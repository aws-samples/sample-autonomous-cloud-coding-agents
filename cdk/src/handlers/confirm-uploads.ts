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

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ulid } from 'ulid';
import { ACTIVE_STATUSES, TaskStatus } from '../constructs/task-status';
import { screenImage, screenTextFile, AttachmentScreeningError, type ScreeningConfig } from './shared/attachment-screening';
import { extractUserId } from './shared/gateway';
import { estimateImageTokensFromBuffer } from './shared/image-tokens';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { ATTACHMENT_OBJECT_KEY_PREFIX } from './shared/storage-names';
import { type AttachmentRecord, createAttachmentRecord, type TaskRecord, toTaskDetail } from './shared/types';
import { makeClient, makeDocClient } from './shared/ua';
import { computeTtlEpoch, MAX_TOTAL_ATTACHMENT_SIZE_BYTES, validateMagicBytes } from './shared/validation';

const ddb = makeDocClient();
const s3Client = makeClient(S3Client);
const lambdaClient = process.env.ORCHESTRATOR_FUNCTION_ARN ? makeClient(LambdaClient) : undefined;

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
const DEADLINE_MARGIN_MS = 15_000;

interface S3ObjectMeta {
  readonly s3Key: string;
  readonly versionId?: string;
  readonly sizeBytes: number;
}

/**
 * POST /v1/tasks/{task_id}/confirm-uploads — confirms presigned uploads, screens
 * attachments, and transitions the task from PENDING_UPLOADS to SUBMITTED, or to
 * FAILED when an attachment is blocked.
 */
export async function handler(event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const callerUserId = extractUserId(event);
    if (!callerUserId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const taskId = event.pathParameters?.task_id;
    if (!taskId) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing task_id path parameter.', requestId);
    }

    const taskResult = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
    }));

    if (!taskResult.Item) {
      return errorResponse(404, ErrorCode.TASK_NOT_FOUND, 'Task not found.', requestId);
    }

    const task = taskResult.Item as TaskRecord;

    if (task.user_id !== callerUserId) {
      return errorResponse(404, ErrorCode.TASK_NOT_FOUND, 'Task not found.', requestId);
    }

    if (task.status !== TaskStatus.PENDING_UPLOADS) {
      if (task.status === TaskStatus.QUEUED || ACTIVE_STATUSES.includes(task.status)) {
        return successResponse(200, toTaskDetail(task), requestId);
      }
      return errorResponse(409, ErrorCode.UPLOADS_NOT_PENDING,
        `Task is in status '${task.status}' and cannot accept upload confirmations.`, requestId);
    }

    const attachments = task.attachments;
    if (!attachments || attachments.length === 0) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR,
        'Task has no attachments to confirm.', requestId);
    }

    const pendingAttachments = attachments.filter(a => a.screening.status === 'pending' && a.type !== 'url');

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

    const preCheckAdmitted = await preCheckConcurrency(task.user_id);
    if (!preCheckAdmitted) {
      return errorResponse(429, ErrorCode.RATE_LIMIT_EXCEEDED,
        'User concurrency limit reached. Wait for a running task to finish or cancel one, then retry.', requestId);
    }

    const screeningConfig = await buildScreeningConfig();
    if (!screeningConfig) {
      return errorResponse(503, ErrorCode.ATTACHMENT_SCREENING_UNAVAILABLE,
        'Attachment content screening is not configured. Please contact your administrator.', requestId);
    }

    const screenedAttachments: AttachmentRecord[] = [];

    for (let i = 0; i < pendingAttachments.length; i += SCREENING_CONCURRENCY) {
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
            const transitioned = await failTaskOnScreening(task, taskId, att.filename, err.message, requestId);
            if (transitioned) {
              await cleanupAllAttachments(task, taskId, s3Meta);
            }
            return errorResponse(400, ErrorCode.ATTACHMENT_BLOCKED,
              `Attachment '${att.filename}' was rejected: ${err.message}`, requestId);
          }

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

        screenedAttachments.push(result.value);
      }

      if (screenedAttachments.some(a => a.screening.status === 'blocked')) break;
    }

    const finalAttachments = attachments.map(existing => {
      const screened = screenedAttachments.find(s => s.attachment_id === existing.attachment_id);
      return screened ?? existing;
    });

    const blockedAtt = finalAttachments.find(a => a.screening.status === 'blocked');
    if (blockedAtt) {
      const categories = blockedAtt.screening.status === 'blocked'
        ? blockedAtt.screening.categories.join(', ')
        : 'content_policy_violation';
      const transitioned = await failTaskOnScreening(task, taskId, blockedAtt.filename, categories, requestId);
      if (transitioned) {
        await cleanupAllAttachments(task, taskId, s3Meta);
      }
      return errorResponse(400, ErrorCode.ATTACHMENT_BLOCKED,
        `Attachment '${blockedAtt.filename}' was blocked by content policy (${categories}).`, requestId);
    }

    const totalBytes = finalAttachments.reduce((sum, a) => sum + (a.size_bytes ?? 0), 0);
    if (totalBytes > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
      logger.warn('Confirmed attachments exceed the task-wide size limit (fail-closed)', {
        task_id: taskId,
        total_bytes: totalBytes,
        limit_bytes: MAX_TOTAL_ATTACHMENT_SIZE_BYTES,
        attachment_count: finalAttachments.length,
        request_id: requestId,
        metric_type: 'attachment_total_size_exceeded',
      });
      const message = `Combined attachment size exceeds the ${MAX_TOTAL_ATTACHMENT_SIZE_BYTES}-byte task limit.`;
      const transitioned = await failTaskOnScreening(task, taskId, undefined, message, requestId);
      if (transitioned) {
        await cleanupAllAttachments(task, taskId, s3Meta);
      }
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, message, requestId);
    }

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

