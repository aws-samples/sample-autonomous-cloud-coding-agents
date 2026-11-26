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

const send = jest.fn();
jest.mock('../../src/handlers/shared/ua', () => ({ makeDocClient: () => ({ send }) }));
import { approvalRowTtl, handler, recordWorkerRequest } from '../../src/handlers/request-approval';

const approval = {
  task_id: 'task',
  request_id: 'gate',
  user_id: 'owner',
  repo: 'owner/repo',
  tool_name: 'Bash',
  tool_input_preview: '{"command":"git push"}',
  tool_input_sha256: 'a'.repeat(64),
  reason: 'Protected operation',
  severity: 'high',
  matching_rule_ids: ['protected'],
  status: 'PENDING',
  created_at: '2026-09-18T00:00:00Z',
  timeout_s: 0,
};
const input = { operation: 'create' as const, task_id: 'task', request_id: 'gate', approval };
let task: Record<string, unknown>;
beforeEach(() => {
  task = { user_id: 'owner', repo: 'owner/repo', compute_type: 'ecs', status: 'RUNNING' };
  send.mockReset().mockImplementation(async command =>
    command.constructor.name === 'GetCommand' ? { Item: task } : {});
});

test.each([
  { status: 'APPROVED' }, { status: 'DENIED' },
  { notified_linear_approval_requested: true }, { decision_source: 'forged' },
  { decided_at: 'now' }, { scope: 'all' }, { ttl: 1 }, { user_id: 'other' }, { repo: 'other/repo' },
])('rejects forged decision/notification fields and ownership: %j', async changes => {
  expect(await recordWorkerRequest({ ...input, approval: { ...approval, ...changes } }))
    .toMatchObject({ ok: false, code: 'APPROVAL_REQUEST_INVALID' });
  expect(send).toHaveBeenCalledTimes(1);
});

test('records only the pending request, guarded by current task ownership and status', async () => {
  expect(await recordWorkerRequest(input)).toEqual({ ok: true });
  const items = send.mock.calls[1][0].input.TransactItems;
  expect(items[0].Put.Item).toEqual({ ...approval, ttl: approvalRowTtl(approval.created_at, approval.timeout_s) });
  expect(items[0].Put.ConditionExpression).toBe('attribute_not_exists(request_id)');
  expect(items[1].Update.ConditionExpression).toBe('#status = :running AND user_id = :user');
  expect(items[1].Update.ExpressionAttributeValues[':user']).toBe('owner');
  // The stranded-approval sweep measures from the time the task entered AWAITING_APPROVAL.
  expect(items[1].Update.UpdateExpression).toContain('status_created_at = :sca');
  expect(items[1].Update.ExpressionAttributeValues[':sca']).toMatch(/^AWAITING_APPROVAL#\d{4}-\d{2}-\d{2}T/);
});

test('every backend uses the same two-item transaction (no worker lease on this branch)', async () => {
  for (const computeType of ['agentcore', 'ecs', 'lambda-microvm']) {
    send.mockClear();
    task.compute_type = computeType;
    await recordWorkerRequest(input);
    expect(send.mock.calls[1][0].input.TransactItems).toHaveLength(2);
  }
});

test('retention is set by the writer from the validated deadline, never by the worker', () => {
  const created = Date.parse('2026-09-18T00:00:00Z') / 1000;
  expect(approvalRowTtl('2026-09-18T00:00:00Z', 300)).toBe(created + 300 + 120);
  // No automatic deadline: the task retention period instead.
  const noDeadline = approvalRowTtl('2026-09-18T00:00:00Z', 0);
  expect(noDeadline).toBeGreaterThan(Math.floor(Date.now() / 1000) + 80 * 86400);
});

test('timeout cannot overwrite a human decision or resume the task', async () => {
  await recordWorkerRequest({ operation: 'timeout', task_id: 'task', request_id: 'gate' });
  const items = send.mock.calls[1][0].input.TransactItems;
  expect(items[0].Update.ExpressionAttributeValues[':timeout']).toBe('TIMED_OUT');
  expect(items[0].Update.ConditionExpression).toBe('#status = :pending AND user_id = :user');
  expect(items[1].ConditionCheck.ConditionExpression).toContain('awaiting_approval_request_id = :request');
  expect(items[1].Update).toBeUndefined();
});

test('preserves cancellation reasons without returning request contents', async () => {
  send.mockRejectedValueOnce({
    name: 'TransactionCanceledException',
    CancellationReasons: [
      { Code: 'ConditionalCheckFailed', Item: { secret: 'must not return' } },
    ],
  });
  expect(await recordWorkerRequest(input)).toEqual({
    ok: false, code: 'TransactionCanceledException', cancellation_reasons: [{ Code: 'ConditionalCheckFailed' }],
  });
});

describe('repeat create of the same request (the worker lost the first response)', () => {
  const cancelled = { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'ConditionalCheckFailed' }] };
  let stored: Record<string, unknown> | undefined;
  beforeEach(() => {
    task = { ...task, status: 'AWAITING_APPROVAL', awaiting_approval_request_id: 'gate' };
    stored = { ...approval };
    send.mockImplementation(async command => {
      if (command.constructor.name === 'TransactWriteCommand') throw cancelled;
      return { Item: command.input.Key.request_id === undefined ? task : stored };
    });
  });

  test('returns the success the committed create returned, from consistent reads', async () => {
    expect(await recordWorkerRequest(input)).toEqual({ ok: true });
    const reads = send.mock.calls.slice(2).map(([command]) => command.input);
    expect(reads).toEqual(expect.arrayContaining([
      expect.objectContaining({ Key: { task_id: 'task', request_id: 'gate' }, ConsistentRead: true }),
      expect.objectContaining({ Key: { task_id: 'task' }, ConsistentRead: true }),
    ]));
  });

  test.each([
    ['the task awaits another request', () => { task.awaiting_approval_request_id = 'other'; }],
    ['the task no longer awaits approval', () => { task.status = 'RUNNING'; }],
    ['the task was cancelled', () => { task.status = 'CANCELLED'; }],
    ['no request row exists', () => { stored = undefined; }],
    ['the row belongs to another user', () => { stored = { ...approval, user_id: 'other' }; }],
    ['the row is for another tool input', () => { stored = { ...approval, tool_input_sha256: 'b'.repeat(64) }; }],
  ])('still fails when %s', async (_name, arrange) => {
    arrange();
    expect(await recordWorkerRequest(input)).toEqual({
      ok: false,
      code: 'TransactionCanceledException',
      cancellation_reasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'ConditionalCheckFailed' }],
    });
  });

  test('a different request id for the waiting task still fails', async () => {
    const other = { ...input, request_id: 'other', approval: { ...approval, request_id: 'other' } };
    expect(await recordWorkerRequest(other)).toMatchObject({ ok: false, code: 'TransactionCanceledException' });
  });
});

