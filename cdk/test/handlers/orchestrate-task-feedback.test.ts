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

process.env.LINEAR_API_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/linear/api-token-XYZ';

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

  test('posts Linear comment + ❌ when channel_source is linear and issue id is set', async () => {
    await notifyLinearOnConcurrencyCap(task({
      channel_source: 'linear',
      channel_metadata: { linear_issue_id: 'lin-issue-1' },
    }));

    expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
    const [secretArn, issueId, message] = reportIssueFailureMock.mock.calls[0];
    expect(secretArn).toBe(process.env.LINEAR_API_TOKEN_SECRET_ARN);
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

  test('no-ops when LINEAR_API_TOKEN_SECRET_ARN env is not set (logs warn)', async () => {
    const saved = process.env.LINEAR_API_TOKEN_SECRET_ARN;
    delete process.env.LINEAR_API_TOKEN_SECRET_ARN;
    try {
      await notifyLinearOnConcurrencyCap(task({
        channel_source: 'linear',
        channel_metadata: { linear_issue_id: 'lin-issue-1' },
      }));
      expect(reportIssueFailureMock).not.toHaveBeenCalled();
    } finally {
      process.env.LINEAR_API_TOKEN_SECRET_ARN = saved;
    }
  });

  test('reportIssueFailure rejection propagates (caller must catch)', async () => {
    // The helper itself swallows network errors internally, but we contract
    // for callers to wrap the call defensively because durable-execution
    // retries the entire step on throw, producing duplicate failTask +
    // emitTaskEvent. This test asserts the rejection actually propagates so
    // the orchestrate-task try-catch is load-bearing, not redundant.
    reportIssueFailureMock.mockRejectedValue(new Error('boom'));
    await expect(
      notifyLinearOnConcurrencyCap(task({
        channel_source: 'linear',
        channel_metadata: { linear_issue_id: 'lin-issue-1' },
      })),
    ).rejects.toThrow('boom');
  });
});
