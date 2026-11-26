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

import { S3Client } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { TaskStatus, TERMINAL_STATUSES, VALID_TRANSITIONS, type TaskStatusType } from '../../constructs/task-status';
import { evaluateAgentHeartbeat } from './agent-heartbeat';
import { resolveRepositoryBackend } from './compute-backend';
import type { SessionControlOptions, SessionHandle } from './compute-strategy';
import { AttachmentBudgetExceededError, AttachmentConfigurationError, AttachmentResolutionError, hydrateContext, resolveGitHubToken } from './context-hydration';
import { logger, type Logger } from './logger';
import { writeMinimalEpisode } from './memory';
import { readMicrovmImageMetadata } from './microvm/image-capability';
import { permanent, type MicrovmSupervisorState } from './microvm/supervisor';
import { coerceNumericOrNull } from './numeric';
import { computePromptVersion } from './prompt-version';
import { makeRegistryClient } from './registry/factory';
import { parseRef } from './registry/ref';
import { RegistryResolutionError, type ResolvedAsset } from './registry/types';
import { loadRepoConfig, type BlueprintConfig, type ComputeType } from './repo-config';
import { resolveUrlAttachments } from './resolve-url-attachments';
import { APPROVAL_GATE_CAP_MAX, APPROVAL_GATE_CAP_MIN, type AgentAttachmentPayload, type AttachmentRecord, type TaskRecord } from './types';
import { makeClient, makeDocClient } from './ua';
import { computeTtlEpoch, DEFAULT_MAX_TURNS } from './validation';

const ddb = makeDocClient();

const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;
const CONCURRENCY_TABLE_NAME = process.env.USER_CONCURRENCY_TABLE_NAME!;
const RUNTIME_ARN = process.env.RUNTIME_ARN!;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '3');
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');
const MEMORY_ID = process.env.MEMORY_ID;
const ATTACHMENTS_BUCKET_NAME = process.env.ATTACHMENTS_BUCKET_NAME;

/** GitHub caps issue titles at 256 characters; store no more than that. */
export const ISSUE_TITLE_MAX_LENGTH = 256;

const MAX_IMAGE_TOKENS_FALLBACK = 1568;

/**
 * State tracked across waitForCondition poll cycles.
 */
export interface PollState {
  readonly attempts: number;
  readonly lastStatus?: TaskStatusType;
  /** True when the agent stopped sending heartbeats while still RUNNING (likely crash/OOM). */
  readonly sessionUnhealthy?: boolean;
  /** Consecutive ECS poll failures — escalated to error after 3. */
  readonly consecutiveEcsPollFailures?: number;
  /** Consecutive polls where ECS reports completed but DDB is not terminal — escalated after 5. */
  readonly consecutiveEcsCompletedPolls?: number;
  readonly microvmSupervisor?: MicrovmSupervisorState;
  readonly microvmFailureReason?: string;
  readonly microvmFailureMessage?: string;
  /** The task row no longer names this execution's MicroVM; clean up only its own handle. */
  readonly microvmOwnershipLost?: boolean;
}

// Observed on Lambda MicroVMs: a MicroVM with a broken hook sat in `RUNNING` indefinitely with no
// `stateReason`. `GetMicrovm` shows a VM that died, not a guest that hangs.
function heartbeatLivenessApplies(computeType: ComputeType): boolean {
  switch (computeType) {
    case 'agentcore':
    case 'lambda-microvm':
      return true;
    case 'ecs':
      return false;
    default: {
      const _exhaustive: never = computeType;
      throw new Error(`Unknown compute type for heartbeat liveness: ${String(_exhaustive)}`);
    }
  }
}

function substrateNoun(computeType: ComputeType | undefined): string {
  switch (computeType) {
    case 'lambda-microvm':
      return 'the MicroVM';
    case 'ecs':
    case 'agentcore':
      return 'the container';
    default:
      return 'the runtime';
  }
}

/**
 * Load a task record from DynamoDB.
 * @param taskId - the task to load.
 * @returns the task record.
 * @throws Error if the task is not found.
 */
export async function loadTask(taskId: string, consistentRead = false): Promise<TaskRecord> {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { task_id: taskId },
    ...(consistentRead && { ConsistentRead: true }),
  }));
  if (!result.Item) {
    throw new Error(`Task ${taskId} not found`);
  }
  return result.Item as TaskRecord;
}

/**
 * Admission control: check user concurrency and increment counter.
 * @param task - the task record.
 * @returns true if admitted, false if concurrency limit reached.
 */
export async function admissionControl(task: TaskRecord): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: CONCURRENCY_TABLE_NAME,
      Key: { user_id: task.user_id },
      UpdateExpression: 'SET active_count = if_not_exists(active_count, :zero) + :one, updated_at = :now',
      ConditionExpression: 'attribute_not_exists(active_count) OR active_count < :max',
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
        ':max': MAX_CONCURRENT,
        ':now': new Date().toISOString(),
      },
    }));
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'name' in err && err.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw err;
  }
}

/**
 * Transition a task's status with a conditional check enforcing valid transitions.
 * @param taskId - the task to update.
 * @param fromStatus - expected current status.
 * @param toStatus - target status.
 * @param extraAttrs - additional attributes to set.
 */
