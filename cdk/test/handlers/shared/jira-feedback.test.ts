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

import {
  buildAdfDocument,
  postIssueComment,
  postIssueCommentAdf,
  reportIssueFailure,
} from '../../../src/handlers/shared/jira-feedback';

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

  test('returns false (never throws) when the initial resolve throws an infra error', async () => {
    // The resolver can throw on DDB/SM failure (not just resolve null). The
    // catch in resolveTenantToken must swallow it and no-op.
    resolveJiraOauthTokenMock.mockRejectedValueOnce(new Error('DDB throttle'));
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await postIssueComment(CTX, 'ENG-42', 'hello');

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns false when the forced-refresh resolve throws an infra error after a 401', async () => {
    // First resolve succeeds; the POST 401s; the forced-refresh resolve then
    // throws (SM unavailable). Must swallow and no-op — never throw.
    resolveJiraOauthTokenMock
      .mockResolvedValueOnce({ accessToken: 'stale_token', scope: '', siteUrl: '', oauthSecretArn: 'x' })
      .mockRejectedValueOnce(new Error('SecretsManager unavailable'));
    const fetchMock = jest.fn().mockResolvedValueOnce(mockResponse(401));
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await postIssueComment(CTX, 'ENG-42', 'hello');

    expect(ok).toBe(false);
    // Only the first POST happened; the retry never got a token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveJiraOauthTokenMock).toHaveBeenCalledTimes(2);
    // The forced-refresh resolve carried forceRefresh: true.
    expect(resolveJiraOauthTokenMock.mock.calls[1][2]).toEqual({ forceRefresh: true });
  });

  test('returns false on a non-auth non-2xx response and does NOT refresh', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(500));
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await postIssueComment(CTX, 'ENG-42', 'hello');

    expect(ok).toBe(false);
    // 5xx is terminal — no forced-refresh retry, no second POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveJiraOauthTokenMock).toHaveBeenCalledTimes(1);
  });

  test('reportIssueFailure never throws even when fetch rejects', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    await expect(reportIssueFailure(CTX, 'ENG-42', '❌ nope')).resolves.toBeUndefined();
  });
});

