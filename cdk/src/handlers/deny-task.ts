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

import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ulid } from 'ulid';
import { recordDecisionPostCommit } from './shared/approval-decision';
import { scanDenyReason } from './shared/deny-reason-scanner';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { formatMinuteBucket, RATE_LIMIT_ROW_TTL_SECONDS } from './shared/rate-limit';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { DENY_REASON_MAX_LENGTH, type DenyRequest, type DenyResponse } from './shared/types';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const TASK_TABLE_NAME = process.env.TASK_TABLE_NAME;
const TASK_APPROVALS_TABLE_NAME = process.env.TASK_APPROVALS_TABLE_NAME;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME;
if (!TASK_TABLE_NAME || !TASK_APPROVALS_TABLE_NAME || !EVENTS_TABLE_NAME) {
  throw new Error(
    'deny-task handler requires TASK_TABLE_NAME, TASK_APPROVALS_TABLE_NAME, and TASK_EVENTS_TABLE_NAME env vars',
  );
}
const DENY_RATE_LIMIT_PER_MINUTE = Number(process.env.APPROVE_RATE_LIMIT_PER_MINUTE ?? '30');
const AUDIT_EVENT_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');

/**
 * POST /v1/tasks/{task_id}/deny — User denies a pending approval.
 *
 *   - `reason` (optional) runs through `scanDenyReason` BEFORE
 *     persistence so secrets (AWS keys, GitHub PATs, private keys)
 *     are never stored or read by the agent.
 *   - Sanitized reason is truncated to `DENY_REASON_MAX_LENGTH`
 *     characters.
 *   - Response is 202 with `{task_id, request_id, status: DENIED,
 *     decided_at}`.
 */
export async function handler(
  event: APIGatewayProxyEvent, context?: Pick<Context, 'getRemainingTimeInMillis'>,
): Promise<APIGatewayProxyResult> {
  const invocationStartedMs = Date.now();
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

    let parsed: DenyRequest | null = null;
    try {
      parsed = event.body ? JSON.parse(event.body) as DenyRequest : null;
    } catch {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON.', requestId);
    }
    if (!parsed || typeof parsed.request_id !== 'string' || parsed.decision !== 'deny') {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Missing or invalid required fields: request_id (string), decision ("deny").',
        requestId,
      );
    }
    const { request_id, reason: rawReason } = parsed;
    if (rawReason != null && typeof rawReason !== 'string') {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid reason. Must be a string.', requestId);
    }

    const sanitizedReason = rawReason
      ? scanDenyReason(rawReason.slice(0, 10 * DENY_REASON_MAX_LENGTH)).slice(0, DENY_REASON_MAX_LENGTH)
      : '';

    const nowIso = new Date().toISOString();
    const nowEpoch = Math.floor(Date.now() / 1000);

    const minuteBucket = formatMinuteBucket(new Date());
    try {
      await ddb.send(new UpdateCommand({
        TableName: TASK_APPROVALS_TABLE_NAME,
        Key: {
          task_id: `RATE#${callerUserId}#APPROVE`,
          request_id: `MINUTE#${minuteBucket}`,
        },
        UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
        ExpressionAttributeNames: {
          '#count': 'count',
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':one': 1,
          ':max': DENY_RATE_LIMIT_PER_MINUTE,
          ':ttl': nowEpoch + RATE_LIMIT_ROW_TTL_SECONDS,
        },
      }));
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'ConditionalCheckFailedException') {
        return errorResponse(
          429,
          ErrorCode.RATE_LIMIT_EXCEEDED,
          `Rate limit exceeded: at most ${DENY_RATE_LIMIT_PER_MINUTE} approve/deny decisions per minute.`,
          requestId,
        );
      }
      throw err;
    }

    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TASK_APPROVALS_TABLE_NAME,
              Key: { task_id: taskId, request_id },
              UpdateExpression:
                'SET #status = :denied, decided_at = :now, deny_reason = :reason',
              ConditionExpression:
                'attribute_exists(request_id) AND #status = :pending AND user_id = :caller '
                  + 'AND (attribute_not_exists(deadline_epoch) OR deadline_epoch > :epoch)',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':denied': 'DENIED',
                ':pending': 'PENDING',
                ':now': nowIso,
                ':reason': sanitizedReason,
                ':caller': callerUserId,
                ':epoch': nowEpoch,
              },
            },
          },
          {
            Update: {
              TableName: TASK_TABLE_NAME,
              Key: { task_id: taskId },
              UpdateExpression: 'SET last_decision_at = :now',
              ConditionExpression:
                '#status = :awaiting AND awaiting_approval_request_id = :rid',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':awaiting': 'AWAITING_APPROVAL',
                ':rid': request_id,
                ':now': nowIso,
              },
            },
          },
        ],
      }));
    } catch (err: unknown) {
      if (err instanceof TransactionCanceledException) {
        return classifyCancel(err, requestId);
      }
      throw err;
    }

    await recordDecisionPostCommit({
      ddb,
      eventsTableName: EVENTS_TABLE_NAME!,
      taskId,
      callerUserId,
      requestId: request_id,
      decision: 'DENIED',
      auditMetadata: { reason: sanitizedReason },
      decidedAt: nowIso,
      nowEpoch,
      retentionDays: AUDIT_EVENT_RETENTION_DAYS,
      invocationStartedMs,
      context,
    });

    logger.info('Denial recorded', {
      task_id: taskId,
      request_id,
      user_id: callerUserId,
      reason_length: sanitizedReason.length,
      request_id_header: requestId,
    });

    const response: DenyResponse = {
      task_id: taskId,
      request_id,
      status: 'DENIED',
      decided_at: nowIso,
    };
    return successResponse(202, response, requestId);
  } catch (err) {
    logger.error('Failed to record denial', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}

function classifyCancel(
  err: TransactionCanceledException,
  requestId: string,
): APIGatewayProxyResult {
  const reasons = err.CancellationReasons ?? [];
  const approvalsReason = reasons[0]?.Code;
  const taskReason = reasons[1]?.Code;

  if (approvalsReason === 'ConditionalCheckFailed') {
    return errorResponse(
      404,
      ErrorCode.REQUEST_NOT_FOUND,
      'Approval request not found or not owned by caller.',
      requestId,
    );
  }
  if (taskReason === 'ConditionalCheckFailed') {
    return errorResponse(
      409,
      ErrorCode.TASK_NOT_AWAITING_APPROVAL,
      'Task is not currently awaiting approval for this request.',
      requestId,
    );
  }
  return errorResponse(
    503,
    ErrorCode.SERVICE_UNAVAILABLE,
    'Denial transaction cancelled for unknown reason.',
    requestId,
  );
}
