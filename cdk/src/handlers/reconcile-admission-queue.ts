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

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { ulid } from 'ulid';
import { logger } from './shared/logger';
import { makeClient } from './shared/ua';

const ddb = makeClient(DynamoDBClient);
const lambdaClient = makeClient(LambdaClient);

const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE = process.env.TASK_EVENTS_TABLE_NAME!;
const CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME!;
const ORCHESTRATOR_FUNCTION_ARN = process.env.ORCHESTRATOR_FUNCTION_ARN!;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');

const QUEUE_MAX_AGE_SECONDS = Number(process.env.QUEUE_MAX_AGE_SECONDS ?? '86400');

interface QueuedTask {
  readonly task_id: string;
  readonly user_id: string;
  readonly created_at: string;
  readonly age_seconds: number;
  readonly admission_attempts: number;
}

export interface PickupSummary {
  queued_seen: number;
  picked_up: number;
  expired: number;
  skipped_no_capacity: number;
  skipped_race: number;
  /** Orchestrator re-invoke failures after a successful QUEUED -> SUBMITTED flip. */
  invoke_failed: number;
  errors: number;
}

type PickupOutcome = 'picked_up' | 'race' | 'invoke_failed';

async function listQueuedTasks(now: Date): Promise<QueuedTask[]> {
  const tasks: QueuedTask[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: TASK_TABLE,
      IndexName: 'StatusIndex',
      KeyConditionExpression: '#s = :queued',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':queued': { S: 'QUEUED' } },
      // ScanIndexForward defaults to true — ascending created_at, i.e. FIFO.
      ExclusiveStartKey: lastKey as Record<string, never> | undefined,
    }));

    for (const item of resp.Items ?? []) {
      const taskId = item.task_id?.S;
      const userId = item.user_id?.S;
      const createdAt = item.created_at?.S;
      if (!taskId || !userId || !createdAt) continue;
      const createdMs = Date.parse(createdAt);
      tasks.push({
        task_id: taskId,
        user_id: userId,
        created_at: createdAt,
        age_seconds: Number.isNaN(createdMs) ? 0 : Math.floor((now.getTime() - createdMs) / 1000),
        admission_attempts: Number(item.admission_attempts?.N ?? '0'),
      });
    }

    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  return tasks;
}

async function readActiveCount(userId: string): Promise<number> {
  const resp = await ddb.send(new GetItemCommand({
    TableName: CONCURRENCY_TABLE,
    Key: { user_id: { S: userId } },
    ProjectionExpression: 'active_count',
  }));
  return Number(resp.Item?.active_count?.N ?? '0');
}

async function emitEvent(taskId: string, eventType: string, metadata: Record<string, { S: string } | { N: string }>): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + TASK_RETENTION_DAYS * 24 * 3600;
  try {
    await ddb.send(new PutItemCommand({
      TableName: EVENTS_TABLE,
      Item: {
        task_id: { S: taskId },
        event_id: { S: ulid() },
        event_type: { S: eventType },
        timestamp: { S: new Date().toISOString() },
        ttl: { N: String(ttl) },
        metadata: { M: metadata },
      },
    }));
  } catch (err) {
    logger.warn(`Failed to write ${eventType} event (best-effort)`, {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function requeueAfterInvokeFailure(taskId: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TASK_TABLE,
      Key: { task_id: { S: taskId } },
      UpdateExpression: 'SET #s = :queued, updated_at = :now, status_created_at = :sca',
      ConditionExpression: '#s = :submitted',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':queued': { S: 'QUEUED' },
        ':submitted': { S: 'SUBMITTED' },
        ':now': { S: now },
        ':sca': { S: `QUEUED#${now}` },
      },
    }));
  } catch (err: unknown) {
    if (!(err && typeof err === 'object' && 'name' in err && err.name === 'ConditionalCheckFailedException')) {
      logger.warn('Failed to re-queue task after invoke failure — leaving for stranded-task reconciler', {
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function pickUpTask(task: QueuedTask): Promise<PickupOutcome> {
  const now = new Date().toISOString();
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TASK_TABLE,
      Key: { task_id: { S: task.task_id } },
      UpdateExpression: 'SET #s = :submitted, updated_at = :now, status_created_at = :sca',
      ConditionExpression: '#s = :queued',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':submitted': { S: 'SUBMITTED' },
        ':queued': { S: 'QUEUED' },
        ':now': { S: now },
        ':sca': { S: `SUBMITTED#${now}` },
      },
    }));
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'name' in err && err.name === 'ConditionalCheckFailedException') {
      logger.info('Queued task transitioned concurrently before pickup — skipping', { task_id: task.task_id });
      return 'race';
    }
    throw err;
  }

  await emitEvent(task.task_id, 'queue_pickup', {
    queued_for_s: { N: String(task.age_seconds) },
    admission_attempts: { N: String(task.admission_attempts) },
  });

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: ORCHESTRATOR_FUNCTION_ARN,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify({
        task_id: task.task_id,
        queue_pickup_id: ulid(),
      })),
    }));
  } catch (invokeErr) {
    logger.error('Orchestrator re-invoke failed after queue pickup — re-queuing for next cycle', {
      task_id: task.task_id,
      error: invokeErr instanceof Error ? invokeErr.message : String(invokeErr),
    });
    await requeueAfterInvokeFailure(task.task_id);
    return 'invoke_failed';
  }

  logger.info('Queued task picked up', {
    task_id: task.task_id,
    user_id: task.user_id,
    queued_for_s: task.age_seconds,
  });
  return 'picked_up';
}

