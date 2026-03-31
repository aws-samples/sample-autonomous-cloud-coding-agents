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
import { decodePaginationToken, encodePaginationToken, parseLimit } from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE_NAME = process.env.TASK_EVENTS_TABLE_NAME!;

/**
 * GET /v1/tasks/{task_id}/events — Get task event audit trail.
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

    // 3. Verify task exists and user owns it
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

    // 4. Parse pagination parameters
    const params = event.queryStringParameters ?? {};
    const limit = parseLimit(params.limit, 50, 100);
    const startKey = decodePaginationToken(params.next_token);

    // 5. Query events
    const queryInput: Record<string, unknown> = {
      TableName: EVENTS_TABLE_NAME,
      KeyConditionExpression: 'task_id = :tid',
      ExpressionAttributeValues: { ':tid': taskId },
      ScanIndexForward: true,
      Limit: limit,
    };

    if (startKey) {
      queryInput.ExclusiveStartKey = startKey;
    }

    const result = await ddb.send(new QueryCommand(queryInput as any));
    const events = (result.Items ?? []) as EventRecord[];

    // 6. Strip task_id from event records (redundant in response context)
    const eventData = events.map(e => ({
      event_id: e.event_id,
      event_type: e.event_type,
      timestamp: e.timestamp,
      metadata: e.metadata ?? {},
    }));

    const nextToken = encodePaginationToken(result.LastEvaluatedKey as Record<string, unknown> | undefined);

    return paginatedResponse(eventData, nextToken, requestId);
  } catch (err) {
    logger.error('Failed to get task events', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
