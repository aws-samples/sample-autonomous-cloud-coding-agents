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
// care about `notifyLinearOnConcurrencyCap` and `notifyJiraOnConcurrencyCap`
// here, which are plain async functions exported alongside the durable handler.
jest.mock('@aws/durable-execution-sdk-js', () => ({
  withDurableExecution: (fn: unknown) => fn,
}));

const postIssueCommentMock = jest.fn();
const reportIssueFailureMock = jest.fn();
const resolveTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  postIssueComment: (...args: unknown[]) => postIssueCommentMock(...args),
  reportIssueFailure: (...args: unknown[]) => reportIssueFailureMock(...args),
  resolveToken: (...args: unknown[]) => resolveTokenMock(...args),
}));

const emitAgentActivityMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-agent-session', () => ({
  emitAgentActivity: (...args: unknown[]) => emitAgentActivityMock(...args),
}));

const reportJiraIssueFailureMock = jest.fn();
jest.mock('../../src/handlers/shared/jira-feedback', () => ({
  reportIssueFailure: (...args: unknown[]) => reportJiraIssueFailureMock(...args),
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
process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraWorkspaceRegistry';

import {
  notifyJiraOnConcurrencyCap,
  notifyLinearOnConcurrencyCap,
} from '../../src/handlers/orchestrate-task';
import type { TaskRecord } from '../../src/handlers/shared/types';

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: 'TASK001',
    user_id: 'user-123',
    status: 'SUBMITTED',
    repo: 'org/repo',
    resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
    branch_name: 'bgagent/TASK001/foo',
    channel_source: 'api',
    status_created_at: 'SUBMITTED#2024-01-01T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  } as TaskRecord;
}

describe('notifyLinearOnConcurrencyCap — agent-session tasks', () => {
  const sessionTask = () => task({
    channel_source: 'linear',
    channel_metadata: { linear_issue_id: 'issue-1', linear_workspace_id: 'org-1', linear_agent_session_id: 'session-1' },
  });

  beforeEach(() => {
    postIssueCommentMock.mockReset();
    resolveTokenMock.mockReset().mockResolvedValue('lin_tok');
    emitAgentActivityMock.mockReset().mockResolvedValue({ ok: true });
  });

  test('says "queued" in the session, not in an issue comment', async () => {
    await notifyLinearOnConcurrencyCap(sessionTask());
    expect(postIssueCommentMock).not.toHaveBeenCalled();
    expect(emitAgentActivityMock).toHaveBeenCalledWith('lin_tok', 'session-1', expect.objectContaining({ type: 'thought' }));
    expect(emitAgentActivityMock.mock.calls[0][2].body).toMatch(/^Queued/);
  });

  test('never blocks admission: no token, a failed emit and a throw are all swallowed', async () => {
    resolveTokenMock.mockResolvedValueOnce(null);
    await expect(notifyLinearOnConcurrencyCap(sessionTask())).resolves.toBeUndefined();
    emitAgentActivityMock.mockResolvedValueOnce({ ok: false, retryable: true });
    await expect(notifyLinearOnConcurrencyCap(sessionTask())).resolves.toBeUndefined();
    resolveTokenMock.mockRejectedValueOnce(new Error('ddb throttled'));
    await expect(notifyLinearOnConcurrencyCap(sessionTask())).resolves.toBeUndefined();
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });
});

describe('notifyLinearOnConcurrencyCap', () => {
  beforeEach(() => {
    postIssueCommentMock.mockReset();
    postIssueCommentMock.mockResolvedValue({ ok: true });
    reportIssueFailureMock.mockReset();
  });

  test('posts a plain Linear comment when channel_source is linear and issue id + workspace are set', async () => {
    await notifyLinearOnConcurrencyCap(task({
      channel_source: 'linear',
      channel_metadata: {
        linear_issue_id: 'lin-issue-1',
        linear_workspace_id: 'lin-org-1',
      },
    }));

    // The task is queued, not failed: a comment without the ❌ reaction that
    // `reportIssueFailure` adds to it.
    expect(reportIssueFailureMock).not.toHaveBeenCalled();
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
    const [ctx, issueId, message] = postIssueCommentMock.mock.calls[0];
    expect(ctx).toEqual({
      linearWorkspaceId: 'lin-org-1',
      registryTableName: process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME,
    });
    expect(issueId).toBe('lin-issue-1');
    expect(message).toContain('concurrency limit');
  });

  test('no-ops on non-Linear channels (api / webhook / slack)', async () => {
    for (const source of ['api', 'webhook', 'slack'] as const) {
      postIssueCommentMock.mockClear();
      await notifyLinearOnConcurrencyCap(task({
        channel_source: source,
        channel_metadata: { linear_issue_id: 'lin-issue-1' }, // even if metadata is set
      }));
      expect(postIssueCommentMock).not.toHaveBeenCalled();
    }
  });

  test('no-ops when channel_metadata is missing the issue id (defensive)', async () => {
    await notifyLinearOnConcurrencyCap(task({
      channel_source: 'linear',
      channel_metadata: {}, // no linear_issue_id
    }));

    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  test('no-ops when channel_metadata is undefined', async () => {
    await notifyLinearOnConcurrencyCap(task({ channel_source: 'linear' }));
    expect(postIssueCommentMock).not.toHaveBeenCalled();
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
      expect(postIssueCommentMock).not.toHaveBeenCalled();
    } finally {
      process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = saved;
    }
  });

  test('postIssueComment rejection is swallowed (best-effort, never blocks the admission step)', async () => {
    // Round-3 review B2 moved the try/catch inside this function so a
    // synchronous throw from the Linear helper (e.g., transient DDB
    // throttle on the registry lookup) cannot crash the durable-execution
    // step and trigger a retry that re-runs queueTask. Contract
    // is now: this helper never rejects.
    postIssueCommentMock.mockRejectedValue(new Error('boom'));
    await expect(
      notifyLinearOnConcurrencyCap(task({
        channel_source: 'linear',
        channel_metadata: {
          linear_issue_id: 'lin-issue-1',
          linear_workspace_id: 'lin-org-1',
        },
      })),
    ).resolves.toBeUndefined();
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
  });
});

describe('notifyJiraOnConcurrencyCap', () => {
  beforeEach(() => {
    reportJiraIssueFailureMock.mockReset();
    reportJiraIssueFailureMock.mockResolvedValue(undefined);
  });

  test('posts a Jira comment when channel_source is jira and cloudId + issue key are set', async () => {
    await notifyJiraOnConcurrencyCap(task({
      channel_source: 'jira',
      channel_metadata: {
        jira_cloud_id: 'cloud-1',
        jira_issue_key: 'ENG-42',
      },
    }));

    expect(reportJiraIssueFailureMock).toHaveBeenCalledTimes(1);
    const [ctx, issueKey, message] = reportJiraIssueFailureMock.mock.calls[0];
    expect(ctx).toEqual({
      cloudId: 'cloud-1',
      registryTableName: process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME,
    });
    expect(issueKey).toBe('ENG-42');
    expect(message).toContain('concurrency limit');
  });

  test('no-ops on non-Jira channels', async () => {
    for (const source of ['api', 'webhook', 'slack', 'linear'] as const) {
      reportJiraIssueFailureMock.mockClear();
      await notifyJiraOnConcurrencyCap(task({
        channel_source: source,
        channel_metadata: { jira_cloud_id: 'cloud-1', jira_issue_key: 'ENG-42' },
      }));
      expect(reportJiraIssueFailureMock).not.toHaveBeenCalled();
    }
  });

  test('no-ops when channel_metadata is missing cloudId or issue key (defensive)', async () => {
    await notifyJiraOnConcurrencyCap(task({
      channel_source: 'jira',
      channel_metadata: { jira_cloud_id: 'cloud-1' }, // no issue key
    }));
    expect(reportJiraIssueFailureMock).not.toHaveBeenCalled();
  });

  test('no-ops when JIRA_WORKSPACE_REGISTRY_TABLE_NAME env is not set', async () => {
    const saved = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
    delete process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
    try {
      await notifyJiraOnConcurrencyCap(task({
        channel_source: 'jira',
        channel_metadata: { jira_cloud_id: 'cloud-1', jira_issue_key: 'ENG-42' },
      }));
      expect(reportJiraIssueFailureMock).not.toHaveBeenCalled();
    } finally {
      process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = saved;
    }
  });

  test('reportIssueFailure rejection is swallowed (never blocks the admission step)', async () => {
    reportJiraIssueFailureMock.mockRejectedValue(new Error('boom'));
    await expect(
      notifyJiraOnConcurrencyCap(task({
        channel_source: 'jira',
        channel_metadata: { jira_cloud_id: 'cloud-1', jira_issue_key: 'ENG-42' },
      })),
    ).resolves.toBeUndefined();
    expect(reportJiraIssueFailureMock).toHaveBeenCalledTimes(1);
  });
});
