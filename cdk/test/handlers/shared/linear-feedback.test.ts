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
  type LinearFeedbackContext,
  postIssueComment,
  reportIssueFailure,
  transitionIssueState,
  upsertStatusComment,
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
      const ok = await postIssueComment(CTX, ISSUE_ID, '❌ blocked');

      expect(ok).toBe(true);
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

    test('returns false (and logs warn) when the token cannot be resolved', async () => {
      resolveLinearOauthTokenMock.mockResolvedValueOnce(null);

      const ok = await postIssueComment(CTX, ISSUE_ID, 'msg');

      expect(ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('returns false on non-2xx response (no throw)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));

      const ok = await postIssueComment(CTX, ISSUE_ID, 'msg');

      expect(ok).toBe(false);
    });

    test('returns false on GraphQL errors (no throw)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'auth' }] }));

      const ok = await postIssueComment(CTX, ISSUE_ID, 'msg');

      expect(ok).toBe(false);
    });

    test('returns false on network failure (swallowed)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

      const ok = await postIssueComment(CTX, ISSUE_ID, 'msg');

      expect(ok).toBe(false);
    });

    test('returns false when resolveLinearOauthToken throws (swallowed at resolveToken layer)', async () => {
      resolveLinearOauthTokenMock.mockRejectedValueOnce(new Error('AccessDenied'));

      const ok = await postIssueComment(CTX, ISSUE_ID, 'msg');

      expect(ok).toBe(false);
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
});
