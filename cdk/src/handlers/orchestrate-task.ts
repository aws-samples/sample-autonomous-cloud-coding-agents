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

import { withDurableExecution, type DurableExecutionHandler } from '@aws/durable-execution-sdk-js';
import { TaskStatus, TERMINAL_STATUSES } from '../constructs/task-status';
import { resolveComputeStrategy, type SessionHandle } from './shared/compute-strategy';
import { MicrovmStartUncertainError } from './shared/error-classifier';
import { reportIssueFailure as reportJiraIssueFailure } from './shared/jira-feedback';
import { emitAgentActivity } from './shared/linear-agent-session';
import { postIssueComment, resolveToken } from './shared/linear-feedback';
import { logger } from './shared/logger';
import { stopMicrovmWithDiagnostics } from './shared/microvm/supervisor';
import { pollMicrovmTask } from './shared/microvm/task-poll';
import {
  admissionControl,
  buildComputeMetadata,
  emitTaskEvent,
  envelopeFor,
  failTask,
  finalizeTask,
  hydrateAndTransition,
  loadBlueprintConfig,
  loadTask,
  pollTaskStatus,
  queueTask,
  transitionTask,
  type PollState,
} from './shared/orchestrator';
import { runPreflightChecks } from './shared/preflight';
import { isAutoRetried, startSessionWithRetry } from './shared/session-start-retry';
import { deleteEcsPayload } from './shared/strategies/ecs-strategy';
import { deleteMicrovmPayload } from './shared/strategies/lambda-microvm-strategy';
import type { TaskRecord } from './shared/types';
import { workflowIsReadOnly, workflowRequiresRepo } from './shared/workflows';

interface OrchestrateTaskEvent {
  readonly task_id: string;
  readonly queue_pickup_id?: string;
}

interface MicrovmStartFailure {
  readonly microvmStartFailure: { readonly fromStatus: TaskRecord['status']; readonly errorMessage: string };
}
type StartSessionResult = SessionHandle | MicrovmStartFailure | null;

function isMicrovmStartFailure(result: StartSessionResult): result is MicrovmStartFailure {
  return result !== null && 'microvmStartFailure' in result;
}

const MAX_POLL_ATTEMPTS = 1020;
const MAX_CONSECUTIVE_ECS_POLL_FAILURES = 3;
const MAX_CONSECUTIVE_ECS_COMPLETED_POLLS = 5;
const DEFAULT_POLL_INTERVAL_SECONDS = 30;

