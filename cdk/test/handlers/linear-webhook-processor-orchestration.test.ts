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
 * Tests the sub-issue orchestration routing in the Linear webhook
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
// The handler fetches the sub-issue graph ONCE up front and reuses it for
// discoverOrchestration (epic attachments are only hydrated when children
// exist, and the graph is never fetched twice). discoverOrchestration is separately
// mocked to drive routing, so this just needs to return a non-empty graph so the
// handler proceeds into the discovery call. A single_task test overrides it.
const fetchSubIssueGraphMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-subissue-fetch', () => ({
  fetchIssueParentId: (...args: unknown[]) => fetchIssueParentIdMock(...args),
  fetchSubIssueGraph: (...args: unknown[]) => fetchSubIssueGraphMock(...args),
}));

// The context probe gates attachment hydration: a FAILED probe fail-closes so
// a paperclip-only spec can't silently vanish. These routing
// tests aren't about attachments, so stub a healthy empty probe (ok:true) —
// otherwise the real fetch would fail in-test → ok:false → the epic/task would
// be rejected with an attachment-error before routing runs.
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
// Enable the orchestration path for this file (sibling file leaves it unset).
process.env.ORCHESTRATION_TABLE_NAME = 'OrchestrationTable';

import { handler } from '../../src/handlers/linear-webhook-processor';
import { buildClarifyResumeDescription } from '../../src/handlers/shared/clarify-resume';
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

