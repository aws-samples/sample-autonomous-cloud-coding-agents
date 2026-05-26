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

// POST /v1/tasks/{task_id}/confirm-uploads — confirms presigned uploads, screens
// attachments, and transitions the task from PENDING_UPLOADS to SUBMITTED.
// Tests: cdk/test/handlers/confirm-uploads.test.ts

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ulid } from 'ulid';
import { ATTACHMENT_OBJECT_KEY_PREFIX } from '../constructs/attachments-bucket';
import { TaskStatus } from '../constructs/task-status';
import { screenImage, screenTextFile, AttachmentScreeningError, type ScreeningConfig } from './shared/attachment-screening';
import { extractUserId } from './shared/gateway';
import { estimateImageTokensFromBuffer } from './shared/image-tokens';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { type AttachmentRecord, createAttachmentRecord, type TaskRecord, toTaskDetail } from './shared/types';
import { computeTtlEpoch } from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3Client = new S3Client({});
const lambdaClient = process.env.ORCHESTRATOR_FUNCTION_ARN ? new LambdaClient({}) : undefined;

const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;
const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET_NAME!;
const CONCURRENCY_TABLE_NAME = process.env.USER_CONCURRENCY_TABLE_NAME!;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '3');
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');

if (!TABLE_NAME || !EVENTS_TABLE_NAME || !ATTACHMENTS_BUCKET || !CONCURRENCY_TABLE_NAME) {
  throw new Error(
    'confirm-uploads handler requires TASK_TABLE_NAME, TASK_EVENTS_TABLE_NAME, ATTACHMENTS_BUCKET_NAME, and USER_CONCURRENCY_TABLE_NAME env vars',
  );
}

const SCREENING_CONCURRENCY = 3;
const HEAD_OBJECT_RETRIES = 3;
const HEAD_OBJECT_RETRY_DELAY_MS = 1000;
/** Safety margin before Lambda timeout: abort screening loop at this threshold. */
const DEADLINE_MARGIN_MS = 15_000;

/** Transient metadata from HeadObject, keyed by attachment_id. */
interface S3ObjectMeta {
  readonly s3Key: string;
  readonly versionId?: string;
  readonly sizeBytes: number;
}

/**
 * POST /v1/tasks/{task_id}/confirm-uploads
 *
 * Flow:
 *   1. Auth — verify caller owns the task.
 *   2. Short-circuit — if task is not PENDING_UPLOADS, return current state (idempotent).
 *   3. HeadObject per attachment — verify uploads exist in S3 (with retry for eventual consistency).
 *   4. Screen each attachment in parallel (bounded concurrency of 3).
 *   5. On all pass: conditional DDB write (status → SUBMITTED), invoke orchestrator.
 *   6. On any block: conditional DDB write (status → FAILED), cleanup S3.
 */
