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
}));

const resolveLinearOauthTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: (...args: unknown[]) => resolveLinearOauthTokenMock(...args),
}));

const discoverOrchestrationMock = jest.fn();
jest.mock('../../src/handlers/shared/orchestration-discovery', () => ({
  discoverOrchestration: (...args: unknown[]) => discoverOrchestrationMock(...args),
}));

process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'LinearProjects';
process.env.LINEAR_USER_MAPPING_TABLE_NAME = 'LinearUsers';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
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
    reportIssueFailureMock.mockReset();
    reportIssueFailureMock.mockResolvedValue(undefined);
    resolveLinearOauthTokenMock.mockReset();
    discoverOrchestrationMock.mockReset();
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    upsertStatusCommentMock.mockReset().mockResolvedValue('cmt-status-1');
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
    // After seeding, the handler loads the orchestration (Query) to
    // release root children. Return an empty snapshot so the load is a
    // no-op (this test only asserts the parent spawns no task; root
    // release is covered by the reconciler/release tests).
    ddbSend.mockResolvedValueOnce({ Items: [] });

    await handler(eventWith(issue()));

    expect(discoverOrchestrationMock).toHaveBeenCalledTimes(1);
    // Parent issue must NOT spawn a task.
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reportIssueFailureMock).not.toHaveBeenCalled();
    // #10: parent epic gets the start signal — 👀 reaction + In Progress.
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
