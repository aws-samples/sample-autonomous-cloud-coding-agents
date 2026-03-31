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
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { type TaskRecord, toTaskDetail } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TASK_TABLE_NAME!;

/**
 * GET /v1/tasks/{task_id} — Get full task details.
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

    // 3. Get task from DynamoDB
    const result = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { task_id: taskId },
    }));

    if (!result.Item) {
      return errorResponse(404, ErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found.`, requestId);
    }

    // 4. Ownership check
    const record = result.Item as TaskRecord;
    if (record.user_id !== userId) {
      return errorResponse(403, ErrorCode.FORBIDDEN, 'You do not have access to this task.', requestId);
    }

    // 5. Return task detail
    return successResponse(200, toTaskDetail(record), requestId);
  } catch (err) {
    logger.error('Failed to get task', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
