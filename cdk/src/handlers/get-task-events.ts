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
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, paginatedResponse } from './shared/response';
import type { EventRecord, TaskRecord } from './shared/types';
import {
  decodePaginationToken,
  encodePaginationToken,
  isValidUlid,
  parseLimit,
} from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;
const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase();
const DEBUG_ENABLED = LOG_LEVEL === 'DEBUG';

/** Query mode resolved from query parameters for structured logging. */
type QueryMode = 'from_beginning' | 'next_token' | 'after';

/**
 * GET /v1/tasks/{task_id}/events — Get task event audit trail.
 *
 * Supports two alternative pagination modes (plus the default "from the beginning"):
 *
 *   - ``?after=<event_id>`` — ULID cursor. Query returns events with
 *     ``event_id > after``. Used by CLI polling and webhook replay to
 *     resume from a known event id. ULIDs are lexicographically sortable
 *     by timestamp, so string ``>`` compare is correct.
 *   - ``?next_token=<base64>`` — opaque DynamoDB ``LastEvaluatedKey``,
 *     used for normal forward pagination.
 *
 * If both are provided, ``after`` wins (a WARN is logged — likely a client bug).
 * If neither is provided, the query starts from the oldest event.
 * In all modes, when the result is truncated at ``limit`` a ``next_token``
 * is emitted so the caller can continue paginating.
 *
 * @param event - API Gateway proxy event.
 * @returns API Gateway proxy result.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    // 1. Extract authenticated user
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    // 2. Extract task_id from path
    const taskId = event.pathParameters?.task_id;
    if (!taskId) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing task_id path parameter.', requestId);
    }

    // 3. Parse pagination parameters
    const params = event.queryStringParameters ?? {};
    const limit = parseLimit(params.limit, 50, 100);
    const afterRaw = params.after;
    const nextTokenRaw = params.next_token;

    // 3a. Validate ``after`` if provided. An invalid ULID shape is a client
    // error — fail fast rather than silently ignoring the cursor.
    if (afterRaw !== undefined && afterRaw !== null && afterRaw !== '' && !isValidUlid(afterRaw)) {
      logger.warn('Invalid after cursor rejected', {
        request_id: requestId,
        task_id: taskId,
        after_len: afterRaw.length,
      });
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Invalid `after` parameter: must be a 26-character ULID.',
        requestId,
      );
    }

    const afterValid = typeof afterRaw === 'string' && afterRaw.length === 26 ? afterRaw : undefined;

    // 3b. ``after`` and ``next_token`` together is always a client bug —
    // one is a user-driven event_id cursor, the other is an opaque
    // pagination token. Prefer ``after`` because it is the more specific,
    // user-driven intent.
    if (afterValid && nextTokenRaw) {
      logger.warn('Both after and next_token provided; preferring after', {
        request_id: requestId,
        task_id: taskId,
      });
    }

    const startKey = afterValid ? undefined : decodePaginationToken(nextTokenRaw ?? undefined);

    const queryMode: QueryMode = afterValid
      ? 'after'
      : startKey
        ? 'next_token'
        : 'from_beginning';

    logger.info('get-task-events invoked', {
      request_id: requestId,
      task_id: taskId,
      limit,
      query_mode: queryMode,
    });

    // 4. Verify task exists and user owns it
    const taskResult = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
    }));

    if (!taskResult.Item) {
      return errorResponse(404, ErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found.`, requestId);
    }

    const taskRecord = taskResult.Item as TaskRecord;
    if (taskRecord.user_id !== userId) {
      return errorResponse(403, ErrorCode.FORBIDDEN, 'You do not have access to this task.', requestId);
    }

    // 5. Build DDB query. When ``after`` is provided we add a sort-key
    // filter ``event_id > :after`` — safe because ULIDs are lexicographic.
    const queryInput: Record<string, unknown> = {
      TableName: EVENTS_TABLE_NAME,
      KeyConditionExpression: afterValid
        ? 'task_id = :tid AND event_id > :after'
        : 'task_id = :tid',
      ExpressionAttributeValues: afterValid
        ? { ':tid': taskId, ':after': afterValid }
        : { ':tid': taskId },
      ScanIndexForward: true,
      Limit: limit,
    };

    if (!afterValid && startKey) {
      queryInput.ExclusiveStartKey = startKey;
    }

    if (DEBUG_ENABLED) {
      logger.info('DDB query prepared (debug)', {
        level_override: 'DEBUG',
        request_id: requestId,
        task_id: taskId,
        key_condition: queryInput.KeyConditionExpression,
        has_exclusive_start_key: Boolean(queryInput.ExclusiveStartKey),
      });
    }

    const result = await ddb.send(new QueryCommand(queryInput as any));
    const events = (result.Items ?? []) as EventRecord[];

    if (DEBUG_ENABLED) {
      logger.info('DDB query returned (debug)', {
        level_override: 'DEBUG',
        request_id: requestId,
        task_id: taskId,
        count: events.length,
        has_last_evaluated_key: Boolean(result.LastEvaluatedKey),
      });
    }

    // 6. Strip task_id from event records (redundant in response context)
    const eventData = events.map(e => ({
      event_id: e.event_id,
      event_type: e.event_type,
      timestamp: e.timestamp,
      metadata: e.metadata ?? {},
    }));

    const nextToken = encodePaginationToken(result.LastEvaluatedKey as Record<string, unknown> | undefined);

    // 7. Warn on unexpectedly empty catch-up — helps debug CLI reconnect logic.
    // We only warn for ``after`` mode because "no events yet" is normal on cold start.
    if (afterValid && events.length === 0) {
      logger.warn('after cursor returned empty page (caller may be at tail)', {
        request_id: requestId,
        task_id: taskId,
        after: afterValid,
      });
    }

    logger.info('get-task-events complete', {
      request_id: requestId,
      task_id: taskId,
      event_count: events.length,
      has_more: nextToken !== null,
      query_mode: queryMode,
    });

    return paginatedResponse(eventData, nextToken, requestId);
  } catch (err) {
    logger.error('Failed to get task events', {
      error: String(err),
      error_type: err instanceof Error ? err.constructor.name : typeof err,
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
