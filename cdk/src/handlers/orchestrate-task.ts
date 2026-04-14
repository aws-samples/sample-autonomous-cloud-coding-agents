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
import { resolveComputeStrategy } from './shared/compute-strategy';
import { logger } from './shared/logger';
import {
  admissionControl,
  emitTaskEvent,
  failTask,
  finalizeTask,
  hydrateAndTransition,
  loadBlueprintConfig,
  loadTask,
  pollTaskStatus,
  transitionTask,
  type PollState,
} from './shared/orchestrator';
import { runPreflightChecks } from './shared/preflight';

interface OrchestrateTaskEvent {
  readonly task_id: string;
}

const MAX_POLL_ATTEMPTS = 1020; // ~8.5h at 30s intervals
const MAX_NON_RUNNING_POLLS = 10; // ~5min grace period for session to start
const MAX_CONSECUTIVE_COMPUTE_POLL_FAILURES = 3;
const MAX_CONSECUTIVE_COMPUTE_COMPLETED_POLLS = 5;

const durableHandler: DurableExecutionHandler<OrchestrateTaskEvent, void> = async (event, context) => {
  const { task_id: taskId } = event;

  // Step 1: Load task record
  const task = await context.step('load-task', async () => {
    return loadTask(taskId);
  });

  // Step 1b: Load blueprint config (per-repo overrides)
  const blueprintConfig = await context.step('load-blueprint', async () => {
    try {
      return await loadBlueprintConfig(task);
    } catch (err) {
      await failTask(taskId, task.status, `Blueprint config load failed: ${String(err)}`, task.user_id, false);
      throw err;
    }
  });

  // Step 2: Admission control — check concurrency limit
  const admitted = await context.step('admission-control', async () => {
    // Re-read status to detect external cancellation between steps
    const current = await loadTask(taskId);
    if (TERMINAL_STATUSES.includes(current.status)) {
      return false;
    }
    const result = await admissionControl(task);
    if (!result) {
      await failTask(taskId, current.status, 'User concurrency limit reached', task.user_id, false);
      await emitTaskEvent(taskId, 'admission_rejected', { reason: 'concurrency_limit' });
    }
    return result;
  });

  if (!admitted) {
    return;
  }

  // Step 2b: Pre-flight checks — verify external dependencies before consuming AgentCore runtime
  const preflightPassed = await context.step('pre-flight', async () => {
    try {
      const current = await loadTask(taskId);
      if (TERMINAL_STATUSES.includes(current.status)) {
        return false;
      }
      const result = await runPreflightChecks(task.repo, blueprintConfig, task.pr_number, task.task_type);
      if (!result.passed) {
        const errorMessage = `Pre-flight check failed: ${result.failureReason}${result.failureDetail ? ' — ' + result.failureDetail : ''}`;
        await failTask(taskId, current.status, errorMessage, task.user_id, true);
        await emitTaskEvent(taskId, 'preflight_failed', {
          reason: result.failureReason,
          detail: result.failureDetail,
          checks: result.checks,
        });
      }
      return result.passed;
    } catch (err) {
      await failTask(taskId, task.status, `Pre-flight failed: ${String(err)}`, task.user_id, true);
      throw err;
    }
  });

  if (!preflightPassed) {
    return;
  }

  // Step 3: Context hydration — assemble payload and transition to HYDRATING
  const payload = await context.step('hydrate-context', async () => {
    try {
      return await hydrateAndTransition(task, blueprintConfig);
    } catch (err) {
      // Hydration may fail due to external cancellation, guardrail blocking, or guardrail API failure — fail the task and release concurrency
      await failTask(taskId, TaskStatus.HYDRATING, `Hydration failed: ${String(err)}`, task.user_id, true);
      throw err;
    }
  });

  // Step 4: Start agent session — resolve compute strategy, invoke runtime, transition to RUNNING
  // Returns the full SessionHandle (serializable) so ECS polling can use it in step 5.
  const sessionHandle = await context.step('start-session', async () => {
    try {
      const strategy = resolveComputeStrategy(blueprintConfig);
      const handle = await strategy.startSession({ taskId, payload, blueprintConfig });

      // Build compute metadata for the task record so cancel-task can stop the right backend
      const computeMetadata: Record<string, string> = handle.strategyType === 'ecs'
        ? { clusterArn: handle.clusterArn, taskArn: handle.taskArn }
        : handle.strategyType === 'ec2'
          ? { instanceId: handle.instanceId, commandId: handle.commandId }
          : { runtimeArn: handle.runtimeArn };

      await transitionTask(taskId, TaskStatus.HYDRATING, TaskStatus.RUNNING, {
        session_id: handle.sessionId,
        started_at: new Date().toISOString(),
        compute_type: handle.strategyType,
        compute_metadata: computeMetadata,
        ...(handle.strategyType === 'agentcore' && { agent_runtime_arn: handle.runtimeArn }),
      });
      await emitTaskEvent(taskId, 'session_started', {
        session_id: handle.sessionId,
        strategy_type: handle.strategyType,
      });

      logger.info('Session started', {
        task_id: taskId,
        session_id: handle.sessionId,
        strategy_type: handle.strategyType,
      });

      return handle;
    } catch (err) {
      await failTask(taskId, TaskStatus.HYDRATING, `Session start failed: ${String(err)}`, task.user_id, true);
      throw err;
    }
  });

  // Resolve the compute strategy once and reuse it across poll iterations
  // instead of constructing a new instance on every cycle.
  const computeStrategy = (blueprintConfig.compute_type === 'ecs' || blueprintConfig.compute_type === 'ec2')
    ? resolveComputeStrategy(blueprintConfig)
    : undefined;

  // Step 5: Wait for agent to finish
  // Polls DynamoDB on each interval. The agent writes terminal status when done.
  // While RUNNING, the runtime updates `agent_heartbeat_at`; if that timestamp
  // goes stale, `pollTaskStatus` sets `sessionUnhealthy` so we fail fast instead
  // of waiting the full MAX_POLL_ATTEMPTS window (~8.5h) after a silent crash.
  // HYDRATING without transition to RUNNING is still bounded by MAX_NON_RUNNING_POLLS (~5min).

  const finalPollState = await context.waitForCondition<PollState>(
    'await-agent-completion',
    async (state) => {
      const ddbState = await pollTaskStatus(taskId, state);
      let consecutiveComputePollFailures = 0;
      let consecutiveComputeCompletedPolls = 0;
      const computeLabel = blueprintConfig.compute_type.toUpperCase();

      // Compute-level crash detection: if DDB is not terminal, check compute task status
      if (
        ddbState.lastStatus &&
        !TERMINAL_STATUSES.includes(ddbState.lastStatus) &&
        computeStrategy
      ) {
        try {
          const computeStatus = await computeStrategy.pollSession(sessionHandle);
          if (computeStatus.status === 'failed') {
            const errorMsg = 'error' in computeStatus ? computeStatus.error : `${computeLabel} task failed`;
            logger.warn(`${computeLabel} task failed before DDB terminal write`, {
              task_id: taskId,
              error: errorMsg,
            });
            await failTask(taskId, ddbState.lastStatus, `${computeLabel} compute failed: ${errorMsg}`, task.user_id, true);
            return { attempts: ddbState.attempts, lastStatus: TaskStatus.FAILED };
          }
          if (computeStatus.status === 'completed') {
            consecutiveComputeCompletedPolls = (state.consecutiveComputeCompletedPolls ?? 0) + 1;
            if (consecutiveComputeCompletedPolls >= MAX_CONSECUTIVE_COMPUTE_COMPLETED_POLLS) {
              logger.error(`${computeLabel} task completed but DDB never caught up — failing task`, {
                task_id: taskId,
                consecutive_completed_polls: consecutiveComputeCompletedPolls,
              });
              await failTask(taskId, ddbState.lastStatus, `${computeLabel} task exited successfully but agent never wrote terminal status after ${consecutiveComputeCompletedPolls} polls`, task.user_id, true);
              return { attempts: ddbState.attempts, lastStatus: TaskStatus.FAILED };
            }
            logger.warn(`${computeLabel} task completed but DDB not terminal — waiting for DDB catchup`, {
              task_id: taskId,
              consecutive_completed_polls: consecutiveComputeCompletedPolls,
            });
          }
        } catch (err) {
          consecutiveComputePollFailures = (state.consecutiveComputePollFailures ?? 0) + 1;
          if (consecutiveComputePollFailures >= MAX_CONSECUTIVE_COMPUTE_POLL_FAILURES) {
            logger.error(`${computeLabel} pollSession failed repeatedly — failing task`, {
              task_id: taskId,
              consecutive_failures: consecutiveComputePollFailures,
              error: err instanceof Error ? err.message : String(err),
            });
            await failTask(taskId, ddbState.lastStatus, `${computeLabel} poll failed ${consecutiveComputePollFailures} consecutive times: ${err instanceof Error ? err.message : String(err)}`, task.user_id, true);
            return { attempts: ddbState.attempts, lastStatus: TaskStatus.FAILED };
          }
          logger.warn(`${computeLabel} pollSession check failed (non-fatal)`, {
            task_id: taskId,
            consecutive_failures: consecutiveComputePollFailures,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { ...ddbState, consecutiveComputePollFailures, consecutiveComputeCompletedPolls };
    },
    {
      initialState: { attempts: 0 },
      waitStrategy: (state: PollState) => {
        if (state.lastStatus && TERMINAL_STATUSES.includes(state.lastStatus)) {
          return { shouldContinue: false };
        }
        if (state.sessionUnhealthy) {
          return { shouldContinue: false };
        }
        if (state.attempts >= MAX_POLL_ATTEMPTS) {
          return { shouldContinue: false };
        }
        // If the task is still HYDRATING after a grace period, the session never
        // started (e.g. container crash). Stop polling early so finalizeTask can
        // transition to FAILED instead of waiting 8.5h.
        if (state.attempts >= MAX_NON_RUNNING_POLLS && state.lastStatus === TaskStatus.HYDRATING) {
          return { shouldContinue: false };
        }
        const pollSeconds = blueprintConfig.poll_interval_ms
          ? Math.ceil(blueprintConfig.poll_interval_ms / 1000)
          : 30;
        return { shouldContinue: true, delay: { seconds: pollSeconds } };
      },
    },
  );

  // Step 6: Finalize — update terminal status, emit events, release concurrency
  await context.step('finalize', async () => {
    await finalizeTask(taskId, finalPollState, task.user_id);
  });
};

export const handler = withDurableExecution(durableHandler);
