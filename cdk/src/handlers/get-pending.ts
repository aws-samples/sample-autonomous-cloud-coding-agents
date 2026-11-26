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

import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { formatMinuteBucket, RATE_LIMIT_ROW_TTL_SECONDS } from './shared/rate-limit';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { GetPendingResponse, PendingApprovalSummary, Severity } from './shared/types';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const TASK_APPROVALS_TABLE_NAME = process.env.TASK_APPROVALS_TABLE_NAME;
if (!TASK_APPROVALS_TABLE_NAME) {
  throw new Error('get-pending handler requires TASK_APPROVALS_TABLE_NAME env var');
}
const USER_STATUS_INDEX_NAME = process.env.USER_STATUS_INDEX_NAME ?? 'user_id-status-index';
const PENDING_RATE_LIMIT_PER_MINUTE = Number(process.env.PENDING_RATE_LIMIT_PER_MINUTE ?? '60');
const PENDING_LIST_LIMIT = 100;
const PENDING_MAX_PAGES = 20;

/**
 * GET /v1/pending — List pending approvals owned by the caller (§7.7).
 *
 * Rate-limited 60/min/user by default.
 *
 * A request whose window has passed is not listed. At most 20 pages are
 * read for one request, so a live request behind 2,000 such rows is not
 * listed.
 *
 * Response contains a `pending[]` of summaries, each with
 * `expires_at` derived from `created_at + timeout_s`.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const nowEpoch = Math.floor(Date.now() / 1000);

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
          ':ttl': nowEpoch + RATE_LIMIT_ROW_TTL_SECONDS,
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

    const live: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    let pages = 0;
    do {
      const page = await ddb.send(new QueryCommand({
        TableName: TASK_APPROVALS_TABLE_NAME,
        IndexName: USER_STATUS_INDEX_NAME,
        KeyConditionExpression: 'user_id = :user AND #status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':user': userId,
          ':pending': 'PENDING',
        },
        Limit: PENDING_LIST_LIMIT,
        ExclusiveStartKey: startKey,
      }));
      live.push(...(page.Items ?? []).filter((row) => !windowHasPassed(row, nowEpoch)));
      startKey = page.LastEvaluatedKey;
      pages += 1;
    } while (startKey && live.length < PENDING_LIST_LIMIT && pages < PENDING_MAX_PAGES);
    if (startKey && live.length < PENDING_LIST_LIMIT) {
      logger.warn('Pending list stopped at its page cap; requests behind the rows read are not listed', {
        user_id: userId,
        pages,
        request_id: requestId,
      });
    }

    const items: ReadonlyArray<Record<string, unknown>> = live.slice(0, PENDING_LIST_LIMIT);
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

function windowHasPassed(row: Record<string, unknown>, nowEpoch: number): boolean {
  const timeoutS = Number(row.timeout_s ?? 0);
  return timeoutS > 0 && Date.parse(String(row.created_at ?? '')) / 1000 + timeoutS <= nowEpoch;
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
