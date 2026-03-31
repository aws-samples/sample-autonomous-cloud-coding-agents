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
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.TASK_RETENTION_DAYS = '90';

import { handler } from '../../src/handlers/cancel-task';

const RUNNING_TASK = {
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
    httpMethod: 'DELETE',
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
      httpMethod: 'DELETE',
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
  // Default: GetCommand returns running task, UpdateCommand + PutCommand succeed
  mockSend
    .mockResolvedValueOnce({ Item: RUNNING_TASK }) // GetCommand
    .mockResolvedValueOnce({}) // UpdateCommand
    .mockResolvedValueOnce({}); // PutCommand (event)
});

describe('cancel-task handler', () => {
  test('cancels a running task successfully', async () => {
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.task_id).toBe('task-1');
    expect(body.data.status).toBe('CANCELLED');
    expect(body.data.cancelled_at).toBeDefined();

    // 3 DynamoDB calls: Get + Update + Put (event)
    expect(mockSend).toHaveBeenCalledTimes(3);
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
    mockSend.mockResolvedValueOnce({ Item: { ...RUNNING_TASK, user_id: 'other-user' } });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('FORBIDDEN');
  });

  test('returns 409 when task is already in terminal state', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: { ...RUNNING_TASK, status: 'COMPLETED' } });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error.code).toBe('TASK_ALREADY_TERMINAL');
  });

  test('returns 409 on ConditionalCheckFailedException (race condition)', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Item: RUNNING_TASK });
    const condError = new Error('Condition not met');
    condError.name = 'ConditionalCheckFailedException';
    mockSend.mockRejectedValueOnce(condError);

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error.code).toBe('TASK_ALREADY_TERMINAL');
  });

  test('returns 500 on unexpected DynamoDB error', async () => {
    mockSend.mockReset();
    mockSend.mockRejectedValueOnce(new Error('DB failure'));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
  });

  test('stamps TTL on task and event when cancelling', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Item: RUNNING_TASK }) // GetCommand
      .mockResolvedValueOnce({}) // UpdateCommand
      .mockResolvedValueOnce({}); // PutCommand (event)

    await handler(makeEvent());

    // UpdateCommand (second call) should include ttl
    const updateCall = mockSend.mock.calls[1][0];
    expect(updateCall.input.UpdateExpression).toContain('#ttl = :ttl');
    expect(updateCall.input.ExpressionAttributeNames['#ttl']).toBe('ttl');
    expect(typeof updateCall.input.ExpressionAttributeValues[':ttl']).toBe('number');

    // PutCommand (third call) should include ttl on event
    const eventCall = mockSend.mock.calls[2][0];
    expect(eventCall.input.Item.ttl).toBeDefined();
    expect(typeof eventCall.input.Item.ttl).toBe('number');
  });

  test('can cancel tasks in SUBMITTED state', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Item: { ...RUNNING_TASK, status: 'SUBMITTED' } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
  });
});
