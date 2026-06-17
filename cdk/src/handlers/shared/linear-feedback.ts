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

import { resolveLinearOauthToken } from './linear-oauth-resolver';
import { logger } from './logger';

/**
 * Lambda-side helper for posting comments and reactions onto Linear issues
 * via direct GraphQL. Used by the webhook processor to give users feedback
 * on pre-container failures (guardrail block, concurrency cap, unmapped
 * project, etc.) — paths where the agent never starts and the agent-side
 * Linear MCP / `linear_reactions.py` cannot run.
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

/**
 * The bgagent status-marker emojis we manage on the PARENT epic. Mirrors
 * ``_BGAGENT_EMOJIS`` in ``agent/src/linear_reactions.py``. Only these are
 * ever deleted by {@link swapIssueReaction} — a human's reaction is never
 * touched.
 */
const BGAGENT_EMOJIS: ReadonlySet<string> = new Set([EMOJI_STARTED, EMOJI_SUCCESS, EMOJI_FAILURE]);

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
    const backward = curRank > tgtRank || (curRank === tgtRank && current.position >= target.position);
    if (backward) {
      logger.info('Linear state transition: skipping backward move', {
        issue_id: issueId,
        current_state: current.name,
        target_state: target.name,
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
