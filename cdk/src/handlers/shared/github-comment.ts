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
 * by default. Concurrency is handled with GitHub's ``If-Match`` / ETag:
 * on 412 Precondition Failed, re-GET the current comment and retry the
 * PATCH once. If the comment was deleted upstream (404 on GET), fall
 * back to POSTing a fresh one. DDB Stream ordering plus ETag optimistic
 * concurrency avoids the need for SQS FIFO serialization.
 *
 * Raw ``fetch`` is used rather than octokit to match the existing
 * codebase pattern (``preflight.ts``, ``context-hydration.ts``).
 */

import { logger } from './logger';

/** GitHub REST v3 media type — required on writes for stable behavior. */
const GITHUB_ACCEPT = 'application/vnd.github.v3+json';

/** Per-request timeout. GitHub's API is usually sub-second; 5 s is a
 *  generous ceiling for edge cases like region failover. */
const GITHUB_TIMEOUT_MS = 5_000;

/** User-Agent required by the GitHub API on all writes. */
const USER_AGENT = 'abca-fanout/1.0';

/** Result of a comment upsert. ``created`` distinguishes the initial
 *  POST from subsequent PATCHes so the caller can gate the TaskRecord
 *  UpdateItem (first call persists the comment_id; later calls refresh
 *  only the etag). */
