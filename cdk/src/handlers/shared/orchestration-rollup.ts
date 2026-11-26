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

import { logger } from './logger';
import { type LookupResult, LOOKUP_ABSENT, lookupFailed, lookupFound } from './lookup-result';
import type { Channel, IssueRef } from './orchestration-channel';
import { isIntegrationNode } from './orchestration-integration-node';
import type { OrchestrationChildRow } from './orchestration-store';
import { encodeMarkdownUrl } from './screenshot-url';
import { DEFAULT_LABEL_FILTER } from './trigger-label';

const STATUS_ICON: Record<string, string> = {
  succeeded: '✅',
  failed: '❌',
  skipped: '⏭️',
  released: '🔄',
  releasing: '🔄',
  ready: '🔄',
  blocked: '⏳',
};

export interface EpicPanelRow {
  readonly sub_issue_id: string;
  readonly display_id?: string;
  readonly title?: string;
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
   * WHAT failed + WHERE to read it (CloudWatch by task id). Composed by
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
  /**
   * The project's resolved trigger label, for the retry hint's fallback line.
   * Absent → the platform default.
   */
  readonly labelFilter?: string;
}

const PANEL_FOOTER = '_One live panel — updates in place as the epic progresses; no comment stream._';

/**
 * SHORT friendly name for a node, used where a node is NAMED inside prose (e.g.
 * the cascade reason "updating to include <X>'s change"). The integration node
 * gets the friendly "the integration" rather than its raw stored title. Prefers
 * the Linear identifier (ENG-42) for real nodes.
 */
export function cascadeNodeLabel(
  subIssueId: string,
  linearIdentifier?: string,
  title?: string,
): string {
  if (isIntegrationNode(subIssueId)) return 'the integration';
  return linearIdentifier ?? title ?? 'a predecessor';
}

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
  const triggerLabel = params.labelFilter?.trim() || DEFAULT_LABEL_FILTER;
  const terminal = (s: string) => s === 'succeeded' || s === 'failed' || s === 'skipped';
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
    .sort((a, b) => Number(isIntegrationNode(a.sub_issue_id)) - Number(isIntegrationNode(b.sub_issue_id))
      || (a.display_id ?? a.sub_issue_id).localeCompare(b.display_id ?? b.sub_issue_id, undefined, { numeric: true }))
    .map((r) => {
      const label = panelLabel(r);
      const pr = r.pr_url ? ` — [PR](${r.pr_url})` : '';
      if (r.updatingReason) {
        return `- 🔄 ${label} — updating ${r.updatingReason}${pr}`;
      }
      const icon = STATUS_ICON[r.child_status] ?? '•';
      const word =
        r.child_status === 'released' || r.child_status === 'ready' || r.child_status === 'releasing' ? 'running'
          : r.child_status === 'blocked' ? 'blocked'
            : r.child_status;
      const line = `- ${icon} ${label} — ${word}${pr}`;
      if (r.child_status === 'failed' && r.failureReason) {
        return `${line}\n    ↳ ${r.failureReason}`;
      }
      return line;
    });

  const retryHint = (!inProgress && anyBad)
    ? ['', '↻ **To retry:** reply `@bgagent retry` on this epic — it re-runs only the '
      + 'failed/skipped sub-issues and keeps the ones that succeeded. '
      + `(No reply? Removing and re-applying the \`${triggerLabel}\` label also retries.)`]
    : [];

  const callout = combinedPrUrl
    ? ['', `🔗 **Combined PR (all sub-issues merged):** [${combinedPrUrl}](${combinedPrUrl})`]
    : [];
  const previewLabel = combinedPrUrl ? 'Combined preview' : 'Preview';
  let shot: string[] = [];
  if (combinedScreenshotUrl) {
    if (combinedPreviewUrl) {
      const safePreview = encodeMarkdownUrl(combinedPreviewUrl);
      shot = [
        '',
        `🖼️ **${previewLabel}**`,
        '',
        `[![${previewLabel.toLowerCase()}](${combinedScreenshotUrl})](${safePreview})`,
        '',
        `[Open the ${previewLabel.toLowerCase()}](${safePreview})`,
      ];
    } else {
      shot = ['', `🖼️ **${previewLabel}**`, '', `![${previewLabel.toLowerCase()}](${combinedScreenshotUrl})`];
    }
  }

  return [heading, '', ...lines, ...callout, ...retryHint, ...shot, '', PANEL_FOOTER].join('\n');
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
  /** sub_issue_id → one-line failure reason for a ❌ row. */
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
  /**
   * The project's resolved trigger label, forwarded to {@link renderEpicPanel}
   * for the retry hint. Absent → the platform default.
   */
  readonly labelFilter?: string;
}

/**
 * Render + upsert the single maturing epic panel, and (optionally) mirror the
 * outcome on the parent issue's state + reaction. The ONE place the parent panel
 * is written.
 *
 * Returns a {@link LookupResult}: ``found`` with the panel comment id (new or
 * existing), ``absent`` when the surface accepted the upsert but handed back no
 * usable id (nothing to persist), or ``failed`` when the upsert threw (already
 * logged at source).
 *
 * - Edits ``statusCommentId`` in place when given; else posts a fresh comment.
 * - Header/rows via {@link renderEpicPanel}; ``inProgress`` derived if omitted.
 * - On settle (not in progress): advance parent state → awaiting review (clean)
 *   + ✅; on failures, leave the state and let ❌ convey it. On in-progress (a
 *   revision re-opened it): back to running + 👀.
 * Best-effort: a surface hiccup never throws out of the reconcile.
 */
export async function upsertEpicPanel(params: UpsertEpicPanelParams): Promise<LookupResult<string>> {
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
    ...(params.labelFilter !== undefined && { labelFilter: params.labelFilter }),
  });

  let commentId: string | null;
  try {
    const ref = await channel.upsertComment(
      parent,
      body,
      params.statusCommentId ? { commentId: params.statusCommentId } : undefined,
    );
    commentId = ref?.commentId || null;
  } catch (err) {
    logger.warn('Epic panel upsert threw (non-fatal)', {
      parent_issue_id: parent.issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    return lookupFailed(err);
  }

  if (params.mirrorParentState !== false) {
    const anyBad = rows.some((r) => r.child_status === 'failed' || r.child_status === 'skipped');
    try {
      if (inProgress) {
        await channel.transitionState?.(parent, 'started', { allowRegression: true });
        await channel.replaceIssueReaction?.(parent, 'started');
      } else if (!anyBad) {
        await channel.transitionState?.(parent, 'in_review');
        await channel.replaceIssueReaction?.(parent, 'succeeded');
      } else {
        await channel.replaceIssueReaction?.(parent, 'failed');
      }
    } catch (err) {
      logger.warn('Epic panel parent-state mirror failed (non-fatal)', {
        parent_issue_id: parent.issueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return commentId ? lookupFound(commentId) : LOOKUP_ABSENT;
}