async function expireQueuedTask(task: QueuedTask): Promise<boolean> {
  const now = new Date().toISOString();
  const errorMessage =
    `Admission queue timeout: task waited ${task.age_seconds}s for a free `
    + 'concurrency slot (limit per user) without being admitted. This usually '
    + 'means long-running tasks are holding all slots — cancel one or wait, '
    + 'then resubmit.';
  const ttl = Math.floor(Date.now() / 1000) + TASK_RETENTION_DAYS * 24 * 3600;
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TASK_TABLE,
      Key: { task_id: { S: task.task_id } },
      UpdateExpression:
        'SET #s = :failed, updated_at = :now, completed_at = :now, '
        + 'error_message = :err, status_created_at = :sca, #ttl = :ttl',
      ConditionExpression: '#s = :queued',
      ExpressionAttributeNames: { '#s': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':failed': { S: 'FAILED' },
        ':queued': { S: 'QUEUED' },
        ':now': { S: now },
        ':err': { S: errorMessage },
        ':sca': { S: `FAILED#${now}` },
        ':ttl': { N: String(ttl) },
      },
    }));
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'name' in err && err.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw err;
  }
  await emitEvent(task.task_id, 'task_failed', {
    error_message: { S: errorMessage },
    reason: { S: 'queue_timeout' },
  });
  logger.warn('Queued task expired by backstop', {
    task_id: task.task_id,
    user_id: task.user_id,
    age_seconds: task.age_seconds,
  });
  return true;
}

export async function handler(): Promise<PickupSummary> {
  const now = new Date();
  const summary: PickupSummary = {
    queued_seen: 0,
    picked_up: 0,
    expired: 0,
    skipped_no_capacity: 0,
    skipped_race: 0,
    invoke_failed: 0,
    errors: 0,
  };

  let queued: QueuedTask[];
  try {
    queued = await listQueuedTasks(now);
  } catch (err) {
    logger.error('Admission-queue query failed — aborting cycle', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  summary.queued_seen = queued.length;
  if (queued.length === 0) {
    return summary;
  }

  const byUser = new Map<string, QueuedTask[]>();
  for (const task of queued) {
    const list = byUser.get(task.user_id);
    if (list) {
      list.push(task);
    } else {
      byUser.set(task.user_id, [task]);
    }
  }

  for (const [userId, userTasks] of byUser) {
    const live: QueuedTask[] = [];
    for (const task of userTasks) {
      if (task.age_seconds > QUEUE_MAX_AGE_SECONDS) {
        try {
          if (await expireQueuedTask(task)) {
            summary.expired++;
          } else {
            summary.skipped_race++;
          }
        } catch (err) {
          summary.errors++;
          logger.warn('Failed to expire over-age queued task, continuing', {
            task_id: task.task_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        live.push(task);
      }
    }
    if (live.length === 0) continue;

    let available: number;
    try {
      available = MAX_CONCURRENT - await readActiveCount(userId);
    } catch (err) {
      summary.errors++;
      logger.warn('Failed to read concurrency for user — skipping their queue this cycle', {
        user_id: userId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (available <= 0) {
      summary.skipped_no_capacity += live.length;
      continue;
    }

    for (const task of live.slice(0, available)) {
      try {
        switch (await pickUpTask(task)) {
          case 'picked_up':
            summary.picked_up++;
            break;
          case 'invoke_failed':
            summary.invoke_failed++;
            break;
          case 'race':
            summary.skipped_race++;
            break;
        }
      } catch (err) {
        summary.errors++;
        logger.warn('Per-task queue pickup failed, continuing', {
          task_id: task.task_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    summary.skipped_no_capacity += Math.max(0, live.length - available);
  }

  const failed = summary.errors + summary.invoke_failed;
  const level = failed > 0 && summary.picked_up === 0 && summary.queued_seen > 0 ? 'error' : 'info';
  logger[level]('Admission-queue pickup finished', { ...summary });
  return summary;
}