export async function handler(event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    // 1. Auth
    const callerUserId = extractUserId(event);
    if (!callerUserId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    // 2. Path parameter
    const taskId = event.pathParameters?.task_id;
    if (!taskId) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing task_id path parameter.', requestId);
    }

    // 3. Read task record
    const taskResult = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
    }));

    if (!taskResult.Item) {
      return errorResponse(404, ErrorCode.TASK_NOT_FOUND, 'Task not found.', requestId);
    }

    const task = taskResult.Item as TaskRecord;

    // Ownership check
    if (task.user_id !== callerUserId) {
      return errorResponse(404, ErrorCode.TASK_NOT_FOUND, 'Task not found.', requestId);
    }

    // 4. Short-circuit: if not PENDING_UPLOADS, return current state (idempotent)
    if (task.status !== TaskStatus.PENDING_UPLOADS) {
      if (task.status === TaskStatus.SUBMITTED || task.status === TaskStatus.HYDRATING ||
          task.status === TaskStatus.RUNNING) {
        return successResponse(200, toTaskDetail(task), requestId);
      }
      return errorResponse(409, ErrorCode.UPLOADS_NOT_PENDING,
        `Task is in status '${task.status}' and cannot accept upload confirmations.`, requestId);
    }

    // 5. Validate attachments exist
    const attachments = task.attachments;
    if (!attachments || attachments.length === 0) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR,
        'Task has no attachments to confirm.', requestId);
    }

    const pendingAttachments = attachments.filter(a => a.screening.status === 'pending');
    if (pendingAttachments.length === 0) {
      // All already screened — transition (handles retry case)
      return await transitionToSubmitted(task, attachments, requestId);
    }

    // 6. HeadObject per pending attachment — verify uploads exist
    const s3Meta = new Map<string, S3ObjectMeta>();
    for (const att of pendingAttachments) {
      const s3Key = `${ATTACHMENT_OBJECT_KEY_PREFIX}${task.user_id}/${taskId}/${att.attachment_id}/${att.filename}`;
      const headResult = await headObjectWithRetry(s3Key);
      if (!headResult.exists) {
        return errorResponse(400, ErrorCode.ATTACHMENT_UPLOAD_MISSING,
          `Upload for '${att.filename}' not found. Ensure the upload completed successfully before calling confirm-uploads.`,
          requestId);
      }
      s3Meta.set(att.attachment_id, {
        s3Key,
        versionId: headResult.versionId,
        sizeBytes: headResult.contentLength!,
      });
    }

    // 6b. Pre-check concurrency before expensive screening (fail-fast).
    // The actual atomic increment happens in transitionToSubmitted after screening
    // passes. This read-only check avoids wasting Bedrock calls when the user is
    // already at their concurrency limit.
    const preCheckAdmitted = await preCheckConcurrency(task.user_id);
    if (!preCheckAdmitted) {
      return errorResponse(429, ErrorCode.RATE_LIMIT_EXCEEDED,
        'User concurrency limit reached. Wait for a running task to finish or cancel one, then retry.', requestId);
    }

    // 7. Screen attachments in parallel with bounded concurrency
    const screeningConfig = await buildScreeningConfig();
    if (!screeningConfig) {
      return errorResponse(503, ErrorCode.ATTACHMENT_SCREENING_UNAVAILABLE,
        'Attachment content screening is not configured. Please contact your administrator.', requestId);
    }

    const screenedAttachments: AttachmentRecord[] = [];

    // Process in batches of SCREENING_CONCURRENCY.
    // Deadline check: abort screening before the Lambda times out so we can
    // return a graceful 503 + Retry-After instead of an opaque timeout error.
    // On retry, already-screened attachments (status === 'passed' in DDB) are
    // skipped, so retries make forward progress.
    for (let i = 0; i < pendingAttachments.length; i += SCREENING_CONCURRENCY) {
      // Deadline check before starting a new batch
      if (context.getRemainingTimeInMillis() <= DEADLINE_MARGIN_MS) {
        const screened = screenedAttachments.length;
        const remaining = pendingAttachments.length - screened;
        logger.warn('Confirm-uploads deadline reached — aborting remaining screening', {
          task_id: taskId,
          screened,
          remaining,
          remaining_ms: context.getRemainingTimeInMillis(),
          request_id: requestId,
          metric_type: 'confirm_uploads_deadline_exceeded',
        });

        // Persist any already-screened results so retries skip them
        if (screenedAttachments.length > 0) {
          await persistPartialScreeningState(task, taskId, screenedAttachments, requestId);
        }

        return {
          statusCode: 503,
          headers: { 'Retry-After': '30', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: {
              code: ErrorCode.SCREENING_DEADLINE_EXCEEDED,
              message:
                'Attachment screening did not complete within the time limit. ' +
                'Reduce the number or size of attachments and try again, or retry after 30 seconds ' +
                '(already-screened attachments will be skipped on retry).',
              request_id: requestId,
            },
          }),
        };
      }

      const batch = pendingAttachments.slice(i, i + SCREENING_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(att => screenSingleAttachment(att, task, screeningConfig, taskId, s3Meta.get(att.attachment_id)!)),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const att = batch[j];

        if (result.status === 'rejected') {
          const err = result.reason;
          if (err instanceof AttachmentScreeningError) {
            logger.warn('Attachment screening rejected content during confirm-uploads', {
              attachment_id: att.attachment_id,
              filename: att.filename,
              error: err.message,
              task_id: taskId,
              request_id: requestId,
            });
            // Fail the entire task
            const transitioned = await failTaskOnScreening(task, taskId, att.filename, err.message, requestId);
            if (transitioned) {
              await cleanupAllAttachments(task, taskId);
            }
            return errorResponse(400, ErrorCode.ATTACHMENT_BLOCKED,
              `Attachment '${att.filename}' was rejected: ${err.message}`, requestId);
          }

          // Non-screening error — fail-closed
          logger.error('Attachment screening failed during confirm-uploads (fail-closed)', {
            attachment_id: att.attachment_id,
            filename: att.filename,
            error: err instanceof Error ? err.message : String(err),
            task_id: taskId,
            request_id: requestId,
            metric_type: 'confirm_uploads_screening_failure',
          });
          return errorResponse(503, ErrorCode.ATTACHMENT_SCREENING_UNAVAILABLE,
            'Attachment content screening is temporarily unavailable. Please try again later.', requestId);
        }

        // Screening passed — record the result
        screenedAttachments.push(result.value);
      }
    }

    // If any attachment was blocked via the result (not error), handle that
    const blockedAtt = screenedAttachments.find(a => a.screening.status === 'blocked');
    if (blockedAtt) {
      const categories = blockedAtt.screening.status === 'blocked'
        ? blockedAtt.screening.categories.join(', ')
        : 'content_policy_violation';
      const transitioned = await failTaskOnScreening(task, taskId, blockedAtt.filename, categories, requestId);
      if (transitioned) {
        await cleanupAllAttachments(task, taskId);
      }
      return errorResponse(400, ErrorCode.ATTACHMENT_BLOCKED,
        `Attachment '${blockedAtt.filename}' was blocked by content policy (${categories}).`, requestId);
    }

    // 8. All passed — merge screened records with any already-screened ones
    const finalAttachments = attachments.map(existing => {
      const screened = screenedAttachments.find(s => s.attachment_id === existing.attachment_id);
      return screened ?? existing;
    });

    // 9. Transition to SUBMITTED
    return await transitionToSubmitted(task, finalAttachments, requestId);
  } catch (err) {
    logger.error('Unhandled error in confirm-uploads', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR,
      'An unexpected error occurred. Please try again.', requestId);
  }
}

