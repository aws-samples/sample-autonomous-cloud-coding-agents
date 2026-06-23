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
 * Outcome of a single comment POST. We distinguish auth rejection (401/403)
 * from other failures so the caller can react to the former with a forced
 * token refresh + retry, and treat the latter as terminal.
 */
type PostOutcome = 'ok' | 'auth' | 'error';

async function postComment(
  accessToken: string,
  cloudId: string,
  issueIdOrKey: string,
  message: string,
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
      body: JSON.stringify({ body: toAdfDocument(message) }),
      signal: controller.signal,
    });
    if (resp.ok) return 'ok';
    // 401/403 are recoverable: the stored access token may be dead despite a
    // not-yet-reached `expires_at` (server-side revocation, scope re-issue, or
    // a value cached past its out-of-band rotation). Signal the caller to
    // force-refresh and retry once. Any other non-2xx is terminal.
    const outcome: PostOutcome = resp.status === 401 || resp.status === 403 ? 'auth' : 'error';
    logger.warn('Jira feedback REST non-2xx', { status: resp.status, url, outcome });
    return outcome;
  } catch (err) {
    logger.warn('Jira feedback request failed', {
      error: err instanceof Error ? err.message : String(err),
      url,
    });
    return 'error';
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
  const resolved = await resolveTenantToken(ctx);
  if (!resolved) return false;

  const outcome = await postComment(resolved.accessToken, ctx.cloudId, issueIdOrKey, body);
  if (outcome === 'ok') return true;
  if (outcome === 'error') return false;

  // outcome === 'auth': the stored access token was rejected. Force a refresh
  // (bypassing the resolver's cache and proactive-expiry short-circuit) and
  // retry once with the freshly-minted token.
  logger.info('Jira feedback got auth rejection — forcing token refresh and retrying once', {
    jira_cloud_id: ctx.cloudId,
    issue_id_or_key: issueIdOrKey,
  });
  const refreshed = await resolveTenantToken(ctx, true);
  if (!refreshed) return false;
  // If the refresh handed back the same access token, the retry can only
  // reproduce the 401 — skip the redundant network call.
  if (refreshed.accessToken === resolved.accessToken) {
    logger.warn('Jira feedback refresh returned an unchanged token — not retrying', {
      jira_cloud_id: ctx.cloudId,
      issue_id_or_key: issueIdOrKey,
    });
    return false;
  }
  return (await postComment(refreshed.accessToken, ctx.cloudId, issueIdOrKey, body)) === 'ok';
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
