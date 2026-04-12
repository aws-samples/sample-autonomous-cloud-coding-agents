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

import { randomUUID } from 'crypto';
import { InvokeAgentRuntimeCommand, BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { hydrateContext } from './context-hydration';
import { logger } from './logger';
import { writeMinimalEpisode } from './memory';
import { computePromptVersion } from './prompt-version';
import { loadRepoConfig, type BlueprintConfig } from './repo-config';
import type { TaskRecord } from './types';
import { computeTtlEpoch, DEFAULT_MAX_TURNS } from './validation';
import { TaskStatus, TERMINAL_STATUSES, VALID_TRANSITIONS, type TaskStatusType } from '../../constructs/task-status';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const agentCoreClient = new BedrockAgentCoreClient({});

const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;
const CONCURRENCY_TABLE_NAME = process.env.USER_CONCURRENCY_TABLE_NAME!;
const RUNTIME_ARN = process.env.RUNTIME_ARN!;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '3');
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');
const MEMORY_ID = process.env.MEMORY_ID;

/**
 * State tracked across waitForCondition poll cycles.
 */
export interface PollState {
  readonly attempts: number;
  readonly lastStatus?: TaskStatusType;
  /** True when the agent stopped sending heartbeats while still RUNNING (likely crash/OOM). */
  readonly sessionUnhealthy?: boolean;
}

/** After RUNNING this long, we expect `agent_heartbeat_at` from the agent (if ever set). */
const AGENT_HEARTBEAT_GRACE_SEC = 120;
/** If `agent_heartbeat_at` exists and is older than this, the session is treated as lost. */
const AGENT_HEARTBEAT_STALE_SEC = 240;

/**
 * Load a task record from DynamoDB.
 * @param taskId - the task to load.
 * @returns the task record.
 * @throws Error if the task is not found.
 */
export async function loadTask(taskId: string): Promise<TaskRecord> {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { task_id: taskId },
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

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { task_id: taskId },
    UpdateExpression: updateExpression,
    ConditionExpression: '#status = :fromStatus',
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues,
  }));
}

/**
 * Emit a task event to the audit log.
 * @param taskId - the task ID.
 * @param eventType - the event type string.
 * @param metadata - optional event metadata.
 */
export async function emitTaskEvent(
  taskId: string,
  eventType: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: EVENTS_TABLE_NAME,
    Item: {
      task_id: taskId,
      event_id: ulid(),
      event_type: eventType,
      timestamp: new Date().toISOString(),
      ttl: computeTtlEpoch(TASK_RETENTION_DAYS),
      ...(metadata && { metadata }),
    },
  }));
}

/** Minimum allowed poll interval (5 seconds). */
const MIN_POLL_INTERVAL_MS = 5_000;
/** Maximum allowed poll interval (5 minutes). */
const MAX_POLL_INTERVAL_MS = 300_000;

/**
 * Load blueprint configuration for a task's repository and merge with platform defaults.
 * @param task - the task record (needs task.repo).
 * @returns the merged blueprint config.
 */
