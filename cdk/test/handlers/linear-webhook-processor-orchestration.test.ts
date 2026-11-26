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
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
  BatchWriteCommand: jest.fn((input: unknown) => ({ _type: 'BatchWrite', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

const reportIssueFailureMock = jest.fn();
const swapIssueReactionMock = jest.fn();
const swapCommentReactionMock = jest.fn();
const transitionIssueStateMock = jest.fn();
const upsertStatusCommentMock = jest.fn();
const reactToCommentMock = jest.fn();
const replyToCommentMock = jest.fn();
const upsertThreadedReplyMock = jest.fn();
const fetchRecentCommentsMock = jest.fn();
const postIssueCommentMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  reportIssueFailure: (...args: unknown[]) => reportIssueFailureMock(...args),
  swapIssueReaction: (...args: unknown[]) => swapIssueReactionMock(...args),
  swapCommentReaction: (...args: unknown[]) => swapCommentReactionMock(...args),
  transitionIssueState: (...args: unknown[]) => transitionIssueStateMock(...args),
  upsertStatusComment: (...args: unknown[]) => upsertStatusCommentMock(...args),
  reactToComment: (...args: unknown[]) => reactToCommentMock(...args),
  replyToComment: (...args: unknown[]) => replyToCommentMock(...args),
  upsertThreadedReply: (...args: unknown[]) => upsertThreadedReplyMock(...args),
  fetchRecentComments: (...args: unknown[]) => fetchRecentCommentsMock(...args),
  postIssueComment: (...args: unknown[]) => postIssueCommentMock(...args),
  EMOJI_STARTED: 'eyes',
  EMOJI_SUCCESS: 'white_check_mark',
  EMOJI_FAILURE: 'x',
  EMOJI_NEEDS_INPUT: 'question',
}));

const resolveLinearOauthTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: (...args: unknown[]) => resolveLinearOauthTokenMock(...args),
}));

const discoverOrchestrationMock = jest.fn();
jest.mock('../../src/handlers/shared/orchestration-discovery', () => ({
  discoverOrchestration: (...args: unknown[]) => discoverOrchestrationMock(...args),
}));

const fetchIssueParentIdMock = jest.fn();
const fetchSubIssueGraphMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-subissue-fetch', () => ({
  fetchIssueParentId: (...args: unknown[]) => fetchIssueParentIdMock(...args),
  fetchSubIssueGraph: (...args: unknown[]) => fetchSubIssueGraphMock(...args),
}));

jest.mock('../../src/handlers/shared/linear-issue-context-probe', () => ({
  probeLinearIssueContext: jest.fn().mockResolvedValue({
    attachmentTitles: [],
    attachments: [],
    projectName: null,
    projectHasDocuments: false,
    projectDocuments: [],
    ok: true,
    projectDocumentCount: 0,
  }),
  renderIssueContextHint: jest.fn(() => ''),
}));

process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'LinearProjects';
process.env.LINEAR_USER_MAPPING_TABLE_NAME = 'LinearUsers';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
process.env.TASK_TABLE_NAME = 'TaskTable';
process.env.ORCHESTRATION_TABLE_NAME = 'OrchestrationTable';

import { handler } from '../../src/handlers/linear-webhook-processor';
import { buildClarifyResumeDescription } from '../../src/handlers/shared/clarify-resume';
import { resetSessionWorkspaceCacheForTests } from '../../src/handlers/shared/linear-channel-metadata';
import { LOOKUP_ABSENT, lookupFailed, lookupFound } from '../../src/handlers/shared/lookup-result';
import { isBotAuthoredComment } from '../../src/handlers/shared/orchestration-comment-trigger';

function eventWith(payload: Record<string, unknown>): { raw_body: string } {
  return { raw_body: JSON.stringify(payload) };
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'create',
    type: 'Issue',
    organizationId: 'org-1',
    actor: { id: 'user-1' },
    data: {
      id: 'issue-1',
      identifier: 'ABC-42',
      title: 'Epic: ship the thing',
      description: 'Parent epic.',
      projectId: 'project-1',
      teamId: 'team-1',
      labels: [{ id: 'lbl-bg', name: 'bgagent' }],
    },
    ...overrides,
  };
}

function happyPreamble(): void {
  ddbSend
    .mockResolvedValueOnce({ Item: { status: 'active', repo: 'owner/repo', label_filter: 'bgagent' } })
    .mockResolvedValueOnce({ Item: { platform_user_id: 'platform-user-1' } });
  resolveLinearOauthTokenMock.mockResolvedValue({
    accessToken: 'access-tok',
    oauthSecretArn: 'arn:secret',
    workspaceSlug: 'acme',
  });
}

