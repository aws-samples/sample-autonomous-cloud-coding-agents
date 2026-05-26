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

// Mock the durable execution SDK before importing orchestrate-task — its
// `withDurableExecution` wraps the handler at module import time. We only
// care about `notifyLinearOnConcurrencyCap` here, which is a plain async
// function exported alongside the durable handler.
jest.mock('@aws/durable-execution-sdk-js', () => ({
  withDurableExecution: (fn: unknown) => fn,
}));

const reportIssueFailureMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  reportIssueFailure: (...args: unknown[]) => reportIssueFailureMock(...args),
}));

// Stub the unused-but-imported orchestrator helpers so module-init side
// effects don't try to talk to AWS.
jest.mock('../../src/handlers/shared/orchestrator', () => ({
  admissionControl: jest.fn(),
  emitTaskEvent: jest.fn(),
  failTask: jest.fn(),
  finalizeTask: jest.fn(),
  hydrateAndTransition: jest.fn(),
  loadBlueprintConfig: jest.fn(),
  loadTask: jest.fn(),
  pollTaskStatus: jest.fn(),
  transitionTask: jest.fn(),
}));
jest.mock('../../src/handlers/shared/preflight', () => ({
  runPreflightChecks: jest.fn(),
}));
jest.mock('../../src/handlers/shared/compute-strategy', () => ({
  resolveComputeStrategy: jest.fn(),
}));

process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';

import { notifyLinearOnConcurrencyCap } from '../../src/handlers/orchestrate-task';
import type { TaskRecord } from '../../src/handlers/shared/types';

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: 'TASK001',
    user_id: 'user-123',
    status: 'SUBMITTED',
    repo: 'org/repo',
    task_type: 'new_task',
    branch_name: 'bgagent/TASK001/foo',
    channel_source: 'api',
    status_created_at: 'SUBMITTED#2024-01-01T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  } as TaskRecord;
}

describe('notifyLinearOnConcurrencyCap', () => {
  beforeEach(() => {
    reportIssueFailureMock.mockReset();
    reportIssueFailureMock.mockResolvedValue(undefined);
  });

  test('posts Linear comment + ❌ when channel_source is linear and issue id + workspace are set', async () => {
    await notifyLinearOnConcurrencyCap(task({
      channel_source: 'linear',
      channel_metadata: {
        linear_issue_id: 'lin-issue-1',
        linear_workspace_id: 'lin-org-1',
      },
    }));

    expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
    const [ctx, issueId, message] = reportIssueFailureMock.mock.calls[0];
    expect(ctx).toEqual({
      linearWorkspaceId: 'lin-org-1',
      registryTableName: process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME,
    });
    expect(issueId).toBe('lin-issue-1');
    expect(message).toContain('concurrency limit');
  });

  test('no-ops on non-Linear channels (api / webhook / slack)', async () => {
    for (const source of ['api', 'webhook', 'slack'] as const) {
      reportIssueFailureMock.mockClear();
      await notifyLinearOnConcurrencyCap(task({
        channel_source: source,
        channel_metadata: { linear_issue_id: 'lin-issue-1' }, // even if metadata is set
      }));
      expect(reportIssueFailureMock).not.toHaveBeenCalled();
    }
  });

  test('no-ops when channel_metadata is missing the issue id (defensive)', async () => {
    await notifyLinearOnConcurrencyCap(task({
      channel_source: 'linear',
      channel_metadata: {}, // no linear_issue_id
    }));

    expect(reportIssueFailureMock).not.toHaveBeenCalled();
  });

  test('no-ops when channel_metadata is undefined', async () => {
    await notifyLinearOnConcurrencyCap(task({ channel_source: 'linear' }));
    expect(reportIssueFailureMock).not.toHaveBeenCalled();
  });

  test('no-ops when LINEAR_WORKSPACE_REGISTRY_TABLE_NAME env is not set (logs warn)', async () => {
    const saved = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
    delete process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
    try {
      await notifyLinearOnConcurrencyCap(task({
        channel_source: 'linear',
        channel_metadata: {
          linear_issue_id: 'lin-issue-1',
          linear_workspace_id: 'lin-org-1',
        },
      }));
      expect(reportIssueFailureMock).not.toHaveBeenCalled();
    } finally {
      process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = saved;
    }
  });

  test('reportIssueFailure rejection is swallowed (best-effort, never blocks rejection path)', async () => {
    // Round-3 review B2 moved the try/catch inside this function so a
    // synchronous throw from `reportIssueFailure` (e.g., transient DDB
    // throttle on the registry lookup) cannot crash the durable-execution
    // step and trigger a retry that double-emits failTask events. Contract
    // is now: this helper never rejects.
    reportIssueFailureMock.mockRejectedValue(new Error('boom'));
    await expect(
      notifyLinearOnConcurrencyCap(task({
        channel_source: 'linear',
        channel_metadata: {
          linear_issue_id: 'lin-issue-1',
          linear_workspace_id: 'lin-org-1',
        },
      })),
    ).resolves.toBeUndefined();
    expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
  });
});
