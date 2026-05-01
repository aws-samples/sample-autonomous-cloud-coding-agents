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

import {
  BGAGENT_COMMENT_MARKER_PREFIX,
  GitHubCommentError,
  renderCommentBody,
  upsertTaskComment,
} from '../../../src/handlers/shared/github-comment';

// ``fetch`` is the global transport; each test installs its own mock.
const originalFetch = global.fetch;

function mockResponse(opts: {
  status: number;
  ok?: boolean;
  etag?: string | null;
  body?: unknown;
}): Response {
  const headers = new Headers();
  if (opts.etag !== null && opts.etag !== undefined) {
    headers.set('etag', opts.etag);
  }
  return {
    ok: opts.ok ?? (opts.status >= 200 && opts.status < 300),
    status: opts.status,
    headers,
    json: async () => opts.body ?? {},
  } as unknown as Response;
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('github-comment: upsertTaskComment — POST', () => {
  test('creates a new comment when existingCommentId is undefined', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      mockResponse({
        status: 201,
        etag: '"abc123"',
        body: { id: 999, body: 'body' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await upsertTaskComment({
      repo: 'owner/repo',
      issueOrPrNumber: 42,
      body: '# body',
      token: 'ghp_xxx',
      existingCommentId: undefined,
      existingEtag: undefined,
    });

    expect(result).toEqual({ commentId: 999, etag: '"abc123"', created: true });
    // Exactly one POST — no fallback GET/PATCH on first publish.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/owner/repo/issues/42/comments');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('token ghp_xxx');
    expect(headers['If-Match']).toBeUndefined();
  });

  test('throws GitHubCommentError with status on POST failure', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ status: 422, ok: false, etag: '"x"' }),
    ) as unknown as typeof fetch;

    await expect(
      upsertTaskComment({
        repo: 'owner/repo',
        issueOrPrNumber: 1,
        body: 'b',
        token: 't',
        existingCommentId: undefined,
        existingEtag: undefined,
      }),
    ).rejects.toMatchObject({ name: 'GitHubCommentError', httpStatus: 422 });
  });

  test('throws when POST response is missing an ETag (cannot reliably PATCH later)', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ status: 201, etag: null, body: { id: 1, body: 'b' } }),
    ) as unknown as typeof fetch;

    await expect(
      upsertTaskComment({
        repo: 'owner/repo',
        issueOrPrNumber: 1,
        body: 'b',
        token: 't',
        existingCommentId: undefined,
        existingEtag: undefined,
      }),
    ).rejects.toThrow(/missing ETag/);
  });
});

