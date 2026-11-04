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
import { GetCommand, TransactWriteCommand, UpdateCommand, QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import type { SessionControlOptions } from './compute-strategy';
import { logger } from './logger';
import type { TaskRecord } from './types';
import { makeDocClient } from './ua';
import { computeTtlEpoch } from './validation';
import { TaskStatus, TERMINAL_STATUSES, ApprovalStatusValue } from '../../constructs/task-status';

const ddb = makeDocClient();
const MAX_ATTEMPTS = 3;
const STATE_TIMEOUT_MS = 5_000;

export class TaskCancellationError extends Error {
  constructor(public readonly reason: 'missing' | 'forbidden' | 'terminal' | 'conflict') {
    super(`Task cancellation ${reason}`);
    this.name = 'TaskCancellationError';
  }
}

interface CancellationOptions {
  readonly userId: string;
  readonly taskTable: string;
  readonly approvalsTable?: string;
  readonly eventsTable?: string;
  readonly retentionDays: number;
}

/** The latest pre-cancel record supplies the compute handle for active cleanup. */
export interface TaskCancellationResult {
  readonly task: TaskRecord;
  readonly cancelledAt: string;
  readonly cancelledRequestId?: string;
}

function conditionalConflict(error: unknown): boolean {
  const value = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return value?.name === 'ConditionalCheckFailedException'
    || (value?.name === 'TransactionCanceledException'
      && Boolean(value.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')));
}

/**
 * Cancel exactly the observed task/gate. Approval, timeout and gate changes race
 * through conditional writes; a conflict reloads state before another attempt.
 * A decision that already committed remains a decision, never a cancellation.
 */
export async function cancelTaskState(
  initialTask: TaskRecord,
  options: CancellationOptions,
): Promise<TaskCancellationResult> {
  const abortSignal = AbortSignal.timeout(STATE_TIMEOUT_MS);
  let task = initialTask;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (task.user_id !== options.userId) throw new TaskCancellationError('forbidden');
    if (TERMINAL_STATUSES.includes(task.status)) throw new TaskCancellationError('terminal');
    const requestId = task.awaiting_approval_request_id;
    let closeApproval = false;
    if (requestId) {
      if (!options.approvalsTable || !options.eventsTable) {
        throw new Error('Cancellation of an approval wait requires approvals and events tables');
      }
      const response = await ddb.send(new GetCommand({
        TableName: options.approvalsTable,
        Key: { task_id: task.task_id, request_id: requestId },
        ConsistentRead: true,
      }), { abortSignal });
      const approval = response.Item;
      closeApproval = approval?.status === 'PENDING' && approval.user_id === options.userId;
      if (approval && approval.user_id !== options.userId) {
        // A malformed approval must not prevent the owner stopping their task.
        // Do not change another user's approval record.
        logger.error('Cancellation found an approval owner mismatch', {
          event: 'approval_cancel_owner_mismatch', task_id: task.task_id, request_id: requestId,
        });
      }
    }
    const now = new Date().toISOString();
    const update = {
      TableName: options.taskTable,
      Key: { task_id: task.task_id },
      UpdateExpression: 'SET #status = :cancelled, updated_at = :now, completed_at = :now, status_created_at = :sca, #ttl = :ttl',
      ConditionExpression: 'attribute_exists(task_id) AND user_id = :user AND #status = :observed AND '
        + (requestId
          ? 'awaiting_approval_request_id = :request'
          : '(attribute_not_exists(awaiting_approval_request_id) OR awaiting_approval_request_id = :request)'),
      ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':cancelled': TaskStatus.CANCELLED,
        ':now': now,
        ':sca': `${TaskStatus.CANCELLED}#${now}`,
        ':ttl': computeTtlEpoch(options.retentionDays),
        ':user': options.userId,
        ':observed': task.status,
        ':request': requestId ?? null,
      },
    };
    try {
      if (closeApproval) {
        await ddb.send(new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            { Update: update },
            {
              Update: {
                TableName: options.approvalsTable!,
                Key: { task_id: task.task_id, request_id: requestId! },
                UpdateExpression: 'SET #status = :cancelled, decided_at = :now, cancellation_reason = :reason',
                ConditionExpression: '#status = :pending AND user_id = :user',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':cancelled': ApprovalStatusValue.CANCELLED,
                  ':pending': ApprovalStatusValue.PENDING,
                  ':user': options.userId,
                  ':now': now,
                  ':reason': 'Task cancelled by its owner',
                },
              },
            },
            {
              Put: {
                TableName: options.eventsTable!,
                Item: {
                  task_id: task.task_id,
                  event_id: ulid(),
                  event_type: 'approval_cancelled',
                  timestamp: now,
                  ttl: computeTtlEpoch(options.retentionDays),
                  metadata: {
                    request_id: requestId,
                    status: 'CANCELLED',
                    reason: 'Task cancelled by its owner',
                  },
                },
              },
            },
          ],
        }), { abortSignal });
      } else {
        await ddb.send(new UpdateCommand(update), { abortSignal });
      }
      return { task, cancelledAt: now, ...(closeApproval && { cancelledRequestId: requestId }) };
    } catch (error) {
      if (!conditionalConflict(error)) throw error;
      logger.info('Task cancellation raced with a state change; refreshing', {
        event: 'task_cancel_retry', task_id: task.task_id, attempt: attempt + 1,
      });
      const fresh = await ddb.send(new GetCommand({
        TableName: options.taskTable, Key: { task_id: task.task_id }, ConsistentRead: true,
      }), { abortSignal });
      if (!fresh.Item) throw new TaskCancellationError('missing');
      task = fresh.Item as TaskRecord;
    }
  }
  throw new TaskCancellationError('conflict');
}

