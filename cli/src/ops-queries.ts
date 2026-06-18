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

import { AttributeValue, DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand as DocQueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

/** Align with ``reconcile-stranded-tasks.ts`` defaults. */
export const DEFAULT_STRANDED_TIMEOUT_SECONDS = 1200;
export const DEFAULT_APPROVAL_STRANDED_TIMEOUT_SECONDS = 7200;
export const DEFAULT_MAX_CONCURRENT_TASKS_PER_USER = 3;

export type StuckTaskStatus = 'SUBMITTED' | 'HYDRATING' | 'AWAITING_APPROVAL';

export interface StuckTaskRow {
  readonly task_id: string;
  readonly user_id: string;
  readonly status: StuckTaskStatus;
  readonly repo?: string;
  readonly created_at: string;
  readonly age_seconds: number;
  readonly threshold_seconds: number;
}

export interface ConcurrencyRow {
  readonly user_id: string;
  readonly stored_count: number;
  /** Null when the live count could not be read (see `error`). */
  readonly actual_count: number | null;
  readonly limit: number;
  /** Null when `actual_count` is unavailable, so drift can't be computed. */
  readonly drift: number | null;
  /** Set when the per-user TaskTable query failed; the row is still reported. */
  readonly error?: string;
}

function documentClient(region: string): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
}

function lowLevelClient(region: string): DynamoDBClient {
  return new DynamoDBClient({ region });
}

function isoCutoff(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

function ageSeconds(createdAt: string): number {
  return Math.floor((Date.now() - Date.parse(createdAt)) / 1000);
}

async function queryStuckByStatus(
  region: string,
  tableName: string,
  status: StuckTaskStatus,
  thresholdSeconds: number,
): Promise<StuckTaskRow[]> {
  const ddb = lowLevelClient(region);
  const cutoff = isoCutoff(thresholdSeconds);
  const rows: StuckTaskRow[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'StatusIndex',
      KeyConditionExpression: '#status = :status AND created_at < :cutoff',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': { S: status },
        ':cutoff': { S: cutoff },
      },
      ExclusiveStartKey: lastKey,
    }));

    for (const item of result.Items ?? []) {
      const taskId = item.task_id?.S;
      const userId = item.user_id?.S;
      const createdAt = item.created_at?.S;
      if (!taskId || !userId || !createdAt) continue;
      rows.push({
        task_id: taskId,
        user_id: userId,
        status,
        repo: item.repo?.S,
        created_at: createdAt,
        age_seconds: ageSeconds(createdAt),
        threshold_seconds: thresholdSeconds,
      });
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return rows;
}

/** Find tasks stuck beyond orchestrator reconciler thresholds. */
export async function findStuckTasks(
  region: string,
  taskTableName: string,
  options: {
    readonly strandedTimeoutSeconds?: number;
    readonly approvalTimeoutSeconds?: number;
  } = {},
): Promise<StuckTaskRow[]> {
  const strandedTimeout = options.strandedTimeoutSeconds ?? DEFAULT_STRANDED_TIMEOUT_SECONDS;
  const approvalTimeout = options.approvalTimeoutSeconds ?? DEFAULT_APPROVAL_STRANDED_TIMEOUT_SECONDS;

  const [submitted, hydrating, awaiting] = await Promise.all([
    queryStuckByStatus(region, taskTableName, 'SUBMITTED', strandedTimeout),
    queryStuckByStatus(region, taskTableName, 'HYDRATING', strandedTimeout),
    queryStuckByStatus(region, taskTableName, 'AWAITING_APPROVAL', approvalTimeout),
  ]);

  return [...submitted, ...hydrating, ...awaiting]
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Count active tasks for a user (matches concurrency reconciler statuses). */
export async function countActiveTasksForUser(
  region: string,
  taskTableName: string,
  userId: string,
): Promise<number> {
  const ddb = documentClient(region);
  let count = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(new DocQueryCommand({
      TableName: taskTableName,
      IndexName: 'UserStatusIndex',
      KeyConditionExpression: 'user_id = :uid',
      FilterExpression: '#s IN (:s1, :s2, :s3, :s4, :s5)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':uid': userId,
        ':s1': 'SUBMITTED',
        ':s2': 'HYDRATING',
        ':s3': 'RUNNING',
        ':s4': 'FINALIZING',
        ':s5': 'AWAITING_APPROVAL',
      },
      ExclusiveStartKey: lastKey,
    }));
    count += result.Items?.length ?? 0;
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return count;
}

/** Compare UserConcurrencyTable counters with live TaskTable counts. */
export async function buildConcurrencyReport(
  region: string,
  taskTableName: string,
  concurrencyTableName: string,
  limitPerUser: number,
): Promise<ConcurrencyRow[]> {
  const ddb = documentClient(region);
  const rows: ConcurrencyRow[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const scan = await ddb.send(new ScanCommand({
      TableName: concurrencyTableName,
      ExclusiveStartKey: lastKey,
    }));

    for (const item of scan.Items ?? []) {
      const userId = item.user_id as string | undefined;
      if (!userId) continue;
      const storedCount = Number(item.active_count ?? 0);
      try {
        const actualCount = await countActiveTasksForUser(region, taskTableName, userId);
        rows.push({
          user_id: userId,
          stored_count: storedCount,
          actual_count: actualCount,
          limit: limitPerUser,
          drift: storedCount - actualCount,
        });
      } catch (err) {
        // One user's failed live count must not blank the whole operational
        // view — report the row with the error so the operator still sees it.
        rows.push({
          user_id: userId,
          stored_count: storedCount,
          actual_count: null,
          limit: limitPerUser,
          drift: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    lastKey = scan.LastEvaluatedKey;
  } while (lastKey);

  return rows.sort((a, b) => a.user_id.localeCompare(b.user_id));
}
