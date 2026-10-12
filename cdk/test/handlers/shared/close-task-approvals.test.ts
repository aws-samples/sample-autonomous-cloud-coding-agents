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
import { closeTaskApprovals } from '../../../src/handlers/shared/close-task-approvals';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TASK_APPROVALS_TABLE_NAME = 'approvals';
});
afterEach(() => { delete process.env.TASK_APPROVALS_TABLE_NAME; });

test('a parked task keeps its unanswered requests and has no retention timer', async () => {
  mockSend.mockResolvedValue({ Item: { user_id: 'user', status: 'AWAITING_APPROVAL' } });
  await closeTaskApprovals('task', 'user');
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('task closure cancels unanswered requests, preserves answers, and stamps history retention', async () => {
  mockSend.mockResolvedValueOnce({ Item: { user_id: 'user', status: 'FAILED' } })
    .mockResolvedValueOnce({
      Items: [
        { user_id: 'user', request_id: 'pending', status: 'PENDING' },
        { user_id: 'user', request_id: 'approved', status: 'APPROVED' },
        { user_id: 'other', request_id: 'wrong-owner', status: 'PENDING' },
      ],
    }).mockResolvedValue({});
  await closeTaskApprovals('task', 'user');
  const updates = mockSend.mock.calls.slice(2).map(([command]) => command.input);
  expect(updates).toHaveLength(2);
  expect(updates[0].ExpressionAttributeValues).toMatchObject({
    ':cancelled': 'CANCELLED', ':observed': 'PENDING', ':reason': 'Owning task is failed.',
  });
  expect(updates[0].ExpressionAttributeValues[':ttl']).toBeGreaterThan(Date.now() / 1000 + 86400);
  expect(updates[1].UpdateExpression).toBe('SET #ttl = if_not_exists(#ttl, :ttl)');
  expect(updates[1].ExpressionAttributeValues[':cancelled']).toBeUndefined();
});

test('a mismatched task owner cannot close another user’s approvals', async () => {
  mockSend.mockResolvedValue({ Item: { user_id: 'other', status: 'CANCELLED' } });
  await closeTaskApprovals('task', 'user');
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('an answer racing task closure keeps its decision and still receives retention', async () => {
  mockSend.mockResolvedValueOnce({ Item: { user_id: 'user', status: 'CANCELLED' } })
    .mockResolvedValueOnce({ Items: [{ user_id: 'user', request_id: 'request', status: 'PENDING' }] })
    .mockRejectedValueOnce(Object.assign(new Error('answered'), { name: 'ConditionalCheckFailedException' }))
    .mockResolvedValue({});
  await closeTaskApprovals('task', 'user');
  expect(mockSend.mock.calls[3][0].input).toMatchObject({
    UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl)',
    ConditionExpression: 'user_id = :user AND #status <> :pending',
  });
});
