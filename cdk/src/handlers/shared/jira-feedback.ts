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

import { requestJiraAppActor, type JiraAppActorConfig } from './jira-app-actor';
import {
  resolveJiraOutboundAuth,
  type ResolvedJiraOutboundAuth,
} from './jira-oauth-resolver';
import { logger } from './logger';
import { type LookupResult, isLookupFailure, lookupFailed, lookupFound } from './lookup-result';
import type { StateIntent, TransitionOptions } from './orchestration-channel';

const REQUEST_TIMEOUT_MS = 5000;

/**
 * Atlassian cross-region REST gateway base. The per-tenant OAuth token is
 * minted with `audience=api.atlassian.com`, so it is only valid against this
 * gateway host scoped by `{cloudId}` — NOT against the raw `*.atlassian.net`
 * site host, which 401s such a token.
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

function toAdfDocument(message: string): Record<string, unknown> {
  return buildAdfDocument(message.split('\n').map(parseMarkdownRuns));
}

/**
 * A single run of comment text with optional inline emphasis / hyperlink.
 * The ADF serializer ({@link buildAdfDocument}) maps ``strong``/``em`` onto
 * ADF ``marks`` and ``href`` onto an ADF ``link`` mark.
 *
 * ADF does NOT auto-linkify a bare URL sitting in a plain text node: it
 * renders as unclickable text unless the run carries an explicit ``link`` mark.
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
 * One block of a comment body: a paragraph, or a block of code, which Jira
 * shows as written, line breaks included.
 */
export type AdfBlock = AdfParagraph | { readonly code: string };

/**
 * Parse the controlled Markdown emitted by ABCA's own status renderers: bold,
 * inline code, links, linked preview images, and italics that span a whole
 * line. Not a general Markdown parser; malformed input stays plain text.
 */
export function parseMarkdownRuns(line: string): AdfParagraph {
  return parseRuns(line, true);
}

const PUNCTUATION = /[\p{P}\p{S}]/u;

function parseRuns(line: string, links: boolean): AdfParagraph {
  // ADF allows the `code` mark only together with `link`, so a code run takes
  // no other emphasis.
  if (line.length > 2 && line.startsWith('_') && line.endsWith('_')) {
    return parseRuns(line.slice(1, -1), links).map((run) => (run.code ? run : { ...run, em: true }));
  }
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
    // External images need Atlassian media storage, so an image becomes
    // explicit links.
    const image = links && line.slice(cursor).match(/^\[?!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)(?:\]\((https?:\/\/[^)\s]+)\))?/);
    if (image) {
      append({ text: 'Open screenshot', href: image[2] });
      if (image[3]) {
        append({ text: ' · ' });
        append({ text: 'Open live preview', href: image[3] });
      }
      cursor += image[0].length;
      continue;
    }

    if (line.startsWith('**', cursor)) {
      const end = line.indexOf('**', cursor + 2);
      if (
        end !== -1 && /[^\s*]/.test(line.charAt(cursor + 2)) && /\S/.test(line.charAt(end - 1))
        && !(/\w/.test(line.charAt(cursor - 1)) && PUNCTUATION.test(line.charAt(cursor + 2)))
        && !(PUNCTUATION.test(line.charAt(end - 1)) && /\w/.test(line.charAt(end + 2)))
      ) {
        for (const run of parseRuns(line.slice(cursor + 2, end), links)) {
          append(run.code ? run : { ...run, strong: true });
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

    if (links && line[cursor] === '[') {
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
      line.indexOf('!', cursor + 1),
    ].filter((index) => index !== -1);
    const next = nextTokens.length > 0 ? Math.min(...nextTokens) : line.length;
    append({ text: line.slice(cursor, next) });
    cursor = next;
  }
  return runs;
}

const CODE_FENCE = /^\s*```[^`]*$/;

/**
 * Parse Markdown the agent wrote (an answer, a question) into blocks: the
 * lines between two fences are one code block, every other line is a paragraph
 * of {@link parseMarkdownRuns}, except that a link or an image stays as typed,
 * with its URL. What that subset does not know (a heading, a list marker)
 * stays as typed too.
 */
export function parseMarkdownBlocks(text: string): AdfBlock[] {
  const blocks: AdfBlock[] = [];
  let open: string[] | undefined;
  const closeBlock = (lines: string[]): void => {
    const code = lines.join('\n');
    // An ADF text node cannot be empty, so a block without text is left out.
    if (code) blocks.push({ code });
  };
  for (const line of text.split(/\r?\n/)) {
    if (!CODE_FENCE.test(line)) {
      if (open) open.push(line);
      else blocks.push(parseRuns(line, false));
    } else if (open) {
      closeBlock(open);
      open = undefined;
    } else {
      open = [];
    }
  }
  if (open) closeBlock(open);
  return blocks;
}