describe('github-comment: upsertTaskComment — PATCH with If-Match', () => {
  test('GETs to capture ETag, then PATCHes with If-Match', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse({ status: 200, etag: '"etag-1"', body: { id: 7, body: 'old' } }))
      .mockResolvedValueOnce(mockResponse({ status: 200, etag: '"etag-2"', body: { id: 7, body: 'new' } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await upsertTaskComment({
      repo: 'owner/repo',
      issueOrPrNumber: 42,
      body: 'new',
      token: 't',
      existingCommentId: 7,
      existingEtag: undefined,
    });

    expect(result).toEqual({ commentId: 7, etag: '"etag-2"', created: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [getUrl, getInit] = fetchMock.mock.calls[0];
    expect((getInit as RequestInit).method).toBe('GET');
    expect(getUrl).toContain('/issues/comments/7');
    const [patchUrl, patchInit] = fetchMock.mock.calls[1];
    expect((patchInit as RequestInit).method).toBe('PATCH');
    expect(patchUrl).toContain('/issues/comments/7');
    const patchHeaders = (patchInit as RequestInit).headers as Record<string, string>;
    expect(patchHeaders['If-Match']).toBe('"etag-1"');
  });

  test('on 412 Precondition Failed: re-GETs and retries the PATCH once', async () => {
    const fetchMock = jest.fn()
      // initial GET
      .mockResolvedValueOnce(mockResponse({ status: 200, etag: '"stale"', body: { id: 7 } }))
      // PATCH rejects with 412
      .mockResolvedValueOnce(mockResponse({ status: 412, ok: false, etag: null }))
      // re-GET picks up the current etag
      .mockResolvedValueOnce(mockResponse({ status: 200, etag: '"fresh"', body: { id: 7 } }))
      // retry PATCH succeeds
      .mockResolvedValueOnce(mockResponse({ status: 200, etag: '"after-retry"', body: { id: 7 } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await upsertTaskComment({
      repo: 'owner/repo',
      issueOrPrNumber: 42,
      body: 'new',
      token: 't',
      existingCommentId: 7,
      existingEtag: undefined,
    });

    expect(result).toEqual({ commentId: 7, etag: '"after-retry"', created: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // Second PATCH carried the fresh etag, not the stale one.
    const secondPatch = fetchMock.mock.calls[3];
    const headers = (secondPatch[1] as RequestInit).headers as Record<string, string>;
    expect(headers['If-Match']).toBe('"fresh"');
  });

  test('a second 412 on retry propagates instead of looping forever', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse({ status: 200, etag: '"a"', body: { id: 7 } }))
      .mockResolvedValueOnce(mockResponse({ status: 412, ok: false, etag: null }))
      .mockResolvedValueOnce(mockResponse({ status: 200, etag: '"b"', body: { id: 7 } }))
      .mockResolvedValueOnce(mockResponse({ status: 412, ok: false, etag: null }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      upsertTaskComment({
        repo: 'owner/repo',
        issueOrPrNumber: 42,
        body: 'new',
        token: 't',
        existingCommentId: 7,
        existingEtag: undefined,
      }),
    ).rejects.toMatchObject({ name: 'GitHubCommentError', httpStatus: 412 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test('on 404 (comment deleted upstream): falls back to POSTing a fresh comment', async () => {
    const fetchMock = jest.fn()
      // GET returns 404
      .mockResolvedValueOnce(mockResponse({ status: 404, ok: false, etag: null }))
      // fallback POST
      .mockResolvedValueOnce(
        mockResponse({ status: 201, etag: '"new"', body: { id: 8, body: 'body' } }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await upsertTaskComment({
      repo: 'owner/repo',
      issueOrPrNumber: 42,
      body: 'new',
      token: 't',
      existingCommentId: 7,
      existingEtag: undefined,
    });

    // NEW comment id, created=true so the caller persists the new id.
    expect(result).toEqual({ commentId: 8, etag: '"new"', created: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('POST');
  });

  test('non-412/404 error (500) propagates without retry', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse({ status: 200, etag: '"a"', body: { id: 7 } }))
      .mockResolvedValueOnce(mockResponse({ status: 500, ok: false, etag: null }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      upsertTaskComment({
        repo: 'owner/repo',
        issueOrPrNumber: 42,
        body: 'new',
        token: 't',
        existingCommentId: 7,
        existingEtag: undefined,
      }),
    ).rejects.toMatchObject({ name: 'GitHubCommentError', httpStatus: 500 });
    // No retry on generic 5xx — caller's batch-level dispatcher log is
    // the right layer to see the failure.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('network error during PATCH is wrapped in GitHubCommentError', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse({ status: 200, etag: '"a"', body: { id: 7 } }))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      upsertTaskComment({
        repo: 'owner/repo',
        issueOrPrNumber: 42,
        body: 'new',
        token: 't',
        existingCommentId: 7,
        existingEtag: undefined,
      }),
    ).rejects.toBeInstanceOf(GitHubCommentError);
  });
});

describe('github-comment: upsertTaskComment — cached-etag fast path', () => {
  test('with existingEtag, skips the GET and PATCHes directly (one GitHub call)', async () => {
    // Design §6.4 steady-state: caller has the last successful etag
    // cached on TaskRecord. Use it as If-Match and skip the GET that
    // would double the API load.
    const fetchMock = jest.fn().mockResolvedValueOnce(
      mockResponse({ status: 200, etag: '"after"', body: { id: 7, body: 'new' } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await upsertTaskComment({
      repo: 'owner/repo',
      issueOrPrNumber: 42,
      body: 'new',
      token: 't',
      existingCommentId: 7,
      existingEtag: '"cached"',
    });

    expect(result).toEqual({ commentId: 7, etag: '"after"', created: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe('PATCH');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['If-Match']).toBe('"cached"');
  });

  test('cached etag is stale (412) → re-GET + retry with fresh etag', async () => {
    // The cached etag raced a concurrent edit. Fall back to the GET-then-retry path.
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse({ status: 412, ok: false, etag: null })) // PATCH with cached
      .mockResolvedValueOnce(mockResponse({ status: 200, etag: '"fresh"', body: { id: 7 } })) // GET
      .mockResolvedValueOnce(mockResponse({ status: 200, etag: '"after"', body: { id: 7 } })); // retry PATCH
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await upsertTaskComment({
      repo: 'owner/repo',
      issueOrPrNumber: 42,
      body: 'new',
      token: 't',
      existingCommentId: 7,
      existingEtag: '"stale"',
    });

    expect(result.etag).toBe('"after"');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // First call must have been PATCH with the stale cached etag.
    const first = fetchMock.mock.calls[0];
    expect((first[1] as RequestInit).method).toBe('PATCH');
    expect(((first[1] as RequestInit).headers as Record<string, string>)['If-Match']).toBe('"stale"');
  });

  test('PATCH body contains the rendered input verbatim', async () => {
    // Locks the payload contract — a regression that stringified the
    // wrong object would break every in-place edit silently.
    const fetchMock = jest.fn().mockResolvedValueOnce(
      mockResponse({ status: 200, etag: '"after"', body: { id: 7 } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await upsertTaskComment({
      repo: 'owner/repo',
      issueOrPrNumber: 42,
      body: '# The Body',
      token: 't',
      existingCommentId: 7,
      existingEtag: '"cached"',
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ body: '# The Body' });
  });

  test('PATCH response without ETag header throws (cannot reliably PATCH again)', async () => {
    // Symmetric with the POST-missing-ETag test above — without a
    // fresh ETag the caller would persist empty-string and every
    // subsequent edit would 412 permanently.
    const fetchMock = jest.fn().mockResolvedValueOnce(
      mockResponse({ status: 200, etag: null, body: { id: 7 } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      upsertTaskComment({
        repo: 'owner/repo',
        issueOrPrNumber: 42,
        body: 'new',
        token: 't',
        existingCommentId: 7,
        existingEtag: '"cached"',
      }),
    ).rejects.toThrow(/missing ETag/);
  });
});

describe('github-comment: renderCommentBody', () => {
  test('renders a stable Markdown body with the bgagent marker and all fields', () => {
    const body = renderCommentBody({
      taskId: 'abc123',
      status: 'RUNNING',
      repo: 'owner/repo',
      latestEventType: 'agent_milestone',
      latestEventAt: '2026-04-30T12:00:00Z',
      prUrl: 'https://github.com/owner/repo/pull/42',
      durationS: 90,
      costUsd: 0.25,
    });

    // Leading HTML marker so future lookups can grep the comment thread.
    expect(body.startsWith('<!-- bgagent:task-id=abc123 -->')).toBe(true);
    expect(body).toContain('| Task  | `abc123` |');
    expect(body).toContain('| Status | **RUNNING** |');
    expect(body).toContain('agent_milestone');
    expect(body).toContain('[link](https://github.com/owner/repo/pull/42)');
    expect(body).toContain('| Duration | 90s |');
    expect(body).toContain('| Cost | $0.2500 |');
  });

  test('sanitizes event types that contain Markdown-breaking characters', () => {
    // Defensive against future writers emitting freer-form event
    // strings — today all event types are snake_case enum values.
    const body = renderCommentBody({
      taskId: 'abc',
      status: 'RUNNING',
      repo: 'o/r',
      latestEventType: 'agent`|break\nline',
      latestEventAt: '2026-04-30T12:00:00Z',
      prUrl: null,
      durationS: null,
      costUsd: null,
    });
    expect(body).toContain('agentbreakline');
    // Ensure the injection characters never made it into the rendered body.
    expect(body).not.toMatch(/agent`/);
  });

  test('truncates bodies that would exceed the 65 536 GitHub ceiling', () => {
    // Repeat a long line many times to cross the 60k cap.
    const hugeStatus = 'RUNNING'.repeat(10_000); // 70k chars
    const body = renderCommentBody({
      taskId: 'abc',
      status: hugeStatus,
      repo: 'o/r',
      latestEventType: 'task_created',
      latestEventAt: '2026-04-30T12:00:00Z',
      prUrl: null,
      durationS: null,
      costUsd: null,
    });
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain('(truncated');
  });

  test('exports the BGAGENT marker prefix constant for downstream callers', () => {
    // The marker prefix is the public convention for identifying
    // bgagent-owned comments in PR threads. Exporting it keeps a
    // Chunk K reconciliation / forensics caller from re-inventing
    // the regex.
    expect(BGAGENT_COMMENT_MARKER_PREFIX).toBe('bgagent:task-id=');
    const body = renderCommentBody({
      taskId: 'T1',
      status: 'COMPLETED',
      repo: 'o/r',
      latestEventType: 'task_completed',
      latestEventAt: '2026-04-30T12:00:00Z',
      prUrl: null,
      durationS: null,
      costUsd: null,
    });
    expect(body).toContain(`<!-- ${BGAGENT_COMMENT_MARKER_PREFIX}T1 -->`);
  });

  test('omits optional rows when fields are null', () => {
    const body = renderCommentBody({
      taskId: 'abc',
      status: 'SUBMITTED',
      repo: 'o/r',
      latestEventType: 'task_created',
      latestEventAt: '2026-04-30T12:00:00Z',
      prUrl: null,
      durationS: null,
      costUsd: null,
    });

    expect(body).not.toContain('Pull request');
    expect(body).not.toContain('Duration');
    expect(body).not.toContain('Cost');
    // Required rows still present.
    expect(body).toContain('| Task  | `abc` |');
    expect(body).toContain('| Status | **SUBMITTED** |');
  });
});
