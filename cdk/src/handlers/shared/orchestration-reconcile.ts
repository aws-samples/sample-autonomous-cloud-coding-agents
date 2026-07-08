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
 * Pure gating logic for the orchestration reconciler (issue #247, Mode A
 * — PR A3). Given a child sub-issue that just reached a terminal state
 * plus the current orchestration rows, decide:
 *   - the new ``child_status`` for the terminal child,
 *   - which blocked children become releasable (all predecessors
 *     succeeded), and
 *   - which children must be skipped (a predecessor failed → transitive
 *     dependents never start).
 *
 * No I/O — the reconciler handler applies the returned plan to
 * DynamoDB + ``createTaskCore``. Keeping this pure makes the 8-case
 * failure matrix from the design doc directly unit-testable.
 */

import type { ChildStatus } from './orchestration-store';

/** Minimal view of an orchestration child row the gating logic needs. */
export interface ReconcileChild {
  readonly sub_issue_id: string;
  readonly depends_on: readonly string[];
  readonly child_status: ChildStatus;
}

/** The terminal outcome of the child that triggered this reconcile. */
export interface TerminalOutcome {
  readonly sub_issue_id: string;
  /** Task terminal status. */
  readonly status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  /**
   * Whether the agent build passed. A child can be ``COMPLETED`` with
   * ``build_passed === false`` (PR opened but build failed); we do NOT
   * release dependents onto broken code. ``undefined`` is treated as
   * "not known to have failed" → still a success for gating (matches
   * the TaskRecord field being optional/absent on older records).
   */
  readonly build_passed?: boolean;
}

/** A single child-status mutation the handler must persist. */
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

/** Orchestration-local terminal child statuses. */
const TERMINAL_CHILD_STATUSES: ReadonlySet<ChildStatus> = new Set<ChildStatus>([
  'succeeded',
  'failed',
  'skipped',
]);

/** A child counts as "done successfully" for releasing its dependents. */
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
 * Gating rules (design §"Failure semantics"):
 * - Success: mark the child ``succeeded``. Any ``blocked`` child whose
 *   predecessors are ALL succeeded (case 2: diamond needs all, not any)
 *   becomes ``toRelease``.
 * - Failure/cancel/timeout, or COMPLETED-with-failed-build (case 1):
 *   mark the child ``failed``, and transitively mark every dependent
 *   (direct + indirect) ``skipped`` — they can never start because a
 *   predecessor will never succeed.
 */
export function computeReconcilePlan(
  outcome: TerminalOutcome,
  children: readonly ReconcileChild[],
): ReconcilePlan {
  const succeeded = isSuccess(outcome);

  // Working copy of statuses so we can reason about "all predecessors
  // succeeded" against the post-update world.
  const statusOf = new Map<string, ChildStatus>(
    children.map((c) => [c.sub_issue_id, c.child_status]),
  );

  const updates: StatusUpdate[] = [];
  const setStatus = (id: string, s: ChildStatus): void => {
    statusOf.set(id, s);
    updates.push({ sub_issue_id: id, child_status: s });
  };

  // 1. The terminal child itself.
  setStatus(outcome.sub_issue_id, succeeded ? 'succeeded' : 'failed');

  const toRelease: string[] = [];

  if (succeeded) {
    // 2. Release any blocked child whose predecessors are ALL succeeded.
    for (const c of children) {
      if (statusOf.get(c.sub_issue_id) !== 'blocked') continue;
      const allSucceeded = c.depends_on.every((dep) => statusOf.get(dep) === 'succeeded');
      if (allSucceeded) {
        toRelease.push(c.sub_issue_id);
        // Mark released so a sibling finishing in the same batch doesn't
        // double-release it.
        setStatus(c.sub_issue_id, 'released');
      }
    }
  } else {
    // 3. Transitively skip every dependent of the failed child.
    //    BFS over the reverse-dependency graph.
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
        // Only skip children that haven't already started/finished.
        // A child already ``released``/``succeeded``/``failed`` is left
        // as-is (its own terminal event reconciles it).
        if (cur_status === 'blocked' || cur_status === 'ready') {
          setStatus(dependentId, 'skipped');
          skipped.add(dependentId);
        }
        queue.push(dependentId);
      }
    }
  }

  // 4. Is the whole orchestration now terminal? Every child either was
  //    already terminal or just transitioned to one. ``released`` is NOT
  //    terminal (the released child's own task is still running).
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
 * #247 #75 — RECOVERY cascade. A human fixed a previously-FAILED sub-issue via a
 * comment (``@bgagent …``), its iteration task just succeeded. The forward
 * cascade ({@link computeReconcilePlan}) only handles a child reaching terminal
 * for the FIRST time; it has no path to *un-fail* a child and re-release the
 * dependents that were transitively ``skipped`` when it first failed. This
 * computes that recovery:
 *
 *   1. Flip the recovered node ``failed`` → ``succeeded``.
 *   2. Walk its (formerly-skipped) descendants. Any ``skipped`` child whose
 *      predecessors are now ALL ``succeeded`` becomes releasable (``ready``).
 *      A descendant with another still-failed/-skipped predecessor stays
 *      ``skipped`` — recovery is gated the same way the original release was.
 *   3. Releasing a child can in turn unblock ITS descendants, so this iterates
 *      to a fixed point (a chain A→B→C recovered at A re-releases B, then B's
 *      success later re-releases C via the normal forward cascade — but a
 *      diamond where the fixed node feeds multiple skipped leaves re-releases
 *      all whose predecessors are satisfied here in one pass).
 *
 * Returns empty updates when the node wasn't actually ``failed`` (nothing to
 * recover — the normal cascade handles a healthy iteration) so the caller can
 * cheaply no-op. Pure (no I/O); the handler persists + releases.
 *
 * @param recoveredSubIssueId the node whose fix-iteration just succeeded.
 * @param children            current orchestration rows.
 */
