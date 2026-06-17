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

const resolveJiraOauthTokenMock = jest.fn();
jest.mock('../../../src/handlers/shared/jira-oauth-resolver', () => ({
  resolveJiraOauthToken: (...args: unknown[]) => resolveJiraOauthTokenMock(...args),
}));

import { postIssueComment, reportIssueFailure } from '../../../src/handlers/shared/jira-feedback';

const CTX = { cloudId: 'cloud-uuid-1', registryTableName: 'JiraWorkspaceRegistry' };

// ``fetch`` is the global transport; each test installs its own mock.
const originalFetch = global.fetch;

function mockResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

beforeEach(() => {
  resolveJiraOauthTokenMock.mockReset();
  // Default: the resolver hands back a usable token. The `site_url` here is
  // deliberately the raw site host — the helper must NOT use it as the REST
  // base (that audience is api.atlassian.com only). See assertions below.
  resolveJiraOauthTokenMock.mockResolvedValue({
    accessToken: 'jira_oauth_token',
    scope: 'write:jira-work',
    siteUrl: 'https://acme.atlassian.net',
    oauthSecretArn: 'arn:aws:secretsmanager:us-east-1:111:secret:bgagent-jira-oauth-cloud-uuid-1',
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('jira-feedback: postIssueComment', () => {
  test('posts to the api.atlassian.com gateway base scoped by cloudId — NOT the site host', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(201));
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await postIssueComment(CTX, 'ENG-42', 'hello');

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];

    // The crux of the bug this test guards: the 3LO token is minted with
    // audience=api.atlassian.com and 401s against `*.atlassian.net`.
    const host = new URL(url as string).host;
    expect(host).toBe('api.atlassian.com');
    expect(url).toBe(
      'https://api.atlassian.com/ex/jira/cloud-uuid-1/rest/api/3/issue/ENG-42/comment',
    );
    expect(url as string).not.toContain('atlassian.net');

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jira_oauth_token');
    expect((init as RequestInit).method).toBe('POST');
  });

  test('url-encodes the issue key', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(201));
    global.fetch = fetchMock as unknown as typeof fetch;

    await postIssueComment(CTX, 'a/b', 'hi');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.atlassian.com/ex/jira/cloud-uuid-1/rest/api/3/issue/a%2Fb/comment',
    );
  });

  test('returns false (never throws) when the resolver yields no token', async () => {
    resolveJiraOauthTokenMock.mockResolvedValueOnce(null);
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await postIssueComment(CTX, 'ENG-42', 'hello');

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns false on a non-2xx response and swallows the error', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse(401)) as unknown as typeof fetch;

    const ok = await postIssueComment(CTX, 'ENG-42', 'hello');

    expect(ok).toBe(false);
  });

  test('reportIssueFailure never throws even when fetch rejects', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    await expect(reportIssueFailure(CTX, 'ENG-42', '❌ nope')).resolves.toBeUndefined();
  });
});