async function screenSingleAttachment(
  att: AttachmentRecord,
  _task: TaskRecord,
  screeningConfig: ScreeningConfig,
  _taskId: string,
  meta: S3ObjectMeta,
): Promise<AttachmentRecord> {
  const { s3Key, versionId, sizeBytes } = meta;

  let getResult;
  try {
    getResult = await s3Client.send(new GetObjectCommand({
      Bucket: ATTACHMENTS_BUCKET,
      Key: s3Key,
      ...(versionId && { VersionId: versionId }),
    }));
  } catch (err: any) {
    if (err?.$metadata?.httpStatusCode !== 404) throw err;
    throw new AttachmentScreeningError(
      `Upload for '${att.filename}' is no longer in storage. The uploads of a task are deleted ` +
      'when the task fails or its upload window expires; check the status of the task.',
    );
  }

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

  if (!validateMagicBytes(content, att.content_type)) {
    throw new AttachmentScreeningError(
      `Upload for '${att.filename}' does not match its declared type '${att.content_type}'. ` +
      'The file may be corrupt or masquerading as a different type.',
    );
  }

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

async function transitionToSubmitted(
  task: TaskRecord,
  finalAttachments: AttachmentRecord[],
  requestId: string,
): Promise<APIGatewayProxyResult> {
  const now = new Date().toISOString();
  const taskId = task.task_id;

  const admitted = await checkConcurrency(task.user_id);
  if (!admitted) {
    return errorResponse(429, ErrorCode.RATE_LIMIT_EXCEEDED,
      'User concurrency limit reached. Wait for a running task to finish or cancel one, then retry.', requestId);
  }

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
      await decrementConcurrency(task.user_id);
      const current = await ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { task_id: taskId },
      }));
      if (current.Item) {
        return successResponse(200, toTaskDetail(current.Item as TaskRecord), requestId);
      }
      return errorResponse(404, ErrorCode.TASK_NOT_FOUND, 'Task not found.', requestId);
    }
    await decrementConcurrency(task.user_id);
    throw err;
  }

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

async function failTaskOnScreening(
  _task: TaskRecord,
  taskId: string,
  filename: string | undefined,
  reason: string,
  requestId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
      UpdateExpression: 'SET #s = :failed, #sca = :status_created_at, error_message = :err, updated_at = :now, completed_at = :now, #ttl = :ttl',
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
        ':err': filename ? `Attachment '${filename}' blocked: ${reason}` : reason,
        ':now': now,
        ':ttl': computeTtlEpoch(TASK_RETENTION_DAYS),
      },
    }));
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      logger.info('Task already transitioned during screening failure', {
        task_id: taskId,
        request_id: requestId,
      });
      return false;
    }
    throw err;
  }

  if (!filename) return true;

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

async function cleanupAllAttachments(task: TaskRecord, taskId: string, s3Meta: Map<string, S3ObjectMeta>): Promise<void> {
  if (!task.attachments || task.attachments.length === 0) return;

  // In a versioned bucket, DeleteObjects without VersionId only creates a delete
  // marker, leaving the actual content accessible.
  const objects = task.attachments.map(att => ({
    Key: `${ATTACHMENT_OBJECT_KEY_PREFIX}${task.user_id}/${taskId}/${att.attachment_id}/${att.filename}`,
    ...(att.s3_version_id && att.s3_version_id !== 'unversioned' && { VersionId: att.s3_version_id }),
  }));
  for (const { s3Key, versionId } of s3Meta.values()) {
    if (versionId) objects.push({ Key: s3Key, VersionId: versionId });
  }

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

async function persistPartialScreeningState(
  task: TaskRecord,
  taskId: string,
  screenedAttachments: AttachmentRecord[],
  requestId: string,
): Promise<void> {
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

let _bedrockClient: import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient | undefined;

async function buildScreeningConfig(): Promise<ScreeningConfig | undefined> {
  if (!process.env.GUARDRAIL_ID || !process.env.GUARDRAIL_VERSION) return undefined;
  if (!_bedrockClient) {
    const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
    _bedrockClient = makeClient(BedrockRuntimeClient);
  }
  return {
    guardrailId: process.env.GUARDRAIL_ID,
    guardrailVersion: process.env.GUARDRAIL_VERSION,
    bedrockClient: _bedrockClient,
  };
}

async function preCheckConcurrency(userId: string): Promise<boolean> {
  try {
    const result = await ddb.send(new GetCommand({
      TableName: CONCURRENCY_TABLE_NAME,
      Key: { user_id: userId },
    }));
    const activeCount = (result?.Item?.active_count as number) ?? 0;
    return activeCount < MAX_CONCURRENT;
  } catch (err: any) {
    const throttleErrors = ['ProvisionedThroughputExceededException', 'RequestLimitExceeded', 'ThrottlingException'];
    if (throttleErrors.includes(err?.name)) {
      logger.warn('Pre-check concurrency throttled — allowing request to proceed', {
        user_id: userId,
        error: err.message,
      });
      return true;
    }
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
        return;
      }
      if (attempt < maxAttempts - 1) {
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
        { cause: err },
      );
    }
  }
}