export async function transitionTask(
  taskId: string,
  fromStatus: TaskStatusType,
  toStatus: TaskStatusType,
  extraAttrs?: Record<string, unknown>,
  expectedMicrovmId?: string,
): Promise<void> {
  const validTargets = VALID_TRANSITIONS[fromStatus];
  if (!validTargets.includes(toStatus)) {
    throw new Error(`Invalid transition: ${fromStatus} -> ${toStatus}`);
  }

  const now = new Date().toISOString();
  let updateExpression = 'SET #status = :toStatus, #sca = :sca, #updatedAt = :now';
  const expressionNames: Record<string, string> = {
    '#status': 'status',
    '#sca': 'status_created_at',
    '#updatedAt': 'updated_at',
  };
  const expressionValues: Record<string, unknown> = {
    ':fromStatus': fromStatus,
    ':toStatus': toStatus,
    ':sca': `${toStatus}#${now}`,
    ':now': now,
  };

  if (TERMINAL_STATUSES.includes(toStatus)) {
    updateExpression += ', #ttl = :ttl';
    expressionNames['#ttl'] = 'ttl';
    expressionValues[':ttl'] = computeTtlEpoch(TASK_RETENTION_DAYS);
  }

  if (extraAttrs) {
    for (const [key, value] of Object.entries(extraAttrs)) {
      const namePlaceholder = `#attr_${key}`;
      const valuePlaceholder = `:attr_${key}`;
      updateExpression += `, ${namePlaceholder} = ${valuePlaceholder}`;
      expressionNames[namePlaceholder] = key;
      expressionValues[valuePlaceholder] = value;
    }
  }

  let condition = '#status = :fromStatus';
  if (expectedMicrovmId) {
    condition += ' AND compute_type = :microvmType AND session_id = :microvmId AND compute_metadata.microvmId = :microvmId';
    expressionValues[':microvmType'] = 'lambda-microvm';
    expressionValues[':microvmId'] = expectedMicrovmId;
  }
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { task_id: taskId },
    UpdateExpression: updateExpression,
    ConditionExpression: condition,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues,
  }));
}

/** Correlation envelope stamped on orchestrator-plane task events. */
export interface EventCorrelation {
  readonly user_id?: string;
  /** `owner/repo`, or absent for repo-less workflows (those with no target
   *  repository). Matches the source `TaskRecord.repo` (`string | undefined`). */
  readonly repo?: string;
}

/**
 * Build the correlation envelope for a task from its identity fields:
 * a `log` child stamping `{task_id, user_id, repo}` on every line, and the
 * matching `correlation` for `emitTaskEvent`. `repo` is omitted (not null/empty)
 * for repo-less workflows.
 */
export function envelopeFor(
  identity: { task_id: string; user_id: string; repo?: string },
): { log: Logger; correlation: EventCorrelation } {
  const { task_id, user_id, repo } = identity;
  return {
    log: logger.child({ task_id, user_id, ...(repo && { repo }) }),
    correlation: { user_id, repo },
  };
}

/**
 * Emit a task event to the audit log.
 * @param taskId - the task ID.
 * @param eventType - the event type string.
 * @param metadata - optional event metadata; an entry whose value is undefined is left out.
 * @param correlation - optional `{ user_id, repo }` stamped as top-level fields
 *   so the event stream joins to orchestrator logs by the correlation envelope.
 *   `repo` is omitted when null/absent (repo-less workflows).
 */
export async function emitTaskEvent(
  taskId: string,
  eventType: string,
  metadata?: Record<string, unknown>,
  correlation?: EventCorrelation,
  options?: SessionControlOptions,
): Promise<void> {
  options?.abortSignal?.throwIfAborted();
  await ddb.send(new PutCommand({
    TableName: EVENTS_TABLE_NAME,
    Item: {
      task_id: taskId,
      event_id: ulid(),
      event_type: eventType,
      timestamp: new Date().toISOString(),
      ttl: computeTtlEpoch(TASK_RETENTION_DAYS),
      ...(correlation?.user_id && { user_id: correlation.user_id }),
      ...(correlation?.repo && { repo: correlation.repo }),
      // The document client leaves out an undefined attribute of the item itself,
      // but throws on one inside a map.
      ...(metadata && { metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)) }),
    },
  }), options);
}

const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 300_000;

/**
 * Build the ``compute_metadata`` map persisted on the task row at session start,
 * so a later handler can act on the right backend without re-deriving anything.
 *
 * DynamoDB stores this as ``Record<string, string>`` (see
 * ``TaskRecord.compute_metadata``), so every value must already be a string.
 */
