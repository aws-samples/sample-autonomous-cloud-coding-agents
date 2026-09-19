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

const mockSend = jest.fn();
jest.mock('../../../src/handlers/shared/ua', () => ({ makeDocClient: () => ({ send: mockSend }) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: jest.fn(input => ({ kind: 'get', input })),
  TransactWriteCommand: jest.fn(input => ({ kind: 'transact', input })),
}));

import { admitContinuation } from '../../../src/handlers/shared/microvm-continuation-start';

const identity = { task_id: 'task', user_id: 'user', repo: 'owner/repo', attempt_id: 'vm-old', request_id: 'request' };
let task: Record<string, any>;
let lease: Record<string, any>;
let approval: Record<string, any>;
let transactions: any[];

beforeEach(() => {
  jest.clearAllMocks();
  task = {
    task_id: 'task',
    user_id: 'user',
    repo: 'owner/repo',
    status: 'AWAITING_APPROVAL',
    session_id: 'vm-old',
    awaiting_approval_request_id: 'request',
    concurrency_slot: { state: 'released' },
    microvm_start: { clientToken: 'task' },
    continuation: {
      version: 1,
      state: 'PARKED',
      identity,
      source_handle: { microvmId: 'vm-old' },
      manifest: {
        kind: 'manifest',
        key: `continuations/task/vm-old/request/manifest/${'a'.repeat(64)}.json`,
        sha256: 'a'.repeat(64),
        version_id: 'v1',
        size_bytes: 100,
      },
    },
  };
  lease = { lease_state: 'PARKED', lease_attempt_id: 'task', lease_microvm_id: 'vm-old', lease_user_id: 'user', lease_repo: 'owner/repo' };
  approval = { user_id: 'user', status: 'APPROVED' };
  transactions = [];
  mockSend.mockImplementation(async ({ kind, input }) => {
    if (kind === 'get') {
      return {
        Item: structuredClone(
          input.Key.request_id ? approval : input.Key.task_id.startsWith('worker-lease#') ? lease : task,
        ),
      };
    }
    transactions.push(input.TransactItems);
    const values = input.TransactItems[0].Update.ExpressionAttributeValues;
    task.continuation = values[':starting'];
    task.concurrency_slot = values[':slot'];
    lease = input.TransactItems[2].Put.Item;
    return {};
  });
});

test('claims exactly one seat and worker token; a replay verifies the same readonly lease', async () => {
  const first = await admitContinuation('task', 'user', 'request', 3);
  const second = await admitContinuation('task', 'user', 'request', 3);
  expect(first.kind).toBe('ready');
  expect(second.kind).toBe('ready');
  expect(transactions).toHaveLength(1);
  expect(lease.lease_state).toBe('ACTIVE');
  expect(task.concurrency_slot.attempt_id).toBe(lease.lease_attempt_id);
  expect(transactions[0][1].Update.ConditionExpression).toContain('active_count < :limit');
  expect(transactions[0][2].Put.ConditionExpression).toContain('lease_state = :parked');
  expect(transactions[0][3].ConditionCheck.ExpressionAttributeValues[':approved']).toBe('APPROVED');
});

test.each(['PENDING', 'CANCELLED'])('does not allocate capacity for %s approval', async status => {
  approval.status = status;
  expect((await admitContinuation('task', 'user', 'request', 3)).kind).toBe(status === 'PENDING' ? 'waiting' : 'closed');
  expect(transactions).toHaveLength(0);
});

test('rejects worker-writable STARTING state without a matching active readonly lease', async () => {
  task.continuation = { ...task.continuation, state: 'STARTING', attempt_id: 'new' };
  task.concurrency_slot = { state: 'held', attempt_id: 'new' };
  await expect(admitContinuation('task', 'user', 'request', 3)).rejects.toThrow('LEASE_INVALID');
  expect(transactions).toHaveLength(0);
});

test('recovers a transaction that committed but lost its reply without allocating again', async () => {
  const normal = mockSend.getMockImplementation()!;
  mockSend.mockImplementation(async (command, options) => {
    const result = await normal(command, options);
    if (command.kind === 'transact') throw new Error('reply lost');
    return result;
  });
  expect((await admitContinuation('task', 'user', 'request', 3)).kind).toBe('ready');
  expect(transactions).toHaveLength(1);
});

test('capacity denial leaves the same saved request parked', async () => {
  const normal = mockSend.getMockImplementation()!;
  mockSend.mockImplementation(async (command, options) => {
    if (command.kind === 'transact') {
      throw Object.assign(new Error('capacity'), {
        name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
      });
    }
    return normal(command, options);
  });
  expect((await admitContinuation('task', 'user', 'request', 3)).kind).toBe('capacity');
  expect(task.continuation.state).toBe('PARKED');
  expect(lease.lease_state).toBe('PARKED');
});

test('an explicit elapsed deadline is resolved atomically with replacement admission', async () => {
  approval = { ...approval, status: 'PENDING', timeout_s: 30, created_at: new Date(Date.now() - 60_000).toISOString() };
  expect((await admitContinuation('task', 'user', 'request', 3)).kind).toBe('ready');
  expect(transactions[0][3].Update).toMatchObject({
    ExpressionAttributeValues: { ':timeout': 30, ':created': approval.created_at },
  });
  expect(transactions[0][3].Update.UpdateExpression).toContain('#status');
});

test('timeout zero remains unanswered regardless of request age', async () => {
  approval = { ...approval, status: 'PENDING', timeout_s: 0, created_at: '2020-01-01T00:00:00Z' };
  expect((await admitContinuation('task', 'user', 'request', 3)).kind).toBe('waiting');
  expect(transactions).toHaveLength(0);
});
