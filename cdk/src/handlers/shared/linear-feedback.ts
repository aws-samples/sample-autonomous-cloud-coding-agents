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

import { preservePreviewSuffix } from './iteration-reply';
import { resolveLinearOauthToken } from './linear-oauth-resolver';
import { logger } from './logger';
import { isBotAuthoredComment } from './orchestration-comment-trigger';

/**
 * Lambda-side helper for posting comments and reactions onto Linear issues
 * via direct GraphQL. Used by the webhook processor to give users feedback
 * on pre-container failures (guardrail block, concurrency cap, unmapped
 * project, etc.) — paths where the agent never starts, so the agent-side
 * `linear_reactions.py` (its only Linear I/O — there is no Linear MCP) can't run.
 *
 * All calls are best-effort. Errors are logged at WARN and swallowed —
 * Linear feedback is advisory and must never gate task-rejection logic.
 */

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

const REQUEST_TIMEOUT_MS = 5000;

/**
 * Reaction emoji short-codes. Match the agent-side child markers in
 * ``agent/src/linear_reactions.py`` so the PARENT epic shows the same
 * status signal as its sub-issues: 👀 at start, ✅/❌ at completion.
 */
export const EMOJI_STARTED = 'eyes';
export const EMOJI_SUCCESS = 'white_check_mark';
export const EMOJI_FAILURE = 'x';
// #247 UX-1: a parent-epic comment we couldn't route to a single sub-issue is a
// QUESTION, not work-in-progress — leaving the 👀 (EMOJI_STARTED) on it makes it
// look like the agent is still working. Swap to ❓ so the reaction matches the
// "I need you to clarify / pick a sub-issue" disambiguation reply.
export const EMOJI_NEEDS_INPUT = 'question';

const COMMENT_CREATE_MUTATION = `
mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
  }
}
`.trim();

/** Create a comment and return its id (for later edit-in-place). */
const COMMENT_CREATE_RETURNING_ID_MUTATION = `
mutation CreateCommentReturningId($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id }
  }
}
`.trim();

/** Edit an existing comment in place (#247 #3 live status block). */
const COMMENT_UPDATE_MUTATION = `
mutation UpdateComment($id: String!, $body: String!) {
  commentUpdate(id: $id, input: { body: $body }) {
    success
  }
}
`.trim();

/** Delete a comment (#299 F-revise-in-place: remove the transient "on it" ack
 *  once the revised plan has matured in place). */
const COMMENT_DELETE_MUTATION = `
mutation DeleteComment($id: String!) {
  commentDelete(id: $id) { success }
}
`.trim();

/**
 * List an issue's TOP-LEVEL comments (id + body) — #299 plan-cleanup. Used to
 * sweep the bot's transient decomposition notes at approval/reject: we can't
 * track every fire-and-forget note id (they're posted from ~15 sites), so we
 * fetch the thread once and delete the bot's own ``🗂️``/``👋`` notes by prefix,
 * keeping the frozen plan reference + the (differently-prefixed) live panel.
 * ``first: 100`` comfortably covers a plan phase (a few notes + revise rounds);
 * pagination is unnecessary for the transient-note volume this sweeps.
 */
const ISSUE_COMMENTS_QUERY = `
query IssueComments($issueId: String!) {
  issue(id: $issueId) {
    comments(first: 100) {
      nodes { id body }
    }
  }
}
`.trim();

/**
 * Fetch comments with the author metadata needed to tell a human turn from a
 * bot/integration one (ADR-016 pre-hydration — the agent has no Linear MCP to
 * read the thread at runtime). ``user`` is the human author (null when a comment
 * was posted by an OAuth app / integration); ``botActor`` is present precisely
 * for those app/integration comments — so @bgagent's own progress and ack
 * comments carry a ``botActor`` and no ``user``. ``createdAt`` orders the thread.
 *
 * We fetch the first 100 (matching {@link ISSUE_COMMENTS_QUERY}) and sort +
 * slice to the most recent human comments CLIENT-SIDE, so the result is
 * independent of Linear's connection sort direction. 100 covers every realistic
 * issue thread; the rare over-100 issue simply may miss the oldest turns, which
 * is acceptable for advisory context.
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
 * Post a THREADED REPLY beneath an existing comment (#247 UX.3 ack trail).
 * ``parentId`` is the comment being replied to; the reply notifies and reads
 * as a conversation turn under it. Returns the new reply's id (for a possible
 * later edit), distinct from a top-level comment.
 *
 * IMPORTANT (live-verified 2026-06-16): Linear's ``commentCreate`` requires
 * ``issueId`` to be present EVEN for a threaded reply — ``parentId`` alone
 * fails ``commentCreate`` argument validation ("Exactly one of …issueId must
 * be defined"). So the reply carries BOTH the parent comment id and its
 * issue id.
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

/**
 * React to a specific COMMENT (not the issue) — the instant "on it" ack on an
 * ``@bgagent`` comment (#247 UX.3). (Verified: ``reactionCreate`` input accepts
 * ``commentId``.)
 */
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