describe('jira-feedback: 401 → forced refresh → retry (issue #370)', () => {
  test('refreshes the token and retries once on 401, succeeding the second time', async () => {
    // First resolve hands back a (stale) token; the forced-refresh resolve
    // hands back a different, freshly-minted token.
    resolveJiraOauthTokenMock
      .mockResolvedValueOnce({
        accessToken: 'stale_token',
        scope: 'write:jira-work',
        siteUrl: 'https://acme.atlassian.net',
        oauthSecretArn: 'arn:aws:secretsmanager:us-east-1:111:secret:x',
      })
      .mockResolvedValueOnce({
        accessToken: 'fresh_token',
        scope: 'write:jira-work',
        siteUrl: 'https://acme.atlassian.net',
        oauthSecretArn: 'arn:aws:secretsmanager:us-east-1:111:secret:x',
      });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(mockResponse(401)) // first POST: stale token rejected
      .mockResolvedValueOnce(mockResponse(201)); // retry: fresh token accepted
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await postIssueComment(CTX, 'ENG-42', 'hello');

    expect(ok).toBe(true);
    // Two POSTs, and the second carried the refreshed bearer token.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const secondHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe('Bearer stale_token');
    expect(secondHeaders.Authorization).toBe('Bearer fresh_token');
    // The forced-refresh resolve must pass forceRefresh: true.
    expect(resolveJiraOauthTokenMock).toHaveBeenCalledTimes(2);
    expect(resolveJiraOauthTokenMock.mock.calls[0][2]).toEqual({ forceRefresh: false });
    expect(resolveJiraOauthTokenMock.mock.calls[1][2]).toEqual({ forceRefresh: true });
  });

  test('also retries on 403 (insufficient-permission style auth rejection)', async () => {
    resolveJiraOauthTokenMock
      .mockResolvedValueOnce({ accessToken: 'stale_token', scope: '', siteUrl: '', oauthSecretArn: 'x' })
      .mockResolvedValueOnce({ accessToken: 'fresh_token', scope: '', siteUrl: '', oauthSecretArn: 'x' });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(mockResponse(403))
      .mockResolvedValueOnce(mockResponse(201));
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await postIssueComment(CTX, 'ENG-42', 'hello');

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('returns false without a second POST when the refresh yields the same token', async () => {
    // Both resolves return the identical access token (e.g. refresh-token
    // revoked, so the resolver couldn't rotate). Retrying would only 401
    // again, so we skip it.
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(401));
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await postIssueComment(CTX, 'ENG-42', 'hello');

    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry with an unchanged token
    expect(resolveJiraOauthTokenMock).toHaveBeenCalledTimes(2);
  });

  test('returns false when the forced refresh cannot resolve a token', async () => {
    resolveJiraOauthTokenMock
      .mockResolvedValueOnce({ accessToken: 'stale_token', scope: '', siteUrl: '', oauthSecretArn: 'x' })
      .mockResolvedValueOnce(null); // refresh-token revoked → resolver gives up
    const fetchMock = jest.fn().mockResolvedValueOnce(mockResponse(401));
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await postIssueComment(CTX, 'ENG-42', 'hello');

    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not retry a second time if the refreshed token is also rejected', async () => {
    resolveJiraOauthTokenMock
      .mockResolvedValueOnce({ accessToken: 'stale_token', scope: '', siteUrl: '', oauthSecretArn: 'x' })
      .mockResolvedValueOnce({ accessToken: 'fresh_token', scope: '', siteUrl: '', oauthSecretArn: 'x' });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(mockResponse(401)) // stale rejected
      .mockResolvedValueOnce(mockResponse(401)); // fresh also rejected → give up
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await postIssueComment(CTX, 'ENG-42', 'hello');

    expect(ok).toBe(false);
    // Exactly two POSTs — the retry is bounded at one attempt.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveJiraOauthTokenMock).toHaveBeenCalledTimes(2);
  });
});

describe('jira-feedback: buildAdfDocument (multi-paragraph ADF, #573)', () => {
  test('maps each paragraph to an ADF paragraph node, preserving order', () => {
    const doc = buildAdfDocument([
      [{ text: 'header', strong: true }],
      [{ text: 'metrics line' }],
      [{ text: 'task t-1', em: true }],
    ]);
    expect(doc.type).toBe('doc');
    expect(doc.version).toBe(1);
    const content = doc.content as Array<{ type: string; content: Array<Record<string, unknown>> }>;
    expect(content).toHaveLength(3);
    expect(content.every((p) => p.type === 'paragraph')).toBe(true);
    expect(content[1].content[0]).toEqual({ type: 'text', text: 'metrics line' });
  });

  test('emits strong / em marks only when the run flags them', () => {
    const doc = buildAdfDocument([[
      { text: 'bold', strong: true },
      { text: 'italic', em: true },
      { text: 'both', strong: true, em: true },
      { text: 'plain' },
    ]]);
    const runs = (doc.content as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(runs[0]).toEqual({ type: 'text', text: 'bold', marks: [{ type: 'strong' }] });
    expect(runs[1]).toEqual({ type: 'text', text: 'italic', marks: [{ type: 'em' }] });
    expect(runs[2]).toEqual({ type: 'text', text: 'both', marks: [{ type: 'strong' }, { type: 'em' }] });
    // A plain run carries no marks key at all.
    expect(runs[3]).toEqual({ type: 'text', text: 'plain' });
  });

  test('an empty run list yields an empty paragraph (blank-line spacing)', () => {
    const doc = buildAdfDocument([[]]);
    const content = doc.content as Array<{ type: string; content: unknown[] }>;
    expect(content[0]).toEqual({ type: 'paragraph', content: [] });
  });

  test('an href run emits an ADF link mark (bare URLs are not auto-linked)', () => {
    const doc = buildAdfDocument([[
      { text: 'PR: ' },
      { text: 'https://github.com/o/r/pull/7', href: 'https://github.com/o/r/pull/7' },
    ]]);
    const runs = (doc.content as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(runs[0]).toEqual({ type: 'text', text: 'PR: ' });
    expect(runs[1]).toEqual({
      type: 'text',
      text: 'https://github.com/o/r/pull/7',
      marks: [{ type: 'link', attrs: { href: 'https://github.com/o/r/pull/7' } }],
    });
  });

  test('href composes with strong/em marks on the same run', () => {
    const doc = buildAdfDocument([[
      { text: 'link', strong: true, href: 'https://x.example/pull/1' },
    ]]);
    const runs = (doc.content as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(runs[0]).toEqual({
      type: 'text',
      text: 'link',
      marks: [{ type: 'strong' }, { type: 'link', attrs: { href: 'https://x.example/pull/1' } }],
    });
  });
});

describe('jira-feedback: postIssueCommentAdf (classified result, #573)', () => {
  const ADF = { type: 'doc', version: 1, content: [] };

  test('returns { ok: true } on 201 and posts the supplied ADF document verbatim', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(201));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await postIssueCommentAdf(CTX, 'ENG-42', ADF);

    expect(result).toEqual({ ok: true });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ body: ADF });
  });

  test('classifies 5xx as retryable', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse(503)) as unknown as typeof fetch;
    const result = await postIssueCommentAdf(CTX, 'ENG-42', ADF);
    expect(result).toEqual({ ok: false, retryable: true });
  });

  test('classifies 429 as retryable', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse(429)) as unknown as typeof fetch;
    const result = await postIssueCommentAdf(CTX, 'ENG-42', ADF);
    expect(result).toEqual({ ok: false, retryable: true });
  });

  test('classifies a 400 as terminal (non-retryable)', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse(400)) as unknown as typeof fetch;
    const result = await postIssueCommentAdf(CTX, 'ENG-42', ADF);
    expect(result).toEqual({ ok: false, retryable: false });
  });

  test('classifies a network rejection as retryable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;
    const result = await postIssueCommentAdf(CTX, 'ENG-42', ADF);
    expect(result).toEqual({ ok: false, retryable: true });
  });

  test('token resolution failure is terminal (never retryable)', async () => {
    resolveJiraOauthTokenMock.mockReset().mockResolvedValueOnce(null);
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await postIssueCommentAdf(CTX, 'ENG-42', ADF);

    expect(result).toEqual({ ok: false, retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('401 → forced refresh → retry succeeds returns { ok: true }', async () => {
    resolveJiraOauthTokenMock
      .mockReset()
      .mockResolvedValueOnce({ accessToken: 'stale', scope: '', siteUrl: '', oauthSecretArn: 'x' })
      .mockResolvedValueOnce({ accessToken: 'fresh', scope: '', siteUrl: '', oauthSecretArn: 'x' });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(mockResponse(401))
      .mockResolvedValueOnce(mockResponse(201));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await postIssueCommentAdf(CTX, 'ENG-42', ADF);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a second auth rejection after refresh is terminal', async () => {
    resolveJiraOauthTokenMock
      .mockReset()
      .mockResolvedValueOnce({ accessToken: 'stale', scope: '', siteUrl: '', oauthSecretArn: 'x' })
      .mockResolvedValueOnce({ accessToken: 'fresh', scope: '', siteUrl: '', oauthSecretArn: 'x' });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(mockResponse(401))
      .mockResolvedValueOnce(mockResponse(403));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await postIssueCommentAdf(CTX, 'ENG-42', ADF);

    expect(result).toEqual({ ok: false, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a transient error on the post-refresh retry stays retryable', async () => {
    resolveJiraOauthTokenMock
      .mockReset()
      .mockResolvedValueOnce({ accessToken: 'stale', scope: '', siteUrl: '', oauthSecretArn: 'x' })
      .mockResolvedValueOnce({ accessToken: 'fresh', scope: '', siteUrl: '', oauthSecretArn: 'x' });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(mockResponse(401))
      .mockResolvedValueOnce(mockResponse(500));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await postIssueCommentAdf(CTX, 'ENG-42', ADF);

    expect(result).toEqual({ ok: false, retryable: true });
  });
});
