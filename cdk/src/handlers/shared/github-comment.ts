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
 * GitHub issue-comment edit-in-place helper (design §6.4).
 *
 * The fan-out plane maintains a single GitHub comment per task, edited
 * in place as the agent progresses through terminal states + pr_created
 * by default. Concurrency is handled entirely upstream: DDB Streams on
 * ``TaskEventsTable`` with ``ParallelizationFactor: 1`` guarantee
 * per-task ordering, and the fanout Lambda is the only writer on its
 * own comment. A second writer cannot race us, so last-writer-wins is
 * safe — there is no concurrent edit to lose.
 *
 * (An earlier revision used GitHub's ``If-Match`` / ETag for optimistic
 * concurrency. That approach was abandoned after in-account validation
 * proved GitHub's REST API does not support ``If-Match`` on
 * ``PATCH /issues/comments/{id}``: every conditional PATCH returns
 * HTTP 400 with
 * ``"Conditional request headers are not allowed in unsafe requests
 * unless supported by the endpoint"``. The ETag returned on GET is a
 * cache validator only. See PR #52 Scenario 7-extended deploy
 * validation.)
 *
 * The 404 fallback path is preserved: if the target comment was
 * deleted upstream (e.g. a user cleaned up the PR thread), we POST a
 * fresh one rather than losing the task's status surface.
 *
 * Raw ``fetch`` is used rather than octokit to match the existing
 * codebase pattern (``preflight.ts``, ``context-hydration.ts``).
 */

import { logger } from './logger';
import { coerceNumericOrNull } from './numeric';

/** GitHub REST v3 media type — required on writes for stable behavior. */
const GITHUB_ACCEPT = 'application/vnd.github.v3+json';

/** Per-request timeout. GitHub's API is usually sub-second; 5 s is a
 *  generous ceiling for edge cases like region failover. */
const GITHUB_TIMEOUT_MS = 5_000;

/** User-Agent required by the GitHub API on all writes. */
const USER_AGENT = 'abca-fanout/1.0';

/** Rate-limit WARN threshold. GitHub's authenticated limit is 5000 req/h.
 *  Below 500 remaining we're within 10% of the 403 window — ops should
 *  see a signal well before the next-poll-storm exhausts the budget. */
const RATE_LIMIT_WARN_THRESHOLD = 500;

/**
 * Inspect ``X-RateLimit-Remaining`` on every GitHub response and emit a
 * WARN when the budget falls below ``RATE_LIMIT_WARN_THRESHOLD`` (L3
 * item 4). Does NOT block the request — the goal is an ops-visible
 * trail leading up to the 403 that would otherwise arrive unannounced.
 *
 * Called from both the POST and PATCH paths so partial-burst scenarios
 * (e.g. a reconciliation wave patching every comment) surface early.
 */
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
 *  POST from subsequent PATCHes so the caller can gate the TaskRecord
 *  UpdateItem (first call persists the comment_id; later calls are
 *  no-ops on the TaskRecord since we no longer track an ETag). */
export interface UpsertCommentResult {
  readonly commentId: number;
  readonly created: boolean;
}

/** Minimal shape of the GitHub issue-comment API response. */
interface GitHubCommentResponse {
  readonly id: number;
  readonly body: string;
}

/** Error that escapes this module. All HTTP errors funnel through here
 *  so the caller can log once and continue without introducing a new
 *  exception taxonomy. */
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
      // Upstream deletion — fall back to POSTing a fresh comment.
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

/**
 * PATCH an existing comment with the given body. One GitHub call per
 * event — no GET round-trip, no conditional headers (see file-level
 * rationale above). 404 propagates so the caller can POST-fallback.
 */
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

// ---------------------------------------------------------------------------
// Body rendering
// ---------------------------------------------------------------------------

/** Hidden HTML marker prefix that tags every bgagent-owned comment so
 *  a future reconciliation tool, user grep, or rehydration path can
 *  identify the in-place comment in a long PR thread. Exported so
 *  downstream callers (Chunk K forensics, Phase 3 audit trail, etc.)
 *  don't have to re-invent the regex. */
export const BGAGENT_COMMENT_MARKER_PREFIX = 'bgagent:task-id=';

/** GitHub issue-comment body hard cap is 65 536 UTF-16 code units. We
 *  leave 5 KB of headroom for the truncation marker and for rough
 *  utf-8-vs-utf-16 skew. Any body exceeding this is truncated at
 *  ``renderCommentBody`` time rather than failing the PATCH with 422. */
const MAX_COMMENT_BODY_CHARS = 60_000;

/** Sanitize a server-sourced event type for inclusion in a Markdown
 *  table cell. Strips backticks, pipes, and newlines that would break
 *  the table layout. Event types today are enum-like (snake_case), so
 *  this is defensive against future writers emitting freer-form
 *  values, not a live vulnerability. */
