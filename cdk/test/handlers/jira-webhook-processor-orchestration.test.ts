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
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

const reportIssueFailureMock = jest.fn();
jest.mock('../../src/handlers/shared/jira-feedback', () => ({
  reportIssueFailure: (...args: unknown[]) => reportIssueFailureMock(...args),
}));

const resolveJiraOauthTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/jira-oauth-resolver', () => ({
  resolveJiraOauthToken: (...args: unknown[]) => resolveJiraOauthTokenMock(...args),
}));

const jiraGraphSourceMock = jest.fn();
jest.mock('../../src/handlers/shared/orchestration-graph-source', () => ({
  jiraGraphSource: (...args: unknown[]) => jiraGraphSourceMock(...args),
}));

const discoverOrchestrationMock = jest.fn();
jest.mock('../../src/handlers/shared/orchestration-discovery', () => ({
  discoverOrchestration: (...args: unknown[]) => discoverOrchestrationMock(...args),
}));

const loadOrchestrationMock = jest.fn();
const setStatusCommentIdMock = jest.fn();
const claimCommentAckMock = jest.fn();
const clearRollupClaimMock = jest.fn();
jest.mock('../../src/handlers/shared/orchestration-store', () => ({
  deriveOrchestrationId: (parent: string) => `orch-${parent}`,
  loadOrchestration: (...args: unknown[]) => loadOrchestrationMock(...args),
  setStatusCommentId: (...args: unknown[]) => setStatusCommentIdMock(...args),
  claimCommentAck: (...args: unknown[]) => claimCommentAckMock(...args),
  clearRollupClaim: (...args: unknown[]) => clearRollupClaimMock(...args),
}));

const releaseReadyChildrenMock = jest.fn();
const applyTerminalCreateFailuresMock = jest.fn();
const readConcurrencyBudgetMock = jest.fn();
jest.mock('../../src/handlers/shared/orchestration-release', () => ({
  releaseReadyChildren: (...args: unknown[]) => releaseReadyChildrenMock(...args),
  applyTerminalCreateFailures: (...args: unknown[]) => applyTerminalCreateFailuresMock(...args),
  readConcurrencyBudget: (...args: unknown[]) => readConcurrencyBudgetMock(...args),
}));

const upsertEpicPanelMock = jest.fn();
jest.mock('../../src/handlers/shared/orchestration-rollup', () => ({
  upsertEpicPanel: (...args: unknown[]) => upsertEpicPanelMock(...args),
}));

jest.mock('../../src/handlers/shared/orchestration-channel-jira', () => ({
  makeJiraChannel: jest.fn(() => ({ kind: 'jira' })),
}));

const fetchRecentHumanCommentsMock = jest.fn();
const downloadScreenAndStoreJiraAttachmentsMock = jest.fn();
jest.mock('../../src/handlers/shared/jira-attachments', () => {
  const actual = jest.requireActual('../../src/handlers/shared/jira-attachments');
  return {
    ...actual,
    fetchRecentHumanComments: (...args: unknown[]) => fetchRecentHumanCommentsMock(...args),
    downloadScreenAndStoreJiraAttachments: (...args: unknown[]) =>
      downloadScreenAndStoreJiraAttachmentsMock(...args),
  };
});

process.env.JIRA_PROJECT_MAPPING_TABLE_NAME = 'JiraProjects';
process.env.JIRA_USER_MAPPING_TABLE_NAME = 'JiraUsers';
process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraWorkspaceRegistry';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.ORCHESTRATION_TABLE_NAME = 'Orchestrations';
process.env.USER_CONCURRENCY_TABLE_NAME = 'Concurrency';
process.env.MAX_CONCURRENT_TASKS_PER_USER = '10';

import { handler } from '../../src/handlers/jira-webhook-processor';

const oauth = {
  accessToken: 'jira-token',
  scope: 'read:jira-work',
  siteUrl: 'https://acme.atlassian.net',
  oauthSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-jira-oauth-cloud-1',
};

const snapshot = {
  meta: {
    orchestration_id: 'orch-ENG-1',
    parent_issue_ref: 'ENG-1',
    credentials_ref: 'cloud-1',
    repo: 'org/repo',
    child_count: 1,
    release_context: {
      platform_user_id: 'platform-user',
      channel_source: 'jira',
      jira_status_on_start: 'Doing',
      jira_status_on_pr: 'Review',
    },
  },
  children: [{
    orchestration_id: 'orch-ENG-1',
    sub_issue_id: 'ENG-2',
    parent_issue_ref: 'ENG-1',
    credentials_ref: 'cloud-1',
    repo: 'org/repo',
    depends_on: [],
    child_status: 'ready',
    created_at: '2026-08-05T00:00:00.000Z',
    updated_at: '2026-08-05T00:00:00.000Z',
  }],
};

