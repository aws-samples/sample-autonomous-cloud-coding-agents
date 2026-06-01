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
});
