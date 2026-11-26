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

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const mockLoadRepoConfig = jest.fn();
const mockResolveGitHubToken = jest.fn();

jest.mock('../../src/handlers/shared/repo-config', () => ({
  loadRepoConfig: (...args: unknown[]) => mockLoadRepoConfig(...args),
}));
jest.mock('../../src/handlers/shared/context-hydration', () => ({
  resolveGitHubToken: (...args: unknown[]) => mockResolveGitHubToken(...args),
}));
jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ1') }));

let handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

const PLATFORM_SECRET = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:platform';
const fetchMock = jest.fn();

function makeEvent(repoId: string | null = 'acme%2Fgame', sub: string | null = 'user-1'): APIGatewayProxyEvent {
  return {
    pathParameters: repoId === null ? null : { repo_id: repoId },
    requestContext: { authorizer: sub ? { claims: { sub } } : undefined },
  } as unknown as APIGatewayProxyEvent;
}

function githubResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(async () => {
  process.env.REPO_TABLE_NAME = 'RepoTable';
  process.env.GITHUB_TOKEN_SECRET_ARN = PLATFORM_SECRET;
  mockLoadRepoConfig.mockReset().mockResolvedValue({ repo: 'acme/game', status: 'active' });
  mockResolveGitHubToken.mockReset().mockResolvedValue('ghp_secret_token');
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.resetModules();
  ({ handler } = await import('../../src/handlers/list-repo-issues'));
});

const body = (res: { body: string }) => JSON.parse(res.body);
const issueNumbers = (res: { body: string }) => body(res).data.issues.map((i: { number: number }) => i.number);

const issue = (number: number) => ({ number, title: `Issue ${number}`, html_url: `https://github.com/acme/game/issues/${number}`, updated_at: 'x' });
const pullRequest = (number: number) => ({ ...issue(number), pull_request: { url: 'p' } });