export async function loadBlueprintConfig(task: TaskRecord): Promise<BlueprintConfig> {
  const repoConfig = await loadRepoConfig(task.repo);

  if (repoConfig) {
    logger.info('Loaded per-repo blueprint config', {
      task_id: task.task_id,
      repo: task.repo,
      has_runtime_override: !!repoConfig.runtime_arn,
      has_model_override: !!repoConfig.model_id,
      has_prompt_override: !!repoConfig.system_prompt_overrides,
      has_token_override: !!repoConfig.github_token_secret_arn,
    });
  } else {
    logger.info('No per-repo config found, using platform defaults', {
      task_id: task.task_id,
      repo: task.repo,
    });
  }

  // Clamp poll_interval_ms to safe range
  let pollIntervalMs = repoConfig?.poll_interval_ms;
  if (pollIntervalMs !== undefined) {
    const clamped = Math.min(Math.max(pollIntervalMs, MIN_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS);
    if (clamped !== pollIntervalMs) {
      logger.warn('poll_interval_ms clamped to safe range', {
        repo: task.repo,
        original: pollIntervalMs,
        clamped,
        min: MIN_POLL_INTERVAL_MS,
        max: MAX_POLL_INTERVAL_MS,
      });
      pollIntervalMs = clamped;
    }
  }

  return {
    compute_type: repoConfig?.compute_type ?? 'agentcore',
    runtime_arn: repoConfig?.runtime_arn ?? RUNTIME_ARN,
    model_id: repoConfig?.model_id,
    max_turns: repoConfig?.max_turns,
    max_budget_usd: repoConfig?.max_budget_usd,
    system_prompt_overrides: repoConfig?.system_prompt_overrides,
    github_token_secret_arn: repoConfig?.github_token_secret_arn ?? process.env.GITHUB_TOKEN_SECRET_ARN,
    poll_interval_ms: pollIntervalMs,
    cedar_policies: repoConfig?.cedar_policies,
  };
}

/**
 * Transition task to HYDRATING and assemble the invocation payload.
 * @param task - the task record.
 * @param blueprintConfig - optional per-repo blueprint config.
 * @returns the assembled payload for the agent runtime.
 */
export async function hydrateAndTransition(task: TaskRecord, blueprintConfig?: BlueprintConfig): Promise<Record<string, unknown>> {
  await transitionTask(task.task_id, TaskStatus.SUBMITTED, TaskStatus.HYDRATING);
  await emitTaskEvent(task.task_id, 'hydration_started');

  const hydratedContext = await hydrateContext(task, {
    githubTokenSecretArn: blueprintConfig?.github_token_secret_arn,
    memoryId: MEMORY_ID,
  });

  // If guardrail screening blocked the hydrated context, emit audit event and throw
  // to trigger task failure (the caller in orchestrate-task.ts catches and transitions to FAILED)
  if (hydratedContext.guardrail_blocked) {
    try {
      await emitTaskEvent(task.task_id, 'guardrail_blocked', {
        reason: hydratedContext.guardrail_blocked,
        task_type: task.task_type,
        pr_number: task.pr_number,
        sources: hydratedContext.sources,
        token_estimate: hydratedContext.token_estimate,
      });
    } catch (eventErr) {
      logger.error('Failed to emit guardrail_blocked event', {
        task_id: task.task_id,
        error: eventErr instanceof Error ? eventErr.message : String(eventErr),
      });
    }
    throw new Error(`Guardrail blocked: ${hydratedContext.guardrail_blocked}`);
  }

  // For PR iteration: resolve actual branch name from PR head_ref
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
      logger.error('Failed to update branch_name from PR head_ref — task record will show stale placeholder', {
        task_id: task.task_id,
        resolved_branch: hydratedContext.resolved_branch_name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Compute prompt version from the system prompt template + overrides
  // (deterministic parts only — excludes memory context which varies per invocation)
  const promptVersionInput = blueprintConfig?.system_prompt_overrides ?? '';
  const promptVersion = computePromptVersion('system_prompt_v1', promptVersionInput ? { overrides: promptVersionInput } : undefined);

  // Store prompt version on the task record
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { task_id: task.task_id },
      UpdateExpression: 'SET #pv = :pv, #ua = :now',
      ExpressionAttributeNames: { '#pv': 'prompt_version', '#ua': 'updated_at' },
      ExpressionAttributeValues: { ':pv': promptVersion, ':now': new Date().toISOString() },
    }));
  } catch (err) {
    logger.warn('Failed to store prompt_version on task record', {
      task_id: task.task_id, error: err instanceof Error ? err.message : String(err),
    });
  }

  // max_budget_usd uses 2-tier override (no platform default — absent means unlimited).
  const effectiveBudget = task.max_budget_usd ?? blueprintConfig?.max_budget_usd;

  const payload: Record<string, unknown> = {
    repo_url: task.repo,
    task_id: task.task_id,
    branch_name: hydratedContext.resolved_branch_name ?? task.branch_name,
    ...(task.issue_number !== undefined && { issue_number: String(task.issue_number) }),
    task_type: task.task_type ?? 'new_task',
    ...(task.pr_number !== undefined && { pr_number: task.pr_number }),
    ...(hydratedContext.resolved_base_branch && { base_branch: hydratedContext.resolved_base_branch }),
    ...(task.task_description && { prompt: task.task_description }),
    max_turns: task.max_turns ?? blueprintConfig?.max_turns ?? DEFAULT_MAX_TURNS,
    ...(effectiveBudget !== undefined && { max_budget_usd: effectiveBudget }),
    ...(blueprintConfig?.model_id && { model_id: blueprintConfig.model_id }),
    ...(blueprintConfig?.system_prompt_overrides && { system_prompt_overrides: blueprintConfig.system_prompt_overrides }),
    ...(blueprintConfig?.cedar_policies && blueprintConfig.cedar_policies.length > 0 && { cedar_policies: blueprintConfig.cedar_policies }),
    prompt_version: promptVersion,
    ...(MEMORY_ID && { memory_id: MEMORY_ID }),
    hydrated_context: hydratedContext,
  };

  if (hydratedContext.fallback_error) {
    logger.warn('Context hydration fell back to minimal payload', {
      task_id: task.task_id,
      fallback_error: hydratedContext.fallback_error,
    });
  }

  await emitTaskEvent(task.task_id, 'hydration_complete', {
    sources: hydratedContext.sources,
    token_estimate: hydratedContext.token_estimate,
    truncated: hydratedContext.truncated,
    prompt_version: promptVersion,
    has_memory_context: !!hydratedContext.memory_context,
    ...(hydratedContext.fallback_error && { fallback_error: hydratedContext.fallback_error }),
  });
  return payload;
}