export function computeRecoveryPlan(
  recoveredSubIssueId: string,
  children: readonly ReconcileChild[],
): RecoveryPlan {
  const current = children.find((c) => c.sub_issue_id === recoveredSubIssueId);
  // Only meaningful when the node is currently failed. A healthy iteration on a
  // succeeded node is the forward cascade's job, not recovery.
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

  // 1. Un-fail the recovered node.
  setStatus(recoveredSubIssueId, 'succeeded');

  // 2. Reset EVERY transitively-skipped descendant of the recovered node back to
  //    'blocked' — the normal waiting state the forward cascade understands.
  //    This is the key fix: once a node is 'skipped' the forward cascade
  //    (computeReconcilePlan) never releases it (it only releases 'blocked'
  //    nodes), so a deeper node like the integration node would strand skipped
  //    forever even after its predecessors recover. Putting the whole subtree
  //    back to 'blocked' lets each layer release normally as predecessors
  //    succeed: the immediately-ready layer here, deeper layers via the forward
  //    cascade when their tasks land. BFS over the reverse-dependency graph.
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

  // 3. Release any now-'blocked' node whose predecessors are ALL succeeded
  //    (the immediate layer behind the recovered node). Deeper nodes stay
  //    'blocked' and release via the forward cascade as their tasks complete.
  //    A node with ANOTHER still-failed/-skipped predecessor stays 'blocked'
  //    (correctly waiting for that one's own recovery) — gated exactly like the
  //    original release.
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
  /** Count of nodes that were failed before this retry (for the honest reply copy). */
  readonly failedCount: number;
  /** Count of nodes that were skipped before this retry. */
  readonly skippedCount: number;
  /** Count of nodes left untouched because they already succeeded. */
  readonly succeededCount: number;
}

/**
 * ABCA-659 — RETRY the whole epic. A human re-applied the trigger label (or
 * re-triggered) on a parent whose orchestration is already TERMINAL: some
 * children ``failed`` (and their dependents transitively ``skipped``). The
 * seed/extend paths don't re-run terminal children — the seed path only releases
 * on first-seed, extend only releases genuinely-NEW nodes — so a bare re-trigger
 * of a finished-with-failures epic previously re-ran nothing while the note
 * claimed it was "running the existing sub-issue graph" (the misleading copy the
 * user hit). This makes a re-trigger a real "retry the failed parts":
 *
 *   1. Every ``failed`` node → ``ready`` if all its predecessors are ``succeeded``,
 *      else ``blocked`` (its own failed/skipped predecessor is being retried too,
 *      and the forward cascade releases it once that predecessor re-succeeds).
 *   2. Every ``skipped`` node → ``blocked`` (it never ran; put it back in the
 *      waiting state the forward cascade understands, exactly like recovery).
 *   3. ``succeeded`` nodes are LEFT ALONE — we never re-run work that landed.
 *   4. Release every now-``ready`` node whose predecessors are ALL ``succeeded``
 *      (the immediate layer); deeper layers release via the forward cascade as
 *      their retried predecessors re-succeed.
 *
 * Returns an all-zero-count / empty plan when NOTHING is failed or skipped (a
 * healthy or still-running epic) so the caller can distinguish "retried N" from
 * "nothing to retry" and post honest copy. Pure (no I/O); the handler persists +
 * releases + resets the reconcile-complete marker. Mirrors {@link computeRecoveryPlan}
 * but keyed on the whole graph rather than one recovered node.
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

  // Nothing to retry — no failed/skipped nodes. Empty plan; the caller reports
  // honestly (already running, or already all-succeeded) instead of re-releasing.
  if (failedCount === 0 && skippedCount === 0) {
    return { statusUpdates: [], toRelease: [], failedCount, skippedCount, succeededCount };
  }

  const updates: StatusUpdate[] = [];
  const setStatus = (id: string, s: ChildStatus): void => {
    statusOf.set(id, s);
    updates.push({ sub_issue_id: id, child_status: s });
  };

  // 1 + 2. Reset failed → ready/blocked (by whether preds are already succeeded)
  //        and skipped → blocked. We compute failed→ready against the CURRENT
  //        (pre-reset) statuses first so a failed node whose preds all succeeded
  //        goes straight to ready; a failed node behind another failed/skipped
  //        node goes blocked and waits for the forward cascade.
  for (const c of children) {
    if (c.child_status === 'failed') {
      const allDepsSucceeded = c.depends_on.every((dep) => statusOf.get(dep) === 'succeeded');
      setStatus(c.sub_issue_id, allDepsSucceeded ? 'ready' : 'blocked');
    } else if (c.child_status === 'skipped') {
      setStatus(c.sub_issue_id, 'blocked');
    }
  }

  // 3. succeeded/released nodes are untouched (never re-run landed work).

  // 4. Release every now-ready node whose predecessors are ALL succeeded.
  const toRelease: string[] = [];
  for (const c of children) {
    if (statusOf.get(c.sub_issue_id) !== 'ready') continue;
    const allSucceeded = c.depends_on.every((dep) => statusOf.get(dep) === 'succeeded');
    if (allSucceeded) toRelease.push(c.sub_issue_id);
  }

  return { statusUpdates: updates, toRelease, failedCount, skippedCount, succeededCount };
}
