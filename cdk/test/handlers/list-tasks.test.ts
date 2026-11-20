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

import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

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

  test('returns 400 for an unknown view instead of returning tasks', async () => {
    const result = await handler(makeEvent({
      queryStringParameters: { view: 'budgets' },
    }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Invalid view value. Expected "budget".',
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
});