// ---------------------------------------------------------------------------
// Approval closure on task close
// ---------------------------------------------------------------------------

const CLEANUP_TIMEOUT_MS = 10_000;
const UPDATE_BATCH_SIZE = 4;

/** Task closure closes its unanswered requests; no action-content recheck is involved. */
export async function closeTaskApprovals(
  taskId: string, userId: string, options: SessionControlOptions = { abortSignal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
): Promise<void> {
  if (!process.env.TASK_APPROVALS_TABLE_NAME) return;
  const current = await ddb.send(new GetCommand({
    TableName: process.env.TASK_TABLE_NAME!, Key: { task_id: taskId }, ConsistentRead: true,
  }), options);
  if (current.Item?.user_id !== userId || !TERMINAL_STATUSES.includes(current.Item.status)) return;
  const terminalStatus: string = current.Item.status;
  let key: Record<string, any> | undefined;
  const now = new Date().toISOString();
  const ttl = computeTtlEpoch(Number(process.env.TASK_RETENTION_DAYS ?? '90'));
  do {
    const page: QueryCommandOutput = await ddb.send(new QueryCommand({
      TableName: process.env.TASK_APPROVALS_TABLE_NAME,
      ConsistentRead: true,
      KeyConditionExpression: 'task_id = :task',
      FilterExpression: 'attribute_not_exists(#ttl) OR #status = :pending',
      ExpressionAttributeNames: { '#ttl': 'ttl', '#status': 'status' },
      ExpressionAttributeValues: { ':task': taskId, ':pending': ApprovalStatusValue.PENDING },
      ExclusiveStartKey: key,
    }), options);
    const rows = (page.Items ?? []).filter(row =>
      row.user_id === userId && typeof row.request_id === 'string' && typeof row.status === 'string');
    for (let index = 0; index < rows.length; index += UPDATE_BATCH_SIZE) {
      // Each slice bounds concurrent writes; completed rows are filtered on retry.
      // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
      await Promise.all(rows.slice(index, index + UPDATE_BATCH_SIZE).map(async row => {
        const pending = row.status === 'PENDING';
        try {
          await ddb.send(new UpdateCommand({
            TableName: process.env.TASK_APPROVALS_TABLE_NAME,
            Key: { task_id: taskId, request_id: row.request_id },
            UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl)' + (pending
              ? ', #status = :cancelled, decided_at = :now, cancellation_reason = :reason' : ''),
            ConditionExpression: 'user_id = :user AND #status = :observed',
            ExpressionAttributeNames: { '#ttl': 'ttl', '#status': 'status' },
            ExpressionAttributeValues: {
              ':ttl': ttl,
              ':user': userId,
              ':observed': row.status,
              ...(pending && {
                ':cancelled': ApprovalStatusValue.CANCELLED,
                ':now': now,
                ':reason': `Owning task is ${terminalStatus.toLowerCase()}.`,
              }),
            },
          }), options);
        } catch (error) {
          if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
          // An answer can win after the query. Preserve it and add only retention.
          await ddb.send(new UpdateCommand({
            TableName: process.env.TASK_APPROVALS_TABLE_NAME,
            Key: { task_id: taskId, request_id: row.request_id },
            UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl)',
            ConditionExpression: 'user_id = :user AND #status <> :pending',
            ExpressionAttributeNames: { '#ttl': 'ttl', '#status': 'status' },
            ExpressionAttributeValues: { ':ttl': ttl, ':user': userId, ':pending': ApprovalStatusValue.PENDING },
          }), options).catch(race => {
            if ((race as { name?: string }).name !== 'ConditionalCheckFailedException') throw race;
          });
        }
      }));
    }
    key = page.LastEvaluatedKey;
  } while (key);
}
