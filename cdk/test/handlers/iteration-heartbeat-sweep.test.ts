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

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: ddbSend })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: ddbSend })),
  },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'GetItem', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const upsertThreadedReplyMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  upsertThreadedReply: (...args: unknown[]) => upsertThreadedReplyMock(...args),
}));

const updateIssueCommentMock = jest.fn();
jest.mock('../../src/handlers/shared/jira-feedback', () => ({
  ...jest.requireActual('../../src/handlers/shared/jira-feedback'),
}));

jest.mock('../../src/handlers/shared/jira-iteration-comment', () => ({
  updateJiraIterationComment: (...args: unknown[]) => updateIssueCommentMock(...args),
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../src/handlers/shared/logger', () => ({ logger: mockLogger }));

const REGISTRY = 'LinearWorkspaceRegistry';
process.env.TASK_TABLE_NAME = 'TaskTable';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = REGISTRY;
process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraWorkspaceRegistry';

const NOW = Date.parse('2026-06-29T13:30:00Z');

import { handler } from '../../src/handlers/iteration-heartbeat-sweep';

function runningTask(overrides: { taskId?: string; createdAt?: string } = {}) {
  return {
    task_id: { S: overrides.taskId ?? 'task-1' },
    status: { S: 'RUNNING' },
    created_at: { S: overrides.createdAt ?? '2026-06-29T13:20:00Z' },
    channel_source: { S: 'linear' },
    pr_number: { N: '42' },
    channel_metadata: {
      M: {
        linear_workspace_id: { S: 'ws-1' },
        iteration_reply_comment_id: { S: 'reply-1' },
        trigger_comment_id: { S: 'cmt-1' },
        trigger_comment_issue_id: { S: 'issue-1' },
        orchestration_iteration: { S: 'true' },
      },
    },
  };
}

function runningJiraTask() {
  return {
    task_id: { S: 'task-jira' },
    status: { S: 'RUNNING' },
    created_at: { S: '2026-06-29T13:20:00Z' },
    channel_source: { S: 'jira' },
    pr_number: { N: '42' },
    channel_metadata: {
      M: {
        jira_cloud_id: { S: 'cloud-1' },
        jira_issue_key: { S: 'ENG-42' },
        iteration_reply_comment_id: { S: 'jira-reply-1' },
        trigger_comment_id: { S: 'jira-trigger-1' },
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  upsertThreadedReplyMock.mockResolvedValue('reply-1');
  updateIssueCommentMock.mockResolvedValue({ ok: true });
  ddbSend.mockImplementation((command: { _type?: string }) => (
    command._type === 'Query'
      ? Promise.resolve({ Items: [runningTask()] })
      : Promise.resolve({})
  ));
});

afterEach(() => jest.restoreAllMocks());

describe('iteration heartbeat sweep', () => {
  test('edits the maturing reply through the channel, preserving a landed preview link', async () => {
    await handler();

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const [ctx, issueId, parentCommentId, body, existingReplyId, options] = upsertThreadedReplyMock.mock.calls[0];
    expect(ctx).toEqual({ linearWorkspaceId: 'ws-1', registryTableName: REGISTRY });
    expect(issueId).toBe('issue-1');
    expect(parentCommentId).toBe('cmt-1');
    expect(existingReplyId).toBe('reply-1');
    expect(body).toContain('🔄 Working');
    expect(options).toEqual({ preservePreview: true, skipIfSettled: true, repairIfOverwritten: false });
  });

  test('a task with no reply to mature is skipped, not edited', async () => {
    const noReply = runningTask();
    delete (noReply.channel_metadata.M as Record<string, unknown>).iteration_reply_comment_id;
    ddbSend.mockResolvedValue({ Items: [noReply] });

    await handler();
    expect(upsertThreadedReplyMock).not.toHaveBeenCalled();
  });

  test('edits a Jira iteration status comment through the Jira adapter', async () => {
    ddbSend.mockImplementation((command: { _type?: string }) => (
      command._type === 'Query'
        ? Promise.resolve({ Items: [runningJiraTask()] })
        : Promise.resolve({})
    ));

    await handler();

    expect(updateIssueCommentMock).toHaveBeenCalledWith(
      expect.anything(), 'TaskTable', 'task-jira',
      { cloudId: 'cloud-1', registryTableName: 'JiraWorkspaceRegistry' },
      'ENG-42',
      'jira-reply-1',
      { body: expect.objectContaining({ type: 'doc' }), terminal: false },
    );
    expect(upsertThreadedReplyMock).not.toHaveBeenCalled();
  });

  test('a terminal claim prevents a late Jira heartbeat from regressing the comment', async () => {
    ddbSend.mockImplementation((command: { _type?: string }) => {
      if (command._type === 'Query') return Promise.resolve({ Items: [runningJiraTask()] });
      return Promise.resolve({ Item: { ack_replied_at: { S: '2026-06-29T13:29:59Z' } } });
    });

    await handler();

    expect(updateIssueCommentMock).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith('Heartbeat sweep complete', { attempted: 0, edited: 0 });
  });

  test('one task\'s edit failure does not stop the rest of the sweep', async () => {
    ddbSend.mockImplementation((command: { _type?: string }) => (
      command._type === 'Query'
        ? Promise.resolve({
          Items: [runningTask({ taskId: 'task-1' }), runningTask({ taskId: 'task-2' })],
        })
        : Promise.resolve({})
    ));
    upsertThreadedReplyMock.mockRejectedValueOnce(new Error('surface hiccup'));

    await expect(handler()).resolves.toBeUndefined();
    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(2);
    expect(mockLogger.info).toHaveBeenCalledWith('Heartbeat sweep complete', { attempted: 2, edited: 1 });
  });

  test('one Jira task edit failure does not stop the rest of the sweep', async () => {
    const second = runningJiraTask();
    second.task_id.S = 'task-jira-2';
    ddbSend.mockImplementation((command: { _type?: string }) => (
      command._type === 'Query'
        ? Promise.resolve({ Items: [runningJiraTask(), second] })
        : Promise.resolve({})
    ));
    updateIssueCommentMock.mockRejectedValueOnce(new Error('surface hiccup'));

    await expect(handler()).resolves.toBeUndefined();
    expect(updateIssueCommentMock).toHaveBeenCalledTimes(2);
  });

  test.each([false, true])('a Jira edit that comes back failed is logged for its task and counted as attempted, not as edited (retryable: %s)', async (retryable) => {
    const second = runningJiraTask();
    second.task_id.S = 'task-jira-2';
    ddbSend.mockImplementation((command: { _type?: string }) => (
      command._type === 'Query'
        ? Promise.resolve({ Items: [runningJiraTask(), second] })
        : Promise.resolve({})
    ));
    updateIssueCommentMock.mockResolvedValueOnce({ ok: false, retryable });

    await handler();

    expect(updateIssueCommentMock).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith('Heartbeat sweep: reply edit failed (non-fatal)', {
      task_id: 'task-jira', retryable,
    });
    expect(mockLogger.info).toHaveBeenCalledWith('Heartbeat sweep complete', { attempted: 2, edited: 1 });
  });

  test('a task whose channel has no credentials registry is skipped, not attempted', async () => {
    jest.resetModules();
    delete process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
    const { handler: withoutJira } = await import('../../src/handlers/iteration-heartbeat-sweep');
    process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraWorkspaceRegistry';
    ddbSend.mockImplementation((command: { _type?: string }) => (
      command._type === 'Query'
        ? Promise.resolve({ Items: [runningJiraTask()] })
        : Promise.resolve({})
    ));

    await withoutJira();

    expect(updateIssueCommentMock).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith('Heartbeat sweep complete', { attempted: 0, edited: 0 });
  });

  test('a query failure is swallowed — a cosmetic sweep never throws', async () => {
    ddbSend.mockImplementation((command: { _type?: string }) => (
      command._type === 'Query'
        ? Promise.reject(new Error('throttled'))
        : Promise.resolve({})
    ));
    await expect(handler()).resolves.toBeUndefined();
    expect(upsertThreadedReplyMock).not.toHaveBeenCalled();
  });
});
