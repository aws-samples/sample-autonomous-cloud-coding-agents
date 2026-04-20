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

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// --- Mocks ---
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';

import { handler } from '../../src/handlers/get-task-events';

const MockQueryCommand = QueryCommand as unknown as jest.Mock;

const TASK_RECORD = {
  task_id: 'task-1',
  user_id: 'user-123',
  status: 'RUNNING',
  repo: 'org/repo',
  branch_name: 'bgagent/task-1/fix',
  channel_source: 'api',
  status_created_at: 'RUNNING#2025-03-15T10:30:00Z',
  created_at: '2025-03-15T10:30:00Z',
  updated_at: '2025-03-15T10:31:00Z',
};

const EVENT_ITEMS = [
  {
    task_id: 'task-1',
    event_id: 'evt-1',
    event_type: 'task_created',
    timestamp: '2025-03-15T10:30:00Z',
    metadata: { repo: 'org/repo' },
  },
  {
    task_id: 'task-1',
    event_id: 'evt-2',
    event_type: 'session_started',
    timestamp: '2025-03-15T10:31:00Z',
    metadata: { session_id: 'sess-1' },
  },
];

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/v1/tasks/task-1/events',
    pathParameters: { task_id: 'task-1' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/tasks/{task_id}/events',
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
      path: '/v1/tasks/task-1/events',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/tasks/{task_id}/events',
      stage: 'v1',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: GetCommand returns task, QueryCommand returns events
  mockSend
    .mockResolvedValueOnce({ Item: TASK_RECORD })
    .mockResolvedValueOnce({ Items: EVENT_ITEMS });
});

