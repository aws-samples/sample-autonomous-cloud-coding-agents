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

import type { DurableContext, WaitForConditionDecision } from '@aws/durable-execution-sdk-js';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { resolveComputeStrategy, type ComputeStrategy } from './compute-strategy';
import type { ContinuableTask } from './microvm-continuation-retirement';
import { admitContinuation } from './microvm-continuation-start';
import { loadContinuationLaunch } from './microvm-continuation-storage';
import { CONTINUATION_IO_TIMEOUT_MS, CONTINUATION_POLL_INTERVAL_MS, CONTINUATION_RETRY_POLL_SECONDS, CONTINUATION_START_ATTEMPTS, CONTINUATION_TRANSITION_POLL_SECONDS } from './microvm-continuation-timing';
import { type MicrovmHandle, validAttemptId, workerLeaseKey } from './microvm-continuation-types';
import { microvmErrorIdentity } from './microvm-control';
import { MICROVM_MAX_POLL_FAILURES, stopMicrovmWithDiagnostics } from './microvm-supervisor';
import { pollMicrovmTask } from './microvm-task-poll';
import { emitTaskEvent, envelopeFor, finalizeTask, loadTask, type PollState } from './orchestrator';
import { deleteMicrovmPayload } from './strategies/lambda-microvm-strategy';
import { makeDocClient } from './ua';
import { TaskStatus, TERMINAL_STATUSES } from '../../constructs/task-status';

const ddb = makeDocClient();
const TABLE = process.env.TASK_TABLE_NAME!;
const RESTORE_TIMEOUT_MS = 900_000;

export interface MicrovmContinuationEvent {
  readonly task_id: string;
  readonly continuation_request_id: string;
  readonly continuation_attempt_id: string;
}

function sameAttempt(task: ContinuableTask, event: MicrovmContinuationEvent): boolean {
  return task.microvm_start?.clientToken === event.continuation_attempt_id
    || task.continuation?.attempt_id === event.continuation_attempt_id;
}

/**
 * Fence the assigned process while closing a failed restoration. A lost reply
 * is resolved by a strong read; a different attempt is never changed.
 */
export async function failContinuationAttempt(
  event: MicrovmContinuationEvent, userId: string, detail: string,
): Promise<void> {
  const task = await loadTask(event.task_id, true) as ContinuableTask;
  if (task.user_id !== userId || !sameAttempt(task, event) || TERMINAL_STATUSES.includes(task.status)) return;
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { task_id: event.task_id },
            UpdateExpression: 'SET #status = :failed, error_message = :detail, completed_at = :now, '
            + 'updated_at = :now, status_created_at = :statusTime',
            ConditionExpression: 'user_id = :user AND #status = :status '
            + 'AND (continuation.attempt_id = :attempt OR microvm_start.clientToken = :attempt)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':failed': TaskStatus.FAILED,
              ':detail': detail,
              ':now': new Date().toISOString(),
              ':statusTime': `FAILED#${new Date().toISOString()}`,
              ':user': userId,
              ':status': task.status,
              ':attempt': event.continuation_attempt_id,
            },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: workerLeaseKey(event.task_id),
            UpdateExpression: 'SET lease_state = :fenced',
            ConditionExpression: 'lease_user_id = :user AND lease_attempt_id = :attempt AND lease_state = :active',
            ExpressionAttributeValues: {
              ':user': userId, ':attempt': event.continuation_attempt_id, ':active': 'ACTIVE', ':fenced': 'FENCED',
            },
          },
        },
      ],
    }));
  } catch (error) {
    const latest = await loadTask(event.task_id, true) as ContinuableTask;
    if (latest.user_id === userId && sameAttempt(latest, event) && !TERMINAL_STATUSES.includes(latest.status)) throw error;
  }
}

export interface RestoreState {
  readonly deadlineMs: number;
  readonly ready?: boolean;
  readonly closed?: boolean;
  readonly ownershipLost?: boolean;
  readonly failure?: string;
  readonly consecutivePollFailures?: number;
}

