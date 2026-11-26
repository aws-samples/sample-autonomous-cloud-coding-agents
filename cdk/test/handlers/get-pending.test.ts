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

const NOW = Date.parse('2026-05-07T00:00:30Z');

beforeEach(() => {
  mockSend.mockReset();
  ulidCounter = 0;
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

function setupPendingMocks(items: ReadonlyArray<Record<string, unknown>>): void {
  mockSend
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ Items: items });
}

function pendingRow(requestId: string, approvalWindow: { created_at?: string; timeout_s?: number }): Record<string, unknown> {
  return { task_id: 'task-1', request_id: requestId, tool_name: 'Bash', tool_input_preview: '', severity: 'medium', reason: '', ...approvalWindow };
}

async function listedRequestIds(): Promise<string[]> {
  const res = await handler(makeEvent());
  return JSON.parse(res.body).data.pending.map((p: { request_id: string }) => p.request_id);
}

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

  test('the default limit is one call a second, enough for the console in several windows', async () => {
    jest.resetModules();
    delete process.env.PENDING_RATE_LIMIT_PER_MINUTE;
    const { handler: handlerWithDefaultLimit } = await import('../../src/handlers/get-pending');
    process.env.PENDING_RATE_LIMIT_PER_MINUTE = '10';
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [] });

    const res = await handlerWithDefaultLimit(makeEvent());

    expect(res.statusCode).toBe(200);
    const rateLimitCall = mockSend.mock.calls.find((c) => c[0]._type === 'Update');
    expect(rateLimitCall![0].input.ExpressionAttributeValues[':max']).toBe(60);
  });

  test('returns empty pending[] when query returns no items', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [] });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.pending).toEqual([]);
  });

  test('queries user_id-status-index GSI with user_id + status=PENDING', async () => {
    mockSend
      .mockResolvedValueOnce({})
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
    setupPendingMocks([
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
    ]);
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
    setupPendingMocks([
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
    ]);
    const res = await handler(makeEvent());
    const body = JSON.parse(res.body);
    expect(body.data.pending[0].severity).toBe('medium');
  });

  test('expires_at falls back to created_at when timeout is missing', async () => {
    setupPendingMocks([
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
    ]);
    const res = await handler(makeEvent());
    const body = JSON.parse(res.body);
    expect(body.data.pending[0].expires_at).toBe('2026-05-07T00:00:00Z');
  });

  test('leaves out a request whose approval window has passed', async () => {
    // DynamoDB's TTL can take days to delete an expired row, so a row can stay PENDING past its window.
    setupPendingMocks([
      pendingRow('stale', { created_at: '2026-05-06T23:00:00Z', timeout_s: 300 }),
      pendingRow('live', { created_at: '2026-05-07T00:00:00Z', timeout_s: 300 }),
    ]);

    expect(await listedRequestIds()).toEqual(['live']);
  });

  test('lists a request up to the last second of its window and not from its end on', async () => {
    setupPendingMocks([
      pendingRow('ends-now', { created_at: '2026-05-07T00:00:00Z', timeout_s: 30 }),
      pendingRow('ends-in-a-second', { created_at: '2026-05-07T00:00:00Z', timeout_s: 31 }),
    ]);

    expect(await listedRequestIds()).toEqual(['ends-in-a-second']);
  });

  test('keeps a request that has no window to pass, however old it is', async () => {
    setupPendingMocks([
      pendingRow('no-timeout', { created_at: '2026-05-01T00:00:00Z', timeout_s: 0 }),
      pendingRow('timeout-absent', { created_at: '2026-05-01T00:00:00Z' }),
      pendingRow('not-a-date', { created_at: 'not-a-date', timeout_s: 300 }),
      pendingRow('created-at-absent', { timeout_s: 300 }),
    ]);

    expect(await listedRequestIds()).toEqual(['no-timeout', 'timeout-absent', 'not-a-date', 'created-at-absent']);
  });

  test('reads past a page of requests whose window has passed to a live one behind it', async () => {
    const stale = Array.from({ length: 100 }, (_, i) =>
      pendingRow(`stale-${i}`, { created_at: '2026-05-06T23:00:00Z', timeout_s: 300 }));
    const lastKey = { user_id: 'user-alice', status: 'PENDING', task_id: 'task-1', request_id: 'stale-99' };
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: stale, LastEvaluatedKey: lastKey })
      .mockResolvedValueOnce({ Items: [pendingRow('live', { created_at: '2026-05-07T00:00:00Z', timeout_s: 300 })] });

    expect(await listedRequestIds()).toEqual(['live']);
    const queries = mockSend.mock.calls.filter((c) => c[0]._type === 'Query').map((c) => c[0].input);
    expect(queries.map((q) => q.ExclusiveStartKey)).toEqual([undefined, lastKey]);
  });

  test('lists at most 100 requests and stops reading once it has them', async () => {
    const rows = (prefix: string, count: number, createdAt: string) => Array.from({ length: count }, (_, i) =>
      pendingRow(`${prefix}-${i}`, { created_at: createdAt, timeout_s: 300 }));
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [...rows('first', 60, '2026-05-07T00:00:00Z'), ...rows('stale', 40, '2026-05-06T23:00:00Z')],
        LastEvaluatedKey: { request_id: 'stale-39' },
      })
      .mockResolvedValueOnce({ Items: rows('second', 100, '2026-05-07T00:00:00Z'), LastEvaluatedKey: { request_id: 'second-99' } });

    const listed = await listedRequestIds();

    expect(listed).toHaveLength(100);
    expect(listed.slice(58, 62)).toEqual(['first-58', 'first-59', 'second-0', 'second-1']);
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  test('stops after 20 pages of requests whose window has passed', async () => {
    const stale = Array.from({ length: 100 }, (_, i) =>
      pendingRow(`stale-${i}`, { created_at: '2026-05-06T23:00:00Z', timeout_s: 300 }));
    mockSend.mockResolvedValueOnce({});
    for (let page = 0; page < 30; page += 1) {
      mockSend.mockResolvedValueOnce({ Items: stale, LastEvaluatedKey: { request_id: `page-${page}` } });
    }
    mockSend.mockResolvedValueOnce({ Items: [pendingRow('live', { created_at: '2026-05-07T00:00:00Z', timeout_s: 300 })] });

    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const listed = await listedRequestIds();
    const logged = stdout.mock.calls.join('');
    stdout.mockRestore();

    expect(listed).toEqual([]);
    expect(mockSend.mock.calls.filter((c) => c[0]._type === 'Query')).toHaveLength(20);
    expect(logged).toContain('stopped at its page cap');
  });

  test('500 on DDB error after rate-limit passes', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('Throughput'));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
  });

  test('maps matching_rule_ids from the GSI row (Cedar HITL diagnostics)', async () => {
    setupPendingMocks([
      {
        task_id: 'task-rule',
        request_id: 'req-rule',
        tool_name: 'Bash',
        tool_input_preview: 'git push --force',
        severity: 'medium',
        reason: 'force_push_any',
        created_at: '2026-05-07T00:00:00Z',
        timeout_s: 300,
        matching_rule_ids: ['force_push_any', 'force_push_main'],
      },
    ]);
    const res = await handler(makeEvent());
    const body = JSON.parse(res.body);
    expect(body.data.pending[0].matching_rule_ids).toEqual([
      'force_push_any',
      'force_push_main',
    ]);
  });

  test('defaults matching_rule_ids to [] when the field is absent or malformed', async () => {
    setupPendingMocks([
      {
        task_id: 't1',
        request_id: 'r1',
        tool_name: 'Bash',
        tool_input_preview: '',
        severity: 'medium',
        reason: '',
        created_at: '2026-05-07T00:00:00Z',
        timeout_s: 60,
      },
      {
        task_id: 't2',
        request_id: 'r2',
        tool_name: 'Bash',
        tool_input_preview: '',
        severity: 'medium',
        reason: '',
        created_at: '2026-05-07T00:00:00Z',
        timeout_s: 60,
        matching_rule_ids: 'not-a-list',
      },
    ]);
    const res = await handler(makeEvent());
    const body = JSON.parse(res.body);
    expect(body.data.pending[0].matching_rule_ids).toEqual([]);
    expect(body.data.pending[1].matching_rule_ids).toEqual([]);
  });
});
