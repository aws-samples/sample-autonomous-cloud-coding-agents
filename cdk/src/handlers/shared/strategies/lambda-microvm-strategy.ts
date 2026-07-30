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
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ComputeStrategy, SessionHandle, SessionStatus } from '../compute-strategy';
import { logger } from '../logger';
import type { BlueprintConfig } from '../repo-config';

let sharedClient: LambdaMicrovmsClient | undefined;
function getClient(): LambdaMicrovmsClient {
  if (!sharedClient) {
    sharedClient = new LambdaMicrovmsClient({});
  }
  return sharedClient;
}

let sharedS3Client: S3Client | undefined;
function getS3Client(): S3Client {
  if (!sharedS3Client) {
    sharedS3Client = new S3Client({});
  }
  return sharedS3Client;
}

const MICROVM_IMAGE_IDENTIFIER = process.env.MICROVM_IMAGE_IDENTIFIER;
const MICROVM_IMAGE_VERSION = process.env.MICROVM_IMAGE_VERSION;
const MICROVM_EXECUTION_ROLE_ARN = process.env.MICROVM_EXECUTION_ROLE_ARN;
const MICROVM_EGRESS_CONNECTOR_ARNS = process.env.MICROVM_EGRESS_CONNECTOR_ARNS;
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
 * Hard service cap on ``runHookPayload`` (bytes). The SDK documents
 * ``RunMicrovmRequest.runHookPayload`` as "Maximum: 16,384 bytes".
 *
 * This is the EXACT branch point for the inline/S3-pointer decision, with no
 * safety margin — deliberately unlike ``ecs-strategy``, which keeps its inline
 * warn line at 6 144 of ECS's 8 192-byte cap. That margin exists because ECS
 * counts the *whole* ``containerOverrides`` blob (env vars, command, and payload
 * share one budget), so the strategy cannot know how much of the 8 192 the
 * payload actually gets. ``runHookPayload`` is a single standalone string, so
 * the counted size is exactly what we measure and the boundary is computable:
 * ADR-021's requirement is "if the task payload EXCEEDS the 16 KB limit, upload",
 * and shipping a 13 KB payload to S3 would violate it.
 */
const RUN_HOOK_PAYLOAD_LIMIT_BYTES = 16_384;

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
 * task-id prefix. The payload bucket's lifecycle-expiry rule (ADR-021
 * sub-decision 3) is the reaper — unlike the ECS path there is no orchestrator
 * finalize-time delete on this backend yet.
 */
export function microvmPayloadKey(taskId: string): string {
  return `${taskId}/payload.json`;
}

