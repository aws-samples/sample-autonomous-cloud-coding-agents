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
const mockVerify = jest.fn();
const mockStopSession = jest.fn();
jest.mock('../../../src/handlers/shared/ua', () => ({ makeDocClient: () => ({ send: mockSend }) }));
jest.mock('../../../src/handlers/shared/microvm-continuation-storage', () => ({
  verifyContinuationCheckpoint: (...args: unknown[]) => mockVerify(...args),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: jest.fn(input => ({ kind: 'get', input })),
  TransactWriteCommand: jest.fn(input => ({ kind: 'transact', input })),
}));
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: { warn: jest.fn() } }));

import type { ComputeStrategy } from '../../../src/handlers/shared/compute-strategy';
import { retireCheckpointedMicrovm } from '../../../src/handlers/shared/microvm-continuation-retirement';

const handle = {
  strategyType: 'lambda-microvm' as const,
  microvmId: 'microvm-one',
  sessionId: 'microvm-one',
  endpoint: 'https://example.invalid',
};
const identity = { task_id: 'task', attempt_id: 'microvm-one', request_id: 'request', user_id: 'user', repo: 'owner/repo' };
const record = {
  version: 1,
  state: 'READY',
  identity,
  manifest: {
    kind: 'manifest',
    key: `continuations/task/microvm-one/request/manifest/${'a'.repeat(64)}.json`,
    sha256: 'a'.repeat(64),
    version_id: 'version-1',
    size_bytes: 100,
  },
};
let task: Record<string, any>;
let strategy: ComputeStrategy;
let transactions: any[];
let leaseState: string;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CONTINUATION_BUCKET_NAME = 'continuations';
  task = {
    task_id: 'task',
    user_id: 'user',
    repo: 'owner/repo',
    status: 'AWAITING_APPROVAL',
    session_id: handle.microvmId,
    awaiting_approval_request_id: 'request',
    continuation: structuredClone(record),
    microvm_start: { clientToken: 'task' },
    concurrency_slot: { state: 'held', acquired_at: '2026-09-17T00:00:00Z' },
  };
  transactions = [];
  leaseState = 'ACTIVE';
  mockVerify.mockResolvedValue(undefined);
  mockSend.mockImplementation(async ({ kind, input }) => {
    if (kind === 'get' && input.Key.task_id === 'worker-lease#task') {
      return {
        Item: {
          lease_state: leaseState,
          lease_attempt_id: 'task',
          lease_microvm_id: 'microvm-one',
          lease_user_id: 'user',
          lease_repo: 'owner/repo',
        },
      };
    }
    if (kind === 'get') {
      return input.Key.request_id
        ? { Item: { user_id: 'user', status: 'PENDING', created_at: new Date(Date.now() - 7200000).toISOString() } }
        : { Item: structuredClone(task) };
    }
    transactions.push(input.TransactItems);
    const values = input.TransactItems[0].Update.ExpressionAttributeValues;
    task.continuation = structuredClone(values[':fenced'] ?? values[':parked']);
    leaseState = task.continuation.state;
    if (leaseState === 'PARKED') task.concurrency_slot = { ...task.concurrency_slot, state: 'released' };
    return {};
  });
  strategy = {
    type: 'lambda-microvm',
    startSession: jest.fn(),
    suspendSession: jest.fn(),
    resumeSession: jest.fn(),
    stopSession: mockStopSession.mockResolvedValue({ outcome: 'requested' }),
    pollSession: jest.fn().mockResolvedValue({ status: 'running', microvmState: 'TERMINATING' }),
  };
});
afterEach(() => { delete process.env.CONTINUATION_BUCKET_NAME; });

function run(force = false) {
  return retireCheckpointedMicrovm({
    taskId: 'task', userId: 'user', handle, strategy, sessionDeadlineMs: Date.now() + 28800000, force,
  });
}

test('fences before termination, holds capacity until terminal observation, then parks once', async () => {
  expect(await run()).toBe('stopping');
  expect(mockVerify).toHaveBeenCalledWith(record, expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
  expect(transactions).toHaveLength(1);
  expect(transactions[0][1].Update.ExpressionAttributeValues).toMatchObject({
    ':fenced': 'FENCED', ':active': 'ACTIVE', ':attempt': 'task', ':vm': 'microvm-one',
  });
  expect(transactions[0][0].Update.ConditionExpression).toContain('continuation = :record');
  expect(task.status).toBe('AWAITING_APPROVAL');
  (strategy.pollSession as jest.Mock).mockResolvedValue({ status: 'completed', microvmState: 'TERMINATED' });
  expect(await run()).toBe('parked');
  expect(transactions).toHaveLength(2);
  expect(transactions[1][2].Update.UpdateExpression).toContain('active_count = active_count - :one');
  expect(transactions[1][0].Update.ExpressionAttributeValues[':slot'].state).toBe('held');
  expect(task.concurrency_slot.state).toBe('released');
  expect(task.awaiting_approval_request_id).toBe('request');
  expect(await run()).toBe('parked');
  expect(transactions).toHaveLength(2);
});

test('a human answer winning the fence race leaves the original worker running', async () => {
  mockSend.mockImplementation(async ({ kind, input }) => {
    if (kind === 'get') {
      return input.Key.request_id
        ? { Item: { created_at: new Date(Date.now() - 7200000).toISOString() } }
        : { Item: structuredClone(task) };
    }
    task.status = 'RUNNING';
    delete task.continuation;
    throw new Error('fence condition lost');
  });
  expect(await run()).toBe('not-due');
  expect(mockStopSession).not.toHaveBeenCalled();
});

test('missing durable objects cannot retire the only copy of the workspace', async () => {
  mockVerify.mockRejectedValue(new Error('missing pinned workspace version'));
  await expect(run()).rejects.toThrow('missing pinned workspace');
  expect(transactions).toHaveLength(0);
  expect(mockStopSession).not.toHaveBeenCalled();
});

test('sleep off retains the worker until its lifetime margin', async () => {
  task.microvm_sleep_after_s = 0;
  expect(await run()).toBe('not-due');
  expect(mockStopSession).not.toHaveBeenCalled();
  expect(await retireCheckpointedMicrovm({
    taskId: 'task', userId: 'user', handle, strategy, sessionDeadlineMs: Date.now() + 100000,
  })).toBe('stopping');
});

test('a stale coordinator never follows or stops a replacement worker', async () => {
  task.session_id = 'microvm-new';
  expect(await run(true)).toBe('ownership-lost');
  expect(transactions).toHaveLength(0);
  expect(mockStopSession).not.toHaveBeenCalled();
});

test.each(['FENCED', 'PARKED'])('a worker-written %s label cannot replace coordinator lease authority', async state => {
  task.continuation = { ...task.continuation, state, source_handle: handle };
  await expect(run()).rejects.toThrow('no coordinator authority');
  expect(mockStopSession).not.toHaveBeenCalled();
  expect(transactions).toHaveLength(0);
});

test('lost fence reply cannot accept a worker-written label while its readonly lease remains active', async () => {
  const normal = mockSend.getMockImplementation()!;
  mockSend.mockImplementation(async (command, options) => {
    if (command.kind === 'transact') {
      task.continuation = { ...task.continuation, state: 'FENCED', source_handle: handle };
      throw new Error('fence did not commit');
    }
    return normal(command, options);
  });
  expect(await run()).toBe('not-due');
  expect(mockStopSession).not.toHaveBeenCalled();
  expect(leaseState).toBe('ACTIVE');
});