describe('linear-webhook-processor — orchestration routing', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    ddbSend.mockResolvedValue({ Items: [] });
    createTaskCoreMock.mockReset();
    createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'child-task' } }) });
    reportIssueFailureMock.mockReset();
    reportIssueFailureMock.mockResolvedValue(undefined);
    fetchRecentCommentsMock.mockReset().mockResolvedValue([]);
    postIssueCommentMock.mockReset().mockResolvedValue({ ok: true });
    resolveLinearOauthTokenMock.mockReset();
    discoverOrchestrationMock.mockReset();
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    swapCommentReactionMock.mockReset().mockResolvedValue(true);
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    upsertStatusCommentMock.mockReset().mockResolvedValue('cmt-status-1');
    fetchIssueParentIdMock.mockReset();
    fetchSubIssueGraphMock.mockReset().mockResolvedValue({
      kind: 'ok', parentIssueId: 'issue-1', children: [{ id: 'A', depends_on: [] }],
    });
  });

  test('seeded graph → no parent task created (reconciler owns children)', async () => {
    happyPreamble();
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'seeded',
      orchestrationId: 'orch_abc',
      childCount: 3,
      rootSubIssueIds: ['A'],
      alreadyExisted: false,
    });
    ddbSend.mockResolvedValue({
      Items: [
        {
          sub_issue_id: '#meta',
          orchestration_id: 'orch_abc',
          parent_linear_issue_id: 'issue-1',
          linear_workspace_id: 'org-1',
          repo: 'owner/repo',
          platform_user_id: 'u1',
        },
        {
          sub_issue_id: 'A',
          orchestration_id: 'orch_abc',
          depends_on: [],
          child_status: 'ready',
          parent_linear_issue_id: 'issue-1',
          linear_workspace_id: 'org-1',
          repo: 'owner/repo',
        },
      ],
    });

    await handler(eventWith(issue()));

    expect(discoverOrchestrationMock).toHaveBeenCalledTimes(1);
    expect(reportIssueFailureMock).not.toHaveBeenCalled();
    const calledWithParentBody = createTaskCoreMock.mock.calls.some(
      (c) => (c[0] as { task_description?: string }).task_description?.includes('Epic: ship the thing'));
    expect(calledWithParentBody).toBe(false);
    expect(upsertStatusCommentMock).toHaveBeenCalled();
    expect(swapIssueReactionMock).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'eyes');
    expect(transitionIssueStateMock).toHaveBeenCalledWith(
      expect.anything(), expect.any(String), 'started', ['In Progress'], true,
    );
  });

  test('seeded → posts the live status block on the parent + stamps its id', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { status: 'active', repo: 'owner/repo', label_filter: 'bgagent' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'u1' } });
    resolveLinearOauthTokenMock.mockResolvedValue({ accessToken: 'tok', oauthSecretArn: 'arn', workspaceSlug: 'acme' });
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'seeded', orchestrationId: 'orch_abc', childCount: 1, rootSubIssueIds: ['A'], alreadyExisted: false,
    });
    const snapshotItems = {
      Items: [
        { sub_issue_id: '#meta', orchestration_id: 'orch_abc', parent_linear_issue_id: 'issue-1', linear_workspace_id: 'org-1', repo: 'owner/repo', child_count: 1, platform_user_id: 'u1' },
        { sub_issue_id: 'A', orchestration_id: 'orch_abc', parent_linear_issue_id: 'issue-1', linear_workspace_id: 'org-1', repo: 'owner/repo', depends_on: [], child_status: 'released', linear_identifier: 'ABCA-1', title: 'Step A' },
      ],
    };
    ddbSend.mockResolvedValue(snapshotItems);

    await handler(eventWith(issue()));

    expect(upsertStatusCommentMock).toHaveBeenCalledTimes(1);
    const [, parentArg, bodyArg, existingId] = upsertStatusCommentMock.mock.calls[0];
    expect(parentArg).toBe('issue-1');
    expect(bodyArg).toContain('ABCA orchestration');
    expect(existingId).toBeUndefined();
    const stampUpdate = ddbSend.mock.calls.map((c) => c[0]?.input).find((i) => i?.UpdateExpression?.includes('status_comment_id'));
    expect(stampUpdate?.ExpressionAttributeValues?.[':cid']).toBe('cmt-status-1');
  });

  test('a root REJECTED at seed time settles the epic now, not 10 minutes later', async () => {
    resolveLinearOauthTokenMock.mockResolvedValue({ accessToken: 'tok', oauthSecretArn: 'arn', workspaceSlug: 'acme' });
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'seeded', orchestrationId: 'orch_gr', childCount: 2, rootSubIssueIds: ['A'], alreadyExisted: false,
    });
    createTaskCoreMock.mockReset().mockResolvedValue({
      statusCode: 400,
      body: '{"error":{"message":"Task description was blocked by content policy."}}',
    });

    const meta = { sub_issue_id: '#meta', orchestration_id: 'orch_gr', parent_issue_ref: 'issue-1', credentials_ref: 'org-1', repo: 'owner/repo', child_count: 2, platform_user_id: 'u1' };
    const rowA = { sub_issue_id: 'A', orchestration_id: 'orch_gr', parent_issue_ref: 'issue-1', credentials_ref: 'org-1', repo: 'owner/repo', depends_on: [], child_status: 'ready', display_id: 'ABCA-1', title: 'Blocked root' };
    const rowB = { sub_issue_id: 'B', orchestration_id: 'orch_gr', parent_issue_ref: 'issue-1', credentials_ref: 'org-1', repo: 'owner/repo', depends_on: ['A'], child_status: 'blocked', display_id: 'ABCA-2', title: 'Dependent' };
    const store: Record<string, Record<string, unknown>> = {
      '#meta': { ...meta }, 'A': { ...rowA }, 'B': { ...rowB },
    };
    let gets = 0;
    ddbSend.mockReset();
    ddbSend.mockImplementation(async (cmd: { _type?: string; input?: Record<string, unknown> }) => {
      if (cmd?._type === 'Get') {
        gets += 1;
        if (gets === 1) return { Item: { status: 'active', repo: 'owner/repo', label_filter: 'bgagent' } };
        if (gets === 2) return { Item: { platform_user_id: 'u1' } };
        return {};
      }
      if (cmd?._type === 'Query') return { Items: Object.values(store) };
      if (cmd?._type === 'Update') {
        const sk = (cmd.input?.Key as { sub_issue_id?: string })?.sub_issue_id;
        const vals = (cmd.input?.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
        if (sk && store[sk]) {
          const expr = String(cmd.input?.UpdateExpression ?? '');
          for (const [bind, value] of Object.entries(vals)) {
            if (expr.includes(`child_status = ${bind}`)) store[sk].child_status = value;
            if (expr.includes(`failure_reason = ${bind}`)) store[sk].failure_reason = value;
          }
        }
        return {};
      }
      return {};
    });

    await handler(eventWith(issue()));

    const skipWrite = ddbSend.mock.calls
      .map((c) => c[0]?.input)
      .find((i) => i?.ExpressionAttributeValues?.[':s'] === 'skipped');
    expect(skipWrite).toBeDefined();
    expect((skipWrite!.Key as { sub_issue_id: string }).sub_issue_id).toBe('B');

    expect(upsertStatusCommentMock).toHaveBeenCalledTimes(1);
    const [, , body] = upsertStatusCommentMock.mock.calls[0];
    expect(body).toContain('finished with failures');
    expect(body).not.toMatch(/^🔄/);
    expect(body).toContain('reword this sub-issue');
    expect(body).toContain('@bgagent retry');
  });

  test('seeded on idempotent replay → no duplicate start signal on parent', async () => {
    happyPreamble();
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'seeded',
      orchestrationId: 'orch_abc',
      childCount: 3,
      rootSubIssueIds: ['A'],
      alreadyExisted: true,
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    await handler(eventWith(issue()));

    expect(swapIssueReactionMock).not.toHaveBeenCalled();
    expect(transitionIssueStateMock).not.toHaveBeenCalled();
  });

  test('the seed records the project trigger label, so the retry hint can name it', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { status: 'active', repo: 'owner/repo', label_filter: 'Ship-It' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'platform-user-1' } });
    resolveLinearOauthTokenMock.mockResolvedValue({
      accessToken: 'access-tok', oauthSecretArn: 'arn:secret', workspaceSlug: 'acme',
    });
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'seeded', orchestrationId: 'orch_abc', childCount: 1, rootSubIssueIds: ['A'], alreadyExisted: true,
    });
    const labelled = issue();
    (labelled.data as Record<string, unknown>).labels = [{ id: 'lbl-ship', name: 'Ship-It' }];

    await handler(eventWith(labelled));

    const { releaseContext } = discoverOrchestrationMock.mock.calls[0][0] as {
      releaseContext: { trigger_label?: string };
    };
    expect(releaseContext.trigger_label).toBe('ship-it');
  });

  test('a project with no configured label records the default, never a blank', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { status: 'active', repo: 'owner/repo' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'platform-user-1' } });
    resolveLinearOauthTokenMock.mockResolvedValue({
      accessToken: 'access-tok', oauthSecretArn: 'arn:secret', workspaceSlug: 'acme',
    });
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'seeded', orchestrationId: 'orch_abc', childCount: 1, rootSubIssueIds: ['A'], alreadyExisted: true,
    });

    await handler(eventWith(issue()));

    const { releaseContext } = discoverOrchestrationMock.mock.calls[0][0] as {
      releaseContext: { trigger_label?: string };
    };
    expect(releaseContext.trigger_label).toBe('bgagent');
  });

  describe('re-labelling an epic with no new sub-issues', () => {
    function wireEpic(children: Array<Record<string, unknown>>): void {
      const meta = {
        sub_issue_id: '#meta',
        orchestration_id: 'orch_abc',
        parent_linear_issue_id: 'issue-1',
        linear_workspace_id: 'org-1',
        repo: 'owner/repo',
        child_count: children.length,
        platform_user_id: 'platform-user-1',
      };
      ddbSend.mockImplementation(async (cmd: { _type: string; input?: Record<string, unknown> }) => {
        if (cmd._type === 'Get') {
          const key = (cmd.input?.Key ?? {}) as { linear_project_id?: string; linear_identity?: string };
          if (key.linear_project_id) return { Item: { status: 'active', repo: 'owner/repo', label_filter: 'bgagent' } };
          if (key.linear_identity) return { Item: { platform_user_id: 'platform-user-1' } };
          return {};
        }
        if (cmd._type === 'Query') return { Items: [meta, ...children] };
        return {};
      });
      resolveLinearOauthTokenMock.mockResolvedValue({
        accessToken: 'access-tok', oauthSecretArn: 'arn:secret', workspaceSlug: 'acme',
      });
      discoverOrchestrationMock.mockResolvedValueOnce({
        kind: 'extended',
        orchestrationId: 'orch_abc',
        addedSubIssueIds: [],
        releasableSubIssueIds: [],
      });
    }

    const child = (id: string, status: string): Record<string, unknown> => ({
      sub_issue_id: id,
      orchestration_id: 'orch_abc',
      parent_linear_issue_id: 'issue-1',
      linear_workspace_id: 'org-1',
      repo: 'owner/repo',
      depends_on: [],
      child_status: status,
      updated_at: '2026-07-01T00:00:00.000Z',
    });

    test('a failed child is actually re-run, and the note names what is being re-run', async () => {
      wireEpic([child('A', 'failed'), child('B', 'succeeded')]);

      await handler(eventWith(issue()));

      expect(createTaskCoreMock).toHaveBeenCalled();
      const posted = upsertStatusCommentMock.mock.calls.map((c) => String(c[2])).join('\n');
      expect(posted).toMatch(/Re-running the parts of this epic that didn't finish/i);
      expect(posted).toContain('1 failed');
      expect(posted).toMatch(/1 that already succeeded is left as-is/);
    });

    test('an all-succeeded epic says so plainly and re-runs nothing', async () => {
      wireEpic([child('A', 'succeeded'), child('B', 'succeeded')]);

      await handler(eventWith(issue()));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const posted = upsertStatusCommentMock.mock.calls.map((c) => String(c[2])).join('\n');
      expect(posted).toMatch(/already finished/i);
      expect(posted).toMatch(/nothing to re-run/i);
    });

    test('a still-running epic posts NOTHING — the live panel already says so', async () => {
      wireEpic([child('A', 'running'), child('B', 'blocked')]);

      await handler(eventWith(issue()));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const posted = upsertStatusCommentMock.mock.calls.map((c) => String(c[2])).join('\n');
      expect(posted).not.toMatch(/already finished/i);
      expect(posted).not.toMatch(/Re-running/i);
    });
  });

  test('no sub-issues → single_task falls through to normal task creation', async () => {
    happyPreamble();
    fetchSubIssueGraphMock.mockResolvedValueOnce({ kind: 'no_children', parentIssueId: 'issue-1' });
    discoverOrchestrationMock.mockResolvedValueOnce({ kind: 'single_task', parentLinearIssueId: 'issue-1' });
    createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });

    await handler(eventWith(issue()));

    expect(discoverOrchestrationMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
  });

  test('rejected graph (cycle) → terminal comment, no task', async () => {
    happyPreamble();
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'rejected',
      reason: 'cycle',
      message: 'The sub-issue blocking relations form a cycle.',
    });

    await handler(eventWith(issue()));

    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
    const [ctx, issueId, message] = reportIssueFailureMock.mock.calls[0];
    expect(ctx).toMatchObject({ linearWorkspaceId: 'org-1' });
    expect(issueId).toBe('issue-1');
    expect(String(message)).toMatch(/cycle/i);
  });

  test('discovery error → terminal comment, no task, no silent single-task fallback', async () => {
    happyPreamble();
    discoverOrchestrationMock.mockResolvedValueOnce({ kind: 'error', message: 'Could not reach the Linear API.' });

    await handler(eventWith(issue()));

    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
  });

  test('no workspace token → event dropped (no orchestration, no task)', async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { status: 'active', repo: 'owner/repo', label_filter: 'bgagent' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'platform-user-1' } });
    resolveLinearOauthTokenMock.mockResolvedValue(null);

    await handler(eventWith(issue()));

    expect(discoverOrchestrationMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('unmapped-project nudge is claim-once — a redelivery posts EXACTLY ONE nudge', async () => {
    const claimed = new Set<string>();
    resolveLinearOauthTokenMock.mockResolvedValue({ accessToken: 't', oauthSecretArn: 'a', workspaceSlug: 'w' });
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      const key = cmd.input?.Key as { sub_issue_id?: string; linear_project_id?: string } | undefined;
      if (key?.linear_project_id) return { Item: undefined };
      if (cmd._type === 'Update' && key?.sub_issue_id?.includes('noproject-nudge#')) {
        if (claimed.has(key.sub_issue_id)) {
          throw Object.assign(new Error('claim'), { name: 'ConditionalCheckFailedException' });
        }
        claimed.add(key.sub_issue_id);
      }
      return {};
    });
    const abcaIssue = () => issue({
      data: {
        id: 'issue-1',
        identifier: 'ABC-1',
        title: 'x',
        description: '',
        projectId: 'project-1',
        teamId: 't',
        labels: [{ id: 'l-abca', name: 'abca' }],
      },
    });
    await handler(eventWith(abcaIssue()));
    await handler(eventWith(abcaIssue()));
    await handler(eventWith(abcaIssue()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
  });

  describe(':help label', () => {
    function helpIssue(): Record<string, unknown> {
      return issue({
        data: {
          id: 'issue-1',
          identifier: 'ABC-42',
          title: 'Anything',
          description: 'x',
          projectId: 'project-1',
          teamId: 'team-1',
          labels: [{ id: 'lbl-help', name: 'bgagent:help' }],
        },
      });
    }

    test(':help posts the label explainer and creates NO task', async () => {
      ddbSend
        .mockResolvedValueOnce({ Item: { status: 'active', repo: 'owner/repo', label_filter: 'bgagent' } })
        .mockResolvedValueOnce({});

      await handler(eventWith(helpIssue()));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(discoverOrchestrationMock).not.toHaveBeenCalled();
      expect(upsertStatusCommentMock).toHaveBeenCalledTimes(1);
      const [, issueId, body] = upsertStatusCommentMock.mock.calls[0];
      expect(issueId).toBe('issue-1');
      expect(String(body)).toContain('`bgagent`');
      expect(String(body)).toMatch(/how to use abca/i);
    });

    test(':help is idempotent — a webhook redelivery does NOT repost', async () => {
      ddbSend
        .mockResolvedValueOnce({ Item: { status: 'active', repo: 'owner/repo', label_filter: 'bgagent' } })
        .mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }));

      await handler(eventWith(helpIssue()));

      expect(upsertStatusCommentMock).not.toHaveBeenCalled();
      expect(createTaskCoreMock).not.toHaveBeenCalled();
    });

    test(':help on a project that is not onboarded gets the onboarding nudge, not silence', async () => {
      await handler(eventWith(helpIssue()));

      expect(upsertStatusCommentMock).not.toHaveBeenCalled();
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
      const [ctx, issueId, message] = reportIssueFailureMock.mock.calls[0];
      expect(ctx).toMatchObject({ linearWorkspaceId: 'org-1' });
      expect(issueId).toBe('issue-1');
      expect(String(message)).toContain("This Linear project isn't onboarded to ABCA");
    });
  });
});

