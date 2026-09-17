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
  BatchGetCommand: jest.fn((input: unknown) => ({ _type: 'BatchGet', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.TASK_APPROVALS_TABLE_NAME = 'Approvals';
process.env.TASK_TABLE_NAME = 'Tasks';
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

/**
 * GSI metadata plus strongly consistent reads of the owning task states.
 */
function setupPendingMocks(
  items: ReadonlyArray<Record<string, unknown>>,
  tasks = items.map(row => ({
    task_id: row.task_id,
    user_id: 'user-alice',
    status: 'AWAITING_APPROVAL',
    awaiting_approval_request_id: row.request_id,
  })),
): void {
  mockSend
    .mockResolvedValueOnce({}) // rate-limit
    .mockResolvedValueOnce({ Items: items })
    .mockResolvedValueOnce({ Responses: { Tasks: tasks } });
}

describe('get-pending', () => {
  test('finds a current request after a full page of cancelled legacy requests', async () => {
    const oldRows = Array.from({ length: 100 }, (_, i) => ({ task_id: `old-${i}`, request_id: 'r' }));
    const lastKey = { task_id: 'old-99', request_id: 'r', user_id: 'user-alice', status: 'PENDING' };
    mockSend.mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: oldRows, LastEvaluatedKey: lastKey })
      .mockResolvedValueOnce({
        Responses: {
          Tasks: oldRows.map(row => ({
            ...row, user_id: 'user-alice', status: 'CANCELLED',
          })),
        },
      })
      .mockResolvedValueOnce({ Items: [{ task_id: 'current', request_id: 'new' }] })
      .mockResolvedValueOnce({
        Responses: {
          Tasks: [{
            task_id: 'current',
            user_id: 'user-alice',
            status: 'AWAITING_APPROVAL',
            awaiting_approval_request_id: 'new',
          }],
        },
      });

    const response = await handler(makeEvent());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.pending).toEqual([
      expect.objectContaining({ task_id: 'current', request_id: 'new' }),
    ]);
    const queries = mockSend.mock.calls.filter(([command]) => command._type === 'Query');
    expect(queries).toHaveLength(2);
    expect(queries[1][0].input.ExclusiveStartKey).toEqual(lastKey);
    expect(queries[0][1].abortSignal).toBe(queries[1][1].abortSignal);
  });

  test('stops paging at the display limit even when the index has more rows', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ task_id: `live-${i}`, request_id: 'r' }));
    mockSend.mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: rows, LastEvaluatedKey: { task_id: 'more' } })
      .mockResolvedValueOnce({
        Responses: {
          Tasks: rows.map(row => ({
            task_id: row.task_id,
            user_id: 'user-alice',
            status: 'AWAITING_APPROVAL',
            awaiting_approval_request_id: 'r',
          })),
        },
      });
    const response = await handler(makeEvent());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.pending).toHaveLength(100);
    expect(mockSend.mock.calls.filter(([command]) => command._type === 'Query')).toHaveLength(1);
  });

  test('reports a later-page read failure instead of returning a misleading empty list', async () => {
    mockSend.mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { task_id: 'more' } })
      .mockRejectedValueOnce(new Error('Later page unavailable'));
    const response = await handler(makeEvent());
    expect(response.statusCode).toBe(500);
  });

  test.each(['CANCELLED', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'RUNNING'])(
    'omits a legacy pending approval when its task is %s',
    async (status) => {
      setupPendingMocks([{ task_id: 't', request_id: 'r' }], [{
        task_id: 't', user_id: 'user-alice', status, awaiting_approval_request_id: 'r',
      }]);
      const response = await handler(makeEvent());
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).data.pending).toEqual([]);
      const batch = mockSend.mock.calls.find(([command]) => command._type === 'BatchGet')![0].input;
      expect(batch.RequestItems.Tasks.ConsistentRead).toBe(true);
    },
  );

  test('omits a replaced gate, missing task and mismatched owner', async () => {
    setupPendingMocks([
      { task_id: 'old', request_id: 'r' },
      { task_id: 'missing', request_id: 'r' },
      { task_id: 'foreign', request_id: 'r' },
    ], [
      { task_id: 'old', user_id: 'user-alice', status: 'AWAITING_APPROVAL', awaiting_approval_request_id: 'new' },
      { task_id: 'foreign', user_id: 'someone-else', status: 'AWAITING_APPROVAL', awaiting_approval_request_id: 'r' },
    ]);
    const response = await handler(makeEvent());
    expect(JSON.parse(response.body).data.pending).toEqual([]);
  });

  test('retries unprocessed task reads instead of dropping the request', async () => {
    mockSend.mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [{ task_id: 't', request_id: 'r' }] })
      .mockResolvedValueOnce({ UnprocessedKeys: { Tasks: { Keys: [{ task_id: 't' }] } } })
      .mockResolvedValueOnce({
        Responses: {
          Tasks: [{
            task_id: 't', user_id: 'user-alice', status: 'AWAITING_APPROVAL', awaiting_approval_request_id: 'r',
          }],
        },
      });
    const response = await handler(makeEvent());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.pending).toHaveLength(1);
  });

  test('reports incomplete task reads as an error, not an empty pending list', async () => {
    mockSend.mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [{ task_id: 't', request_id: 'r' }] })
      .mockResolvedValue({ UnprocessedKeys: { Tasks: { Keys: [{ task_id: 't' }] } } });
    const response = await handler(makeEvent());
    expect(response.statusCode).toBe(500);
  });

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

  test('500 on DDB error after rate-limit passes', async () => {
    mockSend
      .mockResolvedValueOnce({}) // rate-limit
      .mockRejectedValueOnce(new Error('Throughput'));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
  });

  test('maps matching_rule_ids from the GSI row (Cedar HITL diagnostics)', async () => {
    // ``matching_rule_ids`` is projected directly onto the
    // ``user_id-status-index`` GSI (see task-approvals-table.ts),
    // so the handler reads it from the Query result without a
    // second round trip. Lets ``bgagent pending`` show WHICH rule
    // fired without spelunking TaskEventsTable.
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
      // row 1: field absent (pre-Chunk-3 approval row — defensive)
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
      // row 2: field present but wrong shape
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
