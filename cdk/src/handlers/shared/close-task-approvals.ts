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

import { GetCommand, QueryCommand, UpdateCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { SessionControlOptions } from './compute-strategy';
import { makeDocClient } from './ua';
import { TERMINAL_STATUSES } from '../../constructs/task-status';

const ddb = makeDocClient();
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
  const ttl = Math.floor(Date.now() / 1000) + Number(process.env.TASK_RETENTION_DAYS ?? '90') * 86400;
  do {
    const page: QueryCommandOutput = await ddb.send(new QueryCommand({
      TableName: process.env.TASK_APPROVALS_TABLE_NAME,
      ConsistentRead: true,
      KeyConditionExpression: 'task_id = :task',
      FilterExpression: 'attribute_not_exists(#ttl) OR #status = :pending',
      ExpressionAttributeNames: { '#ttl': 'ttl', '#status': 'status' },
      ExpressionAttributeValues: { ':task': taskId, ':pending': 'PENDING' },
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
                ':cancelled': 'CANCELLED',
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
            ExpressionAttributeValues: { ':ttl': ttl, ':user': userId, ':pending': 'PENDING' },
          }), options).catch(race => {
            if ((race as { name?: string }).name !== 'ConditionalCheckFailedException') throw race;
          });
        }
      }));
    }
    key = page.LastEvaluatedKey;
  } while (key);
}
