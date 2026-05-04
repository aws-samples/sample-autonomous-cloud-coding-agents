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
import { logger } from '../../../src/handlers/shared/logger';

// ``fetch`` is the global transport; each test installs its own mock.
const originalFetch = global.fetch;

function mockResponse(opts: {
  status: number;
  ok?: boolean;
  etag?: string | null;
  body?: unknown;
  rateLimitRemaining?: string;
  rateLimitReset?: string;
}): Response {
  const headers = new Headers();
  if (opts.etag !== null && opts.etag !== undefined) {
    headers.set('etag', opts.etag);
  }
  if (opts.rateLimitRemaining !== undefined) {
    headers.set('x-ratelimit-remaining', opts.rateLimitRemaining);
  }
  if (opts.rateLimitReset !== undefined) {
    headers.set('x-ratelimit-reset', opts.rateLimitReset);
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
    });

    expect(result).toEqual({ commentId: 999, created: true });
    // Exactly one POST — no fallback GET/PATCH on first publish.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/owner/repo/issues/42/comments');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('token ghp_xxx');
    // Defense: GitHub's PATCH endpoint rejects ``If-Match`` with HTTP 400
    // ("Conditional request headers are not allowed in unsafe requests").
    // No write path on this helper should ever emit that header. (Scenario
    // 7-ext deploy validation caught this in production.)
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
      }),
    ).rejects.toMatchObject({ name: 'GitHubCommentError', httpStatus: 422 });
  });

  test('POST response without an ETag header is accepted (ETag is no longer load-bearing)', async () => {
    // Pre-fix, a missing ETag header threw because the caller needed
    // it as ``If-Match`` on the next PATCH. After dropping the
    // conditional-PATCH path, ETag is merely informational — absence
    // must not fail the dispatch.
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ status: 201, etag: null, body: { id: 42, body: 'b' } }),
    ) as unknown as typeof fetch;

    await expect(
      upsertTaskComment({
        repo: 'owner/repo',
        issueOrPrNumber: 1,
        body: 'b',
        token: 't',
        existingCommentId: undefined,
      }),
    ).resolves.toEqual({ commentId: 42, created: true });
  });
});

describe('github-comment: upsertTaskComment — PATCH', () => {
  test('PATCHes the existing comment directly (one call, no GET, no If-Match header)', async () => {
    // Design §6.4 post-fix: a single PATCH call per event. GitHub's
    // REST API does not support ``If-Match`` on ``PATCH /issues/
    // comments/{id}`` — every conditional PATCH returns HTTP 400
    // ("Conditional request headers are not allowed in unsafe requests
    // unless supported by the endpoint"). Concurrency is instead
    // handled upstream by DDB Stream ordering. See file header.
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
    });

    expect(result).toEqual({ commentId: 7, created: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/owner/repo/issues/comments/7');
    expect((init as RequestInit).method).toBe('PATCH');
    const headers = (init as RequestInit).headers as Record<string, string>;
    // BLOCKER regression guard: no conditional headers on PATCH.
    expect(headers['If-Match']).toBeUndefined();
    expect(headers['If-None-Match']).toBeUndefined();
  });

  test('on 404 (comment deleted upstream): falls back to POSTing a fresh comment', async () => {
    const fetchMock = jest.fn()
      // PATCH returns 404
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
    });

    // NEW comment id, created=true so the caller persists the new id.
    expect(result).toEqual({ commentId: 8, created: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('POST');
  });

  test('non-404 error (500) propagates without retry', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse({ status: 500, ok: false, etag: null }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      upsertTaskComment({
        repo: 'owner/repo',
        issueOrPrNumber: 42,
        body: 'new',
        token: 't',
        existingCommentId: 7,
      }),
    ).rejects.toMatchObject({ name: 'GitHubCommentError', httpStatus: 500 });
    // No retry on generic 5xx — caller's batch-level dispatcher log is
    // the right layer to see the failure.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('non-404 error (400) propagates without retry (guards against the If-Match regression reappearing silently)', async () => {
    // If a future refactor re-adds a conditional header and GitHub
    // returns 400, the error should bubble up as a GitHubCommentError
    // with httpStatus=400 rather than being swallowed. The fallback
    // POST must NOT fire on 400 — only 404 (comment deleted) triggers
    // the POST retry.
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse({ status: 400, ok: false, etag: null }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      upsertTaskComment({
        repo: 'owner/repo',
        issueOrPrNumber: 42,
        body: 'new',
        token: 't',
        existingCommentId: 7,
      }),
    ).rejects.toMatchObject({ name: 'GitHubCommentError', httpStatus: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('network error during PATCH is wrapped in GitHubCommentError', async () => {
    const fetchMock = jest.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      upsertTaskComment({
        repo: 'owner/repo',
        issueOrPrNumber: 42,
        body: 'new',
        token: 't',
        existingCommentId: 7,
      }),
    ).rejects.toBeInstanceOf(GitHubCommentError);
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
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ body: '# The Body' });
  });
});