/** Restoration has its own bounded startup window; it is not a /resume hook. */
export async function pollContinuationRestore(
  event: MicrovmContinuationEvent, userId: string, handle: MicrovmHandle,
  strategy: ComputeStrategy, previous: RestoreState,
): Promise<RestoreState> {
  const task = await loadTask(event.task_id, true) as ContinuableTask;
  if (task.user_id !== userId || task.session_id !== handle.microvmId
    || task.compute_metadata?.microvmId !== handle.microvmId) return { ...previous, ownershipLost: true };
  if (TERMINAL_STATUSES.includes(task.status)) return { ...previous, closed: true };
  if (task.status === TaskStatus.RUNNING || task.status === TaskStatus.FINALIZING
    || (task.status === TaskStatus.AWAITING_APPROVAL
      && task.awaiting_approval_request_id !== event.continuation_request_id)) {
    return { ...previous, ready: true };
  }
  if (!sameAttempt(task, event) || task.continuation?.state !== 'RESTORING') {
    return { ...previous, failure: 'MICROVM_CONTINUATION_ASSIGNMENT_CHANGED: restoration no longer owns its saved request' };
  }
  if (Date.now() >= previous.deadlineMs) {
    return { ...previous, failure: 'MICROVM_CONTINUATION_RESTORE_TIMEOUT: saved workspace and conversation were not restored within 15 minutes' };
  }
  try {
    const observed = await strategy.pollSession(handle, { abortSignal: AbortSignal.timeout(CONTINUATION_IO_TIMEOUT_MS) });
    if (observed.status === 'completed' || observed.status === 'failed') {
      return { ...previous, failure: `MICROVM_CONTINUATION_WORKER_STOPPED: ${observed.reason ?? ('error' in observed ? observed.error : observed.status)}` };
    }
    return { deadlineMs: previous.deadlineMs, consecutivePollFailures: 0 };
  } catch (error) {
    const failures = (previous.consecutivePollFailures ?? 0) + 1;
    return {
      deadlineMs: previous.deadlineMs,
      consecutivePollFailures: failures,
      ...(failures >= MICROVM_MAX_POLL_FAILURES && {
        failure: `MICROVM_CONTINUATION_POLL_FAILED: ${microvmErrorIdentity(error).error_type}`,
      }),
    };
  }
}

export function continuationWaitStrategy(state: PollState): WaitForConditionDecision {
  if (state.microvmParked || state.microvmOwnershipLost
    || (state.lastStatus && TERMINAL_STATUSES.includes(state.lastStatus))) return { shouldContinue: false };
  if (state.microvmRetiring) {
    return {
      shouldContinue: true, delay: { seconds: state.microvmRetirementError ? CONTINUATION_RETRY_POLL_SECONDS : CONTINUATION_TRANSITION_POLL_SECONDS },
    };
  }
  if (state.microvmFailureReason || state.sessionUnhealthy) return { shouldContinue: false };
  return {
    shouldContinue: true,
    delay: { seconds: Math.max(1, Math.ceil((state.microvmSupervisor?.nextPollInMs ?? CONTINUATION_POLL_INTERVAL_MS) / 1000)) },
  };
}

