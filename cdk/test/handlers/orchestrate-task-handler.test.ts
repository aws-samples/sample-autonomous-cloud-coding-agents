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

// `from` is a plain function: `jest.resetAllMocks()` would strip the implementation from a jest.fn().
const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockDdbSend(...a) }) },
  GetCommand: jest.fn(),
}));

const mockAdmissionControl = jest.fn();
const mockEmitTaskEvent = jest.fn();
const mockFailTask = jest.fn();
const mockFinalizeTask = jest.fn();
const mockHydrateAndTransition = jest.fn();
const mockLoadBlueprintConfig = jest.fn();
const mockLoadTask = jest.fn();
const mockLogWarn = jest.fn();
const mockPollTaskStatus = jest.fn();
const mockQueueTask = jest.fn();
const mockTransitionTask = jest.fn();
jest.mock('../../src/handlers/shared/orchestrator', () => ({
  admissionControl: (...a: unknown[]) => mockAdmissionControl(...a),
  buildComputeMetadata: () => ({}),
  emitTaskEvent: (...a: unknown[]) => mockEmitTaskEvent(...a),
  envelopeFor: () => ({
    log: { info: jest.fn(), warn: (...a: unknown[]) => mockLogWarn(...a), error: jest.fn() },
    correlation: { user_id: 'user-1', repo: 'org/repo' },
  }),
  failTask: (...a: unknown[]) => mockFailTask(...a),
  finalizeTask: (...a: unknown[]) => mockFinalizeTask(...a),
  hydrateAndTransition: (...a: unknown[]) => mockHydrateAndTransition(...a),
  loadBlueprintConfig: (...a: unknown[]) => mockLoadBlueprintConfig(...a),
  loadTask: (...a: unknown[]) => mockLoadTask(...a),
  pollTaskStatus: (...a: unknown[]) => mockPollTaskStatus(...a),
  queueTask: (...a: unknown[]) => mockQueueTask(...a),
  transitionTask: (...a: unknown[]) => mockTransitionTask(...a),
}));

jest.mock('../../src/handlers/shared/preflight', () => ({
  runPreflightChecks: async () => ({ passed: true, checks: {} }),
}));

const mockStartSession = jest.fn();
const mockPollSession = jest.fn();
jest.mock('../../src/handlers/shared/compute-strategy', () => ({
  resolveComputeStrategy: () => ({
    startSession: (...a: unknown[]) => mockStartSession(...a),
    pollSession: (...a: unknown[]) => mockPollSession(...a),
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

const handler = exportedHandler as unknown as DurableExecutionHandler<{ task_id: string }, void>;

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test';
const HANDLE = { sessionId: 'session-1', strategyType: 'agentcore', runtimeArn: RUNTIME_ARN };
const ECS_TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/abc123';
const ECS_HANDLE = {
  sessionId: ECS_TASK_ARN,
  strategyType: 'ecs',
  clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/test-cluster',
  taskArn: ECS_TASK_ARN,
};

type WaitStrategy = (state: PollState) => { shouldContinue: boolean; delay?: { seconds: number } };

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

function pollingContext(maxPolls = 10) {
  return {
    ...fakeContext().ctx,
    waitForCondition: async (
      _name: string,
      check: (state: PollState) => Promise<PollState>,
      cfg: { initialState: PollState; waitStrategy: WaitStrategy },
    ) => {
      let state = cfg.initialState;
      for (let polls = 0; polls < maxPolls; polls++) {
        state = await check(state);
        if (!cfg.waitStrategy(state).shouldContinue) return state;
      }
      throw new Error('the wait strategy never stopped the poll loop');
    },
  };
}

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

  test('starts no session when only a strongly consistent read shows the cancel', async () => {
    mockHydrateAndTransition.mockImplementation(async () => {
      taskStatus = TaskStatus.CANCELLED;
      return { repo_url: 'org/repo', task_id: 'TASK001' };
    });
    mockLoadTask.mockImplementation(async (_id: string, consistentRead?: boolean) => ({
      task_id: 'TASK001',
      user_id: 'user-1',
      repo: 'org/repo',
      status: consistentRead ? taskStatus : TaskStatus.HYDRATING,
    }));

    const [outcome] = await Promise.allSettled([handler({ task_id: 'TASK001' }, fakeContext().ctx as never)]);

    expect(mockStartSession).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'rejected', reason: { message: 'Task is CANCELLED, no session started' } });
  });

  test.each([
    ['agentcore', HANDLE],
    ['ecs', ECS_HANDLE],
  ])('starts one %s session when the session_started event cannot be written', async (computeType, handle) => {
    mockLoadBlueprintConfig.mockResolvedValue({ compute_type: computeType, runtime_arn: RUNTIME_ARN });
    mockStartSession.mockResolvedValue(handle);
    mockEmitTaskEvent.mockRejectedValueOnce(
      Object.assign(new Error('Throughput exceeds the current capacity of your table'), { name: 'ThrottlingException' }),
    );

    const [outcome] = await Promise.allSettled([handler({ task_id: 'TASK001' }, fakeContext().ctx as never)]);

    expect(mockEmitTaskEvent.mock.calls.map(call => call[1])).toEqual(['session_started']);
    expect(mockStartSession).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('fulfilled');
    expect(taskStatus).toBe(TaskStatus.RUNNING);
    expect(mockFinalizeTask).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('session_started'),
      expect.objectContaining({ session_id: handle.sessionId }),
    );
  });
});