/**
 * Start an AgentCore runtime session and transition task to RUNNING.
 * @param task - the task record.
 * @param payload - the hydrated invocation payload.
 * @param blueprintConfig - optional per-repo blueprint config for runtime ARN override.
 * @returns the session ID.
 */
export async function startSession(
  task: TaskRecord,
  payload: Record<string, unknown>,
  blueprintConfig?: BlueprintConfig,
): Promise<string> {
  // AgentCore requires runtimeSessionId >= 33 chars; UUID v4 is 36 chars.
  const sessionId = randomUUID();
  const runtimeArn = blueprintConfig?.runtime_arn ?? RUNTIME_ARN;

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtimeArn,
    runtimeSessionId: sessionId,
    contentType: 'application/json',
    accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify({ input: payload })),
  });

  await agentCoreClient.send(command);

  await transitionTask(task.task_id, TaskStatus.HYDRATING, TaskStatus.RUNNING, {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    agent_runtime_arn: runtimeArn,
  });
  await emitTaskEvent(task.task_id, 'session_started', { session_id: sessionId });

  logger.info('Session started', { task_id: task.task_id, session_id: sessionId });

  return sessionId;
}

/**
 * Poll the task record in DynamoDB to check if the agent wrote a terminal status.
 * Returns the updated PollState; the waitStrategy decides whether to continue.
 * @param taskId - the task to poll.
 * @param state - current poll state.
 * @returns updated poll state with the latest task status.
 */
