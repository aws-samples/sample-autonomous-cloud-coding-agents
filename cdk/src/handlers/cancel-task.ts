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

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { TaskStatus, TERMINAL_STATUSES } from '../constructs/task-status';
import { cancelTask, stopTaskCompute } from './shared/cancel-task-core';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import type { TaskRecord } from './shared/types';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');

/**
 * DELETE /v1/tasks/{task_id} — Cancel a task.
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

    // 3. Get current task state
    const result = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
      ConsistentRead: true,
    }));

    if (!result.Item) {
      return errorResponse(404, ErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found.`, requestId);
    }

    // 4. Ownership check
    const record = result.Item as TaskRecord;
    if (record.user_id !== userId) {
      return errorResponse(403, ErrorCode.FORBIDDEN, 'You do not have access to this task.', requestId);
    }

    // 5. Check if already terminal
    if (TERMINAL_STATUSES.includes(record.status)) {
      return errorResponse(409, ErrorCode.TASK_ALREADY_TERMINAL, `Task ${taskId} is already in terminal state ${record.status}.`, requestId);
    }

    // 6. Cancel: CANCELLED transition + task_cancelled event in one transaction,
    // conditioned on the task not having reached a terminal state first.
    const now = new Date().toISOString();
    const cancelTables = {
      ddb,
      taskTableName: TABLE_NAME,
      taskEventsTableName: EVENTS_TABLE_NAME,
      retentionDays: TASK_RETENTION_DAYS,
    };
    if (await cancelTask(cancelTables, taskId, userId, now) === 'already_terminal') {
      return errorResponse(409, ErrorCode.TASK_ALREADY_TERMINAL, `Task ${taskId} transitioned to a terminal state.`, requestId);
    }

    // 7. Stop the compute session so the container winds down (best-effort)
    await stopTaskCompute(cancelTables, record, now, requestId);

    logger.info('Task cancelled', { task_id: taskId, user_id: userId, request_id: requestId });

    return successResponse(200, {
      task_id: taskId,
      status: TaskStatus.CANCELLED,
      cancelled_at: now,
    }, requestId);
  } catch (err) {
    logger.error('Failed to cancel task', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
