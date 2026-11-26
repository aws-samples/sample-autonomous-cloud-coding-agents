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
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharedConstants from '../../../../../contracts/constants.json';
import type { ComputeStrategy, SessionControlOptions, SessionHandle, SessionLifecycleResult, SessionStatus, SessionStopResult } from '../compute-strategy';
import { MicrovmStartUncertainError } from '../error-classifier';
import { logger } from '../logger';
import { microvmErrorIdentity, microvmRequestIdentity } from '../microvm/control';
import {
  MICROVM_IMAGE_CAPABILITY_REQUEST_TIMEOUT_MS, MICROVM_LIFECYCLE_PROTOCOL,
  readMicrovmImageMetadata, verifyMicrovmImageLifecycle,
} from '../microvm/image-capability';
import { claimMicrovmStart, microvmStartRequestHash, saveMicrovmStartHandle, saveMicrovmImageCapability } from '../microvm/start';
import type { BlueprintConfig } from '../repo-config';
import { makeClient } from '../ua';

let sharedS3Client: S3Client | undefined;
function getS3Client(): S3Client {
  if (!sharedS3Client) {
    sharedS3Client = makeClient(S3Client);
  }
  return sharedS3Client;
}

let sharedClient: LambdaMicrovmsClient | undefined;
function getClient(): LambdaMicrovmsClient {
  if (!sharedClient) {
    sharedClient = makeClient(LambdaMicrovmsClient);
  }
  return sharedClient;
}

/** Bound a control request, not the transition itself. A timeout needs reconciliation. */
export const MICROVM_LIFECYCLE_REQUEST_TIMEOUT_MS = 10_000;

function controlSignal(options?: SessionControlOptions): AbortSignal {
  const limit = AbortSignal.timeout(MICROVM_LIFECYCLE_REQUEST_TIMEOUT_MS);
  const signal = options?.abortSignal ? AbortSignal.any([limit, options.abortSignal]) : limit;
  signal.throwIfAborted();
  return signal;
}

const MICROVM_IMAGE_IDENTIFIER = process.env.MICROVM_IMAGE_IDENTIFIER;
const MICROVM_IMAGE_VERSION = process.env.MICROVM_IMAGE_VERSION;
const MICROVM_EXECUTION_ROLE_ARN = process.env.MICROVM_EXECUTION_ROLE_ARN;
const MICROVM_EGRESS_CONNECTOR_ARNS = process.env.MICROVM_EGRESS_CONNECTOR_ARNS;
const MICROVM_INGRESS_CONNECTOR_ARNS = process.env.MICROVM_INGRESS_CONNECTOR_ARNS;
const MICROVM_PAYLOAD_BUCKET = process.env.MICROVM_PAYLOAD_BUCKET;
const HTTP_REQUEST_TIMEOUT = 408;

/**
 * Session wall-clock ceiling passed on EVERY ``RunMicrovm`` call, pinned to the
 * service maximum of 28 800 s / 8 h (ADR-021 sub-decision 1). It bounds
 * suspended time as well as running time.
 */
export const MICROVM_MAX_DURATION_SECONDS = sharedConstants.microvm_lifecycle.maximum_duration_seconds;

/**
 * Hard service cap on ``runHookPayload`` (bytes). The SDK's
 * ``RunMicrovmRequest.runHookPayload`` documents "Maximum: 16,384 bytes"; the
 * service enforces 4 096 (2026-07-31, us-east-1): 4 096 bytes passes length
 * validation, 4 097 is rejected with a ``ValidationException``.
 */
const RUN_HOOK_PAYLOAD_LIMIT_BYTES = 4_096;

/** The service reports "Success." after normal termination. */
const MICROVM_BENIGN_STATE_REASON = 'Success.';

const PLATFORM_CONFIG_CONTRACT = sharedConstants.microvm_platform_config;

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
 * Keys the agent cannot start a task without: a missing one fails the session
 * start.
 */
export const MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS =
  PLATFORM_CONFIG_CONTRACT.required as readonly MicrovmPlatformConfigKey[];