describe('linear-webhook-processor — @bgagent comment trigger', () => {
  function comment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'Comment',
      action: 'create',
      organizationId: 'org-1',
      actor: { id: 'user-9' },
      data: { id: 'comment-1', body: '@bgagent change the timeout to 30 min', issueId: 'sub-issue-1' },
      ...overrides,
    };
  }

  function mockOrchWithChild(opts: {
    subIssueId: string;
    childTaskId?: string;
    childStatus?: string;
    prUrl?: string;
    standalone?: { task_id: string; user_id?: string; repo?: string; pr_url?: string; pr_number?: number };
  }): void {
    const meta = {
      sub_issue_id: '#meta',
      orchestration_id: 'orch_x',
      parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'org-1',
      repo: 'o/r',
      child_count: 1,
      platform_user_id: 'release-user',
    };
    const child: Record<string, unknown> = {
      orchestration_id: 'orch_x',
      sub_issue_id: opts.subIssueId,
      depends_on: [],
      child_status: opts.childStatus ?? 'succeeded',
      repo: 'o/r',
      parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'org-1',
    };
    if (opts.childTaskId) child.child_task_id = opts.childTaskId;
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'LinearIssueIndex') {
        return { Items: opts.standalone ? [{ channel_metadata: { linear_workspace_id: 'org-1' }, ...opts.standalone }] : [] };
      }
      if (cmd._type === 'Query') return { Items: [meta, child] };
      if (cmd._type === 'Get' && (cmd.input.Key as { linear_identity?: string })?.linear_identity) {
        return { Item: { platform_user_id: 'commenter-user', status: 'active' } };
      }
      if (cmd._type === 'Get') return { Item: opts.prUrl ? { pr_url: opts.prUrl } : {} };
      return {};
    });
  }

  function mockStandaloneOnly(standalone: { task_id: string; user_id?: string; repo?: string; pr_url?: string; pr_number?: number; status?: string } | null): void {
    fetchIssueParentIdMock.mockResolvedValue(LOOKUP_ABSENT);
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'LinearIssueIndex') {
        return { Items: standalone ? [{ channel_metadata: { linear_workspace_id: 'org-1' }, ...standalone }] : [] };
      }
      if (cmd._type === 'Get' && (cmd.input.Key as { linear_identity?: string })?.linear_identity) {
        return { Item: { platform_user_id: 'commenter-user', status: 'active' } };
      }
      return {};
    });
  }

  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset().mockResolvedValue({ statusCode: 201, body: '{}' });
    resolveLinearOauthTokenMock.mockReset()
      .mockResolvedValue({ accessToken: 'tok', oauthSecretArn: 'arn:secret', workspaceSlug: 'acme' });
    fetchIssueParentIdMock.mockReset().mockResolvedValue(lookupFound('PARENT'));
    fetchSubIssueGraphMock.mockReset().mockResolvedValue({ kind: 'no_children', parentIssueId: 'PARENT' });
    discoverOrchestrationMock.mockReset();
    reactToCommentMock.mockReset().mockResolvedValue(true);
    replyToCommentMock.mockReset().mockResolvedValue(true);
    upsertThreadedReplyMock.mockReset().mockResolvedValue('reply-1');
  });

  describe('a comment cannot act on another workspace\'s work', () => {
    function expectSilentDrop(): void {
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(reactToCommentMock).not.toHaveBeenCalled();
      expect(upsertThreadedReplyMock).not.toHaveBeenCalled();
      expect(replyToCommentMock).not.toHaveBeenCalled();
    }

    test('a sub-issue of another workspace\'s orchestration starts no iteration', async () => {
      mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', prUrl: 'https://github.com/o/r/pull/42' });
      await handler(eventWith(comment({ organizationId: 'org-2' })));
      expectSilentDrop();
    });

    test('another workspace\'s parent epic starts no iteration, even naming a child', async () => {
      mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', prUrl: 'https://github.com/o/r/pull/42' });
      await handler(eventWith(comment({
        organizationId: 'org-2',
        data: { id: 'comment-1', body: '@bgagent sub-issue-1: change the timeout', issueId: 'PARENT' },
      })));
      expectSilentDrop();
    });

    test('a standalone task from another workspace starts no iteration', async () => {
      mockStandaloneOnly({ task_id: 'task-p', user_id: 'other-user', repo: 'o2/r2', pr_number: 7 });
      await handler(eventWith(comment({ organizationId: 'org-2' })));
      expectSilentDrop();
    });

    test('a standalone task that records no workspace is not acted on', async () => {
      mockStandaloneOnly({
        task_id: 'task-p',
        user_id: 'other-user',
        repo: 'o2/r2',
        pr_number: 7,
        channel_metadata: {},
      } as Parameters<typeof mockStandaloneOnly>[0]);
      await handler(eventWith(comment()));
      expectSilentDrop();
    });
  });

  test('@bgagent on a started sub-issue → pr-iteration task on its PR with cascade marker', async () => {
    mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', prUrl: 'https://github.com/o/r/pull/42' });
    await handler(eventWith(comment()));

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [body, ctx] = createTaskCoreMock.mock.calls[0];
    expect(body.workflow_ref).toBe('coding/pr-iteration-v1');
    expect(body.pr_number).toBe(42);
    expect(body.task_description).toBe('change the timeout to 30 min');
    expect(ctx.channelSource).toBe('linear');
    expect(ctx.channelMetadata.orchestration_iteration).toBe('true');
    expect(ctx.channelMetadata.orchestration_sub_issue_id).toBe('sub-issue-1');
    expect(ctx.channelMetadata.linear_issue_id).toBe('sub-issue-1');
    expect(ctx.idempotencyKey).toContain('comment-1');
    expect(ctx.channelMetadata.trigger_comment_id).toBe('comment-1');
  });

  test('the "on it" ack replies on the commented issue, threaded under that comment', async () => {
    mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', prUrl: 'https://github.com/o/r/pull/42' });
    await handler(eventWith(comment()));

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const [ctx, issueId, parentCommentId, body, existingReplyId] = upsertThreadedReplyMock.mock.calls[0];
    expect(ctx).toEqual({ linearWorkspaceId: 'org-1', registryTableName: 'LinearWorkspaceRegistry' });
    expect(issueId).toBe('sub-issue-1');
    expect(parentCommentId).toBe('comment-1');
    expect(body).toContain('👀');
    expect(existingReplyId).toBeUndefined();
    const [, taskCtx] = createTaskCoreMock.mock.calls[0];
    expect(taskCtx.channelMetadata.iteration_reply_comment_id).toBe('reply-1');
  });

  test('"@bgagent retry" on a sub-issue re-runs the epic\'s failed child (not iteration)', async () => {
    const meta = {
      sub_issue_id: '#meta',
      orchestration_id: 'orch_x',
      parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'org-1',
      repo: 'o/r',
      child_count: 2,
      platform_user_id: 'release-user',
      release_context: { platform_user_id: 'release-user' },
    };
    const okChild = {
      orchestration_id: 'orch_x',
      sub_issue_id: 'sub-issue-1',
      depends_on: [],
      child_status: 'succeeded',
      repo: 'o/r',
      parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'org-1',
      child_task_id: 'task-sub-1',
    };
    const badSibling = {
      orchestration_id: 'orch_x',
      sub_issue_id: 'sub-bad',
      depends_on: [],
      child_status: 'failed',
      repo: 'o/r',
      parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'org-1',
      child_task_id: 'task-bad-1',
    };
    const claimed = new Set<string>();
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'LinearIssueIndex') return { Items: [] };
      if (cmd._type === 'Query') return { Items: [meta, okChild, badSibling] };
      if (cmd._type === 'Update') {
        const sk = (cmd.input.Key as { sub_issue_id?: string })?.sub_issue_id ?? '';
        if (sk.startsWith('ack#') || sk.startsWith('retry:') || sk === '#rollup-claim') {
          if (claimed.has(sk)) throw Object.assign(new Error('claim'), { name: 'ConditionalCheckFailedException' });
          claimed.add(sk);
        }
        return {};
      }
      if (cmd._type === 'Get' && (cmd.input.Key as { linear_identity?: string })?.linear_identity) {
        return { Item: { platform_user_id: 'commenter-user', status: 'active' } };
      }
      return {};
    });
    fetchSubIssueGraphMock.mockResolvedValue({
      kind: 'ok',
      parentIssueId: 'PARENT',
      children: [{ id: 'sub-issue-1', depends_on: [] }, { id: 'sub-bad', depends_on: [], title: 'Reworded' }],
    });

    await handler(eventWith(comment({ data: { id: 'c-retry', body: '@bgagent retry', issueId: 'sub-issue-1' } })));

    expect(fetchSubIssueGraphMock).toHaveBeenCalledWith('tok', 'PARENT', undefined);
    const textWrites = ddbSend.mock.calls
      .map((c) => c[0] as { _type?: string; input: { Key?: { sub_issue_id?: string }; ExpressionAttributeValues?: Record<string, unknown>; ExpressionAttributeNames?: Record<string, string> } })
      .filter((cmd) => cmd._type === 'Update' && cmd.input.ExpressionAttributeNames?.['#title'] === 'title');
    expect(textWrites.map((cmd) => [cmd.input.Key?.sub_issue_id, cmd.input.ExpressionAttributeValues?.[':title']]))
      .toEqual([['sub-bad', 'Reworded']]);

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [body, ctx] = createTaskCoreMock.mock.calls[0];
    expect(body.workflow_ref).not.toBe('coding/pr-iteration-v1');
    expect(ctx.idempotencyKey).toContain('task-bad-1');
    expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'c-retry', 'eyes');
    expect(replyToCommentMock).not.toHaveBeenCalled();
    const recorded = ddbSend.mock.calls
      .map((c) => c[0] as { _type?: string; input?: { UpdateExpression?: string; ExpressionAttributeValues?: Record<string, unknown> } })
      .filter((cmd) => cmd?._type === 'Update' && /SET retry_comment_id/.test(cmd.input?.UpdateExpression ?? ''));
    expect(recorded).toHaveLength(1);
    expect(recorded[0].input?.ExpressionAttributeValues?.[':cid']).toBe('c-retry');
  });

  test('@bgagent on a started sub-issue → instant 👀 ack on the TRIGGERING comment', async () => {
    mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', prUrl: 'https://github.com/o/r/pull/42' });
    await handler(eventWith(comment()));

    expect(reactToCommentMock).toHaveBeenCalledTimes(1);
    const [, commentId, emoji] = reactToCommentMock.mock.calls[0];
    expect(commentId).toBe('comment-1');
    expect(emoji).toBe('eyes');
  });

  test('@bgagent THREAD-REPLY trigger → 👀 on the reply, but reply target is the thread ROOT', async () => {
    mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', prUrl: 'https://github.com/o/r/pull/42' });
    await handler(eventWith(comment({
      data: { id: 'reply-cmt-9', parentId: 'root-cmt-1', body: '@bgagent tweak it', issueId: 'sub-issue-1' },
    })));

    expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'reply-cmt-9', 'eyes');
    const ctx = createTaskCoreMock.mock.calls[0][1];
    // Linear's commentCreate rejects a reply whose parent is itself a reply.
    expect(ctx.channelMetadata.trigger_comment_id).toBe('root-cmt-1');
  });

  describe('@bgagent on a started sub-issue that has no pull request', () => {
    const askForAFix = (): Record<string, unknown> => comment({
      data: {
        id: 'comment-1',
        body: '@bgagent the fixture path is wrong, use fixtures/v2 and run the tests again please',
        issueId: 'sub-issue-1',
      },
    });

    function expectAnsweredWithoutWork(): string {
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(upsertThreadedReplyMock).not.toHaveBeenCalled();
      expect(replyToCommentMock).toHaveBeenCalledTimes(1);
      const [, issueId, parentCommentId, body] = replyToCommentMock.mock.calls[0];
      expect(issueId).toBe('sub-issue-1');
      expect(parentCommentId).toBe('comment-1');
      expect(reactToCommentMock.mock.calls).toEqual([[expect.anything(), 'comment-1', 'question']]);
      // Linear delivers the app's own comments back as Comment webhooks.
      expect(isBotAuthoredComment(String(body))).toBe(true);
      return String(body);
    }

    test('a sub-issue that failed before opening a PR: says so and how to re-run it', async () => {
      mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', childStatus: 'failed' });
      await handler(eventWith(askForAFix()));
      const reply = expectAnsweredWithoutWork();
      expect(reply).toMatch(/failed before opening a PR/);
      expect(reply).toContain('`@bgagent retry`');
    });

    test('a sub-issue still at work: says there is no pull request to iterate on', async () => {
      mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', childStatus: 'released' });
      await handler(eventWith(askForAFix()));
      const reply = expectAnsweredWithoutWork();
      expect(reply).toMatch(/no pull request, so there's nothing to iterate on/);
      expect(reply).not.toMatch(/failed/);
    });

    test('a sub-issue whose run ended without a pull request is not told that one is coming', async () => {
      mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', childStatus: 'succeeded' });
      await handler(eventWith(askForAFix()));
      const reply = expectAnsweredWithoutWork();
      expect(reply).toMatch(/no pull request, so there's nothing to iterate on/);
      expect(reply).not.toMatch(/\byet\b/);
      expect(reply).toMatch(/If its run is still in progress, comment again once it has opened one/);
    });

    test('a failed read of the task record: says so and asks to comment again', async () => {
      mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1' });
      const snapshot = ddbSend.getMockImplementation()!;
      ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
        if (cmd._type === 'Get' && (cmd.input.Key as { task_id?: string } | undefined)?.task_id === 'task-sub-1') {
          throw new Error('ProvisionedThroughputExceededException');
        }
        return snapshot(cmd);
      });
      await handler(eventWith(askForAFix()));
      const reply = expectAnsweredWithoutWork();
      expect(reply).toMatch(/couldn't read/);
      expect(reply).toMatch(/comment again/);
      expect(reply).not.toMatch(/no pull request, so/);
    });
  });

  describe('@bgagent on a sub-issue its epic has not started', () => {
    function expectOneNote(): string {
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(upsertStatusCommentMock).toHaveBeenCalledTimes(1);
      const [, issueId, body] = upsertStatusCommentMock.mock.calls[0];
      expect(issueId).toBe('sub-issue-1');
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'question');
      expect(isBotAuthoredComment(String(body))).toBe(true);
      return String(body);
    }

    test('a sub-issue waiting for its turn: says so, and does not say to re-apply the label', async () => {
      mockOrchWithChild({ subIssueId: 'sub-issue-1', childStatus: 'blocked' });
      await handler(eventWith(comment()));
      const note = expectOneNote();
      expect(note).toMatch(/hasn't started yet/);
      expect(note).not.toMatch(/trigger label/);
    });

    test('a sub-issue that did not run: points at the retry on the epic', async () => {
      mockOrchWithChild({ subIssueId: 'sub-issue-1', childStatus: 'skipped' });
      await handler(eventWith(comment()));
      const note = expectOneNote();
      expect(note).toMatch(/did not run/);
      expect(note).toContain('`@bgagent retry` on the epic');
      expect(note).not.toMatch(/trigger label/);
    });
  });

  test('@bgagent that does NOT resolve to an actionable iteration → no premature 👀 ack', async () => {
    mockOrchWithChild({ subIssueId: 'sub-issue-1' });
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reactToCommentMock).not.toHaveBeenCalled();
  });

  test('comment WITHOUT @bgagent → no task (ordinary discussion / agent progress comment)', async () => {
    await handler(eventWith(comment({ data: { id: 'c2', body: 'looks good to me!', issueId: 'sub-issue-1' } })));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(fetchIssueParentIdMock).not.toHaveBeenCalled();
  });

  test('@bgagent on an issue with no linked task → TELLS the user, does not drop it', async () => {
    mockStandaloneOnly(null);
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reactToCommentMock).not.toHaveBeenCalled();
    const posted = upsertStatusCommentMock.mock.calls.map((c) => String(c[2])).join('\n');
    expect(posted).toMatch(/don't have a task linked to this issue/i);
    expect(posted).toMatch(/re-apply this project's trigger label/i);
    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'question');
  });

  test('a FAILED issue→task lookup is not reported to the user as "not an ABCA issue"', async () => {
    fetchIssueParentIdMock.mockResolvedValue(LOOKUP_ABSENT);
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'LinearIssueIndex') {
        throw new Error('ProvisionedThroughputExceededException');
      }
      if (cmd._type === 'Get' && (cmd.input.Key as { linear_identity?: string })?.linear_identity) {
        return { Item: { platform_user_id: 'commenter-user', status: 'active' } };
      }
      return {};
    });
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    const posted = upsertStatusCommentMock.mock.calls.map((c) => String(c[2])).join('\n');
    expect(posted).toMatch(/couldn't look up/i);
    expect(posted).toMatch(/transient fault on my side/i);
    expect(posted).not.toMatch(/don't have a task linked/i);
  });

  test('@bgagent on a sub-issue whose parent is not an orchestration AND no ABCA task → no task', async () => {
    fetchIssueParentIdMock.mockResolvedValue(lookupFound('PARENT'));
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'LinearIssueIndex') return { Items: [] };
      return { Items: [] };
    });
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('an ABSENT parent (genuinely top-level) still falls through to the standalone path', async () => {
    fetchIssueParentIdMock.mockResolvedValue(LOOKUP_ABSENT);
    mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });

    await handler(eventWith(comment()));

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock.mock.calls[0][0].pr_number).toBe(99);
  });

  test('a FAILED parent lookup THROWS to earn a retry — no silent downgrade to standalone', async () => {
    const err = new Error('Linear issue-parent fetch returned HTTP 503');
    fetchIssueParentIdMock.mockResolvedValue(lookupFailed(err));
    mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });
    fetchIssueParentIdMock.mockResolvedValue(lookupFailed(err));

    await expect(handler(eventWith(comment()))).rejects.toThrow(err);

    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('@bgagent on an un-started sub-issue (no child_task_id) AND no ABCA task → no task', async () => {
    mockOrchWithChild({ subIssueId: 'sub-issue-1' });
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('an UNMAPPED commenter cannot drive a dispatch (❓ + reply, no task)', async () => {
    fetchIssueParentIdMock.mockResolvedValue(LOOKUP_ABSENT);
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'LinearIssueIndex') {
        return { Items: [{ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 }] };
      }
      return {};
    });
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'question');
  });

  test('the reply to an unmapped commenter is not itself a trigger when Linear delivers it back', async () => {
    fetchIssueParentIdMock.mockResolvedValue(LOOKUP_ABSENT);
    ddbSend.mockResolvedValue({});
    await handler(eventWith(comment()));
    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const reply = String(upsertThreadedReplyMock.mock.calls[0][3]);
    expect(reply).toContain('`@bgagent`');

    await handler(eventWith(comment({
      actor: { id: 'abca-app-user' },
      data: { id: 'reply-1', parentId: 'comment-1', body: reply, issueId: 'sub-issue-1' },
    })));

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    expect(reactToCommentMock).toHaveBeenCalledTimes(1);
  });

  test('bare @bgagent (no text) → falls back to a generic iteration instruction', async () => {
    mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', prUrl: 'https://github.com/o/r/pull/7' });
    await handler(eventWith(comment({ data: { id: 'c3', body: '@bgagent', issueId: 'sub-issue-1' } })));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock.mock.calls[0][0].task_description).toMatch(/latest review feedback/i);
  });

  describe('standalone (non-orchestration) @bgagent trigger', () => {
    test('plain issue with an ABCA PR → pr-iteration task, 👀 ack, trigger_comment_id but NO orchestration markers', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });
      await handler(eventWith(comment()));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [body, ctx] = createTaskCoreMock.mock.calls[0];
      expect(body.workflow_ref).toBe('coding/pr-iteration-v1');
      expect(body.pr_number).toBe(99);
      expect(body.repo).toBe('o/r');
      expect(ctx.userId).toBe('u-solo');
      expect(ctx.channelMetadata.trigger_comment_id).toBe('comment-1');
      expect(ctx.channelMetadata.linear_issue_id).toBe('sub-issue-1');
      expect(ctx.channelMetadata.orchestration_id).toBeUndefined();
      expect(ctx.channelMetadata.orchestration_iteration).toBeUndefined();
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'eyes');
    });

    // ADR-018 Phase 2: where sessions open, Linear opens one for this same mention.
    // Linear's "Agent session events" toggle is per installation, while the flag is stack-wide.
    describe('agent sessions enabled', () => {
      function workspaceSessions(seen: boolean): void {
        const base = ddbSend.getMockImplementation()!;
        ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) =>
          (cmd.input.ProjectionExpression === 'agent_sessions_seen_at'
            ? { Item: seen ? { agent_sessions_seen_at: '2026-11-20T00:00:00Z' } : {} }
            : base(cmd)));
      }
      function unlinkCommenter(): void {
        const base = ddbSend.getMockImplementation()!;
        ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) =>
          ((cmd.input.Key as { linear_identity?: string } | undefined)?.linear_identity ? {} : base(cmd)));
      }

      beforeEach(() => {
        process.env.LINEAR_AGENT_SESSIONS_ENABLED = 'true';
        resetSessionWorkspaceCacheForTests();
        mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });
      });
      afterEach(() => {
        delete process.env.LINEAR_AGENT_SESSIONS_ENABLED;
      });

      test('a workspace that delivers sessions → the standalone mention yields to the session path', async () => {
        workspaceSessions(true);
        await handler(eventWith(comment()));
        expect(createTaskCoreMock).not.toHaveBeenCalled();
        expect(reactToCommentMock).not.toHaveBeenCalled();
        expect(upsertThreadedReplyMock).not.toHaveBeenCalled();
      });

      test('a workspace that has never delivered a session → the comment trigger still answers', async () => {
        workspaceSessions(false);
        await handler(eventWith(comment()));
        expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
        expect(createTaskCoreMock.mock.calls[0][0].pr_number).toBe(99);
      });

      test('a registry read failure → the comment trigger still answers', async () => {
        const base = ddbSend.getMockImplementation()!;
        ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
          if (cmd.input.ProjectionExpression === 'agent_sessions_seen_at') throw new Error('throttled');
          return base(cmd);
        });
        await handler(eventWith(comment()));
        expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      });

      test('sessions delivered → an unlinked commenter gets no comment-path reply (the session tells them)', async () => {
        workspaceSessions(true);
        unlinkCommenter();
        await handler(eventWith(comment()));
        expect(reactToCommentMock).not.toHaveBeenCalled();
        expect(upsertThreadedReplyMock).not.toHaveBeenCalled();
        expect(createTaskCoreMock).not.toHaveBeenCalled();
      });

      test('no sessions delivered → an unlinked commenter is told to link, as with the flag off', async () => {
        workspaceSessions(false);
        unlinkCommenter();
        await handler(eventWith(comment()));
        expect(reactToCommentMock).toHaveBeenCalledTimes(1);
        expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
        expect(createTaskCoreMock).not.toHaveBeenCalled();
      });
    });

    test('plain issue resolves PR from pr_url when pr_number absent', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_url: 'https://github.com/o/r/pull/123' });
      await handler(eventWith(comment()));
      expect(createTaskCoreMock.mock.calls[0][0].pr_number).toBe(123);
    });

    test('PR-less task + instruction → fresh new-task-v1 on the same repo, 👀 ack, NO orchestration markers', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r' });
      await handler(eventWith(comment()));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [body, ctx] = createTaskCoreMock.mock.calls[0];
      expect(body.workflow_ref).toBe('coding/new-task-v1');
      expect(body.pr_number).toBeUndefined();
      expect(body.repo).toBe('o/r');
      expect(body.task_description).toBe('change the timeout to 30 min');
      expect(ctx.userId).toBe('u-solo');
      expect(ctx.channelMetadata.trigger_comment_id).toBe('comment-1');
      expect(ctx.channelMetadata.linear_issue_id).toBe('sub-issue-1');
      expect(ctx.channelMetadata.orchestration_id).toBeUndefined();
      expect(ctx.channelMetadata.orchestration_iteration).toBeUndefined();
      expect(ctx.idempotencyKey).toContain('newwork_');
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'eyes');
    });

    test('PR-less task still RUNNING → does NOT dispatch a parallel task, replies instead', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', status: 'RUNNING' });
      await handler(eventWith(comment()));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'eyes');
    });

    test('PR-less task in a TERMINAL state (COMPLETED) → new work IS dispatched', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', status: 'COMPLETED' });
      await handler(eventWith(comment()));
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      expect(createTaskCoreMock.mock.calls[0][0].workflow_ref).toBe('coding/new-task-v1');
    });

    describe('new work from a follow-up is given the issue, not only the comment', () => {
      function mockFinishedTaskWithDescription(description: string): void {
        mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', status: 'FAILED' });
        const indexOnly = ddbSend.getMockImplementation()!;
        ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => (
          (cmd.input.Key as { task_id?: string } | undefined)?.task_id === 'task-solo'
            ? { Item: { task_id: 'task-solo', workflow_ref: 'coding/new-task-v1', task_description: description } }
            : indexOnly(cmd)));
      }

      test('"@bgagent retry" on a failed issue runs the issue again, not the word "retry"', async () => {
        mockFinishedTaskWithDescription('ABC-42: Fix the login bug\n\nUsers cannot log in with SSO.');
        await handler(eventWith(comment({ data: { id: 'comment-1', body: '@bgagent retry', issueId: 'sub-issue-1' } })));

        expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
        const [body] = createTaskCoreMock.mock.calls[0];
        expect(body.workflow_ref).toBe('coding/new-task-v1');
        expect(body.task_description).toBe([
          'ABC-42: Fix the login bug',
          '',
          'Users cannot log in with SSO.',
          '',
          '---',
          'An earlier run on this issue ended without a pull request.',
          'The reviewer now asks: retry',
        ].join('\n'));
      });

      test('a first-run description at the size limit gives way to the follow-up', async () => {
        mockFinishedTaskWithDescription(`ABC-42: Fix the login bug\n\n${'x'.repeat(10_000 - 27)}`);
        await handler(eventWith(comment({ data: { id: 'comment-1', body: '@bgagent you missed the SAML case', issueId: 'sub-issue-1' } })));

        const description = String(createTaskCoreMock.mock.calls[0][0].task_description);
        expect(description.slice(0, 27)).toBe('ABC-42: Fix the login bug\n\n');
        expect(description.slice(-47)).toBe('The reviewer now asks: you missed the SAML case');
        expect(description).toHaveLength(10_000);
      });

      test('a follow-up on a resumed task keeps the question and the answer', async () => {
        const resumed = buildClarifyResumeDescription(
          `ABC-42: Fix the login bug\n\n${'x'.repeat(10_000 - 27)}`, 'Which environment?', 'staging',
        );
        mockFinishedTaskWithDescription(resumed);
        await handler(eventWith(comment({ data: { id: 'comment-1', body: '@bgagent retry', issueId: 'sub-issue-1' } })));

        const description = String(createTaskCoreMock.mock.calls[0][0].task_description);
        expect(description.slice(0, 27)).toBe('ABC-42: Fix the login bug\n\n');
        expect(description.slice(description.indexOf('\n\n---\n'))).toBe([
          '',
          '',
          '---',
          'This continues an earlier run that paused to ask a clarifying question.',
          'You asked: Which environment?',
          'The reviewer answered: staging',
          'Proceed with the original request using this answer.',
          '',
          '---',
          'An earlier run on this issue ended without a pull request.',
          'The reviewer now asks: retry',
        ].join('\n'));
        expect(description).toHaveLength(10_000);
      });

      test('a follow-up does not shorten exchanges that leave it no room', async () => {
        const first = buildClarifyResumeDescription(undefined, 'q'.repeat(2_000), 'a'.repeat(2_900));
        const resumed = buildClarifyResumeDescription(first, 'r'.repeat(2_000), 'b'.repeat(2_700));
        expect(resumed).toHaveLength(9_930);
        mockFinishedTaskWithDescription(resumed);
        await handler(eventWith(comment({ data: { id: 'comment-1', body: '@bgagent retry', issueId: 'sub-issue-1' } })));

        const description = String(createTaskCoreMock.mock.calls[0][0].task_description);
        expect(description.startsWith(`${resumed}\n\n---\n`)).toBe(true);
        expect(description.slice(-28)).toBe('The reviewer now asks: retry');
        expect(description).toHaveLength(10_023);
      });

      test('an answer to a question of the follow-up run keeps the follow-up request', async () => {
        mockFinishedTaskWithDescription(`ABC-42: Fix the login bug\n\n${'x'.repeat(10_000 - 27)}`);
        await handler(eventWith(comment({
          data: { id: 'comment-1', body: '@bgagent retry, but only the SAML part: skip OIDC', issueId: 'sub-issue-1' },
        })));
        const followUp = String(createTaskCoreMock.mock.calls[0][0].task_description);

        const resumed = buildClarifyResumeDescription(followUp, 'Which IdP?', 'Okta');
        expect(resumed.slice(resumed.indexOf('\n\n---\n'))).toBe([
          '',
          '',
          '---',
          'An earlier run on this issue ended without a pull request.',
          'The reviewer now asks: retry, but only the SAML part: skip OIDC',
          '',
          '---',
          'This continues an earlier run that paused to ask a clarifying question.',
          'You asked: Which IdP?',
          'The reviewer answered: Okta',
          'Proceed with the original request using this answer.',
        ].join('\n'));
        expect(resumed).toHaveLength(10_000);
      });

      test('a first-run row that cannot be read still starts the work, with the comment alone', async () => {
        mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', status: 'FAILED' });
        const indexOnly = ddbSend.getMockImplementation()!;
        ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
          if ((cmd.input.Key as { task_id?: string } | undefined)?.task_id === 'task-solo') {
            throw new Error('ProvisionedThroughputExceededException');
          }
          return indexOnly(cmd);
        });
        await handler(eventWith(comment()));

        expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
        expect(createTaskCoreMock.mock.calls[0][0].task_description).toBe('change the timeout to 30 min');
      });
    });

    test('PR-less task + BARE @bgagent (no instruction) → no task, but a threaded reply (not silent)', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r' });
      await handler(eventWith(comment({ data: { id: 'comment-1', body: '@bgagent', issueId: 'sub-issue-1' } })));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'eyes');
      expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    });

    test('the bare-mention reply is not itself a trigger when Linear delivers it back', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r' });
      await handler(eventWith(comment({ data: { id: 'comment-1', body: '@bgagent', issueId: 'sub-issue-1' } })));
      expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
      const reply = String(upsertThreadedReplyMock.mock.calls[0][3]);
      expect(reply).toContain('`@bgagent add a note to the README`');

      const linked = ddbSend.getMockImplementation()!;
      ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) =>
        ((cmd.input.Key as { linear_identity?: string } | undefined)?.linear_identity === 'org-1#abca-app-user' ? {} : linked(cmd)));
      await handler(eventWith(comment({
        actor: { id: 'abca-app-user' },
        data: { id: 'reply-1', parentId: 'comment-1', body: reply, issueId: 'sub-issue-1' },
      })));

      expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
      expect(reactToCommentMock).toHaveBeenCalledTimes(1);
      expect(createTaskCoreMock).not.toHaveBeenCalled();
    });

    test('PR-less task with NO repo → genuinely unactionable → no task, no ack', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo' });
      await handler(eventWith(comment()));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(reactToCommentMock).not.toHaveBeenCalled();
    });

    test('PR-less task missing user_id → cannot attribute → no task, no ack', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', repo: 'o/r' });
      await handler(eventWith(comment()));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(reactToCommentMock).not.toHaveBeenCalled();
    });

    test('plain issue task missing user_id (has PR) → cannot attribute → no task', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', repo: 'o/r', pr_number: 5 });
      await handler(eventWith(comment()));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
    });
  });

  describe('a comment whose task could not be created', () => {
    const BUDGET_REFUSAL = {
      statusCode: 429,
      body: JSON.stringify({
        error: {
          code: 'BUDGET_EXCEEDED',
          message: 'Your monthly budget is exhausted ($10.00 of $10.00). New tasks are disabled until the next UTC month.',
        },
      }),
    };

    function expectAckSettledAsFailed(reason: RegExp): void {
      expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(2);
      expect(String(upsertThreadedReplyMock.mock.calls[0][3])).toContain('On it');
      const [, issueId, parentCommentId, body, existingReplyId] = upsertThreadedReplyMock.mock.calls[1];
      expect(issueId).toBe('sub-issue-1');
      expect(parentCommentId).toBe('comment-1');
      expect(existingReplyId).toBe('reply-1');
      expect(String(body)).toMatch(reason);
      expect(replyToCommentMock).not.toHaveBeenCalled();
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'x');
    }

    test('an iteration refused for an exhausted budget says so, without the billed user\'s figures', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });
      createTaskCoreMock.mockResolvedValueOnce(BUDGET_REFUSAL);
      await handler(eventWith(comment()));
      expect(createTaskCoreMock.mock.calls[0][1].userId).toBe('u-solo');
      expectAckSettledAsFailed(/monthly budget is exhausted for the user or team/);
      expect(String(upsertThreadedReplyMock.mock.calls[1][3])).not.toMatch(/\$10\.00|Your monthly budget/);
    });

    test('a refusal for a team budget does not name the team or its figures either', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 429,
        body: JSON.stringify({
          error: {
            code: 'BUDGET_EXCEEDED',
            message: "The monthly budget for team 'platform-eng' is exhausted ($250.00 of $250.00). New tasks are disabled until the next UTC month.",
          },
        }),
      });
      await handler(eventWith(comment()));
      expectAckSettledAsFailed(/monthly budget is exhausted for the user or team/);
      expect(String(upsertThreadedReplyMock.mock.calls[1][3])).not.toMatch(/platform-eng|\$/);
    });

    test('an iteration that createTaskCore threw on is settled too', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });
      createTaskCoreMock.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));
      await handler(eventWith(comment()));
      expectAckSettledAsFailed(/hit an error and couldn't start this/);
    });

    test('when the "On it" reply never landed, the reason is posted as a reply of its own', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });
      upsertThreadedReplyMock.mockResolvedValueOnce(null);
      createTaskCoreMock.mockResolvedValueOnce(BUDGET_REFUSAL);
      await handler(eventWith(comment()));

      expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(2);
      const [, issueId, parentCommentId, body, existingReplyId] = upsertThreadedReplyMock.mock.calls[1];
      expect(issueId).toBe('sub-issue-1');
      expect(parentCommentId).toBe('comment-1');
      expect(existingReplyId).toBeUndefined();
      expect(String(body)).toMatch(/monthly budget is exhausted/);
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'x');
    });

    test('an idempotent replay (200) is not a refusal: the first delivery\'s task owns the reply', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });
      createTaskCoreMock.mockResolvedValueOnce({ statusCode: 200, body: JSON.stringify({ data: { task_id: 'T1' } }) });
      await handler(eventWith(comment()));
      expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
      expect(swapCommentReactionMock).not.toHaveBeenCalled();
    });

    test('a refused iteration of an orchestration sub-issue is settled as well', async () => {
      mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', prUrl: 'https://github.com/o/r/pull/42' });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 400,
        body: JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Task description was blocked by content policy.' } }),
      });
      await handler(eventWith(comment()));
      expectAckSettledAsFailed(/blocked by content policy/);
    });

    test('refused new work on a PR-less issue says to comment again, not to re-apply the label', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', status: 'FAILED' });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 503,
        body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Content screening is temporarily unavailable. Please try again later.' } }),
      });
      await handler(eventWith(comment()));
      expect(createTaskCoreMock.mock.calls[0][0].workflow_ref).toBe('coding/new-task-v1');
      expectAckSettledAsFailed(/temporarily unavailable \(status 503\)/);
      const body = String(upsertThreadedReplyMock.mock.calls[1][3]);
      expect(body).toMatch(/re-comment/);
      expect(body).not.toMatch(/trigger label/);
    });

    test('a refused clarify-resume is settled as well', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', status: 'COMPLETED' });
      const indexOnly = ddbSend.getMockImplementation()!;
      ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => (
        (cmd.input.Key as { task_id?: string } | undefined)?.task_id === 'task-solo'
          ? { Item: { workflow_ref: 'coding/new-task-v1', code_changed: false, answer_text: 'Which environment?', task_description: 'ABC-42: Deploy it' } }
          : indexOnly(cmd)));
      createTaskCoreMock.mockResolvedValueOnce(BUDGET_REFUSAL);
      await handler(eventWith(comment({ data: { id: 'comment-1', body: '@bgagent staging', issueId: 'sub-issue-1' } })));
      expect(createTaskCoreMock.mock.calls[0][0].task_description).toContain('The reviewer answered: staging');
      expectAckSettledAsFailed(/monthly budget is exhausted/);
    });

    test('a file in the comment that cannot be screened turns the "On it" reply into the reason', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });
      await handler(eventWith(comment({
        data: { id: 'comment-1', body: '@bgagent still broken, see ![shot](https://uploads.linear.app/a/b/c)', issueId: 'sub-issue-1' },
      })));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expectAckSettledAsFailed(/attachment screening is not configured/);
    });
  });

  describe('parent-epic @bgagent comment routing', () => {
    function mockParentEpic(
      parentIssueId: string,
      moreChildren: Array<Record<string, unknown>> = [],
      moreMeta: Record<string, unknown> = {},
    ): void {
      const meta = {
        sub_issue_id: '#meta',
        orchestration_id: 'orch_x',
        parent_linear_issue_id: parentIssueId,
        linear_workspace_id: 'org-1',
        repo: 'o/r',
        child_count: 2,
        platform_user_id: 'release-user',
        ...moreMeta,
      };
      const footer = {
        orchestration_id: 'orch_x',
        sub_issue_id: 'sub-footer',
        depends_on: [],
        child_status: 'succeeded',
        repo: 'o/r',
        parent_linear_issue_id: parentIssueId,
        linear_workspace_id: 'org-1',
        linear_identifier: 'ABCA-305',
        title: 'Add a site-wide footer',
        child_task_id: 'task-footer',
      };
      const news = {
        orchestration_id: 'orch_x',
        sub_issue_id: 'sub-news',
        depends_on: [],
        child_status: 'succeeded',
        repo: 'o/r',
        parent_linear_issue_id: parentIssueId,
        linear_workspace_id: 'org-1',
        linear_identifier: 'ABCA-306',
        title: 'Add a newsletter signup section',
        child_task_id: 'task-news',
      };
      const claimedAcks = new Set<string>();
      ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
        if (cmd._type === 'Update') {
          const sk = (cmd.input.Key as { sub_issue_id?: string })?.sub_issue_id ?? '';
          if (sk.startsWith('ack#')) {
            if (claimedAcks.has(sk)) {
              throw Object.assign(new Error('claim exists'), { name: 'ConditionalCheckFailedException' });
            }
            claimedAcks.add(sk);
          }
          return {};
        }
        if (cmd._type === 'Query' && cmd.input.IndexName === 'LinearIssueIndex') return { Items: [] };
        if (cmd._type === 'Query') return { Items: [meta, footer, news, ...moreChildren] };
        if (cmd._type === 'Get') {
          const key = cmd.input.Key as { task_id?: string; sub_issue_id?: string; linear_identity?: string };
          if (key.linear_identity) return { Item: { platform_user_id: 'commenter-user', status: 'active' } };
          const tid = key.task_id;
          const pr = tid === 'task-footer' ? 193 : tid === 'task-news' ? 192 : null;
          return { Item: pr ? { pr_number: pr } : {} };
        }
        return {};
      });
    }

    function mockParentEpicWithIntegration(parentIssueId: string): void {
      const base = {
        orchestration_id: 'orch_x',
        depends_on: [] as string[],
        child_status: 'succeeded',
        repo: 'o/r',
        parent_linear_issue_id: parentIssueId,
        linear_workspace_id: 'org-1',
      };
      const meta = {
        orchestration_id: 'orch_x',
        sub_issue_id: '#meta',
        parent_linear_issue_id: parentIssueId,
        linear_workspace_id: 'org-1',
        repo: 'o/r',
        child_count: 3,
        platform_user_id: 'u1',
        status_comment_id: 'panel-1',
      };
      const api = { ...base, sub_issue_id: 'sub-api', linear_identifier: 'ABCA-305', title: 'Add the booking API', child_task_id: 'task-api' };
      const ui = { ...base, sub_issue_id: 'sub-ui', linear_identifier: 'ABCA-306', title: 'Add the booking form', child_task_id: 'task-ui' };
      const integration = {
        ...base,
        sub_issue_id: 'orch_x__integration',
        depends_on: ['sub-api', 'sub-ui'],
        title: 'Integration — combine sub-issue results',
        child_task_id: 'task-int',
      };
      const claimedAcks = new Set<string>();
      ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
        if (cmd._type === 'Update') {
          const sk = (cmd.input.Key as { sub_issue_id?: string })?.sub_issue_id ?? '';
          if (sk.startsWith('ack#')) {
            if (claimedAcks.has(sk)) {
              throw Object.assign(new Error('claim exists'), { name: 'ConditionalCheckFailedException' });
            }
            claimedAcks.add(sk);
          }
          return {};
        }
        if (cmd._type === 'Query' && cmd.input.IndexName === 'LinearIssueIndex') return { Items: [] };
        if (cmd._type === 'Query') return { Items: [meta, api, ui, integration] };
        if (cmd._type === 'Get') {
          const key = cmd.input.Key as { task_id?: string; linear_identity?: string };
          if (key.linear_identity) return { Item: { platform_user_id: 'commenter-user', status: 'active' } };
          const pr = key.task_id === 'task-api' ? 557 : key.task_id === 'task-ui' ? 558 : key.task_id === 'task-int' ? 560 : null;
          return { Item: pr ? { pr_number: pr } : {} };
        }
        return {};
      });
    }

    function parentComment(body: string, id = 'pc-1'): Record<string, unknown> {
      return {
        type: 'Comment',
        action: 'create',
        organizationId: 'org-1',
        actor: { id: 'user-9' },
        data: { id, body, issueId: 'PARENT-EPIC' },
      };
    }

    test('@bgagent integration: … iterates the COMBINED PR, not a child PR', async () => {
      mockParentEpicWithIntegration('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent integration: the dates come back empty for Kyoto')));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [body, ctx] = createTaskCoreMock.mock.calls[0];
      expect(body.workflow_ref).toBe('coding/pr-iteration-v1');
      expect(body.pr_number).toBe(560);
      expect(ctx.channelMetadata.orchestration_sub_issue_id).toBe('orch_x__integration');
      expect(body.task_description).toContain('COMBINED branch');
      expect(body.task_description).toContain('REPRODUCE');
      expect(body.task_description).toContain('are NOT evidence');
    });

    test('"combined" reaches the integration PR too — the word the panel shows', async () => {
      mockParentEpicWithIntegration('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent the combined result 404s on submit')));
      expect(createTaskCoreMock.mock.calls[0][0].pr_number).toBe(560);
    });

    test('Linear feedback uses the PARENT issue id, never the synthetic node id', async () => {
      mockParentEpicWithIntegration('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent integration: dates are empty')));
      const ctx = createTaskCoreMock.mock.calls[0][1];
      expect(ctx.channelMetadata.trigger_comment_issue_id).toBe('PARENT-EPIC');
      expect(ctx.channelMetadata.linear_issue_id).toBe('PARENT-EPIC');
      expect(ctx.channelMetadata.linear_issue_id).not.toContain('__integration');
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'eyes');
    });

    test('a redelivered integration comment creates ONE iteration, not two', async () => {
      mockParentEpicWithIntegration('PARENT-EPIC');
      const evt = eventWith(parentComment('@bgagent integration: dates are empty', 'pc-dup'));
      await handler(evt);
      await handler(evt);
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    });

    test('the disambiguation reply offers integration ONLY when the node exists', async () => {
      mockParentEpicWithIntegration('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent please fix the thing')));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const withInt = String(replyToCommentMock.mock.calls[0][3]);
      expect(withInt).toContain('@bgagent integration: <request>');

      jest.clearAllMocks();
      mockParentEpic('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent please fix the thing', 'pc-2')));
      const noInt = String(replyToCommentMock.mock.calls[0][3]);
      expect(noInt).not.toMatch(/integration/i);
    });

    test('a natural-language target on the epic ("for the footer ...") → iterates that sub-issue\'s PR', async () => {
      mockParentEpic('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent for the footer can you change it to "unforgettable memories await you"')));

      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'eyes');
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [body, ctx] = createTaskCoreMock.mock.calls[0];
      expect(body.workflow_ref).toBe('coding/pr-iteration-v1');
      expect(body.pr_number).toBe(193);
      expect(ctx.channelMetadata.orchestration_sub_issue_id).toBe('sub-footer');
      expect(ctx.channelMetadata.orchestration_iteration).toBe('true');
      expect(ctx.channelMetadata.linear_issue_id).toBe('sub-footer');
      // Linear rejects a threaded reply whose parent comment belongs to a different issue.
      expect(ctx.channelMetadata.trigger_comment_issue_id).toBe('PARENT-EPIC');
      expect(ctx.channelMetadata.trigger_comment_id).toBe('pc-1');
      expect(replyToCommentMock).not.toHaveBeenCalled();
    });

    test('targeting by Linear identifier on the epic → iterates that node', async () => {
      mockParentEpic('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent ABCA-306 tweak the newsletter copy')));
      expect(createTaskCoreMock.mock.calls[0][0].pr_number).toBe(192);
      expect(createTaskCoreMock.mock.calls[0][1].channelMetadata.orchestration_sub_issue_id).toBe('sub-news');
    });

    test('ambiguous comment on the epic → 👀 + a "which sub-issue?" reply, NO task, NO new issue', async () => {
      mockParentEpic('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent please update the copy')));
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'eyes');
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(replyToCommentMock).toHaveBeenCalledTimes(1);
      const [, issueId, , replyBody] = replyToCommentMock.mock.calls[0];
      expect(issueId).toBe('PARENT-EPIC');
      expect(replyBody).toContain('ABCA-305');
      expect(replyBody).toContain('ABCA-306');
      expect(replyBody.toLowerCase()).toContain('new work');
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'question');
    });

    test('no-match comment on the epic → 👀 + reply (never a silent drop), no task', async () => {
      mockParentEpic('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent looks great, ship it')));
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'eyes');
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(replyToCommentMock).toHaveBeenCalledTimes(1);
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'question');
    });

    test('new work asked for on the epic → the reply names the label this project triggers on', async () => {
      mockParentEpic('PARENT-EPIC', [], { trigger_label: 'ship-it' });
      await handler(eventWith(parentComment('@bgagent add a changelog page')));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const replyBody = String(replyToCommentMock.mock.calls[0][3]);
      expect(replyBody).toContain('create a new sub-issue under this epic, then remove and re-apply the `ship-it` label on this epic');
      expect(replyBody).not.toContain('abca');
    });

    test('a FAILED sub-issue PR read ANSWERS the user and flips 👀 → ❓ (never a permanent 👀)', async () => {
      mockParentEpic('PARENT-EPIC');
      const epicImpl = ddbSend.getMockImplementation()!;
      ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
        const key = cmd.input.Key as { task_id?: string } | undefined;
        if (cmd._type === 'Get' && key?.task_id === 'task-footer') {
          throw new Error('ProvisionedThroughputExceededException');
        }
        return epicImpl(cmd);
      });

      await handler(eventWith(parentComment('@bgagent for the footer change the tagline', 'pc-prfail')));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(replyToCommentMock).toHaveBeenCalledTimes(1);
      const [, issueId, , replyBody] = replyToCommentMock.mock.calls[0];
      expect(issueId).toBe('PARENT-EPIC');
      expect(String(replyBody)).toMatch(/couldn't read/i);
      expect(String(replyBody)).toMatch(/comment again/i);
      expect(String(replyBody)).not.toMatch(/nothing to iterate/i);
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'pc-prfail', 'question');
    });

    describe('a comment on the epic that names one sub-issue which has no pull request', () => {
      function mockEpicWithUploads(row: Record<string, unknown>, moreMeta: Record<string, unknown> = {}): void {
        mockParentEpic('PARENT-EPIC', [{
          orchestration_id: 'orch_x',
          sub_issue_id: 'sub-uploads',
          depends_on: ['sub-footer'],
          repo: 'o/r',
          parent_linear_issue_id: 'PARENT-EPIC',
          linear_workspace_id: 'org-1',
          linear_identifier: 'ABCA-307',
          title: 'Add retries to uploads',
          ...row,
        }], moreMeta);
      }

      function expectStateOfNamedSubIssue(name = 'ABCA-307'): string {
        expect(createTaskCoreMock).not.toHaveBeenCalled();
        expect(upsertThreadedReplyMock).not.toHaveBeenCalled();
        expect(replyToCommentMock).toHaveBeenCalledTimes(1);
        const [, issueId, parentCommentId, body] = replyToCommentMock.mock.calls[0];
        expect(issueId).toBe('PARENT-EPIC');
        expect(parentCommentId).toBe('pc-1');
        expect(String(body)).toContain(`**${name}**`);
        expect(String(body)).not.toMatch(/couldn't tell|Did you mean/);
        expect(isBotAuthoredComment(String(body))).toBe(true);
        expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'question');
        return String(body);
      }

      test('a sub-issue the epic has not started: says so, and offers no other sub-issue', async () => {
        mockEpicWithUploads({ child_status: 'blocked' });
        await handler(eventWith(parentComment('@bgagent ABCA-307: keep the retry notice out of the footer')));
        const reply = expectStateOfNamedSubIssue();
        expect(reply).toMatch(/hasn't started yet/);
        expect(reply).not.toContain('ABCA-305');
      });

      test('a sub-issue that was skipped: says it did not run, and how to re-run', async () => {
        mockEpicWithUploads({ child_status: 'skipped' });
        await handler(eventWith(parentComment('@bgagent ABCA-307: use the new API client')));
        const reply = expectStateOfNamedSubIssue();
        expect(reply).toMatch(/did not run/);
        expect(reply).toContain('`@bgagent retry`');
      });

      test('a started sub-issue without a pull request: says so, whether or not its run has ended', async () => {
        mockEpicWithUploads({ child_status: 'released', child_task_id: 'task-uploads' });
        await handler(eventWith(parentComment('@bgagent ABCA-307: use a darker blue')));
        const reply = expectStateOfNamedSubIssue();
        expect(reply).toMatch(/no pull request, so there's nothing to iterate on/);
        expect(reply).not.toMatch(/\byet\b/);
        expect(reply).toMatch(/If its run is still in progress, comment again once it has opened one/);
      });

      test.each([
        ['with a task that opened no pull request', { child_task_id: 'task-uploads' }],
        ['before it became a task', {}],
      ])('a sub-issue that failed %s: points at the retry', async (_when, row) => {
        mockEpicWithUploads({ child_status: 'failed', ...row });
        await handler(eventWith(parentComment('@bgagent ABCA-307: use a darker blue')));
        const reply = expectStateOfNamedSubIssue();
        expect(reply).toMatch(/failed before opening a PR/);
        expect(reply).toContain('`@bgagent retry`');
        expect(reply).toContain('remove and re-apply the `bgagent` label');
      });

      test('a sub-issue that failed: the label to re-apply is the one this project triggers on', async () => {
        mockEpicWithUploads({ child_status: 'failed' }, { trigger_label: 'ship-it' });
        await handler(eventWith(parentComment('@bgagent ABCA-307: use a darker blue')));
        const reply = expectStateOfNamedSubIssue();
        expect(reply).toContain('remove and re-apply the `ship-it` label');
        expect(reply).not.toContain('abca');
      });

      test('the combined result, before it has started: named by its title, never by its internal id', async () => {
        mockParentEpic('PARENT-EPIC', [{
          orchestration_id: 'orch_x',
          sub_issue_id: 'orch_x__integration',
          depends_on: ['sub-footer', 'sub-news'],
          child_status: 'blocked',
          repo: 'o/r',
          parent_linear_issue_id: 'PARENT-EPIC',
          linear_workspace_id: 'org-1',
          title: 'Integration — combine sub-issue results',
        }]);
        await handler(eventWith(parentComment('@bgagent integration: the dates come back empty')));
        const reply = expectStateOfNamedSubIssue('Integration — combine sub-issue results');
        expect(reply).toMatch(/hasn't started yet/);
        expect(reply).not.toContain('__integration');
      });
    });

    test('webhook REDELIVERY of the same parent comment posts EXACTLY ONE reply (no spam)', async () => {
      mockParentEpic('PARENT-EPIC');
      const evt = eventWith(parentComment('@bgagent looks great, ship it', 'pc-dup'));
      await handler(evt);
      await handler(evt);
      await handler(evt);
      expect(replyToCommentMock).toHaveBeenCalledTimes(1);
      expect(reactToCommentMock).toHaveBeenCalledTimes(1);
    });

    test('a matched-iteration parent comment also dedups under redelivery (one task, one ack)', async () => {
      mockParentEpic('PARENT-EPIC');
      const evt = eventWith(parentComment('@bgagent for the footer change the tagline', 'pc-iter'));
      await handler(evt);
      await handler(evt);
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      expect(reactToCommentMock).toHaveBeenCalledTimes(1);
    });

    function mockFailedEpic(parentIssueId: string): void {
      const meta = {
        sub_issue_id: '#meta',
        orchestration_id: 'orch_f',
        parent_linear_issue_id: parentIssueId,
        linear_workspace_id: 'org-1',
        repo: 'o/r',
        child_count: 2,
        platform_user_id: 'release-user',
        release_context: { platform_user_id: 'release-user' },
      };
      const ok = {
        orchestration_id: 'orch_f',
        sub_issue_id: 'sub-ok',
        depends_on: [],
        child_status: 'succeeded',
        repo: 'o/r',
        parent_linear_issue_id: parentIssueId,
        linear_workspace_id: 'org-1',
        linear_identifier: 'ABCA-1',
        title: 'Step A',
        child_task_id: 'task-ok',
      };
      const bad = {
        orchestration_id: 'orch_f',
        sub_issue_id: 'sub-bad',
        depends_on: [],
        child_status: 'failed',
        repo: 'o/r',
        parent_linear_issue_id: parentIssueId,
        linear_workspace_id: 'org-1',
        linear_identifier: 'ABCA-2',
        title: 'Step B',
        child_task_id: 'task-bad-1',
      };
      const claimedAcks = new Set<string>();
      ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
        if (cmd._type === 'Update') {
          const sk = (cmd.input.Key as { sub_issue_id?: string })?.sub_issue_id ?? '';
          if (sk.startsWith('ack#') || sk.startsWith('retry:') || sk === '#rollup-claim') {
            if (claimedAcks.has(sk)) {
              throw Object.assign(new Error('claim exists'), { name: 'ConditionalCheckFailedException' });
            }
            claimedAcks.add(sk);
          }
          const row = [ok, bad].find((r) => r.sub_issue_id === sk);
          if (row && (cmd.input.ExpressionAttributeNames as Record<string, string> | undefined)?.['#title']) {
            const values = cmd.input.ExpressionAttributeValues as Record<string, unknown>;
            Object.assign(row, { title: values[':title'], description: values[':description'] });
          }
          return {};
        }
        if (cmd._type === 'Query' && cmd.input.IndexName === 'LinearIssueIndex') return { Items: [] };
        if (cmd._type === 'Query') return { Items: [meta, ok, bad] };
        if (cmd._type === 'Get') {
          const key = cmd.input.Key as { task_id?: string; linear_identity?: string };
          if (key.linear_identity) return { Item: { platform_user_id: 'commenter-user', status: 'active' } };
          return { Item: {} };
        }
        return {};
      });
    }

    test('"@bgagent retry" on a failed epic re-runs the failed child (NOT disambiguation)', async () => {
      mockFailedEpic('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent retry', 'pc-retry')));
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'pc-retry', 'eyes');
      expect(replyToCommentMock).not.toHaveBeenCalled();
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [, ctx] = createTaskCoreMock.mock.calls[0];
      expect(ctx.idempotencyKey).toContain('task-bad-1');
    });

    describe('"@bgagent retry" reads the sub-issues of the epic again first', () => {
      const textWrites = (): Array<string | undefined> => ddbSend.mock.calls
        .map((c) => c[0] as { _type?: string; input: { Key?: { sub_issue_id?: string }; ExpressionAttributeNames?: Record<string, string> } })
        .filter((cmd) => cmd._type === 'Update' && cmd.input.ExpressionAttributeNames?.['#title'] === 'title')
        .map((cmd) => cmd.input.Key?.sub_issue_id);

      test('a failed sub-issue that was reworded is started with the text it has now', async () => {
        mockFailedEpic('PARENT-EPIC');
        fetchSubIssueGraphMock.mockResolvedValue({
          kind: 'ok',
          parentIssueId: 'PARENT-EPIC',
          children: [
            { id: 'sub-ok', depends_on: [], identifier: 'ABCA-1', title: 'Step A, reworded as well' },
            { id: 'sub-bad', depends_on: [], identifier: 'ABCA-2', title: 'Step B, reworded', description: 'Without the phrase that was refused.' },
          ],
        });
        await handler(eventWith(parentComment('@bgagent retry', 'pc-retry')));

        expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
        expect(createTaskCoreMock.mock.calls[0][0].task_description)
          .toBe('ABCA-2: Step B, reworded\n\nWithout the phrase that was refused.');
        expect(fetchSubIssueGraphMock).toHaveBeenCalledWith('tok', 'PARENT-EPIC', undefined);
        expect(textWrites()).toEqual(['sub-bad']);
      });

      test('sub-issues that cannot be read do not hold the retry up: it sends the stored text', async () => {
        mockFailedEpic('PARENT-EPIC');
        fetchSubIssueGraphMock.mockResolvedValue({ kind: 'error', message: 'Could not reach the Linear API to read sub-issues.' });
        await handler(eventWith(parentComment('@bgagent retry', 'pc-retry')));

        expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
        expect(createTaskCoreMock.mock.calls[0][0].task_description).toBe('ABCA-2: Step B');
        expect(textWrites()).toEqual([]);
        expect(replyToCommentMock).not.toHaveBeenCalled();
      });
    });

    test('"@bgagent retry" on an all-succeeded epic replies "nothing to retry", no task', async () => {
      mockParentEpic('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent retry', 'pc-retry-2')));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(replyToCommentMock).toHaveBeenCalledTimes(1);
      const [, , , replyBody] = replyToCommentMock.mock.calls[0];
      expect(String(replyBody).toLowerCase()).toContain('nothing to retry');
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'pc-retry-2', 'question');
    });

    test('a refused iteration routed from the epic is settled on the epic, where the comment lives', async () => {
      mockParentEpic('PARENT-EPIC');
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 429,
        body: JSON.stringify({ error: { code: 'BUDGET_EXCEEDED', message: 'Your monthly budget is exhausted ($10.00 of $10.00).' } }),
      });
      await handler(eventWith(parentComment('@bgagent for the footer change the tagline', 'pc-refused')));

      expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(2);
      const [, issueId, parentCommentId, body, existingReplyId] = upsertThreadedReplyMock.mock.calls[1];
      expect(issueId).toBe('PARENT-EPIC');
      expect(parentCommentId).toBe('pc-refused');
      expect(existingReplyId).toBe('reply-1');
      expect(String(body)).toMatch(/monthly budget is exhausted/);
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'pc-refused', 'x');
    });
  });
});
