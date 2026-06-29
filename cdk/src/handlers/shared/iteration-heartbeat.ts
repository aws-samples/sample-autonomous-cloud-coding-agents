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
 * K6 — mid-run liveness heartbeat (pure core).
 *
 * Live-caught (ABCA-483, 2026-06-29): a comment-triggered iteration ran for 22
 * minutes showing only "🤖 Starting on this issue", then a terminal ❌ — a total
 * black box in between. The platform already has the data to do better: an
 * iteration task carries its maturing-reply comment id in
 * ``channel_metadata.iteration_reply_comment_id`` and stamps ``created_at``; the
 * agent bumps ``agent_heartbeat_at`` every 45s while RUNNING.
 *
 * This module decides, for ONE RUNNING iteration task, whether a scheduled sweep
 * should edit its maturing reply to show liveness (elapsed + an optional progress
 * note) — and what the new body is. It edits the SAME existing reply comment in
 * place (no new comments — the user's explicit "don't clutter the Linear UI"
 * constraint), reusing the iteration-UX ``working`` state.
 *
 * Pure + deterministic (``now`` injected); all I/O lives in the sweep handler.
 */

import { renderMaturingReply } from './iteration-reply';

/**
 * Below this elapsed floor a RUNNING iteration is NOT heartbeat-updated — a task
 * that just started doesn't need a liveness nudge, and editing too early would
 * fight the trigger-time ack / pr_created edit. Matches the renderer's own
 * elapsed floor so the suffix is meaningful when we do edit.
 */
export const HEARTBEAT_MIN_ELAPSED_S = 90;

/** The fields the sweep reads off a RUNNING task's record (already DDB-unmarshalled). */
export interface HeartbeatTaskView {
  readonly taskId: string;
  readonly status: string;
  /** ISO timestamp the task was created (drives elapsed). */
  readonly createdAt?: string;
  /** Trigger channel — only 'linear' is wired for the reply edit. */
  readonly channelSource?: string;
  /** Linear workspace id (for the per-workspace OAuth token). */
  readonly linearWorkspaceId?: string;
  /** The maturing reply comment id stamped at trigger time. */
  readonly iterationReplyCommentId?: string;
  /** The human comment that triggered the iteration (reply parent). */
  readonly triggerCommentId?: string;
  /** The issue the trigger comment lives on (parent epic or sub-issue). */
  readonly triggerCommentIssueId?: string;
  /** True when this task is a comment-triggered iteration (has the maturing reply). */
  readonly isIteration?: boolean;
  /** PR number, when known (makes the working line name the PR). */
  readonly prNumber?: number | null;
  /** PR url, when known (clickable PR reference). */
  readonly prUrl?: string | null;
  /** Latest agent progress note (sanitized milestone detail), when available. */
  readonly latestProgressNote?: string;
}

/** What the sweep should do for one task. */
export interface HeartbeatPlan {
  readonly taskId: string;
  readonly linearWorkspaceId: string;
  readonly issueId: string;
  readonly parentCommentId: string;
  readonly replyId: string;
  readonly body: string;
  readonly elapsedS: number;
}

/** Parse an ISO timestamp to epoch ms, or null if unusable. */
function parseIso(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decide whether to heartbeat ONE task, and render the new reply body. Returns
 * null when the task is not eligible (not a RUNNING linear iteration with a
 * reply to edit, or not yet past the elapsed floor). Pure — ``nowMs`` injected.
 */
export function planHeartbeat(task: HeartbeatTaskView, nowMs: number): HeartbeatPlan | null {
  if (task.status !== 'RUNNING') return null;
  if (!task.isIteration) return null;
  if ((task.channelSource ?? 'linear') !== 'linear') return null;

  // Every field the reply edit needs must be present — a partial task can't be
  // routed (mirrors the reconciler's reply path requirements).
  const { linearWorkspaceId, iterationReplyCommentId, triggerCommentId, triggerCommentIssueId } = task;
  if (!linearWorkspaceId || !iterationReplyCommentId || !triggerCommentId || !triggerCommentIssueId) {
    return null;
  }

  const startedMs = parseIso(task.createdAt);
  if (startedMs === null) return null;
  const elapsedS = Math.max(0, Math.round((nowMs - startedMs) / 1000));
  if (elapsedS < HEARTBEAT_MIN_ELAPSED_S) return null;

  const body = renderMaturingReply({
    state: 'working',
    ...(task.prNumber != null && { prNumber: task.prNumber }),
    ...(task.prUrl != null && { prUrl: task.prUrl }),
    elapsedS,
    ...(task.latestProgressNote ? { progressNote: task.latestProgressNote } : {}),
  });

  return {
    taskId: task.taskId,
    linearWorkspaceId,
    issueId: triggerCommentIssueId,
    parentCommentId: triggerCommentId,
    replyId: iterationReplyCommentId,
    body,
    elapsedS,
  };
}
