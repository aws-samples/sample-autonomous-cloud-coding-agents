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

const mockLoad = jest.fn();
const mockLaunch = jest.fn();
const mockAdmit = jest.fn();
const mockStart = jest.fn();
const mockPoll = jest.fn();
const mockWorkerPoll = jest.fn();
const mockStop = jest.fn();
const mockFinalize = jest.fn();
const mockDelete = jest.fn();
const mockSend = jest.fn();
jest.mock('../../../src/handlers/shared/ua', () => ({ makeDocClient: () => ({ send: mockSend }) }));
jest.mock('../../../src/handlers/shared/orchestrator', () => ({
  loadTask: (...args: unknown[]) => mockLoad(...args),
  emitTaskEvent: jest.fn(),
  envelopeFor: () => ({ correlation: {}, log: { error: jest.fn() } }),
  finalizeTask: (...args: unknown[]) => mockFinalize(...args),
}));
jest.mock('../../../src/handlers/shared/compute-strategy', () => ({
  resolveComputeStrategy: () => ({
    startSession: mockStart, pollSession: mockWorkerPoll,
  }),
}));
jest.mock('../../../src/handlers/shared/microvm-continuation-storage', () => ({
  loadContinuationLaunch: (...args: unknown[]) => mockLaunch(...args),
}));
jest.mock('../../../src/handlers/shared/microvm-continuation-start', () => ({
  admitContinuation: (...args: unknown[]) => mockAdmit(...args),
}));
jest.mock('../../../src/handlers/shared/microvm-task-poll', () => ({
  pollMicrovmTask: (...args: unknown[]) => mockPoll(...args),
}));
jest.mock('../../../src/handlers/shared/microvm-supervisor', () => ({
  stopMicrovmWithDiagnostics: (...args: unknown[]) => mockStop(...args),
}));
jest.mock('../../../src/handlers/shared/strategies/lambda-microvm-strategy', () => ({
  deleteMicrovmPayload: (...args: unknown[]) => mockDelete(...args),
}));

import type { DurableContext } from '@aws/durable-execution-sdk-js';
import type { ComputeStrategy } from '../../../src/handlers/shared/compute-strategy';
import {
  continuationWaitStrategy, failContinuationAttempt, pollContinuationRestore, runMicrovmContinuation,
} from '../../../src/handlers/shared/microvm-continuation-runner';

const event = { task_id: 'task', continuation_request_id: 'request', continuation_attempt_id: 'attempt-new' };
const handle = { strategyType: 'lambda-microvm' as const, microvmId: 'vm-new', sessionId: 'vm-new', endpoint: 'https://worker.invalid' };
let task: any;
const context = {
  step: async (_name: string, action: () => Promise<unknown>) => action(),
  waitForCondition: async (_name: string, check: (state: any) => Promise<any>, options: any) => {
    let state = options.initialState;
    for (let i = 0; i < 3; i++) {
      state = await check(state);
      if (!options.waitStrategy(state).shouldContinue) return state;
    }
    throw new Error('fixture wait did not complete');
  },
} as unknown as DurableContext;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AWS_LAMBDA_FUNCTION_VERSION = '42';
  task = {
    task_id: 'task',
    user_id: 'user',
    status: 'AWAITING_APPROVAL',
    compute_type: 'lambda-microvm',
    awaiting_approval_request_id: 'request',
    continuation_launch: { orchestrator_version: '42' },
    continuation: {
      state: 'STARTING',
      attempt_id: 'attempt-new',
      started_at: new Date().toISOString(),
      source_handle: { imageArn: 'arn:image:original', imageVersion: '7.0' },
    },
  };
  mockLoad.mockImplementation(async () => structuredClone(task));
  mockLaunch.mockResolvedValue({
    orchestrator_version: '42',
    payload: { task_id: 'task', user_id: 'user', message: 'original instructions' },
    blueprint: { compute_type: 'lambda-microvm' },
  });
  mockAdmit.mockImplementation(async () => ({ kind: 'ready', task: structuredClone(task) }));
  mockStart.mockImplementation(async () => {
    task.session_id = 'vm-new';
    task.compute_metadata = { microvmId: 'vm-new' };
    task.microvm_start = { clientToken: 'attempt-new', handle };
    task.continuation.state = 'CONSUMED';
    task.status = 'RUNNING';
    return handle;
  });
  mockPoll.mockImplementation(async () => {
    task.status = 'COMPLETED';
    return { attempts: 1, lastStatus: 'COMPLETED' };
  });
  mockWorkerPoll.mockResolvedValue({ status: 'running', microvmState: 'RUNNING' });
  mockSend.mockImplementation(async () => { task.status = 'FAILED'; return {}; });
});
afterEach(() => { delete process.env.AWS_LAMBDA_FUNCTION_VERSION; });

