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

/**
 * Drives the orchestrate-task durable handler with a fake durable-execution context
 * and a fake compute strategy, for the step logic that is the same on every backend:
 * what the admission step tells the channel, what the start-session step does when
 * the durable SDK runs it again, and how long the poll loop waits.
 */

// `withDurableExecution` wraps the handler at import time; unwrap it so the raw
// (event, context) function is testable. The rest of the SDK stays real: the fake
// context below decides step retries with the SDK's own default strategy.
jest.mock('@aws/durable-execution-sdk-js', () => ({
  ...jest.requireActual('@aws/durable-execution-sdk-js'),
  withDurableExecution: (fn: unknown) => fn,
}));

const mockPostLinearComment = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  postIssueComment: (...a: unknown[]) => mockPostLinearComment(...a),
}));
const mockReportJiraFailure = jest.fn();
jest.mock('../../src/handlers/shared/jira-feedback', () => ({
  reportIssueFailure: (...a: unknown[]) => mockReportJiraFailure(...a),
}));

const mockAdmissionControl = jest.fn();
const mockFailTask = jest.fn();
const mockFinalizeTask = jest.fn();
const mockHydrateAndTransition = jest.fn();
const mockLoadBlueprintConfig = jest.fn();
const mockLoadTask = jest.fn();
const mockQueueTask = jest.fn();
const mockTransitionTask = jest.fn();
jest.mock('../../src/handlers/shared/orchestrator', () => ({
  admissionControl: (...a: unknown[]) => mockAdmissionControl(...a),
  buildComputeMetadata: () => ({}),
  emitTaskEvent: jest.fn(),
  envelopeFor: () => ({
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    correlation: { user_id: 'user-1', repo: 'org/repo' },
  }),
  failTask: (...a: unknown[]) => mockFailTask(...a),
  finalizeTask: (...a: unknown[]) => mockFinalizeTask(...a),
  hydrateAndTransition: (...a: unknown[]) => mockHydrateAndTransition(...a),
  loadBlueprintConfig: (...a: unknown[]) => mockLoadBlueprintConfig(...a),
  loadTask: (...a: unknown[]) => mockLoadTask(...a),
  pollTaskStatus: jest.fn(),
  queueTask: (...a: unknown[]) => mockQueueTask(...a),
  transitionTask: (...a: unknown[]) => mockTransitionTask(...a),
}));

jest.mock('../../src/handlers/shared/preflight', () => ({
  runPreflightChecks: async () => ({ passed: true, checks: {} }),
}));

const mockStartSession = jest.fn();
jest.mock('../../src/handlers/shared/compute-strategy', () => ({
  resolveComputeStrategy: () => ({
    startSession: (...a: unknown[]) => mockStartSession(...a),
    pollSession: jest.fn(),
    stopSession: jest.fn(),
  }),
}));
jest.mock('../../src/handlers/shared/strategies/ecs-strategy', () => ({ deleteEcsPayload: jest.fn() }));
jest.mock('../../src/handlers/shared/strategies/lambda-microvm-strategy', () => ({ deleteMicrovmPayload: jest.fn() }));

process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraWorkspaceRegistry';

import { retryPresets, type DurableExecutionHandler } from '@aws/durable-execution-sdk-js';
import { TaskStatus, type TaskStatusType } from '../../src/constructs/task-status';
import { handler as exportedHandler } from '../../src/handlers/orchestrate-task';
import type { PollState } from '../../src/handlers/shared/orchestrator';

// The mock at the top of this file makes `withDurableExecution` return the function it is
// given, so the export is the raw durable handler here: it takes the task event and a
// durable context, not the Lambda invocation envelope its declared type describes.
const handler = exportedHandler as unknown as DurableExecutionHandler<{ task_id: string }, void>;

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test';
const HANDLE = { sessionId: 'session-1', strategyType: 'agentcore', runtimeArn: RUNTIME_ARN };

type WaitStrategy = (state: PollState) => { shouldContinue: boolean; delay?: { seconds: number } };

/**
 * A durable-execution context that runs a step the way the SDK does: when the body
 * throws, the step's `retryStrategy` (the SDK's default when it has none) decides
 * whether the body runs again. Delays are not waited for. `waitForCondition` keeps
 * the handler's wait strategy for the test to question and reports a finished task.
 */
function fakeContext() {
  let waitStrategy: WaitStrategy | undefined;
  return {
    waitStrategy: (): WaitStrategy => waitStrategy!,
    ctx: {
      step: async (_name: string, fn: () => Promise<unknown>, opts?: { retryStrategy?: typeof retryPresets.default }) => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await fn();
          } catch (err) {
            if (!(opts?.retryStrategy ?? retryPresets.default)(err as Error, attempt).shouldRetry) throw err;
          }
        }
      },
      waitForCondition: async (_name: string, _check: unknown, cfg: { waitStrategy: WaitStrategy }) => {
        waitStrategy = cfg.waitStrategy;
        return { attempts: 1, lastStatus: TaskStatus.COMPLETED };
      },
    },
  };
}

// The task row as the handler sees it. The stubs below move `status` the way the real
// helpers do, so a step that reads the row again sees what an earlier step wrote.
let taskStatus: TaskStatusType;
let channel: Record<string, unknown>;

