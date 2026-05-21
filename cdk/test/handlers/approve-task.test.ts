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

// Construct a stub TransactionCanceledException that has the
// `err.name` + `CancellationReasons` the handler reads, plus makes
// `instanceof TransactionCanceledException` true. Real
// `TransactionCanceledException` lives on `@aws-sdk/client-dynamodb`;
// we mock that whole module here so we export a class the handler
// can both throw and `instanceof`-check.
class MockTransactionCanceledException extends Error {
  name = 'TransactionCanceledException';
  CancellationReasons?: { Code?: string }[];
  constructor(reasons: { Code?: string }[]) {
    super('TransactionCanceledException');
    this.CancellationReasons = reasons;
  }
}

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
  TransactionCanceledException: MockTransactionCanceledException,
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  TransactWriteCommand: jest.fn((input: unknown) => ({ _type: 'TransactWrite', input })),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_APPROVALS_TABLE_NAME = 'Approvals';
process.env.TASK_EVENTS_TABLE_NAME = 'Events';
process.env.APPROVE_RATE_LIMIT_PER_MINUTE = '30';

import { handler } from '../../src/handlers/approve-task';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({ request_id: '01KREQ1', decision: 'approve' }),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/tasks/task-1/approve',
    pathParameters: { task_id: 'task-1' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/tasks/{task_id}/approve',
    requestContext: {
      accountId: '123',
      apiId: 'api',
      authorizer: { claims: { sub: 'user-alice' } },
      httpMethod: 'POST',
      identity: {} as never,
      path: '/v1/tasks/task-1/approve',
      protocol: 'HTTP/1.1',
      requestId: 'req-1',
      requestTime: '',
      requestTimeEpoch: 0,
      resourceId: '',
      resourcePath: '/tasks/{task_id}/approve',
      stage: 'v1',
    },
    ...overrides,
  } as APIGatewayProxyEvent;
}

beforeEach(() => {
  mockSend.mockReset();
  ulidCounter = 0;
});

describe('approve-task — auth + validation', () => {
  test('401 when no Cognito claims', async () => {
    const event = makeEvent();
    (event.requestContext.authorizer as { claims: Record<string, unknown> }).claims = {};
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
  });

  test('400 when task_id missing', async () => {
    const event = makeEvent({ pathParameters: {} });
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
  });

  test('400 when body is not JSON', async () => {
    const res = await handler(makeEvent({ body: 'not json' }));
    expect(res.statusCode).toBe(400);
  });

  test('400 when request_id missing', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ decision: 'approve' }) }));
    expect(res.statusCode).toBe(400);
  });

  test('400 when decision is not "approve"', async () => {
    const res = await handler(
      makeEvent({ body: JSON.stringify({ request_id: 'r', decision: 'deny' }) }),
    );
    expect(res.statusCode).toBe(400);
  });

  test('400 when scope is invalid', async () => {
    const res = await handler(
      makeEvent({
        body: JSON.stringify({ request_id: 'r', decision: 'approve', scope: 'bogus_scope' }),
      }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('approve-task — happy path', () => {
  test('202 on successful approval, default scope this_call', async () => {
    // Rate-limit UpdateItem succeeds, TransactWriteItems succeeds,
    // audit PutItem succeeds.
    mockSend.mockResolvedValue({});
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('APPROVED');
    expect(body.data.scope).toBe('this_call');
    expect(body.data.request_id).toBe('01KREQ1');
  });

  test('propagates custom scope into TransactWriteItems payload', async () => {
    mockSend.mockResolvedValue({});
    await handler(
      makeEvent({
        body: JSON.stringify({
          request_id: '01KREQ1',
          decision: 'approve',
          scope: 'tool_type_session',
        }),
      }),
    );
    const txCalls = mockSend.mock.calls.filter((c) => c[0]._type === 'TransactWrite');
    expect(txCalls).toHaveLength(1);
    const approvalItem = txCalls[0][0].input.TransactItems[0].Update;
    expect(approvalItem.ExpressionAttributeValues[':scope']).toBe('tool_type_session');
  });

  test('writes approval_decision_recorded audit event', async () => {
    mockSend.mockResolvedValue({});
    await handler(makeEvent());
    const putCalls = mockSend.mock.calls.filter((c) => c[0]._type === 'Put');
    expect(putCalls).toHaveLength(1);
    const auditPut = putCalls[0][0].input;
    expect(auditPut.TableName).toBe('Events');
    expect(auditPut.Item.event_type).toBe('approval_decision_recorded');
    expect(auditPut.Item.metadata.status).toBe('APPROVED');
    expect(auditPut.Item.metadata.caller_user_id).toBe('user-alice');
  });
});

describe('approve-task — error classification', () => {
  test('404 REQUEST_NOT_FOUND when approvals row condition fails', async () => {
    mockSend
      .mockResolvedValueOnce({}) // rate-limit
      .mockRejectedValueOnce(
        new MockTransactionCanceledException([
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
        ]),
      );
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('REQUEST_NOT_FOUND');
  });

  test('409 TASK_NOT_AWAITING_APPROVAL when task row condition fails', async () => {
    mockSend
      .mockResolvedValueOnce({}) // rate-limit
      .mockRejectedValueOnce(
        new MockTransactionCanceledException([
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
        ]),
      );
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('TASK_NOT_AWAITING_APPROVAL');
  });

  test('429 on rate-limit exceeded', async () => {
    const err = new Error('ConditionalCheckFailedException');
    (err as { name: string }).name = 'ConditionalCheckFailedException';
    mockSend.mockRejectedValueOnce(err);
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(429);
  });

  test('500 on unexpected DDB error', async () => {
    mockSend.mockRejectedValueOnce(new Error('boom'));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
  });

  test('audit write failure does NOT fail the request', async () => {
    mockSend
      .mockResolvedValueOnce({}) // rate-limit
      .mockResolvedValueOnce({}) // transaction
      .mockRejectedValueOnce(new Error('ddb throttled on audit'));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(202);
  });
});
