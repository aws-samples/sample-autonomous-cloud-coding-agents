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
process.env.MAX_CONCURRENT_TASKS_PER_USER = '3';

import { handler } from '../../src/handlers/get-task';

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

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/v1/tasks/task-1',
    pathParameters: { task_id: 'task-1' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/tasks/{task_id}',
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
      path: '/v1/tasks/task-1',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/tasks/{task_id}',
      stage: 'v1',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({ Item: TASK_RECORD });
});

describe('get-task handler', () => {
  test('returns task detail successfully', async () => {
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.task_id).toBe('task-1');
    expect(body.data.status).toBe('RUNNING');
    expect(body.data.repo).toBe('org/repo');
    expect(body.data.branch_name).toBe('bgagent/task-1/fix');
    // Null fields should be present
    expect(body.data.pr_url).toBeNull();
    expect(body.data.error_message).toBeNull();
    // Provenance — surfaced so CLI / dashboard consumers can distinguish
    // webhook-submitted tasks from api-submitted tasks without spelunking
    // CloudWatch. Pre-fix this field was present on the DDB record but
    // dropped by ``toTaskDetail``.
    expect(body.data.channel_source).toBe('api');
  });

  test('surfaces channel_source=webhook for tasks created via the webhook path', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({
      Item: {
        ...TASK_RECORD,
        channel_source: 'webhook',
      },
    });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.channel_source).toBe('webhook');
  });

  test('non-QUEUED task carries null queue fields and issues no GSI query', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: TASK_RECORD });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);
    expect(body.data.queue_position).toBeNull();
    expect(body.data.estimated_wait_s).toBeNull();
    expect(body.data.queued_at).toBeNull();
    expect(mockSend).toHaveBeenCalledTimes(1); // GetCommand only
  });

  test('QUEUED task returns 1-based FIFO position among the user\'s queued tasks (#441)', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({
        Item: {
          ...TASK_RECORD,
          status: 'QUEUED',
          status_created_at: 'QUEUED#2025-03-15T10:30:05Z',
          queued_at: '2025-03-15T10:30:05Z',
        },
      })
      // UserStatusIndex query: two tasks queued before ours, one after.
      .mockResolvedValueOnce({
        Items: [
          { task_id: 'older-1', created_at: '2025-03-15T10:28:00Z' },
          { task_id: 'older-2', created_at: '2025-03-15T10:29:00Z' },
          { task_id: 'task-1', created_at: '2025-03-15T10:30:00Z' },
          { task_id: 'newer-1', created_at: '2025-03-15T10:31:00Z' },
        ],
      });

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.queue_position).toBe(3); // 2 ahead + 1
    expect(body.data.estimated_wait_s).toBe(600); // ceil(3/3) * 600
    expect(body.data.queued_at).toBe('2025-03-15T10:30:05Z');
  });

  test('QUEUED task queue-position lookup fails open to null on GSI error', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({
        Item: { ...TASK_RECORD, status: 'QUEUED', status_created_at: 'QUEUED#2025-03-15T10:30:05Z' },
      })
      .mockRejectedValueOnce(new Error('GSI throttled'));

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200); // GET still succeeds
    const body = JSON.parse(result.body);
    expect(body.data.status).toBe('QUEUED');
    expect(body.data.queue_position).toBeNull();
    expect(body.data.estimated_wait_s).toBeNull();
  });

  test('QUEUED task that left the queue between reads reports null position (no stale rank)', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({
        Item: { ...TASK_RECORD, status: 'QUEUED', status_created_at: 'QUEUED#2025-03-15T10:30:05Z' },
      })
      // Query result no longer contains task-1 (picked up concurrently).
      .mockResolvedValueOnce({
        Items: [{ task_id: 'other', created_at: '2025-03-15T10:28:00Z' }],
      });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);
    expect(body.data.queue_position).toBeNull();
  });

  test('returns 401 when user is not authenticated', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error.code).toBe('UNAUTHORIZED');
  });

  test('returns 400 when task_id is missing', async () => {
    const event = makeEvent({ pathParameters: null });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 404 when task does not exist', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error.code).toBe('TASK_NOT_FOUND');
  });

  test('returns 403 when task belongs to another user', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { ...TASK_RECORD, user_id: 'other-user' },
    });
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('FORBIDDEN');
  });

  test('returns 500 on DynamoDB error', async () => {
    mockSend.mockRejectedValueOnce(new Error('DB failure'));
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
  });

  test('includes standard headers', async () => {
    const result = await handler(makeEvent());

    expect(result.headers?.['Content-Type']).toBe('application/json');
    expect(result.headers?.['X-Request-Id']).toBe('REQ-ULID');
  });
});