export function buildComputeMetadata(handle: SessionHandle): Record<string, string> {
  switch (handle.strategyType) {
    case 'ecs':
      return { clusterArn: handle.clusterArn, taskArn: handle.taskArn };
    case 'agentcore':
      return { runtimeArn: handle.runtimeArn };
    case 'lambda-microvm':
      return { microvmId: handle.microvmId, endpoint: handle.endpoint, ...readMicrovmImageMetadata(handle) };
    default: {
      const _exhaustive: never = handle;
      throw new Error(`Unknown strategyType on session handle: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Load blueprint configuration for a task's repository and merge with platform defaults.
 * @param task - the task record (needs task.repo).
 * @returns the merged blueprint config.
 */
export async function loadBlueprintConfig(task: TaskRecord): Promise<BlueprintConfig> {
  const { log } = envelopeFor(task);

  const repoConfig = task.repo ? await loadRepoConfig(task.repo) : null;

  if (repoConfig) {
    log.info('Loaded per-repo blueprint config', {
      has_runtime_override: !!repoConfig.runtime_arn,
      has_model_override: !!repoConfig.model_id,
      has_prompt_override: !!repoConfig.system_prompt_overrides,
      has_token_override: !!repoConfig.github_token_secret_arn,
    });
  } else {
    log.info('No per-repo config found, using platform defaults');
  }

  let pollIntervalMs = repoConfig?.poll_interval_ms;
  if (pollIntervalMs !== undefined) {
    const clamped = Math.min(Math.max(pollIntervalMs, MIN_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS);
    if (clamped !== pollIntervalMs) {
      log.warn('poll_interval_ms clamped to safe range', {
        original: pollIntervalMs,
        clamped,
        min: MIN_POLL_INTERVAL_MS,
        max: MAX_POLL_INTERVAL_MS,
      });
      pollIntervalMs = clamped;
    }
  }

  // No workflow changes the backend: a read-only or repo-less task also runs on the repository's pin, or else on the default backend (#852).
  return {
    compute_type: resolveRepositoryBackend(repoConfig?.compute_type, process.env.DEPLOYED_COMPUTE_TYPE),
    runtime_arn: repoConfig?.runtime_arn ?? RUNTIME_ARN,
    model_id: repoConfig?.model_id,
    max_turns: repoConfig?.max_turns,
    max_budget_usd: repoConfig?.max_budget_usd,
    memory_token_budget: repoConfig?.memory_token_budget,
    system_prompt_overrides: repoConfig?.system_prompt_overrides,
    github_token_secret_arn: repoConfig?.github_token_secret_arn ?? process.env.GITHUB_TOKEN_SECRET_ARN,
    poll_interval_ms: pollIntervalMs,
    build_command: repoConfig?.build_command,
    lint_command: repoConfig?.lint_command,
    cedar_policies: repoConfig?.cedar_policies,
    approval_gate_cap: repoConfig?.approval_gate_cap,
    mcp_servers: repoConfig?.mcp_servers,
    cedar_policy_modules: repoConfig?.cedar_policy_modules,
    skills: repoConfig?.skills,
  };
}

/**
 * Resolve the Blueprint's ``registry://`` asset refs (#246) to a bundle the
 * agent can load. Fail-closed: any unresolved ref throws, which the orchestrator
 * turns into a FAILED task rather than running with a missing/substituted asset.
 */
export async function resolveRegistryAssets(
  blueprintConfig: BlueprintConfig | undefined,
  log: Logger,
): Promise<ResolvedAsset[]> {
  const refs = [
    ...(blueprintConfig?.mcp_servers ?? []),
    ...(blueprintConfig?.cedar_policy_modules ?? []),
    ...(blueprintConfig?.skills ?? []),
  ];
  if (refs.length === 0) return [];

  const client = makeRegistryClient();
  const resolved: ResolvedAsset[] = [];
  for (const ref of refs) {
    const parsed = parseRef(ref);
    if (!parsed.ok) {
      throw new RegistryResolutionError(parsed.reason, ref, parsed.message);
    }
    const asset = await client.resolve(parsed.ref);
    if (asset.warnings.length > 0) {
      log.warn('Registry asset resolved with warnings', { ref, warnings: asset.warnings });
    }
    resolved.push(asset);
  }
  log.info('Resolved registry assets', { count: resolved.length });
  return resolved;
}

function resolveAttachmentPayloads(
  attachments: AttachmentRecord[],
  tokenBudget: number,
): AgentAttachmentPayload[] {
  const payloads: AgentAttachmentPayload[] = [];
  let totalImageTokens = 0;

  for (const att of attachments) {
    if (att.screening.status !== 'passed') continue;
    if (!att.s3_key || !att.s3_version_id || !att.checksum_sha256 || !att.size_bytes) {
      throw new AttachmentResolutionError(
        `Attachment '${att.filename}' (${att.attachment_id}) has passed screening but is missing required ` +
        'storage metadata (s3_key, s3_version_id, checksum_sha256, or size_bytes). ' +
        'This is an internal data integrity error — please re-submit the task.',
      );
    }

    if (att.type === 'image') {
      totalImageTokens += att.token_estimate ?? MAX_IMAGE_TOKENS_FALLBACK;
    }

    payloads.push({
      attachment_id: att.attachment_id,
      type: att.type,
      content_type: att.content_type,
      filename: att.filename,
      s3_uri: `s3://${ATTACHMENTS_BUCKET_NAME}/${att.s3_key}`,
      s3_version_id: att.s3_version_id,
      size_bytes: att.size_bytes,
      checksum_sha256: att.checksum_sha256,
      ...(att.source_url && { source_url: att.source_url }),
      ...(att.token_estimate !== undefined && { token_estimate: att.token_estimate }),
    });
  }

  if (totalImageTokens > tokenBudget) {
    throw new AttachmentBudgetExceededError(
      `Image attachments require ~${totalImageTokens} tokens, exceeding the ${tokenBudget}-token budget. ` +
      'Reduce the number or resolution of image attachments.',
    );
  }

  return payloads;
}

