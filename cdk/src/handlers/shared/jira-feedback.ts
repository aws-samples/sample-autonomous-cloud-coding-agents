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

import { requestJiraAppActor } from './jira-app-actor';
import {
  resolveJiraOutboundAuth,
  type ResolvedJiraOutboundAuth,
} from './jira-oauth-resolver';
import { logger } from './logger';
import type { StateIntent, TransitionOptions } from './orchestration-channel';

/**
 * Lambda-side helper for posting comments onto Jira Cloud issues through the
 * configured Forge app actor or the legacy OAuth fallback. Used by the
 * webhook processor to give users
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
const CATEGORY_RANK: Readonly<Record<string, number>> = {
  new: 0,
  indeterminate: 1,
  done: 2,
};
const REVIEW_STATUS_NAMES = [
  'in review',
  'code review',
  'review',
  'peer review',
  'reviewing',
  'in progress',
] as const;

/** Render ABCA-generated Markdown into the small ADF subset Jira comments use. */
function toAdfDocument(message: string): Record<string, unknown> {
  return buildAdfDocument(message.split('\n').map(parseMarkdownRuns));
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
  readonly code?: boolean;
  /** When set, the run renders as a clickable hyperlink to this URL. */
  readonly href?: string;
}

/** A paragraph is a list of runs; an empty run list renders a blank line. */
export type AdfParagraph = ReadonlyArray<AdfTextRun>;

/**
 * Parse the controlled Markdown emitted by ABCA's own status renderers.
 *
 * This is intentionally not a general Markdown parser. The generated comments
 * use only bold, inline code, and links; handling that exact subset avoids
 * treating the whole panel as one literal ADF text node while keeping malformed
 * input harmless as plain text.
 */
export function parseMarkdownRuns(line: string): AdfParagraph {
  const runs: AdfTextRun[] = [];
  let cursor = 0;
  const append = (run: AdfTextRun): void => {
    if (!run.text) return;
    const previous = runs.at(-1);
    if (
      previous
      && previous.strong === run.strong
      && previous.em === run.em
      && previous.code === run.code
      && previous.href === run.href
    ) {
      runs[runs.length - 1] = { ...previous, text: previous.text + run.text };
      return;
    }
    runs.push(run);
  };

  while (cursor < line.length) {
    if (line.startsWith('**', cursor)) {
      const end = line.indexOf('**', cursor + 2);
      if (end !== -1) {
        for (const run of parseMarkdownRuns(line.slice(cursor + 2, end))) {
          append({ ...run, strong: true });
        }
        cursor = end + 2;
        continue;
      }
    }

    if (line[cursor] === '`') {
      const end = line.indexOf('`', cursor + 1);
      if (end !== -1) {
        append({ text: line.slice(cursor + 1, end), code: true });
        cursor = end + 1;
        continue;
      }
    }

    if (line[cursor] === '[') {
      const match = line.slice(cursor).match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
      if (match) {
        append({ text: match[1], href: match[2] });
        cursor += match[0].length;
        continue;
      }
    }

    const nextTokens = [
      line.indexOf('**', cursor + 1),
      line.indexOf('`', cursor + 1),
      line.indexOf('[', cursor + 1),
    ].filter((index) => index !== -1);
    const next = nextTokens.length > 0 ? Math.min(...nextTokens) : line.length;
    append({ text: line.slice(cursor, next) });
    cursor = next;
  }
  return runs;
}

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
        if (run.code) marks.push({ type: 'code' });
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
 * {@link postIssueComment} returns the created comment ID or null; the fan-out
 * dispatcher uses this classified result to decide whether to escalate to the
 * partial-batch retry path (#573).
 */
export type JiraPostResult =
  | { readonly ok: true; readonly commentId: string }
  | { readonly ok: false; readonly retryable: boolean };

export type JiraUpdateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryable: boolean };

/**
 * Outcome of a single comment POST. We distinguish auth rejection (401/403)
 * from other failures so the caller can react to the former with a forced
 * token refresh + retry. Non-auth failures carry a ``retryable`` flag so the
 * classified caller ({@link postCommentWithResult}) can tell a transient
 * 5xx/429/network blip from a terminal 4xx.
 */
type WriteOutcome =
  | { readonly kind: 'ok'; readonly responseBody: string }
  | { readonly kind: 'auth' }
  | { readonly kind: 'error'; readonly retryable: boolean };

