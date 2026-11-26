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
import { TaskStatus } from '../constructs/task-status';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { type TaskRecord, toTaskDetail } from './shared/types';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const TABLE_NAME = process.env.TASK_TABLE_NAME!;

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');

const QUEUE_ETA_AVG_TASK_DURATION_S = Number(process.env.QUEUE_ETA_AVG_TASK_DURATION_S ?? '600');

async function computeQueueInfo(
  record: TaskRecord,
): Promise<{ queue_position: number; estimated_wait_s: number | null } | undefined> {
  try {
    let ahead = 0;
    let found = false;
    let lastKey: Record<string, unknown> | undefined;
    do {
      const resp = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'UserStatusIndex',
        KeyConditionExpression: 'user_id = :uid AND begins_with(status_created_at, :queued)',
        ExpressionAttributeValues: {
          ':uid': record.user_id,
          ':queued': `${TaskStatus.QUEUED}#`,
        },
        ProjectionExpression: 'task_id, created_at',
        ExclusiveStartKey: lastKey as Record<string, never> | undefined,
      }));
      for (const item of resp.Items ?? []) {
        if (item.task_id === record.task_id) {
          found = true;
        } else if (
          typeof item.created_at === 'string'
          && (item.created_at < record.created_at
            || (item.created_at === record.created_at
              && typeof item.task_id === 'string'
              && item.task_id < record.task_id))
        ) {
          ahead++;
        }
      }
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    if (!found) {
      return undefined;
    }

    const position = ahead + 1;
    const estimatedWaitS = MAX_CONCURRENT > 0 && QUEUE_ETA_AVG_TASK_DURATION_S > 0
      ? Math.ceil(position / MAX_CONCURRENT) * QUEUE_ETA_AVG_TASK_DURATION_S
      : null;
    return { queue_position: position, estimated_wait_s: estimatedWaitS };
  } catch (err) {
    logger.warn('Queue position lookup failed (fail-open — returning null position)', {
      task_id: record.task_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined; // nosemgrep: ts-silent-success-masking -- queue position is a best-effort UX hint; a GSI failure must not fail the whole GET /tasks/{id}
  }
}

/**
 * GET /v1/tasks/{task_id} — Get full task details.
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

    const result = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
    }));

    if (!result.Item) {
      return errorResponse(404, ErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found.`, requestId);
    }

    const record = result.Item as TaskRecord;
    if (record.user_id !== userId) {
      return errorResponse(403, ErrorCode.FORBIDDEN, 'You do not have access to this task.', requestId);
    }

    const queueInfo = record.status === TaskStatus.QUEUED
      ? await computeQueueInfo(record)
      : undefined;

    return successResponse(200, toTaskDetail(record, queueInfo), requestId);
  } catch (err) {
    logger.error('Failed to get task', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
