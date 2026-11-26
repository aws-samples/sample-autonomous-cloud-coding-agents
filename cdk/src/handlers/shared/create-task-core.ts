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

import { BedrockRuntimeClient, ApplyGuardrailCommand } from '@aws-sdk/client-bedrock-runtime';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand, DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { PutCommand, QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { TaskStatus } from '../../constructs/task-status';
import { isDegeneratePattern, parseApprovalScope } from './approval-scope';
import { screenImage, screenTextFile, AttachmentScreeningError, type ScreeningConfig } from './attachment-screening';
import { checkBudgetAdmission } from './budgets';
import { generateBranchName } from './gateway';
import { estimateImageTokensFromBuffer } from './image-tokens';
import { logger } from './logger';
import { lookupRepo } from './repo-config';
import { ErrorCode, errorResponse, successResponse } from './response';
import { ATTACHMENT_OBJECT_KEY_PREFIX } from './storage-names';
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
  type CreateTaskResponse,
  createAttachmentRecord,
  INITIAL_APPROVALS_MAX_ENTRIES,
  MICROVM_SLEEP_AFTER_S_DEFAULT,
  MICROVM_SLEEP_AFTER_S_MAX,
  MICROVM_SLEEP_AFTER_S_MIN,
  type InlineAttachment,
  type PresignedAttachment,
  type TaskRecord,
  toTaskDetail,
} from './types';
import { makeClient, makeDocClient } from './ua';
import { computeTtlEpoch, hasTaskSpec, isValidIdempotencyKey, isValidRepo, isValidTaskDescriptionLength, MAX_ATTACHMENT_SIZE_BYTES, MAX_TASK_DESCRIPTION_LENGTH, MAX_TOTAL_ATTACHMENT_SIZE_BYTES, validateAttachments, validateMaxBudgetUsd, validateMaxTurns, validatePrNumber } from './validation';
import { disallowedWorkflowModel, getWorkflowDescriptor, isValidWorkflowRef, resolveWorkflowRef, resolveWorkflowRefError } from './workflows';

/**
 * Context for task creation — abstracts the auth source (Cognito vs. webhook).
 */
export interface TaskCreationContext {
  readonly userId: string;
  /**
   * Cognito group names used as team IDs for fleet budgets. The direct API
   * supplies these from the authenticated JWT; headless channel adapters omit
   * them and the budget helper resolves current membership from Cognito.
   */
  readonly teamIds?: readonly string[];
  readonly channelSource: ChannelSource;
  readonly channelMetadata: Record<string, string>;
  readonly idempotencyKey?: string;
  /**
   * Task ID to use instead of minting one. Only trusted server-side callers
   * set this.
   */
  readonly taskId?: string;
  /**
   * Attachment records the caller has already downloaded, screened (status
   * `passed`), and uploaded to S3. Merged verbatim into the
   * persisted attachments and NOT re-screened here. Every record MUST be a
   * passed record with storage fields populated; a non-`passed` record is a
   * caller contract violation and fails the request closed.
   *
   * These bypass the wire `Attachment`/`validateAttachments` path, so the
   * caller is responsible for enforcing the per-file / total-size / count
   * limits before upload.
   */
  readonly preScreenedAttachments?: readonly AttachmentRecord[];
}

const ddb = makeDocClient();
const lambdaClient = process.env.ORCHESTRATOR_FUNCTION_ARN ? makeClient(LambdaClient) : undefined;
const bedrockClient = (process.env.GUARDRAIL_ID && process.env.GUARDRAIL_VERSION)
  ? makeClient(BedrockRuntimeClient) : undefined;
if (process.env.GUARDRAIL_ID && !process.env.GUARDRAIL_VERSION) {
  logger.error('GUARDRAIL_ID is set but GUARDRAIL_VERSION is missing — guardrail screening disabled', {
    metric_type: 'guardrail_misconfiguration',
  });
}
const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');
const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET_NAME;
const s3Client = ATTACHMENTS_BUCKET ? makeClient(S3Client) : undefined;

