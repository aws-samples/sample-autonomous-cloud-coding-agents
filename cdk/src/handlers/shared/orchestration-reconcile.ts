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
  const byId = new Map(children.map((c) => [c.sub_issue_id, c]));
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
