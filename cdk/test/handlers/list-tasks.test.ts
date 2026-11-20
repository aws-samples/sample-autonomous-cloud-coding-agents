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

import { BatchGetCommand, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// --- Mocks ---
const mockSend = jest.fn();
/** Answers DescribeTable, so that `mockSend` sees the data-plane calls only. */
const mockDescribeTable = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
  DescribeTableCommand: jest.fn((input: unknown) => ({ _type: 'DescribeTable', input })),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({
      send: (command: { _type: string }) => (command._type === 'DescribeTable' ? mockDescribeTable(command) : mockSend(command)),
    })),
  },
  BatchGetCommand: jest.fn((input: unknown) => ({ _type: 'BatchGet', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.BUDGET_TABLE_NAME = 'Budgets';

import { handler } from '../../src/handlers/list-tasks';
import { SCOREBOARD_TASK_FIELDS, type ScoreboardTask } from '../../src/handlers/shared/scoreboard';
import type { Scoreboard } from '../../src/handlers/shared/types';

const MockQueryCommand = QueryCommand as unknown as jest.Mock;
const MockBatchGetCommand = BatchGetCommand as unknown as jest.Mock;

const TASK_ITEMS = [
  {
    task_id: 'task-1',
    user_id: 'user-123',
    status: 'RUNNING',
    repo: 'org/repo',
    branch_name: 'bgagent/task-1/fix',
    channel_source: 'api',
    status_created_at: 'RUNNING#2025-03-15T10:30:00Z',
    created_at: '2025-03-15T10:30:00Z',
    updated_at: '2025-03-15T10:31:00Z',
  },
  {
    task_id: 'task-2',
    user_id: 'user-123',
    status: 'COMPLETED',
    repo: 'org/other',
    branch_name: 'bgagent/task-2/feature',
    channel_source: 'api',
    status_created_at: 'COMPLETED#2025-03-14T10:00:00Z',
    created_at: '2025-03-14T10:00:00Z',
    updated_at: '2025-03-14T12:00:00Z',
    completed_at: '2025-03-14T11:58:00Z',
    cost_usd: 1.25,
  },
];

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/v1/tasks',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/tasks',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: { claims: { sub: 'user-123' } },
      httpMethod: 'GET',
      identity: {
        sourceIp: '1.2.3.4',
        userAgent: 'test/1.0',
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        user: null,
        userArn: null,
      },
      path: '/v1/tasks',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/tasks',
      stage: 'v1',
    },
    ...overrides,
  };
}

