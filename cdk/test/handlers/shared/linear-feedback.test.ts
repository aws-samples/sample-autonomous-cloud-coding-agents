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

const resolveLinearOauthTokenMock = jest.fn();
jest.mock('../../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: (...args: unknown[]) => resolveLinearOauthTokenMock(...args),
}));

const fetchMock = jest.fn();
// `fetch` is a global on Node 24; reassign for test isolation.
(globalThis as unknown as { fetch: jest.Mock }).fetch = fetchMock;

import {
  addIssueReaction,
  appendOnceToComment,
  type LinearFeedbackContext,
  deleteComment,
  fetchRecentComments,
  postIssueComment,
  reactToComment,
  replyToComment,
  reportIssueFailure,
  revertIssueToNotStarted,
  sweepDecompositionNotes,
  swapCommentReaction,
  swapIssueReaction,
  transitionIssueState,
  upsertStatusComment,
  upsertThreadedReply,
} from '../../../src/handlers/shared/linear-feedback';

const CTX: LinearFeedbackContext = {
  linearWorkspaceId: 'ws-uuid-1',
  registryTableName: 'TestLinearWorkspaceRegistry',
};
const ISSUE_ID = 'issue-1';
const TOKEN = 'lin_oauth_TESTTOKEN';

function jsonResponse(body: unknown, status: number = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('linear-feedback', () => {
  beforeEach(() => {
    resolveLinearOauthTokenMock.mockReset();
    fetchMock.mockReset();
    resolveLinearOauthTokenMock.mockResolvedValue({
      accessToken: TOKEN,
      scope: 'read write',
      workspaceSlug: 'acme',
      oauthSecretArn: 'arn:secret:acme',
    });
    fetchMock.mockResolvedValue(jsonResponse({ data: { commentCreate: { success: true } } }));
  });

  describe('postIssueComment', () => {
    test('POSTs the commentCreate mutation with the issue id and body', async () => {
      const result = await postIssueComment(CTX, ISSUE_ID, '❌ blocked');

      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.linear.app/graphql');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        // OAuth tokens use Bearer prefix per Phase 2.0b-O2.
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      });
      const body = JSON.parse(init.body as string) as { query: string; variables: Record<string, string> };
      expect(body.query).toContain('commentCreate');
      expect(body.variables).toEqual({ issueId: ISSUE_ID, body: '❌ blocked' });
    });

    test('terminal failure (not retryable) when the token cannot be resolved', async () => {
      resolveLinearOauthTokenMock.mockResolvedValueOnce(null);

      const result = await postIssueComment(CTX, ISSUE_ID, 'msg');

      expect(result).toEqual({ ok: false, retryable: false });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('retryable failure on 5xx response (no throw)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));

      const result = await postIssueComment(CTX, ISSUE_ID, 'msg');

      expect(result).toEqual({ ok: false, retryable: true });
    });

    test('retryable failure on 429 rate limit (no throw)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 429));

      const result = await postIssueComment(CTX, ISSUE_ID, 'msg');

      expect(result).toEqual({ ok: false, retryable: true });
    });

    test('terminal failure on auth-shaped non-2xx (401)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));

      const result = await postIssueComment(CTX, ISSUE_ID, 'msg');

      expect(result).toEqual({ ok: false, retryable: false });
    });

    test('terminal failure on GraphQL errors (no throw)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'auth' }] }));

      const result = await postIssueComment(CTX, ISSUE_ID, 'msg');

      expect(result).toEqual({ ok: false, retryable: false });
    });

    test('retryable failure on network failure (swallowed)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

      const result = await postIssueComment(CTX, ISSUE_ID, 'msg');

      expect(result).toEqual({ ok: false, retryable: true });
    });

    test('terminal failure when resolveLinearOauthToken throws (swallowed at resolveToken layer)', async () => {
      resolveLinearOauthTokenMock.mockRejectedValueOnce(new Error('AccessDenied'));

      const result = await postIssueComment(CTX, ISSUE_ID, 'msg');

      expect(result).toEqual({ ok: false, retryable: false });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('addIssueReaction', () => {
    test('defaults to ❌ (emoji short-code "x")', async () => {
      await addIssueReaction(CTX, ISSUE_ID);

      const init = fetchMock.mock.calls[0][1];
      const body = JSON.parse(init.body as string) as { query: string; variables: { emoji: string } };
      expect(body.query).toContain('reactionCreate');
      expect(body.variables.emoji).toBe('x');
    });

    test('honours an explicit emoji argument', async () => {
      await addIssueReaction(CTX, ISSUE_ID, 'eyes');

      const init = fetchMock.mock.calls[0][1];
      const body = JSON.parse(init.body as string) as { variables: { emoji: string } };
      expect(body.variables.emoji).toBe('eyes');
    });
  });

  describe('reactToComment (#247 UX.3 — instant "on it" ack on a comment)', () => {
    test('reacts on the COMMENT (commentId), defaulting to 👀 (eyes)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { reactionCreate: { success: true } } }));

      const ok = await reactToComment(CTX, 'comment-77');

      expect(ok).toBe(true);
      const init = fetchMock.mock.calls[0][1];
      const body = JSON.parse(init.body as string) as { query: string; variables: { commentId: string; emoji: string } };
      expect(body.query).toContain('reactionCreate');
      // The variable is commentId — NOT issueId (reacts on the comment, not the issue).
      expect(body.variables.commentId).toBe('comment-77');
      expect(body.variables.emoji).toBe('eyes');
    });

    test('honours an explicit emoji argument', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { reactionCreate: { success: true } } }));
      await reactToComment(CTX, 'comment-77', 'white_check_mark');
      const init = fetchMock.mock.calls[0][1];
      const body = JSON.parse(init.body as string) as { variables: { emoji: string } };
      expect(body.variables.emoji).toBe('white_check_mark');
    });

    test('returns false when the token cannot be resolved (no fetch)', async () => {
      resolveLinearOauthTokenMock.mockResolvedValueOnce(null);
      const ok = await reactToComment(CTX, 'comment-77');
      expect(ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('returns false on network failure (swallowed)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      const ok = await reactToComment(CTX, 'comment-77');
      expect(ok).toBe(false);
    });
  });

  describe('replyToComment (#247 UX.3 — threaded reply that notifies)', () => {
    test('POSTs commentCreate with BOTH issueId and parentId, returns the new reply id', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { commentCreate: { success: true, comment: { id: 'reply-99' } } } }));

      const replyId = await replyToComment(CTX, ISSUE_ID, 'comment-77', '✅ Updated — PR #178');

      expect(replyId).toBe('reply-99');
      const init = fetchMock.mock.calls[0][1];
      const body = JSON.parse(init.body as string) as { query: string; variables: { issueId: string; parentId: string; body: string } };
      expect(body.query).toContain('commentCreate');
      // CONTRACT (live-verified 2026-06-16): Linear's commentCreate REQUIRES
      // issueId even for a threaded reply — parentId alone fails argument
      // validation. Pin BOTH so the missing-issueId regression can't return.
      expect(body.variables.issueId).toBe(ISSUE_ID);
      expect(body.variables.parentId).toBe('comment-77');
      expect(body.variables.body).toBe('✅ Updated — PR #178');
    });

    test('the mutation declares issueId as a required argument (regression guard)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { commentCreate: { success: true, comment: { id: 'r' } } } }));
      await replyToComment(CTX, ISSUE_ID, 'comment-77', 'body');
      const init = fetchMock.mock.calls[0][1];
      const query = (JSON.parse(init.body as string) as { query: string }).query;
      // The GraphQL op must pass issueId INTO commentCreate's input — not just
      // accept it as a variable. Catches a half-fix that drops it from input.
      expect(query).toMatch(/commentCreate\(\s*input:\s*\{[^}]*issueId:\s*\$issueId/);
    });

    test('returns null when commentCreate did not succeed', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { commentCreate: { success: false } } }));
      const replyId = await replyToComment(CTX, ISSUE_ID, 'comment-77', 'body');
      expect(replyId).toBeNull();
    });

    test('returns null on GraphQL errors (no throw)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'parent not found' }] }));
      const replyId = await replyToComment(CTX, ISSUE_ID, 'comment-77', 'body');
      expect(replyId).toBeNull();
    });

    test('returns null when the token cannot be resolved (no fetch)', async () => {
      resolveLinearOauthTokenMock.mockResolvedValueOnce(null);
      const replyId = await replyToComment(CTX, ISSUE_ID, 'comment-77', 'body');
      expect(replyId).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('reportIssueFailure', () => {
    test('posts comment + ❌ in parallel via Promise.allSettled', async () => {
      await reportIssueFailure(CTX, ISSUE_ID, '❌ failed');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const queries = fetchMock.mock.calls.map((c) => {
        const init = c[1];
        return JSON.parse(init.body as string).query as string;
      });
      expect(queries.some((q) => q.includes('commentCreate'))).toBe(true);
      expect(queries.some((q) => q.includes('reactionCreate'))).toBe(true);
    });

    test('does not throw when one leg fails (partial-success semantics)', async () => {
      // First call (comment) fails; second (reaction) succeeds.
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse({ data: { reactionCreate: { success: true } } }));

      await expect(reportIssueFailure(CTX, ISSUE_ID, 'msg')).resolves.toBeUndefined();
    });

    test('does not throw when both legs fail', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));

      await expect(reportIssueFailure(CTX, ISSUE_ID, 'msg')).resolves.toBeUndefined();
    });
  });

  describe('swapIssueReaction (one marker at a time, #3)', () => {
    const reactionsResp = (rs: Array<{ id: string; emoji: string }>) =>
      jsonResponse({ data: { issue: { reactions: rs } } });

    test('👀 present → deletes it and adds the target (✅)', async () => {
      fetchMock
        .mockResolvedValueOnce(reactionsResp([{ id: 'r-eyes', emoji: 'eyes' }])) // query
        .mockResolvedValueOnce(jsonResponse({ data: { reactionDelete: { success: true } } })) // delete 👀
        .mockResolvedValueOnce(jsonResponse({ data: { reactionCreate: { success: true } } })); // add ✅
      const ok = await swapIssueReaction(CTX, ISSUE_ID, 'white_check_mark');
      expect(ok).toBe(true);
      const deleteVars = JSON.parse(fetchMock.mock.calls[1][1].body).variables;
      expect(deleteVars).toEqual({ id: 'r-eyes' });
      const createVars = JSON.parse(fetchMock.mock.calls[2][1].body).variables;
      expect(createVars).toEqual({ issueId: ISSUE_ID, emoji: 'white_check_mark' });
    });

    test('target already present → deletes other bgagent markers, does NOT re-create', async () => {
      fetchMock
        .mockResolvedValueOnce(reactionsResp([
          { id: 'r-eyes', emoji: 'eyes' },
          { id: 'r-check', emoji: 'white_check_mark' },
        ]))
        .mockResolvedValueOnce(jsonResponse({ data: { reactionDelete: { success: true } } })); // delete 👀 only
      const ok = await swapIssueReaction(CTX, ISSUE_ID, 'white_check_mark');
      expect(ok).toBe(true);
      // 1 query + 1 delete (the 👀); no create (✅ already there).
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables).toEqual({ id: 'r-eyes' });
    });

    test('never deletes a human (non-bgagent) reaction', async () => {
      fetchMock
        .mockResolvedValueOnce(reactionsResp([
          { id: 'r-eyes', emoji: 'eyes' },
          { id: 'r-tada', emoji: 'tada' }, // human reaction — must survive
        ]))
        .mockResolvedValueOnce(jsonResponse({ data: { reactionDelete: { success: true } } })) // delete 👀
        .mockResolvedValueOnce(jsonResponse({ data: { reactionCreate: { success: true } } })); // add ✅
      await swapIssueReaction(CTX, ISSUE_ID, 'white_check_mark');
      const deletedIds = fetchMock.mock.calls
        .filter((c) => JSON.parse(c[1].body).query.includes('reactionDelete'))
        .map((c) => JSON.parse(c[1].body).variables.id);
      expect(deletedIds).toEqual(['r-eyes']); // only the bgagent marker, never r-tada
    });

    test('no existing markers → just adds the target', async () => {
      fetchMock
        .mockResolvedValueOnce(reactionsResp([]))
        .mockResolvedValueOnce(jsonResponse({ data: { reactionCreate: { success: true } } }));
      const ok = await swapIssueReaction(CTX, ISSUE_ID, 'eyes');
      expect(ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2); // query + create, no deletes
    });

    test('no token → false, no fetch', async () => {
      resolveLinearOauthTokenMock.mockResolvedValueOnce(null);
      expect(await swapIssueReaction(CTX, ISSUE_ID, 'eyes')).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('swapCommentReaction (#247 UX.21 — settle the trigger comment 👀→✅/❌)', () => {
    const commentReactionsResp = (rs: Array<{ id: string; emoji: string }>) =>
      jsonResponse({ data: { comment: { reactions: rs } } });

    test('👀 on the comment → deletes it and adds ✅ (on the COMMENT, not the issue)', async () => {
      fetchMock
        .mockResolvedValueOnce(commentReactionsResp([{ id: 'r-eyes', emoji: 'eyes' }]))
        .mockResolvedValueOnce(jsonResponse({ data: { reactionDelete: { success: true } } }))
        .mockResolvedValueOnce(jsonResponse({ data: { reactionCreate: { success: true } } }));
      const ok = await swapCommentReaction(CTX, 'comment-77', 'white_check_mark');
      expect(ok).toBe(true);
      // query targets the COMMENT
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables).toEqual({ commentId: 'comment-77' });
      // delete the stale 👀
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables).toEqual({ id: 'r-eyes' });
      // create the ✅ via reactionCreate(commentId)
      const createVars = JSON.parse(fetchMock.mock.calls[2][1].body).variables;
      expect(createVars).toEqual({ commentId: 'comment-77', emoji: 'white_check_mark' });
    });

    test('target already present → no re-create (idempotent under redelivery)', async () => {
      fetchMock
        .mockResolvedValueOnce(commentReactionsResp([
          { id: 'r-eyes', emoji: 'eyes' },
          { id: 'r-check', emoji: 'white_check_mark' },
        ]))
        .mockResolvedValueOnce(jsonResponse({ data: { reactionDelete: { success: true } } }));
      const ok = await swapCommentReaction(CTX, 'comment-77', 'white_check_mark');
      expect(ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2); // query + delete 👀; ✅ already present
    });

    test('never deletes a human reaction on the comment', async () => {
      fetchMock
        .mockResolvedValueOnce(commentReactionsResp([
          { id: 'r-eyes', emoji: 'eyes' },
          { id: 'r-heart', emoji: 'heart' }, // human — must survive
        ]))
        .mockResolvedValueOnce(jsonResponse({ data: { reactionDelete: { success: true } } }))
        .mockResolvedValueOnce(jsonResponse({ data: { reactionCreate: { success: true } } }));
      await swapCommentReaction(CTX, 'comment-77', 'x');
      const deletedIds = fetchMock.mock.calls
        .filter((c) => JSON.parse(c[1].body).query.includes('reactionDelete'))
        .map((c) => JSON.parse(c[1].body).variables.id);
      expect(deletedIds).toEqual(['r-eyes']); // never r-heart
    });

    test('no token → false, no fetch', async () => {
      resolveLinearOauthTokenMock.mockResolvedValueOnce(null);
      expect(await swapCommentReaction(CTX, 'comment-77', 'eyes')).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('upsertStatusComment (#3 live status block)', () => {
    test('no existing id → creates a comment and returns the new id', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { commentCreate: { success: true, comment: { id: 'cmt-new' } } } }),
      );
      const id = await upsertStatusComment(CTX, ISSUE_ID, 'body');
      expect(id).toBe('cmt-new');
      // create mutation carries issueId + body
      const vars = JSON.parse(fetchMock.mock.calls[0][1].body).variables;
      expect(vars).toEqual({ issueId: ISSUE_ID, body: 'body' });
    });

    test('existing id → edits in place and returns the same id', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { commentUpdate: { success: true } } }));
      const id = await upsertStatusComment(CTX, ISSUE_ID, 'new body', 'cmt-existing');
      expect(id).toBe('cmt-existing');
      const vars = JSON.parse(fetchMock.mock.calls[0][1].body).variables;
      expect(vars).toEqual({ id: 'cmt-existing', body: 'new body' });
    });

    test('create reporting success:false → null', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { commentCreate: { success: false } } }));
      expect(await upsertStatusComment(CTX, ISSUE_ID, 'body')).toBeNull();
    });

    test('update GraphQL failure → null (does not fabricate the id)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'not found' }] }));
      expect(await upsertStatusComment(CTX, ISSUE_ID, 'body', 'cmt-x')).toBeNull();
    });

    test('no token → null, no fetch', async () => {
      resolveLinearOauthTokenMock.mockResolvedValueOnce(null);
      expect(await upsertStatusComment(CTX, ISSUE_ID, 'body')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('deleteComment (#299 F-revise-in-place — remove the transient ack)', () => {
    test('success → true, sends commentDelete with the id', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { commentDelete: { success: true } } }));
      expect(await deleteComment(CTX, 'cmt-ack')).toBe(true);
      const vars = JSON.parse(fetchMock.mock.calls[0][1].body).variables;
      expect(vars).toEqual({ id: 'cmt-ack' });
    });

    test('GraphQL error → false (best-effort, never throws)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'not found' }] }));
      expect(await deleteComment(CTX, 'cmt-ack')).toBe(false);
    });

    test('no token → false, no fetch', async () => {
      resolveLinearOauthTokenMock.mockResolvedValueOnce(null);
      expect(await deleteComment(CTX, 'cmt-ack')).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('transitionIssueState', () => {
    // Mirrors the real ABCA team's workflow states (by type + position).
    const TEAM_STATES = [
      { id: 's-backlog', type: 'backlog', name: 'Backlog', position: 0 },
      { id: 's-todo', type: 'unstarted', name: 'Todo', position: 1 },
      { id: 's-inprogress', type: 'started', name: 'In Progress', position: 2 },
      { id: 's-inreview', type: 'started', name: 'In Review', position: 1002 },
      { id: 's-done', type: 'completed', name: 'Done', position: 3 },
    ];
    const statesResp = (current: { id: string; type: string; name: string; position: number }) =>
      jsonResponse({ data: { issue: { state: current, team: { states: { nodes: TEAM_STATES } } } } });
    const cur = (id: string) => TEAM_STATES.find((s) => s.id === id)!;

    test('Backlog → In Progress: picks the named started state, issues issueUpdate', async () => {
      fetchMock
        .mockResolvedValueOnce(statesResp(cur('s-backlog'))) // team-states query
        .mockResolvedValueOnce(jsonResponse({ data: { issueUpdate: { success: true } } }));
      const ok = await transitionIssueState(CTX, ISSUE_ID, 'started', ['In Progress']);
      expect(ok).toBe(true);
      // second call is the mutation with the resolved stateId
      const mutationVars = JSON.parse(fetchMock.mock.calls[1][1].body).variables;
      expect(mutationVars).toEqual({ issueId: ISSUE_ID, stateId: 's-inprogress' });
    });

    test('In Progress → In Review: name preference wins over position among started states', async () => {
      fetchMock
        .mockResolvedValueOnce(statesResp(cur('s-inprogress')))
        .mockResolvedValueOnce(jsonResponse({ data: { issueUpdate: { success: true } } }));
      const ok = await transitionIssueState(CTX, ISSUE_ID, 'started', ['In Review']);
      expect(ok).toBe(true);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables.stateId).toBe('s-inreview');
    });

    test('already in target state → no mutation, returns false', async () => {
      fetchMock.mockResolvedValueOnce(statesResp(cur('s-inreview')));
      const ok = await transitionIssueState(CTX, ISSUE_ID, 'started', ['In Review']);
      expect(ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1); // only the query, no mutation
    });

    test('never moves backward: Done (completed) is not demoted to In Review', async () => {
      fetchMock.mockResolvedValueOnce(statesResp(cur('s-done')));
      const ok = await transitionIssueState(CTX, ISSUE_ID, 'started', ['In Review']);
      expect(ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // review blocker #9b: the rollup re-open (In Review → In Progress, BOTH
    // 'started') was silently blocked by the same-type position tiebreak.
    test('same-type regression In Review → In Progress is BLOCKED by default', async () => {
      fetchMock.mockResolvedValueOnce(statesResp(cur('s-inreview')));
      const ok = await transitionIssueState(CTX, ISSUE_ID, 'started', ['In Progress']);
      expect(ok).toBe(false); // In Progress (pos 2) < In Review (pos 1002) → backward
      expect(fetchMock).toHaveBeenCalledTimes(1); // no mutation
    });

    test('same-type regression In Review → In Progress SUCCEEDS with allowSameTypeRegression (rollup re-open)', async () => {
      fetchMock
        .mockResolvedValueOnce(statesResp(cur('s-inreview')))
        .mockResolvedValueOnce(jsonResponse({ data: { issueUpdate: { success: true } } }));
      const ok = await transitionIssueState(CTX, ISSUE_ID, 'started', ['In Progress'], true);
      expect(ok).toBe(true);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables.stateId).toBe('s-inprogress');
    });

    test('allowSameTypeRegression does NOT permit a cross-type demotion (Done → In Progress still blocked)', async () => {
      fetchMock.mockResolvedValueOnce(statesResp(cur('s-done')));
      const ok = await transitionIssueState(CTX, ISSUE_ID, 'started', ['In Progress'], true);
      expect(ok).toBe(false); // completed → started is cross-type; still refused
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('returns false when token cannot be resolved', async () => {
      resolveLinearOauthTokenMock.mockResolvedValueOnce(null);
      const ok = await transitionIssueState(CTX, ISSUE_ID, 'started', ['In Review']);
      expect(ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('returns false when the team has no state of the target type', async () => {
      const noCompleted = TEAM_STATES.filter((s) => s.type !== 'completed');
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { issue: { state: cur('s-inprogress'), team: { states: { nodes: noCompleted } } } } }),
      );
      const ok = await transitionIssueState(CTX, ISSUE_ID, 'completed');
      expect(ok).toBe(false);
    });
  });

  describe('revertIssueToNotStarted (#299 F-decompose-inprogress)', () => {
    const TEAM_STATES = [
      { id: 's-backlog', type: 'backlog', name: 'Backlog', position: 0 },
      { id: 's-todo', type: 'unstarted', name: 'Todo', position: 1 },
      { id: 's-inprogress', type: 'started', name: 'In Progress', position: 2 },
      { id: 's-done', type: 'completed', name: 'Done', position: 3 },
    ];
    const statesResp = (current: { id: string; type: string; name: string; position: number }) =>
      jsonResponse({ data: { issue: { state: current, team: { states: { nodes: TEAM_STATES } } } } });
    const cur = (id: string) => TEAM_STATES.find((s) => s.id === id)!;

    test('In Progress → Todo: our In-Progress reverts to the unstarted state', async () => {
      fetchMock
        .mockResolvedValueOnce(statesResp(cur('s-inprogress')))
        .mockResolvedValueOnce(jsonResponse({ data: { issueUpdate: { success: true } } }));
      const ok = await revertIssueToNotStarted(CTX, ISSUE_ID);
      expect(ok).toBe(true);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables.stateId).toBe('s-todo');
    });

    test('falls back to Backlog when the team has no unstarted state', async () => {
      const noUnstarted = TEAM_STATES.filter((s) => s.type !== 'unstarted');
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ data: { issue: { state: cur('s-inprogress'), team: { states: { nodes: noUnstarted } } } } }),
        )
        .mockResolvedValueOnce(jsonResponse({ data: { issueUpdate: { success: true } } }));
      const ok = await revertIssueToNotStarted(CTX, ISSUE_ID);
      expect(ok).toBe(true);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables.stateId).toBe('s-backlog');
    });

    test('does NOT demote a human-completed issue (only reverts a started state)', async () => {
      fetchMock.mockResolvedValueOnce(statesResp(cur('s-done')));
      const ok = await revertIssueToNotStarted(CTX, ISSUE_ID);
      expect(ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1); // query only, no mutation
    });

    test('no-op when the issue is already in a not-started (backlog) state', async () => {
      fetchMock.mockResolvedValueOnce(statesResp(cur('s-backlog')));
      const ok = await revertIssueToNotStarted(CTX, ISSUE_ID);
      expect(ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('appendOnceToComment (iteration-UX preview link)', () => {
    const COMMENT_ID = 'reply-cmt-1';

    test('reads the body and appends the line when the marker is absent', async () => {
      // 1st fetch = read body; 2nd = commentUpdate.
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { comment: { body: '✅ Updated — [PR #5](u). _$0.1_' } } }))
        .mockResolvedValueOnce(jsonResponse({ data: { commentUpdate: { success: true } } }));
      const ok = await appendOnceToComment(CTX, COMMENT_ID, ' · [preview](https://cdn/x.png)', '[preview]');
      expect(ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The update carries the original body + the appended line.
      const updateBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(updateBody.variables.body).toBe('✅ Updated — [PR #5](u). _$0.1_\n · [preview](https://cdn/x.png)');
      expect(updateBody.variables.id).toBe(COMMENT_ID);
    });

    test('idempotent: marker already present → no update (webhook redelivery)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { comment: { body: '✅ Updated — [PR #5](u). · [preview](https://cdn/x.png)' } } }),
      );
      const ok = await appendOnceToComment(CTX, COMMENT_ID, ' · [preview](https://cdn/y.png)', '[preview]');
      expect(ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1); // read only, NO update
    });

    test('missing comment body → no update, returns false', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { comment: null } }));
      const ok = await appendOnceToComment(CTX, COMMENT_ID, ' · [preview](u)', '[preview]');
      expect(ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('no token → no fetch', async () => {
      resolveLinearOauthTokenMock.mockResolvedValueOnce(null);
      const ok = await appendOnceToComment(CTX, COMMENT_ID, ' · [preview](u)', '[preview]');
      expect(ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('upsertThreadedReply preservePreview (iteration-UX convergence)', () => {
    const REPLY_ID = 'reply-cmt-9';
    const BLOCK = '[![preview](https://cdn/screenshots/x.png)](https://app.vercel.app)';

    test('terminal edit carries an already-landed preview thumbnail from the current body', async () => {
      // The screenshot webhook appended the clickable thumbnail block first; this
      // terminal re-render reads the current body and re-attaches it (ABCA-434 race).
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { comment: { body: `✅ Updated.\n\n${BLOCK}` } } }))
        .mockResolvedValueOnce(jsonResponse({ data: { commentUpdate: { success: true } } }));
      const newBody = '✅ Updated — [PR #5](u). _$0.2 · 35s_';
      const id = await upsertThreadedReply(CTX, ISSUE_ID, 'parent-1', newBody, REPLY_ID, { preservePreview: true });
      expect(id).toBe(REPLY_ID);
      expect(fetchMock).toHaveBeenCalledTimes(2); // read body, then update
      const updateBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(updateBody.variables.body).toBe(`${newBody}\n\n${BLOCK}`);
    });

    test('without preservePreview the edit does NOT read the body (single update)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { commentUpdate: { success: true } } }));
      const id = await upsertThreadedReply(CTX, ISSUE_ID, 'parent-1', '✅ Updated.', REPLY_ID);
      expect(id).toBe(REPLY_ID);
      expect(fetchMock).toHaveBeenCalledTimes(1); // straight update, no read
    });
  });

  describe('sweepDecompositionNotes (#299 plan-cleanup)', () => {
    // A representative plan-phase thread: the frozen plan reference (KEEP), the
    // transient decompose notes (🗂️/👋 → DELETE), the live epic panel (🔄 → a
    // different prefix, KEEP), and a human comment (no bot prefix, KEEP).
    const THREAD = {
      data: {
        issue: {
          comments: {
            nodes: [
              { id: 'plan-ref', body: '🗂️ **Approved plan** — 2 sub-issues' },
              { id: 'started-ack', body: '🗂️ On it — working out how to break this up…' },
              { id: 'nudge', body: '👋 I answer to `@bgagent`…' },
              { id: 'panel', body: '🔄 **ABCA orchestration** · 0/2 complete' },
              { id: 'human', body: 'looks good, ship it' },
            ],
          },
        },
      },
    };

    test('deletes the transient 🗂️/👋 notes, keeps the frozen reference + panel + human comment', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(THREAD)) // the comments list
        .mockResolvedValue(jsonResponse({ data: { commentDelete: { success: true } } }));
      const deleted = await sweepDecompositionNotes(CTX, ISSUE_ID, 'plan-ref');
      // started-ack + nudge deleted; plan-ref (kept), panel (🔄), human (no prefix) survive.
      expect(deleted).toBe(2);
      const deletedIds = fetchMock.mock.calls
        .slice(1)
        .map((c) => JSON.parse(c[1].body).variables.id);
      expect(deletedIds.sort()).toEqual(['nudge', 'started-ack']);
      expect(deletedIds).not.toContain('plan-ref');
      expect(deletedIds).not.toContain('panel');
      expect(deletedIds).not.toContain('human');
    });

    test('with no keepCommentId, sweeps ALL bot notes incl. the (untracked) reference — single-task/older-plan path', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(THREAD))
        .mockResolvedValue(jsonResponse({ data: { commentDelete: { success: true } } }));
      const deleted = await sweepDecompositionNotes(CTX, ISSUE_ID);
      // plan-ref + started-ack + nudge (all 🗂️/👋); panel + human still spared.
      expect(deleted).toBe(3);
    });

    test('no token → no fetch, sweeps nothing', async () => {
      resolveLinearOauthTokenMock.mockResolvedValueOnce(null);
      const deleted = await sweepDecompositionNotes(CTX, ISSUE_ID, 'plan-ref');
      expect(deleted).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('a failed comments-list is a clean no-op (best-effort, never throws)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'boom' }] }, 200));
      const deleted = await sweepDecompositionNotes(CTX, ISSUE_ID, 'plan-ref');
      expect(deleted).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1); // only the (failed) list; no deletes
    });

    test('a leading-whitespace bot note is still matched (trimStart)', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({
          data: { issue: { comments: { nodes: [{ id: 'ws', body: '\n  🗂️ over-cap note' }] } } },
        }))
        .mockResolvedValue(jsonResponse({ data: { commentDelete: { success: true } } }));
      const deleted = await sweepDecompositionNotes(CTX, ISSUE_ID, 'plan-ref');
      expect(deleted).toBe(1);
    });
  });

  describe('fetchRecentComments (ADR-016 pre-hydration)', () => {
    function commentsResponse(nodes: unknown[]): Response {
      return jsonResponse({ data: { issue: { comments: { nodes } } } });
    }

    test('returns human comments oldest-first, rendered with author + timestamp', async () => {
      fetchMock.mockResolvedValueOnce(commentsResponse([
        { id: 'c2', body: 'second', createdAt: '2026-07-20T10:00:00Z', user: { displayName: 'Bob' } },
        { id: 'c1', body: 'first', createdAt: '2026-07-19T09:00:00Z', user: { displayName: 'Alice' } },
      ]));
      const result = await fetchRecentComments(CTX, ISSUE_ID);
      expect(result).toEqual([
        { author: 'Alice', createdAt: '2026-07-19T09:00:00Z', markdown: 'first' },
        { author: 'Bob', createdAt: '2026-07-20T10:00:00Z', markdown: 'second' },
      ]);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { query: string; variables: Record<string, string> };
      expect(body.query).toContain('botActor');
      expect(body.variables).toEqual({ issueId: ISSUE_ID });
    });

    test('drops app/integration comments (botActor present, or no user)', async () => {
      fetchMock.mockResolvedValueOnce(commentsResponse([
        { id: 'h', body: 'human turn', createdAt: '2026-07-19T09:00:00Z', user: { displayName: 'Alice' } },
        { id: 'b', body: 'bot progress', createdAt: '2026-07-19T09:05:00Z', botActor: { id: 'app-1' } },
        { id: 'n', body: 'no author', createdAt: '2026-07-19T09:06:00Z', user: null },
      ]));
      const result = await fetchRecentComments(CTX, ISSUE_ID);
      expect(result).toHaveLength(1);
      expect(result[0].markdown).toBe('human turn');
    });

    test('drops bot-prefixed bodies even if attributed to a user (belt + suspenders)', async () => {
      fetchMock.mockResolvedValueOnce(commentsResponse([
        { id: 'p', body: '🤖 Starting…', createdAt: '2026-07-19T09:00:00Z', user: { displayName: 'Someone' } },
        { id: 'h', body: 'real question', createdAt: '2026-07-19T09:01:00Z', user: { displayName: 'Alice' } },
      ]));
      const result = await fetchRecentComments(CTX, ISSUE_ID);
      expect(result.map((c) => c.markdown)).toEqual(['real question']);
    });

    test('keeps only the most recent maxComments', async () => {
      const nodes = Array.from({ length: 5 }, (_, i) => ({
        id: `c${i}`,
        body: `comment ${i}`,
        createdAt: `2026-07-2${i}T00:00:00Z`,
        user: { displayName: 'Alice' },
      }));
      fetchMock.mockResolvedValueOnce(commentsResponse(nodes));
      const capped = await fetchRecentComments(CTX, ISSUE_ID, 2);
      expect(capped.map((c) => c.markdown)).toEqual(['comment 3', 'comment 4']);
    });

    test('fail-open: no token → [] (never throws)', async () => {
      resolveLinearOauthTokenMock.mockResolvedValueOnce(null);
      const result = await fetchRecentComments(CTX, ISSUE_ID);
      expect(result).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('fail-open: GraphQL error → [] (never throws)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'boom' }] }));
      const result = await fetchRecentComments(CTX, ISSUE_ID);
      expect(result).toEqual([]);
    });

    test('skips comments with empty/whitespace bodies', async () => {
      fetchMock.mockResolvedValueOnce(commentsResponse([
        { id: 'e', body: '   ', createdAt: '2026-07-19T09:00:00Z', user: { displayName: 'Alice' } },
        { id: 'h', body: 'kept', createdAt: '2026-07-19T09:01:00Z', user: { displayName: 'Bob' } },
      ]));
      const result = await fetchRecentComments(CTX, ISSUE_ID);
      expect(result.map((c) => c.markdown)).toEqual(['kept']);
    });
  });
});