/** One durable execution for one assigned replacement; dispatch supplies a stable execution name. */
export async function runMicrovmContinuation(event: MicrovmContinuationEvent, context: DurableContext): Promise<void> {
  if (![event.task_id, event.continuation_request_id, event.continuation_attempt_id].every(validAttemptId)) {
    throw new Error('MICROVM_CONTINUATION_EVENT_INVALID: invalid task, request or worker attempt');
  }
  const task = await context.step('continuation-task', async () => loadTask(event.task_id, true) as Promise<ContinuableTask>);
  if (!sameAttempt(task, event) || TERMINAL_STATUSES.includes(task.status)) return;
  const { correlation, log } = envelopeFor(task);
  const emit = (type: string, metadata: Record<string, unknown>, options?: { abortSignal?: AbortSignal }) =>
    emitTaskEvent(task.task_id, type, metadata, correlation, options);
  let handle: MicrovmHandle | undefined;
  let strategy: ComputeStrategy | undefined;
  try {
    const launch = await context.step('continuation-launch-inputs', async () => {
      if (!task.continuation_launch) throw new Error('MICROVM_CONTINUATION_INPUT_INVALID: saved launch is missing');
      const saved = await loadContinuationLaunch(task.task_id, task.user_id, task.continuation_launch);
      if (saved.orchestrator_version !== process.env.AWS_LAMBDA_FUNCTION_VERSION) {
        throw new Error('MICROVM_CONTINUATION_VERSION_CHANGED: recovery requires the original published coordinator');
      }
      return saved;
    });
    strategy = resolveComputeStrategy(launch.blueprint);
    const assigned = await context.step('continuation-assignment', async () => {
      // Dispatch already admitted this attempt. This call verifies its readonly
      // lease and held slot; it cannot re-admit a different request.
      const current = await loadTask(task.task_id, true) as ContinuableTask;
      if (!sameAttempt(current, event)) return null;
      const admission = await admitContinuation(task.task_id, task.user_id, event.continuation_request_id, 1);
      return admission.kind === 'ready' && sameAttempt(admission.task, event) ? admission.task : null;
    });
    if (!assigned) return;
    const source = assigned.continuation?.source_handle;
    if (!source?.imageArn || !source.imageVersion || !assigned.continuation?.started_at) {
      throw new Error('MICROVM_CONTINUATION_IMAGE_INVALID: saved worker image or assignment time is missing');
    }
    const startInput = {
      taskId: task.task_id,
      userId: task.user_id,
      blueprintConfig: launch.blueprint,
      payload: {
        ...launch.payload,
        attempt_id: event.continuation_attempt_id,
        task_started_at: assigned.continuation.started_at,
      },
      microvmImage: { imageArn: source.imageArn, imageVersion: source.imageVersion },
    };
    const started = await context.step('continuation-start', () => strategy!.startSession(startInput), {
      // All retries use the immutable start receipt/token, including lost replies.
      retryStrategy: (_error, attempt) => ({ shouldRetry: attempt < CONTINUATION_START_ATTEMPTS, delay: { seconds: 10 } }),
    });
    if (started.strategyType !== 'lambda-microvm') throw new Error('MICROVM_CONTINUATION_BACKEND_CHANGED');
    handle = started;
    const restoring = await context.waitForCondition<RestoreState>('continuation-restore', state =>
      pollContinuationRestore(event, task.user_id, started, strategy!, state), {
      initialState: { deadlineMs: Date.parse(assigned.continuation.started_at) + RESTORE_TIMEOUT_MS },
      waitStrategy: state => ({
        shouldContinue: !state.ready && !state.closed && !state.ownershipLost && !state.failure,
        delay: { seconds: 5 },
      }),
    });
    if (restoring.failure) throw new Error(restoring.failure);
    if (restoring.ownershipLost) {
      await context.step('continuation-stop-old-worker', () => stopMicrovmWithDiagnostics({
        taskId: task.task_id, handle: started, strategy: strategy!, emitEvent: emit,
      }));
      return;
    }
    const final = restoring.closed ? { attempts: 0 } : await context.waitForCondition<PollState>(
      'continuation-agent-completion', state => pollMicrovmTask({
        taskId: task.task_id,
        userId: task.user_id,
        handle: started,
        strategy: strategy!,
        pollIntervalMs: launch.blueprint.poll_interval_ms ?? CONTINUATION_POLL_INTERVAL_MS,
        suspendEnabled: process.env.MICROVM_APPROVAL_SUSPEND_ENABLED === 'true',
        emitEvent: emit,
      }, state), { initialState: { attempts: 0 }, waitStrategy: continuationWaitStrategy },
    );
    await context.step('continuation-finalize', async () => {
      if (final.microvmParked) {
        await emit('continuation_parked', {
          microvm_id: started.microvmId,
          detail: 'Your approval request is still available. The saved task will continue on another worker after your answer.',
        });
      } else {
        try {
          const current = await loadTask(task.task_id, true);
          if (!final.microvmOwnershipLost && current.session_id === started.microvmId) {
            await finalizeTask(task.task_id, final, task.user_id);
          }
        } finally {
          await stopMicrovmWithDiagnostics({
            taskId: task.task_id, handle: started, strategy: strategy!, emitEvent: emit,
          });
        }
      }
      await deleteMicrovmPayload(task.task_id, event.continuation_attempt_id);
    });
  } catch (error) {
    // Recover a handle saved before the start step's reply was lost.
    await context.step('continuation-failed', async () => {
      const current = await loadTask(task.task_id, true) as ContinuableTask;
      if (!sameAttempt(current, event)) return;
      const savedHandle = current.microvm_start?.handle as MicrovmHandle | undefined;
      const ownedHandle = handle ?? savedHandle;
      await failContinuationAttempt(event, task.user_id, `Saved-task continuation failed: ${String(error)}`);
      if (ownedHandle) {
        const cleanup = strategy ?? resolveComputeStrategy({ compute_type: 'lambda-microvm' } as Parameters<typeof resolveComputeStrategy>[0]);
        await stopMicrovmWithDiagnostics({ taskId: task.task_id, handle: ownedHandle, strategy: cleanup, emitEvent: emit });
      }
      await finalizeTask(task.task_id, { attempts: 0 }, task.user_id);
      await deleteMicrovmPayload(task.task_id, event.continuation_attempt_id);
      log.error('Saved-task continuation failed', {
        request_id: event.continuation_request_id,
        attempt_id: event.continuation_attempt_id,
        ...microvmErrorIdentity(error),
      });
    });
  }
}
