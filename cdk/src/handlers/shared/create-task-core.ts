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
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { isDegeneratePattern, parseApprovalScope } from './approval-scope';
import { screenImage, screenTextFile, AttachmentScreeningError, type ScreeningConfig } from './attachment-screening';
import { generateBranchName } from './gateway';
import { estimateImageTokensFromBuffer } from './image-tokens';
import { logger } from './logger';
import { lookupRepo } from './repo-config';
import { ErrorCode, errorResponse, successResponse } from './response';
import {
  APPROVAL_GATE_CAP_DEFAULT,
  APPROVAL_GATE_CAP_MAX,
  APPROVAL_GATE_CAP_MIN,
  APPROVAL_TIMEOUT_S_MAX,
  APPROVAL_TIMEOUT_S_MIN,
  type AttachmentRecord,
  type AttachmentUploadInstruction,
  type ChannelSource,
  type CreateTaskRequest,
  createAttachmentRecord,
  INITIAL_APPROVALS_MAX_ENTRIES,
  type InlineAttachment,
  isPrTaskType,
  type PresignedAttachment,
  type TaskRecord,
  type TaskType,
  toTaskDetail,
} from './types';
import { computeTtlEpoch, DEFAULT_MAX_TURNS, hasTaskSpec, isValidIdempotencyKey, isValidRepo, isValidTaskDescriptionLength, isValidTaskType, MAX_ATTACHMENT_SIZE_BYTES, MAX_TASK_DESCRIPTION_LENGTH, validateAttachments, validateMaxBudgetUsd, validateMaxTurns, validatePrNumber } from './validation';
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

  // 1b. Single RepoTable GetItem covers BOTH the onboarding gate AND
  //     the Cedar HITL blueprint-cap resolution (§4 step 5, decision
  //     #13). Capturing the cap at submit-time means mid-task blueprint
  //     edits cannot shift the cap beneath a running task. Previously
  //     this path issued two back-to-back GetItems for the same key;
  //     ``lookupRepo`` consolidates them.
  const { onboarded, config: repoConfig } = await lookupRepo(body.repo);
  if (!onboarded) {
    return errorResponse(422, ErrorCode.REPO_NOT_ONBOARDED, `Repository '${body.repo}' is not onboarded. Register it with a Blueprint before submitting tasks.`, requestId);
  }
  const blueprintCap = repoConfig?.approval_gate_cap;
  let resolvedApprovalGateCap: number = APPROVAL_GATE_CAP_DEFAULT;
  if (blueprintCap !== undefined) {
    if (typeof blueprintCap !== 'number' || !Number.isInteger(blueprintCap)) {
      // Blueprint construct's synth-time validation should have caught
      // this, but a hand-edited RepoConfig row could bypass it. Fail
      // closed rather than persisting junk onto the TaskRecord.
      // 503 (not 500) — the condition is permanent until the blueprint
      // is re-deployed, but from the user's perspective this is "platform
      // can't accept this right now"; 500 would misleadingly suggest a
      // transient internal glitch worth retrying.
      logger.error('Blueprint misconfiguration — approval_gate_cap is not an integer', {
        repo: body.repo,
        blueprint_cap: blueprintCap,
        request_id: requestId,
      });
      return errorResponse(
        503,
        ErrorCode.SERVICE_UNAVAILABLE,
        `Blueprint misconfiguration: approval_gate_cap for '${body.repo}' is not an integer. `
          + 'Ask the platform admin to re-deploy the blueprint with a valid cap.',
        requestId,
      );
    }
    if (blueprintCap < APPROVAL_GATE_CAP_MIN || blueprintCap > APPROVAL_GATE_CAP_MAX) {
      logger.error('Blueprint misconfiguration — approval_gate_cap out of bounds', {
        repo: body.repo,
        blueprint_cap: blueprintCap,
        min: APPROVAL_GATE_CAP_MIN,
        max: APPROVAL_GATE_CAP_MAX,
        request_id: requestId,
      });
      return errorResponse(
        503,
        ErrorCode.SERVICE_UNAVAILABLE,
        `Blueprint misconfiguration: approval_gate_cap for '${body.repo}' is `
          + `${blueprintCap}; must be between ${APPROVAL_GATE_CAP_MIN} and `
          + `${APPROVAL_GATE_CAP_MAX}. Ask the platform admin to re-deploy the blueprint.`,
        requestId,
      );
    }
    resolvedApprovalGateCap = blueprintCap;
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

  // Cedar HITL — validate approval_timeout_s if supplied (§7.3 step 5).
  // maxLifetime-based ceiling clip is applied at orchestrator
  // invocation time; at submit time we only enforce the `[floor, cap]`
  // envelope.
  let approvalTimeoutS: number | undefined;
  if (body.approval_timeout_s !== undefined) {
    if (typeof body.approval_timeout_s !== 'number'
        || !Number.isInteger(body.approval_timeout_s)) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Invalid approval_timeout_s. Must be an integer.',
        requestId,
      );
    }
    if (body.approval_timeout_s < APPROVAL_TIMEOUT_S_MIN
        || body.approval_timeout_s > APPROVAL_TIMEOUT_S_MAX) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        `Invalid approval_timeout_s. Must be between ${APPROVAL_TIMEOUT_S_MIN}s `
          + `and ${APPROVAL_TIMEOUT_S_MAX}s.`,
        requestId,
      );
    }
    approvalTimeoutS = body.approval_timeout_s;
  }

  // Cedar HITL — validate initial_approvals if supplied (§7.3 step 4).
  let initialApprovals: string[] | undefined;
  if (body.initial_approvals !== undefined) {
    if (!Array.isArray(body.initial_approvals)) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Invalid initial_approvals. Must be an array of scope strings.',
        requestId,
      );
    }
    if (body.initial_approvals.length > INITIAL_APPROVALS_MAX_ENTRIES) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        `initial_approvals exceeds ${INITIAL_APPROVALS_MAX_ENTRIES} entries.`,
        requestId,
      );
    }
    const normalized: string[] = [];
    for (const entry of body.initial_approvals) {
      const parseResult = parseApprovalScope(String(entry));
      if (!parseResult.ok) {
        return errorResponse(
          400,
          ErrorCode.VALIDATION_ERROR,
          `Invalid initial_approvals entry "${String(entry)}": ${parseResult.message}.`,
          requestId,
        );
      }
      // Degenerate-pattern guard for bash_pattern:/write_path: scopes
      // (§7.4). Rejecting at submit is kinder than silently letting a
      // degenerate pattern through and having it match every tool call.
      if (
        parseResult.scope.startsWith('bash_pattern:')
        || parseResult.scope.startsWith('write_path:')
      ) {
        const value = parseResult.scope.split(':', 2)[1] ?? '';
        if (isDegeneratePattern(value)) {
          return errorResponse(
            400,
            ErrorCode.VALIDATION_ERROR,
            `Invalid initial_approvals entry "${parseResult.scope}": `
              + 'pattern is too broad. Use a more specific pattern, or '
              + '"all_session" if you intend to allow everything.',
            requestId,
          );
        }
      }
      normalized.push(parseResult.scope);
    }
    initialApprovals = normalized;
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

  // 2b. Process inline attachments: screen (with retry + EXIF strip), upload to S3, build records.
  // Presigned attachments are deferred to confirm-uploads; URL attachments are resolved during hydration.
  const attachmentRecords: AttachmentRecord[] = [];
  const uploadedS3Keys: string[] = [];
  if (validatedAttachments.length > 0 && s3Client && ATTACHMENTS_BUCKET) {
    // Build screening config — fail-closed if guardrail is not configured.
    // Reject inline AND presigned attachments upfront: presigned attachments will
    // need screening in confirm-uploads, so rejecting early prevents the user from
    // wasting time uploading files that can never be screened.
    if (!bedrockClient || !process.env.GUARDRAIL_ID || !process.env.GUARDRAIL_VERSION) {
      const hasScreenable = validatedAttachments.some(a => a.delivery === 'inline' || a.delivery === 'presigned');
      if (hasScreenable) {
        logger.error('Attachment submitted but guardrail is not configured (fail-closed)', {
          request_id: requestId,
          delivery_types: [...new Set(validatedAttachments.map(a => a.delivery))],
        });
        return errorResponse(503, ErrorCode.ATTACHMENT_SCREENING_UNAVAILABLE,
          'Attachment content screening is not configured. Please contact your administrator.', requestId);
      }
    }

    const screeningConfig: ScreeningConfig | undefined = bedrockClient && process.env.GUARDRAIL_ID && process.env.GUARDRAIL_VERSION
      ? { bedrockClient, guardrailId: process.env.GUARDRAIL_ID, guardrailVersion: process.env.GUARDRAIL_VERSION }
      : undefined;

    for (const att of validatedAttachments) {
      if (att.delivery !== 'inline') continue;
      const inlineAtt = att as InlineAttachment;

      // Validate base64 encoding before decode
      if (!isValidBase64(inlineAtt.data)) {
        await cleanupOrphanedAttachments(s3Client, uploadedS3Keys);
        return errorResponse(400, ErrorCode.ATTACHMENT_INVALID_CONTENT,
          `Attachment '${inlineAtt.filename}' has invalid base64 encoding.`, requestId);
      }

      const decoded = Buffer.from(inlineAtt.data, 'base64');
      const attachmentId = ulid();

      // Screen content via Bedrock with retry, EXIF stripping, and format conversion
      let screenResult;
      try {
        const isImage = inlineAtt.type === 'image';
        screenResult = isImage
          ? await screenImage(decoded, inlineAtt.content_type, inlineAtt.filename, screeningConfig!)
          : await screenTextFile(decoded, inlineAtt.content_type, inlineAtt.filename, screeningConfig!);
      } catch (screenErr) {
        await cleanupOrphanedAttachments(s3Client, uploadedS3Keys);
        if (screenErr instanceof AttachmentScreeningError) {
          logger.warn('Attachment screening rejected content', {
            attachment_filename: inlineAtt.filename,
            request_id: requestId,
            error: screenErr.message,
          });
          return errorResponse(400, ErrorCode.ATTACHMENT_INVALID_CONTENT, screenErr.message, requestId);
        }
        logger.error('Attachment screening failed (fail-closed)', {
          error: screenErr instanceof Error ? screenErr.message : String(screenErr),
          attachment_filename: inlineAtt.filename,
          request_id: requestId,
          metric_type: 'attachment_screening_failure',
        });
        return errorResponse(503, ErrorCode.ATTACHMENT_SCREENING_UNAVAILABLE,
          'Attachment content screening is temporarily unavailable. Please try again later.', requestId);
      }

      if (screenResult.screening.status === 'blocked') {
        await cleanupOrphanedAttachments(s3Client, uploadedS3Keys);
        const categories = screenResult.screening.categories.join(', ');
        return errorResponse(400, ErrorCode.ATTACHMENT_BLOCKED,
          `Attachment '${inlineAtt.filename}' was blocked by content policy (${categories}).`, requestId);
      }

      // Upload cleaned content to S3 (images are EXIF-stripped and re-encoded)
      const s3Key = `${ATTACHMENT_OBJECT_KEY_PREFIX}${context.userId}/${taskId}/${attachmentId}/${inlineAtt.filename}`;
      let putResult;
      try {
        putResult = await s3Client.send(new PutObjectCommand({
          Bucket: ATTACHMENTS_BUCKET,
          Key: s3Key,
          Body: screenResult.content,
          ContentType: inlineAtt.content_type,
        }));
      } catch (s3Err) {
        await cleanupOrphanedAttachments(s3Client, uploadedS3Keys);
        logger.error('S3 upload failed for attachment', {
          error: s3Err instanceof Error ? s3Err.message : String(s3Err),
          attachment_filename: inlineAtt.filename,
          s3_key: s3Key,
          request_id: requestId,
          metric_type: 'attachment_upload_failure',
        });
        return errorResponse(500, ErrorCode.INTERNAL_ERROR,
          `Failed to store attachment '${inlineAtt.filename}'. Please try again.`, requestId);
      }

      uploadedS3Keys.push(s3Key);

      // Estimate image token cost (best-effort, non-blocking)
      const tokenEstimate = inlineAtt.type === 'image'
        ? estimateImageTokensFromBuffer(screenResult.content, inlineAtt.content_type)
        : undefined;

      attachmentRecords.push(createAttachmentRecord({
        attachment_id: attachmentId,
        type: inlineAtt.type,
        content_type: inlineAtt.content_type,
        filename: inlineAtt.filename,
        s3_key: s3Key,
        s3_version_id: putResult.VersionId ?? 'unversioned',
        size_bytes: screenResult.content.length,
        screening: { status: 'passed', screened_at: new Date().toISOString() },
        checksum_sha256: screenResult.checksum,
        ...(tokenEstimate !== undefined && { token_estimate: tokenEstimate }),
      }));
    }

    // URL attachments: store as pending records — resolved during hydration
    // (resolveUrlAttachments in orchestrator fetches, screens, and uploads to S3).
    for (const att of validatedAttachments) {
      if (att.delivery !== 'url_fetch') continue;
      attachmentRecords.push(createAttachmentRecord({
        attachment_id: ulid(),
        type: att.type,
        content_type: att.content_type,
        filename: att.filename,
        source_url: att.url,
        screening: { status: 'pending' },
      }));
    }

    // Presigned upload attachments get pending records (confirmed via confirm-uploads endpoint)
    // Generate presigned POST policies so the client can upload directly to S3.
    for (const att of validatedAttachments) {
      if (att.delivery !== 'presigned') continue;
      const presignedAtt = att as PresignedAttachment;
      const attachmentId = ulid();
      const s3Key = `${ATTACHMENT_OBJECT_KEY_PREFIX}${context.userId}/${taskId}/${attachmentId}/${presignedAtt.filename}`;

      attachmentRecords.push(createAttachmentRecord({
        attachment_id: attachmentId,
        type: presignedAtt.type,
        content_type: presignedAtt.content_type,
        filename: presignedAtt.filename,
        screening: { status: 'pending' },
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

  // Determine initial status: PENDING_UPLOADS if any presigned attachments need uploading,
  // otherwise SUBMITTED (inline/url/no attachments go straight to the pipeline).
  const hasPresignedAttachments = validatedAttachments.some(a => a.delivery === 'presigned');
  const initialStatus = hasPresignedAttachments ? TaskStatus.PENDING_UPLOADS : TaskStatus.SUBMITTED;

  // 5. Build task record
  const taskRecord: TaskRecord = {
    task_id: taskId,
    user_id: context.userId,
    status: initialStatus,
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
    status_created_at: `${initialStatus}#${now}`,
    created_at: now,
    updated_at: now,
    // Cedar HITL extensions (§10.2). Only written when the submit
    // payload supplied them; ``approval_timeout_s`` defaults to the
    // engine default at agent runtime when absent here.
    ...(approvalTimeoutS !== undefined && { approval_timeout_s: approvalTimeoutS }),
    ...(initialApprovals !== undefined && { initial_approvals: initialApprovals }),
    // Persisted counter the stranded-approval reconciler + agent
    // counter both read (§13.6). Seeded to 0 at task-create time.
    approval_gate_count: 0,
    // Cedar HITL (§4 step 5, decision #13): per-task cap captured at
    // submit-time. Blueprint override wins when within bounds; otherwise
    // platform default of 50. Persisted so a container restart or a
    // mid-task blueprint edit cannot shift the cap beneath the task.
    approval_gate_cap: resolvedApprovalGateCap,
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
    // Chunk 7b: surface the resolved cap + its source so operators can
    // detect a broken blueprint-plumbing deploy (all four fallback
    // layers in the resolution cascade converge here). ``source`` is
    // "blueprint" when the blueprint explicitly configured the value,
    // "platform_default" when it fell through to 50.
    approval_gate_cap: resolvedApprovalGateCap,
    approval_gate_cap_source: blueprintCap !== undefined ? 'blueprint' : 'platform_default',
  });

  // 8. Async-invoke the orchestrator (fire-and-forget).
  // Skip for PENDING_UPLOADS — the orchestrator is invoked from confirm-uploads
  // once all attachments are uploaded and screened.
  if (initialStatus === TaskStatus.SUBMITTED && lambdaClient && process.env.ORCHESTRATOR_FUNCTION_ARN) {
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
  if (hasPresignedAttachments && s3Client && ATTACHMENTS_BUCKET) {
    // Generate presigned POST policies for presigned attachments
    let uploadInstructions: AttachmentUploadInstruction[];
    try {
      uploadInstructions = await generateUploadInstructions(
        taskRecord, validatedAttachments, context.userId, taskId, s3Client,
      );
    } catch (presignErr) {
      logger.error('Failed to generate presigned upload instructions — transitioning task to FAILED', {
        task_id: taskId,
        error: presignErr instanceof Error ? presignErr.message : String(presignErr),
        request_id: requestId,
        metric_type: 'presigned_post_generation_failure',
      });
      // Transition task to FAILED so it doesn't remain orphaned in PENDING_UPLOADS
      try {
        await ddb.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { task_id: taskId },
          UpdateExpression: 'SET #s = :failed, error_message = :err, updated_at = :now',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':failed': TaskStatus.FAILED,
            ':err': 'Failed to generate upload instructions. Please try again.',
            ':now': new Date().toISOString(),
          },
        }));
      } catch (cleanupErr) {
        logger.error('Failed to transition orphaned task to FAILED', {
          task_id: taskId,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
      return errorResponse(500, ErrorCode.INTERNAL_ERROR,
        'Failed to generate upload instructions. Please try again.', requestId);
    }
    const taskExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min auto-cancel window
    return successResponse(202, {
      ...toTaskDetail(taskRecord),
      upload_instructions: uploadInstructions,
      task_expires_at: taskExpiresAt,
    }, requestId);
  }

  return successResponse(201, toTaskDetail(taskRecord), requestId);
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Validate that a string is well-formed base64. */
function isValidBase64(data: string): boolean {
  if (data.length === 0) return false;
  if (data.length % 4 !== 0) return false;
  return BASE64_PATTERN.test(data);
}

/** Presigned POST policy expiry: 10 minutes. */
const PRESIGNED_POST_EXPIRY_SECONDS = 600;

/**
 * Generate presigned POST upload instructions for presigned-delivery attachments.
 */
async function generateUploadInstructions(
  taskRecord: TaskRecord,
  validatedAttachments: readonly import('./types').ValidatedAttachment[],
  userId: string,
  taskId: string,
  client: S3Client,
): Promise<AttachmentUploadInstruction[]> {
  const instructions: AttachmentUploadInstruction[] = [];
  const presignedRecords = taskRecord.attachments?.filter(a => a.screening.status === 'pending' && !a.source_url) ?? [];

  // Match validated presigned attachments with their records (same order as created)
  const presignedValidated = validatedAttachments.filter(a => a.delivery === 'presigned') as PresignedAttachment[];

  for (let i = 0; i < presignedValidated.length; i++) {
    const att = presignedValidated[i];
    const record = presignedRecords[i];
    if (!record) continue;

    const s3Key = `${ATTACHMENT_OBJECT_KEY_PREFIX}${userId}/${taskId}/${record.attachment_id}/${att.filename}`;
    // Type assertion: @aws-sdk/s3-presigned-post bundles a nested @aws-sdk/client-s3
    // with divergent @smithy/types declarations. The runtime is compatible; only the
    // type declarations conflict. Cast to `any` at the boundary.
    const { url, fields } = await createPresignedPost(client as any, {
      Bucket: ATTACHMENTS_BUCKET!,
      Key: s3Key,
      Conditions: [
        ['content-length-range', 1, MAX_ATTACHMENT_SIZE_BYTES],
        ['eq', '$Content-Type', att.content_type],
      ],
      Fields: {
        'Content-Type': att.content_type,
      },
      Expires: PRESIGNED_POST_EXPIRY_SECONDS,
    });

    const expiresAt = new Date(Date.now() + PRESIGNED_POST_EXPIRY_SECONDS * 1000).toISOString();
    instructions.push({
      attachment_id: record.attachment_id,
      filename: att.filename,
      upload_url: url,
      upload_fields: fields,
      upload_expires_at: expiresAt,
    });
  }

  return instructions;
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