test('requires IAM caller identity and refuses body/path task substitution', async () => {
  const event = {
    body: JSON.stringify(input),
    pathParameters: { task_id: 'other-task' },
    requestContext: { identity: { userArn: 'arn:aws:sts::123456789012:assumed-role/Session/task' } },
  } as unknown as APIGatewayProxyEvent;
  expect((await handler(event)).statusCode).toBe(400);
  expect(send).not.toHaveBeenCalled();
  expect((await handler({ ...event, requestContext: {} } as APIGatewayProxyEvent)).statusCode).toBe(403);
});

test('accepts the signed path for the matching request', async () => {
  const result = await handler({
    body: JSON.stringify(input),
    pathParameters: { task_id: 'task' },
    requestContext: { identity: { userArn: 'arn:aws:sts::123456789012:assumed-role/Session/task' } },
  } as unknown as APIGatewayProxyEvent);
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ data: { ok: true } });
});

test('reports service failures as unavailable with a request ID, not invalid input', async () => {
  send.mockRejectedValueOnce({ name: 'ProvisionedThroughputExceededException' });
  const result = await handler({
    body: JSON.stringify(input),
    pathParameters: { task_id: 'task' },
    requestContext: { requestId: 'api-request', identity: { userArn: 'worker' } },
  } as unknown as APIGatewayProxyEvent);
  expect(result.statusCode).toBe(503);
  expect(JSON.parse(result.body)).toMatchObject({
    error: { code: 'ProvisionedThroughputExceededException', request_id: 'api-request' },
  });
});

test.each(['*', 'task/*', '../task', 'task?x', 'task#lease', 'task\n'])('rejects unsafe task/request/worker identifiers %j before database access', async id => {
  for (const key of ['task_id', 'request_id']) {
    expect(await recordWorkerRequest({ ...input, [key]: id })).toEqual({ ok: false, code: 'APPROVAL_REQUEST_INVALID' });
  }
  expect(send).not.toHaveBeenCalled();
});
