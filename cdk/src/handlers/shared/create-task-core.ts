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

// HTTP create-task path: validation, persistence, orchestrator invoke. Related: orchestrator.ts, preflight.ts.
// Idempotent replay: same user + same Idempotency-Key → 200 + TaskDetail (no duplicate write, no orchestrator re-invoke).
// Tests: cdk/test/handlers/shared/create-task-core.test.ts, cdk/test/handlers/create-task.test.ts

import { BedrockRuntimeClient, ApplyGuardrailCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand, DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { createHash } from 'crypto';
import { ulid } from 'ulid';
import { generateBranchName } from './gateway';
import { logger } from './logger';
import { checkRepoOnboarded } from './repo-config';
import { ErrorCode, errorResponse, successResponse } from './response';
import { type AttachmentRecord, type ChannelSource, type CreateTaskRequest, createAttachmentRecord, type InlineAttachment, isPrTaskType, type TaskRecord, type TaskType, toTaskDetail } from './types';
import { computeTtlEpoch, DEFAULT_MAX_TURNS, hasTaskSpec, isValidIdempotencyKey, isValidRepo, isValidTaskDescriptionLength, isValidTaskType, MAX_TASK_DESCRIPTION_LENGTH, validateAttachments, validateMaxBudgetUsd, validateMaxTurns, validatePrNumber } from './validation';
import { ATTACHMENT_OBJECT_KEY_PREFIX } from '../../constructs/attachments-bucket';
import { TaskStatus } from '../../constructs/task-status';

/**
 * Context for task creation — abstracts the auth source (Cognito vs. webhook).
 */
export interface TaskCreationContext {
  readonly userId: string;
  readonly channelSource: ChannelSource;
  readonly channelMetadata: Record<string, string>;
  readonly idempotencyKey?: string;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = process.env.ORCHESTRATOR_FUNCTION_ARN ? new LambdaClient({}) : undefined;
const bedrockClient = (process.env.GUARDRAIL_ID && process.env.GUARDRAIL_VERSION)
  ? new BedrockRuntimeClient({}) : undefined;
if (process.env.GUARDRAIL_ID && !process.env.GUARDRAIL_VERSION) {
  logger.error('GUARDRAIL_ID is set but GUARDRAIL_VERSION is missing — guardrail screening disabled', {
    metric_type: 'guardrail_misconfiguration',
  });
}
const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');
const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET_NAME;
const s3Client = ATTACHMENTS_BUCKET ? new S3Client({}) : undefined;

/**
 * Core task creation logic shared by the Cognito create-task handler
 * and the webhook create-task handler.
 * @param body - parsed and type-checked request body.
 * @param context - auth context (user, channel, idempotency).
 * @param requestId - unique request ID for tracing.
 * @returns the API Gateway proxy result.
 */
export async function createTaskCore(
  body: CreateTaskRequest,
  context: TaskCreationContext,
  requestId: string,
): Promise<APIGatewayProxyResult> {
  // 1. Validate request body
  if (!body.repo || !isValidRepo(body.repo)) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid or missing repo. Expected format: owner/repo.', requestId);
  }

  // 1b. Check repo is onboarded (conditional — skipped when REPO_TABLE_NAME is not set)
  const onboardingResult = await checkRepoOnboarded(body.repo);
  if (!onboardingResult.onboarded) {
    return errorResponse(422, ErrorCode.REPO_NOT_ONBOARDED, `Repository '${body.repo}' is not onboarded. Register it with a Blueprint before submitting tasks.`, requestId);
  }

  if (!hasTaskSpec(body)) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'At least one of issue_number or task_description is required.', requestId);
  }

  // Validate task_type
  if (!isValidTaskType(body.task_type)) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid task_type. Must be "new_task", "pr_iteration", or "pr_review".', requestId);
  }
  const taskType: TaskType = (body.task_type as TaskType) ?? 'new_task';
  const isPrTask = isPrTaskType(taskType);

  // Validate pr_number
  const prNumberResult = validatePrNumber(body.pr_number);
  if (prNumberResult === null) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid pr_number. Must be a positive integer.', requestId);
  }
  if (isPrTask && prNumberResult === undefined) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, `pr_number is required when task_type is "${taskType}".`, requestId);
  }
  if (!isPrTask && prNumberResult !== undefined) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'pr_number is only allowed when task_type is "pr_iteration" or "pr_review".', requestId);
  }

  if (body.task_description && !isValidTaskDescriptionLength(body.task_description)) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, `task_description exceeds maximum length of ${MAX_TASK_DESCRIPTION_LENGTH} characters.`, requestId);
  }

  const maxTurnsResult = validateMaxTurns(body.max_turns);
  if (maxTurnsResult === null) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid max_turns. Must be an integer between 1 and 500.', requestId);
  }
  // Store only user-explicit max_turns on the task record (undefined when not specified).
  // The effective value is computed at orchestration time using the 3-tier override:
  // platform default < per-repo Blueprint config < per-task user override.
  const userMaxTurns = maxTurnsResult;

  const maxBudgetResult = validateMaxBudgetUsd(body.max_budget_usd);
  if (maxBudgetResult === null) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid max_budget_usd. Must be a number between 0.01 and 100.', requestId);
  }
  const userMaxBudgetUsd = maxBudgetResult;

  // --trace is a strict boolean — reject strings / numbers so a
  // misbehaving client can't accidentally enable it with ``"trace":
  // "false"`` (which would be truthy).
  if (body.trace !== undefined && typeof body.trace !== 'boolean') {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid trace. Must be a boolean.', requestId);
  }
  const userTrace = body.trace === true;

  // Validate attachments
  const attachmentResult = validateAttachments(body.attachments as unknown[] | undefined);
  if (!attachmentResult.valid) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, attachmentResult.error, requestId);
  }
  const validatedAttachments = attachmentResult.parsed;

  // Fail-closed: reject requests with attachments when bucket is not configured
  if (validatedAttachments.length > 0 && (!s3Client || !ATTACHMENTS_BUCKET)) {
    logger.error('Attachments submitted but ATTACHMENTS_BUCKET_NAME is not configured', {
      user_id: context.userId,
      request_id: requestId,
      attachment_count: validatedAttachments.length,
    });
    return errorResponse(503, ErrorCode.INTERNAL_ERROR,
      'Attachment storage is not configured. Please contact your administrator.', requestId);
  }

  // 2. Screen task description with Bedrock Guardrail (fail-closed: unscreened content
  //    must not reach the agent — a Bedrock outage blocks task submissions)
  if (bedrockClient && body.task_description) {
    try {
      const guardrailResult = await bedrockClient.send(new ApplyGuardrailCommand({
        guardrailIdentifier: process.env.GUARDRAIL_ID!,
        guardrailVersion: process.env.GUARDRAIL_VERSION!,
        source: 'INPUT',
        content: [{ text: { text: body.task_description } }],
      }));

      if (guardrailResult.action === 'GUARDRAIL_INTERVENED') {
        logger.warn('Task description blocked by guardrail', { user_id: context.userId, request_id: requestId });
        return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Task description was blocked by content policy.', requestId);
      }
    } catch (guardrailErr) {
      logger.error('Guardrail screening failed (fail-closed)', {
        error: String(guardrailErr),
        user_id: context.userId,
        request_id: requestId,
        metric_type: 'guardrail_screening_failure',
      });
      return errorResponse(503, ErrorCode.INTERNAL_ERROR, 'Content screening is temporarily unavailable. Please try again later.', requestId);
    }
  }

  // Generate task ID early so attachment S3 keys use the correct task ID
  const taskId = ulid();

  // 2b. Process inline attachments: screen, upload to S3, build records
  const attachmentRecords: AttachmentRecord[] = [];
  const uploadedS3Keys: string[] = [];
  if (validatedAttachments.length > 0 && s3Client && ATTACHMENTS_BUCKET) {
    for (const att of validatedAttachments) {
      if (att.delivery !== 'inline') continue;
      const inlineAtt = att as InlineAttachment;

      // Validate base64 encoding before decode
      if (!isValidBase64(inlineAtt.data)) {
        return errorResponse(400, ErrorCode.ATTACHMENT_INVALID_CONTENT,
          `Attachment '${inlineAtt.filename}' has invalid base64 encoding.`, requestId);
      }

      const decoded = Buffer.from(inlineAtt.data, 'base64');
      const attachmentId = ulid();

      // Screen inline attachment content via Bedrock Guardrail (fail-closed)
      if (!bedrockClient) {
        await cleanupOrphanedAttachments(s3Client, uploadedS3Keys);
        logger.error('Inline attachment submitted but guardrail is not configured (fail-closed)', {
          request_id: requestId,
          attachment_filename: inlineAtt.filename,
        });
        return errorResponse(503, ErrorCode.ATTACHMENT_SCREENING_UNAVAILABLE,
          'Attachment content screening is not configured. Please contact your administrator.', requestId);
      }
      {
        try {
          const isImage = inlineAtt.type === 'image';
          const guardrailContent = isImage
            ? [{ image: { format: mimeToGuardrailFormat(inlineAtt.content_type), source: { bytes: decoded } } }]
            : [{ text: { text: decoded.toString('utf-8') } }];

          const screenResult = await bedrockClient.send(new ApplyGuardrailCommand({
            guardrailIdentifier: process.env.GUARDRAIL_ID!,
            guardrailVersion: process.env.GUARDRAIL_VERSION!,
            source: 'INPUT',
            content: guardrailContent,
          }));

          if (screenResult.action === 'GUARDRAIL_INTERVENED') {
            // Clean up any already-uploaded attachments
            await cleanupOrphanedAttachments(s3Client, uploadedS3Keys);
            return errorResponse(400, ErrorCode.ATTACHMENT_BLOCKED,
              `Attachment '${inlineAtt.filename}' was blocked by content policy.`, requestId);
          }
        } catch (screenErr) {
          await cleanupOrphanedAttachments(s3Client, uploadedS3Keys);
          logger.error('Attachment screening failed (fail-closed)', {
            error: String(screenErr),
            attachment_filename: inlineAtt.filename,
            request_id: requestId,
          });
          return errorResponse(503, ErrorCode.ATTACHMENT_SCREENING_UNAVAILABLE,
            'Attachment content screening is temporarily unavailable. Please try again later.', requestId);
        }
      }

      // Upload to S3
      const s3Key = `${ATTACHMENT_OBJECT_KEY_PREFIX}${context.userId}/${taskId}/${attachmentId}/${inlineAtt.filename}`;
      try {
        const putResult = await s3Client.send(new PutObjectCommand({
          Bucket: ATTACHMENTS_BUCKET,
          Key: s3Key,
          Body: decoded,
          ContentType: inlineAtt.content_type,
        }));

        uploadedS3Keys.push(s3Key);
        const checksum = createHash('sha256').update(decoded).digest('hex');

        attachmentRecords.push(createAttachmentRecord({
          attachment_id: attachmentId,
          type: inlineAtt.type,
          content_type: inlineAtt.content_type,
          filename: inlineAtt.filename,
          s3_key: s3Key,
          s3_version_id: putResult.VersionId ?? 'unversioned',
          size_bytes: decoded.length,
          screening: { status: 'passed', screened_at: new Date().toISOString() },
          checksum_sha256: checksum,
        }));
      } catch (s3Err) {
        await cleanupOrphanedAttachments(s3Client, uploadedS3Keys);
        logger.error('S3 upload failed for inline attachment', {
          error: String(s3Err),
          attachment_filename: inlineAtt.filename,
          request_id: requestId,
        });
        return errorResponse(500, ErrorCode.INTERNAL_ERROR,
          `Failed to upload attachment '${inlineAtt.filename}'.`, requestId);
      }
    }

    // URL attachments get pending records (resolved during hydration)
    for (const att of validatedAttachments) {
      if (att.delivery !== 'url_fetch') continue;
      attachmentRecords.push(createAttachmentRecord({
        attachment_id: ulid(),
        type: att.type,
        content_type: att.content_type,
        filename: att.filename,
        screening: { status: 'pending' },
        source_url: att.url,
      }));
    }
  }

  // 3. Check idempotency key
  if (context.idempotencyKey !== undefined && context.idempotencyKey !== null) {
    if (!isValidIdempotencyKey(context.idempotencyKey)) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid Idempotency-Key format.', requestId);
    }

    const existing = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'IdempotencyIndex',
      KeyConditionExpression: 'idempotency_key = :key',
      ExpressionAttributeValues: { ':key': context.idempotencyKey },
      Limit: 1,
    }));

    if (existing.Items && existing.Items.length > 0) {
      const existingTaskId = existing.Items[0].task_id as string;
      const existingTask = await ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { task_id: existingTaskId },
      }));

      if (existingTask.Item) {
        const existingRecord = existingTask.Item as TaskRecord;
        const requiredReplayFields = ['task_id', 'user_id', 'status', 'repo', 'branch_name', 'channel_source', 'created_at', 'updated_at'] as const;
        const missingFields = requiredReplayFields.filter(f => !existingRecord[f]);
        if (missingFields.length > 0) {
          logger.error('Idempotent replay: existing task record is incomplete', {
            task_id: existingRecord.task_id,
            missing_fields: missingFields,
            present_fields: Object.keys(existingTask.Item),
            request_id: requestId,
          });
          return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Failed to retrieve existing task for idempotent replay.', requestId);
        }
        if (existingRecord.user_id !== context.userId) {
          return errorResponse(409, ErrorCode.DUPLICATE_TASK, 'A task with this idempotency key already exists.', requestId);
        }
        logger.info('Idempotent task submit replay', {
          task_id: existingRecord.task_id,
          user_id: context.userId,
          request_id: requestId,
        });
        return successResponse(200, toTaskDetail(existingRecord), requestId, { 'Idempotent-Replay': 'true' });
      } else {
        logger.warn('Idempotency key matched GSI but task record is gone (TTL/deletion race)', {
          idempotency_key: context.idempotencyKey,
          stale_task_id: existingTaskId,
          user_id: context.userId,
          request_id: requestId,
        });
      }
    }
  }

  // 4. Generate identifiers and timestamps
  const now = new Date().toISOString();
  const branchName = isPrTask
    ? 'pending:pr_resolution'
    : generateBranchName(taskId, body.task_description ?? body.repo);

  // 5. Build task record
  const taskRecord: TaskRecord = {
    task_id: taskId,
    user_id: context.userId,
    status: TaskStatus.SUBMITTED,
    repo: body.repo,
    ...(body.issue_number !== undefined && { issue_number: body.issue_number }),
    task_type: taskType,
    ...(prNumberResult !== undefined && { pr_number: prNumberResult }),
    ...(body.task_description !== undefined && { task_description: body.task_description }),
    branch_name: branchName,
    ...(userMaxTurns !== undefined && { max_turns: userMaxTurns }),
    ...(userMaxBudgetUsd !== undefined && { max_budget_usd: userMaxBudgetUsd }),
    ...(userTrace && { trace: true }),
    ...(context.idempotencyKey && { idempotency_key: context.idempotencyKey }),
    channel_source: context.channelSource,
    channel_metadata: context.channelMetadata,
    ...(attachmentRecords.length > 0 && { attachments: attachmentRecords }),
    status_created_at: `${TaskStatus.SUBMITTED}#${now}`,
    created_at: now,
    updated_at: now,
  };

  // 6. Write task record
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: taskRecord,
    ConditionExpression: 'attribute_not_exists(task_id)',
  }));

  // 7. Write task_created event (best-effort — event loss is acceptable,
  //    task record is the source of truth)
  try {
    await ddb.send(new PutCommand({
      TableName: EVENTS_TABLE_NAME,
      Item: {
        task_id: taskId,
        event_id: ulid(),
        event_type: 'task_created',
        timestamp: now,
        ttl: computeTtlEpoch(TASK_RETENTION_DAYS),
        metadata: {
          repo: body.repo,
          issue_number: body.issue_number ?? null,
          channel_source: context.channelSource,
        },
      },
    }));
  } catch (eventErr) {
    logger.error('Failed to write task_created event — task was created successfully', {
      task_id: taskId,
      error: String(eventErr),
      request_id: requestId,
    });
  }

  logger.info('Task created', {
    task_id: taskId,
    user_id: context.userId,
    repo: body.repo,
    channel_source: context.channelSource,
    request_id: requestId,
  });

  // 8. Async-invoke the orchestrator (fire-and-forget)
  if (lambdaClient && process.env.ORCHESTRATOR_FUNCTION_ARN) {
    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: process.env.ORCHESTRATOR_FUNCTION_ARN,
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(JSON.stringify({ task_id: taskId })),
      }));
      logger.info('Orchestrator invoked', {
        event: 'task.admitted.orchestrator_invoked',
        task_id: taskId,
        request_id: requestId,
      });
    } catch (orchErr) {
      logger.error('Failed to invoke orchestrator', {
        event: 'task.admitted.orchestrator_invoke_failed',
        error: String(orchErr),
        task_id: taskId,
      });
    }
  }

  // 9. Return created task
  return successResponse(201, toTaskDetail(taskRecord), requestId);
}