beforeEach(() => {
  jest.resetAllMocks();
  taskStatus = TaskStatus.SUBMITTED;
  channel = {};
  mockLoadTask.mockImplementation(async () => ({
    task_id: 'TASK001', user_id: 'user-1', repo: 'org/repo', status: taskStatus, ...channel,
  }));
  mockLoadBlueprintConfig.mockResolvedValue({ compute_type: 'agentcore', runtime_arn: RUNTIME_ARN });
  mockAdmissionControl.mockResolvedValue(true);
  mockHydrateAndTransition.mockImplementation(async () => {
    taskStatus = TaskStatus.HYDRATING;
    return { repo_url: 'org/repo', task_id: 'TASK001' };
  });
  mockStartSession.mockResolvedValue(HANDLE);
  mockTransitionTask.mockImplementation(async (_id: string, from: TaskStatusType, to: TaskStatusType) => {
    if (taskStatus !== from) {
      throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
    }
    taskStatus = to;
  });
  mockFailTask.mockImplementation(async (_id: string, from: TaskStatusType) => {
    if (taskStatus === from) taskStatus = TaskStatus.FAILED;
  });
});

describe('admission step at the concurrency cap', () => {
  const channels = [
    {
      name: 'Linear',
      notice: mockPostLinearComment,
      task: {
        channel_source: 'linear',
        channel_metadata: { linear_issue_id: 'lin-issue-1', linear_workspace_id: 'lin-org-1' },
      },
    },
    {
      name: 'Jira',
      notice: mockReportJiraFailure,
      task: {
        channel_source: 'jira',
        channel_metadata: { jira_cloud_id: 'cloud-1', jira_issue_key: 'ENG-42' },
      },
    },
  ];

  test.each(channels)('tells the $name issue that the task was queued', async ({ notice, task }) => {
    channel = task;
    mockAdmissionControl.mockResolvedValue(false);
    mockQueueTask.mockResolvedValue(true);

    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);

    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0][2]).toContain('this task has been queued');
  });

  test.each(channels)('says nothing on the $name issue when the task was not queued', async ({ notice, task }) => {
    channel = task;
    mockAdmissionControl.mockResolvedValue(false);
    // queueTask answers false when another writer (a user cancel) changed the
    // status first: the task is CANCELLED and will never start.
    mockQueueTask.mockResolvedValue(false);

    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);

    expect(mockQueueTask).toHaveBeenCalledTimes(1);
    expect(notice).not.toHaveBeenCalled();
  });
});

describe('start-session step', () => {
  test('starts one session for a task that is still HYDRATING', async () => {
    await handler({ task_id: 'TASK001' }, fakeContext().ctx as never);

    expect(mockStartSession).toHaveBeenCalledTimes(1);
    expect(taskStatus).toBe(TaskStatus.RUNNING);
    expect(mockFinalizeTask).toHaveBeenCalledTimes(1);
  });

  test('starts no session when the durable SDK runs the step again after it failed the task', async () => {
    // AgentCore throttles the first InvokeAgentRuntime and has recovered by the
    // time the SDK retries the step. The first attempt already moved the task
    // to FAILED, so a session started now would run for a task the user was
    // told has failed.
    mockStartSession
      .mockRejectedValueOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .mockResolvedValue(HANDLE);

    await expect(handler({ task_id: 'TASK001' }, fakeContext().ctx as never)).rejects.toThrow();

    expect(taskStatus).toBe(TaskStatus.FAILED);
    expect(mockStartSession).toHaveBeenCalledTimes(1);
  });

  test('starts no session for a task that was cancelled while its context was hydrated', async () => {
    mockHydrateAndTransition.mockImplementation(async () => {
      taskStatus = TaskStatus.CANCELLED;
      return { repo_url: 'org/repo', task_id: 'TASK001' };
    });

    await expect(handler({ task_id: 'TASK001' }, fakeContext().ctx as never)).rejects.toThrow();

    expect(mockStartSession).not.toHaveBeenCalled();
    expect(taskStatus).toBe(TaskStatus.CANCELLED);
  });
});

describe('poll window', () => {
  /** The handler's decision after `attempts` polls of a task that is still RUNNING. */
  async function pollDecisions(pollIntervalMs?: number) {
    mockLoadBlueprintConfig.mockResolvedValue({
      compute_type: 'agentcore', runtime_arn: RUNTIME_ARN, poll_interval_ms: pollIntervalMs,
    });
    const { ctx, waitStrategy } = fakeContext();
    await handler({ task_id: 'TASK001' }, ctx as never);
    return (attempts: number) => waitStrategy()({ attempts, lastStatus: TaskStatus.RUNNING });
  }

  test('closes after 1020 polls at the default 30 s interval (8.5 h)', async () => {
    const after = await pollDecisions();

    expect(after(1019)).toEqual({ shouldContinue: true, delay: { seconds: 30 } });
    expect(after(1020)).toEqual({ shouldContinue: false });
  });

  test('is still 8.5 h at a 5 s interval, not 85 minutes', async () => {
    const after = await pollDecisions(5_000);

    expect(after(1020)).toEqual({ shouldContinue: true, delay: { seconds: 5 } });
    expect(after(6119)).toEqual({ shouldContinue: true, delay: { seconds: 5 } });
    expect(after(6120)).toEqual({ shouldContinue: false });
  });

  test('is still 8.5 h at a 300 s interval, not 85 hours', async () => {
    const after = await pollDecisions(300_000);

    expect(after(101)).toEqual({ shouldContinue: true, delay: { seconds: 300 } });
    expect(after(102)).toEqual({ shouldContinue: false });
  });
});
