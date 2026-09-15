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
const mockWake = jest.fn();
jest.mock('../../src/handlers/shared/microvm-approval-wake', () => ({
  ...jest.requireActual('../../src/handlers/shared/microvm-approval-wake'),
  wakeMicrovmAfterApproval: (...args: unknown[]) => mockWake(...args),
}));

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
  mockWake.mockReset().mockResolvedValue(undefined);
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

describe('postcommit MicroVM wake', () => {
  test('wake diagnostics are task-bound and keep the supplied remaining-time signal', async () => {
    mockSend.mockResolvedValue({});
    mockWake.mockImplementationOnce(async input => {
      await input.emitEvent('microvm_resume_orphan', { stage: 'resume-request' }, input.options);
    });
    expect((await handler(makeEvent())).statusCode).toBe(202);
    const emitted = mockSend.mock.calls.find(([command]) => command.input.Item?.event_type === 'microvm_resume_orphan');
    expect(emitted?.[0].input.Item).toMatchObject({
      task_id: 'task-1', user_id: 'user-alice', metadata: { stage: 'resume-request' },
    });
    expect(emitted?.[1]).toBe(mockWake.mock.calls[0][0].options);
  });

  test('wake runs after the committed transaction and keeps its decision identity', async () => {
    mockSend.mockResolvedValue({});
    const response = await handler(makeEvent());
    expect(response.statusCode).toBe(202);
    const transaction = mockSend.mock.calls.findIndex(([command]) => command._type === 'TransactWrite');
    expect(mockSend.mock.invocationCallOrder[transaction]).toBeLessThan(mockWake.mock.invocationCallOrder[0]);
    expect(mockWake.mock.calls[0][0]).toMatchObject({
      taskId: 'task-1',
      userId: 'user-alice',
      decision: 'APPROVED',
      options: { abortSignal: expect.any(AbortSignal) },
    });
  });
  test('an unexpected wake failure cannot change the committed202 response', async () => {
    mockSend.mockResolvedValue({});
    mockWake.mockRejectedValue(new Error('private wake failure'));
    const response = await handler(makeEvent());
    expect(response.statusCode).toBe(202);
    expect(response.body).not.toContain('private wake failure');
    expect(mockSend.mock.calls.filter(([command]) => command._type === 'TransactWrite')).toHaveLength(1);
  });
  test('transaction failure cannot wake a worker', async () => {
    mockSend.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('transaction failed'));
    expect((await handler(makeEvent())).statusCode).toBe(500);
    expect(mockWake).not.toHaveBeenCalled();
  });
  test('near Lambda timeout, optional postcommit work gets an already-expired budget', async () => {
    mockSend.mockResolvedValue({});
    const response = await handler(makeEvent(), { getRemainingTimeInMillis: () => 500 });
    expect(response.statusCode).toBe(202);
    expect(mockSend.mock.calls.map(([command]) => command._type)).toEqual(['Update', 'TransactWrite']);
    expect(mockWake.mock.calls[0][0].options.abortSignal.aborted).toBe(true);
  });
  test('audit failure still permits wake and does not fail the decision', async () => {
    mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('audit failed'));
    expect((await handler(makeEvent())).statusCode).toBe(202);
    expect(mockWake).toHaveBeenCalledTimes(1);
  });
});
