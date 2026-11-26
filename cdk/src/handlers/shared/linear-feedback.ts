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

import { isTerminalMaturingReply, preservePreviewSuffix } from './iteration-reply';
import { resolveLinearOauthToken } from './linear-oauth-resolver';
import { logger } from './logger';
import { type LookupResult, LOOKUP_ABSENT, lookupFailed, lookupFound, lookupValueOr } from './lookup-result';
import { isBotAuthoredComment } from './orchestration-comment-trigger';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

const REQUEST_TIMEOUT_MS = 5000;

/**
 * Reaction emoji short-codes: 👀 at start, ✅/❌ at completion.
 */
export const EMOJI_STARTED = 'eyes';
export const EMOJI_SUCCESS = 'white_check_mark';
export const EMOJI_FAILURE = 'x';
export const EMOJI_NEEDS_INPUT = 'question';

const COMMENT_CREATE_MUTATION = `
mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
  }
}
`.trim();

const COMMENT_CREATE_RETURNING_ID_MUTATION = `
mutation CreateCommentReturningId($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id }
  }
}
`.trim();

const COMMENT_UPDATE_MUTATION = `
mutation UpdateComment($id: String!, $body: String!) {
  commentUpdate(id: $id, input: { body: $body }) {
    success
  }
}
`.trim();

const COMMENT_DELETE_MUTATION = `
mutation DeleteComment($id: String!) {
  commentDelete(id: $id) { success }
}
`.trim();

/**
 * ``user`` is the human author (null when a comment
 * was posted by an OAuth app / integration); ``botActor`` is present precisely
 * for those app/integration comments.
 */
const RECENT_COMMENTS_QUERY = `
query RecentComments($issueId: String!) {
  issue(id: $issueId) {
    comments(first: 100) {
      nodes {
        id
        body
        createdAt
        user { displayName name }
        botActor { id }
      }
    }
  }
}
`.trim();

/**
 * Linear's ``commentCreate`` requires
 * ``issueId`` to be present EVEN for a threaded reply — ``parentId`` alone
 * fails ``commentCreate`` argument validation ("Exactly one of …issueId must
 * be defined").
 */
const COMMENT_REPLY_RETURNING_ID_MUTATION = `
mutation ReplyToComment($issueId: String!, $parentId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, parentId: $parentId, body: $body }) {
    success
    comment { id }
  }
}
`.trim();

const REACTION_CREATE_MUTATION = `
mutation ReactIssue($issueId: String!, $emoji: String!) {
  reactionCreate(input: { issueId: $issueId, emoji: $emoji }) {
    success
  }
}
`.trim();

const REACTION_CREATE_ON_COMMENT_MUTATION = `
mutation ReactComment($commentId: String!, $emoji: String!) {
  reactionCreate(input: { commentId: $commentId, emoji: $emoji }) {
    success
  }
}
`.trim();

const REACTION_DELETE_MUTATION = `
mutation UnreactIssue($id: String!) {
  reactionDelete(id: $id) { success }
}
`.trim();

const ISSUE_REACTIONS_QUERY = `
query IssueReactions($issueId: String!) {
  issue(id: $issueId) { reactions { id emoji } }
}
`.trim();

const COMMENT_REACTIONS_QUERY = `
query CommentReactions($commentId: String!) {
  comment(id: $commentId) { reactions { id emoji } }
}
`.trim();

const COMMENT_BODY_QUERY = `
query CommentBody($commentId: String!) {
  comment(id: $commentId) { body }
}
`.trim();

const BGAGENT_EMOJIS: ReadonlySet<string> = new Set([
  EMOJI_STARTED, EMOJI_SUCCESS, EMOJI_FAILURE, EMOJI_NEEDS_INPUT,
]);

/**
 * Linear state IDs are per-team UUIDs. ``type`` values:
 * ``backlog`` | ``unstarted`` (Todo) | ``started`` (In Progress / In Review) |
 * ``completed`` (Done) | ``canceled``.
 */
const ISSUE_TEAM_STATES_QUERY = `
query IssueTeamStates($issueId: String!) {
  issue(id: $issueId) {
    state { id type name position }
    team { states { nodes { id type name position } } }
  }
}
`.trim();

