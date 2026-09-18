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
const mockStop = jest.fn();
const mockPoll = jest.fn();
const mockClose = jest.fn();
const mockDelete = jest.fn();
const mockRelease = jest.fn();
const mockRetire = jest.fn();
const mockDispatch = jest.fn();
jest.mock('../../src/handlers/shared/ua', () => ({ makeDocClient: () => ({ send: mockSend }) }));
jest.mock('../../src/handlers/shared/strategies/lambda-microvm-strategy', () => ({
  LambdaMicrovmComputeStrategy: jest.fn(() => ({ stopSession: mockStop, pollSession: mockPoll })),
  MICROVM_MAX_DURATION_SECONDS: 28800,
}));
jest.mock('../../src/handlers/shared/close-task-approvals', () => ({ closeTaskApprovals: (...args: unknown[]) => mockClose(...args) }));
jest.mock('../../src/handlers/shared/task-concurrency', () => ({ releaseTaskSlot: (...args: unknown[]) => mockRelease(...args) }));
jest.mock('../../src/handlers/shared/microvm-continuation-storage', () => ({
  deleteClosedTaskContinuations: (...args: unknown[]) => mockDelete(...args),
}));
jest.mock('../../src/handlers/shared/microvm-continuation-retirement', () => ({
  retireCheckpointedMicrovm: (...args: unknown[]) => mockRetire(...args),
}));
jest.mock('../../src/handlers/shared/microvm-continuation-dispatch', () => ({
  dispatchMicrovmContinuation: (...args: unknown[]) => mockDispatch(...args),
}));
jest.mock('../../src/handlers/shared/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn() } }));

import { handler, reconcileMicrovmContinuation } from '../../src/handlers/reconcile-microvm-continuations';

let task: any;
beforeEach(() => {
  jest.resetAllMocks();
  task = {
    task_id: 'task',
    user_id: 'user',
    status: 'AWAITING_APPROVAL',
    awaiting_approval_request_id: 'request',
    continuation: { state: 'PARKED' },
    continuation_launch: {},
    microvm_start: { clientToken: 'attempt', createdAt: new Date().toISOString() },
  };
  mockSend.mockResolvedValue({});
});

test('a parked unanswered task is offered for admission without waking its retired worker', async () => {
  await reconcileMicrovmContinuation(task);
  expect(mockDispatch).toHaveBeenCalledWith('task', 'user', 'request', expect.any(Object));
  expect(mockStop).not.toHaveBeenCalled();
  expect(mockDelete).not.toHaveBeenCalled();
});

test('a terminated source triggers verified retirement before dispatch', async () => {
  task.continuation.state = 'READY';
  task.microvm_start.handle = { microvmId: 'old' };
  mockPoll.mockResolvedValue({ microvmState: 'TERMINATED' });
  await reconcileMicrovmContinuation(task);
  expect(mockRetire).toHaveBeenCalledWith(expect.objectContaining({ force: true, handle: { microvmId: 'old' } }));
  expect(mockRetire.mock.invocationCallOrder[0]).toBeLessThan(mockDispatch.mock.invocationCallOrder[0]);
});

test('unknown start keeps artifacts and capacity until its maximum service lifetime', async () => {
  task.status = 'FAILED';
  mockSend.mockResolvedValue({ Item: task });
  await reconcileMicrovmContinuation(task);
  expect(mockClose).toHaveBeenCalled();
  expect(mockRelease).not.toHaveBeenCalled();
  expect(mockDelete).not.toHaveBeenCalled();
  task.microvm_start.createdAt = new Date(Date.now() - 29_000_000).toISOString();
  await reconcileMicrovmContinuation(task);
  expect(mockRelease).toHaveBeenCalledWith('task', 'user');
  expect(mockDelete).toHaveBeenCalled();
  const closed = mockSend.mock.calls.find(([command]) => command.constructor.name === 'UpdateCommand')![0].input;
  expect(closed.ExpressionAttributeValues).toMatchObject({ ':closed': 'CLOSED', ':attempt': 'attempt' });
});

test('unconfirmed termination retains artifacts and reservation', async () => {
  task.status = 'CANCELLED';
  task.microvm_start.handle = { microvmId: 'vm' };
  mockSend.mockResolvedValue({ Item: task });
  mockPoll.mockResolvedValue({ microvmState: 'TERMINATING' });
  await reconcileMicrovmContinuation(task);
  expect(mockStop).toHaveBeenCalledWith({ microvmId: 'vm' }, expect.any(Object));
  expect(mockRelease).not.toHaveBeenCalled();
  expect(mockDelete).not.toHaveBeenCalled();
});

test('terminal scan rows cannot stop a task whose current record is active', async () => {
  mockSend.mockResolvedValue({ Item: task });
  await reconcileMicrovmContinuation({ ...task, status: 'FAILED' });
  expect(mockStop).not.toHaveBeenCalled();
  expect(mockClose).not.toHaveBeenCalled();
});

test('closes a retired source using its preserved lease token after microvm_start was removed', async () => {
  task.status = 'CANCELLED';
  delete task.microvm_start;
  mockSend.mockImplementation(async command => {
    if (command.constructor.name === 'UpdateCommand') return {};
    return {
      Item: command.input.Key.task_id === 'task' ? task : {
        lease_user_id: 'user', lease_attempt_id: 'retired-launch-token', lease_state: 'PARKED',
      },
    };
  });
  await reconcileMicrovmContinuation(task);
  const closed = mockSend.mock.calls.find(([command]) => command.constructor.name === 'UpdateCommand')![0].input;
  expect(closed.ExpressionAttributeValues[':attempt']).toBe('retired-launch-token');
  expect(closed.ExpressionAttributeValues[':observedState']).toBe('PARKED');
  expect(mockRelease).toHaveBeenCalledWith('task', 'user');
  expect(mockDelete).toHaveBeenCalled();
});

test('releases a cancelled replacement admitted before any start receipt or AWS call', async () => {
  task.status = 'CANCELLED';
  delete task.microvm_start;
  task.continuation = { state: 'STARTING', attempt_id: 'new-token' };
  task.concurrency_slot = { state: 'held', attempt_id: 'new-token' };
  mockSend.mockImplementation(async command => {
    if (command.constructor.name === 'UpdateCommand') return {};
    return {
      Item: command.input.Key.task_id === 'task' ? task : {
        lease_user_id: 'user', lease_attempt_id: 'new-token', lease_state: 'ACTIVE',
      },
    };
  });
  await reconcileMicrovmContinuation(task);
  const closed = mockSend.mock.calls.find(([command]) => command.constructor.name === 'UpdateCommand')![0].input;
  expect(closed.ExpressionAttributeValues[':attempt']).toBe('new-token');
  expect(closed.ExpressionAttributeValues[':observedState']).toBe('ACTIVE');
  expect(closed.ConditionExpression).toContain('attribute_not_exists(lease_microvm_id)');
  expect(mockRelease).toHaveBeenCalledWith('task', 'user');
  expect(mockDelete).toHaveBeenCalled();
});

test('does not release a live lease just because the start record is absent', async () => {
  task.status = 'CANCELLED';
  delete task.microvm_start;
  mockSend.mockImplementation(async command => ({
    Item: command.input.Key.task_id === 'task' ? task : {
      lease_user_id: 'user', lease_attempt_id: 'live-token', lease_state: 'ACTIVE',
    },
  }));
  await expect(reconcileMicrovmContinuation(task)).rejects.toThrow('LEASE_INVALID');
  expect(mockRelease).not.toHaveBeenCalled();
  expect(mockDelete).not.toHaveBeenCalled();
});

test('invalid unknown-start timestamp cannot be treated as proof of shutdown', async () => {
  task.status = 'FAILED';
  task.microvm_start.createdAt = 'invalid';
  mockSend.mockResolvedValue({ Item: task });
  await expect(reconcileMicrovmContinuation(task)).rejects.toThrow('START_TIME_INVALID');
  expect(mockRelease).not.toHaveBeenCalled();
});

test('persists the last completed batch when invocation time is low, then resumes from that key', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ ...task, task_id: `task-${index}` }));
  mockSend.mockImplementation(async command => {
    if (command.constructor.name === 'GetCommand') return { Item: { cursor: { task_id: 'previous' } } };
    if (command.constructor.name === 'ScanCommand') return { Items: rows, LastEvaluatedKey: { task_id: 'page-end' } };
    return {};
  });
  const remaining = jest.fn().mockReturnValueOnce(100000).mockReturnValueOnce(100000).mockReturnValue(40000);
  await handler({}, { getRemainingTimeInMillis: remaining });
  expect(mockDispatch).toHaveBeenCalledTimes(4);
  expect(mockSend.mock.calls.find(([command]) => command.constructor.name === 'ScanCommand')![0].input.ExclusiveStartKey)
    .toEqual({ task_id: 'previous' });
  expect(mockSend.mock.calls.at(-1)![0].input.ExpressionAttributeValues[':cursor']).toEqual({ task_id: 'task-3' });
});

test('a failed row does not prevent later rows or clearing the cursor after a complete scan', async () => {
  mockSend.mockImplementation(async command => command.constructor.name === 'ScanCommand'
    ? { Items: [task, { ...task, task_id: 'next' }] } : {});
  mockDispatch.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(true);
  await handler({}, { getRemainingTimeInMillis: () => 100000 });
  expect(mockDispatch).toHaveBeenCalledTimes(2);
  expect(mockSend.mock.calls.at(-1)![0].input.UpdateExpression).toBe('REMOVE #cursor');
});