/** Split a comma-separated env-var list into trimmed, non-empty entries. */
function parseArnList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
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

    // Payload delivery (ADR-021 sub-decision 3): the `/run` lifecycle hook
    // receives `runHookPayload` as its request body, capped at 16 KB. The
    // hydrated_context routinely blows that, so mirror the ECS S3-pointer
    // pattern (#502): small payloads ride inline, large ones are uploaded to the
    // platform payload bucket and only the S3 URI travels in the hook body. The
    // MicroVM EXECUTION role holds the read grant, exactly as the ECS task role
    // does today.
    //
    // Two keys, deliberately mirroring the ECS container env contract
    // (AGENT_PAYLOAD / AGENT_PAYLOAD_S3_URI) so the agent's `/run` hook has one
    // self-describing shape to branch on:
    //   { "agent_payload": {...} }              — inline
    //   { "agent_payload_s3_uri": "s3://..." }  — pointer
    const inlineEnvelope = JSON.stringify({ agent_payload: payload });
    // Measure the SERIALIZED envelope, not the bare payload: the envelope is
    // what the service counts against the 16 KB cap. Byte length (not
    // String.length) because a multi-byte prompt/diff makes chars an undercount.
    const inlineBytes = Buffer.byteLength(inlineEnvelope, 'utf8');

    let runHookPayload: string;
    let payloadS3Uri: string | undefined;
    // EXACT boundary: `<= limit` inlines, `> limit` uploads. ADR-021 says upload
    // only when the payload EXCEEDS 16 KB, so 16 384 bytes must still go inline.
    if (inlineBytes <= RUN_HOOK_PAYLOAD_LIMIT_BYTES) {
      runHookPayload = inlineEnvelope;
    } else {
      const key = microvmPayloadKey(taskId);
      const payloadJson = JSON.stringify(payload);
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
      payloadS3Uri = `s3://${MICROVM_PAYLOAD_BUCKET}/${key}`;
      runHookPayload = JSON.stringify({ agent_payload_s3_uri: payloadS3Uri });
      logger.info('Wrote MicroVM run-hook payload to S3', {
        task_id: taskId,
        bytes: Buffer.byteLength(payloadJson, 'utf8'),
        inline_bytes: inlineBytes,
        inline_limit_bytes: RUN_HOOK_PAYLOAD_LIMIT_BYTES,
        uri: payloadS3Uri,
      });
    }

    const ingressNetworkConnectors = parseArnList(MICROVM_INGRESS_CONNECTOR_ARNS);

    const command = new RunMicrovmCommand({
      imageIdentifier: MICROVM_IMAGE_IDENTIFIER,
      ...(MICROVM_IMAGE_VERSION && { imageVersion: MICROVM_IMAGE_VERSION }),
      executionRoleArn: MICROVM_EXECUTION_ROLE_ARN,
      // Egress rides the platform VPC through an egress network connector so the
      // DNS Firewall / security-group / flow-log stack applies unchanged
      // (ADR-021 sub-decision 4).
      egressNetworkConnectors: parseArnList(MICROVM_EGRESS_CONNECTOR_ARNS),
      // NO ingress beyond the service defaults: nothing in P1–P3 dials into the
      // MicroVM (no JWE tokens are minted at all), so SHELL_INGRESS and friends
      // stay off. The env var exists so a deployment CAN pass connectors without
      // a code change; absent ⇒ the field is omitted entirely.
      ...(ingressNetworkConnectors.length > 0 && { ingressNetworkConnectors }),
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
      throw new Error(
        `RunMicrovm returned an incomplete response (microvmId=${microvmId ?? 'missing'}, `
        + `endpoint=${endpoint ? 'present' : 'missing'}, state=${result.state ?? 'unknown'})`,
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
   *     depending on the task status, never as a failure.
   *   - ``TERMINATING`` / ``TERMINATED`` → ``completed``. Both are terminal or
   *     terminal-bound and carry no exit code, so "the substrate is gone" is all
   *     the strategy can honestly say; whether that is success or failure is the
   *     orchestrator's call (it cross-references the DynamoDB status).
   *   - anything else (an unrecognized future state) → ``running``, so a service
   *     enum addition can never fail a healthy task.
   */
  async pollSession(handle: SessionHandle): Promise<SessionStatus> {
    if (handle.strategyType !== 'lambda-microvm') {
      throw new Error('pollSession called with non-lambda-microvm handle');
    }
    const { microvmId } = handle;

    let state: string | undefined;
    try {
      const result = await getClient().send(new GetMicrovmCommand({
        microvmIdentifier: microvmId,
      }));
      state = result.state;
    } catch (err) {
      // A MicroVM that the control plane no longer knows about is gone, not
      // broken — treat NotFound as terminal (``completed``) rather than
      // ``failed``. This deliberately DIVERGES from ecs-strategy's
      // "DescribeTasks returned no task ⇒ failed": ECS keeps stopped tasks
      // describable for ~1 h, so a missing task there really is anomalous,
      // whereas a terminated MicroVM is reaped from the control plane by design
      // and would otherwise fail every task that finished cleanly. The
      // orchestrator still fails the task when this terminal report lands while
      // the DynamoDB status is non-terminal, so a genuine mid-run disappearance
      // is not swallowed — it just gets the substrate-failure classification
      // instead of a misleading poll error.
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
        return { status: 'running' };
      case MicrovmState.SUSPENDING:
      case MicrovmState.SUSPENDED:
        return { status: 'suspended' };
      case MicrovmState.TERMINATING:
      case MicrovmState.TERMINATED:
        return { status: 'completed' };
      default:
        logger.warn('Unrecognized MicroVM state — reporting running', {
          microvm_id: microvmId,
          state,
        });
        return { status: 'running' };
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
   * 8-hour reservation after the task is done.
   */
  async stopSession(handle: SessionHandle): Promise<void> {
    if (handle.strategyType !== 'lambda-microvm') {
      throw new Error('stopSession called with non-lambda-microvm handle');
    }
    const { microvmId } = handle;

    try {
      await getClient().send(new TerminateMicrovmCommand({
        microvmIdentifier: microvmId,
      }));
      logger.info('Lambda MicroVM terminated', { microvm_id: microvmId });
    } catch (err) {
      const errName = err instanceof Error ? err.name : undefined;
      if (errName === 'ResourceNotFoundException' || errName === 'ConflictException') {
        // Already terminated (reaped) or already TERMINATING — the desired end
        // state either way. ConflictException joins the info branch because a
        // concurrent terminate (orchestrator finalize racing a user cancel) is
        // routine here, and warning on it would train operators to ignore warns.
        logger.info('MicroVM already terminated or terminating', {
          microvm_id: microvmId,
          error_type: errName,
        });
      } else if (errName === 'ThrottlingException' || errName === 'AccessDeniedException') {
        // A throttle or a missing lambda:TerminateMicrovm grant means the VM is
        // probably STILL RUNNING and billing — escalate.
        logger.error('Failed to terminate MicroVM', {
          microvm_id: microvmId,
          error_type: errName,
          error: err instanceof Error ? err.message : String(err),
        });
      } else {
        logger.warn('Failed to terminate MicroVM (best-effort)', {
          microvm_id: microvmId,
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
