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
 * Tests the #247 Mode A orchestration routing in the Linear webhook
 * processor — the env-var-gated branch that, when ORCHESTRATION_TABLE_NAME
 * is set and a workspace token resolves, probes the labeled parent issue
 * for a sub-issue graph and routes accordingly:
 *   seeded → no parent task (reconciler owns children)
 *   single_task → falls through to the normal one-issue→one-task path
 *   rejected/error → terminal ❌ comment, no task
 *
 * Kept separate from linear-webhook-processor.test.ts because the env
 * var is read at module-eval time; this file enables it, the sibling
 * file leaves it unset (proving the path is dormant by default).
 * discoverOrchestration is mocked — its internals are covered by
 * orchestration-discovery.test.ts.
 */

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  BatchWriteCommand: jest.fn((input: unknown) => ({ _type: 'BatchWrite', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

const reportIssueFailureMock = jest.fn();
const swapIssueReactionMock = jest.fn();
const transitionIssueStateMock = jest.fn();
const upsertStatusCommentMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  reportIssueFailure: (...args: unknown[]) => reportIssueFailureMock(...args),
  swapIssueReaction: (...args: unknown[]) => swapIssueReactionMock(...args),
  transitionIssueState: (...args: unknown[]) => transitionIssueStateMock(...args),
  upsertStatusComment: (...args: unknown[]) => upsertStatusCommentMock(...args),
  EMOJI_STARTED: 'eyes',
  EMOJI_SUCCESS: 'white_check_mark',
  EMOJI_FAILURE: 'x',
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
jest.mock('../../src/handlers/shared/linear-subissue-fetch', () => ({
  fetchIssueParentId: (...args: unknown[]) => fetchIssueParentIdMock(...args),
}));

process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'LinearProjects';
process.env.LINEAR_USER_MAPPING_TABLE_NAME = 'LinearUsers';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
process.env.TASK_TABLE_NAME = 'TaskTable';
// Enable the orchestration path for this file (sibling file leaves it unset).
process.env.ORCHESTRATION_TABLE_NAME = 'OrchestrationTable';

import { handler } from '../../src/handlers/linear-webhook-processor';

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

/** Wire the common preamble: onboarded project, linked user, resolved token. */
function happyPreamble(): void {
  ddbSend
    // 1: project mapping lookup → onboarded + active
    .mockResolvedValueOnce({ Item: { status: 'active', repo: 'owner/repo', label_filter: 'bgagent' } })
    // 2: user mapping lookup → linked platform user
    .mockResolvedValueOnce({ Item: { platform_user_id: 'platform-user-1' } });
  resolveLinearOauthTokenMock.mockResolvedValue({
    accessToken: 'access-tok',
    oauthSecretArn: 'arn:secret',
    workspaceSlug: 'acme',
  });
}

describe('linear-webhook-processor — #247 orchestration routing', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset();
    // Default: release path (now exercised in the seed test) returns a created task.
    createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'child-task' } }) });
    reportIssueFailureMock.mockReset();
    reportIssueFailureMock.mockResolvedValue(undefined);
    resolveLinearOauthTokenMock.mockReset();
    discoverOrchestrationMock.mockReset();
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    upsertStatusCommentMock.mockReset().mockResolvedValue('cmt-status-1');
    fetchIssueParentIdMock.mockReset();
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
    // After seeding, the handler loads the orchestration (Query) to release
    // roots + post the initial panel. Return a real snapshot so the panel path
    // runs (mirrors the parent start signal). All Query calls return it.
    ddbSend.mockResolvedValue({ Items: [
      { sub_issue_id: '#meta', orchestration_id: 'orch_abc', parent_linear_issue_id: 'issue-1',
        linear_workspace_id: 'org-1', repo: 'owner/repo', platform_user_id: 'u1' },
      { sub_issue_id: 'A', orchestration_id: 'orch_abc', depends_on: [], child_status: 'ready',
        parent_linear_issue_id: 'issue-1', linear_workspace_id: 'org-1', repo: 'owner/repo' },
    ] });

    await handler(eventWith(issue()));

    expect(discoverOrchestrationMock).toHaveBeenCalledTimes(1);
    expect(reportIssueFailureMock).not.toHaveBeenCalled();
    // The parent issue itself spawns no task FROM the single-task path — but
    // releasing root A does call createTaskCore once (for the child). It must
    // NOT be called with the parent's task_description (the single-task body).
    const calledWithParentBody = createTaskCoreMock.mock.calls.some(
      (c) => (c[0] as { task_description?: string }).task_description?.includes('Epic: ship the thing'));
    expect(calledWithParentBody).toBe(false);
    // #247 UX.2: the initial panel is posted (upsertStatusComment) and the
    // parent start signal mirrored — 👀 reaction + In Progress — via upsertEpicPanel.
    expect(upsertStatusCommentMock).toHaveBeenCalled();
    expect(swapIssueReactionMock).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'eyes');
    expect(transitionIssueStateMock).toHaveBeenCalledWith(
      expect.anything(), expect.any(String), 'started', ['In Progress'],
    );
  });

  test('seeded → posts the live status block on the parent + stamps its id (#3)', async () => {
    // project + user lookups (preamble)
    ddbSend
      .mockResolvedValueOnce({ Item: { status: 'active', repo: 'owner/repo', label_filter: 'bgagent' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'u1' } });
    resolveLinearOauthTokenMock.mockResolvedValue({ accessToken: 'tok', oauthSecretArn: 'arn', workspaceSlug: 'acme' });
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'seeded', orchestrationId: 'orch_abc', childCount: 1, rootSubIssueIds: ['A'], alreadyExisted: false,
    });
    // Every subsequent Query (release-path load + post-release status load)
    // returns a snapshot with a meta row + one child; Updates (release flip,
    // setStatusCommentId) return {}.
    const snapshotItems = {
      Items: [
        { sub_issue_id: '#meta', orchestration_id: 'orch_abc', parent_linear_issue_id: 'issue-1', linear_workspace_id: 'org-1', repo: 'owner/repo', child_count: 1, platform_user_id: 'u1' },
        { sub_issue_id: 'A', orchestration_id: 'orch_abc', parent_linear_issue_id: 'issue-1', linear_workspace_id: 'org-1', repo: 'owner/repo', depends_on: [], child_status: 'released', linear_identifier: 'ABCA-1', title: 'Step A' },
      ],
    };
    ddbSend.mockResolvedValue(snapshotItems);

    await handler(eventWith(issue()));

    // Status block posted (no existing id → create) and its id stamped back.
    expect(upsertStatusCommentMock).toHaveBeenCalledTimes(1);
    const [, parentArg, bodyArg, existingId] = upsertStatusCommentMock.mock.calls[0];
    expect(parentArg).toBe('issue-1');
    expect(bodyArg).toContain('ABCA orchestration');
    expect(existingId).toBeUndefined(); // create, not edit
    // setStatusCommentId issues an Update with the returned comment id.
    const stampUpdate = ddbSend.mock.calls.map((c) => c[0]?.input).find((i) => i?.UpdateExpression?.includes('status_comment_id'));
    expect(stampUpdate?.ExpressionAttributeValues?.[':cid']).toBe('cmt-status-1');
  });

  test('seeded on idempotent replay → no duplicate start signal on parent', async () => {
    happyPreamble();
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'seeded',
      orchestrationId: 'orch_abc',
      childCount: 3,
      rootSubIssueIds: ['A'],
      alreadyExisted: true, // replay
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    await handler(eventWith(issue()));

    // alreadyExisted ⇒ skip the start reaction/transition (already done on first seed).
    expect(swapIssueReactionMock).not.toHaveBeenCalled();
    expect(transitionIssueStateMock).not.toHaveBeenCalled();
  });

  test('no sub-issues → single_task falls through to normal task creation', async () => {
    happyPreamble();
    discoverOrchestrationMock.mockResolvedValueOnce({ kind: 'single_task', parentLinearIssueId: 'issue-1' });
    createTaskCoreMock.mockResolvedValueOnce({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }) });

    await handler(eventWith(issue()));

    expect(discoverOrchestrationMock).toHaveBeenCalledTimes(1);
    // Falls through → a single task is created as today.
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
    // reportIssueFailure(ctx, issueId, message)
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
    // When the registry table is configured but the workspace token does
    // not resolve, the handler drops the event (added in #200) rather than
    // creating a task against a workspace ABCA can't recognize — outbound
    // Linear comments would silently skip and we'd burn agent quota for no
    // observable result. So neither orchestration NOR a single task fires.
    resolveLinearOauthTokenMock.mockResolvedValue(null);

    await handler(eventWith(issue()));

    expect(discoverOrchestrationMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });
});

