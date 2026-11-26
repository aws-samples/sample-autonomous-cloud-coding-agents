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
  sanitizeMarkdownLinkTarget,
  upsertTaskComment,
} from '../../../src/handlers/shared/github-comment';
import { logger } from '../../../src/handlers/shared/logger';

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
      }),
    ).rejects.toMatchObject({ name: 'GitHubCommentError', httpStatus: 422 });
  });

  test('POST response without an ETag header is accepted (ETag is no longer load-bearing)', async () => {
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
    // GitHub rejects ``If-Match`` on ``PATCH /issues/comments/{id}`` with HTTP 400.
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
    expect(headers['If-Match']).toBeUndefined();
    expect(headers['If-None-Match']).toBeUndefined();
  });

  test('on 404 (comment deleted upstream): falls back to POSTing a fresh comment', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse({ status: 404, ok: false, etag: null }))
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('non-404 error (400) propagates without retry (guards against the If-Match regression reappearing silently)', async () => {
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

    expect(body.startsWith('<!-- bgagent:task-id=abc123 -->')).toBe(true);
    expect(body).toContain('| Task  | `abc123` |');
    expect(body).toContain('| Status | **RUNNING** |');
    expect(body).toContain('agent_milestone');
    expect(body).toContain('[link](https://github.com/owner/repo/pull/42)');
    expect(body).toContain('| Duration | 90s |');
    expect(body).toContain('| Cost | $0.2500 |');
  });

  test('sanitizes event types that contain Markdown-breaking characters', () => {
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
    expect(body).not.toMatch(/agent`/);
  });

  test('truncates bodies that would exceed the 65 536 GitHub ceiling', () => {
    const hugeStatus = 'RUNNING'.repeat(10_000);
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
    expect(body).toContain('| Task  | `abc` |');
    expect(body).toContain('| Status | **SUBMITTED** |');
  });
});

describe('github-comment: renderCommentBody numeric self-defense (finding #9)', () => {
  test('string-typed costUsd from an uncoerced DDB Item does NOT throw', () => {
    const body = renderCommentBody({
      taskId: 'abc',
      status: 'COMPLETED',
      repo: 'o/r',
      latestEventType: 'task_completed',
      latestEventAt: '2026-05-05T00:00:00Z',
      prUrl: null,
      durationS: '96.0' as unknown as number,
      costUsd: '0.20939010000000002' as unknown as number,
    });
    expect(body).toContain('| Cost | $0.2094 |');
    expect(body).toContain('| Duration | 96s |');
  });

  test('non-finite string costUsd collapses to null and omits the Cost row', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const body = renderCommentBody({
        taskId: 'abc',
        status: 'COMPLETED',
        repo: 'o/r',
        latestEventType: 'task_completed',
        latestEventAt: '2026-05-05T00:00:00Z',
        prUrl: null,
        durationS: null,
        costUsd: 'not-a-number' as unknown as number,
      });
      expect(body).not.toContain('$NaN');
      expect(body).not.toContain('| Cost |');
      const coercionWarn = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'numeric.coercion_failed',
      );
      expect(coercionWarn).toBeDefined();
      expect((coercionWarn?.[1] as Record<string, unknown>).field).toBe('cost_usd');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('null cost / duration render no row (unchanged behavior — absent is not corrupt)', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      renderCommentBody({
        taskId: 'abc',
        status: 'RUNNING',
        repo: 'o/r',
        latestEventType: 'agent_turn',
        latestEventAt: '2026-05-05T00:00:00Z',
        prUrl: null,
        durationS: null,
        costUsd: null,
      });
      const coercionWarns = warnSpy.mock.calls.filter(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'numeric.coercion_failed',
      );
      expect(coercionWarns).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('github-comment: sanitizeMarkdownLinkTarget (finding #12)', () => {
  test('accepts a well-formed https GitHub PR URL unchanged', () => {
    const ok = 'https://github.com/owner/repo/pull/42';
    expect(sanitizeMarkdownLinkTarget(ok)).toBe(ok);
  });

  test('accepts a plain http URL unchanged', () => {
    // Enterprise / self-hosted GitHub may serve over plain HTTP in internal networks.
    const ok = 'http://github.internal/owner/repo/pull/7';
    expect(sanitizeMarkdownLinkTarget(ok)).toBe(ok);
  });

  test.each([
    ['close-paren', 'https://evil.example.com/a)|injected'],
    ['pipe', 'https://evil.example.com/a|new-col'],
    ['newline', 'https://evil.example.com/a\nnew line'],
    ['carriage-return', 'https://evil.example.com/a\rnew line'],
    ['bracket', 'https://evil.example.com/a]extra'],
    ['quote', 'https://evil.example.com/a"title"'],
    ['space', 'https://evil.example.com/a b'],
    ['tab', 'https://evil.example.com/a\tb'],
    ['backtick', 'https://evil.example.com/a`b'],
  ])('rejects %s injection attempt: %s', (_label, crafted) => {
    expect(sanitizeMarkdownLinkTarget(crafted)).toBeNull();
  });

  test.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['file', 'file:///etc/passwd'],
    ['ftp', 'ftp://evil.example.com/x'],
  ])('rejects non-http(s) scheme: %s', (_label, bad) => {
    expect(sanitizeMarkdownLinkTarget(bad)).toBeNull();
  });

  test('rejects a malformed URL that cannot be parsed', () => {
    expect(sanitizeMarkdownLinkTarget('not a url at all')).toBeNull();
  });

  test('null / undefined pass through as null (omits the row)', () => {
    expect(sanitizeMarkdownLinkTarget(null)).toBeNull();
    expect(sanitizeMarkdownLinkTarget(undefined)).toBeNull();
  });
});

describe('github-comment: renderCommentBody Markdown-link injection guard (finding #12)', () => {
  test('crafted prUrl with ) | ] does not break the Markdown table', () => {
    const body = renderCommentBody({
      taskId: 'abc',
      status: 'COMPLETED',
      repo: 'o/r',
      latestEventType: 'task_completed',
      latestEventAt: '2026-05-05T00:00:00Z',
      prUrl: 'evil)|injected' as unknown as string,
      durationS: null,
      costUsd: null,
    });
    expect(body).not.toContain('Pull request');
    expect(body).not.toMatch(/\[link\]\([^)]*[|)]/);
  });

  test('javascript: scheme prUrl is rejected (omits the row rather than rendering)', () => {
    const body = renderCommentBody({
      taskId: 'abc',
      status: 'RUNNING',
      repo: 'o/r',
      latestEventType: 'task_created',
      latestEventAt: '2026-05-05T00:00:00Z',
      prUrl: 'javascript:alert(1)' as unknown as string,
      durationS: null,
      costUsd: null,
    });
    expect(body).not.toContain('javascript:');
    expect(body).not.toContain('Pull request');
  });

  test('legitimate https PR URL still renders the link row unchanged', () => {
    const prUrl = 'https://github.com/owner/repo/pull/42';
    const body = renderCommentBody({
      taskId: 'abc',
      status: 'COMPLETED',
      repo: 'owner/repo',
      latestEventType: 'task_completed',
      latestEventAt: '2026-05-05T00:00:00Z',
      prUrl,
      durationS: null,
      costUsd: null,
    });
    expect(body).toContain(`| Pull request | [link](${prUrl}) |`);
  });
});