test('runs saved inputs on the pinned original image with a fresh worker lifetime', async () => {
  await runMicrovmContinuation(event, context);
  expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({
    microvmImage: { imageArn: 'arn:image:original', imageVersion: '7.0' },
    payload: {
      task_id: 'task',
      user_id: 'user',
      message: 'original instructions',
      attempt_id: 'attempt-new',
      task_started_at: task.continuation.started_at,
    },
  }));
  expect(mockFinalize).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledWith('task', 'attempt-new');
  expect(mockStop).toHaveBeenCalledWith(expect.objectContaining({ handle }));
});

test('a new parked approval ends this execution without finalizing the task', async () => {
  mockPoll.mockResolvedValue({ attempts: 1, microvmParked: true });
  await runMicrovmContinuation(event, context);
  expect(mockFinalize).not.toHaveBeenCalled();
  expect(mockStop).not.toHaveBeenCalled();
  expect(mockDelete).toHaveBeenCalledWith('task', 'attempt-new');
});

test('a stale continuation event cannot launch or finalize a different assigned worker', async () => {
  task.continuation.attempt_id = 'another';
  await runMicrovmContinuation(event, context);
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockFinalize).not.toHaveBeenCalled();
});

test('a different coordinator version fails before launching a new worker', async () => {
  process.env.AWS_LAMBDA_FUNCTION_VERSION = '43';
  await runMicrovmContinuation(event, context);
  expect(mockStart).not.toHaveBeenCalled();
  const transaction = mockSend.mock.calls[0][0].input.TransactItems;
  expect(transaction[0].Update.ExpressionAttributeValues[':detail']).toContain('VERSION_CHANGED');
  expect(transaction[1].Update.ExpressionAttributeValues[':fenced']).toBe('FENCED');
});

test('restoration uses its own deadline and never issues /resume', async () => {
  task.session_id = 'vm-new';
  task.compute_metadata = { microvmId: 'vm-new' };
  task.continuation.state = 'RESTORING';
  const resume = jest.fn();
  const strategy = { pollSession: mockWorkerPoll, resumeSession: resume } as unknown as ComputeStrategy;
  const deadlineMs = Date.now() + 600_000;
  const waiting = await pollContinuationRestore(event, 'user', handle, strategy, { deadlineMs });
  expect(waiting).toEqual({ deadlineMs, consecutivePollFailures: 0 });
  expect(resume).not.toHaveBeenCalled();
  const failed = await pollContinuationRestore(event, 'user', handle, strategy, { deadlineMs: Date.now() - 1 });
  expect(failed.failure).toContain('RESTORE_TIMEOUT');
});

test('failed recovery fences the current attempt even after a new checkpoint replaced the old record', async () => {
  task.microvm_start = { clientToken: 'attempt-new', handle };
  task.continuation = { state: 'READY', identity: { attempt_id: 'vm-new' } };
  await failContinuationAttempt(event, 'user', 'restore failed');
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0].input.TransactItems[0].Update.ConditionExpression).toContain('microvm_start.clientToken = :attempt');
});

test('retirement reconciliation delays do not trigger ordinary failure finalization', () => {
  expect(continuationWaitStrategy({ attempts: 99, microvmRetiring: true, microvmRetirementError: 'Timeout' }))
    .toEqual({ shouldContinue: true, delay: { seconds: 30 } });
});