describe('linear-webhook-processor — #247 A6 comment trigger', () => {
  /** A Comment webhook payload. */
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

  /** Mock loadOrchestration (Query) → snapshot with the sub-issue as a started child, and GetCommand → its PR url. */
  function mockOrchWithChild(opts: { subIssueId: string; childTaskId?: string; prUrl?: string }): void {
    const meta = {
      sub_issue_id: '#meta', orchestration_id: 'orch_x', parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'WS', repo: 'o/r', child_count: 1, platform_user_id: 'release-user',
    };
    const child: Record<string, unknown> = {
      orchestration_id: 'orch_x', sub_issue_id: opts.subIssueId, depends_on: [],
      child_status: 'succeeded', repo: 'o/r', parent_linear_issue_id: 'PARENT', linear_workspace_id: 'WS',
    };
    if (opts.childTaskId) child.child_task_id = opts.childTaskId;
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query') return { Items: [meta, child] }; // loadOrchestration
      if (cmd._type === 'Get') return { Item: opts.prUrl ? { pr_url: opts.prUrl } : {} };
      return {};
    });
  }

  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset().mockResolvedValue({ statusCode: 201, body: '{}' });
    resolveLinearOauthTokenMock.mockReset()
      .mockResolvedValue({ accessToken: 'tok', oauthSecretArn: 'arn:secret', workspaceSlug: 'acme' });
    fetchIssueParentIdMock.mockReset().mockResolvedValue('PARENT');
    discoverOrchestrationMock.mockReset();
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
  });

  test('comment WITHOUT @bgagent → no task (ordinary discussion / agent progress comment)', async () => {
    await handler(eventWith(comment({ data: { id: 'c2', body: 'looks good to me!', issueId: 'sub-issue-1' } })));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    // Never even fetched the parent (cheap short-circuit on the mention check).
    expect(fetchIssueParentIdMock).not.toHaveBeenCalled();
  });

  test('@bgagent on an issue with no parent → not an orchestrated sub-issue → no task', async () => {
    fetchIssueParentIdMock.mockResolvedValue(null);
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('@bgagent on a sub-issue whose parent is not an orchestration → no task', async () => {
    fetchIssueParentIdMock.mockResolvedValue('PARENT');
    ddbSend.mockResolvedValue({ Items: [] }); // loadOrchestration → no snapshot
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('@bgagent on an un-started sub-issue (no child_task_id) → no task', async () => {
    mockOrchWithChild({ subIssueId: 'sub-issue-1' }); // no childTaskId
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('bare @bgagent (no text) → falls back to a generic iteration instruction', async () => {
    mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', prUrl: 'https://github.com/o/r/pull/7' });
    await handler(eventWith(comment({ data: { id: 'c3', body: '@bgagent', issueId: 'sub-issue-1' } })));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock.mock.calls[0][0].task_description).toMatch(/latest review feedback/i);
  });
});