async function storeAttachmentRecords(taskId: string, attachments: AttachmentRecord[], log: Logger): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
      UpdateExpression: 'SET #at = :at, #ua = :now',
      ExpressionAttributeNames: { '#at': 'attachments', '#ua': 'updated_at' },
      ExpressionAttributeValues: { ':at': attachments, ':now': new Date().toISOString() },
    }));
  } catch (err) {
    log.warn('Failed to store resolved URL attachments on task record', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function isValidApprovalGateCap(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isInteger(value)
    && value >= APPROVAL_GATE_CAP_MIN
    && value <= APPROVAL_GATE_CAP_MAX
  );
}

/**
 * Transition task to HYDRATING and assemble the invocation payload.
 * @param task - the task record.
 * @param blueprintConfig - optional per-repo blueprint config.
 * @returns the assembled payload for the agent runtime.
 */
// eslint-disable-next-line complexity -- predates the ceiling (81 when it landed); must not grow
export async function hydrateAndTransition(task: TaskRecord, blueprintConfig?: BlueprintConfig): Promise<Record<string, unknown>> {
  const { log, correlation } = envelopeFor(task);
  await transitionTask(task.task_id, TaskStatus.SUBMITTED, TaskStatus.HYDRATING);
  await emitTaskEvent(task.task_id, 'hydration_started', undefined, correlation);

  const { github_token_secret_arn: githubTokenSecretArn, memory_token_budget: memoryTokenBudget } = blueprintConfig ?? {};
  const hydratedContext = await hydrateContext(task, {
    githubTokenSecretArn,
    memoryId: MEMORY_ID,
    memoryTokenBudget,
  });

  if (hydratedContext.guardrail_blocked) {
    try {
      await emitTaskEvent(task.task_id, 'guardrail_blocked', {
        reason: hydratedContext.guardrail_blocked,
        resolved_workflow: task.resolved_workflow?.id,
        pr_number: task.pr_number,
        sources: hydratedContext.sources,
        token_estimate: hydratedContext.token_estimate,
        ...(hydratedContext.content_trust && { content_trust: hydratedContext.content_trust }),
      }, correlation);
    } catch (eventErr) {
      log.error('Failed to emit guardrail_blocked event', {
        error: eventErr instanceof Error ? eventErr.message : String(eventErr),
      });
    }
    throw new Error(`Guardrail blocked: ${hydratedContext.guardrail_blocked}`);
  }

  if (hydratedContext.resolved_branch_name) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { task_id: task.task_id },
        UpdateExpression: 'SET #bn = :bn, #ua = :now',
        ExpressionAttributeNames: { '#bn': 'branch_name', '#ua': 'updated_at' },
        ExpressionAttributeValues: { ':bn': hydratedContext.resolved_branch_name, ':now': new Date().toISOString() },
      }));
    } catch (err) {
      log.error('Failed to update branch_name from PR head_ref — task record will show stale placeholder', {
        resolved_branch: hydratedContext.resolved_branch_name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const issueTitle = hydratedContext.issue?.title.trim().slice(0, ISSUE_TITLE_MAX_LENGTH);
  if (issueTitle) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { task_id: task.task_id },
        UpdateExpression: 'SET #it = :it, #ua = :now',
        ExpressionAttributeNames: { '#it': 'issue_title', '#ua': 'updated_at' },
        ExpressionAttributeValues: { ':it': issueTitle, ':now': new Date().toISOString() },
      }));
    } catch (err) {
      log.warn('Failed to store issue_title on task record', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const promptVersionInput = blueprintConfig?.system_prompt_overrides ?? '';
  const promptVersion = computePromptVersion('system_prompt_v1', promptVersionInput ? { overrides: promptVersionInput } : undefined);

  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { task_id: task.task_id },
      UpdateExpression: 'SET #pv = :pv, #ua = :now',
      ExpressionAttributeNames: { '#pv': 'prompt_version', '#ua': 'updated_at' },
      ExpressionAttributeValues: { ':pv': promptVersion, ':now': new Date().toISOString() },
    }));
  } catch (err) {
    log.warn('Failed to store prompt_version on task record', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const effectiveBudget = task.max_budget_usd ?? blueprintConfig?.max_budget_usd;

  if (
    task.approval_gate_cap !== undefined
    && !isValidApprovalGateCap(task.approval_gate_cap)
  ) {
    log.warn('TaskRecord.approval_gate_cap is not a valid integer in bounds; omitting from agent payload', {
      approval_gate_cap: task.approval_gate_cap,
      min: APPROVAL_GATE_CAP_MIN,
      max: APPROVAL_GATE_CAP_MAX,
    });
  }

  let resolvedAttachments = task.attachments ?? [];
  if (resolvedAttachments.some(a => a.type === 'url' && a.screening.status === 'pending') && ATTACHMENTS_BUCKET_NAME) {
    const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
    const screeningConfig = process.env.GUARDRAIL_ID && process.env.GUARDRAIL_VERSION
      ? {
        guardrailId: process.env.GUARDRAIL_ID,
        guardrailVersion: process.env.GUARDRAIL_VERSION,
        bedrockClient: makeClient(BedrockRuntimeClient),
      }
      : undefined;

    if (!screeningConfig) {
      throw new AttachmentConfigurationError(
        'URL attachments require content screening (Bedrock Guardrail) but screening is not configured. ' +
        'Set GUARDRAIL_ID and GUARDRAIL_VERSION environment variables.',
      );
    }

    let githubToken: string | undefined;
    if (githubTokenSecretArn) {
      try {
        githubToken = await resolveGitHubToken(githubTokenSecretArn);
      } catch (err) {
        const githubHosts = ['github.com', 'raw.githubusercontent.com', 'api.github.com'];
        const pendingUrlAtts = resolvedAttachments.filter(a => a.type === 'url' && a.screening.status === 'pending');
        const hasGitHubUrl = pendingUrlAtts.some(a => {
          try {
            const hostname = new URL(a.source_url ?? '').hostname.toLowerCase();
            return githubHosts.some(h => hostname === h || hostname.endsWith(`.${h}`));
          } catch { return false; }
        });

        if (hasGitHubUrl) {
          throw new AttachmentResolutionError(
            'Failed to retrieve GitHub credentials needed to fetch URL attachment(s). ' +
            `Ensure the GitHub token secret (${githubTokenSecretArn}) is accessible. ` +
            `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }

        log.warn('Failed to resolve GitHub token for URL attachment fetch (no GitHub URLs in batch — proceeding)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    resolvedAttachments = await resolveUrlAttachments(
      resolvedAttachments,
      task.task_id,
      task.user_id,
      {
        s3Client: makeClient(S3Client),
        bucketName: ATTACHMENTS_BUCKET_NAME,
        screeningConfig,
        githubToken,
        githubInstallationDomain: process.env.GITHUB_INSTALLATION_DOMAIN,
      },
    );
    await storeAttachmentRecords(task.task_id, resolvedAttachments, log);
  }

  const attachmentPayloads = resolvedAttachments.length > 0 && ATTACHMENTS_BUCKET_NAME
    ? resolveAttachmentPayloads(resolvedAttachments, Number(process.env.USER_PROMPT_TOKEN_BUDGET ?? '100000'))
    : [];

  const resolvedAssets = await resolveRegistryAssets(blueprintConfig, log);
  if (resolvedAssets.length > 0) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { task_id: task.task_id },
      UpdateExpression: 'SET #ra = :ra, #ua = :now',
      ExpressionAttributeNames: { '#ra': 'resolved_assets', '#ua': 'updated_at' },
      ExpressionAttributeValues: {
        ':ra': resolvedAssets.map((a) => ({
          kind: a.kind,
          id: `${a.namespace}/${a.name}`,
          version: a.version,
          ...(a.warnings.length > 0 && { warnings: [...a.warnings] }),
        })),
        ':now': new Date().toISOString(),
      },
    }));

    for (const a of resolvedAssets) {
      if (a.warnings.length > 0) {
        await emitTaskEvent(task.task_id, 'registry_asset_warning', {
          kind: a.kind,
          id: `${a.namespace}/${a.name}`,
          version: a.version,
          warnings: [...a.warnings],
        }, correlation);
      }
    }
  }

  const resolvedCedar = resolvedAssets
    .filter((a) => a.kind === 'cedar_policy_module')
    .map((a) => {
      const text = (a.runtime as { cedar_text?: string }).cedar_text;
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new RegistryResolutionError(
          'REMOVED',
          `registry://cedar_policy_module/${a.namespace}/${a.name}@${a.version}`,
          `resolved cedar_policy_module ${a.namespace}/${a.name}@${a.version} has empty cedar_text`,
        );
      }
      return text;
    });
  const cedarText = [
    ...(blueprintConfig?.cedar_policies ?? []),
    ...resolvedCedar,
  ];

  const payload: Record<string, unknown> = {
    repo_url: task.repo,
    task_id: task.task_id,
    user_id: task.user_id,
    branch_name: hydratedContext.resolved_branch_name ?? task.branch_name,
    ...(task.issue_number !== undefined && { issue_number: String(task.issue_number) }),
    resolved_workflow: task.resolved_workflow ?? { id: 'coding/new-task-v1', version: '1.0.0' },
    ...(task.pr_number !== undefined && { pr_number: task.pr_number }),
    ...(hydratedContext.resolved_base_branch && { base_branch: hydratedContext.resolved_base_branch }),
    ...(!hydratedContext.resolved_base_branch
      && task.channel_metadata?.orchestration_base_branch
      && { base_branch: task.channel_metadata.orchestration_base_branch }),
    ...(task.channel_metadata?.orchestration_merge_branches
      && { merge_branches: parseMergeBranches(task.channel_metadata.orchestration_merge_branches) }),
    ...(task.task_description && { prompt: task.task_description }),
    max_turns: task.max_turns ?? blueprintConfig?.max_turns ?? DEFAULT_MAX_TURNS,
    ...(effectiveBudget !== undefined && { max_budget_usd: effectiveBudget }),
    ...(task.trace === true && { trace: true }),
    ...(blueprintConfig?.model_id && { model_id: blueprintConfig.model_id }),
    ...(blueprintConfig?.system_prompt_overrides && { system_prompt_overrides: blueprintConfig.system_prompt_overrides }),
    ...(blueprintConfig?.build_command && { build_command: blueprintConfig.build_command }),
    ...(blueprintConfig?.lint_command && { lint_command: blueprintConfig.lint_command }),
    ...(cedarText.length > 0 && { cedar_policies: cedarText }),
    ...(resolvedAssets.length > 0 && {
      resolved_assets: resolvedAssets.map((a) => ({
        kind: a.kind, namespace: a.namespace, name: a.name, version: a.version, runtime: a.runtime,
      })),
    }),
    task_started_at: new Date().toISOString(),
    ...(task.approval_timeout_s !== undefined && { approval_timeout_s: task.approval_timeout_s }),
    ...(task.initial_approvals && task.initial_approvals.length > 0 && { initial_approvals: task.initial_approvals }),
    ...(typeof task.approval_gate_count === 'number' && task.approval_gate_count > 0 && {
      initial_approval_gate_count: task.approval_gate_count,
    }),
    ...(isValidApprovalGateCap(task.approval_gate_cap)
      && { approval_gate_cap: task.approval_gate_cap }),
    prompt_version: promptVersion,
    ...(MEMORY_ID && { memory_id: MEMORY_ID }),
    hydrated_context: hydratedContext,
    channel_source: task.channel_source,
    ...(task.channel_metadata && Object.keys(task.channel_metadata).length > 0 && { channel_metadata: task.channel_metadata }),
    ...(attachmentPayloads.length > 0 && { attachments: attachmentPayloads }),
  };

  if (hydratedContext.fallback_error) {
    log.warn('Context hydration fell back to minimal payload', {
      fallback_error: hydratedContext.fallback_error,
    });
  }

  await emitTaskEvent(task.task_id, 'hydration_complete', {
    sources: hydratedContext.sources,
    token_estimate: hydratedContext.token_estimate,
    truncated: hydratedContext.truncated,
    prompt_version: promptVersion,
    has_memory_context: !!hydratedContext.memory_context,
    ...(hydratedContext.content_trust && { content_trust: hydratedContext.content_trust }),
    ...(hydratedContext.fallback_error && { fallback_error: hydratedContext.fallback_error }),
  }, correlation);
  return payload;
}

/**
 * Poll the task record in DynamoDB to check if the agent wrote a terminal status.
 * Returns the updated PollState; the waitStrategy decides whether to continue.
 *
 * Heartbeat staleness is evaluated for the backends
 * {@link heartbeatLivenessApplies} names, with the same thresholds for each.
 *
 * @param taskId - the task to poll.
 * @param state - current poll state.
 * @param computeType - the compute backend for this task (controls heartbeat checks).
 * @returns updated poll state with the latest task status; when the read fails
 *   with an error that can clear, the state it was given with one more attempt.
 * @throws the read error when it cannot clear ({@link permanent}).
 */
export async function pollTaskStatus(
  taskId: string,
  state: PollState,
  computeType: ComputeType,
): Promise<PollState> {
  let item: Record<string, unknown> | undefined;
  try {
    const result = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
      ProjectionExpression: '#st, session_id, started_at, agent_heartbeat_at',
      ExpressionAttributeNames: { '#st': 'status' },
    }));
    item = result.Item;
  } catch (err) {
    if (permanent(err)) {
      logger.error('Task status read refused, ending the orchestration', { task_id: taskId, error: String(err) });
      throw err;
    }
    // The durable execution SDK does not retry a waitForCondition check that throws:
    // it fails the operation.
    logger.warn('Task status read failed, counting it as a missed poll', {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...state, attempts: state.attempts + 1 };
  }

  const currentStatus = item?.status as TaskStatusType | undefined;

  let sessionUnhealthy = false;
  if (
    heartbeatLivenessApplies(computeType)
    && currentStatus === TaskStatus.RUNNING
    && item?.session_id
    && typeof item.started_at === 'string'
  ) {
    const now = Date.now();
    const startedMs = Date.parse(item.started_at);
    const heartbeatMs = typeof item.agent_heartbeat_at === 'string' ? Date.parse(item.agent_heartbeat_at) : undefined;
    const health = evaluateAgentHeartbeat(startedMs, heartbeatMs, now);
    sessionUnhealthy = health !== undefined;
    if (health === 'stale') {
      logger.warn('Agent heartbeat stale while task RUNNING', {
        task_id: taskId,
        compute_type: computeType,
        agent_heartbeat_at: item.agent_heartbeat_at,
        heartbeat_age_sec: Math.round((now - heartbeatMs!) / 1000),
      });
    } else if (health === 'missing') {
      logger.warn('Agent never sent heartbeat while task RUNNING past grace period', {
        task_id: taskId,
        compute_type: computeType,
        running_age_sec: Math.round((now - startedMs) / 1000),
      });
    }
  }

  return {
    attempts: state.attempts + 1,
    lastStatus: currentStatus,
    sessionUnhealthy,
  };
}

