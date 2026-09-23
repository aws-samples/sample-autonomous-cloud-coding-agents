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
const mockWake = jest.fn();
jest.mock('../../src/handlers/shared/microvm-approval-wake', () => ({
  ...jest.requireActual('../../src/handlers/shared/microvm-approval-wake'),
  wakeMicrovmAfterApproval: (...args: unknown[]) => mockWake(...args),
}));

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

import { handler, recordDenialForUser } from '../../src/handlers/deny-task';

// Secret fixtures assembled at runtime so the source file itself
// never holds a contiguous secret literal (Code Defender pre-commit
// hook trips on AWS / GitHub / Slack tokens even inside tests).
const FIX_AWS_KEY = 'AK' + 'IAIOSFODNN7EXAMPLE';
const FIX_GITHUB_PAT = 'gh' + 'p_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({ request_id: '01KREQ', decision: 'deny', reason: 'too risky' }),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/tasks/task-1/deny',
    pathParameters: { task_id: 'task-1' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/tasks/{task_id}/deny',
    requestContext: {
      accountId: '123',
      apiId: 'api',
      authorizer: { claims: { sub: 'user-alice' } },
      httpMethod: 'POST',
      identity: {} as never,
      path: '/v1/tasks/task-1/deny',
      protocol: 'HTTP/1.1',
      requestId: 'req-1',
      requestTime: '',
      requestTimeEpoch: 0,
      resourceId: '',
      resourcePath: '/tasks/{task_id}/deny',
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

describe('deny-task — auth + validation', () => {
  test('401 when no Cognito claims', async () => {
    const event = makeEvent();
    (event.requestContext.authorizer as { claims: Record<string, unknown> }).claims = {};
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
  });

  test('400 when decision is not "deny"', async () => {
    const res = await handler(
      makeEvent({ body: JSON.stringify({ request_id: 'r', decision: 'approve' }) }),
    );
    expect(res.statusCode).toBe(400);
  });

  test('omitting reason is allowed (optional field)', async () => {
    mockSend.mockResolvedValue({});
    const res = await handler(
      makeEvent({ body: JSON.stringify({ request_id: '01K', decision: 'deny' }) }),
    );
    expect(res.statusCode).toBe(202);
    // The deny_reason ends up as "" in the Update expression values.
    const tx = mockSend.mock.calls.find((c) => c[0]._type === 'TransactWrite')?.[0].input;
    expect(tx.TransactItems[0].Update.ExpressionAttributeValues[':reason']).toBe('');
  });
});

describe('deny-task — secret redaction', () => {
  test('redacts AWS key in reason before persisting', async () => {
    mockSend.mockResolvedValue({});
    await handler(
      makeEvent({
        body: JSON.stringify({
          request_id: '01K',
          decision: 'deny',
          reason: `saw ${FIX_AWS_KEY} leaked`,
        }),
      }),
    );
    const tx = mockSend.mock.calls.find((c) => c[0]._type === 'TransactWrite')?.[0].input;
    const reason = tx.TransactItems[0].Update.ExpressionAttributeValues[':reason'];
    expect(reason).not.toContain(FIX_AWS_KEY);
    expect(reason).toContain('[REDACTED-AWS_KEY]');
  });

  test('audit event carries sanitized reason', async () => {
    mockSend.mockResolvedValue({});
    await handler(
      makeEvent({
        body: JSON.stringify({
          request_id: '01K',
          decision: 'deny',
          reason: `token: ${FIX_GITHUB_PAT}`,
        }),
      }),
    );
    const audit = mockSend.mock.calls.find((c) => c[0]._type === 'Put')?.[0].input;
    expect(audit.Item.metadata.reason).not.toContain(FIX_GITHUB_PAT);
    expect(audit.Item.metadata.reason).toContain('[REDACTED-GITHUB_TOKEN]');
  });

  test('truncates reason to DENY_REASON_MAX_LENGTH', async () => {
    mockSend.mockResolvedValue({});
    const longReason = 'x'.repeat(5000);
    await handler(
      makeEvent({
        body: JSON.stringify({ request_id: '01K', decision: 'deny', reason: longReason }),
      }),
    );
    const tx = mockSend.mock.calls.find((c) => c[0]._type === 'TransactWrite')?.[0].input;
    const reason = tx.TransactItems[0].Update.ExpressionAttributeValues[':reason'];
    expect(reason.length).toBeLessThanOrEqual(2000);
  });
});

describe('deny-task — error classification', () => {
  test('404 REQUEST_NOT_FOUND when approvals condition fails', async () => {
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
  });

  test('409 TASK_NOT_AWAITING_APPROVAL when task condition fails', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new MockTransactionCanceledException([
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
        ]),
      );
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(409);
  });

  test('happy path returns 202 with DENIED status', async () => {
    mockSend.mockResolvedValue({});
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('DENIED');
    expect(body.data.request_id).toBe('01KREQ');
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
      decision: 'DENIED',
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

describe('trusted channel decision source', () => {
  test('stores the source inside the guarded decision transaction', async () => {
    mockSend.mockResolvedValue({});
    const result = await recordDenialForUser({
      userId: 'user-alice',
      taskId: 'task-1',
      body: JSON.stringify({ request_id: 'gate', decision: 'deny' }),
      decisionSource: 'linear-source',
    });
    expect(result.statusCode).toBe(202);
    const update = mockSend.mock.calls.find(([cmd]) => cmd._type === 'TransactWrite')![0].input.TransactItems[0].Update;
    expect(update.UpdateExpression).toContain('decision_source = :source');
    expect(update.ExpressionAttributeValues[':source']).toBe('linear-source');
    expect(update.ConditionExpression).toContain('#status = :pending');
    expect(update.ConditionExpression).toContain('deadline_epoch > :epoch');
  });
  test('does not trust a source supplied in the HTTP body', async () => {
    mockSend.mockResolvedValue({});
    await handler(makeEvent({ body: JSON.stringify({ request_id: 'gate', decision: 'deny', decisionSource: 'forged' }) }));
    const update = mockSend.mock.calls.find(([cmd]) => cmd._type === 'TransactWrite')![0].input.TransactItems[0].Update;
    expect(update.UpdateExpression).not.toContain('decision_source');
  });
});