/** A DescribeTable answer in which UserCreatedAtIndex has the given status, or is missing. */
const describedWith = (IndexStatus?: string) => ({
  Table: {
    GlobalSecondaryIndexes: [
      { IndexName: 'UserStatusIndex', IndexStatus: 'ACTIVE' },
      ...(IndexStatus ? [{ IndexName: 'UserCreatedAtIndex', IndexStatus }] : []),
    ],
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({ Items: TASK_ITEMS });
  mockDescribeTable.mockResolvedValue(describedWith('ACTIVE'));
});

describe('list-tasks handler', () => {
  test('returns task summaries', async () => {
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].task_id).toBe('task-1');
    expect(body.data[1].task_id).toBe('task-2');
    // Summary should not include detail-only fields
    expect(body.data[0].session_id).toBeUndefined();
    expect(body.data[0].error_message).toBeUndefined();
    expect(body.pagination.has_more).toBe(false);
    expect(body.pagination.next_token).toBeNull();
  });

  test('returns only the authenticated user personal budget for view=budget', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-21T12:00:00Z'));
    mockSend.mockResolvedValueOnce({
      Responses: {
        Budgets: [
          {
            scope_key: 'USER#user-123',
            period: 'CONFIG',
            monthly_limit_usd: 50,
            hard_stop: true,
          },
          {
            scope_key: 'USER#user-123',
            period: '2026-08',
            spend_usd: 25,
          },
        ],
      },
    });

    try {
      const result = await handler(makeEvent({
        queryStringParameters: { view: 'budget' },
      }));
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).data).toEqual({
        period: '2026-08',
        resets_at: '2026-09-01T00:00:00.000Z',
        configured: true,
        spend_usd: 25,
        monthly_limit_usd: 50,
        remaining_usd: 25,
        utilization_percent: 50,
        hard_stop: true,
        hard_stop_active: false,
      });
      expect(MockBatchGetCommand).toHaveBeenCalledWith(expect.objectContaining({
        RequestItems: {
          Budgets: expect.objectContaining({
            Keys: [
              { scope_key: 'USER#user-123', period: 'CONFIG' },
              { scope_key: 'USER#user-123', period: '2026-08' },
            ],
            ConsistentRead: true,
          }),
        },
      }));
      expect(MockQueryCommand).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('summaries carry cost, completion time and source, for cost views', async () => {
    const body = JSON.parse((await handler(makeEvent())).body);
    expect(body.data[1]).toMatchObject({ cost_usd: 1.25, completed_at: '2025-03-14T11:58:00Z', channel_source: 'api' });
    // Not finished or no cost reported yet: explicit nulls, not missing keys.
    expect(body.data[0]).toMatchObject({ cost_usd: null, completed_at: null, channel_source: 'api' });
  });

  test.each(['budgets', 'Scoreboard', ''])('returns 400 for the unknown view "%s" instead of returning tasks', async (view) => {
    const result = await handler(makeEvent({
      queryStringParameters: { view },
    }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Invalid view value. Expected "budget" or "scoreboard".',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('passes next_token as ExclusiveStartKey', async () => {
    const key = { task_id: { S: 'task-1' } };
    const token = Buffer.from(JSON.stringify(key)).toString('base64');

    const event = makeEvent({ queryStringParameters: { next_token: token } });
    await handler(event);

    const queryInput = MockQueryCommand.mock.calls[0][0];
    expect(queryInput.ExclusiveStartKey).toEqual(key);
  });

  test('returns 400 for a next_token that cannot be decoded', async () => {
    // A token that lost its end. Taken for no token, it restarted the list at the
    // first page with status 200, and the client took that page for the next one.
    const cut = Buffer.from('{"task_id":"01K').toString('base64');
    const result = await handler(makeEvent({ queryStringParameters: { next_token: cut } }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid next_token.' });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDescribeTable).not.toHaveBeenCalled();
  });

  test('applies status filter', async () => {
    const event = makeEvent({ queryStringParameters: { status: 'RUNNING' } });
    await handler(event);

    const queryInput = MockQueryCommand.mock.calls[0][0];
    expect(queryInput.FilterExpression).toContain('#status');
    expect(queryInput.ExpressionAttributeValues).toHaveProperty(':st0', 'RUNNING');
  });

  test('applies repo filter', async () => {
    const event = makeEvent({ queryStringParameters: { repo: 'org/repo' } });
    await handler(event);

    const queryInput = MockQueryCommand.mock.calls[0][0];
    expect(queryInput.FilterExpression).toContain('#repo');
    expect(queryInput.ExpressionAttributeValues).toHaveProperty(':repo', 'org/repo');
  });

  test('applies limit parameter', async () => {
    const event = makeEvent({ queryStringParameters: { limit: '5' } });
    await handler(event);

    const queryInput = MockQueryCommand.mock.calls[0][0];
    // limit + 1: the extra row tells a full page whether another task follows.
    expect(queryInput.Limit).toBe(6);
  });

  test('returns 400 for invalid status filter', async () => {
    const event = makeEvent({ queryStringParameters: { status: 'INVALID_STATUS' } });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 401 when user is not authenticated', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);

    expect(result.statusCode).toBe(401);
  });

  test('returns empty list when no tasks found', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(body.data).toHaveLength(0);
    expect(body.pagination.has_more).toBe(false);
  });

  test('returns 500 on DynamoDB error', async () => {
    mockSend.mockRejectedValueOnce(new Error('Query failed'));
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
  });

  describe('pagination (#51: Limit is applied before the status and repo filters)', () => {
    test('queries UserCreatedAtIndex newest first', async () => {
      await handler(makeEvent());

      const queryInput = MockQueryCommand.mock.calls[0][0];
      expect(queryInput.IndexName).toBe('UserCreatedAtIndex');
      expect(queryInput.ScanIndexForward).toBe(false);
    });

    test('keeps querying past filtered-out pages until the page is full', async () => {
      // Page 1: every row read was filtered out, but a cursor remains. Page 2 is the
      // default reply: enough tasks to fill limit=1 plus one extra.
      const cursor = { task_id: 'task-0', user_id: 'user-123', created_at: '2025-03-16T09:00:00Z' };
      mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: cursor });

      const result = await handler(makeEvent({ queryStringParameters: { status: 'RUNNING,COMPLETED', limit: '1' } }));
      const body = JSON.parse(result.body);

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(MockQueryCommand.mock.calls[1][0].ExclusiveStartKey).toEqual(cursor);
      expect(body.data.map((t: { task_id: string }) => t.task_id)).toEqual(['task-1']);
      expect(body.pagination.has_more).toBe(true);
      expect(body.pagination.next_token).not.toBeNull();
    });

    test('next_token resumes from the last task returned, not the scan boundary', async () => {
      mockSend.mockResolvedValueOnce({ Items: TASK_ITEMS, LastEvaluatedKey: { task_id: 'task-scanned-past' } });

      const result = await handler(makeEvent({ queryStringParameters: { limit: '1' } }));
      const body = JSON.parse(result.body);

      const decoded = JSON.parse(Buffer.from(body.pagination.next_token, 'base64').toString('utf-8'));
      // Boundary is the last task actually returned (task-1), so task-2 is not skipped.
      expect(decoded).toEqual({ task_id: 'task-1', user_id: 'user-123', created_at: TASK_ITEMS[0].created_at });
    });

    test('stops after the page cap and hands back the raw cursor', async () => {
      // Every page filters to nothing but keeps returning a cursor.
      mockSend.mockResolvedValue({ Items: [], LastEvaluatedKey: { task_id: 'task-x' } });

      const result = await handler(makeEvent({ queryStringParameters: { status: 'FAILED' } }));
      const body = JSON.parse(result.body);

      expect(mockSend).toHaveBeenCalledTimes(10); // MAX_QUERY_PAGES
      expect(body.data).toHaveLength(0);
      // The read is not finished, so the list must not be reported as complete.
      expect(body.pagination.has_more).toBe(true);
      const decoded = JSON.parse(Buffer.from(body.pagination.next_token, 'base64').toString('utf-8'));
      expect(decoded).toEqual({ task_id: 'task-x' });
    });
  });

  describe('choice of index (UserCreatedAtIndex is being built on the deploy that adds it)', () => {
    // The handler remembers that the index is ACTIVE, so each test loads a copy of its own.
    // That copy has its own command mocks, so these tests read the commands `mockSend` got.
    let listTasks: typeof handler;
    const indexesRead = () => mockSend.mock.calls.map(([command]) => command.input.IndexName);

    beforeEach(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh copy of the handler and its cached index status
        listTasks = require('../../src/handlers/list-tasks').handler;
      });
    });

    test.each([
      ['CREATING', 'CREATING'], ['UPDATING', 'UPDATING'], ['DELETING', 'DELETING'], ['missing', undefined],
    ])('lists from UserStatusIndex while UserCreatedAtIndex is %s', async (_state, status) => {
      mockDescribeTable.mockResolvedValue(describedWith(status));
      const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const result = await listTasks(makeEvent({ queryStringParameters: { limit: '1' } }));
      const logged = stdout.mock.calls.join('');
      stdout.mockRestore();
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(200);
      expect(mockDescribeTable.mock.calls.map(([command]) => command.input)).toEqual([{ TableName: 'Tasks' }]);
      expect(indexesRead()).toEqual(['UserStatusIndex']);
      expect(body.data.map((t: { task_id: string }) => t.task_id)).toEqual(['task-1']);
      // The cursor is one of the index that was read.
      const decoded = JSON.parse(Buffer.from(body.pagination.next_token, 'base64').toString('utf-8'));
      expect(decoded).toEqual({ task_id: 'task-1', user_id: 'user-123', status_created_at: TASK_ITEMS[0].status_created_at });
      // The deployment guide tells operators to look for this line.
      expect(logged).toContain('UserCreatedAtIndex is not ACTIVE');
    });

    test('asks again on each request until the index is ACTIVE, and never after', async () => {
      mockDescribeTable.mockResolvedValueOnce(describedWith('CREATING'));

      await listTasks(makeEvent());
      await listTasks(makeEvent());
      await listTasks(makeEvent());

      expect(indexesRead()).toEqual(['UserStatusIndex', 'UserCreatedAtIndex', 'UserCreatedAtIndex']);
      expect(mockDescribeTable).toHaveBeenCalledTimes(2);
    });

    const token = (key: Record<string, string>) => Buffer.from(JSON.stringify(key)).toString('base64');
    const createdAtKey = { task_id: 'task-1', user_id: 'user-123', created_at: TASK_ITEMS[0].created_at };

    test('a status_created_at cursor is read from UserStatusIndex without a status check', async () => {
      const key = { task_id: 'task-1', user_id: 'user-123', status_created_at: TASK_ITEMS[0].status_created_at };

      await listTasks(makeEvent({ queryStringParameters: { next_token: token(key) } }));

      expect(mockDescribeTable).not.toHaveBeenCalled();
      expect(mockSend.mock.calls[0][0].input).toMatchObject({ IndexName: 'UserStatusIndex', ExclusiveStartKey: key });
    });

    test.each([
      ['ACTIVE', 'UserCreatedAtIndex'],
      // UserCreatedAtIndex is not read before it is ACTIVE; DynamoDB refuses this key on
      // UserStatusIndex, so the request is a 500.
      ['CREATING', 'UserStatusIndex'],
    ])('a created_at cursor follows the status check: %s reads %s', async (status, index) => {
      mockDescribeTable.mockResolvedValue(describedWith(status));

      await listTasks(makeEvent({ queryStringParameters: { next_token: token(createdAtKey) } }));

      expect(mockSend.mock.calls.map(([command]) => command.input)).toMatchObject([{ IndexName: index, ExclusiveStartKey: createdAtKey }]);
    });

    test('a status check that fails is a 500, and no index is read', async () => {
      mockDescribeTable.mockRejectedValueOnce(new Error('AccessDeniedException'));

      const result = await listTasks(makeEvent());

      expect(result.statusCode).toBe(500);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('view=scoreboard', () => {
    const NOW = new Date('2026-11-19T12:00:00.000Z');
    const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const;
    type Terminal = (typeof TERMINAL)[number];
    interface Page { Items: ScoreboardTask[]; LastEvaluatedKey?: Record<string, unknown> }

    /**
     * Answers the queries of a scoreboard read: for each status its pages, in the order they
     * are read; a status without pages holds no task. Every query moves the clock a second
     * on, as a real read does: a handler that reads the clock a second time sends bounds, or
     * returns a period, that disagree with the first reading.
     */
    function indexHolds(pages: Partial<Record<Terminal, Page[]>>): void {
      const served = new Map<string, number>();
      mockSend.mockImplementation(({ input }: { input: QueryCommandInput }) => {
        jest.setSystemTime(Date.now() + 1000);
        const status = String(input.ExpressionAttributeValues?.[':hi']).split('#')[0] as Terminal;
        const page = served.get(status) ?? 0;
        served.set(status, page + 1);
        return Promise.resolve(pages[status]?.[page] ?? { Items: [] });
      });
    }

    /** The queries sent for one status, in the order they were sent. */
    const queriesFor = (status: Terminal): QueryCommandInput[] => MockQueryCommand.mock.calls
      .map(([input]) => input as QueryCommandInput)
      .filter((input) => input.ExpressionAttributeValues?.[':hi'] === `${status}#~`);

    const getScoreboard = (query: { range?: string } = {}): Promise<APIGatewayProxyResult> =>
      handler(makeEvent({ queryStringParameters: { view: 'scoreboard', ...query } }));
    const scoreboardIn = (result: APIGatewayProxyResult): Scoreboard => JSON.parse(result.body).data;

    /** A scoreboard request, with what it wrote to the error log. */
    async function loggedScoreboard(): Promise<{ result: APIGatewayProxyResult; logged: string }> {
      const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const result = await getScoreboard();
      const logged = stderr.mock.calls.join('');
      stderr.mockRestore();
      return { result, logged };
    }

    /**
     * New work that ended in a verified pull request at `at`, as the projection returns it;
     * `status` makes it a task that ended otherwise. The platform's stamps have milliseconds,
     * the agent's are whole seconds.
     */
    function finishedAt(at: string, status: Terminal = 'COMPLETED'): ScoreboardTask {
      const createdMs = Date.parse(at) - 24 * 60 * 1000;
      return {
        task_id: `${status}-${at}`,
        status,
        repo: 'org/repo',
        resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
        workflow_ref: 'coding/new-task-v1',
        created_at: new Date(createdMs).toISOString(),
        started_at: new Date(createdMs + 41 * 1000).toISOString(),
        completed_at: at,
        updated_at: at,
        pr_url: 'https://github.com/org/repo/pull/12',
        build_passed: true,
        cost_usd: '3.75',
        approval_gate_count: 0,
      };
    }

    /** The pages of a status whose read is cut: six, the cap, and after each the key of `time`, so more is left to read. */
    const cutAt = (status: Terminal, time: string, tasks: ScoreboardTask[] = []): Page[] => Array.from({ length: 6 }, (_, page) => ({
      Items: page === 0 ? tasks : [],
      LastEvaluatedKey: { user_id: 'user-123', task_id: `task-${page}`, status_created_at: `${status}#${time}` },
    }));

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(NOW);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('returns the scoreboard of the caller\'s finished tasks: the range asked for and the period before it', async () => {
      indexHolds({
        COMPLETED: [{ Items: [finishedAt('2026-11-18T10:24:00Z'), finishedAt('2026-10-01T10:30:00Z')] }],
        FAILED: [{ Items: [finishedAt('2026-11-05T14:00:03.120Z', 'FAILED')] }],
        CANCELLED: [{ Items: [finishedAt('2026-11-14T15:30:10.500Z', 'CANCELLED')] }],
        TIMED_OUT: [{ Items: [finishedAt('2026-11-15T20:00:00.250Z', 'TIMED_OUT')] }],
      });

      const result = await getScoreboard();

      // The numbers themselves are pinned where they are computed (test/handlers/shared/scoreboard.test.ts).
      expect(result.statusCode).toBe(200);
      expect(Object.keys(JSON.parse(result.body))).toEqual(['data']);
      expect(scoreboardIn(result)).toMatchObject({
        range: '30d',
        truncated: false,
        current: {
          from: '2026-10-20T12:00:00.000Z',
          to: '2026-11-19T12:00:00.000Z',
          finished: 4,
          outcomes: { verified_pr: 1, unverified_pr: 0, no_new_pr: 0, failed: 1, cancelled: 1, timed_out: 1 },
        },
        previous: { from: '2026-09-20T12:00:00.000Z', to: '2026-10-20T12:00:00.000Z', finished: 1, outcomes: { verified_pr: 1 } },
      });
      // One query per terminal status, and no look at the table: the index it reads is always there.
      expect(mockSend).toHaveBeenCalledTimes(4);
      expect(mockDescribeTable).not.toHaveBeenCalled();
    });

    test.each(TERMINAL)('reads the caller\'s %s tasks since the start of the previous period, newest first', async (status) => {
      indexHolds({});

      await getScoreboard();

      expect(queriesFor(status)).toHaveLength(1);
      const { ProjectionExpression, ExpressionAttributeNames, ...query } = queriesFor(status)[0];
      expect(query).toEqual({
        TableName: 'Tasks',
        IndexName: 'UserStatusIndex',
        KeyConditionExpression: 'user_id = :uid AND status_created_at BETWEEN :lo AND :hi',
        // Sixty days before the request, in the form with milliseconds: `.` sorts before `Z`,
        // so the agent's whole-second keys of that first second are inside the bounds.
        ExpressionAttributeValues: { ':uid': 'user-123', ':lo': `${status}#2026-09-20T12:00:00.000Z`, ':hi': `${status}#~` },
        ScanIndexForward: false,
      });
      // `status` is a reserved word of DynamoDB: a name outside an alias fails the query.
      const aliases = ProjectionExpression!.split(', ');
      expect(aliases.filter((alias) => !/^#\w+$/.test(alias))).toEqual([]);
      expect(aliases.map((alias) => ExpressionAttributeNames![alias])).toEqual([...SCOREBOARD_TASK_FIELDS]);
      // DynamoDB also refuses an alias that no expression uses.
      expect(Object.keys(ExpressionAttributeNames!)).toEqual(aliases);
    });

    test.each([
      [{}, '30d', '2026-09-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z'],
      [{ range: '30d' }, '30d', '2026-09-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z'],
      [{ range: '7d' }, '7d', '2026-11-05T12:00:00.000Z', '2026-11-12T12:00:00.000Z'],
    ])('query %j is the range %s: read from %s, current period from %s', async (query, range, previousFrom, from) => {
      indexHolds({});

      const board = scoreboardIn(await getScoreboard(query));

      expect(TERMINAL.map((status) => queriesFor(status)[0].ExpressionAttributeValues?.[':lo']))
        .toEqual(TERMINAL.map((status) => `${status}#${previousFrom}`));
      expect(board).toMatchObject({
        range,
        current: { from, to: '2026-11-19T12:00:00.000Z' },
        previous: { from: previousFrom, to: from },
      });
    });

    test.each(['90d', '7', '7D', ''])('returns 400 for the unknown range "%s", and reads nothing', async (range) => {
      const result = await getScoreboard({ range });

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Invalid range value. Expected "7d" or "30d".',
      });
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('returns 401 without authentication, and reads nothing', async () => {
      const event = makeEvent({ queryStringParameters: { view: 'scoreboard' } });
      event.requestContext.authorizer = null;

      const result = await handler(event);

      expect(result.statusCode).toBe(401);
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('follows the pages of a status up to the cap, and nothing is cut when the sixth page is the last', async () => {
      const tasks = [18, 17, 16, 15, 14, 13].map((day) => finishedAt(`2026-11-${day}T09:00:00Z`));
      const keyAfter = (task: ScoreboardTask) =>
        ({ user_id: 'user-123', task_id: task.task_id, status_created_at: `COMPLETED#${task.completed_at}` });
      indexHolds({
        COMPLETED: tasks.map((task, page) => ({ Items: [task], ...(page < tasks.length - 1 && { LastEvaluatedKey: keyAfter(task) }) })),
      });

      const board = scoreboardIn(await getScoreboard());

      expect(queriesFor('COMPLETED').map((query) => query.ExclusiveStartKey)).toEqual([undefined, ...tasks.slice(0, -1).map(keyAfter)]);
      // Six pages of one status, one page of each of the other three.
      expect(mockSend).toHaveBeenCalledTimes(9);
      expect(board).toMatchObject({
        truncated: false,
        current: { from: '2026-10-20T12:00:00.000Z', finished: 6, outcomes: { verified_pr: 6 } },
        previous: { finished: 0 },
      });
    });

    test('reads a response without Items as a page that holds no task', async () => {
      // The SDK types `Items` as optional.
      mockSend.mockResolvedValue({});

      const board = scoreboardIn(await getScoreboard());

      expect(mockSend).toHaveBeenCalledTimes(4);
      expect(board).toMatchObject({ truncated: false, current: { finished: 0 }, previous: { finished: 0 } });
    });

    test('a read cut inside one status starts the scoreboard after the cut, for every status', async () => {
      indexHolds({
        // Six pages and still more to read: what failed at 08:30:15 or earlier may be unread.
        FAILED: cutAt('FAILED', '2026-11-10T08:30:15Z', [
          finishedAt('2026-11-18T09:00:00Z', 'FAILED'),
          finishedAt('2026-11-12T09:00:00.000Z', 'FAILED'),
          finishedAt('2026-11-10T08:30:15Z', 'FAILED'),
        ]),
        COMPLETED: [{
          Items: [
            finishedAt('2026-11-17T10:00:00Z'),
            // The first second that every status covers.
            finishedAt('2026-11-10T08:30:16Z'),
            // The second of the cut: a failed task with a millisecond stamp sorts before the
            // whole-second key the read stopped at, and may be unread.
            finishedAt('2026-11-10T08:30:15.900Z'),
            // Before the cut, in the current period and in the previous one.
            finishedAt('2026-11-01T10:00:00Z'),
            finishedAt('2026-10-01T10:00:00Z'),
          ],
        }],
        CANCELLED: [{ Items: [finishedAt('2026-11-09T10:00:00.000Z', 'CANCELLED')] }],
      });

      const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const board = scoreboardIn(await getScoreboard());
      const warnings = stdout.mock.calls.map(([line]) => JSON.parse(String(line))).filter((line) => line.level === 'WARN');
      stdout.mockRestore();

      expect(warnings).toEqual([{
        level: 'WARN',
        message: 'Scoreboard read stopped at its page cap',
        user_id: 'user-123',
        range: '30d',
        covered_from: '2026-11-10T08:30:16.000Z',
      }]);
      expect(queriesFor('FAILED')).toHaveLength(6);
      expect(board.truncated).toBe(true);
      expect(board.previous).toBeNull();
      expect(board.current).toMatchObject({
        from: '2026-11-10T08:30:16.000Z',
        to: '2026-11-19T12:00:00.000Z',
        finished: 4,
        outcomes: { verified_pr: 2, unverified_pr: 0, no_new_pr: 0, failed: 2, cancelled: 0, timed_out: 0 },
      });
    });

    test.each([
      [
        'in two statuses starts it after the later cut',
        { FAILED: cutAt('FAILED', '2026-11-10T08:30:15Z'), CANCELLED: cutAt('CANCELLED', '2026-11-15T09:00:00.250Z') },
        { truncated: true, previous: null, current: { from: '2026-11-15T09:00:01.000Z' } },
      ],
      [
        'inside the previous period leaves the current one whole, and reports no previous one',
        { TIMED_OUT: cutAt('TIMED_OUT', '2026-10-01T00:00:00Z') },
        { truncated: false, previous: null, current: { from: '2026-10-20T12:00:00.000Z' } },
      ],
    ])('a read cut %s', async (_where, pages, expected) => {
      indexHolds(pages);

      expect(scoreboardIn(await getScoreboard())).toMatchObject(expected);
    });

    test.each([
      ['a time that does not parse', { user_id: 'user-123', task_id: 'task-1', status_created_at: 'FAILED#soon' }],
      ['no time', { user_id: 'user-123', task_id: 'task-1', status_created_at: 'FAILED#' }],
      ['no sort key', { user_id: 'user-123', task_id: 'task-1' }],
    ])('fails rather than report an unknown window when the read is cut at a key with %s', async (_what, key) => {
      indexHolds({ FAILED: Array.from({ length: 6 }, () => ({ Items: [finishedAt('2026-11-18T09:00:00Z', 'FAILED')], LastEvaluatedKey: key })) });

      const { result, logged } = await loggedScoreboard();

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
      expect(logged).toContain('Scoreboard read stopped at a key that holds no time');
    });

    test('returns 500 when the read of one status fails', async () => {
      indexHolds({});
      mockSend.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));

      const { result, logged } = await loggedScoreboard();

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
      // The line names the view: a failing scoreboard read is told from a failing list.
      expect(JSON.parse(logged)).toMatchObject({
        message: 'Failed to list tasks',
        view: 'scoreboard',
        error: expect.stringContaining('ProvisionedThroughputExceededException'),
      });
    });
  });
});
