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

import { GetCommand, ScanCommand, UpdateCommand, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';
import { TaskStatus, TERMINAL_STATUSES } from '../constructs/task-status';
import { closeTaskApprovals } from './shared/close-task-approvals';
import { logger } from './shared/logger';
import { dispatchMicrovmContinuation } from './shared/microvm-continuation-dispatch';
import { retireCheckpointedMicrovm, type ContinuableTask } from './shared/microvm-continuation-retirement';
import { deleteClosedTaskContinuations } from './shared/microvm-continuation-storage';
import { CONTINUATION_IO_TIMEOUT_MS, CONTINUATION_RETIREMENT_TIMEOUT_MS } from './shared/microvm-continuation-timing';
import { workerLeaseKey, type MicrovmHandle } from './shared/microvm-continuation-types';
import { microvmErrorIdentity } from './shared/microvm-control';
import { LambdaMicrovmComputeStrategy, MICROVM_MAX_DURATION_SECONDS } from './shared/strategies/lambda-microvm-strategy';
import { releaseTaskSlot } from './shared/task-concurrency';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const strategy = new LambdaMicrovmComputeStrategy();
const TABLE = process.env.TASK_TABLE_NAME!;
const CURSOR_KEY = { task_id: 'continuation-manager#cursor' };
const CURSOR_WRITE_TIMEOUT_MS = 5000;
const MIN_REMAINING_MS = 45_000;
const BATCH_SIZE = 4;

/** Every mutation below rechecks the current owner/attempt; scan rows are only hints. */
export async function reconcileMicrovmContinuation(task: ContinuableTask): Promise<void> {
  const options = { abortSignal: AbortSignal.timeout(CONTINUATION_RETIREMENT_TIMEOUT_MS) };
  // The scan can predate a replacement or cancellation. Resolve physical identity
  // again before issuing a stop against a terminal task.
  if (TERMINAL_STATUSES.includes(task.status)) {
    const latest = await ddb.send(new GetCommand({
      TableName: TABLE, Key: { task_id: task.task_id }, ConsistentRead: true,
    }), options);
    if (latest.Item?.user_id !== task.user_id || !TERMINAL_STATUSES.includes(latest.Item.status)) return;
    task = latest.Item as ContinuableTask;
    const handle = task.microvm_start?.handle as MicrovmHandle | undefined;
    await closeTaskApprovals(task.task_id, task.user_id, options);
    if (handle) {
      await strategy.stopSession(handle, options);
      const observed = await strategy.pollSession(handle, options);
      if (!['TERMINATED', 'NOT_FOUND'].includes(observed.microvmState ?? '')) return;
    } else {
      // An unanswered RunMicrovm response has no handle to inspect. Its fixed
      // service lifetime is the only safe bound on a potentially created worker.
      const started = Date.parse(task.microvm_start?.createdAt ?? '');
      if (task.microvm_start && !Number.isFinite(started)) {
        throw new Error('MICROVM_CONTINUATION_START_TIME_INVALID: cannot confirm the unknown worker lifetime');
      }
      if (Number.isFinite(started) && Date.now() < started + MICROVM_MAX_DURATION_SECONDS * 1000) return;
    }
    let attempt = task.microvm_start?.clientToken;
    const withoutStart = !task.microvm_start;
    let leaseState: string | undefined;
    if (withoutStart) {
      // Replacement admission removes the old start receipt. Its new launch
      // token lives on the coordinator-owned slot and lease, not the task id.
      const lease = (await ddb.send(new GetCommand({
        TableName: TABLE, Key: workerLeaseKey(task.task_id), ConsistentRead: true,
      }), options)).Item;
      if (lease) {
        const notLaunched = lease.lease_state === 'ACTIVE' && !lease.lease_microvm_id
          && task.concurrency_slot?.state === 'held'
          && task.concurrency_slot.attempt_id === lease.lease_attempt_id;
        if (lease.lease_user_id !== task.user_id
          || (!['PARKED', 'CLOSED'].includes(lease.lease_state) && !notLaunched)
          || typeof lease.lease_attempt_id !== 'string' || !lease.lease_attempt_id) {
          throw new Error('MICROVM_CONTINUATION_LEASE_INVALID: missing start does not prove worker shutdown');
        }
        attempt = lease.lease_attempt_id;
        leaseState = lease.lease_state;
      }
    }
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: workerLeaseKey(task.task_id),
      UpdateExpression: 'SET #ttl = :ttl, lease_state = :closed, lease_user_id = :user, lease_attempt_id = :attempt',
      ConditionExpression: 'attribute_not_exists(task_id) OR (lease_user_id = :user AND lease_attempt_id = :attempt'
        + (withoutStart ? ' AND lease_state = :observedState' : '')
        + (leaseState === 'ACTIVE' ? ' AND attribute_not_exists(lease_microvm_id)' : '') + ')',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':user': task.user_id,
        ':closed': 'CLOSED',
        ':attempt': attempt ?? task.task_id,
        ...(withoutStart ? { ':observedState': leaseState ?? 'CLOSED' } : {}),
        ':ttl': Math.floor(Date.now() / 1000) + Number(process.env.TASK_RETENTION_DAYS ?? '90') * 86400,
      },
    }), options);
    await releaseTaskSlot(task.task_id, task.user_id);
    await deleteClosedTaskContinuations(task.task_id, task.user_id, options);
    return;
  }
  if (task.status !== TaskStatus.AWAITING_APPROVAL || !task.awaiting_approval_request_id) return;
  const handle = task.microvm_start?.handle as MicrovmHandle | undefined;
  if (task.continuation?.state === 'READY' || task.continuation?.state === 'FENCED') {
    if (!handle) throw new Error('MICROVM_CONTINUATION_HANDLE_MISSING: cannot confirm source shutdown');
    const observed = await strategy.pollSession(handle, options);
    const terminal = ['TERMINATED', 'NOT_FOUND'].includes(observed.microvmState ?? '');
    const sourceStarted = observed.microvmStartedAtMs ?? Date.parse(task.microvm_start?.createdAt ?? '');
    await retireCheckpointedMicrovm({
      taskId: task.task_id,
      userId: task.user_id,
      handle,
      strategy,
      force: terminal,
      abortSignal: options.abortSignal,
      sessionDeadlineMs: Number.isFinite(sourceStarted)
        ? sourceStarted + (observed.microvmMaximumDurationSeconds ?? MICROVM_MAX_DURATION_SECONDS) * 1000
        : Infinity,
    });
  }
  await dispatchMicrovmContinuation(task.task_id, task.user_id, task.awaiting_approval_request_id, options);
}