describe('get-task-events handler', () => {
  test('returns events for a task', async () => {
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].event_type).toBe('task_created');
    expect(body.data[1].event_type).toBe('session_started');
    // task_id should be stripped from event data
    expect(body.data[0].task_id).toBeUndefined();
    expect(body.pagination.has_more).toBe(false);
  });

  test('returns 401 when user is not authenticated', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);

    expect(result.statusCode).toBe(401);
  });

  test('returns 400 when task_id is missing', async () => {
    const event = makeEvent({ pathParameters: null });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  test('returns 404 when task does not exist', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: undefined });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error.code).toBe('TASK_NOT_FOUND');
  });

  test('returns 403 when task belongs to another user', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: { ...TASK_RECORD, user_id: 'other-user' } });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('FORBIDDEN');
  });

  test('returns pagination token when more events exist', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Item: TASK_RECORD })
      .mockResolvedValueOnce({
        Items: [EVENT_ITEMS[0]],
        LastEvaluatedKey: { task_id: { S: 'task-1' }, event_id: { S: 'evt-1' } },
      });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(body.pagination.has_more).toBe(true);
    expect(body.pagination.next_token).toBeTruthy();
  });

  test('accepts limit query parameter', async () => {
    const event = makeEvent({ queryStringParameters: { limit: '10' } });
    await handler(event);

    const queryInput = MockQueryCommand.mock.calls[0][0];
    expect(queryInput.Limit).toBe(10);
  });

  test('returns empty array when no events exist', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Item: TASK_RECORD })
      .mockResolvedValueOnce({ Items: [] });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(body.data).toHaveLength(0);
    expect(body.pagination.has_more).toBe(false);
  });

  test('returns 500 on DynamoDB error', async () => {
    mockSend.mockReset();
    mockSend.mockRejectedValueOnce(new Error('DB failure'));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
  });

  test('event metadata defaults to empty object when missing', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Item: TASK_RECORD })
      .mockResolvedValueOnce({
        Items: [{ task_id: 'task-1', event_id: 'evt-x', event_type: 'task_created', timestamp: '2025-01-01T00:00:00Z' }],
      });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(body.data[0].metadata).toEqual({});
  });

  // -------- ?after= support (Phase 1b Step 4) --------

  const VALID_AFTER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const ANOTHER_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

  test('valid ?after routes to KeyConditionExpression with event_id > :after', async () => {
    const event = makeEvent({ queryStringParameters: { after: VALID_AFTER } });
    await handler(event);

    const queryInput = MockQueryCommand.mock.calls[0][0];
    expect(queryInput.KeyConditionExpression).toBe('task_id = :tid AND event_id > :after');
    expect(queryInput.ExpressionAttributeValues).toEqual({
      ':tid': 'task-1',
      ':after': VALID_AFTER,
    });
    // ``after`` must NOT carry ExclusiveStartKey through
    expect(queryInput.ExclusiveStartKey).toBeUndefined();
  });

  test('both after and next_token → after wins + WARN logged', async () => {
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const bogusToken = Buffer.from('{"task_id":"task-1","event_id":"z"}').toString('base64');
      const event = makeEvent({
        queryStringParameters: { after: VALID_AFTER, next_token: bogusToken },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);

      const queryInput = MockQueryCommand.mock.calls[0][0];
      // Confirms ``after`` was used, not ``next_token``.
      expect(queryInput.KeyConditionExpression).toBe('task_id = :tid AND event_id > :after');
      expect(queryInput.ExclusiveStartKey).toBeUndefined();

      // WARN about the conflict must be emitted.
      const warnLines = stdoutWrite.mock.calls
        .map(c => String(c[0]))
        .filter(line => line.includes('"level":"WARN"'));
      const conflictWarn = warnLines.find(line =>
        line.includes('Both after and next_token provided'),
      );
      expect(conflictWarn).toBeDefined();
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  test('invalid ?after (wrong length) returns 400 with VALIDATION_ERROR', async () => {
    mockSend.mockReset(); // Should short-circuit before any DDB call
    const event = makeEvent({ queryStringParameters: { after: 'too-short' } });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('after');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('invalid ?after (illegal chars) returns 400 with VALIDATION_ERROR', async () => {
    mockSend.mockReset();
    // Contains Crockford-excluded 'I' and 'L'.
    const event = makeEvent({ queryStringParameters: { after: 'IIIIIIIIIIIIIIIIIIIIIIIIII' } });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('empty ?after falls through to from-beginning (regression)', async () => {
    const event = makeEvent({ queryStringParameters: { after: '' } });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const queryInput = MockQueryCommand.mock.calls[0][0];
    // No after filter applied.
    expect(queryInput.KeyConditionExpression).toBe('task_id = :tid');
    expect(queryInput.ExpressionAttributeValues).toEqual({ ':tid': 'task-1' });
  });

  test('neither after nor next_token preserves original from-beginning behavior', async () => {
    await handler(makeEvent());

    const queryInput = MockQueryCommand.mock.calls[0][0];
    expect(queryInput.KeyConditionExpression).toBe('task_id = :tid');
    expect(queryInput.ExpressionAttributeValues).toEqual({ ':tid': 'task-1' });
    expect(queryInput.ExclusiveStartKey).toBeUndefined();
    expect(queryInput.ScanIndexForward).toBe(true);
  });

  test('after mode with empty result returns events:[] and no next_token', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Item: TASK_RECORD })
      .mockResolvedValueOnce({ Items: [] });

    const result = await handler(makeEvent({
      queryStringParameters: { after: VALID_AFTER },
    }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.pagination.has_more).toBe(false);
    expect(body.pagination.next_token).toBeNull();
  });

  test('after mode with truncated result emits next_token for continuation', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Item: TASK_RECORD })
      .mockResolvedValueOnce({
        Items: [EVENT_ITEMS[0]],
        LastEvaluatedKey: { task_id: 'task-1', event_id: ANOTHER_ULID },
      });

    const result = await handler(makeEvent({
      queryStringParameters: { after: VALID_AFTER, limit: '1' },
    }));
    const body = JSON.parse(result.body);

    expect(body.pagination.has_more).toBe(true);
    expect(body.pagination.next_token).toBeTruthy();
  });

  test('handler logs INFO on entry and exit with query_mode', async () => {
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await handler(makeEvent({ queryStringParameters: { after: VALID_AFTER } }));

      const infoLines = stdoutWrite.mock.calls
        .map(c => String(c[0]))
        .filter(line => line.includes('"level":"INFO"'));

      const invoked = infoLines.find(line => line.includes('get-task-events invoked'));
      const complete = infoLines.find(line => line.includes('get-task-events complete'));

      expect(invoked).toBeDefined();
      expect(invoked).toContain('"query_mode":"after"');
      expect(complete).toBeDefined();
      expect(complete).toContain('"event_count"');
      expect(complete).toContain('"has_more"');
    } finally {
      stdoutWrite.mockRestore();
    }
  });
});