/**
 * Assemble the `platform_config` block from the ORCHESTRATOR Lambda's own
 * environment.
 *
 * @param env - environment to read; defaults to `process.env`.
 * @returns the block, with absent optional keys OMITTED (not `undefined`).
 * @throws Error carrying {@link MICROVM_ERROR_MARKER} and naming every missing
 *   {@link MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS} entry, its environment
 *   variable, and the redeploy remedy.
 */
export function buildMicrovmPlatformConfig(
  env: NodeJS.ProcessEnv = process.env,
): MicrovmPlatformConfig {
  const config: Record<string, string> = {};
  for (const key of MICROVM_PLATFORM_CONFIG_KEYS) {
    const value = env[PLATFORM_CONFIG_ENV_VARS[key]];
    if (value !== undefined && value.trim() !== '') {
      config[key] = value;
    }
  }

  const missing = MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS.filter(key => !(key in config));
  if (missing.length > 0) {
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
 * {@link wrapMicrovmError}. ``error-classifier`` anchors its
 * ``ThrottlingException`` / ``ServiceQuotaExceededException`` /
 * ``ResourceNotFoundException`` entries on this marker.
 */
export const MICROVM_ERROR_MARKER = 'MicroVM';

function wrapMicrovmError(operation: string, err: unknown): Error {
  const name = err instanceof Error ? err.name : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const detail = name && name !== 'Error' && !message.includes(name)
    ? `${name}: ${message}`
    : message;
  const safeCause = new Error(message);
  safeCause.name = name ?? 'Error';
  const requestId = microvmErrorIdentity(err).aws_request_id;
  if (requestId) Object.assign(safeCause, { $metadata: { requestId } });
  return new Error(`${MICROVM_ERROR_MARKER} ${operation} failed: ${detail}`, { cause: safeCause });
}

/**
 * S3 object key for a task's MicroVM ``/run`` payload: one object per task
 * under its own task-id prefix.
 */
export function microvmPayloadKey(taskId: string): string {
  return `${taskId}/payload.json`;
}

/**
 * Delete a task's MicroVM ``/run`` payload object. Best-effort: a failed delete
 * never fails the task. No-ops when the payload bucket isn't configured.
 *
 * Issued unconditionally, including for a task whose payload went inline:
 * ``DeleteObject`` on a missing key succeeds, so a successful call proves a
 * delete was issued, never that an object existed.
 */
export async function deleteMicrovmPayload(taskId: string): Promise<void> {
  if (!MICROVM_PAYLOAD_BUCKET) return;
  const key = microvmPayloadKey(taskId);
  try {
    await getS3Client().send(new DeleteObjectCommand({
      Bucket: MICROVM_PAYLOAD_BUCKET,
      Key: key,
    }));
    logger.info('MicroVM payload delete issued', {
      task_id: taskId,
      bucket: MICROVM_PAYLOAD_BUCKET,
      key,
    });
  } catch (err) {
    logger.warn('Failed to delete MicroVM payload object (non-fatal)', {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function parseArnList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

const NO_INGRESS_CONNECTOR_RESOURCE = 'aws-network-connector:NO_INGRESS';

/** The account segment is the literal `aws` because these connectors are service-owned. */
function noIngressConnectorArn(): string {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? '';
  const partition = region.startsWith('cn-')
    ? 'aws-cn'
    : region.startsWith('us-gov-')
      ? 'aws-us-gov'
      : 'aws';
  return `arn:${partition}:lambda:${region}:aws:network-connector:${NO_INGRESS_CONNECTOR_RESOURCE}`;
}

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

async function deliverRunHookPayload(
  taskId: string, payload: Record<string, unknown>, platformConfig: MicrovmPlatformConfig,
): Promise<string> {
  const inlineEnvelope = JSON.stringify({ agent_payload: payload, platform_config: platformConfig });
  const inlineBytes = Buffer.byteLength(inlineEnvelope, 'utf8');

  let runHookPayload: string;
  let payloadS3Uri: string | undefined;
  if (inlineBytes <= RUN_HOOK_PAYLOAD_LIMIT_BYTES) {
    runHookPayload = inlineEnvelope;
  } else {
    const key = microvmPayloadKey(taskId);
    const uri = `s3://${MICROVM_PAYLOAD_BUCKET}/${key}`;
    const pointerEnvelope = JSON.stringify({
      agent_payload_s3_uri: uri,
      platform_config: platformConfig,
    });
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
    const payloadJson = JSON.stringify({ ...payload, platform_config: platformConfig });
    try {
      await getS3Client().send(new PutObjectCommand({
        Bucket: MICROVM_PAYLOAD_BUCKET,
        Key: key,
        Body: payloadJson,
        ContentType: 'application/json',
      }));
    } catch (err) {
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
  return runHookPayload;
}

function runHookPayloadDelivery(runHookPayload: string): 'inline' | 's3_pointer' {
  return runHookPayload.includes('"agent_payload_s3_uri"') ? 's3_pointer' : 'inline';
}

type MicrovmSessionHandle = Extract<SessionHandle, { strategyType: 'lambda-microvm' }>;

function runMicrovmStartError(err: unknown): Error {
  const wrapped = wrapMicrovmError('RunMicrovm', err);
  const serviceError = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  const httpStatus = serviceError?.$metadata?.httpStatusCode;
  const timedOut = httpStatus === HTTP_REQUEST_TIMEOUT
    || ['TimeoutError', 'RequestTimeout', 'RequestTimeoutException'].includes(serviceError?.name ?? '');
  const knownRejection = !timedOut && (httpStatus !== undefined
    ? httpStatus >= 400 && httpStatus < 500
    : ['AccessDeniedException', 'UnauthorizedException', 'ValidationException',
      'InvalidParameterValueException', 'ResourceNotFoundException', 'ThrottlingException',
      'TooManyRequestsException', 'ServiceQuotaExceededException', 'ConflictException']
      .includes(serviceError?.name ?? ''));
  if (!knownRejection) return new MicrovmStartUncertainError(wrapped.message, { cause: wrapped });
  return wrapped;
}

async function discoverImageCapability(
  taskId: string, clientToken: string, handle: MicrovmSessionHandle,
): Promise<MicrovmSessionHandle> {
  if (!handle.imageArn || handle.imageArn !== MICROVM_IMAGE_IDENTIFIER || !handle.imageVersion) return handle;
  try {
    const identity = { imageArn: handle.imageArn, imageVersion: handle.imageVersion };
    const version = await getClient().send(new GetMicrovmImageVersionCommand({
      imageIdentifier: identity.imageArn, imageVersion: identity.imageVersion,
    }), { abortSignal: AbortSignal.timeout(MICROVM_IMAGE_CAPABILITY_REQUEST_TIMEOUT_MS) });
    if (!verifyMicrovmImageLifecycle(identity, version)) return handle;
    const capable = { ...handle, lifecycleProtocol: MICROVM_LIFECYCLE_PROTOCOL };
    await saveMicrovmImageCapability(taskId, clientToken, capable);
    return capable;
  } catch (error) {
    const name = (error as { name?: unknown })?.name;
    logger.warn('MicroVM image capability unavailable; automatic suspension remains disabled', {
      task_id: taskId,
      microvm_id: handle.microvmId,
      error_type: typeof name === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(name) ? name : 'Error',
    });
    return handle;
  }
}

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
      throw new Error(
        'This repository is configured compute_type=lambda-microvm, but this stack was deployed without the '
        + 'Lambda MicroVMs substrate (missing MICROVM_IMAGE_IDENTIFIER/MICROVM_EXECUTION_ROLE_ARN/'
        + 'MICROVM_EGRESS_CONNECTOR_ARNS/MICROVM_PAYLOAD_BUCKET). Redeploy the stack with '
        + '`--context compute_type=lambda-microvm` to provision the MicroVM substrate, or set this repo to '
        + 'compute_type=agentcore (bgagent repo onboard <repo> --compute-type agentcore).',
      );
    }

    const { taskId, payload } = input;

    assertImageArn(MICROVM_IMAGE_IDENTIFIER);
    const imageVersion = MICROVM_IMAGE_VERSION;

    const platformConfig = buildMicrovmPlatformConfig();

    // `RunMicrovm` does NOT default to "no ingress" — omitting the field attaches
    // the AWS-managed PUBLIC `HTTP_INGRESS` connector (live 2026-07-31).
    const configuredIngress = parseArnList(MICROVM_INGRESS_CONNECTOR_ARNS);
    const ingressNetworkConnectors = configuredIngress.length > 0
      ? configuredIngress
      : [noIngressConnectorArn()];

    const request = {
      imageIdentifier: MICROVM_IMAGE_IDENTIFIER,
      ...(imageVersion && { imageVersion }),
      executionRoleArn: MICROVM_EXECUTION_ROLE_ARN,
      egressNetworkConnectors: parseArnList(MICROVM_EGRESS_CONNECTOR_ARNS),
      ingressNetworkConnectors,
      maximumDurationInSeconds: MICROVM_MAX_DURATION_SECONDS,
      // `idlePolicy` is OMITTED (ADR-021 sub-decision 1): MicroVM idle policies
      // measure idleness as inbound traffic at the endpoint, and the agent is
      // outbound-only.
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
    const runHookPayload = await deliverRunHookPayload(taskId, payload, platformConfig);
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
      throw runMicrovmStartError(err);
    }

    const { microvmId, endpoint } = result;
    if (!microvmId || !endpoint) {
      if (microvmId) {
        await this.terminateBestEffort(microvmId, 'incomplete RunMicrovm response');
      }
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

    let handle: MicrovmSessionHandle = {
      sessionId: microvmId,
      strategyType: 'lambda-microvm',
      microvmId,
      endpoint,
      ...readMicrovmImageMetadata({ imageArn: result.imageArn, imageVersion: result.imageVersion }),
    };
    try {
      await saveMicrovmStartHandle(taskId, latest.clientToken, handle);
    } catch (err) {
      try {
        const saved = await claimMicrovmStart(taskId, input.userId, requestHash);
        if (!saved.closed && saved.handle?.microvmId === microvmId) return saved.handle;
      } catch (readErr) {
        logger.warn('Could not reconcile the MicroVM start receipt', { task_id: taskId, error: String(readErr) });
      }
      await this.terminateBestEffort(microvmId, 'start receipt could not save handle');
      throw new Error(`MICROVM_START_RECEIPT_SAVE_FAILED: ${String(err)}`, { cause: err });
    }

    handle = await discoverImageCapability(taskId, latest.clientToken, handle);

    logger.info('Lambda MicroVM session started', {
      task_id: taskId,
      microvm_id: microvmId,
      state: result.state,
      image_identifier: MICROVM_IMAGE_IDENTIFIER,
      image_arn: result.imageArn,
      image_version: handle.imageVersion ?? null,
      lifecycle_protocol: handle.lifecycleProtocol ?? 'unverified',
      maximum_duration_seconds: MICROVM_MAX_DURATION_SECONDS,
      payload_delivery: runHookPayloadDelivery(runHookPayload),
      platform_config_keys: Object.keys(platformConfig),
    });

    return handle;
  }

  /**
   * Report the substrate's view of the session. No task-state interpretation
   * happens here (ADR-021 sub-decision 1).
   *
   * State mapping:
   *   - ``PENDING`` / ``RUNNING`` → ``running``.
   *   - ``SUSPENDING`` / ``SUSPENDED`` → ``suspended``.
   *   - ``TERMINATING`` / ``TERMINATED`` → ``completed``. Both carry no exit
   *     code, and TERMINATING confirms shutdown is underway, not that it has
   *     finished. A terminated MicroVM stays observable as ``TERMINATED`` for at
   *     least ~10 minutes (live-measured).
   *   - anything else (an unrecognized future state) → ``running`` with explicit
   *     UNKNOWN state.
   * ``microvmState`` also reports the explicit observed state (or local UNKNOWN /
   * NOT_FOUND).
   *
   * Service failure reasons are preserved in SessionStatus.reason, except the
   * known benign success string.
   */
  async pollSession(handle: SessionHandle, options?: SessionControlOptions): Promise<SessionStatus> {
    if (handle.strategyType !== 'lambda-microvm') {
      throw new Error('pollSession called with non-lambda-microvm handle');
    }
    const { microvmId } = handle;

    let state: string | undefined;
    let stateReason: string | undefined;
    let requestIdentity: ReturnType<typeof microvmRequestIdentity> = {};
    let lifetime: Pick<SessionStatus, 'microvmStartedAtMs' | 'microvmMaximumDurationSeconds'> = {};
    try {
      const result = await getClient().send(new GetMicrovmCommand({
        microvmIdentifier: microvmId,
      }), { abortSignal: controlSignal(options) });
      state = result.state;
      requestIdentity = microvmRequestIdentity(result);
      const startedAtMs = result.startedAt instanceof Date ? result.startedAt.getTime() : NaN;
      if (Number.isSafeInteger(startedAtMs) && startedAtMs >= 0
        && Number.isSafeInteger(result.maximumDurationInSeconds) && result.maximumDurationInSeconds! > 0) {
        lifetime = {
          microvmStartedAtMs: startedAtMs,
          microvmMaximumDurationSeconds: result.maximumDurationInSeconds,
        };
      }
      stateReason = result.stateReason && result.stateReason !== MICROVM_BENIGN_STATE_REASON
        ? result.stateReason
        : undefined;
    } catch (err) {
      if (err instanceof Error && err.name === 'ResourceNotFoundException') {
        logger.info('MicroVM not found on poll — treating as terminal', {
          microvm_id: microvmId,
          ...microvmErrorIdentity(err),
        });
        return { status: 'completed', microvmState: 'NOT_FOUND' };
      }
      throw wrapMicrovmError('GetMicrovm', err);
    }

    switch (state) {
      case MicrovmState.PENDING:
      case MicrovmState.RUNNING:
        return { status: 'running', microvmState: state, ...lifetime, ...(stateReason && { reason: stateReason }) };
      case MicrovmState.SUSPENDING:
      case MicrovmState.SUSPENDED:
        return { status: 'suspended', microvmState: state, ...lifetime, ...(stateReason && { reason: stateReason }) };
      case MicrovmState.TERMINATING:
      case MicrovmState.TERMINATED:
        if (stateReason) {
          logger.warn('MicroVM reached a terminal state with a substrate reason', {
            microvm_id: microvmId,
            image_arn: handle.imageArn,
            image_version: handle.imageVersion,
            ...requestIdentity,
            state,
            state_reason: stateReason,
          });
        }
        return { status: 'completed', microvmState: state, ...lifetime, ...(stateReason && { reason: stateReason }) };
      default:
        logger.warn('Unrecognized MicroVM state — reporting running', {
          microvm_id: microvmId,
          ...requestIdentity,
          state,
          ...(stateReason && { state_reason: stateReason }),
        });
        return { status: 'running', microvmState: 'UNKNOWN', ...lifetime, ...(stateReason && { reason: stateReason }) };
    }
  }

  /**
   * Terminate the MicroVM. Best-effort: a stop that cannot happen never fails
   * the caller.
   */
  async stopSession(handle: SessionHandle, options?: SessionControlOptions): Promise<SessionStopResult> {
    if (handle.strategyType !== 'lambda-microvm') {
      throw new Error('stopSession called with non-lambda-microvm handle');
    }
    return this.terminateBestEffort(handle.microvmId, 'session stop', options);
  }

  /** Submit a suspend request; the caller owns gate checks and state reconciliation. */
  async suspendSession(handle: SessionHandle, options?: SessionControlOptions): Promise<SessionLifecycleResult> {
    return this.requestLifecycle('suspendSession', handle, options);
  }

  /** Submit a resume request; acknowledgement alone does not establish RUNNING. */
  async resumeSession(handle: SessionHandle, options?: SessionControlOptions): Promise<SessionLifecycleResult> {
    return this.requestLifecycle('resumeSession', handle, options);
  }

  private async requestLifecycle(
    operation: 'suspendSession' | 'resumeSession',
    handle: SessionHandle,
    options?: SessionControlOptions,
  ): Promise<SessionLifecycleResult> {
    if (handle.strategyType !== 'lambda-microvm') {
      throw new Error(`${operation} called with non-lambda-microvm handle`);
    }
    if (typeof handle.microvmId !== 'string' || !handle.microvmId.trim()) {
      throw new Error(`${operation} requires a non-empty MicroVM identifier`);
    }
    const suspend = operation === 'suspendSession';
    const request = { microvmIdentifier: handle.microvmId };
    const startedAt = Date.now();
    const diagnostic = {
      operation: suspend ? 'SuspendMicrovm' : 'ResumeMicrovm',
      microvm_id: handle.microvmId,
      image_arn: handle.imageArn,
      image_version: handle.imageVersion,
    };
    logger.info('MicroVM lifecycle request started', diagnostic);
    try {
      const response = await getClient().send(
        suspend ? new SuspendMicrovmCommand(request) : new ResumeMicrovmCommand(request),
        { abortSignal: controlSignal(options) },
      );
      logger.info('MicroVM lifecycle request acknowledged', {
        ...diagnostic, elapsed_ms: Date.now() - startedAt, ...microvmRequestIdentity(response),
      });
    } catch (error) {
      logger.warn('MicroVM lifecycle request failed', {
        ...diagnostic, elapsed_ms: Date.now() - startedAt, ...microvmErrorIdentity(error),
      });
      throw wrapMicrovmError(suspend ? 'SuspendMicrovm' : 'ResumeMicrovm', error);
    }
    return { supported: true };
  }

  private async terminateBestEffort(microvmId: string, reason: string, options?: SessionControlOptions): Promise<SessionStopResult> {
    const startedAt = Date.now();
    try {
      const response = await getClient().send(new TerminateMicrovmCommand({
        microvmIdentifier: microvmId,
      }), { abortSignal: controlSignal(options) });
      logger.info('Lambda MicroVM termination requested', {
        microvm_id: microvmId, reason, elapsed_ms: Date.now() - startedAt, ...microvmRequestIdentity(response),
      });
      return { outcome: 'requested' };
    } catch (err) {
      const identity = microvmErrorIdentity(err);
      const errName = identity.error_type;
      if (errName === 'ConflictException') {
        try {
          const observed = await getClient().send(new GetMicrovmCommand({
            microvmIdentifier: microvmId,
          }), { abortSignal: controlSignal(options) });
          if (observed?.state === 'TERMINATED') {
            logger.info('MicroVM already terminated during concurrent cleanup', { microvm_id: microvmId, reason });
            return { outcome: 'terminated' };
          }
        } catch (confirmationError) {
          if (microvmErrorIdentity(confirmationError).error_type === 'ResourceNotFoundException') {
            logger.info('MicroVM no longer found during concurrent cleanup', { microvm_id: microvmId, reason });
            return { outcome: 'not-found' };
          }
          logger.warn('MicroVM termination conflict could not be confirmed', {
            microvm_id: microvmId, ...microvmErrorIdentity(confirmationError),
          });
        }
      }
      if (errName === 'ResourceNotFoundException') {
        logger.info('MicroVM no longer found during termination', {
          microvm_id: microvmId,
          reason,
          error_type: errName,
        });
        return { outcome: 'not-found' };
      } else if (errName === 'ThrottlingException' || errName === 'AccessDeniedException') {
        logger.error('Failed to terminate MicroVM', {
          microvm_id: microvmId,
          reason,
          ...identity,
        });
      } else {
        logger.warn('Failed to terminate MicroVM (best-effort)', {
          microvm_id: microvmId,
          reason,
          ...identity,
        });
      }
      return { outcome: 'unconfirmed', ...identity };
    }
  }
}

/** The service's limit on the serialized `runHookPayload`, in bytes. */
export const MICROVM_RUN_HOOK_PAYLOAD_LIMIT_BYTES = RUN_HOOK_PAYLOAD_LIMIT_BYTES;

/**
 * The `NO_INGRESS` fallback the strategy substitutes when
 * `MICROVM_INGRESS_CONNECTOR_ARNS` is missing.
 */
export const microvmNoIngressConnectorArnForRegion = noIngressConnectorArn;
