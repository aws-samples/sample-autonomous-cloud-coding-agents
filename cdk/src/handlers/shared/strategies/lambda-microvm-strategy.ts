/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

import {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  MicrovmState,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
// Cross-language contract (S9): `microvm_platform_config` is read by BOTH this
// producer and `agent/src/server.py`'s `/run` consumer. Imported (not copied) so
// `tsc` fails on a renamed field — see `contracts/constants.md`.
import sharedConstants from '../../../../../contracts/constants.json';
import type { ComputeStrategy, SessionHandle, SessionStatus } from '../compute-strategy';
import { logger } from '../logger';
import type { BlueprintConfig } from '../repo-config';
import { makeClient } from '../ua';

let sharedClient: LambdaMicrovmsClient | undefined;
function getClient(): LambdaMicrovmsClient {
  if (!sharedClient) {
    sharedClient = makeClient(LambdaMicrovmsClient);
  }
  return sharedClient;
}

let sharedS3Client: S3Client | undefined;
function getS3Client(): S3Client {
  if (!sharedS3Client) {
    sharedS3Client = makeClient(S3Client);
  }
  return sharedS3Client;
}

/**
 * Fully-qualified MicroVM image **ARN** passed as `imageIdentifier` on every
 * `RunMicrovm`.
 *
 * MUST be an ARN, never a bare image name: `RunMicrovm` rejects a name outright
 * (live 2026-07-31 — `ValidationException: Malformed ARN - doesn't start with
 * 'arn:'`), as does `list-microvm-image-builds`. `LambdaMicrovmCompute` already
 * derives the exact `…:microvm-image:<name>` ARN for the lifecycle IAM scope and
 * injects THAT value here, so the two can never disagree; {@link assertImageArn}
 * fails fast if a hand-edited deployment breaks the contract.
 */
const MICROVM_IMAGE_IDENTIFIER = process.env.MICROVM_IMAGE_IDENTIFIER;
const MICROVM_IMAGE_VERSION = process.env.MICROVM_IMAGE_VERSION;
const MICROVM_EXECUTION_ROLE_ARN = process.env.MICROVM_EXECUTION_ROLE_ARN;
const MICROVM_EGRESS_CONNECTOR_ARNS = process.env.MICROVM_EGRESS_CONNECTOR_ARNS;
/**
 * Ingress connectors to pass on every `RunMicrovm`. Injected by
 * `LambdaMicrovmCompute` as exactly the Lambda-managed `NO_INGRESS` connector in
 * P1–P3; a deployment that genuinely needs ingress (#391 operator shell access)
 * can widen it without a strategy change.
 *
 * **Always present in a CDK-deployed stack.** `TaskOrchestrator.microvmConfig`
 * requires `ingressConnectorArns` and injects this var unconditionally alongside
 * the other four, so the fallback below is DEAD CODE on any stack this repo
 * deploys — kept only as defense in depth for a hand-edited Lambda environment,
 * because the failure mode it guards (a PUBLIC endpoint on every agent MicroVM)
 * is too severe to leave to the type system alone.
 */
const MICROVM_INGRESS_CONNECTOR_ARNS = process.env.MICROVM_INGRESS_CONNECTOR_ARNS;
const MICROVM_PAYLOAD_BUCKET = process.env.MICROVM_PAYLOAD_BUCKET;

/**
 * Session wall-clock ceiling passed on EVERY ``RunMicrovm`` call, pinned to the
 * service maximum of 28 800 s / 8 h (ADR-021 sub-decision 1).
 *
 * Three reasons it is a constant and not a knob: it matches AgentCore's 8-hour
 * session cap (backend parity), it sits inside the orchestrator's ~8.5 h
 * safety-net poll window, and — because ``idlePolicy`` is omitted (see
 * {@link RunMicrovmCommand} construction below) — it is the ONLY substrate-level
 * bound on *suspended* time as well as running time. There is no wall-clock task
 * budget in the platform today (budgets are ``max_turns`` / ``max_budget_usd``),
 * so a Blueprint override would be policy without a driver; add one only if a
 * real need appears.
 */
export const MICROVM_MAX_DURATION_SECONDS = 28_800;

/**
 * Hard service cap on ``runHookPayload`` (bytes), measured live rather than read
 * off the SDK docs.
 *
 * The SDK's ``RunMicrovmRequest.runHookPayload`` documents "Maximum: 16,384
 * bytes"; the service enforces **4 096** (2026-07-31, us-east-1):
 *
 * ```
 * ValidationException: 1 validation error detected: Value at 'runHookPayload'
 * failed to satisfy constraint: Member must have length less than or equal to 4096
 * ```
 *
 * Probed exactly: 4 096 bytes passes length validation, 4 097 is rejected. The
 * old 16 384 threshold would have inlined every envelope between 4 097 and
 * 16 384 bytes and had the service reject all of them.
 *
 * This is the EXACT branch point for the inline/S3-pointer decision, with no
 * safety margin — deliberately unlike ``ecs-strategy``, which keeps its inline
 * warn line at 6 144 of ECS's 8 192-byte cap. That margin exists because ECS
 * counts the *whole* ``containerOverrides`` blob (env vars, command, and payload
 * share one budget), so the strategy cannot know how much of the 8 192 the
 * payload actually gets. ``runHookPayload`` is a single standalone string, so
 * the counted size is exactly what we measure and the boundary is computable.
 *
 * Consequence worth stating plainly: at 4 KB the **S3-pointer path is the
 * dominant one**. A hydrated task payload (prompt + issue thread + repo context)
 * essentially always exceeds 4 KB, so the inline branch is the exception (tiny
 * repo-less prompts), not the common case.
 */
const RUN_HOOK_PAYLOAD_LIMIT_BYTES = 4_096;

/**
 * The ``GetMicrovm`` ``stateReason`` value that means "nothing to report".
 *
 * Live-observed, not guessed: an orchestrator-initiated ``TerminateMicrovm`` on the
 * SUCCESS path leaves the MicroVM ``TERMINATED`` with exactly
 * ``stateReason: "Success."`` — trailing period included. Recorded three times in
 * ``docs/verification/645-p2-smoke-runbook.md``: **§5.1** ("Finalization called
 * `TerminateMicrovm`", the verbatim CLI output), **§6.2** (the suspend/resume
 * latency table) and **§2.9** ("Lifecycle — PASS", run 2). A healthy ``RUNNING``
 * MicroVM reports no reason at all (``None``, same §6.2 table).
 *
 * Normalized away in {@link LambdaMicrovmComputeStrategy.pollSession} so it never
 * reaches the reconcile ``detail`` string, where it would append noise to every
 * cleanly-finished task.
 *
 * A bare literal comparison is deliberate and the brittleness is bounded: this is
 * a service-owned display string, so an exact match can only fail OPEN — a future
 * ``"Success"`` without the period, or a different capitalisation, would leak one
 * benign phrase into an operator-facing string. It cannot suppress a real reason,
 * which is the direction that would matter. Left out of
 * ``contracts/constants.json`` for the same reason: nothing in the agent reads it,
 * so it is not a cross-language contract.
 */
const MICROVM_BENIGN_STATE_REASON = 'Success.';

/**
 * The `platform_config` contract (ADR-021 P2): the non-secret platform
 * identifiers the in-guest agent needs, and the EXACT wire keys it reads.
 *
 * ## Why this block exists at all
 *
 * On AgentCore the same values arrive as runtime `environmentVariables`, and on
 * ECS as container `environment` — both set at deploy time by CDK. A MicroVM
 * snapshot cannot carry them: ADR-021 sub-decision 3 forbids baking
 * configuration into the image (it is shared across every task and every
 * deployment that reuses the snapshot, and its env is frozen at build time), so
 * the `/run` hook payload is the only channel. `platform_config` is that channel
 * — the third backend's equivalent of the other two backends' env blocks.
 *
 * ## Cross-language, and therefore contract-sourced
 *
 * The key set is NOT declared here. It is read from
 * `contracts/constants.json` → `microvm_platform_config.env_by_key`, the same
 * object `agent/src/server.py` reads to decide which keys it will install into
 * the guest's `os.environ` — so producer and consumer cannot disagree about a
 * key, its environment-variable name, or the required subset. `tsc` enforces
 * this side (the JSON is imported, so a renamed field fails compilation);
 * `scripts/check-constants-sync.ts` validates the contract's shape and rejects a
 * Python-side literal re-declaration. See `contracts/constants.md`.
 *
 * That indirection is load-bearing on the agent side for a security reason: the
 * values land in `os.environ`, so a key outside the allow-list is an
 * env-injection attempt and the agent **refuses the whole block** rather than
 * filtering it. A producer that invented a key would therefore fail every task,
 * not silently drop a field.
 *
 * ## What may and may not go in here
 *
 * NON-SECRET IDENTIFIERS ONLY — table names, bucket names, log-group names, and
 * secret/role **ARNs**. Never a token, never a secret *value*: the envelope is
 * written to an S3 object and echoed into MicroVM logs on a hook failure, and
 * the agent resolves an ARN itself through its own (SessionRole /
 * execution-role) credentials. The producer below is a map over exactly the
 * contract's keys, so a value can only reach the wire by being added to the
 * contract — an unrelated `process.env` entry (`GITHUB_TOKEN`,
 * `ANTHROPIC_API_KEY`, …) cannot leak in by accident.
 *
 * ## Ordering is part of the contract
 *
 * The contract's declaration order is the emission order (`JSON.stringify`
 * preserves insertion order for string keys), which keeps the serialized
 * envelope — and therefore the 4 KB inline/S3 branch decision — deterministic
 * for a given environment.
 */
const PLATFORM_CONFIG_CONTRACT = sharedConstants.microvm_platform_config;

/**
 * Wire key → the environment variable the orchestrator carries it in, AND the
 * name the agent installs it as in the guest.
 *
 * The env-var names are the ones `TaskOrchestrator` injects
 * (`constructs/task-orchestrator.ts`), which are in turn the names the AgentCore
 * runtime env block in `stacks/agent.ts` uses — so one stack-level value feeds
 * all three backends under one name.
 *
 * Two entries have no CDK-injected source today, deliberately:
 * `LINEAR_OAUTH_SECRET_ARN` / `JIRA_OAUTH_SECRET_ARN` name **per-workspace**
 * secrets created by the CLI at setup, so no single ARN exists at synth time
 * (which is why every consumer role gets a `bgagent-linear-oauth-*` /
 * `bgagent-jira-oauth-*` PREFIX grant instead). The agent's normal source is
 * `channel_metadata.{linear,jira}_oauth_secret_arn` inside `agent_payload`;
 * these keys are the env-var fallback `agent/src/config.py` already reads, so
 * they are forwarded when an operator sets them and omitted otherwise.
 */
const PLATFORM_CONFIG_ENV_VARS = PLATFORM_CONFIG_CONTRACT.env_by_key;

/** One of the `platform_config` wire keys. */
export type MicrovmPlatformConfigKey = keyof typeof PLATFORM_CONFIG_ENV_VARS;

/**
 * Every `platform_config` wire key, in contract (and therefore serialization)
 * order.
 */
export const MICROVM_PLATFORM_CONFIG_KEYS = Object.keys(
  PLATFORM_CONFIG_ENV_VARS,
) as readonly MicrovmPlatformConfigKey[];

/**
 * The `platform_config` block as it appears on the wire. Every key is optional
 * in the TYPE because the producer omits what the orchestrator's environment
 * does not carry; {@link MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS} is the subset
 * whose absence fails the session start instead.
 */
export type MicrovmPlatformConfig = Partial<Record<MicrovmPlatformConfigKey, string>>;

/**
 * Keys the agent cannot start a task without, so a missing one fails the session
 * start here rather than producing a task that dies in-guest (the agent rejects
 * the same set with an `…_INCOMPLETE` 400 — failing at the orchestrator is the
 * cheaper, better-attributed half of the same rule).
 *
 * Each earns its place by what breaks without it:
 *  - `task_table_name` / `task_events_table_name` — every status transition,
 *    heartbeat and progress event the orchestrator polls for. Without them the
 *    task looks hung to the poller and gets failed ~8.5 h later.
 *  - `github_token_secret_arn` — no clone, no push, no PR.
 *  - `agent_session_role_arn` — the agent falls back to AMBIENT execution-role
 *    credentials and per-tenant scoping is silently OFF. That is the failure mode
 *    `ecs-agent-cluster`'s reserved-env list calls the sharpest one in the
 *    platform, and exactly the kind of security control that must not degrade
 *    quietly.
 *
 * Everything else is genuinely optional: a deployment may have no approvals
 * table wired, no artifacts bucket and no channel OAuth, and the agent's own
 * fallbacks cover it.
 *
 * The cast is safe by contract: `scripts/check-constants-sync.ts` fails the build
 * unless `required` is a duplicate-free subset of `env_by_key`.
 */
export const MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS =
  PLATFORM_CONFIG_CONTRACT.required as readonly MicrovmPlatformConfigKey[];

/**
 * Assemble the `platform_config` block from the ORCHESTRATOR Lambda's own
 * environment.
 *
 * Read at CALL time rather than module load (unlike the `MICROVM_*` constants
 * above) for two reasons: the required-key check has to throw *during*
 * `startSession` so the failure lands on the task with a remedy, and these are
 * forwarded values rather than substrate identity — so there is nothing to
 * freeze at import and one env lookup per session start costs nothing.
 *
 * @param env - environment to read; defaults to `process.env`. Injectable so
 *   tests can vary it without reloading the module.
 * @returns the block, with absent optional keys OMITTED (not `undefined`) so the
 *   agent's `key in platform_config` checks mean what they say and the serialized
 *   envelope carries no dead weight against the 4 KB cap.
 * @throws Error carrying {@link MICROVM_ERROR_MARKER} and naming every missing
 *   {@link MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS} entry, its environment
 *   variable, and the redeploy remedy. The marker is what keeps the CLASSIFIER
 *   honest, and it is not optional here — see the throw site.
 */
export function buildMicrovmPlatformConfig(
  env: NodeJS.ProcessEnv = process.env,
): MicrovmPlatformConfig {
  const config: Record<string, string> = {};
  for (const key of MICROVM_PLATFORM_CONFIG_KEYS) {
    const value = env[PLATFORM_CONFIG_ENV_VARS[key]];
    // Empty/whitespace-only is treated as ABSENT, matching the agent's own rule:
    // CloudFormation renders an unresolved optional value as `''`, and sending
    // that would either clobber an image value with nothing or build a request
    // against a nameless table. Omitting says "this deployment has no such
    // resource", which is the truth.
    if (value !== undefined && value.trim() !== '') {
      config[key] = value;
    }
  }

  const missing = MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS.filter(key => !(key in config));
  if (missing.length > 0) {
    // Wrapped, NOT a bare `new Error`. This is a deploy/config fault that no
    // retry can fix, but the marker is what makes the classifier say so. Without
    // it: `startSessionWithRetry` classifies the RAW message (#599), which
    // matches no transient pattern and so throws immediately — correct — but
    // `failTask` then persists `"Session start failed: <raw>"`, and the
    // operator/channel-facing re-classification in `failure-reply.ts` matches
    // that PREFIXED string against `/Session start failed/i`
    // (`error-classifier.ts`), landing `errorClass: TRANSIENT` and the remedy
    // "Check AgentCore Runtime or ECS cluster health / the service quota may be
    // exhausted" — the wrong substrate AND the wrong remedy for a hand-edited
    // orchestrator environment. The marker anchors the MicroVM classifier
    // entries instead. Asserted by a CLASSIFICATION test, not just a message
    // test: message-only assertions passed either way, which is how this slipped.
    throw wrapMicrovmError(
      'platform config',
      new Error(
        'the orchestrator environment is missing platform '
        + `configuration the in-guest agent cannot run without (${missing
          .map(key => `${key} <- ${PLATFORM_CONFIG_ENV_VARS[key]}`)
          .join(', ')}). A MicroVM snapshot must not bake these in (ADR-021 sub-decision 3), so the `
        + '/run payload is the only channel for them. TaskOrchestrator injects every one of these '
        + 'from stack-level values, so this indicates the orchestrator function\'s environment was '
        + 'edited outside CDK — redeploy the stack to restore it.',
      ),
    );
  }

  return config as MicrovmPlatformConfig;
}

/**
 * Stable marker prefixed onto every error this strategy lets escape, via
 * {@link wrapMicrovmError}. Load-bearing, not cosmetic: ``error-classifier``
 * anchors its ``ThrottlingException`` / ``ServiceQuotaExceededException`` /
 * ``ResourceNotFoundException`` entries on this marker so those bare AWS
 * exception names classify as MicroVM faults ONLY when they came from this
 * backend. Without the anchor an identically-named AgentCore or ECS throttle
 * would silently inherit MicroVM copy and MicroVM retry semantics.
 *
 * Keep in lockstep with the MicroVM section of ``error-classifier.ts``.
 */
export const MICROVM_ERROR_MARKER = 'MicroVM';

/**
 * Wrap an error escaping a MicroVM control-plane (or payload-upload) call so it
 * carries {@link MICROVM_ERROR_MARKER} plus the originating operation.
 *
 * The AWS exception NAME is spliced into the message explicitly because
 * ``err.message`` alone omits it (``String(err)`` would include it, but the
 * classifier is handed the *wrapped* error) and the classifier keys on that
 * name. ``cause`` retains the original for anyone who needs ``err.name``.
 *
 * The wrapper's own ``name`` is intentionally left as ``Error`` so
 * ``String(wrapped)`` reads ``Error: MicroVM <op> failed: <Name>: <msg>`` —
 * marker first, which is the order the classifier patterns document.
 */
function wrapMicrovmError(operation: string, err: unknown): Error {
  const name = err instanceof Error ? err.name : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const detail = name && name !== 'Error' && !message.includes(name)
    ? `${name}: ${message}`
    : message;
  return new Error(`${MICROVM_ERROR_MARKER} ${operation} failed: ${detail}`, { cause: err });
}

/**
 * S3 object key for a task's MicroVM ``/run`` payload. Same key shape as the
 * ECS payload bucket (``ecsPayloadKey``): one object per task under its own
 * task-id prefix, deleted by the orchestrator at finalize (see
 * {@link deleteMicrovmPayload}), with the payload bucket's lifecycle-expiry rule
 * (ADR-021 sub-decision 3, ``MICROVM_PAYLOAD_TTL_DAYS``) as the backstop.
 */
export function microvmPayloadKey(taskId: string): string {
  return `${taskId}/payload.json`;
}

/**
 * Delete a task's MicroVM ``/run`` payload object. Best-effort: a failed delete
 * must never fail the task — the bucket's 1-day lifecycle rule reaps it
 * regardless. Called from the orchestrator's ``finalize`` step once the task is
 * terminal. No-ops when the payload bucket isn't configured.
 *
 * WHY this exists rather than leaning on the TTL alone (ECS parity, and a real
 * exposure delta): the execution role's payload-bucket grant is
 * ``grantRead`` on the WHOLE bucket — it cannot be per-task scoped, because the
 * MicroVM has to read its own object before any tenant identity is installed.
 * The key shape is ``<taskId>/payload.json``, so any running MicroVM that knows
 * (or guesses) another task's id can read that task's HYDRATED PROMPT — issue
 * body, comment thread, repo context. The MicroVM also runs untrusted repo code.
 * Relying only on ``MICROVM_PAYLOAD_TTL_DAYS = 1`` left that window open for up
 * to ~24 h; deleting at finalize closes it to the task's own lifetime, which is
 * exactly the posture ``deleteEcsPayload`` already gives the ECS backend.
 *
 * ISSUED UNCONDITIONALLY, including for a task whose payload went INLINE (under
 * the {@link RUN_HOOK_PAYLOAD_LIMIT_BYTES} cap, so no object was ever written).
 * That is on purpose: ``DeleteObject`` on a missing key succeeds, so the call is
 * harmless and idempotent, whereas *deciding* to skip it would mean trusting a
 * per-task record of the delivery mode — and if that record were ever wrong or
 * absent, the skip would leave a real payload behind for the full TTL. Attempting
 * always is the fail-safe direction.
 *
 * The consequence is that a successful call proves a delete was ISSUED, never that
 * an object existed — S3 returns nothing that distinguishes the two on an
 * unversioned bucket. The log line below says exactly that and no more; an earlier
 * "Deleted MicroVM payload object" asserted a deletion that never happened on
 * every inline task.
 */
export async function deleteMicrovmPayload(taskId: string): Promise<void> {
  if (!MICROVM_PAYLOAD_BUCKET) return;
  const key = microvmPayloadKey(taskId);
  try {
    await getS3Client().send(new DeleteObjectCommand({
      Bucket: MICROVM_PAYLOAD_BUCKET,
      Key: key,
    }));
    // "issued", not "deleted": see the docstring. An inline-delivered task has no
    // object here and the call still succeeds.
    logger.info('MicroVM payload delete issued', {
      task_id: taskId,
      bucket: MICROVM_PAYLOAD_BUCKET,
      key,
    });
  } catch (err) {
    // Non-fatal — the lifecycle rule is the backstop.
    logger.warn('Failed to delete MicroVM payload object (non-fatal)', {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Split a comma-separated env-var list into trimmed, non-empty entries. */
function parseArnList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Resource-name half of the Lambda-managed **`NO_INGRESS`** connector ARN.
 *
 * Kept in lockstep with `MICROVM_NO_INGRESS_CONNECTOR_RESOURCE` in
 * `constructs/lambda-microvm-compute.ts` — the construct is the normal source of
 * this ARN (via `MICROVM_INGRESS_CONNECTOR_ARNS`); this copy exists only for the
 * fallback below, which must not depend on a construct the Lambda bundle does
 * not include.
 */
const NO_INGRESS_CONNECTOR_RESOURCE = 'aws-network-connector:NO_INGRESS';

/**
 * ARN of the Lambda-managed `NO_INGRESS` connector for the running Region.
 *
 * **Dead code in a CDK-deployed stack** — `TaskOrchestrator` requires
 * `ingressConnectorArns` and always injects
 * `MICROVM_INGRESS_CONNECTOR_ARNS`, so `configuredIngress` is never empty there.
 * This exists for the one path the type system cannot reach: a Lambda
 * environment edited outside CDK. Kept rather than deleted because the failure
 * mode of *omitting* `ingressNetworkConnectors` is a PUBLIC endpoint on every
 * agent MicroVM — the service attaches `HTTP_INGRESS` by default (live
 * 2026-07-31) — and a silent public endpoint is worse than a few dead lines.
 * Deriving the ARN needs only the Region: partition follows from the Region
 * prefix, and the account segment is the literal `aws` because these connectors
 * are service-owned.
 */
function noIngressConnectorArn(): string {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? '';
  const partition = region.startsWith('cn-')
    ? 'aws-cn'
    : region.startsWith('us-gov-')
      ? 'aws-us-gov'
      : 'aws';
  return `arn:${partition}:lambda:${region}:aws:network-connector:${NO_INGRESS_CONNECTOR_RESOURCE}`;
}

/**
 * Fail fast when `MICROVM_IMAGE_IDENTIFIER` is not an ARN.
 *
 * The service's own error (`ValidationException: Malformed ARN - doesn't start
 * with 'arn:'`) names neither the env var nor the remedy, and it arrives after
 * the payload has already been written to S3. Checking here keeps the diagnosis
 * one hop from the cause.
 */
function assertImageArn(identifier: string): void {
  if (identifier.startsWith('arn:')) {
    return;
  }
  throw new Error(
    `MICROVM_IMAGE_IDENTIFIER must be a full MicroVM image ARN, got ${JSON.stringify(identifier)}. `
    + 'RunMicrovm rejects bare image names ("Malformed ARN - doesn\'t start with \'arn:\'"). '
    + 'LambdaMicrovmCompute injects the exact arn:<partition>:lambda:<region>:<account>:'
    + 'microvm-image:<name> ARN it also scopes the lifecycle IAM grant to, so this indicates the '
    + 'orchestrator function\'s environment was edited outside CDK — redeploy the stack with '
    + '`--context compute_type=lambda-microvm` (plus the image context flags) to restore it.',
  );
}

/**
 * AWS Lambda MicroVMs compute backend (ADR-021).
 *
 * A serverless Firecracker sandbox per session: snapshot-based launch, native
 * disk that survives suspend/resume, and — unlike AgentCore — a real
 * control-plane state machine the orchestrator can observe through
 * {@link LambdaMicrovmComputeStrategy.pollSession}.
 *
 * P1 scope is start / poll / stop only. ``suspendSession`` / ``resumeSession``
 * (the interface widening across all three strategies) land in P3 — do NOT add
 * them here piecemeal, ADR-021 sub-decision 1 requires them in one commit so
 * the exhaustive-``never`` switch culture forces every backend to make a
 * compile-checked decision about its suspend semantics.
 */
export class LambdaMicrovmComputeStrategy implements ComputeStrategy {
  readonly type = 'lambda-microvm';

  async startSession(input: {
    taskId: string;
    /** Accepted to satisfy the ComputeStrategy interface. MicroVMs have no
     *  workload-token-injecting runtime (they inherit the ECS env-var identity
     *  posture until #249 / ADR-016 redesign the seam), so this is unused. */
    userId: string;
    payload: Record<string, unknown>;
    blueprintConfig: BlueprintConfig;
  }): Promise<SessionHandle> {
    if (!MICROVM_IMAGE_IDENTIFIER || !MICROVM_EXECUTION_ROLE_ARN || !MICROVM_EGRESS_CONNECTOR_ARNS || !MICROVM_PAYLOAD_BUCKET) {
      // Config/deploy mismatch: this repo is compute_type=lambda-microvm but the
      // stack was deployed WITHOUT the MicroVM substrate, so the orchestrator has
      // no MICROVM_* env vars. Name the root cause + remedy so an admin doesn't
      // have to reverse-engineer it from a bare env-var list — same posture as
      // the ECS branch. (The CLI `repo onboard --compute-type lambda-microvm`
      // availability probe normally prevents this; a repo onboarded before that
      // guard, or edited directly, can still reach here.)
      throw new Error(
        'This repository is configured compute_type=lambda-microvm, but this stack was deployed without the '
        + 'Lambda MicroVMs substrate (missing MICROVM_IMAGE_IDENTIFIER/MICROVM_EXECUTION_ROLE_ARN/'
        + 'MICROVM_EGRESS_CONNECTOR_ARNS/MICROVM_PAYLOAD_BUCKET). Redeploy the stack with '
        + '`--context compute_type=lambda-microvm` to provision the MicroVM substrate, or set this repo to '
        + 'compute_type=agentcore (bgagent repo onboard <repo> --compute-type agentcore).',
      );
    }

    const { taskId, payload } = input;

    // An identifier that is not an ARN cannot launch anything — check before the
    // payload upload so a misconfiguration never leaves an orphan S3 object.
    assertImageArn(MICROVM_IMAGE_IDENTIFIER);

    // Payload delivery (ADR-021 sub-decision 3): the `/run` lifecycle hook
    // receives `runHookPayload` as its request body, capped at 4 KB by the
    // service. The hydrated_context essentially always blows that, so the
    // S3-pointer path (mirroring ECS #502) is the DOMINANT one here and the
    // inline branch is the exception. The MicroVM EXECUTION role holds the read
    // grant, exactly as the ECS task role does today.
    //
    // Three keys, deliberately mirroring the ECS container env contract
    // (AGENT_PAYLOAD / AGENT_PAYLOAD_S3_URI) so the agent's `/run` hook has one
    // self-describing shape to branch on:
    //   { "agent_payload": {...},     "platform_config": {...} }  — inline
    //   { "agent_payload_s3_uri": "…", "platform_config": {...} }  — pointer
    //
    // `platform_config` (see MICROVM_PLATFORM_CONFIG_KEYS) rides in BOTH forms,
    // and is ALSO merged into the S3 object on the pointer path:
    //   s3://…/<task>/payload.json = { ...agent_payload, "platform_config": {…} }
    // The duplication is deliberate and cheap (a few hundred bytes). It is the
    // agent's env-block substitute — nothing else delivers it, because the
    // snapshot must not bake it in — so it must be reachable whether the agent
    // reads it off the hook body before fetching S3 or out of the fetched object.
    const platformConfig = buildMicrovmPlatformConfig();
    const inlineEnvelope = JSON.stringify({ agent_payload: payload, platform_config: platformConfig });
    // Measure the SERIALIZED envelope, not the bare payload: the envelope is
    // what the service counts against the 4 KB cap, and `platform_config` is part
    // of it — which is precisely why nearly everything lands on the S3 path.
    // Byte length (not String.length) because a multi-byte prompt/diff makes
    // chars an undercount.
    const inlineBytes = Buffer.byteLength(inlineEnvelope, 'utf8');

    let runHookPayload: string;
    let payloadS3Uri: string | undefined;
    // EXACT boundary: `<= limit` inlines, `> limit` uploads. The service accepts
    // 4 096 bytes and rejects 4 097 (measured), so 4 096 must still go inline.
    if (inlineBytes <= RUN_HOOK_PAYLOAD_LIMIT_BYTES) {
      runHookPayload = inlineEnvelope;
    } else {
      const key = microvmPayloadKey(taskId);
      const uri = `s3://${MICROVM_PAYLOAD_BUCKET}/${key}`;
      const pointerEnvelope = JSON.stringify({
        agent_payload_s3_uri: uri,
        platform_config: platformConfig,
      });
      // The pointer envelope is the LAST RESORT — there is no smaller shape to
      // fall back to — so check it BEFORE the upload (an upload followed by a
      // throw would leave an orphan object for the lifecycle rule to reap) and
      // name the one thing an operator can actually act on. Unreachable in
      // practice: the pointer plus all thirteen identifiers is well under 4 KB.
      const pointerBytes = Buffer.byteLength(pointerEnvelope, 'utf8');
      if (pointerBytes > RUN_HOOK_PAYLOAD_LIMIT_BYTES) {
        throw new Error(
          `The MicroVM /run pointer envelope is ${pointerBytes} bytes, over the service's `
          + `${RUN_HOOK_PAYLOAD_LIMIT_BYTES}-byte runHookPayload cap, with the payload already moved `
          + 'to S3. The remaining size is the S3 URI plus the platform_config identifiers, so a '
          + 'pathologically long table/bucket/ARN name is the only possible cause — shorten the '
          + 'stack name (physical resource names derive from it) and redeploy.',
        );
      }
      // The S3 object carries the payload with `platform_config` merged in at the
      // top level, so an agent that fetches the object gets the config with it.
      // Platform config wins on a key collision — the payload has no
      // `platform_config` key today, and if one ever appeared the platform's
      // value is the authoritative one.
      const payloadJson = JSON.stringify({ ...payload, platform_config: platformConfig });
      try {
        await getS3Client().send(new PutObjectCommand({
          Bucket: MICROVM_PAYLOAD_BUCKET,
          Key: key,
          Body: payloadJson,
          ContentType: 'application/json',
        }));
      } catch (err) {
        // Marked so the classifier attributes an upload failure to this backend
        // rather than letting a bare S3 exception name fall through to UNKNOWN.
        throw wrapMicrovmError('payload upload', err);
      }
      payloadS3Uri = uri;
      runHookPayload = pointerEnvelope;
      logger.info('Wrote MicroVM run-hook payload to S3', {
        task_id: taskId,
        bytes: Buffer.byteLength(payloadJson, 'utf8'),
        inline_bytes: inlineBytes,
        inline_limit_bytes: RUN_HOOK_PAYLOAD_LIMIT_BYTES,
        uri: payloadS3Uri,
      });
    }

    // Explicit ingress control (F7, live 2026-07-31): `RunMicrovm` does NOT
    // default to "no ingress" — omitting the field attaches the AWS-managed
    // PUBLIC `HTTP_INGRESS` connector and mints a public
    // `*.lambda-microvm.<region>.on.aws` endpoint. So the field is ALWAYS sent.
    //
    // The env var is unconditional in every CDK-deployed stack (its prop is
    // required), so in practice this always takes the `configuredIngress` branch
    // and carries the construct's `NO_INGRESS` ARN — or real connectors once #391
    // widens it. The fallback is unreachable there by construction; see
    // `noIngressConnectorArn`.
    const configuredIngress = parseArnList(MICROVM_INGRESS_CONNECTOR_ARNS);
    const ingressNetworkConnectors = configuredIngress.length > 0
      ? configuredIngress
      : [noIngressConnectorArn()];

    const command = new RunMicrovmCommand({
      imageIdentifier: MICROVM_IMAGE_IDENTIFIER,
      ...(MICROVM_IMAGE_VERSION && { imageVersion: MICROVM_IMAGE_VERSION }),
      executionRoleArn: MICROVM_EXECUTION_ROLE_ARN,
      // Egress rides the platform VPC through an egress network connector so the
      // DNS Firewall / security-group / flow-log stack applies unchanged
      // (ADR-021 sub-decision 4).
      egressNetworkConnectors: parseArnList(MICROVM_EGRESS_CONNECTOR_ARNS),
      // Never omitted — see the comment above. `NO_INGRESS` is the suppression
      // mechanism, not an empty list.
      ingressNetworkConnectors,
      runHookPayload,
      maximumDurationInSeconds: MICROVM_MAX_DURATION_SECONDS,
      // `idlePolicy` is OMITTED — never passed, in any phase (ADR-021
      // sub-decision 1, asserted by an invariant unit test). MicroVM idle
      // policies measure idleness as *inbound traffic at the endpoint*, and the
      // ABCA agent is outbound-only: "no inbound traffic" is its normal state,
      // so a naive idle policy would suspend an agent mid-way through a
      // 40-minute build. All three idlePolicy fields are required when the block
      // is present, so omission is the unambiguous disabled state. Suspension is
      // orchestrator-owned (P3) — do NOT reintroduce this field.
      //
      // `clientToken` is also deliberately omitted. It is an idempotency token,
      // and the one place a MicroVM start is retried is `startSessionWithRetry`,
      // which retries precisely BECAUSE the first attempt FAILED. Passing a
      // task-derived token there would ask the service to dedupe against that
      // failed attempt and could replay its outcome instead of genuinely
      // retrying — turning the auto-retry into a no-op. Session start is already
      // idempotent by construction at the ABCA level (no clone, commit, or PR has
      // happened yet), so the token buys nothing and risks the retry.
    });

    let result;
    try {
      result = await getClient().send(command);
    } catch (err) {
      // Marker-scoped so `ThrottlingException` / `ServiceQuotaExceededException`
      // / `ResourceNotFoundException` from THIS backend classify as MicroVM
      // faults, while identically-named AgentCore/ECS errors keep their existing
      // classification. See MICROVM_ERROR_MARKER.
      throw wrapMicrovmError('RunMicrovm', err);
    }

    const { microvmId, endpoint } = result;
    if (!microvmId || !endpoint) {
      // A malformed response means a MicroVM may ALREADY BE RUNNING (and billing)
      // that no caller will ever receive a handle for — nothing self-terminates on
      // this substrate. Reap it here, best-effort, before failing: this is the one
      // orphan window the orchestrator's own catch cannot cover, because
      // `startSession` never returned a handle to it.
      if (microvmId) {
        await this.terminateBestEffort(microvmId, 'incomplete RunMicrovm response');
      }
      // Wrapped like every other escaping error so `error-classifier` can see the
      // MicroVM marker: without it this lands in the generic `Session start
      // failed` bucket with "Check AgentCore Runtime or ECS cluster health" —
      // advice that names the wrong substrate entirely. `RunMicrovm` is the
      // operation because that is the call whose response is malformed.
      throw wrapMicrovmError(
        'RunMicrovm',
        new Error(
          `RunMicrovm returned an incomplete response (microvmId=${microvmId ?? 'missing'}, `
          + `endpoint=${endpoint ? 'present' : 'missing'}, state=${result.state ?? 'unknown'})`,
        ),
      );
    }

    // Image ARN/version is logged, NOT carried in the handle (ADR-021
    // sub-decision 1) — it is deployment-time config, and this line is the
    // diagnostic record of which snapshot a given session actually booted.
    logger.info('Lambda MicroVM session started', {
      task_id: taskId,
      microvm_id: microvmId,
      state: result.state,
      image_identifier: MICROVM_IMAGE_IDENTIFIER,
      image_arn: result.imageArn,
      image_version: result.imageVersion ?? MICROVM_IMAGE_VERSION,
      maximum_duration_seconds: MICROVM_MAX_DURATION_SECONDS,
      payload_delivery: payloadS3Uri ? 's3_pointer' : 'inline',
      ...(payloadS3Uri && { payload_s3_uri: payloadS3Uri }),
      // KEY NAMES only, never values: this is the one operator-visible record of
      // which optional platform identifiers a given session actually received, and
      // "the agent said ARTIFACTS_BUCKET_NAME is not configured" is otherwise a
      // half-hour of guessing. Values stay out — see MICROVM_PLATFORM_CONFIG_KEYS.
      platform_config_keys: Object.keys(platformConfig),
    });

    return {
      // sessionId = microvmId, mirroring the ECS variant's "sessionId = the
      // substrate identifier" precedent (ECS uses the task ARN) rather than
      // AgentCore's fresh UUID — AgentCore only needs a UUID because
      // `runtimeSessionId` is a caller-minted value that must be ≥ 33 chars.
      // Here the substrate mints the id, every lifecycle API keys on it, and it
      // is what an operator needs to correlate `TaskRecord.session_id` with the
      // MicroVM in logs/console. A second synthetic UUID would add a
      // non-actionable identifier and leave `session_id` un-joinable.
      sessionId: microvmId,
      strategyType: 'lambda-microvm',
      microvmId,
      endpoint,
    };
  }

  /**
   * Report the substrate's view of the session — MECHANICALLY. No task-state
   * interpretation happens here (ADR-021 sub-decision 1): this method sees only
   * the handle, so the health rules that need the task's DynamoDB status live in
   * the orchestrator (``reconcileMicrovmSubstrateState``).
   *
   * State mapping:
   *   - ``PENDING`` / ``RUNNING`` → ``running`` (PENDING is still booting, the
   *     same way ECS's PENDING/PROVISIONING map to ``running``).
   *   - ``SUSPENDING`` / ``SUSPENDED`` → ``suspended``. SUSPENDING is folded in
   *     because the VM is already on its way to frozen; reporting ``running``
   *     would tell the orchestrator compute is still progressing when it is not.
   *     Both map to a state the orchestrator treats as benign-or-anomalous
   *     depending on the task status, never as a failure. (``SUSPENDING`` was
   *     never observable live — suspend reaches ``SUSPENDED`` in under a second
   *     — so nothing may WAIT for it; it is mapped for completeness only.)
   *   - ``TERMINATING`` / ``TERMINATED`` → ``completed``. Both are terminal or
   *     terminal-bound and carry no exit code, so "the substrate is gone" is all
   *     the strategy can honestly say; whether that is success or failure is the
   *     orchestrator's call (it cross-references the DynamoDB status). This is
   *     the load-bearing terminal signal: a terminated MicroVM stays observable
   *     as ``TERMINATED`` for at least ~10 minutes (live-measured), so a poller
   *     that waited for NotFound would spin on a finished VM.
   *   - anything else (an unrecognized future state) → ``running``, so a service
   *     enum addition can never fail a healthy task.
   *
   * ``stateReason`` is carried through on every mapped state as
   * ``SessionStatus.reason``, VERBATIM and uninterpreted. It is the substrate's
   * own account of WHY, and mapping it away is what made the dominant runtime
   * failure unreadable: a ``/run`` hook 4xx self-terminates the VM within ~12 s
   * (``docs/verification/645-p2-smoke-runbook.md`` §6.1) with
   * ``stateReason = "Run lifecycle hook returned HTTP status 400. Please check
   * your hook endpoint and application logs for more details."`` — and because
   * ``TERMINATED → completed`` has no error slot, the orchestrator's reconcile
   * detail read ``"substrate state completed"``, naming none of the three causes
   * its remedy suggested. Reporting the reason keeps this method mechanical (no
   * branch reads it) while giving the orchestrator something true to say.
   */
  async pollSession(handle: SessionHandle): Promise<SessionStatus> {
    if (handle.strategyType !== 'lambda-microvm') {
      throw new Error('pollSession called with non-lambda-microvm handle');
    }
    const { microvmId } = handle;

    let state: string | undefined;
    let stateReason: string | undefined;
    try {
      const result = await getClient().send(new GetMicrovmCommand({
        microvmIdentifier: microvmId,
      }));
      state = result.state;
      // `Success.` is the service's own "nothing to report" value on a clean
      // termination — carrying it would append noise to every healthy task's
      // detail string, so it is normalized away here rather than filtered at
      // each of the three call sites below. See
      // `MICROVM_BENIGN_STATE_REASON` for the live evidence and why an exact
      // match is acceptable here.
      stateReason = result.stateReason && result.stateReason !== MICROVM_BENIGN_STATE_REASON
        ? result.stateReason
        : undefined;
    } catch (err) {
      // A MicroVM that the control plane no longer knows about is gone, not
      // broken — treat NotFound as terminal (``completed``) rather than
      // ``failed``. This deliberately DIVERGES from ecs-strategy's
      // "DescribeTasks returned no task ⇒ failed": ECS keeps stopped tasks
      // describable for ~1 h, so a missing task there really is anomalous,
      // whereas a MicroVM is eventually reaped from the control plane by design
      // and would otherwise fail every task that finished cleanly.
      //
      // NOTE (live 2026-07-31): this is a LATE signal, not the near-term one. A
      // terminated MicroVM reported ``TERMINATED`` at +3 s and was STILL
      // ``TERMINATED`` ~10 minutes later; ``ResourceNotFoundException`` was never
      // observed in that window. The mapping is still correct — and load-bearing
      // for a VM reaped after a long gap — but the branch that actually fires in
      // practice is ``TERMINATED → completed`` in the switch below. Neither may
      // be removed in favour of the other.
      //
      // The orchestrator still fails the task when this terminal report lands
      // while the DynamoDB status is non-terminal, so a genuine mid-run
      // disappearance is not swallowed — it just gets the substrate-failure
      // classification instead of a misleading poll error.
      if (err instanceof Error && err.name === 'ResourceNotFoundException') {
        logger.info('MicroVM not found on poll — treating as terminal', {
          microvm_id: microvmId,
        });
        return { status: 'completed' };
      }
      throw wrapMicrovmError('GetMicrovm', err);
    }

    switch (state) {
      case MicrovmState.PENDING:
      case MicrovmState.RUNNING:
        return { status: 'running', ...(stateReason && { reason: stateReason }) };
      case MicrovmState.SUSPENDING:
      case MicrovmState.SUSPENDED:
        return { status: 'suspended', ...(stateReason && { reason: stateReason }) };
      case MicrovmState.TERMINATING:
      case MicrovmState.TERMINATED:
        if (stateReason) {
          // WARN, not info: a terminal MicroVM with a reason attached is either
          // the hook-4xx path or a service-side fault, and this line is the
          // in-CloudWatch record of it even when the reconcile detail is not
          // where the operator happens to be looking.
          logger.warn('MicroVM reached a terminal state with a substrate reason', {
            microvm_id: microvmId,
            state,
            state_reason: stateReason,
          });
        }
        return { status: 'completed', ...(stateReason && { reason: stateReason }) };
      default:
        logger.warn('Unrecognized MicroVM state — reporting running', {
          microvm_id: microvmId,
          state,
          ...(stateReason && { state_reason: stateReason }),
        });
        return { status: 'running', ...(stateReason && { reason: stateReason }) };
    }
  }

  /**
   * Terminate the MicroVM. Best-effort with differentiated error handling
   * matching ``agentcore-strategy.stopSession``: a stop that cannot happen must
   * never fail the caller, but the log LEVEL has to distinguish "already gone"
   * (expected) from "we were throttled / denied" (an operator signal that
   * MicroVMs may be leaking) from "something else" (worth a warning).
   *
   * ADR-021: termination is the active cleanup path — it must not rely on
   * ``maximumDurationInSeconds`` expiring, which would keep paying for an
   * 8-hour reservation after the task is done. Live verification made that
   * mandatory rather than belt-and-braces: a hook-less MicroVM reached
   * ``RUNNING`` in 12 s and stayed ``RUNNING`` indefinitely with no
   * ``stateReason`` — nothing self-terminates, so nothing cleans up if the
   * orchestrator does not.
   */
  async stopSession(handle: SessionHandle): Promise<void> {
    if (handle.strategyType !== 'lambda-microvm') {
      throw new Error('stopSession called with non-lambda-microvm handle');
    }
    await this.terminateBestEffort(handle.microvmId, 'session stop');
  }

  /**
   * `TerminateMicrovm` that never throws, with the log LEVEL carrying the
   * diagnosis.
   *
   * The single implementation behind BOTH {@link stopSession} and the
   * incomplete-response orphan reap in {@link startSession}, so every terminate
   * ABCA issues has identical error semantics — a second, subtly-different
   * best-effort copy is exactly how one of them ends up throwing and masking the
   * failure it was cleaning up after.
   *
   * @param microvmId - the MicroVM to terminate.
   * @param reason - why we are terminating, for the log line (the orphan-reap and
   *   the ordinary finalize path are worth telling apart in CloudWatch).
   */
  private async terminateBestEffort(microvmId: string, reason: string): Promise<void> {
    try {
      await getClient().send(new TerminateMicrovmCommand({
        microvmIdentifier: microvmId,
      }));
      logger.info('Lambda MicroVM terminated', { microvm_id: microvmId, reason });
    } catch (err) {
      const errName = err instanceof Error ? err.name : undefined;
      if (errName === 'ResourceNotFoundException' || errName === 'ConflictException') {
        // Already terminated (reaped) or already TERMINATING — the desired end
        // state either way. ConflictException joins the info branch because a
        // concurrent terminate (orchestrator finalize racing a user cancel) is
        // routine here, and warning on it would train operators to ignore warns.
        logger.info('MicroVM already terminated or terminating', {
          microvm_id: microvmId,
          reason,
          error_type: errName,
        });
      } else if (errName === 'ThrottlingException' || errName === 'AccessDeniedException') {
        // A throttle or a missing lambda:TerminateMicrovm grant means the VM is
        // probably STILL RUNNING and billing — escalate.
        logger.error('Failed to terminate MicroVM', {
          microvm_id: microvmId,
          reason,
          error_type: errName,
          error: err instanceof Error ? err.message : String(err),
        });
      } else {
        logger.warn('Failed to terminate MicroVM (best-effort)', {
          microvm_id: microvmId,
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Re-exported so tests and future callers can assert the documented cap without
 * duplicating the literal. This is BOTH the service's limit and our exact
 * inline/S3-pointer branch point — there is no separate threshold.
 */
export const MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES = RUN_HOOK_PAYLOAD_LIMIT_BYTES;

/**
 * Re-exported for tests: the `NO_INGRESS` fallback the strategy substitutes when
 * `MICROVM_INGRESS_CONNECTOR_ARNS` is missing (see {@link noIngressConnectorArn}).
 */
export const microvmNoIngressConnectorArnForRegion = noIngressConnectorArn;
