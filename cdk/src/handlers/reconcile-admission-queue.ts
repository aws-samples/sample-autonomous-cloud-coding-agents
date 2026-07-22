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

/**
 * Scheduled handler: admission-queue deferred pickup (#441).
 *
 * Tasks that hit the per-user concurrency cap are parked in QUEUED by the
 * orchestrator instead of being FAILED (see `queueTask` in
 * `shared/orchestrator.ts`). This handler drains that queue: every cycle it
 * queries QUEUED tasks in FIFO order (StatusIndex GSI, sorted by
 * ``created_at``), and for each user with free capacity flips the oldest
 * QUEUED tasks back to SUBMITTED and re-invokes the orchestrator.
 *
 * Division of authority — this handler does a READ-ONLY capacity check
 * against the concurrency table; the orchestrator's `admissionControl`
 * (atomic conditional increment) remains the single writer of the
 * concurrency counter. A pickup that loses the admission race (another
 * task admitted between our read and the orchestrator's increment) is
 * harmless: the orchestrator re-queues the task (SUBMITTED -> QUEUED),
 * `created_at` never changes, so FIFO position is preserved for the next
 * cycle. This at-most-bounces-once-per-cycle design avoids a second
 * writer on the counter (the #331 class of drift bugs).
 *
 * Cancel semantics: the QUEUED -> SUBMITTED flip is conditional on the
 * task still being QUEUED, so a user cancel between the query and the
 * flip cleanly wins and the task is skipped.
 *
 * Backstop: a task QUEUED longer than ``QUEUE_MAX_AGE_SECONDS`` is failed
 * (QUEUED -> FAILED) with an explanatory message so the queue can never
 * accumulate unbounded zombies (e.g. a user's slots wedged by a
 * counter-drift bug that the concurrency reconciler hasn't corrected yet).
 * No concurrency slot is released — QUEUED tasks never held one.
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

const ddb = new DynamoDBClient({});
const lambdaClient = new LambdaClient({});

const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE = process.env.TASK_EVENTS_TABLE_NAME!;
const CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME!;
const ORCHESTRATOR_FUNCTION_ARN = process.env.ORCHESTRATOR_FUNCTION_ARN!;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');

/**
 * Maximum time a task may sit QUEUED before the backstop fails it.
 * Default 24h — far above any legitimate queue wait (tasks run minutes
 * to a few hours), so tripping it indicates wedged capacity, not load.
 */
const QUEUE_MAX_AGE_SECONDS = Number(process.env.QUEUE_MAX_AGE_SECONDS ?? '86400');

interface QueuedTask {
  readonly task_id: string;
  readonly user_id: string;
  readonly created_at: string;
  readonly age_seconds: number;
  readonly admission_attempts: number;
}

/** Result counters for the final log line / test assertions. */
export interface PickupSummary {
  queued_seen: number;
  picked_up: number;
  expired: number;
  skipped_no_capacity: number;
  skipped_race: number;
  errors: number;
}

/**
 * Query ALL QUEUED tasks in global FIFO order (StatusIndex GSI: PK
 * ``status``, SK ``created_at`` — ascending scan gives oldest-first).
 */
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

/** Read a user's current active_count (0 when the row does not exist). */
async function readActiveCount(userId: string): Promise<number> {
  const resp = await ddb.send(new GetItemCommand({
    TableName: CONCURRENCY_TABLE,
    Key: { user_id: { S: userId } },
    ProjectionExpression: 'active_count',
  }));
  return Number(resp.Item?.active_count?.N ?? '0');
}

/** Best-effort TaskEvents write — event loss is acceptable, the task record is the source of truth. */
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

/**
 * Flip one task QUEUED -> SUBMITTED and re-invoke the orchestrator.
 * Returns false when the conditional flip lost to a concurrent
 * transition (user cancel / another pickup instance).
 */
async function pickUpTask(task: QueuedTask): Promise<boolean> {
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
      return false;
    }
    throw err;
  }

  await emitEvent(task.task_id, 'queue_pickup', {
    queued_for_s: { N: String(task.age_seconds) },
    admission_attempts: { N: String(task.admission_attempts) },
  });

  // Async re-invoke. The payload carries a per-pickup nonce so no layer
  // (Lambda async dedup, durable-execution idempotency) can mistake the
  // re-invoke for a replay of the original create-task invocation.
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
    // The task is now SUBMITTED with no pipeline attached. Do NOT try to
    // roll back (racy) — the stranded-task reconciler sweeps SUBMITTED
    // tasks with no pipeline, which is exactly this failure mode.
    logger.error('Orchestrator re-invoke failed after queue pickup — stranded-task reconciler will sweep', {
      task_id: task.task_id,
      error: invokeErr instanceof Error ? invokeErr.message : String(invokeErr),
    });
    return false;
  }

  logger.info('Queued task picked up', {
    task_id: task.task_id,
    user_id: task.user_id,
    queued_for_s: task.age_seconds,
  });
  return true;
}

/**
 * Backstop: fail a task that has been QUEUED past the max age. No
 * concurrency release — QUEUED tasks never hold a slot.
 */
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

  // Group per user, preserving the global FIFO order within each group.
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
    // Expire over-age tasks first so they never block capacity math.
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

    // Oldest-first pickup, bounded by free capacity. The orchestrator's
    // atomic admissionControl is still the final arbiter — an optimistic
    // over-pick simply re-queues.
    for (const task of live.slice(0, available)) {
      try {
        if (await pickUpTask(task)) {
          summary.picked_up++;
        } else {
          summary.skipped_race++;
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

  const level = summary.errors > 0 && summary.picked_up === 0 && summary.queued_seen > 0 ? 'error' : 'info';
  logger[level]('Admission-queue pickup finished', { ...summary });
  return summary;
}
