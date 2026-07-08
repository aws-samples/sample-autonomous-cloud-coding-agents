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
 * #299 plan-mode T4/T5 — the direct-manipulation command path through the real
 * webhook handler (handleCommentTrigger → handlePlanCommand). Isolated in its own
 * file so it can set ORCHESTRATION_TABLE_NAME (which arms the whole Mode B comment
 * path) before importing the module, without perturbing the main
 * linear-webhook-processor test's env.
 *
 * The [[feedback_test_mock_layer]] lesson: drive the REAL seam (the exported
 * handler over a Comment payload) rather than calling the pure command core —
 * these assert that a structural command edits the pending plan in place with NO
 * agent task created, and that the collapse/error guards leave the plan untouched.
 */

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

const reactToCommentMock = jest.fn();
const upsertStatusCommentMock = jest.fn();
const swapCommentReactionMock = jest.fn();
const sweepDecompositionNotesMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => {
  const actual = jest.requireActual('../../src/handlers/shared/linear-feedback');
  return {
    ...actual,
    reactToComment: (...args: unknown[]) => reactToCommentMock(...args),
    upsertStatusComment: (...args: unknown[]) => upsertStatusCommentMock(...args),
    swapCommentReaction: (...args: unknown[]) => swapCommentReactionMock(...args),
    // #299 plan-cleanup: the sweep hits the network (list + delete comments);
    // stub it so verdict tests don't fetch, and we can assert it fired.
    sweepDecompositionNotes: (...args: unknown[]) => sweepDecompositionNotesMock(...args),
  };
});

const resolveLinearOauthTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: (...args: unknown[]) => resolveLinearOauthTokenMock(...args),
}));

process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'LinearProjects';
process.env.LINEAR_USER_MAPPING_TABLE_NAME = 'LinearUsers';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
process.env.ORCHESTRATION_TABLE_NAME = 'OrchestrationTable';
process.env.TASK_TABLE_NAME = 'TaskTable';

import { handler } from '../../src/handlers/linear-webhook-processor';
import { PENDING_PLAN_SK } from '../../src/handlers/shared/orchestration-decomposition-store';

/** A 3-node pending plan: n0 root, n1←n0, n2←n0. */
function pendingPlanItem(): Record<string, unknown> {
  return {
    orchestration_id: 'orch_x',
    sub_issue_id: PENDING_PLAN_SK,
    parent_linear_issue_id: 'parent-1',
    linear_workspace_id: 'org-1',
    repo: 'o/r',
    linear_project_id: 'project-1',
    platform_user_id: 'user-1',
    proposal_comment_id: 'comment-plan-1',
    nodes: [
      { title: 'Foundation', description: 'core', size: 'S', max_budget_usd: 1, depends_on: [] },
      { title: 'Feature A', description: 'a', size: 'M', max_budget_usd: 3, depends_on: [0] },
      { title: 'Feature B', description: 'b', size: 'M', max_budget_usd: 3, depends_on: [0] },
    ],
    created_at: '2026-07-06T00:00:00.000Z',
  };
}

function commentEvent(body: string): { raw_body: string } {
  return {
    raw_body: JSON.stringify({
      action: 'create',
      type: 'Comment',
      organizationId: 'org-1',
      actor: { id: 'user-1' },
      data: { id: 'cmd-comment-1', body, issueId: 'parent-1' },
    }),
  };
}

/** Route DDB sends: Get(pending-plan) → the plan; Update(claim ack) → success; Put → success. */
function wireDdb(planItem: Record<string, unknown> | undefined): void {
  ddbSend.mockImplementation((cmd: { _type?: string }) => {
    if (cmd._type === 'Get') return Promise.resolve({ Item: planItem });
    if (cmd._type === 'Update') return Promise.resolve({}); // claimCommentAck wins
    if (cmd._type === 'Put') return Promise.resolve({}); // replacePendingPlan
    return Promise.resolve({});
  });
}