const ISSUE_SET_STATE_MUTATION = `
mutation SetIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
  }
}
`.trim();

interface TeamState {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly position: number;
}

/**
 * Read side of the Linear GraphQL API (the write side is {@link graphqlRequest}).
 * Returns a {@link LookupResult}: ``found`` with the ``data`` payload, ``absent``
 * when the call succeeded but carried no ``data`` (an anomalous but non-error
 * shape), or ``failed`` on any error layer (non-2xx, GraphQL errors, a thrown
 * fetch/timeout). Never throws.
 */
export async function graphqlData(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<LookupResult<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn('Linear feedback GraphQL non-2xx', { status: resp.status });
      return lookupFailed(new Error(`Linear feedback GraphQL returned HTTP ${resp.status}`));
    }
    const body = (await resp.json()) as { data?: Record<string, unknown>; errors?: unknown };
    if (body.errors) {
      logger.warn('Linear feedback GraphQL errors', { errors: body.errors });
      return lookupFailed(body.errors);
    }
    return body.data ? lookupFound(body.data) : LOOKUP_ABSENT;
  } catch (err) {
    logger.warn('Linear feedback request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return lookupFailed(err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Outcome of a Linear API call. ``retryable`` distinguishes transient
 * failures (network error, request timeout, HTTP 5xx/429) — where a
 * retry may genuinely succeed — from terminal ones (auth rejection,
 * GraphQL validation errors, unregistered workspace) where it cannot.
 */
export type LinearPostResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryable: boolean };

export async function graphqlRequest(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<LinearPostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const retryable = resp.status >= 500 || resp.status === 429;
      logger.warn('Linear feedback GraphQL non-2xx', { status: resp.status, retryable });
      return { ok: false, retryable };
    }
    const body = (await resp.json()) as { errors?: unknown };
    if (body.errors) {
      logger.warn('Linear feedback GraphQL errors', { errors: body.errors });
      return { ok: false, retryable: false };
    }
    return { ok: true };
  } catch (err) {
    logger.warn('Linear feedback request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

export interface LinearFeedbackContext {
  /** Linear organization UUID — registry key. */
  readonly linearWorkspaceId: string;
  readonly registryTableName: string;
}

export async function resolveToken(ctx: LinearFeedbackContext): Promise<string | null> {
  try {
    const resolved = await resolveLinearOauthToken(ctx.linearWorkspaceId, ctx.registryTableName);
    return resolved?.accessToken ?? null;
  } catch (err) {
    logger.warn('Linear feedback could not resolve OAuth token', {
      linear_workspace_id: ctx.linearWorkspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null; // nosemgrep: ts-silent-success-masking -- Linear feedback is best-effort; null token skips the comment without failing the caller
  }
}

/**
 * Post a comment onto a Linear issue. Never throws — returns a
 * {@link LinearPostResult}. A token-resolution failure is reported as terminal.
 */
export async function postIssueComment(
  ctx: LinearFeedbackContext,
  issueId: string,
  body: string,
): Promise<LinearPostResult> {
  const token = await resolveToken(ctx);
  if (!token) return { ok: false, retryable: false };
  return graphqlRequest(token, COMMENT_CREATE_MUTATION, { issueId, body });
}

/**
 * Upsert the orchestration's live status comment on the parent epic. If
 * ``existingCommentId`` is given, EDIT that comment in place; otherwise
 * CREATE a fresh comment. Returns the comment id on success (the
 * existing id on update, the new id on create), or null on any failure.
 * Never throws.
 */
export async function upsertStatusComment(
  ctx: LinearFeedbackContext,
  issueId: string,
  body: string,
  existingCommentId?: string,
): Promise<string | null> {
  const token = await resolveToken(ctx);
  if (!token) return null;

  if (existingCommentId) {
    const ok = (await graphqlRequest(token, COMMENT_UPDATE_MUTATION, { id: existingCommentId, body })).ok;
    return ok ? existingCommentId : null;
  }

  const data = lookupValueOr(await graphqlData(token, COMMENT_CREATE_RETURNING_ID_MUTATION, { issueId, body }), null);
  const created = data?.commentCreate as { success?: boolean; comment?: { id?: string } } | undefined;
  return created?.success && created.comment?.id ? created.comment.id : null;
}

/** Delete a comment. Best-effort: returns true on success, false on any failure. */
export async function deleteComment(
  ctx: LinearFeedbackContext,
  commentId: string,
): Promise<boolean> {
  const token = await resolveToken(ctx);
  if (!token) return false;
  return (await graphqlRequest(token, COMMENT_DELETE_MUTATION, { id: commentId })).ok;
}

export interface RenderedComment {
  readonly author: string;
  readonly createdAt: string;
  readonly markdown: string;
}

const DEFAULT_MAX_RECENT_COMMENTS = 20;

interface RawLinearComment {
  readonly id?: string;
  readonly body?: string;
  readonly createdAt?: string;
  readonly user?: { readonly displayName?: string; readonly name?: string } | null;
  readonly botActor?: { readonly id?: string } | null;
}

/**
 * Fetch the most recent HUMAN-authored comments on an issue, rendered to
 * markdown oldest-first. Fail-open: any failure (token, GraphQL error,
 * malformed body) logs a WARN and returns ``[]``.
 *
 * "Human" excludes app/integration comments two ways:
 *   1. ``botActor`` present, or ``user`` absent → posted by an OAuth app /
 *      integration;
 *   2. the body starts with one of the bot's own rendered-comment markers
 *      ({@link isBotAuthoredComment}).
 */
export async function fetchRecentComments(
  ctx: LinearFeedbackContext,
  issueId: string,
  maxComments: number = DEFAULT_MAX_RECENT_COMMENTS,
): Promise<RenderedComment[]> {
  const token = await resolveToken(ctx);
  if (!token) return [];
  const data = lookupValueOr(await graphqlData(token, RECENT_COMMENTS_QUERY, { issueId }), null);
  const issue = data?.issue as { comments?: { nodes?: RawLinearComment[] } } | undefined;
  const nodes = issue?.comments?.nodes ?? [];

  const human: RenderedComment[] = [];
  for (const node of nodes) {
    if (node.botActor || !node.user) continue;
    const body = (node.body ?? '').trim();
    if (!body) continue;
    if (isBotAuthoredComment(body)) continue;
    human.push({
      author: node.user.displayName?.trim() || node.user.name?.trim() || 'Unknown',
      createdAt: typeof node.createdAt === 'string' ? node.createdAt : '',
      markdown: body,
    });
  }

  human.sort((a, b) => (a.createdAt || '￿').localeCompare(b.createdAt || '￿'));
  const recent = human.length > maxComments ? human.slice(human.length - maxComments) : human;

  if (recent.length > 0) {
    logger.info('Fetched recent human Linear comments for task context', {
      linear_workspace_id: ctx.linearWorkspaceId,
      issue_id: issueId,
      count: recent.length,
    });
  }
  return recent;
}

/**
 * Add an emoji reaction onto a Linear issue. Defaults to ❌. Same result
 * contract as {@link postIssueComment}.
 */
export async function addIssueReaction(
  ctx: LinearFeedbackContext,
  issueId: string,
  emoji: string = EMOJI_FAILURE,
): Promise<LinearPostResult> {
  const token = await resolveToken(ctx);
  if (!token) return { ok: false, retryable: false };
  return graphqlRequest(token, REACTION_CREATE_MUTATION, { issueId, emoji });
}

/** React to a specific Linear COMMENT. Defaults to 👀. Best-effort; returns true on success. */
export async function reactToComment(
  ctx: LinearFeedbackContext,
  commentId: string,
  emoji: string = EMOJI_STARTED,
): Promise<boolean> {
  const token = await resolveToken(ctx);
  if (!token) return false;
  return (await graphqlRequest(token, REACTION_CREATE_ON_COMMENT_MUTATION, { commentId, emoji })).ok;
}

/**
 * Post a THREADED REPLY beneath a Linear comment.
 * Returns the new reply's comment id or null on any
 * failure. Never throws.
 *
 * ``issueId`` is the issue the parent comment lives on — Linear requires it on
 * ``commentCreate`` even for a reply (see {@link COMMENT_REPLY_RETURNING_ID_MUTATION}).
 */
export async function replyToComment(
  ctx: LinearFeedbackContext,
  issueId: string,
  parentCommentId: string,
  body: string,
): Promise<string | null> {
  const token = await resolveToken(ctx);
  if (!token) return null;
  const data = lookupValueOr(await graphqlData(token, COMMENT_REPLY_RETURNING_ID_MUTATION, {
    issueId, parentId: parentCommentId, body,
  }), null);
  const created = data?.commentCreate as { success?: boolean; comment?: { id?: string } } | undefined;
  return created?.success && created.comment?.id ? created.comment.id : null;
}

/**
 * The MATURING THREADED REPLY for a comment-iteration.
 * If ``existingReplyId`` is given, EDIT that reply in place; otherwise CREATE a
 * new reply threaded under ``parentCommentId``. Returns the reply id
 * (existing on edit, new on create), or null on any failure. Never throws.
 */
export async function upsertThreadedReply(
  ctx: LinearFeedbackContext,
  issueId: string,
  parentCommentId: string,
  body: string,
  existingReplyId?: string,
  options?: { preservePreview?: boolean; skipIfSettled?: boolean; repairIfOverwritten?: boolean },
): Promise<string | null> {
  const token = await resolveToken(ctx);
  if (!token) return null;

  if (existingReplyId) {
    let finalBody = body;
    let current: string | undefined;
    if (options?.preservePreview || options?.skipIfSettled) {
      const data = lookupValueOr(await graphqlData(token, COMMENT_BODY_QUERY, { commentId: existingReplyId }), null);
      current = (data?.comment as { body?: string } | undefined)?.body;
    }
    // Linear's comment update takes only an id and a body — there is no version
    // or etag to make the write conditional on what was read, so this check is
    // not atomic.
    if (options?.skipIfSettled && isTerminalMaturingReply(current)) {
      logger.info('Skipping a progress edit — the reply already shows a terminal outcome', {
        comment_id: existingReplyId,
      });
      return existingReplyId;
    }
    if (options?.preservePreview) {
      finalBody = preservePreviewSuffix(body, current);
    }
    const ok = (await graphqlRequest(token, COMMENT_UPDATE_MUTATION, { id: existingReplyId, body: finalBody })).ok;
    if (!ok) return null;
    if (options?.repairIfOverwritten) {
      await repairOverwrittenOutcome(token, existingReplyId, finalBody);
    }
    return existingReplyId;
  }

  const data = lookupValueOr(await graphqlData(token, COMMENT_REPLY_RETURNING_ID_MUTATION, {
    issueId, parentId: parentCommentId, body,
  }), null);
  const created = data?.commentCreate as { success?: boolean; comment?: { id?: string } } | undefined;
  return created?.success && created.comment?.id ? created.comment.id : null;
}

async function repairOverwrittenOutcome(
  accessToken: string,
  commentId: string,
  outcomeBody: string,
): Promise<void> {
  if (!isTerminalMaturingReply(outcomeBody)) return;
  const data = lookupValueOr(await graphqlData(accessToken, COMMENT_BODY_QUERY, { commentId }), null);
  const current = (data?.comment as { body?: string } | undefined)?.body;
  if (typeof current !== 'string') return;
  if (current === outcomeBody || isTerminalMaturingReply(current)) return;

  logger.warn('A progress edit overwrote a settled reply — restoring the outcome', {
    event: 'iteration_reply.outcome_restored',
    comment_id: commentId,
  });
  const restored = preservePreviewSuffix(outcomeBody, current);
  const ok = (await graphqlRequest(accessToken, COMMENT_UPDATE_MUTATION, { id: commentId, body: restored })).ok;
  if (!ok) {
    logger.warn('Could not restore the overwritten outcome — the reply may read as in-progress', {
      event: 'iteration_reply.outcome_restore_failed',
      comment_id: commentId,
    });
  }
}

/**
 * Append a one-line suffix to an existing comment, idempotently.
 * Reads the comment's current body, and if it does NOT already contain
 * ``marker``, appends ``\n``+``line`` and updates. Best-effort; returns true
 * only if appended.
 */
export async function appendOnceToComment(
  ctx: LinearFeedbackContext,
  commentId: string,
  line: string,
  marker: string,
): Promise<boolean> {
  const token = await resolveToken(ctx);
  if (!token) return false;
  const data = lookupValueOr(await graphqlData(token, COMMENT_BODY_QUERY, { commentId }), null);
  const current = (data?.comment as { body?: string } | undefined)?.body;
  if (typeof current !== 'string') return false;
  if (current.includes(marker)) return false;
  const ok = (await graphqlRequest(token, COMMENT_UPDATE_MUTATION, {
    id: commentId, body: `${current}\n${line}`,
  })).ok;
  return ok;
}

async function deleteOwnMarker(accessToken: string, reactionId: string): Promise<boolean> {
  const first = await graphqlRequest(accessToken, REACTION_DELETE_MUTATION, { id: reactionId });
  if (first.ok) return true;
  if (!first.retryable) return false;
  logger.info('Retrying a status-marker removal after a transient failure', { reaction_id: reactionId });
  return (await graphqlRequest(accessToken, REACTION_DELETE_MUTATION, { id: reactionId })).ok;
}

/**
 * Leave ONE bgagent status marker on an issue or on a comment (👀 → ✅/❌/❓).
 * Deletes every marker emoji EXCEPT the wanted one, then adds the wanted one
 * if absent. A reaction with any other emoji is never touched. Idempotent.
 * Best-effort; returns true only when the wanted marker is present AND no
 * stale marker was left behind.
 */
async function swapReaction(
  ctx: LinearFeedbackContext,
  target: 'issue' | 'comment',
  id: string,
  emoji: string,
): Promise<boolean> {
  const token = await resolveToken(ctx);
  if (!token) return false;

  const onIssue = target === 'issue';
  const idVariable = { [`${target}Id`]: id };
  const data = lookupValueOr(
    await graphqlData(token, onIssue ? ISSUE_REACTIONS_QUERY : COMMENT_REACTIONS_QUERY, idVariable), null);
  const reactions = ((data?.[target] as { reactions?: Array<{ id: string; emoji: string }> } | undefined)?.reactions) ?? [];

  let targetPresent = false;
  let staleLeft = 0;
  for (const r of reactions) {
    if (r.emoji === emoji) { targetPresent = true; continue; }
    if (BGAGENT_EMOJIS.has(r.emoji)) {
      if (!(await deleteOwnMarker(token, r.id))) staleLeft += 1;
    }
  }

  if (staleLeft > 0) {
    logger.warn(`Could not remove a stale status marker from the ${target}`, {
      event: `linear_feedback.${target}_reaction_swap_incomplete`,
      [`${target}_id`]: id,
      stale_count: staleLeft,
    });
  }
  if (targetPresent) return staleLeft === 0;
  const added = (await graphqlRequest(
    token, onIssue ? REACTION_CREATE_MUTATION : REACTION_CREATE_ON_COMMENT_MUTATION, { ...idVariable, emoji })).ok;
  return added && staleLeft === 0;
}

/** Swap an issue's status marker — see {@link swapReaction}. */
export function swapIssueReaction(ctx: LinearFeedbackContext, issueId: string, emoji: string): Promise<boolean> {
  return swapReaction(ctx, 'issue', issueId, emoji);
}

/** Swap the status marker on a COMMENT — see {@link swapReaction}. */
export function swapCommentReaction(ctx: LinearFeedbackContext, commentId: string, emoji: string): Promise<boolean> {
  return swapReaction(ctx, 'comment', commentId, emoji);
}

/** Post a feedback comment and add a ❌ reaction, in parallel; both are best-effort. */
export async function reportIssueFailure(
  ctx: LinearFeedbackContext,
  issueId: string,
  message: string,
): Promise<void> {
  await Promise.allSettled([
    postIssueComment(ctx, issueId, message),
    addIssueReaction(ctx, issueId, EMOJI_FAILURE),
  ]);
}

function pickState(
  states: readonly TeamState[],
  type: string,
  preferredNames: readonly string[],
): TeamState | null {
  const ofType = states.filter((s) => s.type === type);
  if (ofType.length === 0) return null;
  for (const name of preferredNames) {
    const hit = ofType.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return [...ofType].sort((a, b) => a.position - b.position)[0];
}

/**
 * Transition a Linear issue to a workflow state chosen by semantic ``type``
 * (+ optional name preference). Returns true only on a
 * confirmed transition. Skips (returns false) if the issue is already in the
 * target state or moving backward. Never throws.
 */
export async function transitionIssueState(
  ctx: LinearFeedbackContext,
  issueId: string,
  targetType: 'started' | 'completed',
  preferredNames: readonly string[] = [],
  /**
   * Allow a WITHIN-TYPE regression (e.g. In Review → In Progress, both
   * ``started``). Cross-TYPE demotion (completed → started) is
   * still ALWAYS blocked.
   */
  allowSameTypeRegression = false,
): Promise<boolean> {
  const token = await resolveToken(ctx);
  if (!token) return false;

  const data = lookupValueOr(await graphqlData(token, ISSUE_TEAM_STATES_QUERY, { issueId }), null);
  const issue = data?.issue as
    | { state?: TeamState; team?: { states?: { nodes?: TeamState[] } } }
    | undefined;
  const states = issue?.team?.states?.nodes ?? [];
  if (states.length === 0) {
    logger.warn('Linear state transition: no team states resolved', { issue_id: issueId });
    return false;
  }

  const target = pickState(states, targetType, preferredNames);
  if (!target) {
    logger.warn('Linear state transition: no state of target type', { issue_id: issueId, target_type: targetType });
    return false;
  }

  const current = issue?.state;
  if (current?.id === target.id) {
    return false;
  }
  // Linear's raw position is NOT lifecycle order — e.g. Done
  // (completed, position 3) sorts numerically before In Review (started,
  // position 1002).
  if (current) {
    const TYPE_RANK: Record<string, number> = {
      backlog: 0, unstarted: 1, started: 2, completed: 3, canceled: 3, triage: 0,
    };
    const curRank = TYPE_RANK[current.type] ?? 0;
    const tgtRank = TYPE_RANK[target.type] ?? 0;
    const crossTypeDemotion = curRank > tgtRank;
    const sameTypeRegression = curRank === tgtRank && current.position >= target.position;
    const backward = crossTypeDemotion || (sameTypeRegression && !allowSameTypeRegression);
    if (backward) {
      logger.info('Linear state transition: skipping backward move', {
        issue_id: issueId,
        current_state: current.name,
        target_state: target.name,
        cross_type: crossTypeDemotion,
      });
      return false;
    }
  }

  const ok = (await graphqlRequest(token, ISSUE_SET_STATE_MUTATION, { issueId, stateId: target.id })).ok;
  if (ok) {
    logger.info('Linear issue state transitioned', {
      issue_id: issueId,
      from: current?.name,
      to: target.name,
    });
  }
  return ok;
}

/**
 * Move an issue BACKWARD to a not-started state
 * (``unstarted`` "Todo", else ``backlog``). ONLY fires when the issue is
 * CURRENTLY in a ``started`` state. Prefers a
 * "Todo" then "Backlog" target name; falls back to the lowest-position
 * unstarted/backlog state. Best-effort, never throws.
 */
export async function revertIssueToNotStarted(
  ctx: LinearFeedbackContext,
  issueId: string,
): Promise<boolean> {
  const token = await resolveToken(ctx);
  if (!token) return false;

  const data = lookupValueOr(await graphqlData(token, ISSUE_TEAM_STATES_QUERY, { issueId }), null);
  const issue = data?.issue as
    | { state?: TeamState; team?: { states?: { nodes?: TeamState[] } } }
    | undefined;
  const states = issue?.team?.states?.nodes ?? [];
  const current = issue?.state;
  if (states.length === 0 || !current) return false;

  if (current.type !== 'started') {
    logger.info('Revert-to-not-started: issue not in a started state — leaving it', {
      issue_id: issueId, current_state: current.name, current_type: current.type,
    });
    return false;
  }

  const target = pickState(states, 'unstarted', ['Todo', 'To Do'])
    ?? pickState(states, 'backlog', ['Backlog', 'Triage']);
  if (!target) {
    logger.info('Revert-to-not-started: no unstarted/backlog state on the team — leaving it', { issue_id: issueId });
    return false;
  }
  if (target.id === current.id) return false;

  const ok = (await graphqlRequest(token, ISSUE_SET_STATE_MUTATION, { issueId, stateId: target.id })).ok;
  if (ok) {
    logger.info('Linear issue reverted to not-started (awaiting approval)', {
      issue_id: issueId, from: current.name, to: target.name,
    });
  }
  return ok;
}