// ---------------------------------------------------------------------------
// Screen a single attachment: download from S3, screen, re-upload cleaned version
// ---------------------------------------------------------------------------

async function screenSingleAttachment(
  att: AttachmentRecord,
  task: TaskRecord,
  screeningConfig: ScreeningConfig,
  taskId: string,
  meta: S3ObjectMeta,
): Promise<AttachmentRecord> {
  const { s3Key, versionId, sizeBytes } = meta;

  // Download the object content for screening
  const getResult = await s3Client.send(new GetObjectCommand({
    Bucket: ATTACHMENTS_BUCKET,
    Key: s3Key,
    ...(versionId && { VersionId: versionId }),
  }));

  if (!getResult.Body) {
    throw new AttachmentScreeningError(
      `Upload for '${att.filename}' could not be read from storage. Please re-upload the file.`,
    );
  }
  const content = Buffer.from(await getResult.Body.transformToByteArray());

  if (content.length !== sizeBytes) {
    throw new AttachmentScreeningError(
      `Upload for '${att.filename}' size mismatch (expected ${sizeBytes} bytes, read ${content.length}). ` +
      'Please re-upload the file and try again.',
    );
  }

  // Screen based on type
  const isImage = att.type === 'image';
  const screenResult = isImage
    ? await screenImage(content, att.content_type, att.filename, screeningConfig)
    : await screenTextFile(content, att.content_type, att.filename, screeningConfig);

  if (screenResult.screening.status === 'blocked') {
    return createAttachmentRecord({
      attachment_id: att.attachment_id,
      type: att.type,
      content_type: att.content_type,
      filename: att.filename,
      s3_key: s3Key,
      s3_version_id: versionId ?? 'unversioned',
      size_bytes: sizeBytes,
      screening: {
        status: 'blocked',
        screened_at: new Date().toISOString(),
        categories: screenResult.screening.categories,
      },
      checksum_sha256: screenResult.checksum,
    });
  }

  // Screening passed — reuse existing S3 object (no transformation needed)

  // Estimate token cost for images (using shared utility)
  let tokenEstimate: number | undefined;
  if (isImage) {
    tokenEstimate = estimateImageTokensFromBuffer(screenResult.content, att.content_type);
  }

  return createAttachmentRecord({
    attachment_id: att.attachment_id,
    type: att.type,
    content_type: att.content_type,
    filename: att.filename,
    s3_key: s3Key,
    s3_version_id: versionId ?? 'unversioned',
    size_bytes: sizeBytes,
    screening: { status: 'passed', screened_at: new Date().toISOString() },
    checksum_sha256: screenResult.checksum,
    ...(tokenEstimate !== undefined && { token_estimate: tokenEstimate }),
  });
}

// ---------------------------------------------------------------------------
// HeadObject with retry (S3 eventual consistency)
// ---------------------------------------------------------------------------