/**
 * Finalize a task: write terminal status, emit events, release concurrency.
 * @param taskId - the task ID.
 * @param pollState - the final poll state.
 * @param userId - the user who owns the task.
 */
export async function finalizeTask(
  taskId: string,
  pollState: PollState,
  userId: string,
): Promise<boolean> {
  const task = await loadTask(taskId, true);
  const expectedId = pollState.microvmSupervisor?.microvmId;
  if (expectedId && (task.user_id !== userId || task.compute_type !== 'lambda-microvm'
    || task.session_id !== expectedId || task.compute_metadata?.microvmId !== expectedId)) {
    logger.warn('MicroVM finalization skipped after worker ownership changed', { task_id: taskId, microvm_id: expectedId });
    return false;
  }
  await finalizeTaskOutcome(taskId, pollState, userId, task);
  return true;
}

async function finalizeMicrovmSupervisorFailure(
  taskId: string,
  pollState: PollState,
  userId: string,
  currentStatus: TaskStatusType,
  correlation: ReturnType<typeof envelopeFor>['correlation'],
): Promise<void> {
  const reason = pollState.microvmFailureReason!;
  const timeout = reason === 'session-deadline'
    && (currentStatus === TaskStatus.RUNNING || currentStatus === TaskStatus.FINALIZING);
  const terminal = timeout ? TaskStatus.TIMED_OUT : TaskStatus.FAILED;
  try {
    await transitionTask(taskId, currentStatus, terminal, {
      completed_at: new Date().toISOString(),
      error_message: pollState.microvmFailureMessage ?? `MicroVM supervisor: ${reason}`,
    }, pollState.microvmSupervisor?.microvmId);
  } catch (error) {
    const winner = await loadTask(taskId, true);
    if (!TERMINAL_STATUSES.includes(winner.status)) throw error;
    await emitTaskEvent(taskId, `task_${winner.status.toLowerCase()}`, {
      final_status: winner.status, poll_attempts: pollState.attempts,
    }, correlation);
    await decrementConcurrency(userId);
    return;
  }
  await emitTaskEvent(taskId, timeout ? 'task_timed_out' : 'task_failed', {
    reason: 'microvm_supervisor',
    detail: reason,
    microvm_id: pollState.microvmSupervisor?.microvmId,
    poll_attempts: pollState.attempts,
  }, correlation);
  await decrementConcurrency(userId);
}

