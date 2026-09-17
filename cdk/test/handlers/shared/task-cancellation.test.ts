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

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { TaskStatus } from '../../../src/constructs/task-status';
import { cancelTaskState } from '../../../src/handlers/shared/task-cancellation';
import type { TaskRecord } from '../../../src/handlers/shared/types';

const mockSend = jest.fn();
jest.mock('../../../src/handlers/shared/ua', () => ({
  makeDocClient: () => ({ send: (...args: unknown[]) => mockSend(...args) }),
}));

const task = {
  task_id: 'task',
  user_id: 'owner',
  status: TaskStatus.AWAITING_APPROVAL,
  awaiting_approval_request_id: 'gate',
} as TaskRecord;
const options = {
  userId: 'owner', taskTable: 'Tasks', approvalsTable: 'Approvals', eventsTable: 'Events', retentionDays: 90,
};
const pending = { status: 'PENDING', user_id: 'owner' };
const conflict = { name: 'ConditionalCheckFailedException' };
const transactionConflict = {
  name: 'TransactionCanceledException',
  CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
};
beforeEach(() => mockSend.mockReset());

test('atomically closes the exact task, pending approval and audit event', async () => {
  mockSend.mockResolvedValueOnce({ Item: pending }).mockResolvedValueOnce({});
  const result = await cancelTaskState(task, options);
  expect(result.cancelledRequestId).toBe('gate');
  const command = mockSend.mock.calls[1][0] as TransactWriteCommand;
  expect(command).toBeInstanceOf(TransactWriteCommand);
  const [taskWrite, approvalWrite, eventWrite] = command.input.TransactItems!;
  expect(taskWrite.Update).toMatchObject({
    Key: { task_id: 'task' },
    ConditionExpression: expect.stringContaining('awaiting_approval_request_id = :request'),
    ExpressionAttributeValues: { ':observed': 'AWAITING_APPROVAL', ':request': 'gate', ':user': 'owner' },
  });
  expect(approvalWrite.Update).toMatchObject({
    Key: { task_id: 'task', request_id: 'gate' },
    ExpressionAttributeValues: { ':pending': 'PENDING', ':cancelled': 'CANCELLED', ':user': 'owner' },
  });
  expect(eventWrite.Put?.Item).toMatchObject({
    event_type: 'approval_cancelled', metadata: { request_id: 'gate', status: 'CANCELLED' },
  });
});

test.each(['APPROVED', 'DENIED', 'TIMED_OUT', 'CANCELLED', 'STRANDED'])(
  'preserves an already %s approval',
  async status => {
    mockSend.mockResolvedValueOnce({ Item: { ...pending, status } }).mockResolvedValueOnce({});
    expect((await cancelTaskState(task, options)).cancelledRequestId).toBeUndefined();
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(UpdateCommand);
  },
);

test('an approval winning the transaction race stays approved while its task is cancelled', async () => {
  mockSend.mockResolvedValueOnce({ Item: pending })
    .mockRejectedValueOnce(transactionConflict)
    .mockResolvedValueOnce({ Item: task })
    .mockResolvedValueOnce({ Item: { ...pending, status: 'APPROVED' } })
    .mockResolvedValueOnce({});
  await cancelTaskState(task, options);
  expect(mockSend.mock.calls.map(([command]) => command.constructor)).toEqual([
    GetCommand, TransactWriteCommand, GetCommand, GetCommand, UpdateCommand,
  ]);
  expect(mockSend.mock.calls[2][0].input.ConsistentRead).toBe(true);
});

test('refreshes a newly created gate rather than cancelling only the old task snapshot', async () => {
  const running = { ...task, status: TaskStatus.RUNNING, awaiting_approval_request_id: null };
  mockSend.mockRejectedValueOnce(conflict)
    .mockResolvedValueOnce({ Item: task })
    .mockResolvedValueOnce({ Item: pending })
    .mockResolvedValueOnce({});
  const result = await cancelTaskState(running, options);
  expect(result.cancelledRequestId).toBe('gate');
  expect(result.task).toEqual(task);
  expect(mockSend.mock.calls[0][0].input.ConditionExpression).toContain('attribute_not_exists(awaiting_approval_request_id)');
  expect(mockSend.mock.calls[3][0]).toBeInstanceOf(TransactWriteCommand);
});

test.each([
  [undefined, 'missing'],
  [{ ...task, status: TaskStatus.COMPLETED }, 'terminal'],
  [{ ...task, user_id: 'other' }, 'forbidden'],
])('does not overwrite state after a conflicting cancellation (%s)', async (fresh, reason) => {
  mockSend.mockResolvedValueOnce({ Item: pending })
    .mockRejectedValueOnce(transactionConflict)
    .mockResolvedValueOnce({ Item: fresh });
  await expect(cancelTaskState(task, options)).rejects.toMatchObject({ reason });
  expect(mockSend).toHaveBeenCalledTimes(3);
});

test('does not fall back to a task-only cancellation after an unexpected transaction failure', async () => {
  const error = new Error('DynamoDB unavailable');
  mockSend.mockResolvedValueOnce({ Item: pending }).mockRejectedValueOnce(error);
  await expect(cancelTaskState(task, options)).rejects.toBe(error);
  expect(mockSend).toHaveBeenCalledTimes(2);
});

test('bounded conflicts leave a retryable error, never an unconditional update', async () => {
  for (let i = 0; i < 3; i++) {
    mockSend.mockResolvedValueOnce({ Item: pending })
      .mockRejectedValueOnce(transactionConflict).mockResolvedValueOnce({ Item: task });
  }
  await expect(cancelTaskState(task, options)).rejects.toMatchObject({ reason: 'conflict' });
  expect(mockSend).toHaveBeenCalledTimes(9);
});

test('a malformed foreign approval does not prevent cancellation or change that approval', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ...pending, user_id: 'other' } }).mockResolvedValueOnce({});
  await cancelTaskState(task, options);
  expect(mockSend.mock.calls[1][0]).toBeInstanceOf(UpdateCommand);
  expect(mockSend.mock.calls[1][0].input.TableName).toBe('Tasks');
});

test('fails before mutating an approval wait when required tables are not wired', async () => {
  await expect(cancelTaskState(task, { ...options, approvalsTable: undefined }))
    .rejects.toThrow('requires approvals and events tables');
  expect(mockSend).not.toHaveBeenCalled();
});
