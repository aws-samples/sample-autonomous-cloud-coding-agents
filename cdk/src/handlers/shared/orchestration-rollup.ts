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
 * Parent rollup comments for Linear orchestration (#247 A5).
 *
 * The fan-out plane (#243) posts a final-status comment on each CHILD's
 * sub-issue. The PARENT issue has no task, so its aggregate rollup is
 * posted here, by the reconciler, which already holds the orchestration
 * snapshot. The comment renderer is pure (unit-testable); ``postRollup``
 * wraps ``postIssueComment`` best-effort (a failed Linear comment must
 * never fail the reconcile — gating is the source of truth).
 */

import {
  EMOJI_FAILURE,
  EMOJI_SUCCESS,
  type LinearFeedbackContext,
  postIssueComment,
  swapIssueReaction,
  transitionIssueState,
  upsertStatusComment,
} from './linear-feedback';
import { logger } from './logger';
import { ORCH_LOG } from './orchestration-log-events';
import { isIntegrationNode } from './orchestration-integration-node';
import type { OrchestrationChildRow } from './orchestration-store';
import type { ChannelSource } from './types';

/** Which rollup we're posting — drives the heading + emoji. */
export type RollupKind = 'complete' | 'partial_failure' | 'cancelled';

export interface RollupChildView {
  readonly sub_issue_id: string;
  readonly linear_identifier?: string;
  readonly title?: string;
  readonly child_status: string;
  readonly child_task_id?: string;
  /**
   * The child task's PR url, when one was opened (#323). Resolved by the
   * reconciler from the TaskTable at rollup time (pr_url lands on the
   * TaskRecord in a separate write from the status transition, so it is
   * not persisted on the orchestration row). Rendered as a link on the
   * child's line; the integration node's PR is additionally surfaced as a
   * prominent callout (it is the fan-out's combined deliverable).
   */
  readonly pr_url?: string;
}

const STATUS_ICON: Record<string, string> = {
  succeeded: '✅',
  failed: '❌',
  skipped: '⏭️',
  released: '🔄',
  ready: '🔄',
  blocked: '⏳',
};

/**
 * Render the parent rollup comment body (pure). Lists each child with its
 * status, and a one-line summary. ``kind`` is derived by the caller from
 * the terminal child statuses.
 */
export function renderRollupComment(
  kind: RollupKind,
  children: readonly RollupChildView[],
): string {
  const counts = { succeeded: 0, failed: 0, skipped: 0 };
  for (const c of children) {
    if (c.child_status === 'succeeded') counts.succeeded += 1;
    else if (c.child_status === 'failed') counts.failed += 1;
    else if (c.child_status === 'skipped') counts.skipped += 1;
  }

  const heading =
    kind === 'complete'
      ? '✅ **ABCA orchestration complete**'
      : kind === 'cancelled'
        ? '🛑 **ABCA orchestration cancelled**'
        : '⚠️ **ABCA orchestration finished with failures**';

  const lines = [...children]
    .sort((a, b) => (a.linear_identifier ?? a.sub_issue_id).localeCompare(b.linear_identifier ?? b.sub_issue_id))
    .map((c) => {
      const icon = STATUS_ICON[c.child_status] ?? '•';
      const label = c.linear_identifier
        ? (c.title ? `${c.linear_identifier}: ${c.title}` : c.linear_identifier)
        : (c.title ?? c.sub_issue_id);
      // #323: append the child's PR link when one was opened, so the parent
      // rollup is a single place to reach every sub-issue's PR.
      const pr = c.pr_url ? ` — [PR](${c.pr_url})` : '';
      return `- ${icon} ${label} — ${c.child_status}${pr}`;
    });

  const summary = `${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.skipped} skipped `
    + `(of ${children.length}).`;

  // #323: surface the integration node's combined PR as a prominent callout —
  // it is the fan-out's single merged deliverable, and (being a synthetic node
  // with no Linear sub-issue) it is otherwise unreachable from Linear. Only
  // when the integration node actually opened a PR.
  const integration = children.find((c) => isIntegrationNode(c.sub_issue_id) && c.pr_url);
  const callout = integration
    ? ['', `🔗 **Combined PR (all sub-issues merged):** [${integration.pr_url}](${integration.pr_url})`]
    : [];

  return [heading, '', summary, ...callout, '', ...lines].join('\n');
}

/**
 * Render the LIVE status block (pure) — the single edit-in-place comment on
 * the parent epic that answers "where are we" during a running
 * orchestration (#247 UX, #3). Posted at seed and re-rendered + edited on
 * every child transition, so the parent shows current progress without a
 * comment stream. Once all children are terminal the reconciler replaces
 * the body with the final {@link renderRollupComment}, so this block is the
 * in-flight view only.
 *
 * Per-child line shows the same icons as the rollup (running/blocked/done/
 * failed/skipped) plus the child's PR link when known.
 */
export function renderStatusBlock(children: readonly RollupChildView[]): string {
  const terminal = (s: string) => s === 'succeeded' || s === 'failed' || s === 'skipped';
  const done = children.filter((c) => terminal(c.child_status)).length;

  const heading = `🔄 **ABCA orchestration** · ${done}/${children.length} complete`;

  const lines = [...children]
    .sort((a, b) => (a.linear_identifier ?? a.sub_issue_id).localeCompare(b.linear_identifier ?? b.sub_issue_id))
    .map((c) => {
      const icon = STATUS_ICON[c.child_status] ?? '•';
      const label = c.linear_identifier
        ? (c.title ? `${c.linear_identifier}: ${c.title}` : c.linear_identifier)
        : (c.title ?? c.sub_issue_id);
      // Human-friendly status words for the in-flight view.
      const word =
        c.child_status === 'released' || c.child_status === 'ready' ? 'running'
          : c.child_status === 'blocked' ? 'blocked'
            : c.child_status;
      // #323: link the PR as soon as it is known, even mid-run.
      const pr = c.pr_url ? ` — [PR](${c.pr_url})` : '';
      return `- ${icon} ${label} — ${word}${pr}`;
    });

  return [heading, '', ...lines, '', '_Updates live as sub-issues progress._'].join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// #247 UX redesign: the single MATURING panel comment. Supersedes the
// separate renderStatusBlock + renderRollupComment — ONE comment, edited in
// place, that shows the full DAG and matures from in-progress → complete and
// back to in-progress on an extend/revision. See project_247_ux_redesign.
// ───────────────────────────────────────────────────────────────────────────

/** Per-sub-issue view for the maturing panel — adds the 'updating' context the rollup/block can't express. */
export interface EpicPanelRow {
  readonly sub_issue_id: string;
  readonly linear_identifier?: string;
  readonly title?: string;
  /** Persisted orchestration status: blocked | ready | released | succeeded | failed | skipped. */
  readonly child_status: string;
  /** The sub-issue's current PR url, when one exists yet (omitted for a not-yet-PR'd first run). */
  readonly pr_url?: string;
  /**
   * When this row is being re-built by an in-flight cascade/iteration (its
   * persisted status is still 'succeeded' but a new task is updating its PR),
   * the human-readable reason — e.g. `per ABCA-289's "button doesn't work"` or
   * `to include ABCA-289's change`. Present → the row renders as 🔄 updating.
   */
  readonly updatingReason?: string;
}

export interface EpicPanelParams {
  readonly rows: readonly EpicPanelRow[];
  /**
   * True when any sub-issue is non-terminal OR any row is mid-update
   * (cascade in flight). Drives the in-progress header even when every
   * persisted status is terminal (a revision re-opens the epic).
   */
  readonly inProgress: boolean;
  /** Combined/integration PR url (the fan-out's merged deliverable), when one exists. */
  readonly combinedPrUrl?: string;
  /** Combined preview screenshot url, embedded in the panel (auto-refreshes; no separate comment). */
  readonly combinedScreenshotUrl?: string;
}

const PANEL_FOOTER = '_One live panel — updates in place as the epic progresses; no comment stream._';

/**
 * Truncate a quoted comment for the "updating per …" row, keeping it short.
 * Exported so the caller (reconciler) builds the ``updatingReason`` string —
 * e.g. ``per ABCA-289's "${truncateQuote(commentBody)}"``.
 */
export function truncateQuote(s: string, max = 40): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * SHORT friendly name for a node, used where a node is NAMED inside prose (e.g.
 * the cascade reason "updating to include <X>'s change"). The integration node
 * gets the friendly "the integration" rather than its raw stored title, so a
 * possessive reads cleanly ("the integration's change") instead of leaking the
 * clumsy synthetic title. Prefers the Linear identifier (ABCA-42) for real
 * nodes. (#247 — live-caught under the UX.6 stress test.)
 */
export function cascadeNodeLabel(
  subIssueId: string,
  linearIdentifier?: string,
  title?: string,
): string {
  if (isIntegrationNode(subIssueId)) return 'the integration';
  return linearIdentifier ?? title ?? 'a predecessor';
}

/** Friendly label for a row — Linear identifier + title, or 'Integration — combined result' for the synthetic node. */
function panelLabel(row: EpicPanelRow): string {
  if (isIntegrationNode(row.sub_issue_id)) return 'Integration — combined result';
  if (row.linear_identifier) return row.title ? `${row.linear_identifier}: ${row.title}` : row.linear_identifier;
  return row.title ?? row.sub_issue_id;
}

/**
 * Render the single maturing epic panel (pure). Edited in place on every event
 * (seed/run/extend/revision/complete). Rules:
 *  - PR link shown ONLY when a PR exists (a first run mid-flight has none).
 *  - A row with ``updatingReason`` renders as `🔄 … — updating <reason> — [PR]`
 *    even though its persisted status is still succeeded.
 *  - Header: in-progress → `🔄 N/M complete`; all settled → `✅ complete` or
 *    `⚠️ finished with failures`. ``inProgress`` forces 🔄 (a revision re-opens).
 *  - Integration node renders friendly; never a raw id.
 *  - Combined PR callout + embedded combined screenshot when present.
 */
export function renderEpicPanel(params: EpicPanelParams): string {
  const { rows, inProgress, combinedPrUrl, combinedScreenshotUrl } = params;
  const terminal = (s: string) => s === 'succeeded' || s === 'failed' || s === 'skipped';
  // "done" counts settled rows that are NOT mid-update (an updating row is back in flight).
  const done = rows.filter((r) => terminal(r.child_status) && !r.updatingReason).length;
  const anyBad = rows.some((r) => r.child_status === 'failed' || r.child_status === 'skipped');

  let heading: string;
  if (inProgress) {
    heading = `🔄 **ABCA orchestration** · ${done}/${rows.length} complete`;
  } else if (anyBad) {
    heading = '⚠️ **ABCA orchestration finished with failures**';
  } else {
    heading = '✅ **ABCA orchestration complete**';
  }

  const lines = [...rows]
    .sort((a, b) => (a.linear_identifier ?? a.sub_issue_id).localeCompare(b.linear_identifier ?? b.sub_issue_id))
    .map((r) => {
      const label = panelLabel(r);
      const pr = r.pr_url ? ` — [PR](${r.pr_url})` : '';
      // A mid-update row: 🔄 + the reason, regardless of persisted status.
      if (r.updatingReason) {
        return `- 🔄 ${label} — updating ${r.updatingReason}${pr}`;
      }
      const icon = STATUS_ICON[r.child_status] ?? '•';
      const word =
        r.child_status === 'released' || r.child_status === 'ready' ? 'running'
          : r.child_status === 'blocked' ? 'blocked'
            : r.child_status;
      return `- ${icon} ${label} — ${word}${pr}`;
    });

  const callout = combinedPrUrl
    ? ['', `🔗 **Combined PR (all sub-issues merged):** [${combinedPrUrl}](${combinedPrUrl})`]
    : [];
  const shot = combinedScreenshotUrl
    ? ['', `🖼️ **Combined preview**`, '', `![combined preview](${combinedScreenshotUrl})`]
    : [];

  return [heading, '', ...lines, ...callout, ...shot, '', PANEL_FOOTER].join('\n');
}

/**
 * Decide the rollup kind from the (terminal) child statuses.
 * - any failed/skipped → partial_failure
 * - all succeeded → complete
 * (cancelled is passed explicitly by the cancel path, not derived here)
 */
export function rollupKindFromChildren(children: readonly RollupChildView[]): RollupKind {
  const anyBad = children.some((c) => c.child_status === 'failed' || c.child_status === 'skipped');
  return anyBad ? 'partial_failure' : 'complete';
}

/**
 * Build the {@link EpicPanelRow}s for a snapshot's children (#247 UX.2). Maps
 * the persisted child rows + a ``sub_issue_id → pr_url`` map + an optional
 * ``sub_issue_id → updatingReason`` map (rows a cascade is rebuilding) into the
 * panel view. Pure.
 */
export function buildPanelRows(
  children: readonly OrchestrationChildRow[],
  prUrls: Readonly<Record<string, string>> = {},
  updating: Readonly<Record<string, string>> = {},
): EpicPanelRow[] {
  return children.map((c) => ({
    sub_issue_id: c.sub_issue_id,
    ...(c.linear_identifier !== undefined && { linear_identifier: c.linear_identifier }),
    ...(c.title !== undefined && { title: c.title }),
    child_status: c.child_status,
    ...(prUrls[c.sub_issue_id] !== undefined && { pr_url: prUrls[c.sub_issue_id] }),
    ...(updating[c.sub_issue_id] !== undefined && { updatingReason: updating[c.sub_issue_id] }),
  }));
}

export interface UpsertEpicPanelParams {
  readonly ctx: LinearFeedbackContext;
  readonly parentLinearIssueId: string;
  /** Existing panel comment id (status_comment_id). When absent, a fresh comment is posted + the id returned. */
  readonly statusCommentId?: string;
  readonly children: readonly OrchestrationChildRow[];
  readonly prUrls?: Readonly<Record<string, string>>;
  /** sub_issue_id → human reason, for rows a cascade is currently rebuilding. */
  readonly updating?: Readonly<Record<string, string>>;
  readonly combinedPrUrl?: string;
  readonly combinedScreenshotUrl?: string;
  /**
   * Whether the epic is in progress. When omitted, derived: in progress iff any
   * child is non-terminal OR any row has an updating reason. Pass explicitly to
   * force (e.g. a revision just started → still in progress even if all
   * persisted statuses are terminal).
   */
  readonly inProgress?: boolean;
  /**
   * When true AND the epic is settled, mirror the outcome on the PARENT issue:
   * advance state In Review (complete) / leave (failures) + swap reaction to
   * ✅/❌. When in progress, revert: state → In Progress + reaction → 👀. Only
   * for the Linear channel. Default true.
   */
  readonly mirrorParentState?: boolean;
  /** Trigger channel; non-'linear' makes this a logged no-op (other planes unwired). */
  readonly channelSource?: ChannelSource;
}

/**
 * Render + upsert the single maturing epic panel, and (optionally) mirror the
 * outcome on the parent issue's state + reaction (#247 UX.2). The ONE place
 * the parent panel is written — replaces the old renderStatusBlock-edit +
 * postRollup + standalone notes. Returns the panel comment id (new or existing),
 * or null on a non-linear channel / failure.
 *
 * - Edits ``statusCommentId`` in place when given; else posts a fresh comment.
 * - Header/rows via {@link renderEpicPanel}; ``inProgress`` derived if omitted.
 * - On settle (not in progress): advance parent state→In Review (clean) + ✅;
 *   on failures, leave state + ❌. On in-progress (a revision re-opened it):
 *   revert state→In Progress + reaction→👀. Sequential calls (each fans out
 *   into multiple Linear reads) to avoid self-throttling the 5s timeout.
 * Best-effort: a Linear hiccup never throws out of the reconcile.
 */
export async function upsertEpicPanel(params: UpsertEpicPanelParams): Promise<string | null> {
  const channelSource = params.channelSource ?? 'linear';
  if (channelSource !== 'linear') {
    logger.info('Epic panel skipped — channel has no wired plane', {
      parent_linear_issue_id: params.parentLinearIssueId, channel_source: channelSource,
    });
    return null;
  }
  const rows = buildPanelRows(params.children, params.prUrls ?? {}, params.updating ?? {});
  const terminal = (s: string) => s === 'succeeded' || s === 'failed' || s === 'skipped';
  const inProgress = params.inProgress
    ?? rows.some((r) => !terminal(r.child_status) || r.updatingReason !== undefined);
  const body = renderEpicPanel({
    rows,
    inProgress,
    ...(params.combinedPrUrl !== undefined && { combinedPrUrl: params.combinedPrUrl }),
    ...(params.combinedScreenshotUrl !== undefined && { combinedScreenshotUrl: params.combinedScreenshotUrl }),
  });

  let commentId: string | null;
  try {
    if (params.statusCommentId) {
      commentId = await upsertStatusComment(params.ctx, params.parentLinearIssueId, body, params.statusCommentId);
    } else {
      // Post a fresh comment and capture its id (upsertStatusComment with no id creates + returns it).
      commentId = await upsertStatusComment(params.ctx, params.parentLinearIssueId, body);
    }
  } catch (err) {
    logger.warn('Epic panel upsert threw (non-fatal)', {
      parent_linear_issue_id: params.parentLinearIssueId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Mirror parent state + reaction. Sequential (each fans out into several
  // Linear graphql reads; firing together self-throttles the 5s timeout).
  if (params.mirrorParentState !== false) {
    const anyBad = rows.some((r) => r.child_status === 'failed' || r.child_status === 'skipped');
    try {
      if (inProgress) {
        // Re-opened (or running): back to In Progress + 👀.
        await transitionIssueState(params.ctx, params.parentLinearIssueId, 'started', ['In Progress']);
        await swapIssueReaction(params.ctx, params.parentLinearIssueId, 'eyes');
      } else if (!anyBad) {
        // Clean completion: work done, awaiting human merge → In Review + ✅.
        await transitionIssueState(params.ctx, params.parentLinearIssueId, 'started', ['In Review']);
        await swapIssueReaction(params.ctx, params.parentLinearIssueId, EMOJI_SUCCESS);
      } else {
        // Finished with failures: leave state; ❌ reaction conveys it.
        await swapIssueReaction(params.ctx, params.parentLinearIssueId, EMOJI_FAILURE);
      }
    } catch (err) {
      logger.warn('Epic panel parent-state mirror failed (non-fatal)', {
        parent_linear_issue_id: params.parentLinearIssueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return commentId;
}

export interface PostRollupParams {
  readonly ctx: LinearFeedbackContext;
  readonly orchestrationId: string;
  readonly parentLinearIssueId: string;
  readonly kind: RollupKind;
  readonly children: readonly OrchestrationChildRow[];
  /**
   * The orchestration's trigger channel. Defaults to ``'linear'`` — the only
   * wired rollup plane today. #247 trigger-agnostic seam: a future
   * GitHub/Slack/Jira trigger dispatches its own parent-rollup here (open a
   * tracking comment / update an epic) instead of the Linear comment +
   * state-transition + reaction below. An unrecognised channel is a logged
   * no-op so a mis-seeded orchestration never throws out of the reconciler.
   */
  readonly channelSource?: ChannelSource;
  /**
   * #247 #3: the live status-block comment id stamped at seed. When set, the
   * final rollup EDITS that comment in place (one comment for the whole run,
   * no stream). When absent (seed-time create failed, or an older
   * orchestration), the rollup posts a fresh comment.
   */
  readonly statusCommentId?: string;
  /**
   * #323: ``sub_issue_id → pr_url`` for children that opened a PR. Supplied
   * by the reconciler (batch-read from the TaskTable at rollup time, when
   * pr_urls have settled). Threaded into the rendered comment as per-child
   * links + the integration node's combined-PR callout. Absent/partial is
   * fine — a missing entry just renders no link.
   */
  readonly prUrls?: Readonly<Record<string, string>>;
}

/**
 * Post the parent rollup comment. Best-effort: never throws; logs a
 * stable event on both success and failure so automated tests can assert
 * on ``orch.rollup.posted`` / ``orch.rollup.failed``.
 */
export async function postRollup(params: PostRollupParams): Promise<boolean> {
  const { ctx, orchestrationId, parentLinearIssueId, kind, children, statusCommentId } = params;
  const channelSource = params.channelSource ?? 'linear';

  // #247 trigger-agnostic dispatch. Only the Linear plane is wired today;
  // other channels are an explicit logged no-op (the DAG executor +
  // gating already ran channel-agnostically — only the parent feedback is
  // channel-specific). A new trigger adds its branch here.
  if (channelSource !== 'linear') {
    logger.info('Parent rollup skipped — channel has no wired rollup plane', {
      event: ORCH_LOG.rollupFailed,
      orchestration_id: orchestrationId,
      channel_source: channelSource,
      rollup_kind: kind,
    });
    return false;
  }
  const prUrls = params.prUrls ?? {};
  const body = renderRollupComment(
    kind,
    children.map((c) => ({
      sub_issue_id: c.sub_issue_id,
      ...(c.linear_identifier !== undefined && { linear_identifier: c.linear_identifier }),
      ...(c.title !== undefined && { title: c.title }),
      child_status: c.child_status,
      ...(c.child_task_id !== undefined && { child_task_id: c.child_task_id }),
      ...(prUrls[c.sub_issue_id] !== undefined && { pr_url: prUrls[c.sub_issue_id] }),
    })),
  );

  let ok = false;
  try {
    // #247 #3: edit the live status block into the final rollup when we have
    // its id (one comment for the whole run); else post a fresh comment.
    if (statusCommentId) {
      ok = (await upsertStatusComment(ctx, parentLinearIssueId, body, statusCommentId)) !== null;
    } else {
      ok = await postIssueComment(ctx, parentLinearIssueId, body);
    }
  } catch (err) {
    logger.warn('Parent rollup comment threw (non-fatal)', {
      event: ORCH_LOG.rollupFailed,
      orchestration_id: orchestrationId,
      parent_linear_issue_id: parentLinearIssueId,
      rollup_kind: kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  if (ok) {
    logger.info('Parent rollup comment posted', {
      event: ORCH_LOG.rollupPosted,
      orchestration_id: orchestrationId,
      parent_linear_issue_id: parentLinearIssueId,
      rollup_kind: kind,
      child_count: children.length,
    });

    // Mirror the child sub-issues' status signal on the PARENT epic:
    // - state: on a clean 'complete', advance to In Review (work done, child
    //   PRs awaiting human merge — NOT Done, since nothing is merged). On a
    //   partial_failure / cancelled rollup, leave the state in place (the
    //   comment + ❌ reaction already convey the outcome).
    // - reaction: SWAP the seed 👀 for ✅ (complete) / ❌ (otherwise) so the
    //   parent shows exactly ONE marker at a time, like the children.
    // Run SEQUENTIALLY, not concurrently: the state transition (a team-states
    // query) and the reaction swap (reactions query + deletes + create) each
    // fan out into multiple Linear calls. Firing them together — on top of
    // the rollup comment edit just above — self-throttled the 5s-timeout
    // graphql reads, so the states query aborted and the transition silently
    // no-op'd (parent stuck In Progress). Serialising keeps each read under
    // its own budget. Both best-effort; a hiccup never suppresses the rollup.
    if (kind === 'complete') {
      await transitionIssueState(ctx, parentLinearIssueId, 'started', ['In Review']);
    }
    await swapIssueReaction(ctx, parentLinearIssueId, kind === 'complete' ? EMOJI_SUCCESS : EMOJI_FAILURE);
  } else {
    logger.warn('Parent rollup comment post returned false', {
      event: ORCH_LOG.rollupFailed,
      orchestration_id: orchestrationId,
      parent_linear_issue_id: parentLinearIssueId,
      rollup_kind: kind,
    });
  }
  return ok;
}