async function headObjectWithRetry(s3Key: string): Promise<{
  exists: boolean;
  versionId?: string;
  contentLength?: number;
}> {
  for (let attempt = 0; attempt <= HEAD_OBJECT_RETRIES; attempt++) {
    try {
      const result = await s3Client.send(new HeadObjectCommand({
        Bucket: ATTACHMENTS_BUCKET,
        Key: s3Key,
      }));
      return {
        exists: true,
        versionId: result.VersionId,
        contentLength: result.ContentLength,
      };
    } catch (err: any) {
      const statusCode = err?.$metadata?.httpStatusCode;
      if (statusCode === 404 && attempt < HEAD_OBJECT_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, HEAD_OBJECT_RETRY_DELAY_MS));
        continue;
      }
      if (statusCode === 404) {
        return { exists: false };
      }
      throw err;
    }
  }
  return { exists: false };
}

// ---------------------------------------------------------------------------
// Transition to SUBMITTED (conditional write + orchestrator invoke)
// ---------------------------------------------------------------------------

async function transitionToSubmitted(
  task: TaskRecord,
  finalAttachments: AttachmentRecord[],
  requestId: string,
): Promise<APIGatewayProxyResult> {
  const now = new Date().toISOString();
  const taskId = task.task_id;

  // Admission control — check concurrency before transitioning
  const admitted = await checkConcurrency(task.user_id);
  if (!admitted) {
    return errorResponse(429, ErrorCode.RATE_LIMIT_EXCEEDED,
      'User concurrency limit reached. Wait for a running task to finish or cancel one, then retry.', requestId);
  }

  // Conditional DynamoDB write: status PENDING_UPLOADS → SUBMITTED
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
      UpdateExpression: 'SET #s = :submitted, #sca = :status_created_at, attachments = :atts, updated_at = :now',
      ConditionExpression: '#s = :pending_uploads',
      ExpressionAttributeNames: {
        '#s': 'status',
        '#sca': 'status_created_at',
      },
      ExpressionAttributeValues: {
        ':submitted': TaskStatus.SUBMITTED,
        ':pending_uploads': TaskStatus.PENDING_UPLOADS,
        ':status_created_at': `${TaskStatus.SUBMITTED}#${now}`,
        ':atts': finalAttachments,
        ':now': now,
      },
    }));
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Another caller already transitioned (e.g. cleanup Lambda cancelled
      // the task). Roll back the concurrency counter we just incremented.
      await decrementConcurrency(task.user_id);
      // Return current state (idempotent)
      const current = await ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { task_id: taskId },
      }));
      if (current.Item) {
        return successResponse(200, toTaskDetail(current.Item as TaskRecord), requestId);
      }
      return errorResponse(404, ErrorCode.TASK_NOT_FOUND, 'Task not found.', requestId);
    }
    // Roll back concurrency counter on any other DDB error (throttling,
    // network timeout, etc.) to prevent permanent slot leaks.
    await decrementConcurrency(task.user_id);
    throw err;
  }

  // Write uploads_confirmed event (best-effort)
  try {
    await ddb.send(new PutCommand({
      TableName: EVENTS_TABLE_NAME,
      Item: {
        task_id: taskId,
        event_id: ulid(),
        event_type: 'uploads_confirmed',
        timestamp: now,
        ttl: computeTtlEpoch(TASK_RETENTION_DAYS),
        metadata: {
          attachment_count: finalAttachments.length,
          total_size_bytes: finalAttachments.reduce((sum, a) => sum + (a.size_bytes ?? 0), 0),
        },
      },
    }));
  } catch (eventErr) {
    logger.error('Failed to write uploads_confirmed event', {
      task_id: taskId,
      error: String(eventErr),
      request_id: requestId,
    });
  }

  // Invoke orchestrator (fire-and-forget)
  let orchestratorInvokeFailed = false;
  if (lambdaClient && process.env.ORCHESTRATOR_FUNCTION_ARN) {
    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: process.env.ORCHESTRATOR_FUNCTION_ARN,
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(JSON.stringify({ task_id: taskId })),
      }));
      logger.info('Orchestrator invoked after confirm-uploads', {
        task_id: taskId,
        request_id: requestId,
      });
    } catch (orchErr) {
      orchestratorInvokeFailed = true;
      logger.error('Failed to invoke orchestrator after confirm-uploads — task will be picked up by StrandedTaskReconciler', {
        error: orchErr instanceof Error ? orchErr.message : String(orchErr),
        task_id: taskId,
        request_id: requestId,
        metric_type: 'orchestrator_invoke_failure',
      });
    }
  }

  // Return updated task
  const updatedTask: TaskRecord = {
    ...task,
    status: TaskStatus.SUBMITTED,
    attachments: finalAttachments,
    updated_at: now,
  };
  const responseBody = toTaskDetail(updatedTask);
  if (orchestratorInvokeFailed) {
    (responseBody as any).warning = 'Task was submitted successfully but orchestration dispatch failed. ' +
      'The task will be picked up automatically within minutes by the background reconciler.';
  }
  return successResponse(200, responseBody, requestId);
}