function event(): { raw_body: string } {
  return {
    raw_body: JSON.stringify({
      webhookEvent: 'jira:issue_created',
      cloudId: 'cloud-1',
      user: { accountId: 'account-1' },
      issue: {
        id: '10001',
        key: 'ENG-1',
        fields: {
          summary: 'Parent work',
          description: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Shared contract' }] }],
          },
          labels: ['bgagent'],
          project: { id: 'p1', key: 'ENG' },
        },
      },
    }),
  };
}

function retryEvent(): { raw_body: string } {
  return {
    raw_body: JSON.stringify({
      webhookEvent: 'comment_created',
      cloudId: 'cloud-1',
      issue: {
        id: '10001',
        key: 'ENG-1',
        fields: { project: { id: 'p1', key: 'ENG' } },
      },
      comment: {
        id: 'retry-comment-1',
        author: { accountId: 'account-1', accountType: 'atlassian' },
        body: {
          type: 'doc',
          version: 1,
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: '@bgagent retry' }],
          }],
        },
      },
    }),
  };
}

function child(key = 'ENG-2', projectKey = 'ENG') {
  return {
    id: key,
    issue_id: key === 'ENG-2' ? '10002' : '10003',
    identifier: key,
    project_key: projectKey,
    title: `Build ${key}`,
    description: `Scope ${key}`,
    depends_on: [],
  };
}