/**
 * Build a multi-paragraph ADF document. Each paragraph of ``blocks``
 * becomes one ADF ``paragraph`` node; an empty run list yields an empty
 * paragraph (Jira renders it as a blank line — ADF text nodes do not honor
 * newlines). A code block becomes one ``codeBlock`` node, the one place where
 * a newline is kept.
 */
export function buildAdfDocument(blocks: ReadonlyArray<AdfBlock>): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: blocks.map((block) => ('code' in block ? {
      type: 'codeBlock',
      content: [{ type: 'text', text: block.code }],
    } : {
      type: 'paragraph',
      content: block.map((run) => {
        const marks: Array<Record<string, unknown>> = [];
        if (run.strong) marks.push({ type: 'strong' });
        if (run.em) marks.push({ type: 'em' });
        if (run.code) marks.push({ type: 'code' });
        if (run.href) marks.push({ type: 'link', attrs: { href: run.href } });
        return marks.length > 0
          ? { type: 'text', text: run.text, marks }
          : { type: 'text', text: run.text };
      }),
    })),
  };
}

/**
 * Classified outcome of a comment POST. ``retryable`` distinguishes transient
 * failures (network error, request timeout, HTTP 5xx/429) from terminal ones
 * (bad issue id, revoked credential, malformed request).
 */
export type JiraPostResult =
  | { readonly ok: true; readonly commentId: string }
  | { readonly ok: false; readonly retryable: boolean };