function sanitizeEventType(eventType: string): string {
  return eventType.replace(/[`|\r\n]/g, '');
}

/**
 * Sanitize a ``prUrl`` before interpolating it into a Markdown link
 * target (``[link](<here>)``). Without this guard a crafted URL could
 * break the table layout or inject trailing Markdown: ``)`` closes the
 * link prematurely, ``|`` starts a new table column, and CR / LF / ``]``
 * / ``"`` each let an attacker extend the comment body past the link.
 *
 * Strategy: strip the six characters that are meaningful inside
 * ``[text](target)`` Markdown AND reject anything that does not parse
 * as an ``http://`` or ``https://`` URL after the strip. The strip is
 * deliberately conservative — a legitimate GitHub PR URL
 * (``https://github.com/owner/repo/pull/42``) never contains any of the
 * listed characters, so false positives are effectively zero. Any URL
 * that fails validation returns ``null`` and the caller must omit the
 * Pull-request row entirely rather than risk a broken-layout comment.
 *
 * Refs: PR #52 krokoko code review finding #12 (Markdown injection
 * possible via ``prUrl`` in GitHub comment body).
 */
export function sanitizeMarkdownLinkTarget(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  // Reject anything carrying a Markdown-significant character. We do
  // NOT attempt to URL-encode these — encoded ``)`` (``%29``) would
  // render correctly, but encoding opens a harder surface to reason
  // about (e.g. an attacker who gets ``%0A`` past this function could
  // still break the table on some Markdown renderers). A flat reject
  // keeps the contract simple and the comment row trustworthy.
  if (/[\r\n\t\s)|\]"<>`]/.test(url)) return null;
  // Validate the parsed URL is http(s). A ``javascript:`` link target
  // is also attacker-controlled content and has no place in a status
  // comment. ``new URL`` throws on malformed input.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return url;
}

function bgagentMarker(taskId: string): string {
  return `<!-- ${BGAGENT_COMMENT_MARKER_PREFIX}${taskId} -->`;
}

/**
 * A compact terminal-friendly summary the GitHub comment displays as
 * the task progresses. Kept small on purpose — GitHub truncates long
 * comments in mobile / email notifications and the PR activity log
 * accumulates the full history anyway.
 *
 * The numeric fields accept ``string`` alongside ``number | null`` to
 * honestly model the DynamoDB Document-client boundary: ``Number``
 * attributes deserialize as JS ``string`` in some code paths (see
 * ``shared/numeric.ts``). ``renderCommentBody`` coerces defensively so
 * a future caller that forgets to run the shared coercion helper at
 * its own boundary does not crash the way the fanout dispatcher did in
 * Scenario 7-ext (``costUsd.toFixed is not a function``, commit
 * ``9fe704e``).
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
 * no network — callers can snapshot-test the exact bytes. The only
 * side effect is a ``logger.warn`` via ``coerceNumericOrNull`` if a
 * numeric field arrives with a non-finite value (e.g. ``'NaN'``), which
 * surfaces upstream writer bugs instead of silently dropping the row.
 *
 * Defense-in-depth vs. the caller's coercion (finding #9):
 *   - Callers SHOULD coerce DDB numerics at their own boundary using
 *     ``coerceNumericOrNull`` so the warn log carries their context
 *     (task_id, event_id). The fanout dispatcher does this today.
 *   - ``renderCommentBody`` coerces again internally so a future caller
 *     that forgets the boundary step (e.g. a Chunk K reconciler
 *     reading raw DDB items) still degrades to a null-omitted row
 *     instead of throwing ``TypeError: .toFixed is not a function``.
 *     Non-finite values (``NaN``, ``Infinity``) collapse to null and
 *     omit the row; finite values (including parseable strings) render
 *     normally.
 *
 * Markdown-link target sanitization (finding #12):
 *   - ``prUrl`` is interpolated into a Markdown link (``[link](<here>)``).
 *     Without sanitization a crafted URL containing ``)`` / ``|`` / CR
 *     / LF could break the table layout or inject trailing content.
 *     ``sanitizeMarkdownLinkTarget`` strips the injection surface and
 *     validates the URL is http(s); a rejected URL omits the row
 *     rather than rendering a broken or misleading link.
 */
export function renderCommentBody(input: CommentBodyInput): string {
  // Coerce DDB-string numerics defensively — see doc block above. The
  // context object gives the ``numeric.coercion_failed`` warn enough
  // breadcrumbs (field + task_id) to trace back to the upstream writer.
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
  // Sanitize the PR link target before interpolation. A rejected URL
  // returns null and the row is omitted.
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
    lines.push(`| Cost | $${costUsd.toFixed(4)} |`);
  }
  const rendered = lines.join('\n');
  if (rendered.length <= MAX_COMMENT_BODY_CHARS) return rendered;
  // Truncate mid-body with a visible marker so the GitHub API accepts
  // the edit and a human inspecting the PR sees that data was lost.
  return rendered.slice(0, MAX_COMMENT_BODY_CHARS) + '\n\n…(truncated — body exceeded 60 000 chars)';
}
