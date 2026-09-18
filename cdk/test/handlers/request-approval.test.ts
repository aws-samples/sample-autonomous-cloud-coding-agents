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
import { handler, recordWorkerRequest } from '../../src/handlers/request-approval';

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
  expect(items[0].Put.Item).toEqual(approval);
  expect(items[0].Put.ConditionExpression).toBe('attribute_not_exists(request_id)');
  expect(items[1].Update.ConditionExpression).toBe('#status = :running AND user_id = :user');
  expect(items[1].Update.ExpressionAttributeValues[':user']).toBe('owner');
});

test('fences stale MicroVM writers in the same transaction', async () => {
  task.compute_type = 'lambda-microvm';
  await recordWorkerRequest({ ...input, worker_attempt_id: 'worker-token' });
  const lease = send.mock.calls[1][0].input.TransactItems[2].ConditionCheck;
  expect(lease.Key).toEqual({ task_id: 'worker-lease#task' });
  expect(lease.ExpressionAttributeValues).toEqual({
    ':active': 'ACTIVE', ':attempt': 'worker-token', ':user': 'owner',
  });
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
