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

import { DynamoDBClient, ScanCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { logger } from './shared/logger';

const ddb = new DynamoDBClient({});
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME!;

/**
 * Count actual active tasks for a user by querying the UserStatusIndex GSI.
 */
async function countActiveTasks(userId: string): Promise<number> {
  let count = 0;
  let lastKey: Record<string, any> | undefined;

  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: TASK_TABLE,
      IndexName: 'UserStatusIndex',
      KeyConditionExpression: 'user_id = :uid',
      FilterExpression: '#s IN (:s1, :s2, :s3, :s4)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':uid': { S: userId },
        ':s1': { S: 'SUBMITTED' },
        ':s2': { S: 'HYDRATING' },
        ':s3': { S: 'RUNNING' },
        ':s4': { S: 'FINALIZING' },
      },
      Select: 'COUNT',
      ExclusiveStartKey: lastKey,
    }));
    count += resp.Count ?? 0;
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  return count;
}

/**
 * Scheduled handler: scan the concurrency table and reconcile each user's
 * active_count against actual active tasks in the task table.
 */
export async function handler(): Promise<void> {
  logger.info('Concurrency reconciler started');
  let corrected = 0;
  let scanned = 0;
  let errors = 0;
  let lastKey: Record<string, any> | undefined;

  do {
    const scanResp = await ddb.send(new ScanCommand({
      TableName: CONCURRENCY_TABLE,
      ExclusiveStartKey: lastKey,
    }));

    for (const rawItem of scanResp.Items ?? []) {
      const userId = rawItem.user_id?.S;
      const storedCount = Number(rawItem.active_count?.N ?? '0');
      if (!userId) continue;
      scanned++;

      try {
        const actualCount = await countActiveTasks(userId);

        if (storedCount !== actualCount) {
          logger.info('Drift detected', { userId, storedCount, actualCount });
          try {
            await ddb.send(new UpdateItemCommand({
              TableName: CONCURRENCY_TABLE,
              Key: { user_id: { S: userId } },
              UpdateExpression: 'SET active_count = :count, updated_at = :now',
              ConditionExpression: 'active_count = :stored',
              ExpressionAttributeValues: {
                ':count': { N: String(actualCount) },
                ':now': { S: new Date().toISOString() },
                ':stored': { N: String(storedCount) },
              },
            }));
            corrected++;
          } catch (updateErr: unknown) {
            if (updateErr && typeof updateErr === 'object' && 'name' in updateErr && updateErr.name === 'ConditionalCheckFailedException') {
              logger.info('Concurrent update detected, skipping', { userId });
            } else {
              throw updateErr;
            }
          }
        }
      } catch (err: unknown) {
        errors++;
        logger.warn('Per-user reconciliation failed, continuing', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    lastKey = scanResp.LastEvaluatedKey;
  } while (lastKey);

  if (errors === scanned && scanned > 0) {
    logger.error('All users failed reconciliation — possible systemic issue', { scanned, errors });
  }
  logger.info('Concurrency reconciler finished', { scanned, corrected, errors });
}