function describeRequiredInputs(requiredInputs: { allOf?: readonly string[]; oneOf?: readonly string[] }): string {
  const parts: string[] = [];
  if (requiredInputs.allOf?.length) {
    parts.push(requiredInputs.allOf.join(' and '));
  }
  if (requiredInputs.oneOf?.length) {
    parts.push(`one of ${requiredInputs.oneOf.join(' or ')}`);
  }
  return parts.length > 0 ? parts.join(', plus ') : 'a task specification';
}

/**
 * Core task creation logic shared by the Cognito create-task handler
 * and the webhook create-task handler.
 * @param body - parsed and type-checked request body.
 * @param context - auth context (user, channel, idempotency).
 * @param requestId - unique request ID for tracing.
 * @returns the API Gateway proxy result.
 */
// eslint-disable-next-line complexity -- predates the ceiling (145; 140 when it landed); must not grow
export async function createTaskCore(
  body: CreateTaskRequest,
  context: TaskCreationContext,
  requestId: string,
): Promise<APIGatewayProxyResult> {
  if (!isValidWorkflowRef(body.workflow_ref)) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid workflow_ref. Expected "<domain>/<name>-vN[@<constraint>]".', requestId);
  }
  const resolvedWorkflow = resolveWorkflowRef(body.workflow_ref);
  if (resolvedWorkflow === null) {
    const reason = resolveWorkflowRefError(body.workflow_ref);
    const message = reason === 'unsatisfiable_version'
      ? `workflow_ref "${body.workflow_ref}" pins a version that is not available.`
      : `Unknown workflow_ref "${body.workflow_ref}".`;
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, message, requestId);
  }
  const workflow = getWorkflowDescriptor(resolvedWorkflow.id)!;

  const badModel = disallowedWorkflowModel(resolvedWorkflow.id);
  if (badModel !== null) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, `The "${resolvedWorkflow.id}" workflow requests model "${badModel}", which is not on the platform allow-list.`, requestId);
  }

  if (workflow.requiresRepo && !body.repo) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, `The "${resolvedWorkflow.id}" workflow requires a repo. Expected format: owner/repo.`, requestId);
  }
  if (body.repo && !isValidRepo(body.repo)) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid repo. Expected format: owner/repo.', requestId);
  }

  let resolvedApprovalGateCap: number = APPROVAL_GATE_CAP_DEFAULT;
  let capFromBlueprint = false;
  if (body.repo) {
    const { onboarded, config: repoConfig } = await lookupRepo(body.repo);
    if (!onboarded) {
      return errorResponse(422, ErrorCode.REPO_NOT_ONBOARDED, `Repository '${body.repo}' is not onboarded. Register it with a Blueprint before submitting tasks.`, requestId);
    }
    const blueprintCap = repoConfig?.approval_gate_cap;
    if (blueprintCap !== undefined) {
      if (typeof blueprintCap !== 'number' || !Number.isInteger(blueprintCap)) {
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
      capFromBlueprint = true;
    }
  }

  const isPrTask = workflow.requiredInputs.allOf?.includes('pr_number') ?? false;

  if (body.task_description != null && typeof body.task_description !== 'string') {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid task_description. Must be a string.', requestId);
  }

  if (!hasTaskSpec(body, workflow.requiredInputs)) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, `The "${resolvedWorkflow.id}" workflow requires ${describeRequiredInputs(workflow.requiredInputs)}.`, requestId);
  }

  const prNumberResult = validatePrNumber(body.pr_number);
  if (prNumberResult === null) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid pr_number. Must be a positive integer.', requestId);
  }
  if (isPrTask && prNumberResult === undefined) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, `pr_number is required for the "${resolvedWorkflow.id}" workflow.`, requestId);
  }
  if (!isPrTask && prNumberResult !== undefined) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'pr_number is only allowed for a pull-request workflow (e.g. coding/pr-iteration-v1, coding/pr-review-v1).', requestId);
  }

  const issueNumber = validatePrNumber(body.issue_number);
  if (issueNumber === null) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid issue_number. Must be a positive integer.', requestId);
  }

  if (body.task_description && !isValidTaskDescriptionLength(body.task_description)) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, `task_description exceeds maximum length of ${MAX_TASK_DESCRIPTION_LENGTH} characters.`, requestId);
  }

  const maxTurnsResult = validateMaxTurns(body.max_turns);
  if (maxTurnsResult === null) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid max_turns. Must be an integer between 1 and 500.', requestId);
  }
  const userMaxTurns = maxTurnsResult;

  const maxBudgetResult = validateMaxBudgetUsd(body.max_budget_usd);
  if (maxBudgetResult === null) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid max_budget_usd. Must be a number between 0.01 and 100.', requestId);
  }
  const userMaxBudgetUsd = maxBudgetResult;

  if (body.trace !== undefined && typeof body.trace !== 'boolean') {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid trace. Must be a boolean.', requestId);
  }
  const userTrace = body.trace === true;

  const attachmentResult = validateAttachments(body.attachments as unknown[] | undefined);
  if (!attachmentResult.valid) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, attachmentResult.error, requestId);
  }
  const validatedAttachments = attachmentResult.parsed;

  if (validatedAttachments.length > 0 && (!s3Client || !ATTACHMENTS_BUCKET)) {
    logger.error('Attachments submitted but ATTACHMENTS_BUCKET_NAME is not configured', {
      user_id: context.userId,
      request_id: requestId,
      attachment_count: validatedAttachments.length,
    });
    return errorResponse(503, ErrorCode.INTERNAL_ERROR,
      'Attachment storage is not configured. Please contact your administrator.', requestId);
  }

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

  const microvmSleepAfterS = body.microvm_sleep_after_s === undefined
    ? MICROVM_SLEEP_AFTER_S_DEFAULT : body.microvm_sleep_after_s;
  if (typeof microvmSleepAfterS !== 'number' || !Number.isInteger(microvmSleepAfterS)
    || microvmSleepAfterS < MICROVM_SLEEP_AFTER_S_MIN || microvmSleepAfterS > MICROVM_SLEEP_AFTER_S_MAX) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR,
      `Invalid microvm_sleep_after_s. Must be an integer between ${MICROVM_SLEEP_AFTER_S_MIN} `
        + `and ${MICROVM_SLEEP_AFTER_S_MAX} seconds (0 disables sleep).`, requestId);
  }

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
      const checked = checkInitialApproval(entry);
      if (!checked.ok) {
        return errorResponse(400, ErrorCode.VALIDATION_ERROR, checked.message, requestId);
      }
      normalized.push(checked.scope);
    }
    initialApprovals = normalized;
  }

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
        const requiredReplayFields = ['task_id', 'user_id', 'status', 'channel_source', 'created_at', 'updated_at'] as const;
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
        return replayResponse(existingRecord, requestId);
      }
      logger.warn('Idempotency key matched GSI but task record is gone (TTL/deletion race)', {
        idempotency_key: context.idempotencyKey,
        stale_task_id: existingTaskId,
        user_id: context.userId,
        request_id: requestId,
      });
    }
  }

  let budgetAdmission;
  try {
    budgetAdmission = await checkBudgetAdmission(context.userId, context.teamIds);
  } catch (budgetErr) {
    if (
      budgetErr instanceof Error
      && budgetErr.name === 'BudgetScopeLimitError'
    ) {
      logger.warn('Budget admission rejected unsupported team count', {
        user_id: context.userId,
        request_id: requestId,
        error: budgetErr.message,
      });
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        budgetErr.message,
        requestId,
      );
    }
    logger.error('Budget admission check failed closed', {
      user_id: context.userId,
      request_id: requestId,
      error: budgetErr instanceof Error ? budgetErr.message : String(budgetErr),
      metric_type: 'budget_admission_failure',
    });
    return errorResponse(
      503,
      ErrorCode.SERVICE_UNAVAILABLE,
      'Budget admission is temporarily unavailable. Please try again later.',
      requestId,
    );
  }
  if (budgetAdmission.blocked) {
    const blocked = budgetAdmission.blocked;
    logger.warn('Monthly hard-stop budget blocked task admission', {
      user_id: context.userId,
      request_id: requestId,
      scope_type: blocked.scopeType,
      scope_id: blocked.scopeId,
      period: budgetAdmission.period,
      spend_usd: blocked.spendUsd,
      monthly_limit_usd: blocked.monthlyLimitUsd,
      metric_type: 'budget_admission_blocked',
    });
    const owner = blocked.scopeType === 'user'
      ? 'Your monthly budget'
      : `The monthly budget for team '${blocked.scopeId}'`;
    return errorResponse(
      429,
      ErrorCode.BUDGET_EXCEEDED,
      `${owner} is exhausted ($${blocked.spendUsd.toFixed(2)} of `
        + `$${blocked.monthlyLimitUsd.toFixed(2)}). New tasks are disabled until the next UTC month.`,
      requestId,
    );
  }

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

  const taskId = context.taskId ?? ulid();

  const attachmentRecords: AttachmentRecord[] = [];
  const uploadedS3Keys: string[] = [];
  if (validatedAttachments.length > 0 && s3Client && ATTACHMENTS_BUCKET) {
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

      if (!isValidBase64(inlineAtt.data)) {
        await cleanupOrphanedAttachments(s3Client, uploadedS3Keys);
        return errorResponse(400, ErrorCode.ATTACHMENT_INVALID_CONTENT,
          `Attachment '${inlineAtt.filename}' has invalid base64 encoding.`, requestId);
      }

      const decoded = Buffer.from(inlineAtt.data, 'base64');
      const attachmentId = ulid();

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

    for (const att of validatedAttachments) {
      if (att.delivery !== 'presigned') continue;
      const presignedAtt = att as PresignedAttachment;
      const attachmentId = ulid();

      attachmentRecords.push(createAttachmentRecord({
        attachment_id: attachmentId,
        type: presignedAtt.type,
        content_type: presignedAtt.content_type,
        filename: presignedAtt.filename,
        screening: { status: 'pending' },
      }));
    }
  }

  if (context.preScreenedAttachments && context.preScreenedAttachments.length > 0) {
    for (const rec of context.preScreenedAttachments) {
      if (rec.screening.status !== 'passed') {
        logger.error('Pre-screened attachment is not in passed state (fail-closed)', {
          attachment_filename: rec.filename,
          screening_status: rec.screening.status,
          request_id: requestId,
          metric_type: 'prescreened_attachment_invalid',
        });
        if (s3Client) await cleanupOrphanedAttachments(s3Client, uploadedS3Keys);
        return errorResponse(500, ErrorCode.INTERNAL_ERROR,
          'A pre-screened attachment was not in a passed state.', requestId);
      }
    }
    attachmentRecords.push(...context.preScreenedAttachments);
  }

  const knownTotalBytes = attachmentRecords.reduce(
    (sum, r) => sum + (typeof (r as { size_bytes?: number }).size_bytes === 'number' ? (r as { size_bytes: number }).size_bytes : 0),
    0,
  );
  if (knownTotalBytes > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
    logger.warn('Combined attachment size exceeds the task-wide limit (fail-closed)', {
      total_bytes: knownTotalBytes,
      limit_bytes: MAX_TOTAL_ATTACHMENT_SIZE_BYTES,
      attachment_count: attachmentRecords.length,
      request_id: requestId,
      metric_type: 'attachment_total_size_exceeded',
    });
    if (s3Client) await cleanupOrphanedAttachments(s3Client, uploadedS3Keys);
    return errorResponse(
      400, ErrorCode.VALIDATION_ERROR,
      `Combined attachment size exceeds the ${MAX_TOTAL_ATTACHMENT_SIZE_BYTES}-byte task limit.`,
      requestId,
    );
  }

  const now = new Date().toISOString();
  const branchName = !body.repo
    ? ''
    : isPrTask
      ? 'pending:pr_resolution'
      : generateBranchName(taskId, body.task_description ?? body.repo);

  const hasPresignedAttachments = validatedAttachments.some(a => a.delivery === 'presigned');
  const initialStatus = hasPresignedAttachments ? TaskStatus.PENDING_UPLOADS : TaskStatus.SUBMITTED;

  const taskRecord: TaskRecord = {
    task_id: taskId,
    user_id: context.userId,
    ...(budgetAdmission.teamIds.length > 0 && { team_ids: budgetAdmission.teamIds }),
    status: initialStatus,
    ...(body.repo ? { repo: body.repo } : {}),
    ...(issueNumber !== undefined && { issue_number: issueNumber }),
    ...(body.workflow_ref !== undefined && { workflow_ref: body.workflow_ref }),
    resolved_workflow: resolvedWorkflow,
    ...(prNumberResult !== undefined && { pr_number: prNumberResult }),
    ...(body.task_description !== undefined && { task_description: body.task_description }),
    branch_name: branchName,
    ...(userMaxTurns !== undefined && { max_turns: userMaxTurns }),
    ...(userMaxBudgetUsd !== undefined && { max_budget_usd: userMaxBudgetUsd }),
    ...(userTrace && { trace: true }),
    ...(context.idempotencyKey && { idempotency_key: context.idempotencyKey }),
    channel_source: context.channelSource,
    channel_metadata: context.channelMetadata,
    // DynamoDB GSIs cannot key on nested map values.
    ...(context.channelMetadata?.linear_issue_id && {
      linear_issue_id: context.channelMetadata.linear_issue_id,
    }),
    ...(context.channelSource === 'jira'
      && context.channelMetadata?.jira_cloud_id
      && context.channelMetadata?.jira_issue_key
      && {
        jira_issue_identity:
          `${context.channelMetadata.jira_cloud_id}#${context.channelMetadata.jira_issue_key}`,
      }),
    ...(attachmentRecords.length > 0 && { attachments: attachmentRecords }),
    status_created_at: `${initialStatus}#${now}`,
    created_at: now,
    updated_at: now,
    ...(approvalTimeoutS !== undefined && { approval_timeout_s: approvalTimeoutS }),
    microvm_sleep_after_s: microvmSleepAfterS,
    ...(initialApprovals !== undefined && { initial_approvals: initialApprovals }),
    approval_gate_count: 0,
    approval_gate_cap: resolvedApprovalGateCap,
  };

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: taskRecord,
    ConditionExpression: 'attribute_not_exists(task_id)',
  }));

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
          repo: body.repo ?? null,
          issue_number: issueNumber ?? null,
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
    approval_gate_cap: resolvedApprovalGateCap,
    approval_gate_cap_source: capFromBlueprint ? 'blueprint' : 'platform_default',
  });

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

  if (hasPresignedAttachments && s3Client && ATTACHMENTS_BUCKET) {
    let uploadInstructions: AttachmentUploadInstruction[];
    try {
      uploadInstructions = await generateUploadInstructions(taskRecord, s3Client);
    } catch (presignErr) {
      logger.error('Failed to generate presigned upload instructions — transitioning task to FAILED', {
        task_id: taskId,
        error: presignErr instanceof Error ? presignErr.message : String(presignErr),
        request_id: requestId,
        metric_type: 'presigned_post_generation_failure',
      });
      try {
        const failedAt = new Date().toISOString();
        await ddb.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { task_id: taskId },
          UpdateExpression: 'SET #s = :failed, error_message = :err, updated_at = :now, completed_at = :now, status_created_at = :sca, #ttl = :ttl',
          ExpressionAttributeNames: { '#s': 'status', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':failed': TaskStatus.FAILED,
            ':err': 'Failed to generate upload instructions. Please try again.',
            ':now': failedAt,
            ':sca': `${TaskStatus.FAILED}#${failedAt}`,
            ':ttl': computeTtlEpoch(TASK_RETENTION_DAYS),
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
    const taskExpiresAt = new Date(Date.now() + PENDING_UPLOAD_EXPIRY_MINUTES * 60 * 1000).toISOString();
    return successResponse(202, {
      ...toTaskDetail(taskRecord),
      upload_instructions: uploadInstructions,
      task_expires_at: taskExpiresAt,
    } satisfies CreateTaskResponse, requestId);
  }

  return successResponse(201, toTaskDetail(taskRecord), requestId);
}

function checkInitialApproval(entry: unknown): { ok: true; scope: string } | { ok: false; message: string } {
  const parseResult = parseApprovalScope(String(entry));
  if (!parseResult.ok) {
    return { ok: false, message: `Invalid initial_approvals entry "${String(entry)}": ${parseResult.message}.` };
  }
  if (['this_call', 'tool_type_session', 'tool_group_session'].includes(parseResult.scope)) {
    return {
      ok: false,
      message: `Invalid initial_approvals entry "${parseResult.scope}": it stands for a call that is `
        + 'waiting for approval, so it cannot be granted in advance. '
        + 'Name the tool or the group, for example "tool_type:Bash".',
    };
  }
  if (
    parseResult.scope.startsWith('bash_pattern:')
    || parseResult.scope.startsWith('write_path:')
  ) {
    const value = parseResult.scope.slice(parseResult.scope.indexOf(':') + 1);
    if (isDegeneratePattern(value)) {
      return {
        ok: false,
        message: `Invalid initial_approvals entry "${parseResult.scope}": `
          + 'pattern is too broad. Use a more specific pattern, or '
          + '"all_session" if you intend to allow everything.',
      };
    }
  }
  return { ok: true, scope: parseResult.scope };
}

const PENDING_UPLOAD_EXPIRY_MINUTES = 30;

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const BASE64_GROUP_SIZE = 4;

function isValidBase64(data: string): boolean {
  if (data.length === 0) return false;
  if (data.length % BASE64_GROUP_SIZE !== 0) return false;
  return BASE64_PATTERN.test(data);
}

const PRESIGNED_POST_EXPIRY_SECONDS = 600;

async function replayResponse(record: TaskRecord, requestId: string): Promise<APIGatewayProxyResult> {
  let detail: CreateTaskResponse = toTaskDetail(record);
  if (record.status === TaskStatus.PENDING_UPLOADS && s3Client) {
    detail = {
      ...detail,
      upload_instructions: await generateUploadInstructions(record, s3Client),
      task_expires_at: new Date(Date.parse(record.created_at) + PENDING_UPLOAD_EXPIRY_MINUTES * 60 * 1000).toISOString(),
    };
  }
  return successResponse(200, detail, requestId, { 'Idempotent-Replay': 'true' });
}

async function generateUploadInstructions(
  taskRecord: TaskRecord,
  client: S3Client,
): Promise<AttachmentUploadInstruction[]> {
  const instructions: AttachmentUploadInstruction[] = [];
  const presignedRecords = taskRecord.attachments?.filter(a => a.screening.status === 'pending' && !a.source_url) ?? [];

  for (const record of presignedRecords) {
    const s3Key = `${ATTACHMENT_OBJECT_KEY_PREFIX}${taskRecord.user_id}/${taskRecord.task_id}/${record.attachment_id}/${record.filename}`;
    const { url, fields } = await createPresignedPost(client as any, {
      Bucket: ATTACHMENTS_BUCKET!,
      Key: s3Key,
      Conditions: [
        ['content-length-range', 1, MAX_ATTACHMENT_SIZE_BYTES],
        ['eq', '$Content-Type', record.content_type],
      ],
      Fields: {
        'Content-Type': record.content_type,
      },
      Expires: PRESIGNED_POST_EXPIRY_SECONDS,
    });

    const expiresAt = new Date(Date.now() + PRESIGNED_POST_EXPIRY_SECONDS * 1000).toISOString();
    instructions.push({
      attachment_id: record.attachment_id,
      filename: record.filename,
      upload_url: url,
      upload_fields: fields,
      upload_expires_at: expiresAt,
    });
  }

  return instructions;
}

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