describe('plan-command path (T4/T5) through the real handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset();
    reactToCommentMock.mockReset().mockResolvedValue(undefined);
    upsertStatusCommentMock.mockReset().mockResolvedValue('comment-plan-1');
    swapCommentReactionMock.mockReset().mockResolvedValue(undefined);
    resolveLinearOauthTokenMock.mockReset().mockResolvedValue({
      accessToken: 'lin_at',
      workspaceSlug: 'acme',
      oauthSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-linear-oauth-acme',
    });
  });

  test('"drop 3" edits the plan IN PLACE (no agent, no fresh comment) and persists', async () => {
    wireDdb(pendingPlanItem());
    await handler(commentEvent('@bgagent drop 3'));

    // No agent task dispatched — this is a deterministic, free edit.
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    // 👀 on the command comment.
    expect(reactToCommentMock).toHaveBeenCalled();
    // F-command-ack-stuck: the 👀 must SETTLE to ✅ (white_check_mark) — not left
    // hanging as if stuck. The edit applied fine, so it's a success settle.
    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'cmd-comment-1', 'white_check_mark');
    // The re-rendered proposal leads with the computed "What changed" diff.
    const [, , dropBody] = upsertStatusCommentMock.mock.calls[0];
    expect(dropBody).toMatch(/What changed/);
    // T5: edited the existing proposal comment IN PLACE (4th arg = the stored id).
    expect(upsertStatusCommentMock).toHaveBeenCalledTimes(1);
    const [, issueId, body, existingCommentId] = upsertStatusCommentMock.mock.calls[0];
    expect(issueId).toBe('parent-1');
    expect(existingCommentId).toBe('comment-plan-1');
    // Re-rendered proposal now has 2 sub-issues (dropped one of three).
    expect(body).toMatch(/2 sub-issues/);
    // Persisted the edited node list (a Put to the pending-plan row).
    const putCalls = ddbSend.mock.calls.filter((c) => c[0]?._type === 'Put');
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
    const putNodes = putCalls[putCalls.length - 1][0].input.Item.nodes;
    expect(putNodes).toHaveLength(2);
  });

  test('"merge 2 and 3" collapses toward one feature but stays ≥2 (foundation + merged)', async () => {
    wireDdb(pendingPlanItem());
    await handler(commentEvent('@bgagent merge 2 and 3'));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    const putCalls = ddbSend.mock.calls.filter((c) => c[0]?._type === 'Put');
    const putNodes = putCalls[putCalls.length - 1][0].input.Item.nodes;
    expect(putNodes).toHaveLength(2); // foundation + (A+B merged)
    expect(putNodes[1].title).toBe('Feature A + Feature B');
  });

  test('a command that would collapse to <2 → note, plan NOT persisted', async () => {
    wireDdb(pendingPlanItem());
    await handler(commentEvent('@bgagent drop 2, 3')); // leaves only the foundation
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    // Posted a note (fresh comment, no existingCommentId), and did NOT Put a new plan.
    expect(upsertStatusCommentMock).toHaveBeenCalled();
    const putCalls = ddbSend.mock.calls.filter((c) => c[0]?._type === 'Put');
    expect(putCalls).toHaveLength(0);
  });

  test('an out-of-range index → error note, plan NOT persisted, 👀 settled to ❓', async () => {
    wireDdb(pendingPlanItem());
    await handler(commentEvent('@bgagent drop 9'));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    const [, , body] = upsertStatusCommentMock.mock.calls[0];
    expect(body).toMatch(/no sub-issue #9/i);
    const putCalls = ddbSend.mock.calls.filter((c) => c[0]?._type === 'Put');
    expect(putCalls).toHaveLength(0);
    // F-command-ack-stuck: a bad command settles 👀→❓ (needs the reviewer), not stuck.
    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'cmd-comment-1', 'question');
  });

  test('"make #2 small" edits size in place, no agent', async () => {
    wireDdb(pendingPlanItem());
    await handler(commentEvent('@bgagent make #2 small'));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    const putCalls = ddbSend.mock.calls.filter((c) => c[0]?._type === 'Put');
    const putNodes = putCalls[putCalls.length - 1][0].input.Item.nodes;
    expect(putNodes).toHaveLength(3); // size doesn't change count
    expect(putNodes[1].size).toBe('S');
    expect(putNodes[1].max_budget_usd).toBe(1);
  });
});