async function finalizeTaskOutcome(taskId: string, pollState: PollState, userId: string, task: TaskRecord): Promise<void> {
  const currentStatus = task.status;
  const { log, correlation } = envelopeFor(task);

  if (pollState.microvmFailureReason && !TERMINAL_STATUSES.includes(currentStatus)) {
    await finalizeMicrovmSupervisorFailure(taskId, pollState, userId, currentStatus, correlation);
    return;
  }

  if (
    pollState.sessionUnhealthy
    && (currentStatus === TaskStatus.RUNNING || currentStatus === TaskStatus.FINALIZING)
  ) {
    let transitioned = false;
    try {
      await transitionTask(taskId, currentStatus, TaskStatus.FAILED, {
        completed_at: new Date().toISOString(),
        error_message:
          'Agent session lost: no recent heartbeat from the agent '
          + `(${substrateNoun(task.compute_type)} may have crashed, been OOM-killed, or stopped)`,
      }, pollState.microvmSupervisor?.microvmId);
      transitioned = true;
    } catch (err) {
      log.warn('Finalization transition to FAILED (heartbeat) failed, task may have transitioned concurrently', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (transitioned) {
      await emitTaskEvent(taskId, 'task_failed', {
        reason: 'agent_heartbeat_stale',
        poll_attempts: pollState.attempts,
      }, correlation);
      await decrementConcurrency(userId);
    } else {
      const reread = await loadTask(taskId, true);
      if (TERMINAL_STATUSES.includes(reread.status)) {
        log.info('Heartbeat path: task already terminal after failed transition', { status: reread.status });
        await emitTaskEvent(taskId, `task_${reread.status.toLowerCase()}`, {
          final_status: reread.status,
          poll_attempts: pollState.attempts,
        }, correlation);
        await decrementConcurrency(userId);
      } else {
        log.warn('Heartbeat path: task in unexpected state after failed transition, releasing concurrency', { status: reread.status });
        await decrementConcurrency(userId);
      }
    }
    return;
  }

  if (TERMINAL_STATUSES.includes(currentStatus)) {
    log.info('Task already in terminal state', { status: currentStatus });

    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { task_id: taskId },
        UpdateExpression: 'SET #ttl = :ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':ttl': computeTtlEpoch(TASK_RETENTION_DAYS) },
      }));
    } catch (err) {
      log.warn('Failed to stamp TTL on terminal task', { error: err instanceof Error ? err.message : String(err) });
    }

    if (MEMORY_ID && !task.memory_written) {
      log.info('Agent did not write memory — writing fallback episode');
      try {
        const durationS = coerceNumericOrNull(
          task.duration_s,
          { field: 'duration_s', task_id: taskId },
          logger,
        );
        const costUsd = coerceNumericOrNull(
          task.cost_usd,
          { field: 'cost_usd', task_id: taskId },
          logger,
        );
        const actorNamespace = task.repo ?? `user:${task.user_id}`;
        const written = await writeMinimalEpisode(
          MEMORY_ID,
          actorNamespace,
          taskId,
          currentStatus,
          durationS ?? undefined,
          costUsd ?? undefined,
        );
        if (!written) {
          log.warn('Fallback episode write returned false');
        }
      } catch (err) {
        log.warn('Fallback episode write threw unexpectedly (fail-open)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await emitTaskEvent(taskId, `task_${currentStatus.toLowerCase()}`, {
      final_status: currentStatus,
      poll_attempts: pollState.attempts,
    }, correlation);
    await decrementConcurrency(userId);
    return;
  }

  if (
    currentStatus === TaskStatus.RUNNING
    || currentStatus === TaskStatus.FINALIZING
    || currentStatus === TaskStatus.AWAITING_APPROVAL
  ) {
    const terminalStatus = currentStatus === TaskStatus.AWAITING_APPROVAL ? TaskStatus.FAILED : TaskStatus.TIMED_OUT;
    try {
      await transitionTask(taskId, currentStatus, terminalStatus, {
        completed_at: new Date().toISOString(),
        error_message: currentStatus === TaskStatus.AWAITING_APPROVAL
          ? 'Task execution limit reached while waiting for approval. '
            + 'The task has closed; submit a new task to continue.'
          : 'Orchestrator poll timeout exceeded',
      });
    } catch (err) {
      log.warn('Finalization transition failed, task may have transitioned concurrently', { error: err instanceof Error ? err.message : String(err) });
    }
    await emitTaskEvent(taskId, terminalStatus === TaskStatus.FAILED ? 'task_failed' : 'task_timed_out', {
      reason: currentStatus === TaskStatus.AWAITING_APPROVAL
        ? 'approval_poll_timeout'
        : 'poll_timeout',
      poll_attempts: pollState.attempts,
    }, correlation);
    await decrementConcurrency(userId);
    return;
  }

  if (currentStatus === TaskStatus.HYDRATING) {
    try {
      await transitionTask(taskId, currentStatus, TaskStatus.FAILED, {
        completed_at: new Date().toISOString(),
        error_message: 'Session never started — poll timeout exceeded while still HYDRATING',
      });
    } catch (err) {
      log.warn('Finalization transition from HYDRATING failed, task may have transitioned concurrently', { error: err instanceof Error ? err.message : String(err) });
    }
    await emitTaskEvent(taskId, 'task_failed', {
      reason: 'session_never_started',
      poll_attempts: pollState.attempts,
    }, correlation);
    await decrementConcurrency(userId);
    return;
  }

  log.error('Unexpected task state during finalization', { status: currentStatus });
  await decrementConcurrency(userId);
}

