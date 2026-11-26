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

import type { ChildStatus } from './orchestration-store';

export interface ReconcileChild {
  readonly sub_issue_id: string;
  readonly depends_on: readonly string[];
  readonly child_status: ChildStatus;
}

export interface TerminalOutcome {
  readonly sub_issue_id: string;
  readonly status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  /**
   * Whether the agent build passed. A child can be ``COMPLETED`` with
   * ``build_passed === false`` (PR opened but build failed); we do NOT
   * release dependents onto broken code. ``undefined`` is treated as
   * "not known to have failed" → still a success for gating.
   */
  readonly build_passed?: boolean;
}

export interface StatusUpdate {
  readonly sub_issue_id: string;
  readonly child_status: ChildStatus;
}

export interface ReconcilePlan {
  /** ``true`` when the terminal child counts as a success for gating. */
  readonly terminalSucceeded: boolean;
  /** Status writes to apply (includes the terminal child itself). */
  readonly statusUpdates: readonly StatusUpdate[];
  /** Sub-issue ids that are now releasable (create child task, mark released). */
  readonly toRelease: readonly string[];
  /** True when every child has reached a terminal orchestration state. */
  readonly orchestrationComplete: boolean;
}

const TERMINAL_CHILD_STATUSES: ReadonlySet<ChildStatus> = new Set<ChildStatus>([
  'succeeded',
  'failed',
  'skipped',
]);

function isSuccess(outcome: TerminalOutcome): boolean {
  return outcome.status === 'COMPLETED' && outcome.build_passed !== false;
}

/**
 * Compute the reconcile plan for one terminal child.
 *
 * @param outcome  the child that just reached terminal state.
 * @param children all rows for the orchestration (including the terminal
 *                 child). ``child_status`` reflects current persisted state.
 *
 * Gating rules:
 * - Success: mark the child ``succeeded``. Any ``blocked`` child whose
 *   predecessors are ALL succeeded (diamond needs all, not any)
 *   becomes ``toRelease``.
 * - Failure/cancel/timeout, or COMPLETED-with-failed-build:
 *   mark the child ``failed``, and transitively mark every not-yet-started
 *   dependent (direct + indirect) ``skipped``.
 */
export function computeReconcilePlan(
  outcome: TerminalOutcome,
  children: readonly ReconcileChild[],
): ReconcilePlan {
  const succeeded = isSuccess(outcome);

  const statusOf = new Map<string, ChildStatus>(
    children.map((c) => [c.sub_issue_id, c.child_status]),
  );

  const updates: StatusUpdate[] = [];
  const setStatus = (id: string, s: ChildStatus): void => {
    statusOf.set(id, s);
    updates.push({ sub_issue_id: id, child_status: s });
  };

  setStatus(outcome.sub_issue_id, succeeded ? 'succeeded' : 'failed');

  const toRelease: string[] = [];

  if (succeeded) {
    for (const c of children) {
      if (statusOf.get(c.sub_issue_id) !== 'blocked') continue;
      const allSucceeded = c.depends_on.every((dep) => statusOf.get(dep) === 'succeeded');
      if (allSucceeded) {
        toRelease.push(c.sub_issue_id);
        setStatus(c.sub_issue_id, 'released');
      }
    }
  } else {
    const dependents = new Map<string, string[]>();
    for (const c of children) {
      for (const dep of c.depends_on) {
        const list = dependents.get(dep) ?? [];
        list.push(c.sub_issue_id);
        dependents.set(dep, list);
      }
    }
    const queue = [outcome.sub_issue_id];
    const skipped = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const dependentId of dependents.get(cur) ?? []) {
        if (skipped.has(dependentId)) continue;
        const cur_status = statusOf.get(dependentId);
        if (cur_status === 'blocked' || cur_status === 'ready') {
          setStatus(dependentId, 'skipped');
          skipped.add(dependentId);
        }
        queue.push(dependentId);
      }
    }
  }

  const orchestrationComplete = children.every((c) => {
    const s = statusOf.get(c.sub_issue_id)!;
    return TERMINAL_CHILD_STATUSES.has(s);
  });

  return {
    terminalSucceeded: succeeded,
    statusUpdates: updates,
    toRelease,
    orchestrationComplete,
  };
}

export interface RecoveryPlan {
  /** Status writes to apply (the un-failed node + any un-skipped dependents). */
  readonly statusUpdates: readonly StatusUpdate[];
  /** Sub-issue ids now releasable (un-skipped because predecessors all succeeded). */
  readonly toRelease: readonly string[];
}

/**
 * RECOVERY cascade. A human fixed a previously-FAILED sub-issue via a
 * comment (``@bgagent …``), its iteration task just succeeded:
 *
 *   1. Flip the recovered node ``failed`` → ``succeeded``.
 *   2. Reset every transitively-``skipped`` descendant to ``blocked``.
 *   3. Any ``blocked`` child whose predecessors are now ALL ``succeeded``
 *      becomes releasable.
 *
 * Returns empty updates when the node wasn't actually ``failed``.
 *
 * @param recoveredSubIssueId the node whose fix-iteration just succeeded.
 * @param children            current orchestration rows.
 */