describe('graph verdict cleanup (#299 plan-cleanup) through the real handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset();
    reactToCommentMock.mockReset().mockResolvedValue(undefined);
    upsertStatusCommentMock.mockReset().mockResolvedValue('comment-plan-1');
    sweepDecompositionNotesMock.mockReset().mockResolvedValue(2);
    resolveLinearOauthTokenMock.mockReset().mockResolvedValue({
      accessToken: 'lin_at',
      workspaceSlug: 'acme',
      oauthSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-linear-oauth-acme',
    });
    // Get → the GRAPH pending plan; Update(claim) → win; Delete(consume for reject) → ALL_OLD.
    ddbSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'Get') return Promise.resolve({ Item: pendingPlanItem() });
      if (cmd._type === 'Update') return Promise.resolve({});
      if (cmd._type === 'Delete') return Promise.resolve({ Attributes: pendingPlanItem() });
      return Promise.resolve({});
    });
  });

  test('reject on a GRAPH pending plan → freezes the plan comment to "discarded" + sweeps the notes', async () => {
    await handler(commentEvent('@bgagent reject'));
    // No graph seeded (nothing to write back), nothing dispatched.
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    // cleanupPlanThread: the proposal comment is EDITED IN PLACE (4th arg = its id)
    // to the frozen "discarded" reference.
    const freezeCall = upsertStatusCommentMock.mock.calls.find((c) => c[3] === 'comment-plan-1');
    expect(freezeCall).toBeDefined();
    expect(freezeCall![2]).toMatch(/discarded/i);
    // …and the transient notes are swept, keeping that frozen reference.
    expect(sweepDecompositionNotesMock).toHaveBeenCalledWith(expect.anything(), 'parent-1', 'comment-plan-1');
  });
});

/** A SINGLE-task pending plan (a :decompose that declined to split — F-single-gate). */
function singlePendingItem(): Record<string, unknown> {
  return {
    orchestration_id: 'orch_x',
    sub_issue_id: PENDING_PLAN_SK,
    parent_linear_issue_id: 'parent-1',
    linear_workspace_id: 'org-1',
    repo: 'o/r',
    linear_project_id: 'project-1',
    platform_user_id: 'user-1',
    nodes: [],
    pending_kind: 'single',
    single_task_description: 'ABC-1: add the amplify build spec',
    created_at: '2026-07-07T00:00:00.000Z',
  };
}

describe('single-task verdict path (F-single-gate) through the real handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset().mockResolvedValue({ statusCode: 201, body: '' });
    reactToCommentMock.mockReset().mockResolvedValue(undefined);
    upsertStatusCommentMock.mockReset().mockResolvedValue('c-1');
    sweepDecompositionNotesMock.mockReset().mockResolvedValue(0);
    resolveLinearOauthTokenMock.mockReset().mockResolvedValue({
      accessToken: 'lin_at',
      workspaceSlug: 'acme',
      oauthSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-linear-oauth-acme',
    });
    // Get → the single pending plan; Update(claim) → win; Delete(consume) → ALL_OLD.
    ddbSend.mockImplementation((cmd: { _type?: string; input?: { Key?: unknown } }) => {
      if (cmd._type === 'Get') return Promise.resolve({ Item: singlePendingItem() });
      if (cmd._type === 'Update') return Promise.resolve({});
      if (cmd._type === 'Delete') return Promise.resolve({ Attributes: singlePendingItem() });
      return Promise.resolve({});
    });
  });

  test('approve on a single pending plan → runs ONE coding task (no seed), carries the stored description', async () => {
    await handler(commentEvent('@bgagent approve'));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [req, ctx] = createTaskCoreMock.mock.calls[0];
    // A single coding task — NOT a decompose-v1 re-plan, NOT a graph seed.
    expect(req.workflow_ref).toBeUndefined(); // default coding/new-task-v1
    expect(req.task_description).toBe('ABC-1: add the amplify build spec');
    expect(ctx.channelSource).toBe('linear');
    expect(ctx.channelMetadata.linear_issue_id).toBe('parent-1');
    // Consumed the pending plan (a Delete fired).
    expect(ddbSend.mock.calls.some((c) => c[0]?._type === 'Delete')).toBe(true);
    // #299 plan-cleanup: the transient planning notes are swept once the task runs.
    expect(sweepDecompositionNotesMock).toHaveBeenCalledWith(expect.anything(), 'parent-1');
  });

  test('reject on a single pending plan → discards, runs nothing', async () => {
    await handler(commentEvent('@bgagent reject'));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(ddbSend.mock.calls.some((c) => c[0]?._type === 'Delete')).toBe(true);
    const note = upsertStatusCommentMock.mock.calls.map((c) => c[2]).join(' ');
    expect(note).toMatch(/cancelled/i);
    // #299 plan-cleanup: sweep fires BEFORE the durable "cancelled" note is posted,
    // so the note (posted fresh, after) survives.
    expect(sweepDecompositionNotesMock).toHaveBeenCalledWith(expect.anything(), 'parent-1');
  });
});
