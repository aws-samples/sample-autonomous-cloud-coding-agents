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

import { ACTIVE_STATUSES, PRE_ACTIVE_STATUSES, TERMINAL_STATUSES } from '../api/types';
import type { TaskStatusType, TaskSummary } from '../api/types';

/**
 * Liveness thresholds mirrored from the orchestrator
 * (`cdk/src/handlers/shared/orchestrator.ts`): a RUNNING task is treated as
 * stranded once it has run past the grace period and its last heartbeat is
 * older than the stale threshold. The console only flags; the reconciler acts.
 */
export const AGENT_HEARTBEAT_GRACE_SEC = 120;
export const AGENT_HEARTBEAT_STALE_SEC = 240;

/** Window in which terminal failures still need someone's attention. */
export const RECENT_FAILURE_WINDOW_SEC = 24 * 3600;

export type AttentionReason = 'awaiting_approval' | 'stale_heartbeat' | 'failed' | 'timed_out';

export const ATTENTION_LABELS: Readonly<Record<AttentionReason, string>> = {
  awaiting_approval: 'Needs your OK',
  stale_heartbeat: 'No updates lately',
  failed: 'Failed',
  timed_out: 'Ran out of time',
};

export function isTerminal(status: TaskStatusType): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isActive(status: TaskStatusType): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function isQueued(status: TaskStatusType): boolean {
  return PRE_ACTIVE_STATUSES.includes(status);
}

function ageSec(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (now.getTime() - t) / 1000;
}

/** True when a RUNNING task's agent has stopped reporting liveness. */
export function hasStaleHeartbeat(task: TaskSummary, now: Date = new Date()): boolean {
  if (task.status !== 'RUNNING') return false;
  const heartbeatAge = ageSec(task.agent_heartbeat_at, now);
  if (heartbeatAge !== null) return heartbeatAge > AGENT_HEARTBEAT_STALE_SEC;
  // No beat yet: the summary has no started_at, so the last status change stands in for it.
  const runningAge = ageSec(task.updated_at, now);
  return runningAge !== null && runningAge > AGENT_HEARTBEAT_GRACE_SEC + AGENT_HEARTBEAT_STALE_SEC;
}

/** Why a task needs an operator's attention, or null when it does not. */
export function attentionReason(task: TaskSummary, now: Date = new Date()): AttentionReason | null {
  if (task.status === 'AWAITING_APPROVAL') return 'awaiting_approval';
  if (hasStaleHeartbeat(task, now)) return 'stale_heartbeat';
  if (task.status === 'FAILED' || task.status === 'TIMED_OUT') {
    const age = ageSec(task.updated_at, now);
    if (age !== null && age <= RECENT_FAILURE_WINDOW_SEC) {
      return task.status === 'FAILED' ? 'failed' : 'timed_out';
    }
  }
  return null;
}