export function computeRecoveryPlan(
  recoveredSubIssueId: string,
  children: readonly ReconcileChild[],
): RecoveryPlan {
  const current = children.find((c) => c.sub_issue_id === recoveredSubIssueId);
  if (!current || current.child_status !== 'failed') {
    return { statusUpdates: [], toRelease: [] };
  }

  const statusOf = new Map<string, ChildStatus>(
    children.map((c) => [c.sub_issue_id, c.child_status]),
  );
  const updates: StatusUpdate[] = [];
  const setStatus = (id: string, s: ChildStatus): void => {
    statusOf.set(id, s);
    updates.push({ sub_issue_id: id, child_status: s });
  };

  setStatus(recoveredSubIssueId, 'succeeded');

  const dependents = new Map<string, string[]>();
  for (const c of children) {
    for (const dep of c.depends_on) {
      const list = dependents.get(dep) ?? [];
      list.push(c.sub_issue_id);
      dependents.set(dep, list);
    }
  }
  const queue = [recoveredSubIssueId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const depId of dependents.get(cur) ?? []) {
      if (seen.has(depId)) continue;
      seen.add(depId);
      if (statusOf.get(depId) === 'skipped') {
        setStatus(depId, 'blocked');
      }
      queue.push(depId);
    }
  }

  const toRelease: string[] = [];
  for (const c of children) {
    if (statusOf.get(c.sub_issue_id) !== 'blocked') continue;
    const allSucceeded = c.depends_on.every((dep) => statusOf.get(dep) === 'succeeded');
    if (allSucceeded) toRelease.push(c.sub_issue_id);
  }

  return { statusUpdates: updates, toRelease };
}

export interface EpicRetryPlan {
  /** Status writes to apply (failed→ready/blocked, skipped→blocked). */
  readonly statusUpdates: readonly StatusUpdate[];
  /** Sub-issue ids now releasable (a reset node with all predecessors succeeded). */
  readonly toRelease: readonly string[];
  /** Count of nodes that were failed before this retry. */
  readonly failedCount: number;
  /** Count of nodes that were skipped before this retry. */
  readonly skippedCount: number;
  /** Count of nodes left untouched because they already succeeded. */
  readonly succeededCount: number;
}

/**
 * RETRY the whole epic. A human re-applied the trigger label (or
 * re-triggered) on a parent whose orchestration is already TERMINAL: some
 * children ``failed`` (and their dependents transitively ``skipped``):
 *
 *   1. Every ``failed`` node → ``ready`` if all its predecessors are ``succeeded``,
 *      else ``blocked``.
 *   2. Every ``skipped`` node → ``blocked``.
 *   3. ``succeeded`` nodes are LEFT ALONE — we never re-run work that landed.
 *   4. Release every now-``ready`` node whose predecessors are ALL ``succeeded``.
 *
 * Returns empty ``statusUpdates`` and ``toRelease`` when NOTHING is failed or
 * skipped (a healthy or still-running epic).
 */
export function computeEpicRetryPlan(
  children: readonly ReconcileChild[],
): EpicRetryPlan {
  const statusOf = new Map<string, ChildStatus>(
    children.map((c) => [c.sub_issue_id, c.child_status]),
  );
  const failedCount = children.filter((c) => c.child_status === 'failed').length;
  const skippedCount = children.filter((c) => c.child_status === 'skipped').length;
  const succeededCount = children.filter((c) => c.child_status === 'succeeded').length;

  if (failedCount === 0 && skippedCount === 0) {
    return { statusUpdates: [], toRelease: [], failedCount, skippedCount, succeededCount };
  }

  const updates: StatusUpdate[] = [];
  const setStatus = (id: string, s: ChildStatus): void => {
    statusOf.set(id, s);
    updates.push({ sub_issue_id: id, child_status: s });
  };

  for (const c of children) {
    if (c.child_status === 'failed') {
      const allDepsSucceeded = c.depends_on.every((dep) => statusOf.get(dep) === 'succeeded');
      setStatus(c.sub_issue_id, allDepsSucceeded ? 'ready' : 'blocked');
    } else if (c.child_status === 'skipped') {
      setStatus(c.sub_issue_id, 'blocked');
    }
  }

  const toRelease: string[] = [];
  for (const c of children) {
    if (statusOf.get(c.sub_issue_id) !== 'ready') continue;
    const allSucceeded = c.depends_on.every((dep) => statusOf.get(dep) === 'succeeded');
    if (allSucceeded) toRelease.push(c.sub_issue_id);
  }

  return { statusUpdates: updates, toRelease, failedCount, skippedCount, succeededCount };
}
