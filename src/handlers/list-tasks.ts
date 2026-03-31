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
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, paginatedResponse } from './shared/response';
import { type TaskRecord, toTaskSummary } from './shared/types';
import { decodePaginationToken, encodePaginationToken, parseLimit, parseStatusFilter } from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TASK_TABLE_NAME!;

/**
 * GET /v1/tasks — List tasks for the authenticated user.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    // 1. Extract authenticated user
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    // 2. Parse query parameters
    const params = event.queryStringParameters ?? {};
    const limit = parseLimit(params.limit, 20, 100);
    const statusFilter = params.status !== undefined ? parseStatusFilter(params.status) : null;
    const repoFilter = params.repo;
    const startKey = decodePaginationToken(params.next_token);

    // Validate status filter — returns null for invalid values
    if (params.status !== undefined && statusFilter === null) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid status filter value.', requestId);
    }

    // 3. Build query
    const exprValues: Record<string, unknown> = { ':uid': userId };
    const exprNames: Record<string, string> = {};
    const filterParts: string[] = [];

    // Filter by status
    if (statusFilter && statusFilter.length > 0) {
      const statusConditions = statusFilter.map((s, i) => {
        exprValues[`:st${i}`] = s;
        return `#status = :st${i}`;
      });
      exprNames['#status'] = 'status';
      filterParts.push(`(${statusConditions.join(' OR ')})`);
    }

    // Filter by repo
    if (repoFilter) {
      exprValues[':repo'] = repoFilter;
      exprNames['#repo'] = 'repo';
      filterParts.push('#repo = :repo');
    }

    const queryInput: Record<string, unknown> = {
      TableName: TABLE_NAME,
      IndexName: 'UserStatusIndex',
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: exprValues,
      ScanIndexForward: false,
      Limit: limit,
    };

    if (filterParts.length > 0) {
      queryInput.FilterExpression = filterParts.join(' AND ');
    }
    if (Object.keys(exprNames).length > 0) {
      queryInput.ExpressionAttributeNames = exprNames;
    }
    if (startKey) {
      queryInput.ExclusiveStartKey = startKey;
    }

    // 4. Execute query
    const result = await ddb.send(new QueryCommand(queryInput as any));
    const items = (result.Items ?? []) as TaskRecord[];
    const summaries = items.map(toTaskSummary);

    // 5. Encode pagination token
    const nextToken = encodePaginationToken(result.LastEvaluatedKey as Record<string, unknown> | undefined);

    return paginatedResponse(summaries, nextToken, requestId);
  } catch (err) {
    logger.error('Failed to list tasks', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
