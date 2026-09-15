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
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  MicrovmState,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
  SuspendMicrovmCommand,
  ResumeMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
// Cross-language contract (S9): `microvm_platform_config` is read by BOTH this
// producer and `agent/src/server.py`'s `/run` consumer. Imported (not copied) so
// `tsc` fails on a renamed field — see `contracts/constants.md`.
import sharedConstants from '../../../../../contracts/constants.json';
import type { ComputeStrategy, SessionHandle, SessionLifecycleResult, SessionStatus } from '../compute-strategy';
import { MicrovmStartUncertainError } from '../error-classifier';
import { logger } from '../logger';
import {
  MICROVM_IMAGE_CAPABILITY_REQUEST_TIMEOUT_MS, MICROVM_LIFECYCLE_PROTOCOL,
  readMicrovmImageMetadata, verifyMicrovmImageLifecycle,
} from '../microvm-image-capability';
import { claimMicrovmStart, microvmStartRequestHash, saveMicrovmStartHandle, saveMicrovmImageCapability } from '../microvm-start';
import { deletePayloadReference, preparePayloadReference, redactPayloadUrls } from '../payload-bootstrap';
import type { BlueprintConfig } from '../repo-config';
import { makeClient } from '../ua';

let sharedClient: LambdaMicrovmsClient | undefined;
function getClient(): LambdaMicrovmsClient {
  if (!sharedClient) {
    sharedClient = makeClient(LambdaMicrovmsClient);
  }
  return sharedClient;
}

/** Bound a control request, not the transition itself. A timeout needs reconciliation. */
export const MICROVM_LIFECYCLE_REQUEST_TIMEOUT_MS = 10_000;

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
const HTTP_REQUEST_TIMEOUT = 408;

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
 * V2 always sends a signed payload reference. Enforce this byte limit on the
 * final serialized reference; payload/config bytes live in S3, not in the hook.
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
 * secret/role **ARNs**. Never a token, never a secret *value*: configuration is
 * stored in the worker-readable deployment manifest and task object. Hook
 * diagnostics omit payloads and redact signed URLs. The agent resolves an ARN
 * itself through its own (SessionRole /
 * execution-role) credentials. The producer below is a map over exactly the
 * contract's keys, so a value can only reach the wire by being added to the
 * contract — an unrelated `process.env` entry (`GITHUB_TOKEN`,
 * `ANTHROPIC_API_KEY`, …) cannot leak in by accident.
 *
 * ## Ordering is part of the contract
 *
 * The contract's declaration order is the emission order (`JSON.stringify`
 * preserves insertion order for string keys), which keeps the serialized
 * manifest serialization deterministic
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
 * Wrap an error escaping a MicroVM control-plane or payload-bootstrap call so it
 * carries {@link MICROVM_ERROR_MARKER} plus the originating operation.
 *
 * The AWS exception NAME is spliced into the message explicitly because
 * ``err.message`` alone omits it (``String(err)`` would include it, but the
 * classifier is handed the *wrapped* error) and the classifier keys on that
 * name. ``cause`` retains a sanitized name/message copy: SDK errors and their
 * nested causes can contain signed URLs or request metadata.
 *
 * The wrapper's own ``name`` is intentionally left as ``Error`` so
 * ``String(wrapped)`` reads ``Error: MicroVM <op> failed: <Name>: <msg>`` —
 * marker first, which is the order the classifier patterns document.
 */
function wrapMicrovmError(operation: string, err: unknown): Error {
  const name = err instanceof Error ? redactPayloadUrls(err.name) : undefined;
  const message = redactPayloadUrls(err instanceof Error ? err.message : String(err));
  const detail = name && name !== 'Error' && !message.includes(name)
    ? `${name}: ${message}`
    : message;
  const safeCause = new Error(message);
  safeCause.name = name ?? 'Error';
  return new Error(`${MICROVM_ERROR_MARKER} ${operation} failed: ${detail}`, { cause: safeCause });
}

/** Remove task instructions and their saved download capability after finalization.
 * Best-effort; bucket lifecycle reaps leftovers. Deployment manifests are shared.
 */