describe('linear-webhook-processor — orchestration routing', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    // Default DDB response: an empty page. An alreadySeeded
    // loadOrchestration(Query) runs before hydrating the parent — these fresh-seed
    // tests want "not yet seeded" (Items:[]) so hydration runs.
    // happyPreamble's mockResolvedValueOnce Get responses still take precedence.
    ddbSend.mockResolvedValue({ Items: [] });
    createTaskCoreMock.mockReset();
    // Default: release path (now exercised in the seed test) returns a created task.
    createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'child-task' } }) });
    reportIssueFailureMock.mockReset();
    reportIssueFailureMock.mockResolvedValue(undefined);
    // ADR-016: single-task fall-through pre-hydrates comments + posts a start
    // comment. Default to no comments / clean post so orchestration tests are
    // unaffected.
    fetchRecentCommentsMock.mockReset().mockResolvedValue([]);
    postIssueCommentMock.mockReset().mockResolvedValue({ ok: true });
    resolveLinearOauthTokenMock.mockReset();
    discoverOrchestrationMock.mockReset();
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    swapCommentReactionMock.mockReset().mockResolvedValue(true);
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    upsertStatusCommentMock.mockReset().mockResolvedValue('cmt-status-1');
    fetchIssueParentIdMock.mockReset();
    // Default: the labeled issue has a sub-issue graph so the handler proceeds
    // into discoverOrchestration (whose mock drives the routing outcome). The
    // single_task-fall-through test overrides with { kind: 'no_children' }.
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
    // After seeding, the handler loads the orchestration (Query) to release
    // roots + post the initial panel. Return a real snapshot so the panel path
    // runs (mirrors the parent start signal). All Query calls return it.
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
    // The parent issue itself spawns no task FROM the single-task path — but
    // releasing root A does call createTaskCore once (for the child). It must
    // NOT be called with the parent's task_description (the single-task body).
    const calledWithParentBody = createTaskCoreMock.mock.calls.some(
      (c) => (c[0] as { task_description?: string }).task_description?.includes('Epic: ship the thing'));
    expect(calledWithParentBody).toBe(false);
    // The initial panel is posted (upsertStatusComment) and the parent start
    // signal mirrored — 👀 reaction + In Progress — via upsertEpicPanel.
    expect(upsertStatusCommentMock).toHaveBeenCalled();
    expect(swapIssueReactionMock).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'eyes');
    // The 5th arg (allowSameTypeRegression) is passed by the shared rollup
    // re-open path; harmless on this forward Backlog→In Progress mirror.
    expect(transitionIssueStateMock).toHaveBeenCalledWith(
      expect.anything(), expect.any(String), 'started', ['In Progress'], true,
    );
  });

  test('seeded → posts the live status block on the parent + stamps its id', async () => {
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

  test('a root REJECTED at seed time settles the epic now, not 10 minutes later', async () => {
    // A guardrail-blocked root never becomes a task, so no
    // task event ever wakes the reconciler — and the reconciler is what skips a
    // failed node's dependents and settles the epic. The panel sat at "🔄 1/2" with
    // a 👀 on an epic that was already finished, until the 10-minute stranded sweep
    // swept it up.
    resolveLinearOauthTokenMock.mockResolvedValue({ accessToken: 'tok', oauthSecretArn: 'arn', workspaceSlug: 'acme' });
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'seeded', orchestrationId: 'orch_gr', childCount: 2, rootSubIssueIds: ['A'], alreadyExisted: false,
    });
    // The guardrail rejects the root: a DETERMINISTIC 400, so it is terminally
    // failed rather than rolled back to ready.
    createTaskCoreMock.mockReset().mockResolvedValue({
      statusCode: 400,
      body: '{"error":{"message":"Task description was blocked by content policy."}}',
    });

    const meta = { sub_issue_id: '#meta', orchestration_id: 'orch_gr', parent_issue_ref: 'issue-1', credentials_ref: 'org-1', repo: 'owner/repo', child_count: 2, platform_user_id: 'u1' };
    const rowA = { sub_issue_id: 'A', orchestration_id: 'orch_gr', parent_issue_ref: 'issue-1', credentials_ref: 'org-1', repo: 'owner/repo', depends_on: [], child_status: 'ready', display_id: 'ABCA-1', title: 'Blocked root' };
    const rowB = { sub_issue_id: 'B', orchestration_id: 'orch_gr', parent_issue_ref: 'issue-1', credentials_ref: 'org-1', repo: 'owner/repo', depends_on: ['A'], child_status: 'blocked', display_id: 'ABCA-2', title: 'Dependent' };
    // The post-release re-read shows the settled picture the fix just persisted.
    // Model the store, rather than counting calls: the handler loads the graph, the
    // release + skip writes mutate it, and the post-release re-read must show those
    // mutations — exactly what the fix depends on.
    const store: Record<string, Record<string, unknown>> = {
      '#meta': { ...meta }, 'A': { ...rowA }, 'B': { ...rowB },
    };
    let gets = 0;
    ddbSend.mockReset();
    ddbSend.mockImplementation(async (cmd: { _type?: string; input?: Record<string, unknown> }) => {
      if (cmd?._type === 'Get') {
        gets += 1;
        // 1st: the project-mapping row; 2nd: the linked-user row.
        if (gets === 1) return { Item: { status: 'active', repo: 'owner/repo', label_filter: 'bgagent' } };
        if (gets === 2) return { Item: { platform_user_id: 'u1' } };
        return {};
      }
      if (cmd?._type === 'Query') return { Items: Object.values(store) };
      if (cmd?._type === 'Update') {
        const sk = (cmd.input?.Key as { sub_issue_id?: string })?.sub_issue_id;
        const vals = (cmd.input?.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
        if (sk && store[sk]) {
          // Apply the value the UpdateExpression actually SETs, not whichever
          // binding happens to be present — a conditional write binds its expected
          // status too, so keying on presence applied the guard as the new value.
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

    // The dependent's skip is PERSISTED at seed time — that is what makes the epic
    // reach all-terminal without waiting for a sweep.
    const skipWrite = ddbSend.mock.calls
      .map((c) => c[0]?.input)
      .find((i) => i?.ExpressionAttributeValues?.[':s'] === 'skipped');
    expect(skipWrite).toBeDefined();
    expect((skipWrite!.Key as { sub_issue_id: string }).sub_issue_id).toBe('B');

    // ...and the panel renders the SETTLED outcome, not "in progress".
    expect(upsertStatusCommentMock).toHaveBeenCalledTimes(1);
    const [, , body] = upsertStatusCommentMock.mock.calls[0];
    expect(body).toContain('finished with failures');
    expect(body).not.toMatch(/^🔄/);
    // The row carries the actionable reason, since there is no task to read it from.
    expect(body).toContain('reword this sub-issue');
    // And the settled-with-failures panel offers the retry route.
    expect(body).toContain('@bgagent retry');
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

  test('the seed records the project trigger label, so the retry hint can name it', async () => {
    // The panel's retry hint tells an operator which label to re-apply. That label
    // is per-project configurable, and the seed is the only point where the project
    // mapping is in hand — the reconciler reads the meta row and has no project id
    // to look one up with. Without this the hint renders the platform default,
    // which on a project that triggers on anything else is a dead end.
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
    // Normalised the same way the trigger gate matches, so the hint names a label
    // that actually fires rather than the casing someone happened to type.
    expect(releaseContext.trigger_label).toBe('ship-it');
  });

  test('a project with no configured label records the default, never a blank', async () => {
    // A blank would render an empty label in the retry hint — worse than the
    // default, which at least names the label the gate actually falls back to.
    ddbSend
      .mockResolvedValueOnce({ Item: { status: 'active', repo: 'owner/repo' } }) // no label_filter
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

  // Re-applying the trigger label on an epic that already has a graph and no new
  // sub-issues means "re-run what didn't finish". Three shapes, and the note posted
  // has to match which one it is — the earlier copy claimed it was "running the
  // existing sub-issue graph" on all three while re-running nothing on two of them.
  describe('re-labelling an epic with no new sub-issues', () => {
    /** Wire the ddb calls the extend-with-no-new-nodes retry path makes. */
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

      // The failed child really is dispatched again — the point of the retry.
      expect(createTaskCoreMock).toHaveBeenCalled();
      const posted = upsertStatusCommentMock.mock.calls.map((c) => String(c[2])).join('\n');
      expect(posted).toMatch(/Re-running the parts of this epic that didn't finish/i);
      expect(posted).toContain('1 failed');
      // And it says the succeeded work is left alone, so nobody fears a redo.
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
      // Nothing has failed, so there is nothing to re-run, but the epic is also not
      // finished. Claiming either would be wrong, and a note saying "still running"
      // only repeats what the panel above it already shows.
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
    // No graph → the handler must NOT hydrate epic attachments; it
    // falls through to the single-task path which hydrates once under the taskId.
    fetchSubIssueGraphMock.mockResolvedValueOnce({ kind: 'no_children', parentIssueId: 'issue-1' });
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
    // not resolve, the handler drops the event rather than
    // creating a task against a workspace ABCA can't recognize — outbound
    // Linear comments would silently skip and we'd burn agent quota for no
    // observable result. So neither orchestration NOR a single task fires.
    resolveLinearOauthTokenMock.mockResolvedValue(null);

    await handler(eventWith(issue()));

    expect(discoverOrchestrationMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  // The unmapped-project nudge must be claim-once
  // (a webhook redelivery carries the same labelIds, so labelJustPresent alone
  // re-fires). This file sets ORCHESTRATION_TABLE_NAME, so the claim path runs.
  test('unmapped-project nudge is claim-once — a redelivery posts EXACTLY ONE nudge', async () => {
    const claimed = new Set<string>();
    resolveLinearOauthTokenMock.mockResolvedValue({ accessToken: 't', oauthSecretArn: 'a', workspaceSlug: 'w' });
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      const key = cmd.input?.Key as { sub_issue_id?: string; linear_project_id?: string } | undefined;
      if (key?.linear_project_id) return { Item: undefined }; // project not mapped
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
    await handler(eventWith(abcaIssue())); // redelivery
    await handler(eventWith(abcaIssue())); // redelivery
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reportIssueFailureMock).toHaveBeenCalledTimes(1); // ONE nudge, not three
  });

  // Label discoverability: the :help explainer. Tested at the handler seam (real
  // webhook → real routing) rather than against a mocked helper, so the tests pin
  // the behaviour a user actually sees.
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
      // project mapping (onboarded) → then the claim-once Update wins.
      ddbSend
        .mockResolvedValueOnce({ Item: { status: 'active', repo: 'owner/repo', label_filter: 'bgagent' } })
        .mockResolvedValueOnce({}); // claimCommentAck Update → succeeds (first delivery)

      await handler(eventWith(helpIssue()));

      // No task, no orchestration — help is inert compute-wise.
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(discoverOrchestrationMock).not.toHaveBeenCalled();
      // The explainer was posted on the issue.
      expect(upsertStatusCommentMock).toHaveBeenCalledTimes(1);
      const [, issueId, body] = upsertStatusCommentMock.mock.calls[0];
      expect(issueId).toBe('issue-1');
      expect(String(body)).toContain('`bgagent`');
      expect(String(body)).toMatch(/how to use abca/i);
    });

    test(':help is idempotent — a webhook redelivery does NOT repost', async () => {
      ddbSend
        .mockResolvedValueOnce({ Item: { status: 'active', repo: 'owner/repo', label_filter: 'bgagent' } })
        // claimCommentAck loses the conditional write → already posted.
        .mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }));

      await handler(eventWith(helpIssue()));

      expect(upsertStatusCommentMock).not.toHaveBeenCalled();
      expect(createTaskCoreMock).not.toHaveBeenCalled();
    });

    test(':help on a project that is not onboarded gets the onboarding nudge, not silence', async () => {
      // The first-time user the help label is for: the project has no mapping yet,
      // so no explainer can be posted. The nudge for an ABCA label on an unmapped
      // project recognises `bgagent:help`, but the help branch returned before it.
      // (Default mock: no mapping row, and the claim-once write succeeds.)
      await handler(eventWith(helpIssue()));

      expect(upsertStatusCommentMock).not.toHaveBeenCalled(); // no explainer without a mapping
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

  /** Mock loadOrchestration (Query) → snapshot with the sub-issue as a started child, and GetCommand → its PR url.
   *  The standalone LinearIssueIndex GSI query (Query w/ IndexName) returns empty unless `standalone` is given. */
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
        return { Items: opts.standalone ? [{ channel_metadata: { linear_workspace_id: 'org-1' }, ...opts.standalone }] : [] }; // lookupTaskByLinearIssue
      }
      if (cmd._type === 'Query') return { Items: [meta, child] }; // loadOrchestration
      // Comment-trigger authorization: lookupPlatformUser Gets the user-mapping
      // row keyed on linear_identity. Return a mapped commenter so the auth gate
      // passes (the un-mapped case is covered by its own dedicated test).
      if (cmd._type === 'Get' && (cmd.input.Key as { linear_identity?: string })?.linear_identity) {
        return { Item: { platform_user_id: 'commenter-user', status: 'active' } };
      }
      if (cmd._type === 'Get') return { Item: opts.prUrl ? { pr_url: opts.prUrl } : {} };
      return {};
    });
  }

  /** Mock for a PLAIN (non-orchestration) issue: no parent, no orchestration snapshot, only the GSI hit. */
  function mockStandaloneOnly(standalone: { task_id: string; user_id?: string; repo?: string; pr_url?: string; pr_number?: number; status?: string } | null): void {
    fetchIssueParentIdMock.mockResolvedValue(LOOKUP_ABSENT); // no parent ⇒ not a sub-issue
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'LinearIssueIndex') {
        return { Items: standalone ? [{ channel_metadata: { linear_workspace_id: 'org-1' }, ...standalone }] : [] };
      }
      // Comment-trigger authorization: the commenter resolves to a mapped user.
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
    // A retry comment reads the sub-issues of the epic again. The tests that are
    // about that give it a graph.
    fetchSubIssueGraphMock.mockReset().mockResolvedValue({ kind: 'no_children', parentIssueId: 'PARENT' });
    discoverOrchestrationMock.mockReset();
    reactToCommentMock.mockReset().mockResolvedValue(true);
    replyToCommentMock.mockReset().mockResolvedValue(true);
    upsertThreadedReplyMock.mockReset().mockResolvedValue('reply-1');
  });

  // A comment only acts on work recorded under the workspace the delivery came from.
  // The other fixtures in this file are single-workspace (org-1).
  describe('a comment cannot act on another workspace\'s work', () => {
    function expectSilentDrop(): void {
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      // No ack or reply, matching the project-mapping check.
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
      // A comment on the epic itself is routed without a Linear API call, so the
      // workspace match is checked on this path too.
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
    // The triggering comment id is threaded so the reconciler can
    // reply ✅/❌ beneath it when the iteration lands.
    expect(ctx.channelMetadata.trigger_comment_id).toBe('comment-1');
  });

  test('the "on it" ack replies on the commented issue, threaded under that comment', async () => {
    // The ack is a THREADED reply: it must name the issue the comment lives on
    // AND the comment to thread under. Reversing the two makes the surface
    // reject the reply, so the user sees the 👀 and then silence.
    mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', prUrl: 'https://github.com/o/r/pull/42' });
    await handler(eventWith(comment()));

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const [ctx, issueId, parentCommentId, body, existingReplyId] = upsertThreadedReplyMock.mock.calls[0];
    expect(ctx).toEqual({ linearWorkspaceId: 'org-1', registryTableName: 'LinearWorkspaceRegistry' });
    expect(issueId).toBe('sub-issue-1');
    expect(parentCommentId).toBe('comment-1');
    expect(body).toContain('👀');
    expect(existingReplyId).toBeUndefined(); // a fresh ack, nothing to edit yet
    // Its id rides on the task so later events mature THIS reply, not a new one.
    const [, taskCtx] = createTaskCoreMock.mock.calls[0];
    expect(taskCtx.channelMetadata.iteration_reply_comment_id).toBe('reply-1');
  });

  // "@bgagent retry" on a CHILD of a failed orchestration routes to the SAME
  // epic-retry machinery as on the parent (consistency), NOT to iteration of
  // that child's PR. Proves the shared handleEpicRetryIntent path works from
  // the child entry point, not just from the parent epic.
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
    // The commented child succeeded; a SIBLING failed → retry has work to do.
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
    // The failed sibling was reworded since the epic was first read.
    fetchSubIssueGraphMock.mockResolvedValue({
      kind: 'ok',
      parentIssueId: 'PARENT',
      children: [{ id: 'sub-issue-1', depends_on: [] }, { id: 'sub-bad', depends_on: [], title: 'Reworded' }],
    });

    await handler(eventWith(comment({ data: { id: 'c-retry', body: '@bgagent retry', issueId: 'sub-issue-1' } })));

    // The sub-issues of the EPIC, not of the commented one, are read again, and
    // the title the failed sibling has now is stored for the retry to send.
    expect(fetchSubIssueGraphMock).toHaveBeenCalledWith('tok', 'PARENT', undefined);
    const textWrites = ddbSend.mock.calls
      .map((c) => c[0] as { _type?: string; input: { Key?: { sub_issue_id?: string }; ExpressionAttributeValues?: Record<string, unknown>; ExpressionAttributeNames?: Record<string, string> } })
      .filter((cmd) => cmd._type === 'Update' && cmd.input.ExpressionAttributeNames?.['#title'] === 'title');
    expect(textWrites.map((cmd) => [cmd.input.Key?.sub_issue_id, cmd.input.ExpressionAttributeValues?.[':title']]))
      .toEqual([['sub-bad', 'Reworded']]);

    // Re-ran the failed sibling (salted key), did NOT open a pr-iteration on the child.
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [body, ctx] = createTaskCoreMock.mock.calls[0];
    expect(body.workflow_ref).not.toBe('coding/pr-iteration-v1');
    expect(ctx.idempotencyKey).toContain('task-bad-1'); // salted with the dead task id → new task for the failed child
    // 👀 kept (work in flight), no "nothing to retry" reply.
    expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'c-retry', 'eyes');
    expect(replyToCommentMock).not.toHaveBeenCalled();
    // ...but the comment is RECORDED, so the epic's settle can move that 👀 to the
    // outcome. This handler returns as soon as the work is dispatched, and the
    // reconciler that sees the result has no other way to learn which comment asked
    // for it — without this the comment stays on 👀 forever.
    const recorded = ddbSend.mock.calls
      .map((c) => c[0] as { _type?: string; input?: { UpdateExpression?: string; ExpressionAttributeValues?: Record<string, unknown> } })
      .filter((cmd) => cmd?._type === 'Update' && /SET retry_comment_id/.test(cmd.input?.UpdateExpression ?? ''));
    expect(recorded).toHaveLength(1);
    expect(recorded[0].input?.ExpressionAttributeValues?.[':cid']).toBe('c-retry');
  });

  test('@bgagent on a started sub-issue → instant 👀 ack on the TRIGGERING comment', async () => {
    mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', prUrl: 'https://github.com/o/r/pull/42' });
    await handler(eventWith(comment()));

    // 👀 lands on the comment (commentId 'comment-1'), not the issue, with EMOJI_STARTED.
    expect(reactToCommentMock).toHaveBeenCalledTimes(1);
    const [, commentId, emoji] = reactToCommentMock.mock.calls[0];
    expect(commentId).toBe('comment-1');
    expect(emoji).toBe('eyes');
  });

  test('@bgagent THREAD-REPLY trigger → 👀 on the reply, but reply target is the thread ROOT', async () => {
    // A trigger comment that is itself a thread-reply carries parentId = the
    // top-level root. Linear rejects replying to a reply, so trigger_comment_id
    // must be the ROOT — but the 👀 still goes on the actual reply the human wrote.
    mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', prUrl: 'https://github.com/o/r/pull/42' });
    await handler(eventWith(comment({
      data: { id: 'reply-cmt-9', parentId: 'root-cmt-1', body: '@bgagent tweak it', issueId: 'sub-issue-1' },
    })));

    // 👀 on the actual reply the human wrote.
    expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'reply-cmt-9', 'eyes');
    // But the ack replies to the thread ROOT, not the reply.
    const ctx = createTaskCoreMock.mock.calls[0][1];
    expect(ctx.channelMetadata.trigger_comment_id).toBe('root-cmt-1');
  });

  // A started sub-issue whose task has no pull request cannot be iterated. The
  // reviewer addressed the bot there, so they have to be told: the same request
  // left on the epic and naming this sub-issue is answered, while this one was
  // logged and dropped with no reaction and no reply.
  describe('@bgagent on a started sub-issue that has no pull request', () => {
    const askForAFix = (): Record<string, unknown> => comment({
      data: {
        id: 'comment-1',
        body: '@bgagent the fixture path is wrong, use fixtures/v2 and run the tests again please',
        issueId: 'sub-issue-1',
      },
    });

    /** One threaded reply under the comment on the sub-issue, a ❓, and nothing started. */
    function expectAnsweredWithoutWork(): string {
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(upsertThreadedReplyMock).not.toHaveBeenCalled(); // no "On it": nothing is being worked on
      expect(replyToCommentMock).toHaveBeenCalledTimes(1);
      const [, issueId, parentCommentId, body] = replyToCommentMock.mock.calls[0];
      expect(issueId).toBe('sub-issue-1');
      expect(parentCommentId).toBe('comment-1');
      expect(reactToCommentMock.mock.calls).toEqual([[expect.anything(), 'comment-1', 'question']]);
      // Linear delivers the reply back; it must not read as a request itself.
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
      // A run that stopped to ask a clarifying question, or found nothing to change,
      // ends COMPLETED without a pull request: the sub-issue is 'succeeded' for the
      // epic and no pull request will follow. "No pull request yet, comment again
      // once it has one" would have the reviewer wait for nothing.
      mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', childStatus: 'succeeded' });
      await handler(eventWith(askForAFix()));
      const reply = expectAnsweredWithoutWork();
      expect(reply).toMatch(/no pull request, so there's nothing to iterate on/);
      expect(reply).not.toMatch(/\byet\b/);
      // Coming back is advised only for a run that is still going.
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
      // Must not report the different, misleading "no pull request" state.
      expect(reply).not.toMatch(/no pull request, so/);
    });
  });

  // A sub-issue the epic has not started has no task, so the lookup of a task
  // for it misses. The answer for a plain issue in that state is "re-apply the
  // trigger label for a fresh run" — here that advice starts a second, detached
  // run of a sub-issue the epic is going to run anyway.
  describe('@bgagent on a sub-issue its epic has not started', () => {
    /** The single note posted on the sub-issue (and the ❓ on the comment). */
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
      mockOrchWithChild({ subIssueId: 'sub-issue-1', childStatus: 'blocked' }); // no task yet
      await handler(eventWith(comment()));
      const note = expectOneNote();
      expect(note).toMatch(/hasn't started yet/);
      expect(note).not.toMatch(/trigger label/);
    });

    test('a sub-issue that did not run: points at the retry on the epic', async () => {
      mockOrchWithChild({ subIssueId: 'sub-issue-1', childStatus: 'skipped' }); // a dependency failed
      await handler(eventWith(comment()));
      const note = expectOneNote();
      expect(note).toMatch(/did not run/);
      expect(note).toContain('`@bgagent retry` on the epic');
      expect(note).not.toMatch(/trigger label/);
    });
  });

  test('@bgagent that does NOT resolve to an actionable iteration → no premature 👀 ack', async () => {
    // No childTaskId ⇒ un-started sub-issue ⇒ we bail before acting; don't ack.
    mockOrchWithChild({ subIssueId: 'sub-issue-1' });
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(reactToCommentMock).not.toHaveBeenCalled();
  });

  test('comment WITHOUT @bgagent → no task (ordinary discussion / agent progress comment)', async () => {
    await handler(eventWith(comment({ data: { id: 'c2', body: 'looks good to me!', issueId: 'sub-issue-1' } })));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    // Never even fetched the parent (cheap short-circuit on the mention check).
    expect(fetchIssueParentIdMock).not.toHaveBeenCalled();
  });

  test('@bgagent on an issue with no linked task → TELLS the user, does not drop it', async () => {
    // Reaching this path requires an explicit @bgagent mention, so the user is
    // waiting on an answer. This used to log at info and return, which is
    // indistinguishable from being ignored.
    //
    // It is not a rare edge either: the issue→task link comes from a sparse GSI on
    // an attribute only written going forward, with no back-fill, so on the deploy
    // that first enables this path EVERY issue already in flight lands here.
    mockStandaloneOnly(null); // no parent, GSI miss
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    // No premature 👀 — we never committed to doing work.
    expect(reactToCommentMock).not.toHaveBeenCalled();
    // But the user IS told, and pointed at the way forward.
    const posted = upsertStatusCommentMock.mock.calls.map((c) => String(c[2])).join('\n');
    expect(posted).toMatch(/don't have a task linked to this issue/i);
    expect(posted).toMatch(/re-apply this project's trigger label/i);
    // ...and the comment settles to ❓, not ✅ — nothing succeeded.
    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'question');
  });

  test('a FAILED issue→task lookup is not reported to the user as "not an ABCA issue"', async () => {
    // A Query failure and a genuine miss are different facts. Collapsing them told
    // the user their issue is not ours, which is a guess dressed as a conclusion —
    // and it hides a real fault (throttling, a missing GSI) behind a silent no-op.
    fetchIssueParentIdMock.mockResolvedValue(LOOKUP_ABSENT);
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      // ONLY the GSI query fails — everything else (the redelivery claim, the
      // commenter authorization) must still work, or the nudge would be skipped
      // for an unrelated reason and the test would pass vacuously.
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
    // Must NOT claim the issue isn't ours — we do not know that.
    expect(posted).not.toMatch(/don't have a task linked/i);
  });

  test('@bgagent on a sub-issue whose parent is not an orchestration AND no ABCA task → no task', async () => {
    fetchIssueParentIdMock.mockResolvedValue(lookupFound('PARENT'));
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'LinearIssueIndex') return { Items: [] };
      return { Items: [] }; // loadOrchestration → no snapshot
    });
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  // The two behaviour changes the LookupResult conversion actually makes: a
  // *failed* issue-parent lookup must not be treated like "this issue has no
  // parent". These two tests pin the difference — same standalone fallback
  // available in both, opposite outcomes.
  test('an ABSENT parent (genuinely top-level) still falls through to the standalone path', async () => {
    fetchIssueParentIdMock.mockResolvedValue(LOOKUP_ABSENT);
    mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });

    await handler(eventWith(comment()));

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock.mock.calls[0][0].pr_number).toBe(99);
  });

  test('a FAILED parent lookup THROWS to earn a retry — no silent downgrade to standalone', async () => {
    // Two regressions in one. (1) Falling through would iterate this issue's PR
    // via the standalone path — no dependency cascade — on nothing worse than a
    // Linear 503, silently downgrading an orchestration child. (2) Returning
    // instead of throwing would be a *successful* async invocation: Lambda
    // discards the event, the receiver's dedup row (8h TTL) already suppressed
    // Linear's own redelivery, and the @bgagent comment is dropped with no 👀,
    // no reply, and no retry. Only a throw spends the async-invoke retry budget,
    // and nothing user-visible has been posted at this point, so a retry is safe.
    const err = new Error('Linear issue-parent fetch returned HTTP 503');
    fetchIssueParentIdMock.mockResolvedValue(lookupFailed(err));
    // A standalone task IS resolvable — so "no task created" can only mean the
    // fall-through was refused, not that there was nothing to fall through to.
    mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });
    fetchIssueParentIdMock.mockResolvedValue(lookupFailed(err)); // mockStandaloneOnly resets it to ABSENT

    await expect(handler(eventWith(comment()))).rejects.toThrow(err);

    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('@bgagent on an un-started sub-issue (no child_task_id) AND no ABCA task → no task', async () => {
    mockOrchWithChild({ subIssueId: 'sub-issue-1' }); // no childTaskId, no standalone
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('an UNMAPPED commenter cannot drive a dispatch (❓ + reply, no task)', async () => {
    // Even with a fully actionable iteration target, a commenter with NO linked
    // platform user must not be able to start a code-pushing run billed to the
    // requester. The mapping Get returns nothing → the gate blocks before dispatch.
    fetchIssueParentIdMock.mockResolvedValue(LOOKUP_ABSENT);
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'LinearIssueIndex') {
        return { Items: [{ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 }] };
      }
      // No user-mapping row for the commenter (linear_identity Get → empty).
      return {};
    });
    await handler(eventWith(comment()));
    expect(createTaskCoreMock).not.toHaveBeenCalled(); // blocked by auth
    expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'question');
  });

  test('the reply to an unmapped commenter is not itself a trigger when Linear delivers it back', async () => {
    // Linear sends the app's own comments back as Comment webhooks, with the app
    // as the actor, and no ABCA user is linked to the app. The reply names the
    // handle, so if it read as a trigger it would be one from an unmapped
    // commenter: the bot would answer its own reply, and that answer would come
    // back the same way, without end.
    fetchIssueParentIdMock.mockResolvedValue(LOOKUP_ABSENT);
    ddbSend.mockResolvedValue({}); // nobody is linked: not the commenter, not the app
    await handler(eventWith(comment()));
    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const reply = String(upsertThreadedReplyMock.mock.calls[0][3]);
    expect(reply).toContain('`@bgagent`'); // it does tell the user which handle it means

    await handler(eventWith(comment({
      actor: { id: 'abca-app-user' },
      data: { id: 'reply-1', parentId: 'comment-1', body: reply, issueId: 'sub-issue-1' },
    })));

    // No reply to the reply, and no second ❓.
    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    expect(reactToCommentMock).toHaveBeenCalledTimes(1);
  });

  test('bare @bgagent (no text) → falls back to a generic iteration instruction', async () => {
    mockOrchWithChild({ subIssueId: 'sub-issue-1', childTaskId: 'task-sub-1', prUrl: 'https://github.com/o/r/pull/7' });
    await handler(eventWith(comment({ data: { id: 'c3', body: '@bgagent', issueId: 'sub-issue-1' } })));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock.mock.calls[0][0].task_description).toMatch(/latest review feedback/i);
  });

  // The GENERALIZED trigger — a plain (non-orchestration) issue
  // that ABCA opened a PR for, resolved via the LinearIssueIndex GSI.
  describe('standalone (non-orchestration) @bgagent trigger', () => {
    test('plain issue with an ABCA PR → pr-iteration task, 👀 ack, trigger_comment_id but NO orchestration markers', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });
      await handler(eventWith(comment()));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [body, ctx] = createTaskCoreMock.mock.calls[0];
      expect(body.workflow_ref).toBe('coding/pr-iteration-v1');
      expect(body.pr_number).toBe(99);
      expect(body.repo).toBe('o/r');
      expect(ctx.userId).toBe('u-solo'); // attributed to the original task's user
      expect(ctx.channelMetadata.trigger_comment_id).toBe('comment-1');
      expect(ctx.channelMetadata.linear_issue_id).toBe('sub-issue-1');
      // NOT an orchestration iteration — the reconciler must ignore it (fanout replies).
      expect(ctx.channelMetadata.orchestration_id).toBeUndefined();
      expect(ctx.channelMetadata.orchestration_iteration).toBeUndefined();
      // 👀 ack on the comment.
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'eyes');
    });

    test('plain issue resolves PR from pr_url when pr_number absent', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_url: 'https://github.com/o/r/pull/123' });
      await handler(eventWith(comment()));
      expect(createTaskCoreMock.mock.calls[0][0].pr_number).toBe(123);
    });

    // A follow-up on a PR-less completed task is NEW work, not a dead-end.
    test('PR-less task + instruction → fresh new-task-v1 on the same repo, 👀 ack, NO orchestration markers', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r' }); // no pr
      await handler(eventWith(comment())); // '@bgagent change the timeout to 30 min'

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [body, ctx] = createTaskCoreMock.mock.calls[0];
      expect(body.workflow_ref).toBe('coding/new-task-v1');
      expect(body.pr_number).toBeUndefined(); // NEW work, not an iteration
      expect(body.repo).toBe('o/r');
      expect(body.task_description).toBe('change the timeout to 30 min');
      expect(ctx.userId).toBe('u-solo');
      expect(ctx.channelMetadata.trigger_comment_id).toBe('comment-1');
      expect(ctx.channelMetadata.linear_issue_id).toBe('sub-issue-1');
      expect(ctx.channelMetadata.orchestration_id).toBeUndefined();
      expect(ctx.channelMetadata.orchestration_iteration).toBeUndefined();
      expect(ctx.idempotencyKey).toContain('newwork_');
      // 👀 ack on the comment.
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'eyes');
    });

    // A follow-up comment while the task is
    // still RUNNING (PR-less because it hasn't opened its PR yet) must NOT spawn
    // a second parallel task — prNumber===null is not enough to mean "finished".
    test('PR-less task still RUNNING → does NOT dispatch a parallel task, replies instead', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', status: 'RUNNING' });
      await handler(eventWith(comment()));
      expect(createTaskCoreMock).not.toHaveBeenCalled(); // no double-dispatch
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'eyes');
    });

    test('PR-less task in a TERMINAL state (COMPLETED) → new work IS dispatched', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', status: 'COMPLETED' });
      await handler(eventWith(comment()));
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      expect(createTaskCoreMock.mock.calls[0][0].workflow_ref).toBe('coding/new-task-v1');
    });

    // The agent cannot read Linear and is told the issue is in its task description.
    // New work started from a follow-up therefore needs what the first run was
    // given: on its own, "retry" or "you missed the SAML case" is not a task.
    describe('new work from a follow-up is given the issue, not only the comment', () => {
      /** The PR-less task found through the index, and its base row with the stored description. */
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
        // The issue first, as the first run received it; then the follow-up.
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
        // The label path fills the description up to the limit whenever project
        // documents or comments overflow, so "issue + follow-up" must be cut to fit
        // or createTaskCore rejects it. The follow-up is the part that must survive.
        mockFinishedTaskWithDescription(`ABC-42: Fix the login bug\n\n${'x'.repeat(10_000 - 27)}`);
        await handler(eventWith(comment({ data: { id: 'comment-1', body: '@bgagent you missed the SAML case', issueId: 'sub-issue-1' } })));

        const description = String(createTaskCoreMock.mock.calls[0][0].task_description);
        expect(description.slice(0, 27)).toBe('ABC-42: Fix the login bug\n\n');
        expect(description.slice(-47)).toBe('The reviewer now asks: you missed the SAML case');
        expect(description).toHaveLength(10_000); // cut to exactly what fits, no further
      });

      test('a follow-up on a resumed task keeps the question and the answer', async () => {
        // The description of a task that was resumed after a clarifying question
        // ends with that exchange. Cut from its end, the follow-up took the place
        // of the reviewer's answer: the issue text in front of the exchange gives way.
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
        expect(description).toHaveLength(10_000); // cut to exactly what fits, no further
      });

      test('a follow-up does not shorten exchanges that leave it no room', async () => {
        // A row without a stored description, resumed twice with long answers:
        // the description is exchanges only, and no issue text can give way.
        // What the reviewer wrote stays whole; the description is then over the
        // limit, createTaskCore refuses it and the commenter is told why.
        const first = buildClarifyResumeDescription(undefined, 'q'.repeat(2_000), 'a'.repeat(2_900));
        const resumed = buildClarifyResumeDescription(first, 'r'.repeat(2_000), 'b'.repeat(2_700));
        expect(resumed).toHaveLength(9_930); // a description a task can have
        mockFinishedTaskWithDescription(resumed);
        await handler(eventWith(comment({ data: { id: 'comment-1', body: '@bgagent retry', issueId: 'sub-issue-1' } })));

        const description = String(createTaskCoreMock.mock.calls[0][0].task_description);
        expect(description.startsWith(`${resumed}\n\n---\n`)).toBe(true);
        expect(description.slice(-28)).toBe('The reviewer now asks: retry');
        expect(description).toHaveLength(10_023);
      });

      test('an answer to a question of the follow-up run keeps the follow-up request', async () => {
        // The other direction, through both builders. Each keeps the blocks of
        // the other by their first lines (APPENDED_BLOCK in clarify-resume.ts):
        // a rewording of the follow-up block has to reach that expression.
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
        await handler(eventWith(comment())); // '@bgagent change the timeout to 30 min'

        expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
        expect(createTaskCoreMock.mock.calls[0][0].task_description).toBe('change the timeout to 30 min');
      });
    });

    test('PR-less task + BARE @bgagent (no instruction) → no task, but a threaded reply (not silent)', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r' }); // no pr
      await handler(eventWith(comment({ data: { id: 'comment-1', body: '@bgagent', issueId: 'sub-issue-1' } })));

      expect(createTaskCoreMock).not.toHaveBeenCalled(); // nothing to start
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'eyes');
      expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1); // told the user what to do
    });

    test('the bare-mention reply is not itself a trigger when Linear delivers it back', async () => {
      // The reply shows an example (`@bgagent add a note to the README`). Delivered
      // back with the app as its author, it must not be read as a request from an
      // unmapped commenter, which would be answered, and that answer delivered back.
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r' }); // no pr
      await handler(eventWith(comment({ data: { id: 'comment-1', body: '@bgagent', issueId: 'sub-issue-1' } })));
      expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
      const reply = String(upsertThreadedReplyMock.mock.calls[0][3]);
      expect(reply).toContain('`@bgagent add a note to the README`');

      // The app's own Linear user has no linked ABCA user.
      const linked = ddbSend.getMockImplementation()!;
      ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) =>
        ((cmd.input.Key as { linear_identity?: string } | undefined)?.linear_identity === 'org-1#abca-app-user' ? {} : linked(cmd)));
      await handler(eventWith(comment({
        actor: { id: 'abca-app-user' },
        data: { id: 'reply-1', parentId: 'comment-1', body: reply, issueId: 'sub-issue-1' },
      })));

      expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1); // no reply to the reply
      expect(reactToCommentMock).toHaveBeenCalledTimes(1); // only the 👀 of the first delivery
      expect(createTaskCoreMock).not.toHaveBeenCalled();
    });

    test('PR-less task with NO repo → genuinely unactionable → no task, no ack', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo' }); // no pr, no repo
      await handler(eventWith(comment()));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(reactToCommentMock).not.toHaveBeenCalled();
    });

    test('PR-less task missing user_id → cannot attribute → no task, no ack', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', repo: 'o/r' }); // no user_id, no pr
      await handler(eventWith(comment()));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(reactToCommentMock).not.toHaveBeenCalled();
    });

    test('plain issue task missing user_id (has PR) → cannot attribute → no task', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', repo: 'o/r', pr_number: 5 }); // no user_id
      await handler(eventWith(comment()));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
    });
  });

  // The 👀 and the "On it" reply are posted BEFORE createTaskCore. When that call
  // refuses or throws there is no task, so nothing later would ever edit the reply:
  // the thread would say "On it" for good and the commenter would never learn why
  // nothing happened. The dispatch has to settle its own acknowledgement.
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

    /** The "On it" reply was edited in place into the reason, and the comment's 👀 became ❌. */
    function expectAckSettledAsFailed(reason: RegExp): void {
      expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(2);
      expect(String(upsertThreadedReplyMock.mock.calls[0][3])).toContain('On it');
      const [, issueId, parentCommentId, body, existingReplyId] = upsertThreadedReplyMock.mock.calls[1];
      expect(issueId).toBe('sub-issue-1');
      expect(parentCommentId).toBe('comment-1');
      expect(existingReplyId).toBe('reply-1'); // the acknowledgement itself, not a second reply
      expect(String(body)).toMatch(reason);
      expect(replyToCommentMock).not.toHaveBeenCalled();
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'x');
    }

    test('an iteration refused for an exhausted budget says so, without the billed user\'s figures', async () => {
      // The task is created as, and billed to, the user whose task the comment
      // continues ('u-solo'), not as the commenter ('commenter-user'). createTaskCore
      // words the refusal for the billed user and puts their spend and limit in it;
      // passed on, it would tell the commenter "Your monthly budget" and show every
      // reader of the issue another user's figures.
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
      upsertThreadedReplyMock.mockResolvedValueOnce(null); // the acknowledgement failed to post
      createTaskCoreMock.mockResolvedValueOnce(BUDGET_REFUSAL);
      await handler(eventWith(comment()));

      expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(2);
      const [, issueId, parentCommentId, body, existingReplyId] = upsertThreadedReplyMock.mock.calls[1];
      expect(issueId).toBe('sub-issue-1');
      expect(parentCommentId).toBe('comment-1');
      expect(existingReplyId).toBeUndefined(); // nothing to edit
      expect(String(body)).toMatch(/monthly budget is exhausted/);
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'comment-1', 'x');
    });

    test('an idempotent replay (200) is not a refusal: the first delivery\'s task owns the reply', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });
      createTaskCoreMock.mockResolvedValueOnce({ statusCode: 200, body: JSON.stringify({ data: { task_id: 'T1' } }) });
      await handler(eventWith(comment()));
      expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1); // this delivery's acknowledgement only
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
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', status: 'FAILED' }); // no pr
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 503,
        body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Content screening is temporarily unavailable. Please try again later.' } }),
      });
      await handler(eventWith(comment()));
      expect(createTaskCoreMock.mock.calls[0][0].workflow_ref).toBe('coding/new-task-v1');
      expectAckSettledAsFailed(/temporarily unavailable \(status 503\)/);
      const body = String(upsertThreadedReplyMock.mock.calls[1][3]);
      expect(body).toMatch(/re-comment/);
      // Re-applying the label is the wrong advice on a comment: it starts a new run.
      expect(body).not.toMatch(/trigger label/);
    });

    test('a refused clarify-resume is settled as well', async () => {
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', status: 'COMPLETED' }); // no pr
      // The base row of that task: a run that paused to ask a question.
      const indexOnly = ddbSend.getMockImplementation()!;
      ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => (
        (cmd.input.Key as { task_id?: string } | undefined)?.task_id === 'task-solo'
          ? { Item: { workflow_ref: 'coding/new-task-v1', code_changed: false, answer_text: 'Which environment?', task_description: 'ABC-42: Deploy it' } }
          : indexOnly(cmd)));
      createTaskCoreMock.mockResolvedValueOnce(BUDGET_REFUSAL);
      await handler(eventWith(comment({ data: { id: 'comment-1', body: '@bgagent staging', issueId: 'sub-issue-1' } })));
      // It is the resume that was refused, not a context-free new task.
      expect(createTaskCoreMock.mock.calls[0][0].task_description).toContain('The reviewer answered: staging');
      expectAckSettledAsFailed(/monthly budget is exhausted/);
    });

    test('a file in the comment that cannot be screened turns the "On it" reply into the reason', async () => {
      // Attachment screening is not configured in this file, so an uploaded file is
      // refused (fail-closed) after the acknowledgement was posted.
      mockStandaloneOnly({ task_id: 'task-solo', user_id: 'u-solo', repo: 'o/r', pr_number: 99 });
      await handler(eventWith(comment({
        data: { id: 'comment-1', body: '@bgagent still broken, see ![shot](https://uploads.linear.app/a/b/c)', issueId: 'sub-issue-1' },
      })));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expectAckSettledAsFailed(/attachment screening is not configured/);
    });
  });

  // An @bgagent comment left on the PARENT epic (the panel lives
  // there) routes to the sub-issue it names — instead of the old silent drop.
  describe('parent-epic @bgagent comment routing', () => {
    /** Mock so the COMMENTED issue id is itself the orchestration parent. The
     *  fan-out epic has two started sub-issues (footer + newsletter), and the
     *  rows of `moreChildren` after them; `moreMeta` is added to its meta row. */
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
      // Stateful ack-claim: the conditional Update on ack#<comment>
      // succeeds the FIRST time and ConditionalCheckFailed on every redelivery.
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
        if (cmd._type === 'Query') return { Items: [meta, footer, news, ...moreChildren] }; // loadOrchestration (parent's own)
        if (cmd._type === 'Get') {
          const key = cmd.input.Key as { task_id?: string; sub_issue_id?: string; linear_identity?: string };
          // Comment-trigger authorization: mapped commenter (auth gate passes).
          if (key.linear_identity) return { Item: { platform_user_id: 'commenter-user', status: 'active' } };
          const tid = key.task_id;
          const pr = tid === 'task-footer' ? 193 : tid === 'task-news' ? 192 : null;
          return { Item: pr ? { pr_number: pr } : {} };
        }
        return {};
      });
    }

    /**
     * Like {@link mockParentEpic} but the graph also has the synthetic integration
     * node — the fan-out shape, where the combined PR is the only place a
     * cross-sibling defect can be reproduced.
     */
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

    /** A comment ON the parent epic (issueId === the parent id). */
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
      // The incident: an API child and a UI child disagreed on a contract, the
      // symptom only appeared once merged, and the reviewer's comment on the epic
      // was routed to the UI child — whose PR does not even contain the backend
      // code being described. The agent then changed how the error was displayed.
      //
      // Naming the integration node explicitly must reach the combined PR, which is
      // the only place both sides of the boundary exist.
      mockParentEpicWithIntegration('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent integration: the dates come back empty for Kyoto')));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [body, ctx] = createTaskCoreMock.mock.calls[0];
      expect(body.workflow_ref).toBe('coding/pr-iteration-v1');
      // 560 = the integration node's PR. 557/558 are the child PRs it must NOT pick.
      expect(body.pr_number).toBe(560);
      expect(ctx.channelMetadata.orchestration_sub_issue_id).toBe('orch_x__integration');
      // The prompt must tell the agent this is the combined branch and that a clean
      // merge is not evidence — otherwise it does the locally-sensible thing.
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
      // The integration node has no Linear issue — its id is a derived string. Any
      // reaction or comment addressed to it fails, so both the reply target and the
      // agent's own issue id must be the epic.
      mockParentEpicWithIntegration('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent integration: dates are empty')));
      const ctx = createTaskCoreMock.mock.calls[0][1];
      expect(ctx.channelMetadata.trigger_comment_issue_id).toBe('PARENT-EPIC');
      expect(ctx.channelMetadata.linear_issue_id).toBe('PARENT-EPIC');
      expect(ctx.channelMetadata.linear_issue_id).not.toContain('__integration');
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'eyes');
    });

    test('a redelivered integration comment creates ONE iteration, not two', async () => {
      // Linear retries webhooks. The ack claim is the guard; without it a retry
      // spawns a second iteration on the same combined PR, and two agents push to
      // one branch.
      mockParentEpicWithIntegration('PARENT-EPIC');
      const evt = eventWith(parentComment('@bgagent integration: dates are empty', 'pc-dup'));
      await handler(evt);
      await handler(evt);
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    });

    test('the disambiguation reply offers integration ONLY when the node exists', async () => {
      // With an integration node: an ambiguous comment still asks (never auto-routes
      // to the combined branch — a misrouted change there is the costliest to
      // unpick) but the reply now tells the user how to target it.
      mockParentEpicWithIntegration('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent please fix the thing')));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const withInt = String(replyToCommentMock.mock.calls[0][3]);
      expect(withInt).toContain('@bgagent integration: <request>');

      // Without one (a chain epic), it must not be offered — the final child IS the
      // combined result, so there is nothing separate to target.
      jest.clearAllMocks();
      mockParentEpic('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent please fix the thing', 'pc-2')));
      const noInt = String(replyToCommentMock.mock.calls[0][3]);
      expect(noInt).not.toMatch(/integration/i);
    });

    test('a natural-language target on the epic ("for the footer ...") → iterates that sub-issue\'s PR', async () => {
      mockParentEpic('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent for the footer can you change it to "unforgettable memories await you"')));

      // 👀 on the parent comment (never a silent drop).
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'eyes');
      // Routed to the footer sub-issue's PR with the cascade marker.
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [body, ctx] = createTaskCoreMock.mock.calls[0];
      expect(body.workflow_ref).toBe('coding/pr-iteration-v1');
      expect(body.pr_number).toBe(193);
      expect(ctx.channelMetadata.orchestration_sub_issue_id).toBe('sub-footer');
      expect(ctx.channelMetadata.orchestration_iteration).toBe('true');
      expect(ctx.channelMetadata.linear_issue_id).toBe('sub-footer');
      // The trigger comment lives on the PARENT epic, so the reply
      // must target the parent issue (not the sub-issue) — else Linear rejects it.
      expect(ctx.channelMetadata.trigger_comment_issue_id).toBe('PARENT-EPIC');
      expect(ctx.channelMetadata.trigger_comment_id).toBe('pc-1');
      // No disambiguation reply — we acted.
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
      // Acked, but did not act.
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'eyes');
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      // Posted a disambiguation reply on the parent — never a silent drop.
      expect(replyToCommentMock).toHaveBeenCalledTimes(1);
      const [, issueId, , replyBody] = replyToCommentMock.mock.calls[0];
      expect(issueId).toBe('PARENT-EPIC');
      expect(replyBody).toContain('ABCA-305');
      expect(replyBody).toContain('ABCA-306');
      expect(replyBody.toLowerCase()).toContain('new work'); // the create-a-sub-issue path
      // A question is not work-in-progress — the 👀 is swapped to ❓.
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'question');
    });

    test('no-match comment on the epic → 👀 + reply (never a silent drop), no task', async () => {
      mockParentEpic('PARENT-EPIC');
      await handler(eventWith(parentComment('@bgagent looks great, ship it')));
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'eyes');
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(replyToCommentMock).toHaveBeenCalledTimes(1);
      // 👀 → ❓ once we know we're only asking, not working.
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'question');
    });

    test('new work asked for on the epic → the reply names the label this project triggers on', async () => {
      // The label is set per project and stored on the epic when it is seeded. A
      // reply that names another one sends the user to a label that starts nothing.
      mockParentEpic('PARENT-EPIC', [], { trigger_label: 'ship-it' });
      await handler(eventWith(parentComment('@bgagent add a changelog page')));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const replyBody = String(replyToCommentMock.mock.calls[0][3]);
      expect(replyBody).toContain('create a new sub-issue under this epic, then remove and re-apply the `ship-it` label on this epic');
      expect(replyBody).not.toContain('abca');
    });

    test('a FAILED sub-issue PR read ANSWERS the user and flips 👀 → ❓ (never a permanent 👀)', async () => {
      // The counterpart to the issue-parent site, which throws to earn a retry.
      // Here the one-time ack claim is already won and the 👀 already posted, and
      // `claimCommentAck` is never released — so a throw would be re-driven into
      // the `!won` no-op branch, leaving the comment marked "being worked on"
      // forever with no reply. The only durable outcome is a visible one.
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

      // Did not iterate on a PR number it could not read, and did not throw.
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      // Answered on the epic, threaded under the triggering comment.
      expect(replyToCommentMock).toHaveBeenCalledTimes(1);
      const [, issueId, , replyBody] = replyToCommentMock.mock.calls[0];
      expect(issueId).toBe('PARENT-EPIC');
      expect(String(replyBody)).toMatch(/couldn't read/i);
      expect(String(replyBody)).toMatch(/comment again/i);
      // Must NOT report the distinct, misleading "no PR yet" state.
      expect(String(replyBody)).not.toMatch(/nothing to iterate/i);
      // 👀 → ❓, so the comment does not read as still-in-progress.
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'pc-prfail', 'question');
    });

    // The reviewer NAMED a sub-issue and exactly one matched. When that one has no
    // pull request to iterate, the answer is its state. It used to be the "which
    // sub-issue?" question: "I couldn't tell which sub-issue that's about", then a
    // "did you mean" that is scored on title words — so it offered the sub-issue
    // the reviewer had just named, or a different one.
    describe('a comment on the epic that names one sub-issue which has no pull request', () => {
      /** The epic with a third sub-issue, ABCA-307, after the two started ones. */
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

      /** One reply on the epic that names the sub-issue and asks nothing, a ❓, and no task. */
      function expectStateOfNamedSubIssue(name = 'ABCA-307'): string {
        expect(createTaskCoreMock).not.toHaveBeenCalled();
        expect(upsertThreadedReplyMock).not.toHaveBeenCalled(); // no "On it": nothing is being worked on
        expect(replyToCommentMock).toHaveBeenCalledTimes(1);
        const [, issueId, parentCommentId, body] = replyToCommentMock.mock.calls[0];
        expect(issueId).toBe('PARENT-EPIC');
        expect(parentCommentId).toBe('pc-1');
        expect(String(body)).toContain(`**${name}**`);
        expect(String(body)).not.toMatch(/couldn't tell|Did you mean/);
        // Linear delivers the reply back; it must not read as a request itself.
        expect(isBotAuthoredComment(String(body))).toBe(true);
        expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'pc-1', 'question');
        return String(body);
      }

      test('a sub-issue the epic has not started: says so, and offers no other sub-issue', async () => {
        mockEpicWithUploads({ child_status: 'blocked' }); // no task yet
        // "footer" is a title word of ABCA-305, which is what the "did you mean" offered.
        await handler(eventWith(parentComment('@bgagent ABCA-307: keep the retry notice out of the footer')));
        const reply = expectStateOfNamedSubIssue();
        expect(reply).toMatch(/hasn't started yet/);
        expect(reply).not.toContain('ABCA-305');
      });

      test('a sub-issue that was skipped: says it did not run, and how to re-run', async () => {
        mockEpicWithUploads({ child_status: 'skipped' }); // a sub-issue it depends on failed
        await handler(eventWith(parentComment('@bgagent ABCA-307: use the new API client')));
        const reply = expectStateOfNamedSubIssue();
        expect(reply).toMatch(/did not run/);
        expect(reply).toContain('`@bgagent retry`');
      });

      test('a started sub-issue without a pull request: says so, whether or not its run has ended', async () => {
        mockEpicWithUploads({ child_status: 'released', child_task_id: 'task-uploads' }); // its task has no PR
        await handler(eventWith(parentComment('@bgagent ABCA-307: use a darker blue')));
        const reply = expectStateOfNamedSubIssue();
        expect(reply).toMatch(/no pull request, so there's nothing to iterate on/);
        // A run that ended without a pull request will never have one: no "yet".
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
        // An epic seeded before the label was stored: the platform default.
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
        // The integration node has no identifier; "integration" is the word that names it.
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
      // Linear redelivers the same comment webhook 3× (handler exceeded its ack window).
      await handler(evt);
      await handler(evt);
      await handler(evt);
      // The conditional ack-claim lets only the FIRST delivery act: one 👀, one reply.
      expect(replyToCommentMock).toHaveBeenCalledTimes(1);
      expect(reactToCommentMock).toHaveBeenCalledTimes(1);
    });

    test('a matched-iteration parent comment also dedups under redelivery (one task, one ack)', async () => {
      mockParentEpic('PARENT-EPIC');
      const evt = eventWith(parentComment('@bgagent for the footer change the tagline', 'pc-iter'));
      await handler(evt);
      await handler(evt);
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1); // one iteration, not two
      expect(reactToCommentMock).toHaveBeenCalledTimes(1);
    });

    // "@bgagent retry" on a FAILED epic must run the epic-retry machinery
    // (reset + re-release the failed child), NOT answer with the
    // disambiguation reply — that left the user in a loop. One failed + one
    // succeeded child: retry re-runs ONLY the failed one, and the succeeded
    // one is kept.
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
          // ack + retry claim rows: first wins, redelivery ConditionalCheckFailed.
          if (sk.startsWith('ack#') || sk.startsWith('retry:') || sk === '#rollup-claim') {
            if (claimedAcks.has(sk)) {
              throw Object.assign(new Error('claim exists'), { name: 'ConditionalCheckFailedException' });
            }
            claimedAcks.add(sk);
          }
          // A title and description that are stored are there for the next read.
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
      // Acked with 👀 (work in flight) — kept, NOT swapped to ❓ (that was the
      // dead-end path). No disambiguation reply.
      expect(reactToCommentMock).toHaveBeenCalledWith(expect.anything(), 'pc-retry', 'eyes');
      expect(replyToCommentMock).not.toHaveBeenCalled();
      // The failed child was re-released: createTaskCore called for it, with its
      // prior failed task id salted into the idempotency key so a NEW task spawns.
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [, ctx] = createTaskCoreMock.mock.calls[0];
      expect(ctx.idempotencyKey).toContain('task-bad-1'); // salted with the dead task
    });

    // A sub-issue is started from the title and description stored on its row,
    // which the first read of the epic wrote. One that was refused for its text
    // and then reworded was sent again as it was, on every retry.
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
        // The row of the sub-issue that succeeded is not written.
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
      mockParentEpic('PARENT-EPIC'); // both children succeeded
      await handler(eventWith(parentComment('@bgagent retry', 'pc-retry-2')));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(replyToCommentMock).toHaveBeenCalledTimes(1);
      const [, , , replyBody] = replyToCommentMock.mock.calls[0];
      expect(String(replyBody).toLowerCase()).toContain('nothing to retry');
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'pc-retry-2', 'question');
    });

    test('a refused iteration routed from the epic is settled on the epic, where the comment lives', async () => {
      // The "On it" reply and the 👀 were posted on the epic before createTaskCore
      // refused; with no task, only this dispatch can turn them into the reason.
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