// ---------------------------------------------------------------------------
// Fail task on screening failure (conditional write)
// ---------------------------------------------------------------------------

async function failTaskOnScreening(
  task: TaskRecord,
  taskId: string,
  filename: string,
  reason: string,
  requestId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
      UpdateExpression: 'SET #s = :failed, #sca = :status_created_at, error_message = :err, updated_at = :now, #ttl = :ttl',
      ConditionExpression: '#s = :pending_uploads',
      ExpressionAttributeNames: {
        '#s': 'status',
        '#sca': 'status_created_at',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':failed': TaskStatus.FAILED,
        ':pending_uploads': TaskStatus.PENDING_UPLOADS,
        ':status_created_at': `${TaskStatus.FAILED}#${now}`,
        ':err': `Attachment '${filename}' blocked: ${reason}`,
        ':now': now,
        ':ttl': computeTtlEpoch(TASK_RETENTION_DAYS),
      },
    }));
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Another caller already transitioned — skip
      logger.info('Task already transitioned during screening failure', {
        task_id: taskId,
        request_id: requestId,
      });
      return false;
    }
    throw err;
  }

  // Write event (best-effort)
  try {
    await ddb.send(new PutCommand({
      TableName: EVENTS_TABLE_NAME,
      Item: {
        task_id: taskId,
        event_id: ulid(),
        event_type: 'attachment_blocked',
        timestamp: now,
        ttl: computeTtlEpoch(TASK_RETENTION_DAYS),
        metadata: { filename, reason },
      },
    }));
  } catch (eventErr) {
    logger.error('Failed to write attachment_blocked event (best-effort)', {
      task_id: taskId,
      filename,
      error: String(eventErr),
      request_id: requestId,
    });
  }

  return true;
}

// ---------------------------------------------------------------------------
// Cleanup all S3 attachments for a task
// ---------------------------------------------------------------------------

async function cleanupAllAttachments(task: TaskRecord, taskId: string): Promise<void> {
  if (!task.attachments || task.attachments.length === 0) return;

  // Include VersionId when available — in a versioned bucket, DeleteObjects
  // without VersionId only creates a delete marker, leaving the actual content
  // accessible until the 7-day noncurrent lifecycle runs.
  const objects = task.attachments.map(att => ({
    Key: `${ATTACHMENT_OBJECT_KEY_PREFIX}${task.user_id}/${taskId}/${att.attachment_id}/${att.filename}`,
    ...(att.s3_version_id && att.s3_version_id !== 'unversioned' && { VersionId: att.s3_version_id }),
  }));

  try {
    const result = await s3Client.send(new DeleteObjectsCommand({
      Bucket: ATTACHMENTS_BUCKET,
      Delete: { Objects: objects },
    }));
    if (result.Errors && result.Errors.length > 0) {
      logger.error('Partial cleanup failure in confirm-uploads', {
        task_id: taskId,
        failedKeys: result.Errors.map(e => e.Key),
        metric_type: 'cleanup_failure_blocked_content',
      });
    }
  } catch (err) {
    logger.error('S3 cleanup failed in confirm-uploads — 90-day lifecycle is safety net', {
      task_id: taskId,
      object_count: objects.length,
      error: String(err),
      metric_type: 'cleanup_failure_blocked_content',
    });
  }
}

// ---------------------------------------------------------------------------
// Persist partial screening state (for deadline-exceeded retries)
// ---------------------------------------------------------------------------

/**
 * Write already-screened attachment records back to DDB so retries skip them.
 * Uses a conditional write to only update if the task is still in PENDING_UPLOADS.
 * If this write fails (race with cleanup), the already-screened work is lost but
 * the task was already being cancelled, so the client will see the correct state.
 */
