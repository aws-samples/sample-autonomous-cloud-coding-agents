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
 * Scheduled handler: auto-cancel stale PENDING_UPLOADS tasks.
 *
 * Tasks in PENDING_UPLOADS that have not received a confirm-uploads call
 * within the configured timeout (default 30 minutes) are transitioned to
 * CANCELLED. This prevents abandoned upload sessions from accumulating
 * orphaned S3 objects and cluttering the user's task list.
 *
 * Race safety: Uses conditional DynamoDB writes so this Lambda and a
 * concurrent confirm-uploads call cannot both succeed. If confirm-uploads
 * wins (transitions to SUBMITTED), the conditional write here fails
 * harmlessly. If this Lambda wins, confirm-uploads' conditional write
 * fails and returns the CANCELLED status idempotently.
 *
 * Tests: cdk/test/handlers/cleanup-pending-uploads.test.ts
 */

import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { ulid } from 'ulid';
import { ATTACHMENT_OBJECT_KEY_PREFIX } from '../constructs/attachments-bucket';
import { logger } from './shared/logger';

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});

const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE = process.env.TASK_EVENTS_TABLE_NAME!;
const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET_NAME!;

/** Timeout in seconds before a PENDING_UPLOADS task is auto-cancelled. */
const PENDING_UPLOAD_TIMEOUT_SECONDS = Number(
  process.env.PENDING_UPLOAD_TIMEOUT_SECONDS ?? '1800',
);

const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');

interface ExpiredTask {
  readonly task_id: string;
  readonly user_id: string;
  readonly created_at: string;
  readonly age_seconds: number;
}

/**
 * Query TaskTable's StatusIndex GSI for PENDING_UPLOADS tasks
 * older than the timeout threshold.
 */
async function findExpiredPendingUploads(now: Date): Promise<ExpiredTask[]> {
  const cutoff = new Date(now.getTime() - PENDING_UPLOAD_TIMEOUT_SECONDS * 1000);
  const matches: ExpiredTask[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: TASK_TABLE,
      IndexName: 'StatusIndex',
      KeyConditionExpression: '#s = :status AND created_at < :cutoff',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':status': { S: 'PENDING_UPLOADS' },
        ':cutoff': { S: cutoff.toISOString() },
      },
      ExclusiveStartKey: lastKey as Record<string, never> | undefined,
    }));

    for (const item of resp.Items ?? []) {
      const taskId = item.task_id?.S;
      const userId = item.user_id?.S;
      const createdAt = item.created_at?.S;
      if (!taskId || !userId || !createdAt) continue;

      const createdMs = Date.parse(createdAt);
      const ageSec = Math.floor((now.getTime() - createdMs) / 1000);

      matches.push({
        task_id: taskId,
        user_id: userId,
        created_at: createdAt,
        age_seconds: ageSec,
      });
    }

    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  return matches;
}

/**
 * Transition a PENDING_UPLOADS task to CANCELLED with a conditional write.
 * Returns true if the transition succeeded, false if another caller
 * already transitioned (confirm-uploads won the race).
 */
async function cancelExpiredTask(task: ExpiredTask): Promise<boolean> {
  const now = new Date().toISOString();
  const errorMessage =
    `Upload window expired (${Math.floor(task.age_seconds / 60)} minutes). ` +
    'Please re-submit the task.';

  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TASK_TABLE,
      Key: { task_id: { S: task.task_id } },
      UpdateExpression:
        'SET #s = :cancelled, updated_at = :now, completed_at = :now, '
        + 'error_message = :err, status_created_at = :sca, #ttl = :ttl',
      ConditionExpression: '#s = :expected',
      ExpressionAttributeNames: { '#s': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':cancelled': { S: 'CANCELLED' },
        ':expected': { S: 'PENDING_UPLOADS' },
        ':now': { S: now },
        ':err': { S: errorMessage },
        ':sca': { S: `CANCELLED#${now}` },
        ':ttl': { N: String(Math.floor(Date.now() / 1000) + TASK_RETENTION_DAYS * 86400) },
      },
    }));
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      logger.info('Task already transitioned during pending-upload cleanup (race with confirm-uploads)', {
        task_id: task.task_id,
      });
      return false;
    }
    throw err;
  }

  // Write pending_upload_expired event (best-effort)
  const ttl = Math.floor(Date.now() / 1000) + TASK_RETENTION_DAYS * 86400;
  try {
    await ddb.send(new PutItemCommand({
      TableName: EVENTS_TABLE,
      Item: {
        task_id: { S: task.task_id },
        event_id: { S: ulid() },
        event_type: { S: 'pending_upload_expired' },
        timestamp: { S: now },
        ttl: { N: String(ttl) },
        metadata: {
          M: {
            age_seconds: { N: String(task.age_seconds) },
            timeout_seconds: { N: String(PENDING_UPLOAD_TIMEOUT_SECONDS) },
          },
        },
      },
    }));
  } catch (eventErr) {
    logger.error('Failed to write pending_upload_expired event (best-effort)', {
      task_id: task.task_id,
      error: String(eventErr),
    });
  }

  return true;
}

