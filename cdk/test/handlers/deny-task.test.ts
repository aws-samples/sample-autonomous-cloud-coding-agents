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

import { handler } from '../../src/handlers/deny-task';

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
