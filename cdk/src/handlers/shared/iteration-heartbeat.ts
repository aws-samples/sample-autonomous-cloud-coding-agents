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

import { renderMaturingReply } from './iteration-reply';

const HEARTBEAT_MIN_ELAPSED_S = 90;

export interface HeartbeatTaskView {
  readonly taskId: string;
  readonly status: string;
  /** ISO timestamp the task was created (drives elapsed). */
  readonly createdAt?: string;
  /** Trigger channel. Linear and Jira support maturing iteration comments. */
  readonly channelSource?: string;
  readonly linearWorkspaceId?: string;
  readonly jiraCloudId?: string;
  readonly iterationReplyCommentId?: string;
  readonly triggerCommentId?: string;
  /** The issue the trigger comment lives on (parent epic or sub-issue). */
  readonly triggerCommentIssueId?: string;
  /**
   * Whether this task carries the orchestration-iteration marker. NOT used for
   * eligibility: a standalone iteration omits the marker.
   */
  readonly isIteration?: boolean;
  readonly prNumber?: number | null;
  readonly prUrl?: string | null;
  /** Latest agent progress note (sanitized milestone detail). */
  readonly latestProgressNote?: string;
}

export interface HeartbeatPlan {
  readonly taskId: string;
  readonly channelSource: 'linear' | 'jira';
  readonly credentialsRef: string;
  readonly issueId: string;
  /** Linear thread root. Jira's maturing comment is top-level. */
  readonly parentCommentId?: string;
  readonly replyId: string;
  readonly body: string;
  readonly elapsedS: number;
}

function parseIso(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decide whether to heartbeat ONE task, and render the new reply body. Returns
 * null when the task is not eligible (not a RUNNING Linear/Jira iteration with a
 * reply to edit, or not yet past the elapsed floor). Pure — ``nowMs`` injected.
 */
export function planHeartbeat(task: HeartbeatTaskView, nowMs: number): HeartbeatPlan | null {
  if (task.status !== 'RUNNING') return null;
  const channelSource = task.channelSource ?? 'linear';
  if (channelSource !== 'linear' && channelSource !== 'jira') return null;

  const {
    linearWorkspaceId,
    jiraCloudId,
    iterationReplyCommentId,
    triggerCommentId,
    triggerCommentIssueId,
  } = task;
  const credentialsRef = channelSource === 'jira' ? jiraCloudId : linearWorkspaceId;
  if (
    !credentialsRef
    || !iterationReplyCommentId
    || !triggerCommentIssueId
    || (channelSource === 'linear' && !triggerCommentId)
  ) {
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
    channelSource,
    credentialsRef,
    issueId: triggerCommentIssueId,
    ...(triggerCommentId && { parentCommentId: triggerCommentId }),
    replyId: iterationReplyCommentId,
    body,
    elapsedS,
  };
}
