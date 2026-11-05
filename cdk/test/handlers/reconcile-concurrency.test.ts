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
const mockRelease = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  ScanCommand: jest.fn((input: unknown) => ({ kind: 'scan', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ kind: 'update', input })),
}));
jest.mock('../../src/handlers/shared/ua', () => ({ makeDocClient: () => ({ send: mockSend }) }));
jest.mock('../../src/handlers/shared/task-concurrency', () => ({
  releaseTaskSlot: (...args: unknown[]) => mockRelease(...args),
}));
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.USER_CONCURRENCY_TABLE_NAME = 'Counters';
import { handler } from '../../src/handlers/reconcile-concurrency';

function held(id: string, user = 'user', status = 'RUNNING') {
  return { task_id: id, user_id: user, status, concurrency_slot: { state: 'held' } };
}
function seed(counters: object[], tasks: object[]) {
  mockSend.mockResolvedValueOnce({ Items: counters }).mockResolvedValueOnce({ Items: tasks }).mockResolvedValue({});
}
function updates() {
  return mockSend.mock.calls.filter(([command]) => command.kind === 'update').map(([command]) => command.input);
}
beforeEach(() => {
  mockSend.mockReset();
  mockRelease.mockReset().mockResolvedValue(true);
});

test('empty tables complete without writes', async () => {
  seed([], []);
  await handler();
  expect(updates()).toEqual([]);
  expect(mockRelease).not.toHaveBeenCalled();
});

test('approval waits count as held seats and a matching counter needs no repair', async () => {
  seed([{ user_id: 'user', active_count: 2, reservation_version: 'v1' }],
    [held('one'), held('two', 'user', 'AWAITING_APPROVAL')]);
  await handler();
  expect(updates()).toEqual([]);
  expect(mockRelease).not.toHaveBeenCalled();
});

test('repairs drift only while the observed count and reservation revision still match', async () => {
  seed([{ user_id: 'user', active_count: 5, reservation_version: 'v1' }], [held('one'), held('two')]);
  await handler();
  expect(updates()).toEqual([expect.objectContaining({
    Key: { user_id: 'user' },
    ConditionExpression: 'attribute_exists(user_id) AND active_count = :stored AND reservation_version = :observed',
    ExpressionAttributeValues: expect.objectContaining({ ':count': 2, ':stored': 5, ':observed': 'v1' }),
  })]);
});

test('missing counters are recreated only if no reservation writer has created them meanwhile', async () => {
  seed([], [held('one')]);
  await handler();
  expect(updates()[0]).toMatchObject({
    ConditionExpression: 'attribute_not_exists(user_id)',
    ExpressionAttributeValues: { ':count': 1 },
  });
});

test('legacy counter repair checks that a version has not been installed concurrently', async () => {
  seed([{ user_id: 'user', active_count: 4 }], [held('one')]);
  await handler();
  expect(updates()[0].ConditionExpression).toContain('attribute_not_exists(reservation_version)');
});

test('ambiguous legacy active tasks prevent guessing a count', async () => {
  seed([{ user_id: 'user', active_count: 5 }], [{ task_id: 'legacy', user_id: 'user', status: 'AWAITING_APPROVAL' }]);
  await handler();
  expect(updates()).toEqual([]);
});

test('queued and unadmitted terminal tasks do not inflate the count', async () => {
  seed([{ user_id: 'user', active_count: 3 }], [
    { task_id: 'queued', user_id: 'user', status: 'QUEUED' },
    { task_id: 'failed', user_id: 'user', status: 'FAILED' },
  ]);
  await handler();
  expect(updates()[0].ExpressionAttributeValues[':count']).toBe(0);
});

test('counts terminal held markers before asking shared cleanup to release them', async () => {
  seed([{ user_id: 'user', active_count: 0, reservation_version: 'v1' }], [held('done', 'user', 'FAILED'), held('live')]);
  await handler();
  expect(updates()[0].ExpressionAttributeValues[':count']).toBe(2);
  expect(mockRelease).toHaveBeenCalledWith('done', 'user');
  expect(mockSend.mock.invocationCallOrder.at(-1)!).toBeLessThan(mockRelease.mock.invocationCallOrder[0]);
});

test('a changed revision skips stale repair and still tries terminal cleanup', async () => {
  seed([{ user_id: 'user', active_count: 3, reservation_version: 'v1' }], [held('done', 'user', 'FAILED')]);
  mockSend.mockRejectedValueOnce(Object.assign(new Error('changed'), { name: 'ConditionalCheckFailedException' }));
  await handler();
  expect(updates()).toHaveLength(1);
  expect(mockRelease).toHaveBeenCalledWith('done', 'user');
});

test('one user repair failure does not stop the next user', async () => {
  seed([{ user_id: 'one', active_count: 3 }, { user_id: 'two', active_count: 3 }], []);
  mockSend.mockRejectedValueOnce(new Error('unavailable'));
  await handler();
  expect(updates().map(update => update.Key.user_id)).toEqual(['one', 'two']);
});

test('scans every counter page before strongly scanning every task page', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ user_id: 'user', active_count: 2 }], LastEvaluatedKey: { user_id: 'user' } })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({ Items: [held('one')], LastEvaluatedKey: { task_id: 'one' } })
    .mockResolvedValueOnce({ Items: [held('two')] });
  await handler();
  expect(mockSend.mock.calls.map(([command]) => [command.input.TableName, command.input.ConsistentRead]))
    .toEqual([['Counters', true], ['Counters', true], ['Tasks', true], ['Tasks', true]]);
  expect(mockSend.mock.calls[3][0].input.ExclusiveStartKey).toEqual({ task_id: 'one' });
});

test('an incomplete task scan aborts before any partial count is installed', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ user_id: 'user', active_count: 2 }] })
    .mockResolvedValueOnce({ Items: [held('one')], LastEvaluatedKey: { task_id: 'one' } })
    .mockRejectedValueOnce(new Error('scan unavailable'));
  await expect(handler()).rejects.toThrow('scan unavailable');
  expect(updates()).toEqual([]);
});