describe('list-repo-issues', () => {
  test('returns open issues (not pull requests) with titles and metadata only', async () => {
    fetchMock.mockResolvedValue(githubResponse([
      { number: 2, title: 'Spawn wild monsters', html_url: 'https://github.com/acme/game/issues/2', updated_at: '2026-10-27T10:00:00Z', labels: [{ name: 'enhancement' }], body: 'secret plans' },
      { number: 5, title: 'A pull request', html_url: 'u', updated_at: 'x', pull_request: { url: 'p' } },
    ]));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({
      data: {
        repo: 'acme/game',
        issues: [{ number: 2, title: 'Spawn wild monsters', url: 'https://github.com/acme/game/issues/2', updated_at: '2026-10-27T10:00:00Z', labels: ['enhancement'] }],
      },
    });
    expect(res.body).not.toContain('secret plans');
  });

  test('reads further pages when pull requests fill the first one', async () => {
    // GitHub's list-issues endpoint returns pull requests too, and has no parameter that excludes them.
    fetchMock
      .mockResolvedValueOnce(githubResponse(Array.from({ length: 100 }, (_, i) => pullRequest(1000 + i))))
      .mockResolvedValueOnce(githubResponse([issue(3), issue(2), issue(1)]));
    const res = await handler(makeEvent());
    expect(issueNumbers(res)).toEqual([3, 2, 1]);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get('page'))).toEqual(['1', '2']);
    expect(fetchMock.mock.calls[1][1].signal).toBe(fetchMock.mock.calls[0][1].signal);
  });

  test('answers the 50 most recently updated issues and stops reading', async () => {
    fetchMock.mockResolvedValue(githubResponse(Array.from({ length: 100 }, (_, i) => issue(100 - i))));
    const res = await handler(makeEvent());
    expect(issueNumbers(res)).toEqual(Array.from({ length: 50 }, (_, i) => 100 - i));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('reads at most three pages of a repository that shows only pull requests', async () => {
    fetchMock.mockResolvedValue(githubResponse(Array.from({ length: 100 }, (_, i) => pullRequest(1000 + i))));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(issueNumbers(res)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('answers 503, not a short list, when a later page fails', async () => {
    fetchMock
      .mockResolvedValueOnce(githubResponse([...Array.from({ length: 99 }, (_, i) => pullRequest(1000 + i)), issue(7)]))
      .mockRejectedValueOnce(new Error('timeout'));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(503);
    expect(body(res).error.message).toMatch(/GitHub did not answer/);
  });

  test('lists an issue once when an update moves it onto the next page between two reads', async () => {
    fetchMock
      .mockResolvedValueOnce(githubResponse([...Array.from({ length: 99 }, (_, i) => pullRequest(1000 + i)), issue(7)]))
      .mockResolvedValueOnce(githubResponse([issue(7), issue(6)]));
    const res = await handler(makeEvent());
    expect(issueNumbers(res)).toEqual([7, 6]);
  });

  test('answers a repeated request from memory, without spending another GitHub call', async () => {
    fetchMock.mockResolvedValue(githubResponse([issue(2)]));
    const first = await handler(makeEvent());
    const second = await handler(makeEvent());
    expect(second.statusCode).toBe(200);
    expect(body(second)).toEqual(body(first));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('asks GitHub again once the kept answer is a minute old', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    fetchMock.mockResolvedValueOnce(githubResponse([issue(2)])).mockResolvedValueOnce(githubResponse([issue(3), issue(2)]));
    await handler(makeEvent());
    now.mockReturnValue(1_000_000 + 60_000);
    const later = await handler(makeEvent());
    now.mockRestore();
    expect(issueNumbers(later)).toEqual([3, 2]);
  });

  test('keeps the answers of two repositories apart', async () => {
    mockLoadRepoConfig.mockImplementation(async (repo: string) => ({ repo, status: 'active' }));
    fetchMock.mockImplementation(async (url: string) => githubResponse([issue(url.includes('/acme/game/') ? 1 : 2)]));
    await handler(makeEvent('acme%2Fgame'));
    const other = await handler(makeEvent('acme%2Fengine'));
    expect(body(other).data).toEqual({ repo: 'acme/engine', issues: [expect.objectContaining({ number: 2 })] });
  });

  test('calls GitHub server-side with the token, which never reaches the response', async () => {
    fetchMock.mockResolvedValue(githubResponse([]));
    const res = await handler(makeEvent());
    expect(mockResolveGitHubToken).toHaveBeenCalledWith(PLATFORM_SECRET);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/game/issues?state=open&sort=updated&direction=desc&per_page=100&page=1');
    expect(init.headers.Authorization).toBe('token ghp_secret_token');
    expect(JSON.stringify(res)).not.toContain('ghp_secret_token');
  });

  test('prefers the repository\'s own token when its Blueprint sets one', async () => {
    mockLoadRepoConfig.mockResolvedValue({ repo: 'acme/game', status: 'active', github_token_secret_arn: 'arn:repo-secret' });
    fetchMock.mockResolvedValue(githubResponse([]));
    await handler(makeEvent());
    expect(mockResolveGitHubToken).toHaveBeenCalledWith('arn:repo-secret');
  });

  test('requires a signed-in caller', async () => {
    expect((await handler(makeEvent('acme%2Fgame', null))).statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([null, 'not-a-repo', '..%2Fx', 'a%2Fb%2Fc'])('rejects repo_id %p', async (repoId) => {
    expect((await handler(makeEvent(repoId))).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('serves only onboarded repositories', async () => {
    mockLoadRepoConfig.mockResolvedValue(null);
    const res = await handler(makeEvent('someone%2Felse'));
    expect(res.statusCode).toBe(422);
    expect(body(res).error.code).toBe('REPO_NOT_ONBOARDED');
    expect(mockResolveGitHubToken).not.toHaveBeenCalled();
  });

  test('fails closed when the repo table is not configured', async () => {
    delete process.env.REPO_TABLE_NAME;
    expect((await handler(makeEvent())).statusCode).toBe(503);
    expect(mockLoadRepoConfig).not.toHaveBeenCalled();
  });

  test('explains a token GitHub refuses', async () => {
    fetchMock.mockResolvedValue(githubResponse({ message: 'Bad credentials' }, 401));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(503);
    expect(body(res).error.message).toMatch(/Check that the stored GitHub token can read issues/);
  });

  test('explains when GitHub does not answer', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(503);
    expect(body(res).error.message).toMatch(/GitHub did not answer/);
  });

  test('explains it the same way when the time limit ends while a page is being read', async () => {
    // fetch resolves once the headers arrive; an abort during the body read rejects `json()` with the signal's error.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(503);
    expect(body(res).error.message).toMatch(/GitHub did not answer/);
  });

  test('reports an unexpected failure without details', async () => {
    mockResolveGitHubToken.mockRejectedValue(new Error('AccessDenied for arn:...'));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('AccessDenied');
  });
});