async function persistPartialScreeningState(
  task: TaskRecord,
  taskId: string,
  screenedAttachments: AttachmentRecord[],
  requestId: string,
): Promise<void> {
  // Merge screened results with existing attachment records
  const mergedAttachments = (task.attachments ?? []).map(existing => {
    const screened = screenedAttachments.find(s => s.attachment_id === existing.attachment_id);
    return screened ?? existing;
  });

  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
      UpdateExpression: 'SET attachments = :atts, updated_at = :now',
      ConditionExpression: '#s = :pending_uploads',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':atts': mergedAttachments,
        ':pending_uploads': TaskStatus.PENDING_UPLOADS,
        ':now': new Date().toISOString(),
      },
    }));
    logger.info('Persisted partial screening state for deadline-exceeded retry', {
      task_id: taskId,
      screened_count: screenedAttachments.length,
      request_id: requestId,
    });
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      logger.info('Task already transitioned during partial screening persist — skipping', {
        task_id: taskId,
        request_id: requestId,
      });
      return;
    }
    logger.error('Failed to persist partial screening state (best-effort)', {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _bedrockClient: import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient | undefined;

async function buildScreeningConfig(): Promise<ScreeningConfig | undefined> {
  if (!process.env.GUARDRAIL_ID || !process.env.GUARDRAIL_VERSION) return undefined;
  if (!_bedrockClient) {
    const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
    _bedrockClient = new BedrockRuntimeClient({});
  }
  return {
    guardrailId: process.env.GUARDRAIL_ID,
    guardrailVersion: process.env.GUARDRAIL_VERSION,
    bedrockClient: _bedrockClient,
  };
}

/**
 * Non-mutating read to check if the user is at their concurrency limit.
 * Used as a fast pre-check before expensive screening; the actual atomic
 * increment happens in checkConcurrency() during transitionToSubmitted.
 */
async function preCheckConcurrency(userId: string): Promise<boolean> {
  try {
    const result = await ddb.send(new GetCommand({
      TableName: CONCURRENCY_TABLE_NAME,
      Key: { user_id: userId },
    }));
    const activeCount = (result?.Item?.active_count as number) ?? 0;
    return activeCount < MAX_CONCURRENT;
  } catch (err: any) {
    // Only swallow DDB throttling errors — these are transient and the atomic
    // check in transitionToSubmitted is the authoritative gate.
    const throttleErrors = ['ProvisionedThroughputExceededException', 'RequestLimitExceeded', 'ThrottlingException'];
    if (throttleErrors.includes(err?.name)) {
      logger.warn('Pre-check concurrency throttled — allowing request to proceed', {
        user_id: userId,
        error: err.message,
      });
      return true;
    }
    // Non-throttling errors (misconfigured table, IAM, network partition)
    // should propagate — no point running expensive screening if infra is broken.
    logger.error('Pre-check concurrency failed (non-throttling error)', {
      user_id: userId,
      error: err instanceof Error ? err.message : String(err),
      error_name: err?.name,
      metric_type: 'precheck_concurrency_failure',
    });
    throw err;
  }
}

async function checkConcurrency(userId: string): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: CONCURRENCY_TABLE_NAME,
      Key: { user_id: userId },
      UpdateExpression: 'SET active_count = if_not_exists(active_count, :zero) + :one, updated_at = :now',
      ConditionExpression: 'attribute_not_exists(active_count) OR active_count < :max',
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
        ':max': MAX_CONCURRENT,
        ':now': new Date().toISOString(),
      },
    }));
    return true;
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw err;
  }
}

async function decrementConcurrency(userId: string): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: CONCURRENCY_TABLE_NAME,
        Key: { user_id: userId },
        UpdateExpression: 'SET active_count = active_count - :one, updated_at = :now',
        ConditionExpression: 'attribute_exists(active_count) AND active_count > :zero',
        ExpressionAttributeValues: {
          ':one': 1,
          ':zero': 0,
          ':now': new Date().toISOString(),
        },
      }));
      return;
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') {
        // Counter already at 0 or doesn't exist — nothing to roll back
        return;
      }
      if (attempt < maxAttempts - 1) {
        // Retry transient DDB errors (throttling, network) with backoff
        await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt)));
        continue;
      }
      logger.error('Failed to decrement concurrency counter after retries (leak possible)', {
        user_id: userId,
        attempts: maxAttempts,
        error: err instanceof Error ? err.message : String(err),
        metric_type: 'concurrency_counter_leak',
      });
      throw new Error(
        `Concurrency counter decrement failed for user ${userId} after ${maxAttempts} attempts. ` +
        'Manual intervention may be required to reset the counter.',
      );
    }
  }
}
