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
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { formatMinuteBucket } from './shared/rate-limit';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { GetPendingResponse, PendingApprovalSummary, Severity } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TASK_APPROVALS_TABLE_NAME = process.env.TASK_APPROVALS_TABLE_NAME;
if (!TASK_APPROVALS_TABLE_NAME) {
  throw new Error('get-pending handler requires TASK_APPROVALS_TABLE_NAME env var');
}
const USER_STATUS_INDEX_NAME = process.env.USER_STATUS_INDEX_NAME ?? 'user_id-status-index';
const PENDING_RATE_LIMIT_PER_MINUTE = Number(process.env.PENDING_RATE_LIMIT_PER_MINUTE ?? '10');
const PENDING_LIST_LIMIT = 100;

/**
 * GET /v1/pending — List pending approvals owned by the caller (§7.7).
 *
 * Backed by the `user_id-status-index` GSI on `TaskApprovalsTable`.
 * Without the GSI a Scan would touch every approval row on every
 * `watch -n1 bgagent pending` call and exhaust DDB burst capacity for
 * the whole fleet (§10.1 finding #8).
 *
 * Rate-limited 10/min/user to belt-and-suspenders the GSI — runaway
 * polling from a single user is capped before it touches the GSI at
 * all.
 *
 * Response contains a `pending[]` of summaries, each with
 * `expires_at` derived from `created_at + timeout_s` so the CLI can
 * render time-to-timeout without the user doing the math.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const nowEpoch = Math.floor(Date.now() / 1000);

    // Per-user per-minute rate limit. Uses a synthetic row on the
    // approvals table with `RATE#<user_id>#PENDING` PK to avoid
    // colliding with the approve/deny counter (same table but
    // different PK namespace).
    const minuteBucket = formatMinuteBucket(new Date());
    try {
      await ddb.send(new UpdateCommand({
        TableName: TASK_APPROVALS_TABLE_NAME,
        Key: {
          task_id: `RATE#${userId}#PENDING`,
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
          ':max': PENDING_RATE_LIMIT_PER_MINUTE,
          ':ttl': nowEpoch + 120,
        },
      }));
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'ConditionalCheckFailedException') {
        return errorResponse(
          429,
          ErrorCode.RATE_LIMIT_EXCEEDED,
          `Rate limit exceeded: at most ${PENDING_RATE_LIMIT_PER_MINUTE} pending-list queries per minute.`,
          requestId,
        );
      }
      throw err;
    }

    const result = await ddb.send(new QueryCommand({
      TableName: TASK_APPROVALS_TABLE_NAME,
      IndexName: USER_STATUS_INDEX_NAME,
      KeyConditionExpression: 'user_id = :user AND #status = :pending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':user': userId,
        ':pending': 'PENDING',
      },
      Limit: PENDING_LIST_LIMIT,
    }));

    const items = (result.Items ?? []) as ReadonlyArray<Record<string, unknown>>;
    const pending: PendingApprovalSummary[] = items.map((row) => {
      const created_at = String(row.created_at ?? '');
      const timeout_s = Number(row.timeout_s ?? 0);
      const expires_at = computeExpiresAt(created_at, timeout_s);
      return {
        task_id: String(row.task_id ?? ''),
        request_id: String(row.request_id ?? ''),
        tool_name: String(row.tool_name ?? ''),
        tool_input_preview: String(row.tool_input_preview ?? ''),
        severity: coerceSeverity(row.severity),
        reason: String(row.reason ?? ''),
        created_at,
        timeout_s,
        expires_at,
        matching_rule_ids: coerceStringList(row.matching_rule_ids),
      };
    });

    logger.info('Pending approvals listed', {
      user_id: userId,
      count: pending.length,
      request_id: requestId,
    });

    const response: GetPendingResponse = { pending };
    return successResponse(200, response, requestId);
  } catch (err) {
    logger.error('Failed to list pending approvals', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}

function coerceSeverity(value: unknown): Severity {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return 'medium';
}

function coerceStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function computeExpiresAt(createdAt: string, timeoutS: number): string {
  if (!createdAt || !Number.isFinite(timeoutS) || timeoutS <= 0) {
    return createdAt;
  }
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) {
    return createdAt;
  }
  return new Date(created + timeoutS * 1000).toISOString();
}