/**
 * Map MIME type to Bedrock GuardrailImageFormat.
 * The SDK currently supports 'png' | 'jpeg' — GIF and WebP are mapped
 * to 'png' (lossless container) since the guardrail inspects visual
 * content, not codec fidelity.
 */
function mimeToGuardrailFormat(contentType: string): 'png' | 'jpeg' {
  if (contentType === 'image/jpeg') return 'jpeg';
  return 'png';
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Validate that a string is well-formed base64. */
function isValidBase64(data: string): boolean {
  if (data.length === 0) return false;
  if (data.length % 4 !== 0) return false;
  return BASE64_PATTERN.test(data);
}

/**
 * Clean up S3 objects from a partially-failed inline upload.
 * Best-effort — the 90-day lifecycle is the safety net if cleanup fails.
 */
async function cleanupOrphanedAttachments(client: S3Client, keys: string[]): Promise<void> {
  if (keys.length === 0 || !ATTACHMENTS_BUCKET) return;
  try {
    const result = await client.send(new DeleteObjectsCommand({
      Bucket: ATTACHMENTS_BUCKET,
      Delete: { Objects: keys.map(Key => ({ Key })) },
    }));
    if (result.Errors && result.Errors.length > 0) {
      logger.error('Partial cleanup failure — some orphaned objects remain', {
        failedKeys: result.Errors.map(e => e.Key),
        errorCodes: result.Errors.map(e => e.Code),
      });
    }
  } catch (err) {
    logger.error('Cleanup failed entirely — all objects orphaned (90-day lifecycle is safety net)', {
      keys,
      error: String(err),
    });
  }
}
