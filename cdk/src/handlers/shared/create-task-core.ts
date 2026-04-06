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
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { generateBranchName } from './gateway';
import { logger } from './logger';
import { checkRepoOnboarded } from './repo-config';
import { ErrorCode, errorResponse, successResponse } from './response';
import { type CreateTaskRequest, type TaskRecord, toTaskDetail } from './types';
import { computeTtlEpoch, DEFAULT_MAX_TURNS, hasTaskSpec, isValidIdempotencyKey, isValidRepo, isValidTaskDescriptionLength, MAX_TASK_DESCRIPTION_LENGTH, validateMaxBudgetUsd, validateMaxTurns } from './validation';
import { TaskStatus } from '../../constructs/task-status';

/**
 * Context for task creation — abstracts the auth source (Cognito vs. webhook).
 */
export interface TaskCreationContext {
  readonly userId: string;
  readonly channelSource: 'api' | 'webhook';
  readonly channelMetadata: Record<string, string>;
  readonly idempotencyKey?: string;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = process.env.ORCHESTRATOR_FUNCTION_ARN ? new LambdaClient({}) : undefined;
const bedrockClient = process.env.GUARDRAIL_ID ? new BedrockRuntimeClient({}) : undefined;
const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');

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

  // 2. Screen task description with Bedrock Guardrail (fail-open: a Bedrock outage
  //    should not block all task submissions — log the error and proceed)
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
      logger.error('Guardrail screening failed — proceeding without screening (fail-open)', {
        error: String(guardrailErr),
        user_id: context.userId,
        request_id: requestId,
      });
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
        return errorResponse(409, ErrorCode.DUPLICATE_TASK, 'A task with this idempotency key already exists.', requestId);
      }
    }
  }

  // 4. Generate identifiers and timestamps
  const taskId = ulid();
  const now = new Date().toISOString();
  const branchName = generateBranchName(taskId, body.task_description ?? body.repo);

  // 5. Build task record
  const taskRecord: TaskRecord = {
    task_id: taskId,
    user_id: context.userId,
    status: TaskStatus.SUBMITTED,
    repo: body.repo,
    ...(body.issue_number !== undefined && { issue_number: body.issue_number }),
    ...(body.task_description !== undefined && { task_description: body.task_description }),
    branch_name: branchName,
    ...(userMaxTurns !== undefined && { max_turns: userMaxTurns }),
    ...(userMaxBudgetUsd !== undefined && { max_budget_usd: userMaxBudgetUsd }),
    ...(context.idempotencyKey && { idempotency_key: context.idempotencyKey }),
    channel_source: context.channelSource,
    channel_metadata: context.channelMetadata,
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
      logger.info('Orchestrator invoked', { task_id: taskId });
    } catch (orchErr) {
      logger.error('Failed to invoke orchestrator', { error: String(orchErr), task_id: taskId });
    }
  }

  // 9. Return created task
  return successResponse(201, toTaskDetail(taskRecord), requestId);
}