describe('poll window', () => {
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

describe('status reads that fail during the wait', () => {
  const { pollTaskStatus } = jest.requireActual<typeof import('../../src/handlers/shared/orchestrator')>(
    '../../src/handlers/shared/orchestrator',
  );
  const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });

  beforeEach(() => {
    mockPollTaskStatus.mockImplementation(pollTaskStatus);
    mockPollSession.mockResolvedValue({ status: 'running' });
  });

  describe.each([
    ['agentcore', HANDLE],
    ['ecs', ECS_HANDLE],
  ])('of an %s task', (computeType, handle) => {
    beforeEach(() => {
      mockLoadBlueprintConfig.mockResolvedValue({ compute_type: computeType, runtime_arn: RUNTIME_ARN });
      mockStartSession.mockResolvedValue(handle);
    });

    test.each([3, 9])('waits out %i failed reads in a row and finalizes the task as it ended', async (failedReads) => {
      for (let read = 0; read < failedReads; read++) mockDdbSend.mockRejectedValueOnce(throttled);
      mockDdbSend.mockResolvedValueOnce({ Item: { status: TaskStatus.COMPLETED } });

      await handler({ task_id: 'TASK001' }, pollingContext() as never);

      expect(mockDdbSend).toHaveBeenCalledTimes(failedReads + 1);
      expect(mockFinalizeTask).toHaveBeenCalledTimes(1);
      expect(mockFinalizeTask).toHaveBeenCalledWith(
        'TASK001',
        expect.objectContaining({ attempts: failedReads + 1, lastStatus: TaskStatus.COMPLETED }),
        'user-1',
      );
      expect(mockFailTask).not.toHaveBeenCalled();
    });

    test('waits out failed reads that follow a stale first read of the status', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: { status: TaskStatus.HYDRATING } });
      for (let read = 0; read < 9; read++) mockDdbSend.mockRejectedValueOnce(throttled);
      mockDdbSend.mockResolvedValueOnce({ Item: { status: TaskStatus.COMPLETED } });

      await handler({ task_id: 'TASK001' }, pollingContext(11) as never);

      expect(mockDdbSend).toHaveBeenCalledTimes(11);
      expect(mockFinalizeTask).toHaveBeenCalledTimes(1);
      expect(mockFinalizeTask).toHaveBeenCalledWith(
        'TASK001',
        expect.objectContaining({ attempts: 11, lastStatus: TaskStatus.COMPLETED }),
        'user-1',
      );
    });

    test('ends the orchestration on a read error that cannot clear, and leaves the task as it is', async () => {
      mockDdbSend
        .mockResolvedValueOnce({ Item: { status: TaskStatus.RUNNING } })
        .mockRejectedValue(Object.assign(new Error('not authorized to perform: dynamodb:GetItem'), {
          name: 'AccessDeniedException',
        }));

      await expect(handler({ task_id: 'TASK001' }, pollingContext() as never))
        .rejects.toThrow('not authorized to perform: dynamodb:GetItem');

      expect(mockDdbSend).toHaveBeenCalledTimes(2);
      expect(mockFinalizeTask).not.toHaveBeenCalled();
      expect(mockFailTask).not.toHaveBeenCalled();
      expect(taskStatus).toBe(TaskStatus.RUNNING);
    });
  });
});