/** Read an issue's reactions (id + emoji) — to swap one bgagent marker for another. */
const ISSUE_REACTIONS_QUERY = `
query IssueReactions($issueId: String!) {
  issue(id: $issueId) { reactions { id emoji } }
}
`.trim();

/** Read a COMMENT's reactions (id + emoji) — to swap the comment's bgagent marker (#247 UX.21). */
const COMMENT_REACTIONS_QUERY = `
query CommentReactions($commentId: String!) {
  comment(id: $commentId) { reactions { id emoji } }
}
`.trim();

/** Read a COMMENT's current body — to append to it (iteration-UX preview link). */
const COMMENT_BODY_QUERY = `
query CommentBody($commentId: String!) {
  comment(id: $commentId) { body }
}
`.trim();

/**
 * The bgagent status-marker emojis we manage on the PARENT epic. Mirrors
 * ``_BGAGENT_EMOJIS`` in ``agent/src/linear_reactions.py``. Only these are
 * ever deleted by {@link swapIssueReaction} — a human's reaction is never
 * touched.
 */
const BGAGENT_EMOJIS: ReadonlySet<string> = new Set([
  EMOJI_STARTED, EMOJI_SUCCESS, EMOJI_FAILURE, EMOJI_NEEDS_INPUT,
]);

/**
 * Fetch the workflow states for the TEAM that owns ``issueId``, so we can
 * resolve a target state by its semantic ``type`` (Linear state IDs are
 * per-team UUIDs, not knowable a priori). ``type`` values:
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

async function graphqlData(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
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
      return null;
    }
    const body = (await resp.json()) as { data?: Record<string, unknown>; errors?: unknown };
    if (body.errors) {
      logger.warn('Linear feedback GraphQL errors', { errors: body.errors });
      return null;
    }
    return body.data ?? null;
  } catch (err) {
    logger.warn('Linear feedback request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Outcome of a Linear API call. ``retryable`` distinguishes transient
 * failures (network error, request timeout, HTTP 5xx/429) — where a
 * retry may genuinely succeed — from terminal ones (auth rejection,
 * GraphQL validation errors, unregistered workspace) where it cannot.
 * Callers with a retry mechanism (the fan-out dispatcher's
 * partial-batch path) escalate retryable failures; purely best-effort
 * callers can branch on ``ok`` alone.
 */
export type LinearPostResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryable: boolean };