/**
 * Backstop for lost approval invokes, unfinished retirement, and closed-task
 * object cleanup. The task table is scanned with the same bounded-page pattern
 * as the concurrency reconciler; reserved lease items have no launch receipt.
 */
export async function handler(_event: unknown, context: Pick<Context, 'getRemainingTimeInMillis'>): Promise<void> {
  const saved = await ddb.send(new GetCommand({
    TableName: TABLE, Key: CURSOR_KEY, ConsistentRead: true,
  }), { abortSignal: AbortSignal.timeout(CONTINUATION_IO_TIMEOUT_MS) });
  const initialCursor: Record<string, any> | undefined = saved.Item?.cursor;
  let lastKey = initialCursor;
  const saveCursor = async (cursor?: Record<string, unknown>) => {
    const values = {
      ...(cursor && { ':cursor': cursor }),
      ...(initialCursor && { ':previous': initialCursor }),
    };
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: CURSOR_KEY,
        UpdateExpression: cursor ? 'SET #cursor = :cursor' : 'REMOVE #cursor',
        ConditionExpression: initialCursor ? '#cursor = :previous' : 'attribute_not_exists(#cursor)',
        ExpressionAttributeNames: { '#cursor': 'cursor' },
        ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
      }), { abortSignal: AbortSignal.timeout(CURSOR_WRITE_TIMEOUT_MS) });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error;
      logger.info('Another continuation sweep advanced the cursor; preserving its progress');
    }
  };
  let processed = 0;
  let failures = 0;
  do {
    if (context.getRemainingTimeInMillis() < MIN_REMAINING_MS) {
      await saveCursor(lastKey);
      return;
    }
    const page: ScanCommandOutput = await ddb.send(new ScanCommand({
      TableName: TABLE,
      ConsistentRead: true,
      Limit: 100,
      FilterExpression: 'attribute_exists(continuation_launch)',
      ExclusiveStartKey: lastKey,
    }), { abortSignal: AbortSignal.timeout(CONTINUATION_IO_TIMEOUT_MS) });
    // Small batches bound both downstream concurrency and the invocation budget.
    const tasks = page.Items ?? [];
    let lastProcessedKey = lastKey;
    for (let index = 0; index < tasks.length; index += BATCH_SIZE) {
      if (context.getRemainingTimeInMillis() < MIN_REMAINING_MS) {
        await saveCursor(lastProcessedKey);
        logger.warn('Continuation reconciliation reached its invocation budget', { processed, failures });
        return;
      }
      // The slice bounds work to BATCH_SIZE.
      // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
      await Promise.all(tasks.slice(index, index + BATCH_SIZE).map(async row => {
        try {
          await reconcileMicrovmContinuation(row as ContinuableTask);
          processed++;
        } catch (error) {
          failures++;
          logger.warn('Continuation reconciliation will retry', { task_id: row.task_id, ...microvmErrorIdentity(error) });
        }
      }));
      lastProcessedKey = { task_id: tasks[Math.min(index + BATCH_SIZE - 1, tasks.length - 1)].task_id };
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  await saveCursor();
  logger.info('Continuation reconciliation finished', { processed, failures });
}