/**
 * Delete all S3 objects under a task's attachment prefix.
 * Uses prefix listing to catch any objects (including oversized abuse
 * uploads that were never confirmed).
 */
async function cleanupTaskAttachments(task: ExpiredTask): Promise<void> {
  const prefix = `${ATTACHMENT_OBJECT_KEY_PREFIX}${task.user_id}/${task.task_id}/`;

  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  let totalDeleted = 0;
  let isTruncated = true;

  while (isTruncated) {
    const listResp = await s3.send(new ListObjectVersionsCommand({
      Bucket: ATTACHMENTS_BUCKET,
      Prefix: prefix,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
    }));

    isTruncated = listResp.IsTruncated ?? false;
    keyMarker = listResp.NextKeyMarker;
    versionIdMarker = listResp.NextVersionIdMarker;

    // Collect all versions and delete markers for deletion
    const objects = [
      ...(listResp.Versions ?? []).map(v => ({ Key: v.Key!, VersionId: v.VersionId })),
      ...(listResp.DeleteMarkers ?? []).map(d => ({ Key: d.Key!, VersionId: d.VersionId })),
    ].filter(obj => obj.Key !== undefined);

    if (objects.length === 0) continue;

    const deleteResp = await s3.send(new DeleteObjectsCommand({
      Bucket: ATTACHMENTS_BUCKET,
      Delete: { Objects: objects.map(({ Key, VersionId }) => ({ Key, VersionId })) },
    }));

    if (deleteResp.Errors && deleteResp.Errors.length > 0) {
      logger.error('Partial S3 cleanup failure for expired pending-upload task', {
        task_id: task.task_id,
        failedKeys: deleteResp.Errors.map(e => e.Key),
      });
    }

    totalDeleted += objects.length - (deleteResp.Errors?.length ?? 0);
  }

  if (totalDeleted > 0) {
    logger.info('Cleaned up S3 objects for expired pending-upload task', {
      task_id: task.task_id,
      objects_deleted: totalDeleted,
    });
  }
}

/**
 * EventBridge scheduled handler entry point.
 */
export async function handler(): Promise<void> {
  const now = new Date();

  const expired = await findExpiredPendingUploads(now);

  if (expired.length === 0) {
    logger.info('No expired PENDING_UPLOADS tasks found');
    return;
  }

  logger.info('Found expired PENDING_UPLOADS tasks', { count: expired.length });

  let cancelled = 0;
  let raced = 0;
  let errored = 0;

  for (const task of expired) {
    try {
      const transitioned = await cancelExpiredTask(task);
      if (transitioned) {
        cancelled++;
        await cleanupTaskAttachments(task);
      } else {
        raced++;
      }
    } catch (err) {
      errored++;
      logger.error('Failed to process expired PENDING_UPLOADS task — continuing with remaining tasks', {
        task_id: task.task_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Pending-upload cleanup complete', {
    expired: expired.length,
    cancelled,
    raced,
    errored,
    metric_type: errored > 0 ? 'pending_upload_cleanup_errors' : undefined,
  });

  // If ALL tasks errored and none were cancelled, throw so EventBridge sees
  // a Lambda failure and CloudWatch alarms fire. Partial success (some cancelled,
  // some errored) is acceptable — the next scheduled run will retry the failed ones.
  if (errored > 0 && cancelled === 0 && raced === 0) {
    throw new Error(
      `All ${errored} expired PENDING_UPLOADS task(s) failed to process. ` +
      'Investigate DynamoDB/S3 connectivity — abandoned tasks will not auto-cancel until resolved.',
    );
  }
}
