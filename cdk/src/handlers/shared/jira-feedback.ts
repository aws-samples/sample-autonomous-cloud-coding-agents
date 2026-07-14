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

import { resolveJiraOauthToken } from './jira-oauth-resolver';
import { logger } from './logger';

/**
 * Lambda-side helper for posting comments onto Jira Cloud issues via the
 * Atlassian REST v3 API. Used by the webhook processor to give users
 * feedback on pre-container failures (guardrail block, concurrency cap,
 * unmapped project, etc.) — paths where the agent never starts and the
 * agent-side Jira MCP cannot run.
 *
 * Unlike Linear, Jira has no "reaction" primitive. The failure marker
 * (❌) is folded into the comment text instead of attached as a separate
 * reaction call.
 *
 * All calls are best-effort. Errors are logged at WARN and swallowed —
 * Jira feedback is advisory and must never gate task-rejection logic.
 */

const REQUEST_TIMEOUT_MS = 5000;

/**
 * Atlassian cross-region REST gateway base. The per-tenant OAuth token is
 * minted with `audience=api.atlassian.com` (see `cli/src/jira-oauth.ts`), so
 * it is only valid against this gateway host scoped by `{cloudId}` — NOT
 * against the raw `*.atlassian.net` site host, which 401s such a token. The
 * agent-side path (`agent/src/jira_reactions.py`) uses the same base.
 */
const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';

/**
 * Wrap a plain message string in Atlassian Document Format. Jira REST v3
 * comments require ADF, not markdown. We keep this minimal — a single
 * paragraph with the raw text — because the messages are short, user-
 * facing strings written by the processor (no embedded markdown to
 * preserve).
 */
function toAdfDocument(message: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: message }],
      },
    ],
  };
}

/**
 * A single run of comment text with optional inline emphasis / hyperlink.
 * The ADF serializer ({@link buildAdfDocument}) maps ``strong``/``em`` onto
 * ADF ``marks`` and ``href`` onto an ADF ``link`` mark. Callers that need
 * plain text simply omit all flags. This is the smallest content model that
 * lets the fan-out final-status comment render a bold header, an italic
 * task-id footer, and a clickable PR link without hand-building ADF at every
 * call site (issue #573).
 *
 * ``href`` matters because ADF — unlike Linear's Markdown — does NOT
 * auto-linkify a bare URL sitting in a plain text node: it renders as
 * unclickable text unless the run carries an explicit ``link`` mark.
 */
export interface AdfTextRun {
  readonly text: string;
  readonly strong?: boolean;
  readonly em?: boolean;
  /** When set, the run renders as a clickable hyperlink to this URL. */
  readonly href?: string;
}

/** A paragraph is a list of runs; an empty run list renders a blank line. */
export type AdfParagraph = ReadonlyArray<AdfTextRun>;

/**
 * Build a multi-paragraph ADF document. Each element of ``paragraphs``
 * becomes one ADF ``paragraph`` node; an empty run list yields an empty
 * paragraph (Jira renders it as a blank line, which is how we get the
 * spacing between the header, the metrics line, and the footer without
 * embedding ``\n`` — ADF text nodes do not honor newlines).
 *
 * Exported for the fan-out final-status renderer + its tests. The
 * single-paragraph {@link toAdfDocument} stays for the short processor
 * messages that have no structure to preserve.
 */
export function buildAdfDocument(paragraphs: ReadonlyArray<AdfParagraph>): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((runs) => ({
      type: 'paragraph',
      content: runs.map((run) => {
        const marks: Array<Record<string, unknown>> = [];
        if (run.strong) marks.push({ type: 'strong' });
        if (run.em) marks.push({ type: 'em' });
        // ADF ``link`` mark — the only way to make a URL clickable in a
        // Jira comment; a bare URL in a text node stays plain text.
        if (run.href) marks.push({ type: 'link', attrs: { href: run.href } });
        return marks.length > 0
          ? { type: 'text', text: run.text, marks }
          : { type: 'text', text: run.text };
      }),
    })),
  };
}

