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
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

process.env.TASK_TABLE_NAME = 'Tasks';

import { handler } from '../../src/handlers/list-tasks';

const MockQueryCommand = QueryCommand as unknown as jest.Mock;

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

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({ Items: TASK_ITEMS });
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

  test('returns pagination token when more results exist', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [TASK_ITEMS[0]],
      LastEvaluatedKey: { task_id: { S: 'task-1' }, user_id: { S: 'user-123' } },
    });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(body.pagination.has_more).toBe(true);
    expect(body.pagination.next_token).toBeTruthy();
  });

  test('passes next_token as ExclusiveStartKey', async () => {
    const key = { task_id: { S: 'task-1' } };
    const token = Buffer.from(JSON.stringify(key)).toString('base64');

    const event = makeEvent({ queryStringParameters: { next_token: token } });
    await handler(event);

    const queryInput = MockQueryCommand.mock.calls[0][0];
    expect(queryInput.ExclusiveStartKey).toEqual(key);
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
    expect(queryInput.Limit).toBe(5);
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
});
