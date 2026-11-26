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

import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, paginatedResponse } from './shared/response';
import type { EventRecord, TaskRecord } from './shared/types';
import { makeDocClient } from './shared/ua';
import {
  decodePaginationToken,
  encodePaginationToken,
  isValidUlid,
  parseLimit,
  ULID_LENGTH,
} from './shared/validation';

const ddb = makeDocClient();
const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;
const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase();
const DEBUG_ENABLED = LOG_LEVEL === 'DEBUG';

const DEFAULT_PAGE_LIMIT = 50;

const MAX_PAGE_LIMIT = 100;

type QueryMode = 'from_beginning' | 'next_token' | 'after' | 'desc';

/**
 * GET /v1/tasks/{task_id}/events — Get task event audit trail.
 *
 * Supports three alternative query modes (plus the default "from the beginning"):
 *
 *   - ``?after=<event_id>`` — ULID cursor. Query returns events with
 *     ``event_id > after``.
 *   - ``?next_token=<base64>`` — opaque DynamoDB ``LastEvaluatedKey``,
 *     used for normal forward pagination.
 *   - ``?desc=1`` — return the newest events first. Mutually exclusive with
 *     ``after``; the combination is rejected as 400. No ``next_token`` is
 *     emitted in this mode.
 *
 * If both ``after`` and ``next_token`` are provided, ``after`` wins. If none
 * are provided, the query starts from the oldest event. In the ascending
 * modes, when the result is truncated at ``limit`` a ``next_token`` is
 * emitted.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const taskId = event.pathParameters?.task_id;
    if (!taskId) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing task_id path parameter.', requestId);
    }

    const params = event.queryStringParameters ?? {};
    const limit = parseLimit(params.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const afterRaw = params.after;
    const nextTokenRaw = params.next_token;
    const descRaw = params.desc;
    const desc = typeof descRaw === 'string'
      && (descRaw === '1' || descRaw.toLowerCase() === 'true');

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

    const afterValid = typeof afterRaw === 'string' && afterRaw.length === ULID_LENGTH
      ? afterRaw.toUpperCase()
      : undefined;

    if (desc && afterValid) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Parameters `desc` and `after` are mutually exclusive.',
        requestId,
      );
    }

    if (afterValid && nextTokenRaw) {
      logger.warn('Both after and next_token provided; preferring after', {
        request_id: requestId,
        task_id: taskId,
      });
    }

    const startKey = afterValid ? undefined : decodePaginationToken(nextTokenRaw ?? undefined);
    if (startKey === null) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid next_token.', requestId);
    }

    const queryMode: QueryMode = afterValid
      ? 'after'
      : desc
        ? 'desc'
        : startKey
          ? 'next_token'
          : 'from_beginning';

    logger.info('get-task-events invoked', {
      request_id: requestId,
      task_id: taskId,
      limit,
      query_mode: queryMode,
    });

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

    const queryInput: Record<string, unknown> = {
      TableName: EVENTS_TABLE_NAME,
      KeyConditionExpression: afterValid
        ? 'task_id = :tid AND event_id > :after'
        : 'task_id = :tid',
      ExpressionAttributeValues: afterValid
        ? { ':tid': taskId, ':after': afterValid }
        : { ':tid': taskId },
      ScanIndexForward: !desc,
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

    const eventData = events.map(e => ({
      event_id: e.event_id,
      event_type: e.event_type,
      timestamp: e.timestamp,
      metadata: e.metadata ?? {},
      ...(e.user_id && { user_id: e.user_id }),
      ...(e.repo && { repo: e.repo }),
      ...(e.trace_id && { trace_id: e.trace_id }),
    }));

    const nextToken = desc
      ? null
      : encodePaginationToken(result.LastEvaluatedKey as Record<string, unknown> | undefined);

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