export interface UpsertCommentResult {
  readonly commentId: number;
  readonly etag: string;
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
 *     return its id + etag.
 *   - If ``existingEtag`` is known, try ``PATCH`` directly with
 *     ``If-Match: <etag>`` first (the steady-state happy path — one
 *     GitHub call per event). On 412 we re-GET the current etag and
 *     retry the PATCH exactly once. Without a stored etag we fall
 *     back to the defensive GET-then-PATCH pattern.
 *   - On 404, treat the comment as deleted upstream and POST a
 *     fresh one.
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
  existingEtag: string | undefined;
}): Promise<UpsertCommentResult> {
  const { repo, issueOrPrNumber, body, token, existingCommentId, existingEtag } = params;

  if (existingCommentId === undefined) {
    return createComment({ repo, issueOrPrNumber, body, token });
  }

  try {
    return await patchExistingComment({
      repo,
      commentId: existingCommentId,
      body,
      token,
      existingEtag,
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
 * PATCH an existing comment, preferring a cached ``If-Match`` etag for
 * the steady-state one-call path (design §6.4). On 412 (the stored
 * etag is stale) we re-GET to capture the current etag and retry the
 * PATCH exactly once. Without a stored etag we GET first — same shape
 * as a cold-start re-resync.
 *
 * A second 412 gives up — something else is racing us too aggressively,
 * and swallowing it silently would mislead operators. 404 (comment
 * deleted upstream) propagates to the caller which triggers the POST
 * fallback.
 */
async function patchExistingComment(params: {
  repo: string;
  commentId: number;
  body: string;
  token: string;
  existingEtag: string | undefined;
}): Promise<UpsertCommentResult> {
  const { repo, commentId, body, token, existingEtag } = params;

  let etag: string;
  if (existingEtag) {
    // Steady-state path: use the cached etag. One GitHub call per event.
    etag = existingEtag;
  } else {
    // Cold start / never-patched: fetch the current etag to establish baseline.
    ({ etag } = await getComment({ repo, commentId, token }));
  }

  let patch = await tryPatch({ repo, commentId, body, token, etag });
  if (patch.ok) {
    return { commentId, etag: patch.etag, created: false };
  }

  // The GET-not-found path is a distinct failure (404 here means the
  // tryPatch itself returned 404 — comment was deleted between our
  // last successful write and this one). Propagate for POST-fallback.
  if (patch.status === 404) {
    throw new GitHubCommentError(
      `PATCH /repos/${repo}/issues/comments/${commentId} failed: HTTP 404`,
      404,
    );
  }

  if (patch.status === 412) {
    logger.info('[github-comment] PATCH 412, re-fetching ETag and retrying once', {
      event: 'github.comment.etag_retry',
      repo,
      comment_id: commentId,
    });
    ({ etag } = await getComment({ repo, commentId, token }));
    patch = await tryPatch({ repo, commentId, body, token, etag });
    if (patch.ok) {
      return { commentId, etag: patch.etag, created: false };
    }
  }

  throw new GitHubCommentError(
    `PATCH /repos/${repo}/issues/comments/${commentId} failed: HTTP ${patch.status}`,
    patch.status,
  );
}

interface GetCommentResult {
  readonly etag: string;
}

async function getComment(params: {
  repo: string;
  commentId: number;
  token: string;
}): Promise<GetCommentResult> {
  const { repo, commentId, token } = params;
  const url = `https://api.github.com/repos/${repo}/issues/comments/${commentId}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': GITHUB_ACCEPT,
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitHubCommentError(
      `GET /repos/${repo}/issues/comments/${commentId} network error: ${String(err)}`,
    );
  }

  if (!res.ok) {
    throw new GitHubCommentError(
      `GET /repos/${repo}/issues/comments/${commentId} failed: HTTP ${res.status}`,
      res.status,
    );
  }

  const etag = res.headers.get('etag');
  if (!etag) {
    // GitHub always returns an ETag on comment GETs. An absent header
    // is a server contract break — bail rather than silently PATCH
    // without optimistic concurrency.
    throw new GitHubCommentError(`GET comment response missing ETag header (repo=${repo}, id=${commentId})`);
  }
  return { etag };
}

interface PatchResult {
  readonly ok: boolean;
  readonly status: number;
  readonly etag: string;
}

async function tryPatch(params: {
  repo: string;
  commentId: number;
  body: string;
  token: string;
  etag: string;
}): Promise<PatchResult> {
  const { repo, commentId, body, token, etag } = params;
  const url = `https://api.github.com/repos/${repo}/issues/comments/${commentId}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': GITHUB_ACCEPT,
        'User-Agent': USER_AGENT,
        'If-Match': etag,
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

  if (!res.ok) {
    return { ok: false, status: res.status, etag: '' };
  }

  const newEtag = res.headers.get('etag');
  if (!newEtag) {
    throw new GitHubCommentError(
      `PATCH comment response missing ETag header (repo=${repo}, id=${commentId})`,
    );
  }
  return { ok: true, status: res.status, etag: newEtag };
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

  const etag = res.headers.get('etag');
  if (!etag) {
    // POST without an ETag means we can't reliably PATCH later. Rather
    // than carrying an empty string that would always 412 on the first
    // edit, fail visibly.
    throw new GitHubCommentError(
      `POST comment response missing ETag header (repo=${repo}, issue=${issueOrPrNumber})`,
    );
  }
  return { commentId: payload.id, etag, created: true };
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

function bgagentMarker(taskId: string): string {
  return `<!-- ${BGAGENT_COMMENT_MARKER_PREFIX}${taskId} -->`;
}

/** A compact terminal-friendly summary the GitHub comment displays as
 *  the task progresses. Kept small on purpose — GitHub truncates long
 *  comments in mobile / email notifications and the PR activity log
 *  accumulates the full history anyway. */
export interface CommentBodyInput {
  readonly taskId: string;
  readonly status: string;
  readonly repo: string;
  readonly latestEventType: string;
  readonly latestEventAt: string;
  readonly prUrl: string | null;
  readonly durationS: number | null;
  readonly costUsd: number | null;
}

/**
 * Render the Markdown body for the in-place comment. Pure: no logger,
 * no timing, no side effects — callers can snapshot-test the exact
 * bytes without monkey-patching anything.
 */
export function renderCommentBody(input: CommentBodyInput): string {
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
  if (input.prUrl) {
    lines.push(`| Pull request | [link](${input.prUrl}) |`);
  }
  if (input.durationS !== null) {
    lines.push(`| Duration | ${input.durationS}s |`);
  }
  if (input.costUsd !== null) {
    lines.push(`| Cost | $${input.costUsd.toFixed(4)} |`);
  }
  const rendered = lines.join('\n');
  if (rendered.length <= MAX_COMMENT_BODY_CHARS) return rendered;
  // Truncate mid-body with a visible marker so the GitHub API accepts
  // the edit and a human inspecting the PR sees that data was lost.
  return rendered.slice(0, MAX_COMMENT_BODY_CHARS) + '\n\n…(truncated — body exceeded 60 000 chars)';
}
