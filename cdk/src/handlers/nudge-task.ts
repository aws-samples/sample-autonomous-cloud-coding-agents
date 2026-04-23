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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { TERMINAL_STATUSES } from '../constructs/task-status';
import { GuardrailScreeningError, screenWithGuardrail } from './shared/context-hydration';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { NUDGE_MAX_MESSAGE_LENGTH } from './shared/types';
import type { NudgeRecord, NudgeRequest, TaskRecord } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TASK_TABLE_NAME = process.env.TASK_TABLE_NAME;
const NUDGES_TABLE_NAME = process.env.NUDGES_TABLE_NAME;
if (!TASK_TABLE_NAME || !NUDGES_TABLE_NAME) {
  throw new Error(
    'nudge-task handler requires TASK_TABLE_NAME and NUDGES_TABLE_NAME env vars to be set',
  );
}
const RATE_LIMIT_PER_MINUTE = Number(process.env.NUDGE_RATE_LIMIT_PER_MINUTE ?? '10');
/** TTL for stored nudge rows (~30 days). */
const NUDGE_RETENTION_SECONDS = 30 * 24 * 60 * 60;
/** TTL for rate-limit counter rows (~2 minutes — only need the current minute bucket). */
const RATE_LIMIT_ROW_TTL_SECONDS = 120;

/**
 * POST /v1/tasks/{task_id}/nudge — submit a steering message to a running agent.
 *
 * Flow: auth → validate → ownership → state → guardrail → rate-limit → persist.
 *
 * Note ordering: guardrail screening runs BEFORE the rate-limit counter
 * increment so that a guardrail-blocked message does NOT consume a slot in
 * the user's per-minute budget. ApplyGuardrail is cheap compared to DDB,
 * and the user-facing UX of "accidentally blocked, lost a slot" is worse
 * than the alternative. Authenticated users are already rate-limited
 * upstream by API Gateway / Cognito.
 *
 * Returns 202 Accepted with the nudge_id. The nudge will be picked up by
 * the agent runtime at the next between-turns seam.
 * @param event - the API Gateway proxy event.
 * @returns the API Gateway proxy result.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    // 1. Auth
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    // 2. Path param
    const taskId = event.pathParameters?.task_id;
    if (!taskId) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing task_id path parameter.', requestId);
    }

    // 3. Body validation
    let parsed: NudgeRequest | null = null;
    try {
      parsed = event.body ? JSON.parse(event.body) as NudgeRequest : null;
    } catch {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON.', requestId);
    }
    if (!parsed || typeof parsed.message !== 'string') {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing required field: message (string).', requestId);
    }
    const message = parsed.message.trim();
    if (message.length === 0) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Field "message" must be a non-empty string.', requestId);
    }
    if (message.length > NUDGE_MAX_MESSAGE_LENGTH) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        `Field "message" exceeds maximum length of ${NUDGE_MAX_MESSAGE_LENGTH} characters.`,
        requestId,
      );
    }

    // 4. Ownership + state check
    const getResult = await ddb.send(new GetCommand({
      TableName: TASK_TABLE_NAME,
      Key: { task_id: taskId },
    }));
    if (!getResult.Item) {
      return errorResponse(404, ErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found.`, requestId);
    }
    const record = getResult.Item as TaskRecord;
    if (record.user_id !== userId) {
      return errorResponse(403, ErrorCode.FORBIDDEN, 'You do not have access to this task.', requestId);
    }
    if (TERMINAL_STATUSES.includes(record.status)) {
      return errorResponse(
        409,
        ErrorCode.TASK_ALREADY_TERMINAL,
        `Task ${taskId} is in terminal state ${record.status}; cannot accept nudges.`,
        requestId,
      );
    }

    const now = new Date();
    const minuteBucket = formatMinuteBucket(now);
    const nowIso = now.toISOString();
    const nowEpoch = Math.floor(now.getTime() / 1000);

    // 5. Guardrail screening (fail-closed).
    //
    // Runs BEFORE the rate-limit counter so a guardrail-blocked message
    // does not consume a rate-limit slot (see handler docstring).
    try {
      const screenResult = await screenWithGuardrail(message, taskId);
      if (screenResult?.action === 'GUARDRAIL_INTERVENED') {
        const details = screenResult.assessments
          ?.map(a => `${a.filter_type}/${a.filter_name}${a.confidence ? ` (${a.confidence})` : ''}`)
          .join(', ');
        const reason = `Nudge message blocked by content policy${details ? ': ' + details : ''}`;
        return errorResponse(400, ErrorCode.VALIDATION_ERROR, reason, requestId);
      }
    } catch (err) {
      if (err instanceof GuardrailScreeningError) {
        logger.error('Guardrail screening failed for nudge (fail-closed)', {
          task_id: taskId,
          request_id: requestId,
          error: err.message,
        });
        return errorResponse(
          503,
          ErrorCode.SERVICE_UNAVAILABLE,
          'Content screening is temporarily unavailable.',
          requestId,
        );
      }
      throw err;
    }

    // 6. Per-task per-minute rate limit.
    //
    // Uses a synthetic row in the nudges table to take advantage of the
    // existing grantReadWriteData wiring and atomic UpdateItem semantics.
    // PK = `RATE#<task_id>` (distinct from real PKs which are task ULIDs),
    // SK = `MINUTE#<yyyymmddhhmm>` (one bucket per wall-clock minute).
    // Short TTL (~2m) cleans up stale counters automatically.
    try {
      await ddb.send(new UpdateCommand({
        TableName: NUDGES_TABLE_NAME,
        Key: {
          task_id: `RATE#${taskId}`,
          nudge_id: `MINUTE#${minuteBucket}`,
        },
        UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
        ExpressionAttributeNames: {
          '#count': 'count',
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':one': 1,
          ':max': RATE_LIMIT_PER_MINUTE,
          ':ttl': nowEpoch + RATE_LIMIT_ROW_TTL_SECONDS,
        },
      }));
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'ConditionalCheckFailedException') {
        return errorResponse(
          429,
          ErrorCode.RATE_LIMIT_EXCEEDED,
          `Rate limit exceeded: at most ${RATE_LIMIT_PER_MINUTE} nudges per minute per task.`,
          requestId,
        );
      }
      throw err;
    }

    // 7. Persist nudge record.
    const nudgeId = ulid();
    const nudgeRecord: NudgeRecord = {
      task_id: taskId,
      nudge_id: nudgeId,
      user_id: userId,
      message,
      created_at: nowIso,
      consumed: false,
      ttl: nowEpoch + NUDGE_RETENTION_SECONDS,
    };
    await ddb.send(new PutCommand({
      TableName: NUDGES_TABLE_NAME,
      Item: nudgeRecord,
    }));

    logger.info('Nudge submitted', {
      task_id: taskId,
      nudge_id: nudgeId,
      user_id: userId,
      request_id: requestId,
      message_length: message.length,
    });

    return successResponse(202, {
      task_id: taskId,
      nudge_id: nudgeId,
      submitted_at: nowIso,
    }, requestId);
  } catch (err) {
    logger.error('Failed to submit nudge', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}

/**
 * Format the current minute as a `yyyymmddhhmm` UTC bucket identifier.
 * @param date - the timestamp to format.
 * @returns 12-character bucket string.
 */
function formatMinuteBucket(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  const h = date.getUTCHours().toString().padStart(2, '0');
  const mi = date.getUTCMinutes().toString().padStart(2, '0');
  return `${y}${m}${d}${h}${mi}`;
}