async function graphqlRequest(
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
        // OAuth tokens use Bearer; legacy PAK was the bare value. Phase
        // 2.0b: all tokens stored in Secrets Manager are OAuth bearer
        // tokens so we always Bearer-prefix.
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      // 5xx is a Linear-side outage and 429 a rate limit — both may
      // clear on retry. Any other non-2xx (401/403/404…) is terminal:
      // re-sending the same request cannot change the answer.
      const retryable = resp.status >= 500 || resp.status === 429;
      logger.warn('Linear feedback GraphQL non-2xx', { status: resp.status, retryable });
      return { ok: false, retryable };
    }
    const body = (await resp.json()) as { errors?: unknown };
    if (body.errors) {
      // GraphQL-level errors (bad issue id, missing scope) are
      // request-shape problems, not infrastructure — terminal.
      logger.warn('Linear feedback GraphQL errors', { errors: body.errors });
      return { ok: false, retryable: false };
    }
    return { ok: true };
  } catch (err) {
    // fetch rejection: DNS/connect failure or the AbortController
    // timeout above — transient by nature.
    logger.warn('Linear feedback request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Workspace-scoped feedback context. Resolved once per task by the
 * caller (webhook processor / orchestrator) and threaded through to
 * the post-comment / add-reaction helpers, so the resolver runs once
 * per task instead of once per Linear API call.
 */
export interface LinearFeedbackContext {
  /** Linear organization UUID — registry key. */
  readonly linearWorkspaceId: string;
  /** Name of LinearWorkspaceRegistryTable, from CDK stack output. */
  readonly registryTableName: string;
}

async function resolveToken(ctx: LinearFeedbackContext): Promise<string | null> {
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
 * {@link LinearPostResult} so callers can distinguish transient failures
 * (worth a retry) from terminal ones (auth, bad issue id) without this
 * helper ever gating task-rejection logic.
 *
 * Token-resolution failure is classified terminal: ``resolveLinearOauthToken``
 * deliberately collapses every failure cause (registry miss, revoked
 * workspace, unreadable secret, and also transient DDB throttles) into
 * ``null`` as part of its graceful no-op contract, so there is no signal
 * left here to tell a throttle from an unregistered workspace. Splitting
 * that contract is a resolver-level refactor — see ``getRegistryRowStrict``
 * for the precedent.
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
 * Upsert the orchestration live status block (#247 #3): if
 * ``existingCommentId`` is given, EDIT that comment in place; otherwise
 * CREATE a fresh comment and return its id so the caller can persist it and
 * edit on the next transition. Returns the comment id on success (the
 * existing id on update, the new id on create), or null on any failure.
 * Best-effort — never throws; the status block is advisory.
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
    // graphqlRequest now returns a LinearPostResult — read .ok (an object is
    // always truthy, so a bare `ok ?` would wrongly report success).
    const ok = (await graphqlRequest(token, COMMENT_UPDATE_MUTATION, { id: existingCommentId, body })).ok;
    return ok ? existingCommentId : null;
  }

  const data = await graphqlData(token, COMMENT_CREATE_RETURNING_ID_MUTATION, { issueId, body });
  const created = data?.commentCreate as { success?: boolean; comment?: { id?: string } } | undefined;
  return created?.success && created.comment?.id ? created.comment.id : null;
}

/**
 * #299 F-revise-in-place: delete a comment (the transient "🗂️ On it — updating…"
 * ack, once the revised plan has matured in place). Best-effort: returns true on
 * success, false on any failure (a lingering ack is a cosmetic nit, never a
 * breakage). Note Linear may already have fired a notification for the ack that
 * deletion can't un-send — acceptable.
 */
export async function deleteComment(
  ctx: LinearFeedbackContext,
  commentId: string,
): Promise<boolean> {
  const token = await resolveToken(ctx);
  if (!token) return false;
  return (await graphqlRequest(token, COMMENT_DELETE_MUTATION, { id: commentId })).ok;
}

/**
 * Bot-comment prefixes that mark a TRANSIENT Mode B decomposition note (the "on
 * it" ack, revise/escalate acks, planner-error, over-cap, already-decomposed,
 * nudge, wrong-handle). These are the ``🗂️``/``👋`` comments the plan cleanup
 * sweeps at approval/reject. Deliberately does NOT include the live epic panel
 * (``🔄``/``⚠️``/``✅``) or the agent's own progress (``🤖``) — those aren't ours
 * to delete here, and the panel is the thing we're KEEPING. Mirrors the
 * self-trigger guard's ``BOT_COMMENT_PREFIXES`` but scoped to the decompose notes.
 */
const DECOMPOSE_NOTE_PREFIXES: readonly string[] = ['🗂️', '👋'];

/**
 * #299 plan-cleanup — sweep the bot's transient decomposition notes off an
 * issue once the plan is approved/rejected, leaving just the frozen plan
 * reference + the live epic panel. Fetches the thread once, then deletes every
 * top-level comment that (a) starts with a decompose-note prefix and (b) is NOT
 * ``keepCommentId`` (the frozen plan reference we just wrote). Best-effort and
 * total: a failed list returns 0 (nothing swept — a lingering note is a
 * cosmetic nit, never a breakage), and each delete is independent so one
 * failure doesn't abort the rest. Returns the count deleted (for logging/tests).
 *
 * Prefix-scoping is the robustness win: interim notes are posted from ~15
 * fire-and-forget sites whose ids we don't track, and future note types are
 * covered automatically — while the panel (different prefix) and human comments
 * (no bot prefix) are provably untouched.
 */
export async function sweepDecompositionNotes(
  ctx: LinearFeedbackContext,
  issueId: string,
  keepCommentId?: string,
): Promise<number> {
  const token = await resolveToken(ctx);
  if (!token) return 0;
  const data = await graphqlData(token, ISSUE_COMMENTS_QUERY, { issueId });
  const issue = data?.issue as { comments?: { nodes?: Array<{ id?: string; body?: string }> } } | undefined;
  const nodes = issue?.comments?.nodes ?? [];
  let deleted = 0;
  for (const node of nodes) {
    const id = node?.id;
    const body = (node?.body ?? '').trimStart();
    if (!id || id === keepCommentId) continue;
    if (!DECOMPOSE_NOTE_PREFIXES.some((p) => body.startsWith(p))) continue;
    const ok = (await graphqlRequest(token, COMMENT_DELETE_MUTATION, { id })).ok;
    if (ok) deleted += 1;
  }
  if (deleted > 0) {
    logger.info('Swept transient decomposition notes at plan settle', {
      issue_id: issueId, deleted, kept_reference: keepCommentId ?? null,
    });
  }
  return deleted;
}

/** A rendered issue comment folded into the task context (mirrors the Jira
 *  ``RenderedComment`` shape so the two processors read alike). */
export interface RenderedComment {
  readonly author: string;
  readonly createdAt: string;
  readonly markdown: string;
}

/** Default cap on recent human comments folded into the task context. */
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
 * markdown oldest-first, for pre-hydrating the task context (ADR-016 — the agent
 * has no Linear MCP to read the thread at runtime). Best-effort / fail-open: any
 * failure (token, GraphQL error, malformed body) logs a WARN and returns ``[]``
 * so the task still proceeds — comments are advisory context, not a gate.
 *
 * "Human" excludes app/integration comments two ways (belt and suspenders):
 *   1. ``botActor`` present, or ``user`` absent → posted by an OAuth app /
 *      integration (this is how @bgagent's own comments are marked);
 *   2. the body starts with one of the bot's own rendered-comment markers
 *      ({@link isBotAuthoredComment}) — catches anything mis-attributed to a user.
 */
export async function fetchRecentComments(
  ctx: LinearFeedbackContext,
  issueId: string,
  maxComments: number = DEFAULT_MAX_RECENT_COMMENTS,
): Promise<RenderedComment[]> {
  const token = await resolveToken(ctx);
  if (!token) return [];
  const data = await graphqlData(token, RECENT_COMMENTS_QUERY, { issueId });
  const issue = data?.issue as { comments?: { nodes?: RawLinearComment[] } } | undefined;
  const nodes = issue?.comments?.nodes ?? [];

  const human: RenderedComment[] = [];
  for (const node of nodes) {
    // Skip app/integration comments (bgagent + other bots): they carry a
    // botActor and no human user.
    if (node.botActor || !node.user) continue;
    const body = (node.body ?? '').trim();
    if (!body) continue;
    // Belt and suspenders: drop anything that reads as one of our own rendered
    // comments even if it slipped through as a "user" comment.
    if (isBotAuthoredComment(body)) continue;
    human.push({
      author: node.user.displayName?.trim() || node.user.name?.trim() || 'Unknown',
      createdAt: typeof node.createdAt === 'string' ? node.createdAt : '',
      markdown: body,
    });
  }

  // Order oldest-first so the thread reads naturally, then keep the most recent
  // ``maxComments`` (sort is client-side — independent of Linear's connection
  // sort direction). Comments without a timestamp sort last (treated as newest).
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
 * Add an emoji reaction onto a Linear issue. Defaults to ❌ — the failure marker
 * the agent uses on the success/failure side. Same result contract as
 * {@link postIssueComment}.
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

/**
 * React to a specific Linear COMMENT (#247 UX.3 ack model). Used as the
 * instant "on it" acknowledgement when a human ``@bgagent``s a comment —
 * 👀 ({@link EMOJI_STARTED}) lands immediately, before the iteration task is
 * even created, so the human knows the agent saw their request with zero
 * comment clutter. Best-effort; returns true on success.
 */
export async function reactToComment(
  ctx: LinearFeedbackContext,
  commentId: string,
  emoji: string = EMOJI_STARTED,
): Promise<boolean> {
  const token = await resolveToken(ctx);
  if (!token) return false;
  // graphqlRequest returns a LinearPostResult (upstream #311/#332); this
  // best-effort helper just needs the success bool.
  return (await graphqlRequest(token, REACTION_CREATE_ON_COMMENT_MUTATION, { commentId, emoji })).ok;
}

/**
 * Post a THREADED REPLY beneath a Linear comment (#247 UX.3 ack model). Used
 * when the agent's work on an ``@bgagent`` comment lands ("✅ Updated — PR #178")
 * or fails ("❌ …"). Unlike an edit, a reply NOTIFIES and reads as a
 * conversation turn under the original request, keeping the thread contextual.
 * Returns the new reply's comment id (for a possible later edit) or null on any
 * failure. Best-effort — never throws.
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
  const data = await graphqlData(token, COMMENT_REPLY_RETURNING_ID_MUTATION, {
    issueId, parentId: parentCommentId, body,
  });
  const created = data?.commentCreate as { success?: boolean; comment?: { id?: string } } | undefined;
  return created?.success && created.comment?.id ? created.comment.id : null;
}

/**
 * The MATURING THREADED REPLY for a comment-iteration (iteration-UX redesign).
 * If ``existingReplyId`` is given, EDIT that reply in place; otherwise CREATE a
 * new reply threaded under ``parentCommentId`` and return its id. Mirrors
 * {@link upsertStatusComment} but as a THREADED reply (carries ``parentId``) so
 * one iteration shows a single reply that matures 👀→🔄→✅/💬 instead of N
 * top-level comments. Returns the reply id (existing on edit, new on create),
 * or null on any failure. Best-effort — never throws.
 *
 * Linear requires ``issueId`` even for a threaded reply (parentId alone fails
 * commentCreate validation, live-verified 2026-06-16), so the create carries both.
 */
export async function upsertThreadedReply(
  ctx: LinearFeedbackContext,
  issueId: string,
  parentCommentId: string,
  body: string,
  existingReplyId?: string,
  options?: { preservePreview?: boolean },
): Promise<string | null> {
  const token = await resolveToken(ctx);
  if (!token) return null;

  if (existingReplyId) {
    let finalBody = body;
    // iteration-UX convergence: the deploy-preview link is appended by a
    // SEPARATE async path (the screenshot webhook). A terminal-settle re-render
    // here would clobber a preview that already landed (live-caught ABCA-434).
    // When asked, read the current body and carry an existing `[preview]`
    // segment onto the new body so the two writers converge regardless of order.
    if (options?.preservePreview) {
      const data = await graphqlData(token, COMMENT_BODY_QUERY, { commentId: existingReplyId });
      const current = (data?.comment as { body?: string } | undefined)?.body;
      finalBody = preservePreviewSuffix(body, current);
    }
    const ok = (await graphqlRequest(token, COMMENT_UPDATE_MUTATION, { id: existingReplyId, body: finalBody })).ok;
    return ok ? existingReplyId : null;
  }

  const data = await graphqlData(token, COMMENT_REPLY_RETURNING_ID_MUTATION, {
    issueId, parentId: parentCommentId, body,
  });
  const created = data?.commentCreate as { success?: boolean; comment?: { id?: string } } | undefined;
  return created?.success && created.comment?.id ? created.comment.id : null;
}

/**
 * iteration-UX: append a one-line suffix to an existing comment, idempotently.
 * Reads the comment's current body, and if it does NOT already contain
 * ``marker``, appends ``\n``+``line`` and updates. Used by the screenshot webhook
 * to add the ``· [preview](url)`` link to the iteration's settle reply once the
 * (async) capture finishes — the reply has usually already rendered ✅ + cost by
 * then, so the link arrives a few seconds later as an in-place edit rather than a
 * new comment. ``marker`` is a stable substring (e.g. ``[preview]``) so a webhook
 * redelivery doesn't append twice. Best-effort; returns true only if appended.
 */
export async function appendOnceToComment(
  ctx: LinearFeedbackContext,
  commentId: string,
  line: string,
  marker: string,
): Promise<boolean> {
  const token = await resolveToken(ctx);
  if (!token) return false;
  const data = await graphqlData(token, COMMENT_BODY_QUERY, { commentId });
  const current = (data?.comment as { body?: string } | undefined)?.body;
  if (typeof current !== 'string') return false;
  if (current.includes(marker)) return false; // already appended (idempotent)
  const ok = (await graphqlRequest(token, COMMENT_UPDATE_MUTATION, {
    id: commentId, body: `${current}\n${line}`,
  })).ok;
  return ok;
}

/**
 * Swap the PARENT epic's bgagent status marker so only ONE is shown at a
 * time (👀 → ✅/❌), mirroring the children's reaction behaviour. The
 * children capture the reaction id in-process and delete it; the parent's
 * markers are added across SEPARATE lambda invocations (👀 at seed, ✅/❌ at
 * completion), so we instead query the issue's reactions, delete every
 * bgagent marker EXCEPT the target, then add the target if absent. Only
 * bgagent emojis (👀/✅/❌) are ever removed — a human's reaction is left
 * untouched. Best-effort; returns true if the target marker is present
 * afterwards.
 */
export async function swapIssueReaction(
  ctx: LinearFeedbackContext,
  issueId: string,
  emoji: string,
): Promise<boolean> {
  const token = await resolveToken(ctx);
  if (!token) return false;

  const data = await graphqlData(token, ISSUE_REACTIONS_QUERY, { issueId });
  const reactions = ((data?.issue as { reactions?: Array<{ id: string; emoji: string }> } | undefined)?.reactions) ?? [];

  // Delete our stale markers (any bgagent emoji that isn't the target).
  let targetPresent = false;
  for (const r of reactions) {
    if (r.emoji === emoji) { targetPresent = true; continue; }
    if (BGAGENT_EMOJIS.has(r.emoji)) {
      await graphqlRequest(token, REACTION_DELETE_MUTATION, { id: r.id });
    }
  }

  if (targetPresent) return true; // already the only marker after the deletes above
  return (await graphqlRequest(token, REACTION_CREATE_MUTATION, { issueId, emoji })).ok;
}

/**
 * Swap the bgagent status marker on a COMMENT (👀 → ✅/❌), so the trigger
 * comment shows ONE marker reflecting the outcome — mirrors
 * {@link swapIssueReaction} but on a comment (#247 UX.21). The 👀 lands at
 * receipt ({@link reactToComment}); when the iteration settles we swap it for
 * ✅ (success) / ❌ (failure) so the comment itself reads done at a glance, not
 * just the threaded reply. Queries the comment's reactions, deletes every
 * bgagent marker except the target, adds the target if absent. Only bgagent
 * emojis (👀/✅/❌) are removed — a human's reaction is never touched.
 * Idempotent (a reconciler redelivery re-converges to the same single marker).
 * Best-effort; returns true if the target marker is present afterwards.
 */
export async function swapCommentReaction(
  ctx: LinearFeedbackContext,
  commentId: string,
  emoji: string,
): Promise<boolean> {
  const token = await resolveToken(ctx);
  if (!token) return false;

  const data = await graphqlData(token, COMMENT_REACTIONS_QUERY, { commentId });
  const reactions = ((data?.comment as { reactions?: Array<{ id: string; emoji: string }> } | undefined)?.reactions) ?? [];

  let targetPresent = false;
  for (const r of reactions) {
    if (r.emoji === emoji) { targetPresent = true; continue; }
    if (BGAGENT_EMOJIS.has(r.emoji)) {
      await graphqlRequest(token, REACTION_DELETE_MUTATION, { id: r.id });
    }
  }

  if (targetPresent) return true;
  return (await graphqlRequest(token, REACTION_CREATE_ON_COMMENT_MUTATION, { commentId, emoji })).ok;
}

/**
 * Convenience: post a feedback comment **and** drop a ❌ reaction in one call.
 * Both calls run in parallel; both are best-effort. Returns void — callers
 * never branch on the result.
 */
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

/**
 * Pick the target workflow state by semantic preference. ``preferredNames``
 * (case-insensitive) is tried first so e.g. "In Review" wins over "In
 * Progress" when both share Linear ``type: started``; falls back to the
 * lowest-``position`` state of ``type``. Returns null if the team has no
 * state of that type.
 */
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
 * (+ optional name preference). Used by the #247 reconciler to move the
 * PARENT epic through its lifecycle — ``In Progress`` when the orchestration
 * seeds, ``In Review`` when all children succeed — since the parent spawns no
 * task and Linear's GitHub automation (which moves the children on PR-open)
 * never touches it.
 *
 * Best-effort, like the rest of this module: resolves the team's states,
 * picks the target, and issues ``issueUpdate``. Returns true only on a
 * confirmed transition. Skips (returns false) if the issue is already in the
 * target state or moving backward (we never demote, e.g. a human already
 * pushed the epic to Done). Never throws.
 */
export async function transitionIssueState(
  ctx: LinearFeedbackContext,
  issueId: string,
  targetType: 'started' | 'completed',
  preferredNames: readonly string[] = [],
  /**
   * review blocker #9b: allow a WITHIN-TYPE regression (e.g. In Review → In
   * Progress, both ``started``). By default the backward-move guard blocks it —
   * correct for most callers, but it silently no-op'd the orchestration rollup's
   * deliberate re-open (a settled epic getting a new/re-run child must go back
   * from In Review to In Progress, and both are ``started`` type so the
   * position-tiebreak blocked it). Cross-TYPE demotion (completed → started) is
   * still ALWAYS blocked — this only relaxes the same-type position tiebreak.
   */
  allowSameTypeRegression = false,
): Promise<boolean> {
  const token = await resolveToken(ctx);
  if (!token) return false;

  const data = await graphqlData(token, ISSUE_TEAM_STATES_QUERY, { issueId });
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
    // Already there — idempotent no-op (e.g. reconciler re-fires).
    return false;
  }
  // Never move backward. Order by state TYPE first (the lifecycle:
  // backlog → unstarted → started → completed/canceled), then by position
  // within the same type. Raw position is NOT lifecycle order — e.g. Done
  // (completed, position 3) sorts numerically before In Review (started,
  // position 1002), so a position-only guard would wrongly demote a
  // human-completed epic back to In Review. We never demote across types
  // (a human/automation advanced it) nor backward within a type.
  if (current) {
    const TYPE_RANK: Record<string, number> = {
      backlog: 0, unstarted: 1, started: 2, completed: 3, canceled: 3, triage: 0,
    };
    const curRank = TYPE_RANK[current.type] ?? 0;
    const tgtRank = TYPE_RANK[target.type] ?? 0;
    const crossTypeDemotion = curRank > tgtRank;
    const sameTypeRegression = curRank === tgtRank && current.position >= target.position;
    // Cross-type demotion (e.g. completed → started) is NEVER allowed — a human
    // or automation advanced it. A same-type regression (In Review → In Progress)
    // is allowed ONLY when the caller opts in (#9b: the rollup re-open).
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
 * #299 F-decompose-inprogress — move an issue BACKWARD to a not-started state
 * (``unstarted`` "Todo", else ``backlog``), used when a ``:decompose`` planning
 * run finishes and the issue is now awaiting the reviewer's approve. The webhook
 * moved it to In Progress at dispatch (so the board showed the ~1-2 min planning
 * WAS happening — {@link transitionIssueState}); once the plan is posted and
 * nothing is running, "In Progress" would lie ("looks like work started while
 * it's just a pending plan"). So we revert it.
 *
 * This is the ONE sanctioned backward move, and it's tightly guarded to avoid
 * clobbering a human: it ONLY fires when the issue is CURRENTLY in a ``started``
 * state (i.e. still the In Progress we set) — if a human already pushed it to
 * Done/Canceled, or pulled it back to Backlog themselves, we leave it. Prefers a
 * "Todo" then "Backlog" target name; falls back to the lowest-position
 * unstarted/backlog state. Best-effort, never throws.
 */
export async function revertIssueToNotStarted(
  ctx: LinearFeedbackContext,
  issueId: string,
): Promise<boolean> {
  const token = await resolveToken(ctx);
  if (!token) return false;

  const data = await graphqlData(token, ISSUE_TEAM_STATES_QUERY, { issueId });
  const issue = data?.issue as
    | { state?: TeamState; team?: { states?: { nodes?: TeamState[] } } }
    | undefined;
  const states = issue?.team?.states?.nodes ?? [];
  const current = issue?.state;
  if (states.length === 0 || !current) return false;

  // Only revert OUR "In Progress" — never demote a human-advanced (completed/
  // canceled) or a human-pulled-back (already backlog/unstarted) issue.
  if (current.type !== 'started') {
    logger.info('Revert-to-not-started: issue not in a started state — leaving it', {
      issue_id: issueId, current_state: current.name, current_type: current.type,
    });
    return false;
  }

  // Prefer an unstarted "Todo" (the natural "not started, waiting" state); fall
  // back to backlog. Within a type, prefer the named state, else lowest position.
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