async function writeComment(
  accessToken: string,
  cloudId: string,
  issueIdOrKey: string,
  body: Record<string, unknown>,
  commentId?: string,
): Promise<WriteOutcome> {
  // The 3LO token (audience=api.atlassian.com) is only valid against the
  // gateway base scoped by cloudId — see JIRA_API_BASE. Posting to the raw
  // site host (`*.atlassian.net`) would 401. Both path segments are
  // URL-encoded for defense-in-depth: cloudId is registry-sourced (a stored
  // tenant UUID), but encoding it keeps a malformed/compromised row from
  // injecting extra path segments into the gateway URL.
  const commentPath = commentId ? `/comment/${encodeURIComponent(commentId)}` : '/comment';
  const url = `${JIRA_API_BASE}/${encodeURIComponent(cloudId)}/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}${commentPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: commentId ? 'PUT' : 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ body }),
      signal: controller.signal,
    });
    const responseBody = await resp.text();
    if (resp.ok) return { kind: 'ok', responseBody };
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
 * post-comment helper, so outbound identity resolution runs once per task.
 */
export interface JiraFeedbackContext {
  /** Atlassian tenant identifier (`cloudId`) — registry key. */
  readonly cloudId: string;
  /** Name of JiraWorkspaceRegistryTable, from CDK stack output. */
  readonly registryTableName: string;
}

async function resolveTenantAuth(
  ctx: JiraFeedbackContext,
  forceRefresh = false,
): Promise<ResolvedJiraOutboundAuth | null> {
  try {
    return await resolveJiraOutboundAuth(ctx.cloudId, ctx.registryTableName, { forceRefresh });
  } catch (err) {
    logger.warn('Jira feedback could not resolve outbound identity', {
      jira_cloud_id: ctx.cloudId,
      force_refresh: forceRefresh,
      error: err instanceof Error ? err.message : String(err),
    });
    return null; // nosemgrep: ts-silent-success-masking -- Jira feedback is advisory and cannot block task execution
  }
}

interface JiraTransition {
  readonly id?: unknown;
  readonly hasScreen?: unknown;
  readonly to?: {
    readonly name?: unknown;
    readonly statusCategory?: { readonly key?: unknown };
  };
}

interface JiraTransitionSnapshot {
  readonly fields?: {
    readonly status?: {
      readonly name?: unknown;
      readonly statusCategory?: { readonly key?: unknown };
    };
  };
  readonly transitions?: unknown;
}

async function readTransitionSnapshot(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  auth: ResolvedJiraOutboundAuth,
): Promise<JiraTransitionSnapshot | null> {
  let status: number;
  let body: string;
  if (auth.kind === 'app') {
    const result = await requestJiraAppActor(auth.appActor, {
      version: 1,
      operation: 'get_transitions',
      cloud_id: ctx.cloudId,
      issue_key: issueIdOrKey,
    });
    if (!result.ok) return null;
    status = result.status;
    body = result.body;
  } else {
    const url = `${JIRA_API_BASE}/${encodeURIComponent(ctx.cloudId)}`
      + `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}?fields=status&expand=transitions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const result = await fetch(url, {
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      status = result.status;
      body = await result.text();
    } catch (err) {
      logger.warn('Jira transition lookup failed', {
        jira_cloud_id: ctx.cloudId,
        issue_id_or_key: issueIdOrKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  if (status !== 200) {
    logger.warn('Jira transition lookup returned non-200', {
      jira_cloud_id: ctx.cloudId,
      issue_id_or_key: issueIdOrKey,
      status,
    });
    return null;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JiraTransitionSnapshot
      : null;
  } catch (err) {
    logger.warn('Jira transition lookup returned invalid JSON', {
      issue_id_or_key: issueIdOrKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function transitionName(transition: JiraTransition): string {
  return typeof transition.to?.name === 'string'
    ? transition.to.name.trim().toLowerCase()
    : '';
}

function transitionCategory(transition: JiraTransition): string {
  return typeof transition.to?.statusCategory?.key === 'string'
    ? transition.to.statusCategory.key
    : '';
}

function selectTransition(
  transitions: readonly JiraTransition[],
  override: string | undefined,
  preferredNames: readonly string[],
  fallbackCategory: string | undefined,
): JiraTransition | undefined {
  const usable = transitions.filter(
    (transition) => transition && transition.hasScreen !== true && typeof transition.id === 'string',
  );
  if (override) {
    const wanted = override.trim().toLowerCase();
    return usable.find((transition) => transitionName(transition) === wanted);
  }
  for (const name of preferredNames) {
    const match = usable.find((transition) => transitionName(transition) === name);
    if (match) return match;
  }
  return fallbackCategory
    ? usable.find((transition) =>
      transitionCategory(transition) === fallbackCategory
      && transitionName(transition) !== 'blocked')
    : undefined;
}

async function executeTransition(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  transitionId: string,
  auth: ResolvedJiraOutboundAuth,
): Promise<boolean> {
  if (auth.kind === 'app') {
    const result = await requestJiraAppActor(auth.appActor, {
      version: 1,
      operation: 'transition',
      cloud_id: ctx.cloudId,
      issue_key: issueIdOrKey,
      transition_id: transitionId,
    });
    return result.ok && result.status === 204;
  }
  const url = `${JIRA_API_BASE}/${encodeURIComponent(ctx.cloudId)}`
    + `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const result = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ transition: { id: transitionId } }),
      signal: controller.signal,
    });
    return result.status === 204;
  } catch (err) {
    logger.warn('Jira transition request failed', {
      jira_cloud_id: ctx.cloudId,
      issue_id_or_key: issueIdOrKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort Jira workflow transition used by orchestration parent panels. */
export async function transitionIssueState(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  intent: StateIntent,
  overrides: { readonly started?: string; readonly inReview?: string } = {},
  options: TransitionOptions = {},
): Promise<boolean> {
  const auth = await resolveTenantAuth(ctx);
  if (!auth) return false;
  const snapshot = await readTransitionSnapshot(ctx, issueIdOrKey, auth);
  if (!snapshot) return false;

  const currentCategory = typeof snapshot.fields?.status?.statusCategory?.key === 'string'
    ? snapshot.fields.status.statusCategory.key
    : '';
  const currentRank = CATEGORY_RANK[currentCategory];
  const targetRank = intent === 'completed' ? CATEGORY_RANK.done : CATEGORY_RANK.indeterminate;
  if (currentRank !== undefined) {
    if (currentRank > targetRank) return false;
    if (intent === 'started' && currentRank === targetRank && !options.allowRegression) {
      return false;
    }
    if (intent === 'completed' && currentRank === targetRank) return false;
  }

  const transitions = Array.isArray(snapshot.transitions)
    ? snapshot.transitions.filter((value): value is JiraTransition =>
      Boolean(value) && typeof value === 'object' && !Array.isArray(value))
    : [];
  const override = intent === 'started' ? overrides.started : overrides.inReview;
  const preferred = intent === 'started'
    ? ['in progress']
    : (intent === 'in_review' ? REVIEW_STATUS_NAMES : ['done', 'completed', 'closed']);
  const fallbackCategory = override
    ? undefined
    : (intent === 'completed' ? 'done' : 'indeterminate');
  const transition = selectTransition(transitions, override, preferred, fallbackCategory);
  if (!transition || typeof transition.id !== 'string') {
    logger.warn('No matching Jira workflow transition', {
      issue_id_or_key: issueIdOrKey,
      intent,
      override,
      current_status: snapshot.fields?.status?.name,
    });
    return false;
  }
  return executeTransition(ctx, issueIdOrKey, transition.id, auth);
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
): Promise<string | null> {
  const result = await postCommentWithResult(ctx, issueIdOrKey, toAdfDocument(body));
  return result.ok ? result.commentId : null;
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
  const resolved = await resolveTenantAuth(ctx);
  if (!resolved) return { ok: false, retryable: false };

  if (resolved.kind === 'app') {
    const appResult = await requestJiraAppActor(resolved.appActor, {
      version: 1,
      operation: 'comment',
      cloud_id: ctx.cloudId,
      issue_key: issueIdOrKey,
      body,
    });
    return createdCommentResult(appResult, ctx, issueIdOrKey);
  }

  const outcome = await writeComment(resolved.accessToken, ctx.cloudId, issueIdOrKey, body);
  if (outcome.kind === 'ok') {
    return createdCommentResult({
      ok: true,
      body: outcome.responseBody,
    }, ctx, issueIdOrKey);
  }
  if (outcome.kind === 'error') return { ok: false, retryable: outcome.retryable };

  // outcome.kind === 'auth': the stored access token was rejected. Force a
  // refresh (bypassing the resolver's cache and proactive-expiry
  // short-circuit) and retry once with the freshly-minted token.
  logger.info('Jira feedback got auth rejection — forcing token refresh and retrying once', {
    jira_cloud_id: ctx.cloudId,
    issue_id_or_key: issueIdOrKey,
  });
  const refreshed = await resolveTenantAuth(ctx, true);
  if (!refreshed) return { ok: false, retryable: false };
  if (refreshed.kind === 'app') {
    const appResult = await requestJiraAppActor(refreshed.appActor, {
      version: 1,
      operation: 'comment',
      cloud_id: ctx.cloudId,
      issue_key: issueIdOrKey,
      body,
    });
    return createdCommentResult(appResult, ctx, issueIdOrKey);
  }
  // If the refresh handed back the same access token, the retry can only
  // reproduce the 401 — skip the redundant network call.
  if (refreshed.accessToken === resolved.accessToken) {
    logger.warn('Jira feedback refresh returned an unchanged token — not retrying', {
      jira_cloud_id: ctx.cloudId,
      issue_id_or_key: issueIdOrKey,
    });
    return { ok: false, retryable: false };
  }
  const retryOutcome = await writeComment(refreshed.accessToken, ctx.cloudId, issueIdOrKey, body);
  if (retryOutcome.kind === 'ok') {
    return createdCommentResult({
      ok: true,
      body: retryOutcome.responseBody,
    }, ctx, issueIdOrKey);
  }
  // A second auth rejection means the credential is genuinely unusable —
  // terminal. A transient error on the retry stays retryable so the
  // dispatcher can escalate for a Lambda retry.
  if (retryOutcome.kind === 'error') return { ok: false, retryable: retryOutcome.retryable };
  return { ok: false, retryable: false };
}

function createdCommentResult(
  result: { readonly ok: true; readonly body: string }
    | { readonly ok: false; readonly retryable: boolean },
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
): JiraPostResult {
  if (!result.ok) return { ok: false, retryable: result.retryable };
  try {
    const value = JSON.parse(result.body) as { id?: unknown };
    const commentId = typeof value.id === 'string'
      ? value.id
      : (typeof value.id === 'number' ? String(value.id) : '');
    if (commentId) return { ok: true, commentId };
    logger.warn('Jira comment create succeeded without a usable comment id', {
      jira_cloud_id: ctx.cloudId,
      issue_id_or_key: issueIdOrKey,
      response_id_type: typeof value.id,
    });
  } catch (err) {
    logger.warn('Jira comment create succeeded but its response was not valid JSON', {
      jira_cloud_id: ctx.cloudId,
      issue_id_or_key: issueIdOrKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // The write itself succeeded. Returning success prevents a caller from
  // creating a duplicate just because this response cannot support a later edit.
  return { ok: true, commentId: '' };
}

/**
 * Update an existing Jira comment in place. Returns true on success and false
 * on any failure. Like comment creation, this is advisory and never throws.
 */
export async function updateIssueComment(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  commentId: string,
  body: string,
): Promise<boolean> {
  const result = await updateIssueCommentAdf(
    ctx,
    issueIdOrKey,
    commentId,
    toAdfDocument(body),
  );
  return result.ok;
}

/** Update an existing Jira comment with a pre-built ADF document. */
export async function updateIssueCommentAdf(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  commentId: string,
  body: Record<string, unknown>,
): Promise<JiraUpdateResult> {
  if (!/^\d+$/.test(commentId)) {
    logger.warn('Refusing to update Jira comment with an invalid id', {
      jira_cloud_id: ctx.cloudId,
      issue_id_or_key: issueIdOrKey,
      comment_id: commentId,
    });
    return { ok: false, retryable: false };
  }
  const resolved = await resolveTenantAuth(ctx);
  if (!resolved) return { ok: false, retryable: false };

  if (resolved.kind === 'app') {
    const appResult = await requestJiraAppActor(resolved.appActor, {
      version: 1,
      operation: 'update_comment',
      cloud_id: ctx.cloudId,
      issue_key: issueIdOrKey,
      comment_id: commentId,
      body,
    });
    return appResult.ok
      ? { ok: true }
      : { ok: false, retryable: appResult.retryable };
  }

  const outcome = await writeComment(
    resolved.accessToken,
    ctx.cloudId,
    issueIdOrKey,
    body,
    commentId,
  );
  if (outcome.kind === 'ok') return { ok: true };
  if (outcome.kind === 'error') return { ok: false, retryable: outcome.retryable };

  logger.info('Jira feedback got auth rejection — forcing token refresh and retrying once', {
    jira_cloud_id: ctx.cloudId,
    issue_id_or_key: issueIdOrKey,
    comment_id: commentId,
  });
  const refreshed = await resolveTenantAuth(ctx, true);
  if (!refreshed) return { ok: false, retryable: false };
  if (refreshed.kind === 'app') {
    const appResult = await requestJiraAppActor(refreshed.appActor, {
      version: 1,
      operation: 'update_comment',
      cloud_id: ctx.cloudId,
      issue_key: issueIdOrKey,
      comment_id: commentId,
      body,
    });
    return appResult.ok
      ? { ok: true }
      : { ok: false, retryable: appResult.retryable };
  }
  if (refreshed.accessToken === resolved.accessToken) {
    logger.warn('Jira feedback refresh returned an unchanged token — not retrying', {
      jira_cloud_id: ctx.cloudId,
      issue_id_or_key: issueIdOrKey,
      comment_id: commentId,
    });
    return { ok: false, retryable: false };
  }
  const retryOutcome = await writeComment(
    refreshed.accessToken,
    ctx.cloudId,
    issueIdOrKey,
    body,
    commentId,
  );
  if (retryOutcome.kind === 'ok') return { ok: true };
  if (retryOutcome.kind === 'error') {
    return { ok: false, retryable: retryOutcome.retryable };
  }
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
