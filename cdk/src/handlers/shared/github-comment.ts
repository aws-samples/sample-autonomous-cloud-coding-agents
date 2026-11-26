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
 * GitHub's REST API does not support ``If-Match`` on
 * ``PATCH /issues/comments/{id}``: every conditional PATCH returns
 * HTTP 400 with
 * ``"Conditional request headers are not allowed in unsafe requests
 * unless supported by the endpoint"``. The ETag returned on GET is a
 * cache validator only. Measured in PR #52.
 */

import { logger } from './logger';
import { coerceNumericOrNull } from './numeric';

const GITHUB_ACCEPT = 'application/vnd.github.v3+json';

const GITHUB_TIMEOUT_MS = 5_000;

const USER_AGENT = 'abca-fanout/1.0';

// GitHub's authenticated rate limit is 5000 requests per hour.
const RATE_LIMIT_WARN_THRESHOLD = 500;

function logRateLimitIfLow(response: Response, repo: string): void {
  const remainingHeader = response.headers.get('x-ratelimit-remaining');
  if (remainingHeader === null) return;
  const remaining = Number(remainingHeader);
  if (!Number.isFinite(remaining) || remaining >= RATE_LIMIT_WARN_THRESHOLD) {
    return;
  }
  logger.warn('GitHub rate limit low', {
    event: 'github.rate_limit_low',
    remaining,
    reset_at: response.headers.get('x-ratelimit-reset') ?? undefined,
    repo,
  });
}

/** Result of a comment upsert. ``created`` distinguishes the initial
 *  POST from subsequent PATCHes. */
export interface UpsertCommentResult {
  readonly commentId: number;
  readonly created: boolean;
}

interface GitHubCommentResponse {
  readonly id: number;
  readonly body: string;
}

/** Error that escapes this module. All HTTP errors funnel through here. */
export class GitHubCommentError extends Error {
  readonly httpStatus: number | undefined;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = 'GitHubCommentError';
    this.httpStatus = httpStatus;
  }
}

/**
 * Create or update the single in-place comment for a task.
 *
 * Flow:
 *   - If ``existingCommentId`` is undefined, POST a new comment and
 *     return its id.
 *   - Otherwise PATCH the existing comment directly (one GitHub call
 *     per event, no GET round-trip).
 *   - On 404, treat the comment as deleted upstream and POST a fresh
 *     one.
 *
 * All errors are thrown as ``GitHubCommentError`` — the caller is
 * expected to ``try/catch`` and log rather than propagating.
 */
export async function upsertTaskComment(params: {
  repo: string;
  issueOrPrNumber: number;
  body: string;
  token: string;
  existingCommentId: number | undefined;
}): Promise<UpsertCommentResult> {
  const { repo, issueOrPrNumber, body, token, existingCommentId } = params;

  if (existingCommentId === undefined) {
    return createComment({ repo, issueOrPrNumber, body, token });
  }

  try {
    return await patchExistingComment({
      repo,
      commentId: existingCommentId,
      body,
      token,
    });
  } catch (err) {
    if (err instanceof GitHubCommentError && err.httpStatus === 404) {
      logger.warn('[github-comment] previous comment deleted upstream, re-creating', {
        event: 'github.comment.recreated',
        repo,
        comment_id: existingCommentId,
      });
      return createComment({ repo, issueOrPrNumber, body, token });
    }
    throw err;
  }
}

async function patchExistingComment(params: {
  repo: string;
  commentId: number;
  body: string;
  token: string;
}): Promise<UpsertCommentResult> {
  const { repo, commentId, body, token } = params;
  const url = `https://api.github.com/repos/${repo}/issues/comments/${commentId}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': GITHUB_ACCEPT,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitHubCommentError(
      `PATCH /repos/${repo}/issues/comments/${commentId} network error: ${String(err)}`,
    );
  }

  logRateLimitIfLow(res, repo);
  if (!res.ok) {
    throw new GitHubCommentError(
      `PATCH /repos/${repo}/issues/comments/${commentId} failed: HTTP ${res.status}`,
      res.status,
    );
  }

  return { commentId, created: false };
}

async function createComment(params: {
  repo: string;
  issueOrPrNumber: number;
  body: string;
  token: string;
}): Promise<UpsertCommentResult> {
  const { repo, issueOrPrNumber, body, token } = params;
  const url = `https://api.github.com/repos/${repo}/issues/${issueOrPrNumber}/comments`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': GITHUB_ACCEPT,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitHubCommentError(
      `POST /repos/${repo}/issues/${issueOrPrNumber}/comments network error: ${String(err)}`,
    );
  }

  logRateLimitIfLow(res, repo);
  if (!res.ok) {
    throw new GitHubCommentError(
      `POST /repos/${repo}/issues/${issueOrPrNumber}/comments failed: HTTP ${res.status}`,
      res.status,
    );
  }

  let payload: GitHubCommentResponse;
  try {
    payload = (await res.json()) as GitHubCommentResponse;
  } catch {
    throw new GitHubCommentError(
      `POST comment response was not JSON (repo=${repo}, issue=${issueOrPrNumber})`,
    );
  }
  if (typeof payload.id !== 'number') {
    throw new GitHubCommentError(
      `POST comment response missing numeric id (repo=${repo}, issue=${issueOrPrNumber})`,
    );
  }
  return { commentId: payload.id, created: true };
}

