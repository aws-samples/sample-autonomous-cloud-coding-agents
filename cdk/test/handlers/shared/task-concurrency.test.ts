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
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: jest.fn((input: unknown) => ({ kind: 'get', input })),
  TransactWriteCommand: jest.fn((input: unknown) => ({ kind: 'transaction', input })),
}));
jest.mock('../../../src/handlers/shared/ua', () => ({
  makeDocClient: () => ({ send: mockSend }),
}));
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.USER_CONCURRENCY_TABLE_NAME = 'Counters';

import { acquireTaskSlot, releaseTaskSlot } from '../../../src/handlers/shared/task-concurrency';

const base = { task_id: 'task', user_id: 'user', status: 'SUBMITTED' };
const held = { state: 'held', acquired_at: '2026-09-13T00:00:00Z' };
function cancelled(index: number) {
  return Object.assign(new Error('transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [0, 1].map(i => ({ Code: i === index ? 'ConditionalCheckFailed' : 'None' })),
  });
}
beforeEach(() => mockSend.mockReset());

test('admission atomically ties a counter increment to an owned SUBMITTED task', async () => {
  mockSend.mockResolvedValueOnce({ Item: base }).mockResolvedValueOnce({});
  expect(await acquireTaskSlot('task', 'user', 3)).toBe(true);
  const transaction = mockSend.mock.calls[1][0].input;
  expect(transaction.TransactItems).toHaveLength(2);
  expect(transaction.TransactItems[0].Update).toMatchObject({
    TableName: 'Tasks',
    Key: { task_id: 'task' },
    ConditionExpression: 'user_id = :user AND #status = :submitted AND attribute_not_exists(concurrency_slot)',
    ExpressionAttributeValues: { ':slot': { state: 'held' }, ':user': 'user', ':submitted': 'SUBMITTED' },
  });
  expect(transaction.TransactItems[1].Update).toMatchObject({
    TableName: 'Counters',
    Key: { user_id: 'user' },
    ConditionExpression: 'attribute_not_exists(active_count) OR active_count < :max',
    ExpressionAttributeValues: { ':max': 3, ':version': transaction.ClientRequestToken },
  });
});

test.each(['SUBMITTED', 'HYDRATING', 'RUNNING', 'AWAITING_APPROVAL', 'FINALIZING'])(
  'replaying admission in %s reuses the held reservation', async (status) => {
    mockSend.mockResolvedValueOnce({ Item: { ...base, status, concurrency_slot: held } });
    expect(await acquireTaskSlot('task', 'user', 3)).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
  },
);

test('a full counter declines admission without leaving a marker', async () => {
  mockSend.mockResolvedValueOnce({ Item: base }).mockRejectedValueOnce(cancelled(1))
    .mockResolvedValueOnce({ Item: base });
  expect(await acquireTaskSlot('task', 'user', 3)).toBe(false);
});

test('a transaction outage is not misreported as a full counter', async () => {
  mockSend.mockResolvedValueOnce({ Item: base }).mockRejectedValueOnce(new Error('throttled'))
    .mockResolvedValueOnce({ Item: base });
  await expect(acquireTaskSlot('task', 'user', 3)).rejects.toThrow('throttled');
});

test('a lost admission response recovers the committed held marker', async () => {
  mockSend.mockResolvedValueOnce({ Item: base }).mockRejectedValueOnce(new Error('response lost'))
    .mockResolvedValueOnce({ Item: { ...base, concurrency_slot: held } });
  expect(await acquireTaskSlot('task', 'user', 3)).toBe(true);
});

test('a cancelled task cannot acquire capacity', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ...base, status: 'CANCELLED' } });
  expect(await acquireTaskSlot('task', 'user', 3)).toBe(false);
});

test('a released task cannot reacquire even if its status is changed', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ...base, concurrency_slot: { ...held, state: 'released' } } });
  expect(await acquireTaskSlot('task', 'user', 3)).toBe(false);
});

test('owner mismatch never writes', async () => {
  mockSend.mockResolvedValueOnce({ Item: base });
  await expect(acquireTaskSlot('task', 'other', 3)).rejects.toThrow('owner');
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test.each(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])(
  '%s releases the marker and count in one guarded transaction', async (status) => {
    mockSend.mockResolvedValueOnce({ Item: { ...base, status, concurrency_slot: held } })
      .mockResolvedValueOnce({});
    expect(await releaseTaskSlot('task', 'user')).toBe(true);
    const transaction = mockSend.mock.calls[1][0].input;
    expect(transaction.TransactItems[0].Update).toMatchObject({
      ConditionExpression: 'user_id = :user AND concurrency_slot.#state = :held AND #status IN (:completed, :failed, :cancelled, :timedOut)',
      ExpressionAttributeValues: { ':released': 'released', ':held': 'held' },
    });
    expect(transaction.TransactItems[1].Update).toMatchObject({
      UpdateExpression: 'SET active_count = active_count - :one, updated_at = :now, reservation_version = :version',
      ConditionExpression: 'active_count > :zero',
    });
  },
);

test('an active task retains its slot', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ...base, status: 'AWAITING_APPROVAL', concurrency_slot: held } });
  expect(await releaseTaskSlot('task', 'user')).toBe(false);
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('unadmitted or legacy terminal tasks do not return another task seat', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ...base, status: 'FAILED' } });
  expect(await releaseTaskSlot('task', 'user')).toBe(false);
});

test('release recovers a competing commit or lost successful response', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ...base, status: 'FAILED', concurrency_slot: held } })
    .mockRejectedValueOnce(new Error('response lost'))
    .mockResolvedValueOnce({ Item: { ...base, status: 'FAILED', concurrency_slot: { ...held, state: 'released' } } });
  expect(await releaseTaskSlot('task', 'user')).toBe(false);
});

test('an empty counter closes the marker without subtracting from later admissions', async () => {
  const row = { Item: { ...base, status: 'FAILED', concurrency_slot: held } };
  mockSend.mockResolvedValueOnce(row).mockRejectedValueOnce(cancelled(1))
    .mockResolvedValueOnce(row).mockResolvedValueOnce({});
  expect(await releaseTaskSlot('task', 'user')).toBe(true);
  const update = mockSend.mock.calls[3][0].input.TransactItems[1].Update;
  expect(update.UpdateExpression).toBe('SET active_count = if_not_exists(active_count, :zero), updated_at = :now, reservation_version = :version');
  expect(update.ExpressionAttributeValues).not.toHaveProperty(':one');
});

test('a release outage propagates with the held marker intact', async () => {
  const row = { Item: { ...base, status: 'FAILED', concurrency_slot: held } };
  mockSend.mockResolvedValueOnce(row).mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(row);
  await expect(releaseTaskSlot('task', 'user')).rejects.toThrow('unavailable');
});