/**
 * Classified outcome of a comment POST, mirroring Linear's
 * ``LinearPostResult``. ``retryable`` distinguishes transient failures
 * (network error, request timeout, HTTP 5xx/429) — where a Lambda retry
 * may genuinely succeed — from terminal ones (bad issue id, revoked
 * credential, malformed request) where it cannot. The best-effort
 * boolean-returning {@link postIssueComment} collapses this to
 * ``ok``/``!ok``; the fan-out dispatcher branches on ``retryable`` to
 * decide whether to escalate to the partial-batch retry path (#573).
 */
export type JiraPostResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryable: boolean };

/**
 * Outcome of a single comment POST. We distinguish auth rejection (401/403)
 * from other failures so the caller can react to the former with a forced
 * token refresh + retry. Non-auth failures carry a ``retryable`` flag so the
 * classified caller ({@link postCommentWithResult}) can tell a transient
 * 5xx/429/network blip from a terminal 4xx.
 */
type PostOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'auth' }
  | { readonly kind: 'error'; readonly retryable: boolean };

async function postComment(
  accessToken: string,
  cloudId: string,
  issueIdOrKey: string,
  body: Record<string, unknown>,
): Promise<PostOutcome> {
  // The 3LO token (audience=api.atlassian.com) is only valid against the
  // gateway base scoped by cloudId — see JIRA_API_BASE. Posting to the raw
  // site host (`*.atlassian.net`) would 401. Both path segments are
  // URL-encoded for defense-in-depth: cloudId is registry-sourced (a stored
  // tenant UUID), but encoding it keeps a malformed/compromised row from
  // injecting extra path segments into the gateway URL.
  const url = `${JIRA_API_BASE}/${encodeURIComponent(cloudId)}/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ body }),
      signal: controller.signal,
    });
    if (resp.ok) return { kind: 'ok' };
    // 401/403 are recoverable via a forced refresh: the stored access token
    // may be dead despite a not-yet-reached `expires_at` (server-side
    // revocation, scope re-issue, or a value cached past its out-of-band
    // rotation). Signal the caller to force-refresh and retry once. 5xx is a
    // Jira-side outage and 429 a rate limit — both may clear on a Lambda
    // retry. Any other non-2xx (400/404…) is terminal: re-sending the same
    // request cannot change the answer.
    if (resp.status === 401 || resp.status === 403) {
      logger.warn('Jira feedback REST auth rejection', { status: resp.status, url });
      return { kind: 'auth' };
    }
    const retryable = resp.status >= 500 || resp.status === 429;
    logger.warn('Jira feedback REST non-2xx', { status: resp.status, url, retryable });
    return { kind: 'error', retryable };
  } catch (err) {
    // fetch rejection: DNS/connect failure or the AbortController timeout —
    // transient by nature, so worth a retry.
    logger.warn('Jira feedback request failed', {
      error: err instanceof Error ? err.message : String(err),
      url,
    });
    return { kind: 'error', retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tenant-scoped feedback context. Resolved once per task by the caller
 * (webhook processor / orchestrator) and threaded through to the
 * post-comment helper, so the OAuth resolver runs once per task instead
 * of once per Jira API call.
 */
export interface JiraFeedbackContext {
  /** Atlassian tenant identifier (`cloudId`) — registry key. */
  readonly cloudId: string;
  /** Name of JiraWorkspaceRegistryTable, from CDK stack output. */
  readonly registryTableName: string;
}

async function resolveTenantToken(
  ctx: JiraFeedbackContext,
  forceRefresh = false,
): Promise<{ accessToken: string } | null> {
  try {
    const resolved = await resolveJiraOauthToken(ctx.cloudId, ctx.registryTableName, { forceRefresh });
    if (!resolved) return null;
    return { accessToken: resolved.accessToken };
  } catch (err) {
    // `force_refresh` discriminates the initial resolve from the post-401
    // retry resolve: a failure here on the retry is an infra error (DDB/SM),
    // distinct from "refresh-token revoked", and triage needs to tell them
    // apart.
    logger.warn('Jira feedback could not resolve OAuth token', {
      jira_cloud_id: ctx.cloudId,
      force_refresh: forceRefresh,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Post a comment onto a Jira issue. Returns true on success, false on any
 * failure (network, auth, REST errors). Never throws — callers proceed
 * regardless.
 *
 * Auth resilience: the access token from the resolver can already be stale
 * (cached within its TTL, or revoked/re-issued server-side before its
 * advertised `expires_at`). The proactive expiry check can't catch those, so
 * a 401/403 on the first POST triggers exactly one forced token refresh
 * (`forceRefresh: true`) and one retry. This is the path that makes feedback
 * comments — the only operator-visible failure signal — actually land after a
 * token goes bad, rather than silently 401ing (issue #370). The retry is
 * bounded at one attempt: a second 401 means the credential is genuinely
 * unusable (refresh-token revoked, scope removed), so we stop and let the
 * caller no-op.
 */
export async function postIssueComment(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  body: string,
): Promise<boolean> {
  const result = await postCommentWithResult(ctx, issueIdOrKey, toAdfDocument(body));
  return result.ok;
}

/**
 * Post a pre-built ADF document onto a Jira issue, returning a classified
 * {@link JiraPostResult} so a caller with a retry mechanism (the fan-out
 * dispatcher's partial-batch path, #573) can distinguish transient failures
 * worth a Lambda retry from terminal ones. Never throws.
 *
 * Shares the 401/403 forced-refresh-and-retry-once behaviour with
 * {@link postIssueComment} (issue #370). The auth-refresh path always
 * classifies its final failure as terminal ``{ retryable: false }`` — a
 * bad/revoked credential is not fixed by re-running the whole dispatcher.
 */
export async function postIssueCommentAdf(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  body: Record<string, unknown>,
): Promise<JiraPostResult> {
  return postCommentWithResult(ctx, issueIdOrKey, body);
}

async function postCommentWithResult(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  body: Record<string, unknown>,
): Promise<JiraPostResult> {
  const resolved = await resolveTenantToken(ctx);
  // Token resolution collapses every failure cause (registry miss, revoked
  // workspace, unreadable secret, transient DDB/SM throttle) into null. As
  // with linear-feedback, there is no signal left to tell a throttle from an
  // unregistered workspace, so we classify it terminal — the dispatcher's
  // marker-gated retry would not resolve a genuinely-missing credential.
  if (!resolved) return { ok: false, retryable: false };

  const outcome = await postComment(resolved.accessToken, ctx.cloudId, issueIdOrKey, body);
  if (outcome.kind === 'ok') return { ok: true };
  if (outcome.kind === 'error') return { ok: false, retryable: outcome.retryable };

  // outcome.kind === 'auth': the stored access token was rejected. Force a
  // refresh (bypassing the resolver's cache and proactive-expiry
  // short-circuit) and retry once with the freshly-minted token.
  logger.info('Jira feedback got auth rejection — forcing token refresh and retrying once', {
    jira_cloud_id: ctx.cloudId,
    issue_id_or_key: issueIdOrKey,
  });
  const refreshed = await resolveTenantToken(ctx, true);
  if (!refreshed) return { ok: false, retryable: false };
  // If the refresh handed back the same access token, the retry can only
  // reproduce the 401 — skip the redundant network call.
  if (refreshed.accessToken === resolved.accessToken) {
    logger.warn('Jira feedback refresh returned an unchanged token — not retrying', {
      jira_cloud_id: ctx.cloudId,
      issue_id_or_key: issueIdOrKey,
    });
    return { ok: false, retryable: false };
  }
  const retryOutcome = await postComment(refreshed.accessToken, ctx.cloudId, issueIdOrKey, body);
  if (retryOutcome.kind === 'ok') return { ok: true };
  // A second auth rejection means the credential is genuinely unusable —
  // terminal. A transient error on the retry stays retryable so the
  // dispatcher can escalate for a Lambda retry.
  if (retryOutcome.kind === 'error') return { ok: false, retryable: retryOutcome.retryable };
  return { ok: false, retryable: false };
}

/**
 * Post a feedback comment with the failure marker (❌) folded into the
 * message text. Mirrors `linear-feedback.reportIssueFailure` semantics
 * (best-effort, never throws, returns void) so callers don't branch on
 * the result. The marker is included in `message` by the caller — this
 * helper exists for symmetry with Linear's API surface.
 */
export async function reportIssueFailure(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  message: string,
): Promise<void> {
  await Promise.allSettled([postIssueComment(ctx, issueIdOrKey, message)]);
}