/**
 * Queue a task that hit the per-user admission cap (#441). Transitions
 * SUBMITTED -> QUEUED and stamps queue bookkeeping; the admission-queue
 * pickup Lambda later re-attempts admission in FIFO order (by
 * ``created_at``) as slots free up.
 *
 * ``queued_at`` is written only on the FIRST queue entry — a re-queue
 * after a lost admission race preserves the original timestamp.
 * ``admission_attempts`` increments on every pass through admission so
 * repeatedly-losing tasks are visible to operators.
 *
 * No concurrency slot is held while QUEUED (admission explicitly did
 * not acquire one), so there is nothing to release here.
 *
 * @param task - the task record (status must be SUBMITTED).
 * @returns true if the task was queued; false if a concurrent
 *   transition (e.g. user cancel) won the conditional check.
 */
export async function queueTask(task: TaskRecord): Promise<boolean> {
  try {
    await transitionTask(task.task_id, TaskStatus.SUBMITTED, TaskStatus.QUEUED, {
      ...(task.queued_at === undefined && { queued_at: new Date().toISOString() }),
      admission_attempts: (typeof task.admission_attempts === 'number' ? task.admission_attempts : 0) + 1,
    });
  } catch (err) {
    if (err && typeof err === 'object' && 'name' in err && err.name === 'ConditionalCheckFailedException') {
      logger.info('Queue transition lost to a concurrent status change — skipping', { task_id: task.task_id });
      return false;
    }
    throw err;
  }
  await emitTaskEvent(task.task_id, 'admission_queued', {
    reason: 'concurrency_limit',
    admission_attempts: (typeof task.admission_attempts === 'number' ? task.admission_attempts : 0) + 1,
  });
  logger.info('Task queued on admission cap', {
    task_id: task.task_id,
    user_id: task.user_id,
    prior_attempts: task.admission_attempts ?? 0,
  });
  return true;
}