const durableHandler: DurableExecutionHandler<OrchestrateTaskEvent, void> = async (event, context) => {
  const { task_id: taskId } = event;

  const task = await context.step('load-task', async () => {
    return loadTask(taskId);
  });

  const { log, correlation } = envelopeFor(task);

  const blueprintConfig = await context.step('load-blueprint', async () => {
    try {
      return await loadBlueprintConfig(task);
    } catch (err) {
      await failTask(taskId, task.status, `Blueprint config load failed: ${String(err)}`, task.user_id, false, task.repo);
      throw err;
    }
  });

  const admitted = await context.step('admission-control', async () => {
    const current = await loadTask(taskId, true);
    if (TERMINAL_STATUSES.includes(current.status)) {
      return false;
    }
    const result = await admissionControl(task);
    if (!result) {
      const queued = await queueTask(current);
      if (queued && current.queued_at === undefined) {
        try {
          await notifyLinearOnConcurrencyCap(task);
        } catch (err) {
          log.warn('Linear concurrency-cap feedback failed (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        try {
          await notifyJiraOnConcurrencyCap(task);
        } catch (err) {
          log.warn('Jira concurrency-cap feedback failed (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return result;
  });

  if (!admitted) {
    return;
  }

  const preflightPassed = await context.step('pre-flight', async () => {
    try {
      const current = await loadTask(taskId, true);
      if (TERMINAL_STATUSES.includes(current.status)) {
        return false;
      }
      const workflowId = task.resolved_workflow?.id ?? 'coding/new-task-v1';
      const result = await runPreflightChecks(
        task.repo,
        blueprintConfig,
        task.pr_number,
        workflowIsReadOnly(workflowId),
        workflowRequiresRepo(workflowId),
      );
      if (!result.passed) {
        const errorMessage = `Pre-flight check failed: ${result.failureReason}${result.failureDetail ? ' — ' + result.failureDetail : ''}`;
        await failTask(taskId, current.status, errorMessage, task.user_id, true, task.repo);
        await emitTaskEvent(taskId, 'preflight_failed', {
          reason: result.failureReason,
          detail: result.failureDetail,
          checks: result.checks,
        }, correlation);
      }
      return result.passed;
    } catch (err) {
      await failTask(taskId, task.status, `Pre-flight failed: ${String(err)}`, task.user_id, true, task.repo);
      throw err;
    }
  });

  if (!preflightPassed) {
    return;
  }

  const payload = await context.step('hydrate-context', async () => {
    try {
      return await hydrateAndTransition(task, blueprintConfig);
    } catch (err) {
      await failTask(taskId, TaskStatus.HYDRATING, `Hydration failed: ${String(err)}`, task.user_id, true, task.repo);
      throw err;
    }
  });

  const startResult: StartSessionResult = await context.step('start-session', async (): Promise<StartSessionResult> => {
    let autoRetried = false;
    let failureStatus: TaskRecord['status'] = TaskStatus.HYDRATING;
    let strategy: ReturnType<typeof resolveComputeStrategy> | undefined;
    let startedHandle: Awaited<ReturnType<typeof startSessionWithRetry>>['handle'] | undefined;
    try {
      if (blueprintConfig.compute_type !== 'lambda-microvm') {
        const beforeStart = await loadTask(taskId, true);
        if (TERMINAL_STATUSES.includes(beforeStart.status)) {
          throw new Error(`Task is ${beforeStart.status}, no session started`);
        }
      }
      strategy = resolveComputeStrategy(blueprintConfig);
      const startInput = {
        taskId,
        userId: task.user_id,
        payload,
        blueprintConfig,
        readOnly: workflowIsReadOnly(task.resolved_workflow?.id ?? 'coding/new-task-v1'),
      };
      const { handle, autoRetried: retried } = await startSessionWithRetry(
        strategy,
        startInput,
        {
          emitRetryEvent: (reason) =>
            emitTaskEvent(taskId, 'session_start_retry', { reason }, correlation),
          logger,
          taskId,
        },
      );
      autoRetried = retried;
      startedHandle = handle;

      const computeMetadata = buildComputeMetadata(handle);

      const current = handle.strategyType === 'lambda-microvm' ? await loadTask(taskId, true) : undefined;
      if (current && TERMINAL_STATUSES.includes(current.status)) {
        await strategy.stopSession(handle);
        return null;
      }
      const alreadyRegistered = current?.session_id === handle.sessionId
        && (current.status === TaskStatus.RUNNING || current.status === TaskStatus.AWAITING_APPROVAL);
      if (alreadyRegistered) return handle;

      await transitionTask(taskId, TaskStatus.HYDRATING, TaskStatus.RUNNING, {
        session_id: handle.sessionId,
        started_at: new Date().toISOString(),
        compute_type: handle.strategyType,
        compute_metadata: computeMetadata,
        ...(handle.strategyType === 'agentcore' && { agent_runtime_arn: handle.runtimeArn }),
      });
      if (handle.strategyType !== 'lambda-microvm') {
        try {
          await emitTaskEvent(taskId, 'session_started', {
            session_id: handle.sessionId,
            strategy_type: handle.strategyType,
          }, correlation);
        } catch (emitErr) {
          log.warn('session_started event failed after the session was registered', {
            session_id: handle.sessionId, error: String(emitErr),
          });
        }
      }

      log.info('Session started', {
        session_id: handle.sessionId,
        strategy_type: handle.strategyType,
      });

      return handle;
    } catch (err) {
      if (blueprintConfig.compute_type === 'lambda-microvm') {
        try {
          const current = await loadTask(taskId, true);
          // A lost DynamoDB update response does not undo its committed result.
          if (startedHandle && current.session_id === startedHandle.sessionId
            && (current.status === TaskStatus.RUNNING || current.status === TaskStatus.AWAITING_APPROVAL)) {
            return startedHandle;
          }
          if (TERMINAL_STATUSES.includes(current.status)) {
            if (startedHandle && strategy) await strategy.stopSession(startedHandle);
            if (!startedHandle && err instanceof MicrovmStartUncertainError) {
              log.error('Task became terminal while its MicroVM start outcome is unknown', {
                task_id: taskId, client_token: taskId, task_status: current.status,
              });
              try {
                await emitTaskEvent(taskId, 'microvm_start_outcome_unknown', {
                  client_token: taskId, task_status: current.status,
                }, correlation);
              } catch (eventErr) {
                log.warn('Could not record the unknown MicroVM start event', { error: String(eventErr) });
              }
            }
            return null;
          }
          failureStatus = current.status;
        } catch (readErr) {
          log.warn('Could not reconcile MicroVM registration after start failure', { error: String(readErr) });
        }
      }
      if (startedHandle?.strategyType === 'lambda-microvm' && strategy) {
        try {
          log.warn('Session start failed after the MicroVM was created — terminating the orphan', {
            microvm_id: startedHandle.microvmId,
            original_error: err instanceof Error ? err.message : String(err),
          });
          await strategy.stopSession(startedHandle);
        } catch (reapErr) {
          log.error('Failed to terminate the orphaned MicroVM — it may bill until its 8h cap', {
            microvm_id: startedHandle.microvmId,
            error: reapErr instanceof Error ? reapErr.message : String(reapErr),
          });
        }
      }

      const retriedNote = (autoRetried || isAutoRetried(err)) ? ' [auto-retried]' : '';
      const detail = err instanceof MicrovmStartUncertainError
        ? `MICROVM_START_OUTCOME_UNKNOWN: ${String(err)}`
        : String(err);
      const errorMessage = `Session start failed: ${detail}${retriedNote}`;
      if (blueprintConfig.compute_type === 'lambda-microvm') {
        try {
          await transitionTask(taskId, failureStatus, TaskStatus.FAILED, {
            completed_at: new Date().toISOString(), error_message: errorMessage,
          });
        } catch (transitionErr) {
          log.warn('Could not record the MicroVM start failure yet; a retried step records it', {
            error: String(transitionErr),
          });
        }
        return { microvmStartFailure: { fromStatus: failureStatus, errorMessage } };
      }
      await failTask(taskId, failureStatus, errorMessage, task.user_id, true, task.repo);
      throw err;
    }
  }, blueprintConfig.compute_type === 'lambda-microvm'
    ? { retryStrategy: () => ({ shouldRetry: false }) }
    : undefined);

  if (isMicrovmStartFailure(startResult)) {
    const { fromStatus, errorMessage } = startResult.microvmStartFailure;
    await context.step('record-start-failure', async () => {
      try {
        await transitionTask(taskId, fromStatus, TaskStatus.FAILED, {
          completed_at: new Date().toISOString(), error_message: errorMessage,
        });
      } catch (transitionErr) {
        const current = await loadTask(taskId, true);
        if (!TERMINAL_STATUSES.includes(current.status)) throw transitionErr;
      }
    });
  }
  const sessionHandle = isMicrovmStartFailure(startResult) ? null : startResult;

  if (sessionHandle?.strategyType === 'lambda-microvm') {
    await context.step('session-started-event', async () => {
      try {
        await emitTaskEvent(taskId, 'session_started', {
          session_id: sessionHandle.sessionId,
          strategy_type: sessionHandle.strategyType,
        }, correlation);
      } catch (emitErr) {
        log.warn('session_started event failed after the MicroVM was registered', {
          session_id: sessionHandle.sessionId, error: String(emitErr),
        });
      }
    });
  }

  if (!sessionHandle) {
    await context.step('finalize-before-session', async () => {
      await finalizeTask(taskId, { attempts: 0 }, task.user_id);
      await deleteMicrovmPayload(taskId);
    });
    return;
  }

  const computeStrategy = blueprintConfig.compute_type === 'ecs'
    ? resolveComputeStrategy(blueprintConfig)
    : undefined;

  const microvmStrategy = blueprintConfig.compute_type === 'lambda-microvm'
    ? resolveComputeStrategy(blueprintConfig)
    : undefined;

  const pollSeconds = blueprintConfig.poll_interval_ms
    ? Math.ceil(blueprintConfig.poll_interval_ms / 1000)
    : DEFAULT_POLL_INTERVAL_SECONDS;
  const maxPollAttempts = Math.ceil(MAX_POLL_ATTEMPTS * DEFAULT_POLL_INTERVAL_SECONDS / pollSeconds);

  const finalPollState = await context.waitForCondition<PollState>(
    'await-agent-completion',
    async (state) => {
      if (microvmStrategy && sessionHandle.strategyType === 'lambda-microvm') {
        return pollMicrovmTask({
          taskId,
          userId: task.user_id,
          handle: sessionHandle,
          strategy: microvmStrategy,
          pollIntervalMs: blueprintConfig.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_SECONDS * 1000,
          suspendEnabled: process.env.MICROVM_APPROVAL_SUSPEND_ENABLED === 'true',
          emitEvent: (type, metadata, options) => emitTaskEvent(taskId, type, metadata, correlation, options),
        }, state);
      }
      const ddbState = await pollTaskStatus(taskId, state, blueprintConfig.compute_type);
      let consecutiveEcsPollFailures = 0;
      let consecutiveEcsCompletedPolls = 0;
      if (
        ddbState.lastStatus &&
        !TERMINAL_STATUSES.includes(ddbState.lastStatus) &&
        computeStrategy
      ) {
        try {
          const ecsStatus = await computeStrategy.pollSession(sessionHandle);
          if (ecsStatus.status === 'failed') {
            const errorMsg = 'error' in ecsStatus ? ecsStatus.error : 'ECS task failed';
            log.warn('ECS task failed before DDB terminal write', {
              error: errorMsg,
            });
            await failTask(taskId, ddbState.lastStatus, `ECS container failed: ${errorMsg}`, task.user_id, false, task.repo);
            return { attempts: ddbState.attempts, lastStatus: TaskStatus.FAILED };
          }
          if (ecsStatus.status === 'completed') {
            consecutiveEcsCompletedPolls = (state.consecutiveEcsCompletedPolls ?? 0) + 1;
            if (consecutiveEcsCompletedPolls >= MAX_CONSECUTIVE_ECS_COMPLETED_POLLS) {
              log.error('ECS task completed but DDB never caught up — failing task', {
                consecutive_completed_polls: consecutiveEcsCompletedPolls,
              });
              await failTask(taskId, ddbState.lastStatus, `ECS task exited successfully but agent never wrote terminal status after ${consecutiveEcsCompletedPolls} polls`, task.user_id, false, task.repo);
              return { attempts: ddbState.attempts, lastStatus: TaskStatus.FAILED };
            }
            log.warn('ECS task completed but DDB not terminal — waiting for DDB catchup', {
              consecutive_completed_polls: consecutiveEcsCompletedPolls,
            });
          }
        } catch (err) {
          consecutiveEcsPollFailures = (state.consecutiveEcsPollFailures ?? 0) + 1;
          if (consecutiveEcsPollFailures >= MAX_CONSECUTIVE_ECS_POLL_FAILURES) {
            log.error('ECS pollSession failed repeatedly — failing task', {
              consecutive_failures: consecutiveEcsPollFailures,
              error: err instanceof Error ? err.message : String(err),
            });
            await failTask(taskId, ddbState.lastStatus, `ECS poll failed ${consecutiveEcsPollFailures} consecutive times: ${err instanceof Error ? err.message : String(err)}`, task.user_id, false, task.repo);
            return { attempts: ddbState.attempts, lastStatus: TaskStatus.FAILED };
          }
          log.warn('ECS pollSession check failed (non-fatal)', {
            consecutive_failures: consecutiveEcsPollFailures,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { ...ddbState, consecutiveEcsPollFailures, consecutiveEcsCompletedPolls };
    },
    {
      initialState: { attempts: 0 },
      waitStrategy: (state: PollState) => {
        if (state.microvmOwnershipLost) return { shouldContinue: false };
        if (state.lastStatus && TERMINAL_STATUSES.includes(state.lastStatus)) {
          return { shouldContinue: false };
        }
        if (state.sessionUnhealthy) {
          return { shouldContinue: false };
        }
        if (state.microvmSupervisor) {
          if (state.microvmFailureReason || state.microvmOwnershipLost) return { shouldContinue: false };
          return {
            shouldContinue: true,
            delay: { seconds: Math.max(1, Math.ceil(state.microvmSupervisor.nextPollInMs / 1000)) },
          };
        }
        if (state.attempts >= maxPollAttempts) {
          return { shouldContinue: false };
        }
        return { shouldContinue: true, delay: { seconds: pollSeconds } };
      },
    },
  );

  await context.step('finalize', async () => {
    let finalized = false;
    try {
      if (!finalPollState.microvmOwnershipLost) {
        finalized = (await finalizeTask(taskId, finalPollState, task.user_id)) !== false;
      }
    } finally {
      if (microvmStrategy && sessionHandle.strategyType === 'lambda-microvm') {
        await stopMicrovmWithDiagnostics({
          taskId,
          handle: sessionHandle,
          strategy: microvmStrategy,
          emitEvent: (type, metadata, options) => emitTaskEvent(taskId, type, metadata, correlation, options),
        });
      }
    }
    if (!finalized) return;
    if (blueprintConfig.compute_type === 'ecs') {
      await deleteEcsPayload(taskId);
    } else if (blueprintConfig.compute_type === 'lambda-microvm') {
      await deleteMicrovmPayload(taskId);
    }
  });
};

export const handler = withDurableExecution(durableHandler);

/**
 * Post a Linear comment when admission control queues a task on the user
 * concurrency cap (#441). Linear-only; silently no-ops for other channels.
 */
export async function notifyLinearOnConcurrencyCap(task: TaskRecord): Promise<void> {
  if (task.channel_source !== 'linear') return;
  const issueId = task.channel_metadata?.linear_issue_id;
  const linearWorkspaceId = task.channel_metadata?.linear_workspace_id;
  if (!issueId || !linearWorkspaceId) return;
  const registryTableName = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
  if (!registryTableName) {
    logger.warn('Skipping Linear concurrency-cap feedback: LINEAR_WORKSPACE_REGISTRY_TABLE_NAME not set', {
      task_id: task.task_id,
    });
    return;
  }
  try {
    const agentSessionId = task.channel_metadata?.linear_agent_session_id;
    if (agentSessionId) {
      const token = await resolveToken({ linearWorkspaceId, registryTableName });
      if (!token) return;
      const result = await emitAgentActivity(token, agentSessionId, {
        type: 'thought',
        body: 'Queued: you are at your concurrency limit. This task starts automatically when a slot frees up — no action needed.',
      });
      if (!result.ok) {
        logger.warn('Linear concurrency-cap session activity failed (non-fatal)', {
          task_id: task.task_id, linear_agent_session_id: agentSessionId, retryable: result.retryable,
        });
      }
      return;
    }
    await postIssueComment(
      { linearWorkspaceId, registryTableName },
      issueId,
      '⏸️ ABCA hit your concurrency limit — this task has been queued and will start automatically when a slot frees up. No action needed.',
    );
  } catch (err) {
    logger.warn('Linear concurrency-cap feedback failed (non-fatal)', {
      task_id: task.task_id,
      linear_workspace_id: linearWorkspaceId,
      issue_id: issueId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Post a Jira issue comment when admission control queues a task on the
 * user concurrency cap (#441). Jira-only; silently no-ops for other channels.
 */
export async function notifyJiraOnConcurrencyCap(task: TaskRecord): Promise<void> {
  if (task.channel_source !== 'jira') return;
  const cloudId = task.channel_metadata?.jira_cloud_id;
  const issueKey = task.channel_metadata?.jira_issue_key;
  if (!cloudId || !issueKey) return;
  const registryTableName = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
  if (!registryTableName) {
    logger.warn('Skipping Jira concurrency-cap feedback: JIRA_WORKSPACE_REGISTRY_TABLE_NAME not set', {
      task_id: task.task_id,
    });
    return;
  }
  try {
    await reportJiraIssueFailure(
      { cloudId, registryTableName },
      issueKey,
      '⏸️ ABCA hit your concurrency limit — this task has been queued and will start automatically when a slot frees up. No action needed.',
    );
  } catch (err) {
    logger.warn('Jira concurrency-cap feedback failed (non-fatal)', {
      task_id: task.task_id,
      jira_cloud_id: cloudId,
      issue_key: issueKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