describe('github-comment: X-RateLimit-Remaining WARN-below-500 (L3 item 4)', () => {
  test('emits a WARN when x-ratelimit-remaining < 500 on POST response', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 201,
        etag: '"abc"',
        body: { id: 1, body: 'b' },
        rateLimitRemaining: '450',
        rateLimitReset: '1714500000',
      }),
    ) as unknown as typeof fetch;

    await upsertTaskComment({
      repo: 'owner/repo',
      issueOrPrNumber: 1,
      body: 'b',
      token: 't',
      existingCommentId: undefined,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      'GitHub rate limit low',
      expect.objectContaining({
        event: 'github.rate_limit_low',
        remaining: 450,
        reset_at: '1714500000',
        repo: 'owner/repo',
      }),
    );
  });

  test('emits a WARN when x-ratelimit-remaining < 500 on PATCH response', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Single-call PATCH path.
    global.fetch = jest.fn().mockResolvedValueOnce(
      mockResponse({
        status: 200,
        etag: '"after"',
        body: { id: 7 },
        rateLimitRemaining: '100',
      }),
    ) as unknown as typeof fetch;

    await upsertTaskComment({
      repo: 'owner/repo',
      issueOrPrNumber: 42,
      body: 'new',
      token: 't',
      existingCommentId: 7,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      'GitHub rate limit low',
      expect.objectContaining({ remaining: 100, repo: 'owner/repo' }),
    );
  });

  test('does NOT warn when x-ratelimit-remaining is well above the 500 threshold', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 201,
        etag: '"abc"',
        body: { id: 1, body: 'b' },
        rateLimitRemaining: '4999',
      }),
    ) as unknown as typeof fetch;

    await upsertTaskComment({
      repo: 'owner/repo',
      issueOrPrNumber: 1,
      body: 'b',
      token: 't',
      existingCommentId: undefined,
    });

    // Rate-limit WARN is the only warn site touched by this path; a
    // future unrelated warn in the dispatcher would break this. Pin
    // specifically on the rate-limit event name.
    const rateLimitWarns = warnSpy.mock.calls.filter(
      c => (c[1] as Record<string, unknown> | undefined)?.event === 'github.rate_limit_low',
    );
    expect(rateLimitWarns).toHaveLength(0);
  });

  test('does NOT warn when x-ratelimit-remaining is absent (e.g. GHES variants)', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 201,
        etag: '"abc"',
        body: { id: 1, body: 'b' },
        // No rateLimitRemaining set — header absent on the response.
      }),
    ) as unknown as typeof fetch;

    await upsertTaskComment({
      repo: 'owner/repo',
      issueOrPrNumber: 1,
      body: 'b',
      token: 't',
      existingCommentId: undefined,
    });

    const rateLimitWarns = warnSpy.mock.calls.filter(
      c => (c[1] as Record<string, unknown> | undefined)?.event === 'github.rate_limit_low',
    );
    expect(rateLimitWarns).toHaveLength(0);
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
