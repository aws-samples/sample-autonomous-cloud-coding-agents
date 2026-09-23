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

import { ensureWorkerLease, leaseHandleUpdate } from '../../../src/handlers/shared/microvm-worker-lease';

const input = { taskId: 'task', userId: 'user', repo: 'owner/repo', attemptId: 'attempt-1', requestHash: 'hash' };
const lease = {
  task_id: 'worker-lease#task',
  lease_attempt_id: 'attempt-1',
  lease_state: 'ACTIVE',
  lease_user_id: 'user',
  lease_repo: 'owner/repo',
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CONTINUATION_BUCKET_NAME = 'continuations';
  mockSend.mockResolvedValue({});
});
afterEach(() => { delete process.env.CONTINUATION_BUCKET_NAME; });

test('creates authority only alongside the same task owner and immutable start receipt', async () => {
  await ensureWorkerLease(input);
  const transaction = mockSend.mock.calls[0][0].input.TransactItems;
  expect(transaction[0].ConditionCheck.ExpressionAttributeValues).toMatchObject({
    ':user': 'user', ':attempt': 'attempt-1', ':hash': 'hash',
  });
  expect(transaction[1].Put).toMatchObject({
    Item: lease, ConditionExpression: 'attribute_not_exists(task_id)',
  });
  // Reserved rows cannot enter ordinary task status/user indexes.
  expect(transaction[1].Put.Item).not.toHaveProperty('status');
  expect(transaction[1].Put.Item).not.toHaveProperty('user_id');
});

test('lost successful acknowledgement accepts the same active lease with a registered handle', async () => {
  mockSend.mockRejectedValueOnce(new Error('reply lost')).mockResolvedValueOnce({
    Item: { ...lease, lease_microvm_id: 'microvm-one' },
  });
  await expect(ensureWorkerLease(input)).resolves.toBeUndefined();
  expect(mockSend.mock.calls[1][0].input.ConsistentRead).toBe(true);
});

test.each([
  { lease_state: 'FENCED' }, { lease_state: 'PARKED' }, { lease_attempt_id: 'new-attempt' },
  { lease_user_id: 'other' }, { lease_repo: 'other/repo' },
])('a replay cannot replace or reactivate changed authority: %j', async changed => {
  mockSend.mockRejectedValueOnce(new Error('conditional failure')).mockResolvedValueOnce({
    Item: { ...lease, ...changed },
  });
  await expect(ensureWorkerLease(input)).rejects.toThrow('conditional failure');
  expect(mockSend).toHaveBeenCalledTimes(2);
});

test('handle registration never changes the lease state', () => {
  const update = leaseHandleUpdate('task', 'attempt-1', 'microvm-one').Update;
  expect(update.Key).toEqual({ task_id: 'worker-lease#task' });
  expect(update.UpdateExpression).toBe('SET lease_microvm_id = :id');
  expect(update.ConditionExpression).toContain('lease_attempt_id = :attempt');
});
