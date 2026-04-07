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
import {
  admissionControl,
  emitTaskEvent,
  failTask,
  finalizeTask,
  hydrateAndTransition,
  loadBlueprintConfig,
  loadTask,
  pollTaskStatus,
  startSession,
  type PollState,
} from './shared/orchestrator';
import { runPreflightChecks } from './shared/preflight';

interface OrchestrateTaskEvent {
  readonly task_id: string;
}

const MAX_POLL_ATTEMPTS = 1020; // ~8.5h at 30s intervals
const MAX_NON_RUNNING_POLLS = 10; // ~5min grace period for session to start

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
      const result = await runPreflightChecks(task.repo, blueprintConfig);
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
      // Transition may fail if task was externally cancelled — release concurrency
      await failTask(taskId, task.status, `Hydration failed: ${String(err)}`, task.user_id, true);
      throw err;
    }
  });

  // Step 4: Start agent session — invoke runtime and transition to RUNNING
  await context.step('start-session', async () => {
    try {
      return await startSession(task, payload, blueprintConfig);
    } catch (err) {
      await failTask(taskId, TaskStatus.HYDRATING, `Session start failed: ${String(err)}`, task.user_id, true);
      throw err;
    }
  });

  // Step 5: Wait for agent to finish
  // NOTE: Polls DynamoDB every 30s rather than re-invoking the AgentCore session.
  // The agent writes terminal status directly to DDB. If the agent crashes without
  // writing a terminal status, we detect it via the HYDRATING early-exit check
  // (MAX_NON_RUNNING_POLLS ~5min); otherwise the loop runs up to MAX_POLL_ATTEMPTS
  // (~8.5h). A future improvement could add AgentCore session status checks for
  // faster crash detection.
  const finalPollState = await context.waitForCondition<PollState>(
    'await-agent-completion',
    async (state) => {
      return pollTaskStatus(taskId, state);
    },
    {
      initialState: { attempts: 0 },
      waitStrategy: (state: PollState) => {
        if (state.lastStatus && TERMINAL_STATUSES.includes(state.lastStatus)) {
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