/**
 * Fail a task and release concurrency. Used when admission or hydration fails.
 * @param taskId - the task ID.
 * @param fromStatus - the current status.
 * @param errorMessage - the error reason.
 * @param userId - the user who owns the task.
 * @param releaseConcurrency - whether to decrement the concurrency counter.
 * @param repo - optional target repo (`owner/repo`) for the correlation
 *   envelope; omit for repo-less workflows.
 */
export async function failTask(
  taskId: string,
  fromStatus: TaskStatusType,
  errorMessage: string,
  userId: string,
  releaseConcurrency: boolean,
  repo?: string,
): Promise<void> {
  let transitioned = false;
  try {
    await transitionTask(taskId, fromStatus, TaskStatus.FAILED, {
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
    });
    transitioned = true;
  } catch (err) {
    const { log } = envelopeFor({ task_id: taskId, user_id: userId, repo });
    log.warn('Failed to transition task to FAILED', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Durable Execution retries a step that throws, and callers such as orchestrate-task rethrow after failTask.
  if (transitioned) {
    await emitTaskEvent(taskId, 'task_failed', { error_message: errorMessage }, { user_id: userId, repo });
    if (releaseConcurrency) {
      await decrementConcurrency(userId);
    }
  }
}

async function decrementConcurrency(userId: string): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: CONCURRENCY_TABLE_NAME,
      Key: { user_id: userId },
      UpdateExpression: 'SET active_count = active_count - :one, updated_at = :now',
      ConditionExpression: 'active_count > :zero',
      ExpressionAttributeValues: {
        ':one': 1,
        ':zero': 0,
        ':now': new Date().toISOString(),
      },
    }));
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'name' in err && err.name === 'ConditionalCheckFailedException') {
      logger.info('Concurrency counter already at zero, nothing to decrement', { user_id: userId });
    } else {
      logger.warn('Failed to decrement concurrency counter', { user_id: userId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function parseMergeBranches(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((b) => typeof b === 'string')) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  logger.warn('Ignoring malformed orchestration_merge_branches', { raw });
  return [];
}