describe('jira-webhook-processor orchestration adapter', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          status: 'active',
          repo: 'org/repo',
          label_filter: 'bgagent',
          status_on_start: 'Doing',
          status_on_pr: 'Review',
        },
      })
      .mockResolvedValueOnce({
        Item: { status: 'active', platform_user_id: 'platform-user' },
      })
      .mockResolvedValue({ Item: { active_count: 3 } });
    createTaskCoreMock.mockReset();
    createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: '{}' });
    reportIssueFailureMock.mockReset();
    reportIssueFailureMock.mockResolvedValue(undefined);
    resolveJiraOauthTokenMock.mockReset();
    resolveJiraOauthTokenMock.mockResolvedValue(oauth);
    jiraGraphSourceMock.mockReset();
    jiraGraphSourceMock.mockReturnValue(jest.fn().mockResolvedValue({
      kind: 'ok',
      children: [child()],
    }));
    discoverOrchestrationMock.mockReset();
    discoverOrchestrationMock.mockResolvedValue({
      kind: 'seeded',
      orchestrationId: 'orch-ENG-1',
      childCount: 1,
      rootSubIssueIds: ['ENG-2'],
      alreadyExisted: false,
    });
    loadOrchestrationMock.mockReset();
    loadOrchestrationMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(snapshot);
    releaseReadyChildrenMock.mockReset();
    releaseReadyChildrenMock.mockResolvedValue([]);
    applyTerminalCreateFailuresMock.mockReset();
    applyTerminalCreateFailuresMock.mockResolvedValue(snapshot.children);
    readConcurrencyBudgetMock.mockReset().mockResolvedValue(7);
    upsertEpicPanelMock.mockReset();
    upsertEpicPanelMock.mockResolvedValue(null);
    setStatusCommentIdMock.mockReset();
    claimCommentAckMock.mockReset().mockResolvedValue(true);
    clearRollupClaimMock.mockReset().mockResolvedValue(undefined);
    fetchRecentHumanCommentsMock.mockReset().mockResolvedValue([]);
    downloadScreenAndStoreJiraAttachmentsMock.mockReset().mockResolvedValue([]);
  });

  test('seeds the shared graph, releases roots, and suppresses the parent coding task', async () => {
    await handler(event());

    expect(jiraGraphSourceMock).toHaveBeenCalledWith('jira-token', 'cloud-1', 'ENG-1');
    const params = discoverOrchestrationMock.mock.calls[0][0];
    expect(params).toMatchObject({
      tableName: 'Orchestrations',
      parentIssueRef: 'ENG-1',
      credentialsRef: 'cloud-1',
      repo: 'org/repo',
      releaseContext: {
        platform_user_id: 'platform-user',
        channel_source: 'jira',
        trigger_label: 'bgagent',
        parent_context: {
          title: 'Parent work',
          description: 'Shared contract',
        },
      },
    });
    await expect(params.graphSource()).resolves.toEqual({
      kind: 'ok',
      children: [expect.objectContaining({
        id: 'ENG-2',
        channel_metadata: {
          jira_cloud_id: 'cloud-1',
          jira_project_key: 'ENG',
          jira_issue_id: '10002',
          jira_issue_key: 'ENG-2',
          jira_oauth_secret_arn: oauth.oauthSecretArn,
          jira_site_url: oauth.siteUrl,
          jira_status_on_start: 'Doing',
          jira_status_on_pr: 'Review',
        },
      })],
    });
    expect(releaseReadyChildrenMock).toHaveBeenCalledTimes(1);
    expect(releaseReadyChildrenMock).toHaveBeenCalledWith(
      expect.anything(),
      'Orchestrations',
      snapshot.children,
      snapshot.meta.release_context,
      expect.any(Function),
      expect.any(String),
      snapshot.children,
      'main',
      7,
    );
    expect(upsertEpicPanelMock).toHaveBeenCalledWith(expect.objectContaining({
      parent: expect.objectContaining({ issueId: 'ENG-1', credentialsRef: 'cloud-1' }),
    }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('parent retry preserves successes and releases only failed/skipped work', async () => {
    const failedSnapshot = {
      ...snapshot,
      meta: {
        ...snapshot.meta,
        status_comment_id: 'panel-1',
      },
      children: [
        { ...snapshot.children[0], sub_issue_id: 'ENG-2', child_status: 'succeeded' },
        {
          ...snapshot.children[0],
          sub_issue_id: 'ENG-3',
          child_status: 'failed',
          child_task_id: 'failed-task',
        },
        {
          ...snapshot.children[0],
          sub_issue_id: 'ENG-4',
          depends_on: ['ENG-3'],
          child_status: 'skipped',
        },
      ],
    };
    const resetSnapshot = {
      ...failedSnapshot,
      children: [
        failedSnapshot.children[0],
        { ...failedSnapshot.children[1], child_status: 'ready' },
        { ...failedSnapshot.children[2], child_status: 'blocked' },
      ],
    };
    ddbSend.mockReset().mockImplementation(async (command: {
      _type?: string;
      input?: { TableName?: string };
    }) => {
      if (command._type === 'Get' && command.input?.TableName === 'JiraProjects') {
        return { Item: { status: 'active', repo: 'org/repo', label_filter: 'bgagent' } };
      }
      if (command._type === 'Get' && command.input?.TableName === 'JiraUsers') {
        return { Item: { status: 'active', platform_user_id: 'platform-user' } };
      }
      if (command._type === 'Get' && command.input?.TableName === 'Concurrency') {
        return { Item: { active_count: 3 } };
      }
      return {};
    });
    loadOrchestrationMock.mockReset()
      .mockResolvedValueOnce(failedSnapshot)
      .mockResolvedValueOnce(resetSnapshot)
      .mockResolvedValueOnce(resetSnapshot);
    releaseReadyChildrenMock.mockResolvedValueOnce([]);

    await handler(retryEvent());

    expect(releaseReadyChildrenMock).toHaveBeenCalledWith(
      expect.anything(),
      'Orchestrations',
      [expect.objectContaining({ sub_issue_id: 'ENG-3', child_status: 'ready' })],
      failedSnapshot.meta.release_context,
      expect.any(Function),
      expect.any(String),
      resetSnapshot.children,
      'main',
      7,
      true,
    );
    expect(clearRollupClaimMock).toHaveBeenCalledWith(
      expect.anything(),
      'Orchestrations',
      'orch-ENG-1',
      expect.any(String),
    );
    expect(reportIssueFailureMock).toHaveBeenCalledWith(
      expect.anything(),
      'ENG-1',
      expect.stringContaining('1 successful sub-issue(s) are unchanged'),
    );
  });

  test('refuses parent retry from an unlinked Jira commenter before reading the graph', async () => {
    ddbSend.mockReset()
      .mockResolvedValueOnce({
        Item: { status: 'active', repo: 'org/repo', label_filter: 'bgagent' },
      })
      .mockResolvedValueOnce({});

    await handler(retryEvent());

    expect(loadOrchestrationMock).not.toHaveBeenCalled();
    expect(claimCommentAckMock).not.toHaveBeenCalled();
    expect(releaseReadyChildrenMock).not.toHaveBeenCalled();
    expect(reportIssueFailureMock).toHaveBeenCalledWith(
      expect.anything(),
      'ENG-1',
      expect.stringContaining('linked ABCA user'),
    );
  });

  test('continues parent retry when a conditional child reset loses a race', async () => {
    const failedSnapshot = {
      ...snapshot,
      children: [
        {
          ...snapshot.children[0],
          sub_issue_id: 'ENG-3',
          child_status: 'failed',
          child_task_id: 'failed-task',
        },
      ],
    };
    const resetSnapshot = {
      ...failedSnapshot,
      children: [{ ...failedSnapshot.children[0], child_status: 'ready' }],
    };
    ddbSend.mockReset().mockImplementation(async (command: {
      _type?: string;
      input?: {
        TableName?: string;
        Key?: { sub_issue_id?: string };
      };
    }) => {
      if (command._type === 'Get' && command.input?.TableName === 'JiraProjects') {
        return { Item: { status: 'active', repo: 'org/repo', label_filter: 'bgagent' } };
      }
      if (command._type === 'Get' && command.input?.TableName === 'JiraUsers') {
        return { Item: { status: 'active', platform_user_id: 'platform-user' } };
      }
      if (command._type === 'Get' && command.input?.TableName === 'Concurrency') {
        return { Item: { active_count: 0 } };
      }
      if (command._type === 'Update' && command.input?.Key?.sub_issue_id === 'ENG-3') {
        throw Object.assign(new Error('racing transition'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      return {};
    });
    loadOrchestrationMock.mockReset()
      .mockResolvedValueOnce(failedSnapshot)
      .mockResolvedValueOnce(resetSnapshot)
      .mockResolvedValueOnce(resetSnapshot);
    readConcurrencyBudgetMock.mockResolvedValueOnce(10);

    await expect(handler(retryEvent())).resolves.toBeUndefined();

    expect(clearRollupClaimMock).toHaveBeenCalled();
    expect(releaseReadyChildrenMock).toHaveBeenCalledWith(
      expect.anything(),
      'Orchestrations',
      [expect.objectContaining({ sub_issue_id: 'ENG-3', child_status: 'ready' })],
      failedSnapshot.meta.release_context,
      expect.any(Function),
      expect.any(String),
      resetSnapshot.children,
      'main',
      10,
      true,
    );
  });

  test('falls through to the existing single-task path when Jira has no children', async () => {
    jiraGraphSourceMock.mockReturnValueOnce(jest.fn().mockResolvedValue({ kind: 'no_children' }));

    await handler(event());

    expect(discoverOrchestrationMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock.mock.calls[0][0]).toMatchObject({
      repo: 'org/repo',
      workflow_ref: 'coding/new-task-v1',
    });
  });

  test('surfaces Jira graph errors without degrading to a parent task', async () => {
    jiraGraphSourceMock.mockReturnValueOnce(jest.fn().mockResolvedValue({
      kind: 'error',
      message: 'Jira returned status 401 while reading authored subtasks.',
    }));

    await handler(event());

    expect(discoverOrchestrationMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reportIssueFailureMock).toHaveBeenCalledWith(
      expect.anything(),
      'ENG-1',
      expect.stringContaining('status 401'),
    );
  });

  test('rejects an unmapped cross-project child before seeding', async () => {
    jiraGraphSourceMock.mockReturnValueOnce(jest.fn().mockResolvedValue({
      kind: 'ok',
      children: [child('OPS-2', 'OPS')],
    }));
    ddbSend.mockResolvedValueOnce({});

    await handler(event());

    expect(discoverOrchestrationMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reportIssueFailureMock).toHaveBeenCalledWith(
      expect.anything(),
      'ENG-1',
      expect.stringContaining('not actively mapped'),
    );
  });

  test('rejects cross-repository child mappings before seeding', async () => {
    jiraGraphSourceMock.mockReturnValueOnce(jest.fn().mockResolvedValue({
      kind: 'ok',
      children: [child('OPS-2', 'OPS')],
    }));
    ddbSend.mockResolvedValueOnce({
      Item: { status: 'active', repo: 'other/repo' },
    });

    await handler(event());

    expect(discoverOrchestrationMock).not.toHaveBeenCalled();
    expect(reportIssueFailureMock).toHaveBeenCalledWith(
      expect.anything(),
      'ENG-1',
      expect.stringContaining('All executable Jira subtasks must map to the same repository'),
    );
  });

  test('treats an existing orchestration with no new node IDs as a no-op', async () => {
    loadOrchestrationMock.mockReset();
    loadOrchestrationMock.mockResolvedValueOnce(snapshot);
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'extended',
      orchestrationId: 'orch-ENG-1',
      addedSubIssueIds: [],
      releasableSubIssueIds: [],
    });

    await handler(event());

    expect(jiraGraphSourceMock).toHaveBeenCalledTimes(1);
    expect(discoverOrchestrationMock).toHaveBeenCalledTimes(1);
    expect(releaseReadyChildrenMock).not.toHaveBeenCalled();
    expect(upsertEpicPanelMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('releases only a newly-added root and reopens the existing panel', async () => {
    const extendedSnapshot = {
      ...snapshot,
      meta: { ...snapshot.meta, child_count: 2, status_comment_id: 'panel-1' },
      children: [
        { ...snapshot.children[0], child_status: 'succeeded' },
        {
          ...snapshot.children[0],
          sub_issue_id: 'ENG-3',
          child_status: 'ready',
        },
      ],
    };
    jiraGraphSourceMock.mockReturnValueOnce(jest.fn().mockResolvedValue({
      kind: 'ok',
      children: [child(), child('ENG-3')],
    }));
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'extended',
      orchestrationId: 'orch-ENG-1',
      addedSubIssueIds: ['ENG-3'],
      releasableSubIssueIds: ['ENG-3'],
    });
    loadOrchestrationMock.mockReset();
    loadOrchestrationMock
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(extendedSnapshot)
      .mockResolvedValueOnce(extendedSnapshot);

    await handler(event());

    expect(releaseReadyChildrenMock).toHaveBeenCalledTimes(1);
    expect(releaseReadyChildrenMock.mock.calls[0][2]).toEqual([
      expect.objectContaining({ sub_issue_id: 'ENG-3', child_status: 'ready' }),
    ]);
    expect(releaseReadyChildrenMock.mock.calls[0][6]).toBe(extendedSnapshot.children);
    expect(upsertEpicPanelMock).toHaveBeenCalledWith(expect.objectContaining({
      statusCommentId: 'panel-1',
      inProgress: true,
      children: extendedSnapshot.children,
      parent: expect.objectContaining({
        issueId: 'ENG-1',
        credentialsRef: 'cloud-1',
        stateOverrides: {
          started: 'Doing',
          inReview: 'Review',
        },
      }),
    }));
    expect(setStatusCommentIdMock).not.toHaveBeenCalled();
  });

  test('leaves a newly-added blocked child for the reconciler but refreshes the panel', async () => {
    const extendedSnapshot = {
      ...snapshot,
      meta: { ...snapshot.meta, child_count: 2 },
      children: [
        snapshot.children[0],
        {
          ...snapshot.children[0],
          sub_issue_id: 'ENG-3',
          depends_on: ['ENG-2'],
          child_status: 'blocked',
        },
      ],
    };
    jiraGraphSourceMock.mockReturnValueOnce(jest.fn().mockResolvedValue({
      kind: 'ok',
      children: [child(), { ...child('ENG-3'), depends_on: ['ENG-2'] }],
    }));
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'extended',
      orchestrationId: 'orch-ENG-1',
      addedSubIssueIds: ['ENG-3'],
      releasableSubIssueIds: [],
    });
    loadOrchestrationMock.mockReset();
    loadOrchestrationMock
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(extendedSnapshot);
    upsertEpicPanelMock.mockResolvedValueOnce('new-panel');

    const extensionEvent = event();
    const payload = JSON.parse(extensionEvent.raw_body);
    payload.issue.fields.attachment = [{ id: 'existing-parent-attachment' }];
    extensionEvent.raw_body = JSON.stringify(payload);

    await handler(extensionEvent);

    expect(releaseReadyChildrenMock).not.toHaveBeenCalled();
    expect(loadOrchestrationMock).toHaveBeenCalledTimes(2);
    expect(fetchRecentHumanCommentsMock).not.toHaveBeenCalled();
    expect(downloadScreenAndStoreJiraAttachmentsMock).not.toHaveBeenCalled();
    expect(upsertEpicPanelMock).toHaveBeenCalledWith(expect.objectContaining({
      inProgress: true,
      children: extendedSnapshot.children,
    }));
    expect(setStatusCommentIdMock).toHaveBeenCalledWith(
      expect.anything(),
      'Orchestrations',
      'orch-ENG-1',
      'new-panel',
    );
  });

  test('does not create a parent task when an existing graph currently returns no children', async () => {
    loadOrchestrationMock.mockReset();
    loadOrchestrationMock.mockResolvedValueOnce(snapshot);
    jiraGraphSourceMock.mockReturnValueOnce(jest.fn().mockResolvedValue({ kind: 'no_children' }));

    await handler(event());

    expect(discoverOrchestrationMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('surfaces shared DAG rejection and creates no task', async () => {
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'rejected',
      reason: 'cycle',
      message: 'The child graph contains a cycle.',
    });

    await handler(event());

    expect(releaseReadyChildrenMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reportIssueFailureMock).toHaveBeenCalledWith(
      expect.anything(),
      'ENG-1',
      expect.stringContaining('contains a cycle'),
    );
  });
});
