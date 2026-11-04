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

import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { computeTtlEpoch } from './validation';
import { TaskStatus } from '../../constructs/task-status';

export interface CancelTaskTables {
  readonly ddb: DynamoDBDocumentClient;
  readonly taskTableName: string;
  readonly taskEventsTableName: string;
  readonly retentionDays: number;
}

/**
 * Conditionally move a task to CANCELLED. Returns ``'already_terminal'`` when
 * the task reached COMPLETED / FAILED / CANCELLED / TIMED_OUT first (or the row
 * is gone) — the caller lost a race, nothing was written. Any other DynamoDB
 * error propagates.
 *
 * The agent runtime polls its task record between turns and exits on CANCELLED
 * (``agent/src/hooks.py``), so this transition alone stops the work; callers
 * holding compute-stop permissions (the REST cancel handler) additionally stop
 * the session for a faster wind-down.
 */
export async function transitionTaskToCancelled(
  tables: CancelTaskTables,
  taskId: string,
  now: string = new Date().toISOString(),
): Promise<'cancelled' | 'already_terminal'> {
  try {
    await tables.ddb.send(new UpdateCommand({
      TableName: tables.taskTableName,
      Key: { task_id: taskId },
      UpdateExpression: 'SET #status = :cancelled, updated_at = :now, completed_at = :now, status_created_at = :sca, #ttl = :ttl',
      ConditionExpression: 'attribute_exists(task_id) AND NOT #status IN (:s1, :s2, :s3, :s4)',
      ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':cancelled': TaskStatus.CANCELLED,
        ':now': now,
        ':sca': `${TaskStatus.CANCELLED}#${now}`,
        ':s1': TaskStatus.COMPLETED,
        ':s2': TaskStatus.FAILED,
        ':s3': TaskStatus.CANCELLED,
        ':s4': TaskStatus.TIMED_OUT,
        ':ttl': computeTtlEpoch(tables.retentionDays),
      },
    }));
    return 'cancelled';
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
      return 'already_terminal';
    }
    throw err;
  }
}

/**
 * Write the ``task_cancelled`` event that drives the fan-out terminal
 * notifications. ``extraMetadata`` lets an entry point tag the event (e.g. a
 * Linear session stop, whose confirmation the caller already posted).
 */
export async function writeTaskCancelledEvent(
  tables: CancelTaskTables,
  taskId: string,
  cancelledBy: string,
  now: string = new Date().toISOString(),
  extraMetadata: Record<string, string> = {},
): Promise<void> {
  await tables.ddb.send(new PutCommand({
    TableName: tables.taskEventsTableName,
    Item: {
      task_id: taskId,
      event_id: ulid(),
      event_type: 'task_cancelled',
      timestamp: now,
      ttl: computeTtlEpoch(tables.retentionDays),
      metadata: { ...extraMetadata, cancelled_by: cancelledBy },
    },
  }));
}
