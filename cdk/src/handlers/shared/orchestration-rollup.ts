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
 * Parent rollup comments for Linear orchestration.
 *
 * The fan-out plane posts a final-status comment on each CHILD's
 * sub-issue. The PARENT issue has no task, so its aggregate rollup is
 * posted here, by the reconciler, which already holds the orchestration
 * snapshot. The comment renderer is pure (unit-testable); ``postRollup``
 * wraps ``postIssueComment`` best-effort (a failed Linear comment must
 * never fail the reconcile — gating is the source of truth).
 */

import { logger } from './logger';
import type { Channel, IssueRef } from './orchestration-channel';
import { isIntegrationNode } from './orchestration-integration-node';
import { ORCH_LOG } from './orchestration-log-events';
import type { OrchestrationChildRow } from './orchestration-store';
import { encodeMarkdownUrl } from './screenshot-url';

/** Which rollup we're posting — drives the heading + emoji. */
export type RollupKind = 'complete' | 'partial_failure' | 'cancelled';

export interface RollupChildView {
  readonly sub_issue_id: string;
  readonly display_id?: string;
  readonly title?: string;
  readonly child_status: string;
  readonly child_task_id?: string;
  /**
   * The child task's PR url, when one was opened. Resolved by the
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
  releasing: '🔄', // transient flip-then-create claim — mid-launch
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
    .sort((a, b) => (a.display_id ?? a.sub_issue_id).localeCompare(b.display_id ?? b.sub_issue_id))
    .map((c) => {
      const icon = STATUS_ICON[c.child_status] ?? '•';
      const label = c.display_id
        ? (c.title ? `${c.display_id}: ${c.title}` : c.display_id)
        : (c.title ?? c.sub_issue_id);
      // Append the child's PR link when one was opened, so the parent
      // rollup is a single place to reach every sub-issue's PR.
      const pr = c.pr_url ? ` — [PR](${c.pr_url})` : '';
      return `- ${icon} ${label} — ${c.child_status}${pr}`;
    });

  const summary = `${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.skipped} skipped `
    + `(of ${children.length}).`;

  // Surface the integration node's combined PR as a prominent callout —
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
 * orchestration. Posted at seed and re-rendered + edited on
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
    .sort((a, b) => (a.display_id ?? a.sub_issue_id).localeCompare(b.display_id ?? b.sub_issue_id))
    .map((c) => {
      const icon = STATUS_ICON[c.child_status] ?? '•';
      const label = c.display_id
        ? (c.title ? `${c.display_id}: ${c.title}` : c.display_id)
        : (c.title ?? c.sub_issue_id);
      // Human-friendly status words for the in-flight view. 'releasing' (the
      // transient flip-then-create claim) reads as running like
      // released/ready — the child is mid-launch, not a distinct user-facing state.
      const word =
        c.child_status === 'released' || c.child_status === 'ready' || c.child_status === 'releasing' ? 'running'
          : c.child_status === 'blocked' ? 'blocked'
            : c.child_status;
      // Link the PR as soon as it is known, even mid-run.
      const pr = c.pr_url ? ` — [PR](${c.pr_url})` : '';
      return `- ${icon} ${label} — ${word}${pr}`;
    });

  return [heading, '', ...lines, '', '_Updates live as sub-issues progress._'].join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// The single MATURING panel comment. Supersedes the
// separate renderStatusBlock + renderRollupComment — ONE comment, edited in
// place, that shows the full DAG and matures from in-progress → complete and
// back to in-progress on an extend/revision.
// ───────────────────────────────────────────────────────────────────────────

/** Per-sub-issue view for the maturing panel — adds the 'updating' context the rollup/block can't express. */
export interface EpicPanelRow {
  readonly sub_issue_id: string;
  readonly display_id?: string;
  readonly title?: string;
  /** Persisted orchestration status: blocked | ready | released | succeeded | failed | skipped. */
  readonly child_status: string;
  /** The sub-issue's current PR url, when one exists yet (omitted for a not-yet-PR'd first run). */
  readonly pr_url?: string;
  /**
   * When this row is being re-built by an in-flight cascade/iteration (its
   * persisted status is still 'succeeded' but a new task is updating its PR),
   * the human-readable reason — e.g. `per ENG-42's "button doesn't work"` or
   * `to include ENG-42's change`. Present → the row renders as 🔄 updating.
   */
  readonly updatingReason?: string;
  /**
   * SHORT one-line reason for a ❌ failed row, rendered as an indented sub-line:
   * WHAT failed + WHERE to read it (CloudWatch by task
   * id). Critical for the synthetic integration node, which has no Linear
   * sub-issue / comment-iteration reply and would otherwise surface as a bare
   * "❌ … — failed" with no diagnostic. Composed by
   * {@link renderPanelFailureReason}; absent for non-failed rows.
   */
  readonly failureReason?: string;
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
  /**
   * Live deploy-preview URL the combined screenshot was captured from.
   * When present, the embedded combined preview becomes a clickable
   * deep-link to the running combined site. Ignored unless
   * ``combinedScreenshotUrl`` is also set.
   */
  readonly combinedPreviewUrl?: string;
}

const PANEL_FOOTER = '_One live panel — updates in place as the epic progresses; no comment stream._';

/**
 * Truncate a quoted comment for the "updating per …" row, keeping it short.
 * Exported so the caller (reconciler) builds the ``updatingReason`` string —
 * e.g. ``per ENG-42's "${truncateQuote(commentBody)}"``.
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
 * clumsy synthetic title. Prefers the Linear identifier (ENG-42) for real
 * nodes. (Observed in practice: the raw synthetic title read badly in prose.)
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
  if (row.display_id) return row.title ? `${row.display_id}: ${row.title}` : row.display_id;
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
  const { rows, inProgress, combinedPrUrl, combinedScreenshotUrl, combinedPreviewUrl } = params;
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
    .sort((a, b) => (a.display_id ?? a.sub_issue_id).localeCompare(b.display_id ?? b.sub_issue_id))
    .map((r) => {
      const label = panelLabel(r);
      const pr = r.pr_url ? ` — [PR](${r.pr_url})` : '';
      // A mid-update row: 🔄 + the reason, regardless of persisted status.
      if (r.updatingReason) {
        return `- 🔄 ${label} — updating ${r.updatingReason}${pr}`;
      }
      const icon = STATUS_ICON[r.child_status] ?? '•';
      const word =
        r.child_status === 'released' || r.child_status === 'ready' || r.child_status === 'releasing' ? 'running'
          : r.child_status === 'blocked' ? 'blocked'
            : r.child_status;
      const line = `- ${icon} ${label} — ${word}${pr}`;
      // A failed row carries a diagnostic sub-line (what failed + the
      // CloudWatch task to read). Indented continuation so it reads as a
      // detail of the row, not a sibling bullet. Only when a reason was
      // resolved (the integration node is the prime beneficiary — no sub-issue
      // comment carries this anywhere else).
      if (r.child_status === 'failed' && r.failureReason) {
        return `${line}\n    ↳ ${r.failureReason}`;
      }
      return line;
    });

  // A SETTLED epic that finished with failures tells the user how to retry. Names
  // ONE way, deliberately: re-applying the label is a different gesture that only
  // happens to retry in this one state — the same label re-apply also means "add
  // the sub-issues I just created", "nothing to do, still running", or "already
  // complete", inferred from the graph rather than from what the user meant. So an
  // epic with both a new sub-issue and a failure does two things on a re-label and
  // one on a retry, which is why the previous "either way" wording was wrong.
  // Commenting is also the more reliable of the two: a label change only triggers
  // when the webhook reports the label set as having changed, whereas a comment is
  // an unambiguous event. The label is offered as a fallback, not an equal.
  // Only when the epic is terminal (not inProgress) AND something failed/skipped
  // (nothing to retry otherwise). One line so the panel stays scannable.
  const retryHint = (!inProgress && anyBad)
    ? ['', '↻ **To retry:** reply `@bgagent retry` on this epic — it re-runs only the '
      + 'failed/skipped sub-issues and keeps the ones that succeeded. '
      + '(No reply? Removing and re-applying the `abca` label also retries.)']
    : [];

  const callout = combinedPrUrl
    ? ['', `🔗 **Combined PR (all sub-issues merged):** [${combinedPrUrl}](${combinedPrUrl})`]
    : [];
  // When we know the live preview-deploy URL, render the embedded
  // screenshot as a clickable linked image + a plain "Open the combined
  // preview" link, so a reviewer can open the running combined site, not just
  // see a static PNG. The preview URL is payload-derived (came from the deploy
  // webhook) — percent-encode its parens so a crafted path can't break out of
  // the markdown link. The CloudFront screenshot URL is our own key (no
  // parens) so it's interpolated as-is.
  let shot: string[] = [];
  if (combinedScreenshotUrl) {
    if (combinedPreviewUrl) {
      const safePreview = encodeMarkdownUrl(combinedPreviewUrl);
      shot = [
        '',
        '🖼️ **Combined preview**',
        '',
        `[![combined preview](${combinedScreenshotUrl})](${safePreview})`,
        '',
        `[Open the combined preview](${safePreview})`,
      ];
    } else {
      shot = ['', '🖼️ **Combined preview**', '', `![combined preview](${combinedScreenshotUrl})`];
    }
  }

  return [heading, '', ...lines, ...callout, ...retryHint, ...shot, '', PANEL_FOOTER].join('\n');
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
 * Build the {@link EpicPanelRow}s for a snapshot's children. Maps
 * the persisted child rows + a ``sub_issue_id → pr_url`` map + an optional
 * ``sub_issue_id → updatingReason`` map (rows a cascade is rebuilding) into the
 * panel view. Pure.
 */
export function buildPanelRows(
  children: readonly OrchestrationChildRow[],
  prUrls: Readonly<Record<string, string>> = {},
  updating: Readonly<Record<string, string>> = {},
  failureReasons: Readonly<Record<string, string>> = {},
): EpicPanelRow[] {
  return children.map((c) => ({
    sub_issue_id: c.sub_issue_id,
    ...(c.display_id !== undefined && { display_id: c.display_id }),
    ...(c.title !== undefined && { title: c.title }),
    child_status: c.child_status,
    ...(prUrls[c.sub_issue_id] !== undefined && { pr_url: prUrls[c.sub_issue_id] }),
    ...(updating[c.sub_issue_id] !== undefined && { updatingReason: updating[c.sub_issue_id] }),
    ...(failureReasons[c.sub_issue_id] !== undefined && { failureReason: failureReasons[c.sub_issue_id] }),
  }));
}

export interface UpsertEpicPanelParams {
  /** The surface adapter to drive. Optional capabilities it omits are skipped. */
  readonly channel: Channel;
  /** The parent epic, on whichever surface triggered the orchestration. */
  readonly parent: IssueRef;
  /** Existing panel comment id (status_comment_id). When absent, a fresh comment is posted + the id returned. */
  readonly statusCommentId?: string;
  readonly children: readonly OrchestrationChildRow[];
  readonly prUrls?: Readonly<Record<string, string>>;
  /** sub_issue_id → human reason, for rows a cascade is currently rebuilding. */
  readonly updating?: Readonly<Record<string, string>>;
  /**
   * sub_issue_id → one-line failure reason for a ❌ row. Resolved by the
   * reconciler from the failed child task's record (build-gate vs agent-crash +
   * CloudWatch task id). The integration node's entry is the one that matters
   * most — it's the only place its combined-build failure can be surfaced.
   */
  readonly failureReasons?: Readonly<Record<string, string>>;
  readonly combinedPrUrl?: string;
  readonly combinedScreenshotUrl?: string;
  /** Live preview-deploy URL the combined screenshot was captured from. */
  readonly combinedPreviewUrl?: string;
  /**
   * Whether the epic is in progress. When omitted, derived: in progress iff any
   * child is non-terminal OR any row has an updating reason. Pass explicitly to
   * force (e.g. a revision just started → still in progress even if all
   * persisted statuses are terminal).
   */
  readonly inProgress?: boolean;
  /**
   * When true AND the epic is settled, mirror the outcome on the PARENT issue:
   * advance state to awaiting-review (clean) / leave it (failures) + swap the
   * reaction to ✅/❌. When in progress, revert: state → running + reaction → 👀.
   * Skipped on surfaces without reaction/transition support. Default true.
   */
  readonly mirrorParentState?: boolean;
}

/**
 * Render + upsert the single maturing epic panel, and (optionally) mirror the
 * outcome on the parent issue's state + reaction. The ONE place the parent panel
 * is written. Returns the panel comment id (new or existing), or null on failure.
 *
 * - Edits ``statusCommentId`` in place when given; else posts a fresh comment.
 * - Header/rows via {@link renderEpicPanel}; ``inProgress`` derived if omitted.
 * - On settle (not in progress): advance parent state → awaiting review (clean)
 *   + ✅; on failures, leave the state and let ❌ convey it. On in-progress (a
 *   revision re-opened it): back to running + 👀.
 * - Sequential, not concurrent: each mirror step fans out into several surface
 *   reads, and firing them together self-throttled the request budget so a
 *   transition silently no-op'd and left the epic stuck.
 * Best-effort: a surface hiccup never throws out of the reconcile.
 */
export async function upsertEpicPanel(params: UpsertEpicPanelParams): Promise<string | null> {
  const { channel, parent } = params;
  const rows = buildPanelRows(params.children, params.prUrls ?? {}, params.updating ?? {}, params.failureReasons ?? {});
  const terminal = (s: string) => s === 'succeeded' || s === 'failed' || s === 'skipped';
  const inProgress = params.inProgress
    ?? rows.some((r) => !terminal(r.child_status) || r.updatingReason !== undefined);
  const body = renderEpicPanel({
    rows,
    inProgress,
    ...(params.combinedPrUrl !== undefined && { combinedPrUrl: params.combinedPrUrl }),
    ...(params.combinedScreenshotUrl !== undefined && { combinedScreenshotUrl: params.combinedScreenshotUrl }),
    ...(params.combinedPreviewUrl !== undefined && { combinedPreviewUrl: params.combinedPreviewUrl }),
  });

  let commentId: string | null;
  try {
    const ref = await channel.upsertComment(
      parent,
      body,
      params.statusCommentId ? { commentId: params.statusCommentId } : undefined,
    );
    // A surface that can't hand back a real comment id reports an empty one.
    // Treat that as "no panel id" rather than persisting a blank id the next
    // edit would try (and fail) to address.
    commentId = ref?.commentId || null;
  } catch (err) {
    logger.warn('Epic panel upsert threw (non-fatal)', {
      parent_issue_id: parent.issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Mirror parent state + reaction, sequentially (see the note above).
  if (params.mirrorParentState !== false) {
    const anyBad = rows.some((r) => r.child_status === 'failed' || r.child_status === 'skipped');
    try {
      if (inProgress) {
        // Re-opened (or running): back to running + 👀. This is a deliberate
        // move backward within the same state category — a settled epic sits in
        // "awaiting review", and re-opening it must be allowed explicitly or the
        // adapter's backward-move guard drops it silently. A parent a human
        // already marked done stays done; that guard still applies.
        await channel.transitionState?.(parent, 'started', { allowRegression: true });
        await channel.replaceIssueReaction?.(parent, 'started');
      } else if (!anyBad) {
        // Clean completion: work done, awaiting human merge → in review + ✅.
        await channel.transitionState?.(parent, 'in_review');
        await channel.replaceIssueReaction?.(parent, 'succeeded');
      } else {
        // Finished with failures: leave the state; the ❌ reaction conveys it.
        await channel.replaceIssueReaction?.(parent, 'failed');
      }
    } catch (err) {
      logger.warn('Epic panel parent-state mirror failed (non-fatal)', {
        parent_issue_id: parent.issueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return commentId;
}

export interface PostRollupParams {
  /** The surface adapter to drive. Optional capabilities it omits are skipped. */
  readonly channel: Channel;
  readonly orchestrationId: string;
  /** The parent epic, on whichever surface triggered the orchestration. */
  readonly parent: IssueRef;
  readonly kind: RollupKind;
  readonly children: readonly OrchestrationChildRow[];
  /**
   * The live status-block comment id stamped at seed. When set, the
   * final rollup EDITS that comment in place (one comment for the whole run,
   * no stream). When absent (seed-time create failed, or an older
   * orchestration), the rollup posts a fresh comment.
   */
  readonly statusCommentId?: string;
  /**
   * ``sub_issue_id → pr_url`` for children that opened a PR. Supplied
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
  const { channel, parent, orchestrationId, kind, children, statusCommentId } = params;
  const prUrls = params.prUrls ?? {};
  const body = renderRollupComment(
    kind,
    children.map((c) => ({
      sub_issue_id: c.sub_issue_id,
      ...(c.display_id !== undefined && { display_id: c.display_id }),
      ...(c.title !== undefined && { title: c.title }),
      child_status: c.child_status,
      ...(c.child_task_id !== undefined && { child_task_id: c.child_task_id }),
      ...(prUrls[c.sub_issue_id] !== undefined && { pr_url: prUrls[c.sub_issue_id] }),
    })),
  );

  let ok = false;
  try {
    // Edit the live status block into the final rollup when we have its id (one
    // comment for the whole run); else post a fresh comment.
    if (statusCommentId) {
      ok = (await channel.upsertComment(parent, body, { commentId: statusCommentId })) !== null;
    } else {
      ok = (await channel.postComment(parent, body)) !== null;
    }
  } catch (err) {
    logger.warn('Parent rollup comment threw (non-fatal)', {
      event: ORCH_LOG.rollupFailed,
      orchestration_id: orchestrationId,
      parent_issue_id: parent.issueId,
      rollup_kind: kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  if (ok) {
    logger.info('Parent rollup comment posted', {
      event: ORCH_LOG.rollupPosted,
      orchestration_id: orchestrationId,
      parent_issue_id: parent.issueId,
      rollup_kind: kind,
      child_count: children.length,
    });

    // Mirror the children's status signal on the PARENT epic:
    // - state: on a clean 'complete', advance to awaiting-review (work done,
    //   child PRs awaiting a human merge — NOT done, since nothing is merged).
    //   On a partial-failure / cancelled rollup, leave the state in place (the
    //   comment + ❌ reaction already convey the outcome).
    // - reaction: replace the seed 👀 with ✅ (complete) / ❌ (otherwise) so the
    //   parent shows exactly ONE marker at a time, like the children.
    // Run SEQUENTIALLY, not concurrently: the state transition and the reaction
    // replace each fan out into multiple surface calls. Firing them together —
    // on top of the comment edit just above — self-throttled the request budget,
    // so the states read aborted and the transition silently no-op'd, leaving
    // the parent stuck. Serialising keeps each read under its own budget. Both
    // best-effort; a hiccup never suppresses the rollup.
    if (kind === 'complete') {
      await channel.transitionState?.(parent, 'in_review');
    }
    await channel.replaceIssueReaction?.(parent, kind === 'complete' ? 'succeeded' : 'failed');
  } else {
    logger.warn('Parent rollup comment post returned false', {
      event: ORCH_LOG.rollupFailed,
      orchestration_id: orchestrationId,
      parent_issue_id: parent.issueId,
      rollup_kind: kind,
    });
  }
  return ok;
}