/** Hidden HTML marker prefix that tags every bgagent-owned comment. */
export const BGAGENT_COMMENT_MARKER_PREFIX = 'bgagent:task-id=';

/** GitHub issue-comment body hard cap is 65 536 UTF-16 code units; a
 *  longer body fails the PATCH with 422. */
const MAX_COMMENT_BODY_CHARS = 60_000;

const COST_USD_DECIMAL_PLACES = 4;

function sanitizeEventType(eventType: string): string {
  return eventType.replace(/[`|\r\n]/g, '');
}

/**
 * Sanitize a ``prUrl`` before interpolating it into a Markdown link
 * target (``[link](<here>)``). Any URL that fails validation returns
 * ``null`` and the caller must omit the Pull-request row entirely.
 */
export function sanitizeMarkdownLinkTarget(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  if (/[\r\n\t\s)|\]"<>`]/.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null; // nosemgrep: ts-silent-success-masking -- malformed URL input is rejected; null is the validation contract, not a masked infra error
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return url;
}

function bgagentMarker(taskId: string): string {
  return `<!-- ${BGAGENT_COMMENT_MARKER_PREFIX}${taskId} -->`;
}

/**
 * A compact terminal-friendly summary the GitHub comment displays as
 * the task progresses.
 */
export interface CommentBodyInput {
  readonly taskId: string;
  readonly status: string;
  readonly repo: string;
  readonly latestEventType: string;
  readonly latestEventAt: string;
  readonly prUrl: string | null;
  readonly durationS: number | string | null;
  readonly costUsd: number | string | null;
}

/**
 * Render the Markdown body for the in-place comment. Pure: no timing,
 * no network. The only side effect is a ``logger.warn`` via
 * ``coerceNumericOrNull`` if a numeric field arrives with a non-finite
 * value (e.g. ``'NaN'``).
 *
 * Non-finite numeric values (``NaN``, ``Infinity``) collapse to null and
 * omit the row; finite values (including parseable strings) render
 * normally. A ``prUrl`` that ``sanitizeMarkdownLinkTarget`` rejects omits
 * the row.
 */
export function renderCommentBody(input: CommentBodyInput): string {
  const durationS = coerceNumericOrNull(
    input.durationS,
    { field: 'duration_s', task_id: input.taskId },
    logger,
  );
  const costUsd = coerceNumericOrNull(
    input.costUsd,
    { field: 'cost_usd', task_id: input.taskId },
    logger,
  );
  const safePrUrl = sanitizeMarkdownLinkTarget(input.prUrl);

  const lines: string[] = [];
  lines.push(bgagentMarker(input.taskId));
  lines.push(`### Background agent — ${input.status}`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| Task  | \`${input.taskId}\` |`);
  lines.push(`| Repo  | \`${input.repo}\` |`);
  lines.push(`| Status | **${input.status}** |`);
  lines.push(`| Last event | \`${sanitizeEventType(input.latestEventType)}\` @ ${input.latestEventAt} |`);
  if (safePrUrl) {
    lines.push(`| Pull request | [link](${safePrUrl}) |`);
  }
  if (durationS !== null) {
    lines.push(`| Duration | ${durationS}s |`);
  }
  if (costUsd !== null) {
    lines.push(`| Cost | $${costUsd.toFixed(COST_USD_DECIMAL_PLACES)} |`);
  }
  const rendered = lines.join('\n');
  if (rendered.length <= MAX_COMMENT_BODY_CHARS) return rendered;
  return rendered.slice(0, MAX_COMMENT_BODY_CHARS) + '\n\n…(truncated — body exceeded 60 000 chars)';
}
