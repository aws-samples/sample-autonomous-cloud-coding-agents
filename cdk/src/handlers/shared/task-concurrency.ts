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

import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import { makeDocClient } from './ua';
import { ACTIVE_STATUSES, TaskStatus, TERMINAL_STATUSES } from '../../constructs/task-status';

/** Internal TaskTable data; a released task cannot acquire another reservation. */
export interface ReservationTask {
  readonly task_id: string;
  readonly user_id: string;
  readonly status: string;
  readonly concurrency_slot?: {
    readonly state: 'held' | 'released';
    readonly acquired_at: string;
    readonly released_at?: string;
  };
}

const ddb = makeDocClient();
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const COUNTER_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME!;

function terminal(status: string): boolean {
  return TERMINAL_STATUSES.some(value => value === status);
}

async function readTask(taskId: string, userId: string): Promise<ReservationTask | undefined> {
  const result = await ddb.send(new GetCommand({
    TableName: TASK_TABLE, Key: { task_id: taskId }, ConsistentRead: true,
  }));
  const task = result.Item as ReservationTask | undefined;
  if (task && task.user_id !== userId) throw new Error('Concurrency reservation owner does not match task owner');
  return task;
}

function conditionalFailure(error: unknown, index: number): boolean {
  const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] };
  return failure?.name === 'TransactionCanceledException'
    && failure.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed';
}

/** Reserve once per task, including after a lost transaction acknowledgement. */
export async function acquireTaskSlot(taskId: string, userId: string, limit: number): Promise<boolean> {
  const current = await readTask(taskId, userId);
  if (!current) throw new Error(`Cannot reserve capacity for missing task ${taskId}`);
  if (current.concurrency_slot?.state === 'held') {
    return ACTIVE_STATUSES.some(status => status === current.status);
  }
  if (current.status !== TaskStatus.SUBMITTED || current.concurrency_slot) return false;

  const now = new Date().toISOString();
  const revision = randomUUID();
  try {
    await ddb.send(new TransactWriteCommand({
      ClientRequestToken: revision,
      TransactItems: [
        {
          Update: {
            TableName: TASK_TABLE,
            Key: { task_id: taskId },
            UpdateExpression: 'SET concurrency_slot = :slot',
            ConditionExpression: 'user_id = :user AND #status = :submitted AND attribute_not_exists(concurrency_slot)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':slot': { state: 'held', acquired_at: now },
              ':user': userId,
              ':submitted': TaskStatus.SUBMITTED,
            },
          },
        },
        {
          Update: {
            TableName: COUNTER_TABLE,
            Key: { user_id: userId },
            UpdateExpression: 'SET active_count = if_not_exists(active_count, :zero) + :one, '
            + 'updated_at = :now, reservation_version = :version',
            ConditionExpression: 'attribute_not_exists(active_count) OR active_count < :max',
            ExpressionAttributeValues: {
              ':zero': 0, ':one': 1, ':max': limit, ':now': now, ':version': revision,
            },
          },
        },
      ],
    }));
    return true;
  } catch (error) {
    // A competing invocation or a lost successful response may have reserved it.
    const latest = await readTask(taskId, userId);
    if (latest?.concurrency_slot?.state === 'held') {
      return ACTIVE_STATUSES.some(status => status === latest.status);
    }
    if (!latest || latest.status !== TaskStatus.SUBMITTED || latest.concurrency_slot) return false;
    if (conditionalFailure(error, 1)) return false; // Capacity was full.
    throw error; // Throttling/conflict/outage is not evidence that capacity is full.
  }
}

/**
 * Return a terminal task's reservation atomically with its counter update.
 * Never infer ownership from status alone: legacy/unadmitted tasks have no
 * marker and cannot return another task's seat. Reconciliation handles drift.
 */
export async function releaseTaskSlot(taskId: string, userId: string): Promise<boolean> {
  const current = await readTask(taskId, userId);
  if (!current || !terminal(current.status) || current.concurrency_slot?.state !== 'held') return false;

  let emptyCounter = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = new Date().toISOString();
    const revision = randomUUID();
    try {
      await ddb.send(new TransactWriteCommand({
        ClientRequestToken: revision,
        TransactItems: [
          {
            Update: {
              TableName: TASK_TABLE,
              Key: { task_id: taskId },
              UpdateExpression: 'SET concurrency_slot.#state = :released, concurrency_slot.released_at = :now',
              ConditionExpression: 'user_id = :user AND concurrency_slot.#state = :held '
              + 'AND #status IN (:completed, :failed, :cancelled, :timedOut)',
              ExpressionAttributeNames: { '#state': 'state', '#status': 'status' },
              ExpressionAttributeValues: {
                ':user': userId,
                ':held': 'held',
                ':released': 'released',
                ':now': now,
                ':completed': TaskStatus.COMPLETED,
                ':failed': TaskStatus.FAILED,
                ':cancelled': TaskStatus.CANCELLED,
                ':timedOut': TaskStatus.TIMED_OUT,
              },
            },
          },
          {
            Update: {
              TableName: COUNTER_TABLE,
              Key: { user_id: userId },
              UpdateExpression: emptyCounter
                ? 'SET active_count = if_not_exists(active_count, :zero), updated_at = :now, reservation_version = :version'
                : 'SET active_count = active_count - :one, updated_at = :now, reservation_version = :version',
              ConditionExpression: emptyCounter
                ? 'attribute_not_exists(active_count) OR active_count >= :zero'
                : 'active_count > :zero',
              ExpressionAttributeValues: {
                ':zero': 0, ...(!emptyCounter && { ':one': 1 }), ':now': now, ':version': revision,
              },
            },
          },
        ],
      }));
      if (emptyCounter) {
        logger.warn('Released task reservation whose counter was already empty', {
          task_id: taskId, user_id: userId, error_id: 'CONCURRENCY_EMPTY_COUNTER',
        });
      }
      return true;
    } catch (error) {
      const latest = await readTask(taskId, userId);
      if (latest?.concurrency_slot?.state === 'released') return false;
      if (!latest || !terminal(latest.status) || latest.concurrency_slot?.state !== 'held') return false;
      if (!emptyCounter && conditionalFailure(error, 1)) {
        // This attempt observed no positive count. Close its marker without
        // subtracting from seats reserved since then. A concurrent repair may
        // leave an overcount, which a later revision-guarded sweep can correct.
        emptyCounter = true;
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not release capacity reservation for task ${taskId}`);
}