export async function pollTaskStatus(taskId: string, state: PollState): Promise<PollState> {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { task_id: taskId },
    ProjectionExpression: '#st, session_id, started_at, agent_heartbeat_at',
    ExpressionAttributeNames: { '#st': 'status' },
  }));

  const currentStatus = result.Item?.status as TaskStatusType | undefined;
  const item = result.Item as Record<string, unknown> | undefined;

  let sessionUnhealthy = false;
  if (
    currentStatus === TaskStatus.RUNNING
    && item?.session_id
    && typeof item.started_at === 'string'
  ) {
    const startedMs = Date.parse(item.started_at);
    const now = Date.now();
    if (!Number.isNaN(startedMs)) {
      const runningAgeSec = (now - startedMs) / 1000;

      if (typeof item.agent_heartbeat_at === 'string') {
        // Agent has sent at least one heartbeat — check staleness
        const hbMs = Date.parse(item.agent_heartbeat_at);
        if (!Number.isNaN(hbMs)) {
          const hbAgeSec = (now - hbMs) / 1000;
          if (runningAgeSec > AGENT_HEARTBEAT_GRACE_SEC && hbAgeSec > AGENT_HEARTBEAT_STALE_SEC) {
            sessionUnhealthy = true;
            logger.warn('Agent heartbeat stale while task RUNNING', {
              task_id: taskId,
              agent_heartbeat_at: item.agent_heartbeat_at,
              heartbeat_age_sec: Math.round(hbAgeSec),
            });
          }
        }
      } else if (runningAgeSec > AGENT_HEARTBEAT_GRACE_SEC + AGENT_HEARTBEAT_STALE_SEC) {
        // Agent never sent a heartbeat and task has been RUNNING well past
        // the grace period — likely early crash before pipeline started.
        sessionUnhealthy = true;
        logger.warn('Agent never sent heartbeat while task RUNNING past grace period', {
          task_id: taskId,
          running_age_sec: Math.round(runningAgeSec),
        });
      }
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
): Promise<void> {
  const task = await loadTask(taskId);
  const currentStatus = task.status;

  // Lost session: RUNNING but agent heartbeats stopped (crash/OOM) — fail fast
  if (
    pollState.sessionUnhealthy
    && (currentStatus === TaskStatus.RUNNING || currentStatus === TaskStatus.FINALIZING)
  ) {
    let transitioned = false;
    try {
      await transitionTask(taskId, currentStatus, TaskStatus.FAILED, {
        completed_at: new Date().toISOString(),
        error_message:
          'Agent session lost: no recent heartbeat from the runtime (container may have crashed, been OOM-killed, or stopped)',
      });
      transitioned = true;
    } catch (err) {
      // Task may have transitioned concurrently (e.g. agent wrote terminal status).
      // Re-read to avoid double-decrement or contradictory events.
      logger.warn('Finalization transition to FAILED (heartbeat) failed, task may have transitioned concurrently', {
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (transitioned) {
      await emitTaskEvent(taskId, 'task_failed', {
        reason: 'agent_heartbeat_stale',
        poll_attempts: pollState.attempts,
      });
      await decrementConcurrency(userId);
    } else {
      // Transition failed — re-read task to determine actual state.
      // If already terminal the block below will handle TTL + concurrency.
      const reread = await loadTask(taskId);
      if (TERMINAL_STATUSES.includes(reread.status)) {
        logger.info('Heartbeat path: task already terminal after failed transition', { task_id: taskId, status: reread.status });
        await emitTaskEvent(taskId, `task_${reread.status.toLowerCase()}`, {
          final_status: reread.status,
          poll_attempts: pollState.attempts,
        });
        await decrementConcurrency(userId);
      } else {
        logger.warn('Heartbeat path: task in unexpected state after failed transition, releasing concurrency', { task_id: taskId, status: reread.status });
        await decrementConcurrency(userId);
      }
    }
    return;
  }

  // If the agent already wrote a terminal status, just finalize
  if (TERMINAL_STATUSES.includes(currentStatus)) {
    logger.info('Task already in terminal state', { task_id: taskId, status: currentStatus });

    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { task_id: taskId },
        UpdateExpression: 'SET #ttl = :ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':ttl': computeTtlEpoch(TASK_RETENTION_DAYS) },
      }));
    } catch (err) {
      logger.warn('Failed to stamp TTL on terminal task', { task_id: taskId, error: err instanceof Error ? err.message : String(err) });
    }

    // Memory fallback: if the agent did not write memory, write a minimal episode
    if (MEMORY_ID && !task.memory_written) {
      logger.info('Agent did not write memory — writing fallback episode', { task_id: taskId });
      try {
        const written = await writeMinimalEpisode(
          MEMORY_ID,
          task.repo,
          taskId,
          currentStatus,
          task.duration_s !== undefined ? Number(task.duration_s) : undefined,
          task.cost_usd !== undefined ? Number(task.cost_usd) : undefined,
        );
        if (!written) {
          logger.warn('Fallback episode write returned false', { task_id: taskId });
        }
      } catch (err) {
        logger.warn('Fallback episode write threw unexpectedly (fail-open)', {
          task_id: taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await emitTaskEvent(taskId, `task_${currentStatus.toLowerCase()}`, {
      final_status: currentStatus,
      poll_attempts: pollState.attempts,
    });
    await decrementConcurrency(userId);
    return;
  }

  // If still RUNNING after timeout, transition to TIMED_OUT
  if (currentStatus === TaskStatus.RUNNING || currentStatus === TaskStatus.FINALIZING) {
    const terminalStatus = TaskStatus.TIMED_OUT;
    try {
      await transitionTask(taskId, currentStatus, terminalStatus, {
        completed_at: new Date().toISOString(),
        error_message: 'Orchestrator poll timeout exceeded',
      });
    } catch (err) {
      // Task may have transitioned concurrently — re-read and accept
      logger.warn('Finalization transition failed, task may have transitioned concurrently', { task_id: taskId, error: err instanceof Error ? err.message : String(err) });
    }
    await emitTaskEvent(taskId, 'task_timed_out', {
      reason: 'poll_timeout',
      poll_attempts: pollState.attempts,
    });
    await decrementConcurrency(userId);
    return;
  }

  // If still HYDRATING after poll timeout, the session never started (e.g. container crash).
  // Transition to FAILED so the task doesn't stay stuck forever.
  if (currentStatus === TaskStatus.HYDRATING) {
    try {
      await transitionTask(taskId, currentStatus, TaskStatus.FAILED, {
        completed_at: new Date().toISOString(),
        error_message: 'Session never started — poll timeout exceeded while still HYDRATING',
      });
    } catch (err) {
      logger.warn('Finalization transition from HYDRATING failed, task may have transitioned concurrently', { task_id: taskId, error: err instanceof Error ? err.message : String(err) });
    }
    await emitTaskEvent(taskId, 'task_failed', {
      reason: 'session_never_started',
      poll_attempts: pollState.attempts,
    });
    await decrementConcurrency(userId);
    return;
  }

  // Unexpected state — log and release concurrency
  logger.error('Unexpected task state during finalization', { task_id: taskId, status: currentStatus });
  await decrementConcurrency(userId);
}

/**
 * Fail a task and release concurrency. Used when admission or hydration fails.
 * @param taskId - the task ID.
 * @param fromStatus - the current status.
 * @param errorMessage - the error reason.
 * @param userId - the user who owns the task.
 * @param releaseConcurrency - whether to decrement the concurrency counter.
 */
export async function failTask(
  taskId: string,
  fromStatus: TaskStatusType,
  errorMessage: string,
  userId: string,
  releaseConcurrency: boolean,
): Promise<void> {
  try {
    await transitionTask(taskId, fromStatus, TaskStatus.FAILED, {
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
    });
  } catch (err) {
    logger.warn('Failed to transition task to FAILED', { task_id: taskId, error: err instanceof Error ? err.message : String(err) });
  }
  await emitTaskEvent(taskId, 'task_failed', { error_message: errorMessage });
  if (releaseConcurrency) {
    await decrementConcurrency(userId);
  }
}

/**
 * Decrement the user's concurrency counter (best-effort).
 * @param userId - the user ID.
 */
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