export type JiraUpdateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryable: boolean };

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
  signal?: AbortSignal,
): Promise<WriteOutcome> {
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
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    const responseBody = await resp.text();
    if (resp.ok) return { kind: 'ok', responseBody };
    if (resp.status === 401 || resp.status === 403) {
      logger.warn('Jira feedback REST auth rejection', { status: resp.status, url });
      return { kind: 'auth' };
    }
    const retryable = resp.status >= 500 || resp.status === 429;
    logger.warn('Jira feedback REST non-2xx', { status: resp.status, url, retryable });
    return { kind: 'error', retryable };
  } catch (err) {
    logger.warn('Jira feedback request failed', {
      error: err instanceof Error ? err.message : String(err),
      url,
    });
    return { kind: 'error', retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

export interface JiraFeedbackContext {
  /** Atlassian tenant identifier (`cloudId`) — registry key. */
  readonly cloudId: string;
  readonly registryTableName: string;
  /** Optional deadline cancellation for deployment-preview delivery. */
  readonly signal?: AbortSignal;
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
): Promise<LookupResult<JiraTransitionSnapshot>> {
  let status: number;
  let body: string;
  if (auth.kind === 'app') {
    const result = await requestJiraAppActor(auth.appActor, {
      version: 1,
      operation: 'get_transitions',
      cloud_id: ctx.cloudId,
      issue_key: issueIdOrKey,
    });
    if (!result.ok) {
      logger.warn('Jira transition lookup (app actor) failed', {
        jira_cloud_id: ctx.cloudId,
        issue_id_or_key: issueIdOrKey,
      });
      return lookupFailed(new Error('Jira app-actor get_transitions returned not-ok'));
    }
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
      return lookupFailed(err);
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
    return lookupFailed(new Error(`Jira transition lookup returned HTTP ${status}`));
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? lookupFound(parsed as JiraTransitionSnapshot)
      : lookupFailed(new Error('Jira transition lookup returned a non-object body'));
  } catch (err) {
    logger.warn('Jira transition lookup returned invalid JSON', {
      issue_id_or_key: issueIdOrKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return lookupFailed(err);
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

/** Best-effort Jira workflow transition. Returns true only when a transition was made. */
export async function transitionIssueState(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  intent: StateIntent,
  overrides: { readonly started?: string; readonly inReview?: string } = {},
  options: TransitionOptions = {},
): Promise<boolean> {
  const auth = await resolveTenantAuth(ctx);
  if (!auth) return false;
  const snapshotResult = await readTransitionSnapshot(ctx, issueIdOrKey, auth);
  if (!snapshotResult.ok) {
    logger.warn('Jira transition: snapshot lookup failed — not transitioning', {
      jira_cloud_id: ctx.cloudId,
      issue_id_or_key: issueIdOrKey,
      ...(isLookupFailure(snapshotResult) && {
        error: snapshotResult.error instanceof Error ? snapshotResult.error.message : String(snapshotResult.error),
      }),
    });
    return false;
  }
  const snapshot = snapshotResult.value;

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
  const preferred: readonly string[] = intent === 'started'
    ? ['in progress']
    : (intent === 'in_review' ? REVIEW_STATUS_NAMES : ['done', 'completed', 'closed']);
  const fallbackCategory = override
    ? undefined
    : (intent === 'completed' ? 'done' : 'indeterminate');
  const currentName = typeof snapshot.fields?.status?.name === 'string'
    ? snapshot.fields.status.name.trim().toLowerCase()
    : '';
  const rung = preferred.indexOf(currentName);
  const transition = rung === -1
    ? selectTransition(transitions, override, preferred, fallbackCategory)
    : selectTransition(transitions, override, preferred.slice(0, rung), undefined);
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
 * Post a comment onto a Jira issue. Returns the created comment ID, or null on
 * any failure (network, auth, REST errors). Never throws.
 *
 * A 401/403 on the first POST triggers exactly one forced token refresh
 * (`forceRefresh: true`) and one retry (issue #370).
 */
export async function postIssueComment(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  body: string,
): Promise<string | null> {
  const result = await postIssueCommentAdf(ctx, issueIdOrKey, toAdfDocument(body));
  return result.ok ? result.commentId : null;
}

/**
 * Post a pre-built ADF document onto a Jira issue, returning a classified
 * {@link JiraPostResult}. Never throws.
 *
 * Shares the 401/403 forced-refresh-and-retry-once behaviour with
 * {@link postIssueComment} (issue #370). A second auth rejection is terminal
 * (``{ retryable: false }``).
 */
export async function postIssueCommentAdf(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  body: Record<string, unknown>,
): Promise<JiraPostResult> {
  return createdCommentResult(await writeCommentWithRefresh(ctx, issueIdOrKey, body), ctx, issueIdOrKey);
}

type CommentWriteResult =
  | { readonly ok: true; readonly responseBody: string }
  | { readonly ok: false; readonly retryable: boolean };

async function writeCommentWithRefresh(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  body: Record<string, unknown>,
  commentId?: string,
): Promise<CommentWriteResult> {
  const writeAsApp = async (appActor: JiraAppActorConfig): Promise<CommentWriteResult> => {
    const appResult = await requestJiraAppActor(appActor, {
      version: 1,
      operation: commentId ? 'update_comment' : 'comment',
      cloud_id: ctx.cloudId,
      issue_key: issueIdOrKey,
      ...(commentId && { comment_id: commentId }),
      body,
    }, undefined, ctx.signal);
    return appResult.ok
      ? { ok: true, responseBody: appResult.body }
      : { ok: false, retryable: appResult.retryable };
  };
  const logContext = {
    jira_cloud_id: ctx.cloudId,
    issue_id_or_key: issueIdOrKey,
    ...(commentId && { comment_id: commentId }),
  };

  if (ctx.signal?.aborted) return { ok: false, retryable: true };
  const resolved = await resolveTenantAuth(ctx);
  if (ctx.signal?.aborted) return { ok: false, retryable: true };
  if (!resolved) return { ok: false, retryable: false };
  if (resolved.kind === 'app') return writeAsApp(resolved.appActor);

  const outcome = await writeComment(resolved.accessToken, ctx.cloudId, issueIdOrKey, body, commentId, ctx.signal);
  if (outcome.kind === 'ok') return { ok: true, responseBody: outcome.responseBody };
  if (outcome.kind === 'error') return { ok: false, retryable: outcome.retryable };

  logger.info('Jira feedback got auth rejection — forcing token refresh and retrying once', logContext);
  if (ctx.signal?.aborted) return { ok: false, retryable: true };
  const refreshed = await resolveTenantAuth(ctx, true);
  if (ctx.signal?.aborted) return { ok: false, retryable: true };
  if (!refreshed) return { ok: false, retryable: false };
  if (refreshed.kind === 'app') return writeAsApp(refreshed.appActor);
  if (refreshed.accessToken === resolved.accessToken) {
    logger.warn('Jira feedback refresh returned an unchanged token — not retrying', logContext);
    return { ok: false, retryable: false };
  }
  const retryOutcome = await writeComment(refreshed.accessToken, ctx.cloudId, issueIdOrKey, body, commentId, ctx.signal);
  if (retryOutcome.kind === 'ok') return { ok: true, responseBody: retryOutcome.responseBody };
  if (retryOutcome.kind === 'error') return { ok: false, retryable: retryOutcome.retryable };
  return { ok: false, retryable: false };
}

function createdCommentResult(
  result: CommentWriteResult,
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
): JiraPostResult {
  if (!result.ok) return { ok: false, retryable: result.retryable };
  try {
    const value = JSON.parse(result.responseBody) as { id?: unknown };
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
  return { ok: true, commentId: '' };
}

/**
 * Update an existing Jira comment in place. Returns true on success and false
 * on any failure. Never throws.
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
  const result = await writeCommentWithRefresh(ctx, issueIdOrKey, body, commentId);
  return result.ok ? { ok: true } : result;
}

/**
 * Post a feedback comment with the failure marker (❌) folded into the
 * message text. Best-effort, never throws. The marker is included in
 * `message` by the caller.
 */
export async function reportIssueFailure(
  ctx: JiraFeedbackContext,
  issueIdOrKey: string,
  message: string,
): Promise<void> {
  await Promise.allSettled([postIssueComment(ctx, issueIdOrKey, message)]);
}