export async function deleteMicrovmPayload(taskId: string): Promise<void> {
  if (!MICROVM_PAYLOAD_BUCKET) return;
  await deletePayloadReference(MICROVM_PAYLOAD_BUCKET, taskId);
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
 * P3 command primitives implement mandatory suspend/resume alongside the
 * explicit unsupported results in the other two strategies. The supervisor
 * must still supply gate policy, durable intent and state reconciliation
 * before automatic suspension can be enabled with compatible agent hooks.
 */
export class LambdaMicrovmComputeStrategy implements ComputeStrategy {
  readonly type = 'lambda-microvm';

  async startSession(input: {
    taskId: string;
    /** Checked against the stored task owner before claiming a start receipt. */
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

    // The manifest authenticates deployment settings through the worker's IAM
    // grant. Payload access uses a single-object URL, saved outside TaskTable.
    const platformConfig = buildMicrovmPlatformConfig();

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

    const request = {
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
      runHookPayload: 'payload-bootstrap-v2',
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
      // The receipt below supplies a task-stable token across new SDK commands.
    };

    const requestHash = microvmStartRequestHash(
      { ...request, payloadBucket: MICROVM_PAYLOAD_BUCKET }, { ...payload, platform_config: platformConfig },
    );
    const claim = await claimMicrovmStart(taskId, input.userId, requestHash);
    if (claim.closed) {
      if (claim.handle) await this.stopSession(claim.handle);
      throw new Error('MICROVM_START_TASK_CLOSED: task became terminal before session start');
    }
    if (claim.handle) return claim.handle;
    const reference = await preparePayloadReference({
      bucket: MICROVM_PAYLOAD_BUCKET, taskId, backend: 'lambda-microvm', payload, platformConfig,
    }).catch((error: unknown) => { throw wrapMicrovmError('payload bootstrap', error); });
    const runHookPayload = JSON.stringify(reference);
    if (Buffer.byteLength(runHookPayload, 'utf8') > RUN_HOOK_PAYLOAD_LIMIT_BYTES) {
      throw new Error('PAYLOAD_BOOTSTRAP_TOO_LARGE: launch reference exceeds the MicroVM hook limit');
    }
    // Uploads can take time. Observe cancellation/another saved handle again
    // immediately before the service call, using the same immutable request.
    const latest = await claimMicrovmStart(taskId, input.userId, requestHash);
    if (latest.closed) {
      if (latest.handle) await this.stopSession(latest.handle);
      throw new Error('MICROVM_START_TASK_CLOSED: task became terminal before session start');
    }
    if (latest.handle) return latest.handle;
    const command = new RunMicrovmCommand({ ...request, runHookPayload, clientToken: latest.clientToken });

    let result;
    try {
      result = await getClient().send(command);
    } catch (err) {
      // Marker-scoped so `ThrottlingException` / `ServiceQuotaExceededException`
      // / `ResourceNotFoundException` from THIS backend classify as MicroVM
      // faults, while identically-named AgentCore/ECS errors keep their existing
      // classification. See MICROVM_ERROR_MARKER.
      const wrapped = wrapMicrovmError('RunMicrovm', err);
      const serviceError = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      const httpStatus = serviceError?.$metadata?.httpStatusCode;
      // A service timeout can carry a 4xx status without proving that creation
      // never happened. Preserve uncertainty across any subsequent rejection.
      const timedOut = httpStatus === HTTP_REQUEST_TIMEOUT
        || ['TimeoutError', 'RequestTimeout', 'RequestTimeoutException'].includes(serviceError?.name ?? '');
      const knownRejection = !timedOut && (httpStatus !== undefined
        ? httpStatus >= 400 && httpStatus < 500
        : ['AccessDeniedException', 'UnauthorizedException', 'ValidationException',
          'InvalidParameterValueException', 'ResourceNotFoundException', 'ThrottlingException',
          'TooManyRequestsException', 'ServiceQuotaExceededException', 'ConflictException']
          .includes(serviceError?.name ?? ''));
      if (!knownRejection) throw new MicrovmStartUncertainError(wrapped.message, { cause: wrapped });
      throw wrapped;
    }

    const { microvmId, endpoint } = result;
    if (!microvmId || !endpoint) {
      // A malformed response may describe an existing VM without a usable handle.
      // The eight-hour service lifetime is a backstop, not prompt cleanup.
      // Clean up any available ID here: the caller will not receive a handle
      // it can use to stop this VM.
      if (microvmId) {
        await this.terminateBestEffort(microvmId, 'incomplete RunMicrovm response');
      }
      // Wrapped like every other escaping error so `error-classifier` can see the
      // MicroVM marker: without it this lands in the generic `Session start
      // failed` bucket with "Check AgentCore Runtime or ECS cluster health" —
      // advice that names the wrong substrate entirely. `RunMicrovm` is the
      // operation because that is the call whose response is malformed.
      const incomplete = wrapMicrovmError(
        'RunMicrovm',
        new Error(
          `RunMicrovm returned an incomplete response (microvmId=${microvmId ?? 'missing'}, `
          + `endpoint=${endpoint ? 'present' : 'missing'}, state=${result.state ?? 'unknown'})`,
        ),
      );
      if (!microvmId) throw new MicrovmStartUncertainError(incomplete.message, { cause: incomplete });
      throw incomplete;
    }

    let handle: Extract<SessionHandle, { strategyType: 'lambda-microvm' }> = {
      sessionId: microvmId,
      strategyType: 'lambda-microvm',
      microvmId,
      endpoint,
      ...readMicrovmImageMetadata({ imageArn: result.imageArn, imageVersion: result.imageVersion }),
    };
    try {
      await saveMicrovmStartHandle(taskId, latest.clientToken, handle);
    } catch (err) {
      // The write may have committed before its response was lost. Recover that
      // receipt before destroying a computer whose handle is already durable.
      try {
        const saved = await claimMicrovmStart(taskId, input.userId, requestHash);
        if (!saved.closed && saved.handle?.microvmId === microvmId) return saved.handle;
      } catch (readErr) {
        logger.warn('Could not reconcile the MicroVM start receipt', { task_id: taskId, error: String(readErr) });
      }
      await this.terminateBestEffort(microvmId, 'start receipt could not save handle');
      throw new Error(`MICROVM_START_RECEIPT_SAVE_FAILED: ${String(err)}`, { cause: err });
    }

    // Persist the known worker above BEFORE optional image discovery. A crash or
    // failed lookup must not widen the orphan window or break ordinary coding.
    // Never infer capability from a requested pin or the deployment's latest image.
    if (handle.imageArn === MICROVM_IMAGE_IDENTIFIER && handle.imageVersion) {
      try {
        const identity = { imageArn: handle.imageArn, imageVersion: handle.imageVersion };
        const version = await getClient().send(new GetMicrovmImageVersionCommand({
          imageIdentifier: identity.imageArn, imageVersion: identity.imageVersion,
        }), { abortSignal: AbortSignal.timeout(MICROVM_IMAGE_CAPABILITY_REQUEST_TIMEOUT_MS) });
        if (verifyMicrovmImageLifecycle(identity, version)) {
          const capable = { ...handle, lifecycleProtocol: MICROVM_LIFECYCLE_PROTOCOL };
          await saveMicrovmImageCapability(taskId, latest.clientToken, capable);
          handle = capable;
        }
      } catch (error) {
        // Explicit degraded mode: the saved worker remains usable, with new
        // suspension disabled. Do not expose image environment or AWS error text.
        const name = (error as { name?: unknown })?.name;
        logger.warn('MicroVM image capability unavailable; automatic suspension remains disabled', {
          task_id: taskId,
          microvm_id: microvmId,
          error_type: typeof name === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(name) ? name : 'Error',
        });
      }
    }

    // The durable handle carries actual identity/capability for later decisions.
    logger.info('Lambda MicroVM session started', {
      task_id: taskId,
      microvm_id: microvmId,
      state: result.state,
      image_identifier: MICROVM_IMAGE_IDENTIFIER,
      image_arn: result.imageArn,
      image_version: handle.imageVersion ?? null,
      lifecycle_protocol: handle.lifecycleProtocol ?? 'unverified',
      maximum_duration_seconds: MICROVM_MAX_DURATION_SECONDS,
      payload_delivery: 'signed_reference',
      // KEY NAMES only, never values: this is the one operator-visible record of
      // which optional platform identifiers a given session actually received, and
      // "the agent said ARTIFACTS_BUCKET_NAME is not configured" is otherwise a
      // half-hour of guessing. Values stay out — see MICROVM_PLATFORM_CONFIG_KEYS.
      platform_config_keys: Object.keys(platformConfig),
    });

    // Use AWS's identifier for both lifecycle calls and TaskRecord.session_id.
    return handle;
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
   *     depending on the task status, never as a failure. Earlier probes skipped
   *     this short transition, but P3 must handle it if observed: save wake intent
   *     and wait for SUSPENDED before issuing ResumeMicrovm.
   *   - ``TERMINATING`` / ``TERMINATED`` → ``completed``. Both are terminal or
   *     terminal-bound and carry no exit code, so "the substrate is gone" is all
   *     the strategy can honestly say; whether that is success or failure is the
   *     orchestrator's call (it cross-references the DynamoDB status). This is
   *     the load-bearing terminal signal: a terminated MicroVM stays observable
   *     as ``TERMINATED`` for at least ~10 minutes (live-measured), so a poller
   *     that waited for NotFound would spin on a finished VM.
   *   - anything else (an unrecognized future state) → ``running``, so a service
   *     enum addition can never fail a healthy task.
   * ``microvmState`` also reports the explicit observed state (or local UNKNOWN /
   * NOT_FOUND). P3 uses it to distinguish readiness from the coarse status.
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
        return { status: 'completed', microvmState: 'NOT_FOUND' };
      }
      throw wrapMicrovmError('GetMicrovm', err);
    }

    switch (state) {
      case MicrovmState.PENDING:
      case MicrovmState.RUNNING:
        return { status: 'running', microvmState: state, ...(stateReason && { reason: stateReason }) };
      case MicrovmState.SUSPENDING:
      case MicrovmState.SUSPENDED:
        return { status: 'suspended', microvmState: state, ...(stateReason && { reason: stateReason }) };
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
        return { status: 'completed', microvmState: state, ...(stateReason && { reason: stateReason }) };
      default:
        logger.warn('Unrecognized MicroVM state — reporting running', {
          microvm_id: microvmId,
          state,
          ...(stateReason && { state_reason: stateReason }),
        });
        return { status: 'running', microvmState: 'UNKNOWN', ...(stateReason && { reason: stateReason }) };
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

  /** Submit a suspend request; the caller owns gate checks and state reconciliation. */
  async suspendSession(handle: SessionHandle): Promise<SessionLifecycleResult> {
    return this.requestLifecycle('suspendSession', handle);
  }

  /** Submit a resume request; acknowledgement alone does not establish RUNNING. */
  async resumeSession(handle: SessionHandle): Promise<SessionLifecycleResult> {
    return this.requestLifecycle('resumeSession', handle);
  }

  private async requestLifecycle(
    operation: 'suspendSession' | 'resumeSession',
    handle: SessionHandle,
  ): Promise<SessionLifecycleResult> {
    if (handle.strategyType !== 'lambda-microvm') {
      throw new Error(`${operation} called with non-lambda-microvm handle`);
    }
    if (typeof handle.microvmId !== 'string' || !handle.microvmId.trim()) {
      throw new Error(`${operation} requires a non-empty MicroVM identifier`);
    }
    const suspend = operation === 'suspendSession';
    const request = { microvmIdentifier: handle.microvmId };
    try {
      await getClient().send(
        suspend ? new SuspendMicrovmCommand(request) : new ResumeMicrovmCommand(request),
        { abortSignal: AbortSignal.timeout(MICROVM_LIFECYCLE_REQUEST_TIMEOUT_MS) },
      );
    } catch (error) {
      // Includes Conflict/NotFound: neither proves the desired state was reached.
      // Even a timeout may have committed; the durable caller must observe again.
      throw wrapMicrovmError(suspend ? 'SuspendMicrovm' : 'ResumeMicrovm', error);
    }
    return { supported: true };
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
          error: redactPayloadUrls(err instanceof Error ? err.message : String(err)),
        });
      } else {
        logger.warn('Failed to terminate MicroVM (best-effort)', {
          microvm_id: microvmId,
          reason,
          error: redactPayloadUrls(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  }
}

/**
 * Re-exported so tests and future callers can assert the documented cap without
 * duplicating the literal. This is BOTH the service's limit and our exact
 * maximum serialized v2 launch-reference size.
 */
export const MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES = RUN_HOOK_PAYLOAD_LIMIT_BYTES;

/**
 * Re-exported for tests: the `NO_INGRESS` fallback the strategy substitutes when
 * `MICROVM_INGRESS_CONNECTOR_ARNS` is missing (see {@link noIngressConnectorArn}).
 */
export const microvmNoIngressConnectorArnForRegion = noIngressConnectorArn;
