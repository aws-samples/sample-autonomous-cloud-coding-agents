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

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.TASK_APPROVALS_TABLE_NAME = 'Approvals';
process.env.PENDING_RATE_LIMIT_PER_MINUTE = '10';

import { handler } from '../../src/handlers/get-pending';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/v1/pending',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/pending',
    requestContext: {
      accountId: '123',
      apiId: 'api',
      authorizer: { claims: { sub: 'user-alice' } },
      httpMethod: 'GET',
      identity: {} as never,
      path: '/v1/pending',
      protocol: 'HTTP/1.1',
      requestId: 'req-1',
      requestTime: '',
      requestTimeEpoch: 0,
      resourceId: '',
      resourcePath: '/pending',
      stage: 'v1',
    },
    ...overrides,
  } as APIGatewayProxyEvent;
}

beforeEach(() => {
  mockSend.mockReset();
  ulidCounter = 0;
});

describe('get-pending', () => {
  test('401 when no Cognito claims', async () => {
    const event = makeEvent();
    (event.requestContext.authorizer as { claims: Record<string, unknown> }).claims = {};
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
  });

  test('429 on rate-limit exceeded', async () => {
    const err = new Error('ConditionalCheckFailedException');
    (err as { name: string }).name = 'ConditionalCheckFailedException';
    mockSend.mockRejectedValueOnce(err);
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(429);
  });

  test('returns empty pending[] when query returns no items', async () => {
    mockSend
      .mockResolvedValueOnce({}) // rate-limit
      .mockResolvedValueOnce({ Items: [] });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.pending).toEqual([]);
  });

  test('queries user_id-status-index GSI with user_id + status=PENDING', async () => {
    mockSend
      .mockResolvedValueOnce({}) // rate-limit
      .mockResolvedValueOnce({ Items: [] });
    await handler(makeEvent());
    const queryCall = mockSend.mock.calls.find((c) => c[0]._type === 'Query');
    expect(queryCall).toBeDefined();
    const input = queryCall![0].input;
    expect(input.TableName).toBe('Approvals');
    expect(input.IndexName).toBe('user_id-status-index');
    expect(input.KeyConditionExpression).toContain('user_id = :user');
    expect(input.KeyConditionExpression).toContain('#status = :pending');
    expect(input.ExpressionAttributeValues[':user']).toBe('user-alice');
    expect(input.ExpressionAttributeValues[':pending']).toBe('PENDING');
  });

  test('maps GSI rows into PendingApprovalSummary with derived expires_at', async () => {
    mockSend
      .mockResolvedValueOnce({}) // rate-limit
      .mockResolvedValueOnce({
        Items: [
          {
            task_id: 'task-1',
            request_id: 'req-1',
            tool_name: 'Bash',
            tool_input_preview: 'git push --force',
            severity: 'medium',
            reason: 'force_push_any',
            created_at: '2026-05-07T00:00:00Z',
            timeout_s: 300,
          },
        ],
      });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.pending).toHaveLength(1);
    const row = body.data.pending[0];
    expect(row.task_id).toBe('task-1');
    expect(row.request_id).toBe('req-1');
    expect(row.expires_at).toBe('2026-05-07T00:05:00.000Z');
    expect(row.severity).toBe('medium');
  });

  test('falls back to medium severity when row has an unexpected value', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [
          {
            task_id: 't',
            request_id: 'r',
            tool_name: 'Read',
            tool_input_preview: '',
            severity: 'CRITICAL',
            reason: '',
            created_at: '2026-05-07T00:00:00Z',
            timeout_s: 60,
          },
        ],
      });
    const res = await handler(makeEvent());
    const body = JSON.parse(res.body);
    expect(body.data.pending[0].severity).toBe('medium');
  });

  test('expires_at falls back to created_at when timeout is missing', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [
          {
            task_id: 't',
            request_id: 'r',
            tool_name: 'Read',
            tool_input_preview: '',
            severity: 'low',
            reason: '',
            created_at: '2026-05-07T00:00:00Z',
            timeout_s: 0,
          },
        ],
      });
    const res = await handler(makeEvent());
    const body = JSON.parse(res.body);
    expect(body.data.pending[0].expires_at).toBe('2026-05-07T00:00:00Z');
  });

  test('500 on DDB error after rate-limit passes', async () => {
    mockSend
      .mockResolvedValueOnce({}) // rate-limit
      .mockRejectedValueOnce(new Error('Throughput'));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
  });
});
