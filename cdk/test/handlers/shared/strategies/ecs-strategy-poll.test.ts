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

jest.mock('@aws/durable-execution-sdk-js', () => ({
  withDurableExecution: (fn: unknown) => fn,
}));

delete process.env.ECS_PAYLOAD_BUCKET;

const CLUSTER_ARN = 'arn:aws:ecs:us-east-1:123456789012:cluster/test-cluster';
const TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/abc123';
const HANDLE = { sessionId: TASK_ARN, strategyType: 'ecs', clusterArn: CLUSTER_ARN, taskArn: TASK_ARN };
const TASK_MISSING = { tasks: [], failures: [{ arn: TASK_ARN, reason: 'MISSING' }] };

const mockEcsSend = jest.fn();
jest.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: jest.fn(() => ({ send: mockEcsSend })),
  DescribeTasksCommand: jest.fn((input: unknown) => ({ _type: 'DescribeTasks', input })),
}));

const mockFailTask = jest.fn();
const mockPollTaskStatus = jest.fn();
jest.mock('../../../../src/handlers/shared/orchestrator', () => ({
  admissionControl: async () => true,
  buildComputeMetadata: () => ({}),
  emitTaskEvent: async () => undefined,
  envelopeFor: () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, correlation: {} }),
  failTask: (...a: unknown[]) => mockFailTask(...a),
  finalizeTask: async () => undefined,
  hydrateAndTransition: async () => ({ repo_url: 'org/repo', task_id: 'TASK001' }),
  loadBlueprintConfig: async () => ({ compute_type: 'ecs', runtime_arn: '' }),
  loadTask: async () => ({ task_id: 'TASK001', user_id: 'user-1', repo: 'org/repo', status: 'SUBMITTED' }),
  pollTaskStatus: (...a: unknown[]) => mockPollTaskStatus(...a),
  transitionTask: async () => undefined,
}));
jest.mock('../../../../src/handlers/shared/preflight', () => ({
  runPreflightChecks: async () => ({ passed: true, checks: [] }),
}));
jest.mock('../../../../src/handlers/shared/session-start-retry', () => ({
  isAutoRetried: () => false,
  startSessionWithRetry: async () => ({ handle: HANDLE, autoRetried: false }),
}));

import type { DurableExecutionHandler } from '@aws/durable-execution-sdk-js';
import { TaskStatus } from '../../../../src/constructs/task-status';
import { handler as exportedHandler } from '../../../../src/handlers/orchestrate-task';
import type { PollState } from '../../../../src/handlers/shared/orchestrator';

const handler = exportedHandler as unknown as DurableExecutionHandler<{ task_id: string }, void>;

const loopingContext = {
  step: async (_name: string, fn: () => Promise<unknown>) => fn(),
  waitForCondition: async (
    _name: string,
    check: (state: PollState) => Promise<PollState>,
    cfg: { initialState: PollState; waitStrategy: (state: PollState) => { shouldContinue: boolean } },
  ) => {
    let state = cfg.initialState;
    for (let polls = 0; polls < 10; polls++) {
      state = await check(state);
      if (!cfg.waitStrategy(state).shouldContinue) return state;
    }
    throw new Error('the wait strategy never stopped the poll loop');
  },
};

beforeEach(() => {
  mockEcsSend.mockReset();
  mockFailTask.mockReset();
  mockPollTaskStatus.mockReset().mockImplementation(async (_taskId: string, state: PollState) => ({
    attempts: state.attempts + 1,
    lastStatus: TaskStatus.RUNNING,
  }));
});

describe('orchestrate-task poll loop for an ECS task that DescribeTasks does not return', () => {
  test('does not fail the task when the first poll, right after RunTask, misses it', async () => {
    // The ECS API is eventually consistent.
    mockEcsSend
      .mockResolvedValueOnce(TASK_MISSING)
      .mockResolvedValueOnce({ tasks: [{ lastStatus: 'RUNNING' }] });
    mockPollTaskStatus
      .mockResolvedValueOnce({ attempts: 1, lastStatus: TaskStatus.RUNNING })
      .mockResolvedValueOnce({ attempts: 2, lastStatus: TaskStatus.RUNNING })
      .mockResolvedValueOnce({ attempts: 3, lastStatus: TaskStatus.COMPLETED });

    await handler({ task_id: 'TASK001' }, loopingContext as never);

    expect(mockFailTask).not.toHaveBeenCalled();
    expect(mockEcsSend).toHaveBeenCalledTimes(2);
  });

  test('fails the task when three polls in a row miss it', async () => {
    mockEcsSend.mockResolvedValue(TASK_MISSING);

    await handler({ task_id: 'TASK001' }, loopingContext as never);

    expect(mockFailTask.mock.calls.map(call => call[2])).toEqual([
      `ECS poll failed 3 consecutive times: ECS task ${TASK_ARN} not found`,
    ]);
    expect(mockEcsSend).toHaveBeenCalledTimes(3);
  });
});
