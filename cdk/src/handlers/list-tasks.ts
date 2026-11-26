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
 * and the list's own reading of UserStatusIndex can go. The scoreboard view keeps reading
 * that index.
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
 * Cap on the pages a scoreboard reads per terminal status. A page holds up to 1 MB of whole
 * records, whatever the projection returns, so the four statuses bound a request at 24 pages.
 */
const SCOREBOARD_PAGES_PER_STATUS = 6;

/**
 * The time from which a status read that the page cap stopped is complete. Read newest
 * first, it holds every key that sorts after the one it stopped at. A key of that same
 * second can still be unread: an equal one, or one with milliseconds, which sorts before
 * the whole-second key of its second. Every key of a later second was read.
 * @param cutKey - `status_created_at` of the `LastEvaluatedKey` the read stopped at.
 * @returns epoch milliseconds of the second after the cut.
 * @throws when the key holds no time: numbers over an unknown window are not reported.
 */
function secondAfterCut(cutKey: unknown): number {
  const cutMs = typeof cutKey === 'string' ? Date.parse(cutKey.slice(cutKey.indexOf('#') + 1)) : NaN;
  if (!Number.isFinite(cutMs)) {
    throw new Error(`Scoreboard read stopped at a key that holds no time: ${JSON.stringify(cutKey)}`);
  }
  return (Math.floor(cutMs / 1000) + 1) * 1000;
}

/**
 * The caller's tasks that entered one terminal status since `since`, newest first.
 * @returns the tasks and, when the page cap stopped the read, the time from which they are complete.
 */
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
      // The sort key is `<STATUS>#<ISO time the status was entered>`. The lower bound has
      // milliseconds, so it keeps the whole-second keys of its own second (`.` sorts
      // before `Z`); `~` sorts after every character of a time.
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

/**
 * The caller's scoreboard: their finished tasks of the range and of the period before it,
 * one read per terminal status.
 * @param now - the time of the request: the windows, the bounds of the read and the response share it.
 * @param repo - when given, only the tasks of that repository are counted.
 */
async function loadScoreboard(userId: string, range: ScoreboardRange, now: Date, repo?: string): Promise<Scoreboard> {
  const { previousFrom } = scoreboardWindows(range, now);
  // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism -- one read per terminal status: four
  const reads = await Promise.all(TERMINAL_STATUSES.map((status) => readFinishedTasks(userId, status, previousFrom)));
  // A status that was cut holds nothing older than its cut, so the scoreboard is complete
  // from the latest cut only: a rate is never computed with one status missing.
  const cuts = reads.map((read) => read.coveredFromMs).filter((cutMs) => cutMs !== undefined);
  const coveredFrom = cuts.length > 0 ? new Date(Math.max(...cuts)) : undefined;
  if (coveredFrom) {
    // The caller is told through the response; this is how an operator sees who outgrows the cap.
    logger.warn('Scoreboard read stopped at its page cap', { user_id: userId, range, covered_from: coveredFrom.toISOString() });
  }
  const tasks = reads.flatMap((read) => read.tasks);
  // The read is the same whatever repository is asked for, so a cut still describes it. A
  // repository's name is the same name in any letter case, on GitHub and in this filter.
  const wanted = repo?.toLowerCase();
  const counted = wanted === undefined ? tasks : tasks.filter((task) => typeof task.repo === 'string' && task.repo.toLowerCase() === wanted);
  return buildScoreboard(counted, range, now, coveredFrom);
}

/**
 * The read models that `?view=` serves on this route in place of a page of tasks. Each is
 * the caller's own.
 * @param query - the `range` and the `repo` of the request, which the scoreboard reads.
 * @returns the view, or a 400 that names the values the parameter takes.
 */
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
    // 1. Extract authenticated user
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    // 2. Parse query parameters
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
    // The view tells a failing read model from a failing list.
    logger.error('Failed to list tasks', { error: String(err), request_id: requestId, view: event.queryStringParameters?.view });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
