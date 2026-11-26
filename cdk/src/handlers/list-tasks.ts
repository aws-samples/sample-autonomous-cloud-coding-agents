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
import { TERMINAL_STATUSES, type TaskStatusType } from '../constructs/task-status';
import { loadPersonalBudgetStatus } from './shared/budgets';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, paginatedResponse, successResponse } from './shared/response';
import { buildScoreboard, parseScoreboardRange, SCOREBOARD_PROJECTION, type ScoreboardTask, scoreboardWindows } from './shared/scoreboard';
import { type Scoreboard, type ScoreboardRange, type TaskRecord, toTaskSummary } from './shared/types';
import { makeDocClient } from './shared/ua';
import { decodePaginationToken, encodePaginationToken, isValidRepo, parseLimit, parseStatusFilter } from './shared/validation';

const ddb = makeDocClient();
const TABLE_NAME = process.env.TASK_TABLE_NAME!;

const DEFAULT_PAGE_LIMIT = 20;

const MAX_PAGE_LIMIT = 100;

// DynamoDB applies `Limit` to the items it reads, before `FilterExpression`: a filtered page can come back short.
const MAX_QUERY_PAGES = 10;

const SORT_KEY_OF = { UserCreatedAtIndex: 'created_at', UserStatusIndex: 'status_created_at' } as const;

// CloudFormation does not wait for a new global secondary index to finish building, and
// DynamoDB rejects a query on an index that is not ACTIVE.
let createdAtIndexActive = false;

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

// A DynamoDB Query page reads up to 1 MB of whole items, whatever the projection returns.
const SCOREBOARD_PAGES_PER_STATUS = 6;

function secondAfterCut(cutKey: unknown): number {
  const cutMs = typeof cutKey === 'string' ? Date.parse(cutKey.slice(cutKey.indexOf('#') + 1)) : NaN;
  if (!Number.isFinite(cutMs)) {
    throw new Error(`Scoreboard read stopped at a key that holds no time: ${JSON.stringify(cutKey)}`);
  }
  return (Math.floor(cutMs / 1000) + 1) * 1000;
}

async function readFinishedTasks(
  userId: string,
  status: TaskStatusType,
  since: Date,
): Promise<{ tasks: ScoreboardTask[]; coveredFromMs?: number }> {
  const tasks: ScoreboardTask[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < SCOREBOARD_PAGES_PER_STATUS; page += 1) {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'UserStatusIndex',
      KeyConditionExpression: 'user_id = :uid AND status_created_at BETWEEN :lo AND :hi',
      ExpressionAttributeValues: { ':uid': userId, ':lo': `${status}#${since.toISOString()}`, ':hi': `${status}#~` },
      ...SCOREBOARD_PROJECTION,
      ScanIndexForward: false,
      ...(startKey && { ExclusiveStartKey: startKey }),
    }));
    tasks.push(...((result.Items ?? []) as ScoreboardTask[]));
    startKey = result.LastEvaluatedKey;
    if (!startKey) return { tasks };
  }
  return { tasks, coveredFromMs: secondAfterCut(startKey?.status_created_at) };
}

async function loadScoreboard(userId: string, range: ScoreboardRange, now: Date, repo?: string): Promise<Scoreboard> {
  const { previousFrom } = scoreboardWindows(range, now);
  // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism -- one read per terminal status: four
  const reads = await Promise.all(TERMINAL_STATUSES.map((status) => readFinishedTasks(userId, status, previousFrom)));
  const cuts = reads.map((read) => read.coveredFromMs).filter((cutMs) => cutMs !== undefined);
  const coveredFrom = cuts.length > 0 ? new Date(Math.max(...cuts)) : undefined;
  if (coveredFrom) {
    logger.warn('Scoreboard read stopped at its page cap', { user_id: userId, range, covered_from: coveredFrom.toISOString() });
  }
  const tasks = reads.flatMap((read) => read.tasks);
  // On GitHub a repository's name is the same name in any letter case.
  const wanted = repo?.toLowerCase();
  const counted = wanted === undefined ? tasks : tasks.filter((task) => typeof task.repo === 'string' && task.repo.toLowerCase() === wanted);
  return buildScoreboard(counted, range, now, coveredFrom);
}

async function viewResponse(
  view: string,
  query: { range?: string; repo?: string },
  userId: string,
  requestId: string,
): Promise<APIGatewayProxyResult> {
  if (view === 'budget') {
    return successResponse(200, await loadPersonalBudgetStatus(userId), requestId);
  }
  if (view === 'scoreboard') {
    const range = parseScoreboardRange(query.range);
    if (range === null) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid range value. Expected "7d" or "30d".', requestId);
    }
    if (query.repo !== undefined && !isValidRepo(query.repo)) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid repo value. Expected "owner/name".', requestId);
    }
    return successResponse(200, await loadScoreboard(userId, range, new Date(), query.repo), requestId);
  }
  return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid view value. Expected "budget" or "scoreboard".', requestId);
}

/**
 * GET /v1/tasks — List tasks for the authenticated user, or serve the read model `?view=` names.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    const params = event.queryStringParameters ?? {};
    if (params.view !== undefined) {
      return await viewResponse(params.view, params, userId, requestId);
    }
    const limit = parseLimit(params.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const statusFilter = params.status !== undefined ? parseStatusFilter(params.status) : null;
    const repoFilter = params.repo;
    let startKey = decodePaginationToken(params.next_token);
    if (startKey === null) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid next_token.', requestId);
    }

    if (params.status !== undefined && statusFilter === null) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid status filter value.', requestId);
    }

    const exprValues: Record<string, unknown> = { ':uid': userId };
    const exprNames: Record<string, string> = {};
    const filterParts: string[] = [];

    if (statusFilter && statusFilter.length > 0) {
      const statusConditions = statusFilter.map((s, i) => {
        exprValues[`:st${i}`] = s;
        return `#status = :st${i}`;
      });
      exprNames['#status'] = 'status';
      filterParts.push(`(${statusConditions.join(' OR ')})`);
    }

    if (repoFilter) {
      exprValues[':repo'] = repoFilter;
      exprNames['#repo'] = 'repo';
      filterParts.push('#repo = :repo');
    }

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

    const last = pageItems[pageItems.length - 1];
    const sortKey = SORT_KEY_OF[index];
    const nextToken = items.length > limit
      ? encodePaginationToken({ task_id: last.task_id, user_id: last.user_id, [sortKey]: last[sortKey] })
      : encodePaginationToken(startKey);

    return paginatedResponse(pageItems.map(toTaskSummary), nextToken, requestId);
  } catch (err) {
    logger.error('Failed to list tasks', { error: String(err), request_id: requestId, view: event.queryStringParameters?.view });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
