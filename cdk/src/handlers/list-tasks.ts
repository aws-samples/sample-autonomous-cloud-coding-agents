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

import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { loadPersonalBudgetStatus } from './shared/budgets';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, paginatedResponse, successResponse } from './shared/response';
import { type TaskRecord, toTaskSummary } from './shared/types';
import { makeDocClient } from './shared/ua';
import { decodePaginationToken, encodePaginationToken, parseLimit, parseStatusFilter } from './shared/validation';

const ddb = makeDocClient();
const TABLE_NAME = process.env.TASK_TABLE_NAME!;

/** Default page size when the caller omits ``?limit=``. */
const DEFAULT_PAGE_LIMIT = 20;

/** Hard page-size ceiling. */
const MAX_PAGE_LIMIT = 100;

/**
 * Cap on DynamoDB `Query` round-trips per request. `Limit` is applied to items read,
 * before `FilterExpression`, so a status or repo filter can leave a page short; we page
 * until it is full. The cap bounds what one request reads; the token still advances.
 */
const MAX_QUERY_PAGES = 10;

/**
 * The indexes that can serve the list, each with the sort key its cursors carry.
 * UserStatusIndex is the one the list read before #51; it groups tasks by status.
 */
const SORT_KEY_OF = { UserCreatedAtIndex: 'created_at', UserStatusIndex: 'status_created_at' } as const;

/**
 * True once DynamoDB has reported UserCreatedAtIndex as ACTIVE; kept for the life of this
 * execution environment. The deploy that adds the index updates this function without
 * waiting for DynamoDB to build it, and an index cannot be queried until it is ACTIVE.
 * Only that deploy needs this: once every deployed stack has the index, the status check
 * and the reading of UserStatusIndex can go.
 */
let createdAtIndexActive = false;

/**
 * The index to list from: UserCreatedAtIndex once it is ACTIVE, UserStatusIndex until then.
 * @param requestId - for the warning logged while the list is read from UserStatusIndex.
 * @returns the index name.
 */
async function listIndex(requestId: string): Promise<keyof typeof SORT_KEY_OF> {
  if (!createdAtIndexActive) {
    const { Table } = await ddb.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    const status = Table?.GlobalSecondaryIndexes?.find((index) => index.IndexName === 'UserCreatedAtIndex')?.IndexStatus;
    createdAtIndexActive = status === 'ACTIVE';
    if (!createdAtIndexActive) {
      logger.warn('UserCreatedAtIndex is not ACTIVE; listing from UserStatusIndex', { index_status: status ?? 'missing', request_id: requestId });
    }
  }
  return createdAtIndexActive ? 'UserCreatedAtIndex' : 'UserStatusIndex';
}

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
    if (params.view !== undefined && params.view !== 'budget') {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Invalid view value. Expected "budget".',
        requestId,
      );
    }
    if (params.view === 'budget') {
      const budget = await loadPersonalBudgetStatus(userId);
      return successResponse(200, budget, requestId);
    }
    const limit = parseLimit(params.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const statusFilter = params.status !== undefined ? parseStatusFilter(params.status) : null;
    const repoFilter = params.repo;
    let startKey = decodePaginationToken(params.next_token);

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

    // 4. Execute query. Accumulate until the page is full or the index is exhausted;
    // over-fetch one so a full page can tell whether another task follows. A cursor is
    // only valid on the index that issued it, and only UserStatusIndex cursors carry
    // status_created_at.
    const index = startKey?.status_created_at !== undefined ? 'UserStatusIndex' : await listIndex(requestId);
    const items: TaskRecord[] = [];
    for (let page = 0; page < MAX_QUERY_PAGES; page += 1) {
      const result = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: index,
        KeyConditionExpression: 'user_id = :uid',
        ExpressionAttributeValues: exprValues,
        ScanIndexForward: false,
        Limit: limit + 1,
        ...(filterParts.length > 0 && {
          FilterExpression: filterParts.join(' AND '),
          ExpressionAttributeNames: exprNames,
        }),
        ...(startKey && { ExclusiveStartKey: startKey }),
      }));
      items.push(...((result.Items ?? []) as TaskRecord[]));
      startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (items.length > limit || !startKey) break;
    }
    const pageItems = items.slice(0, limit);

    // 5. Encode pagination token. Trimmed: resume after the last task returned
    // (LastEvaluatedKey lies past the over-fetched one). Otherwise the raw cursor,
    // which is only set when the page cap stopped the loop.
    const last = pageItems[pageItems.length - 1];
    const sortKey = SORT_KEY_OF[index];
    const nextToken = items.length > limit
      ? encodePaginationToken({ task_id: last.task_id, user_id: last.user_id, [sortKey]: last[sortKey] })
      : encodePaginationToken(startKey);

    return paginatedResponse(pageItems.map(toTaskSummary), nextToken, requestId);
  } catch (err) {
    logger.error('Failed to list tasks', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
