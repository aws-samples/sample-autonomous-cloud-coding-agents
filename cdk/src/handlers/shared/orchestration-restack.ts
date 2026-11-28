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
 * Re-stack planning — pure logic.
 *
 * When a predecessor sub-issue's PR branch changes after a dependent already
 * merged it in, the dependent is STALE. This module computes WHICH dependents
 * must be re-stacked and IN WHAT ORDER, given an orchestration snapshot and
 * the sub-issue whose branch changed. No I/O — the handler does the GitHub /
 * DynamoDB / task-creation side effects using this plan.
 *
 * Rules:
 *  - Re-stack only the changed node's DIRECT dependents (the nodes that
 *    depend on it in one hop).
 *  - A dependent is re-stackable only if it has actually started — it carries
 *    a ``child_task_id`` + ``child_branch_name`` (released). A still-``blocked``
 *    dependent will pick up the new predecessor code when it is first
 *    released, so it needs no re-stack.
 *  - One hop per completion: a node further downstream is re-stacked when the
 *    re-stack of one of its own predecessors completes, so only after that
 *    predecessor's branch carries the change.
 *  - The changed node itself is NOT re-stacked (its own branch is what changed).
 */

import type { OrchestrationChildRow } from './orchestration-store';

/** A single dependent to re-stack, with the predecessor branches to merge in. */
export interface RestackStep {
  /** The dependent sub-issue row to re-stack. */
  readonly child: OrchestrationChildRow;
  /**
   * The branches to merge into the dependent's branch — its predecessors'
   * CURRENT head branches (the changed node's branch + any sibling
   * predecessor branches the dependent also depends on). The agent merges
   * these into the existing dependent branch.
   */
  readonly mergeBranches: readonly string[];
}

const RELEASED_OR_TERMINAL: ReadonlySet<string> = new Set([
  'released', 'succeeded', 'failed', 'skipped',
]);

/**
 * Plan the re-stack of a changed node's DIRECT (one-hop) started dependents.
 *
 * Used by the reconciler-driven cascade: when an
 * iteration/restack task on node X completes, we re-stack only the children
 * that depend DIRECTLY on X — each of those, when ITS restack task completes,
 * re-fires the reconciler and cascades to ITS dependents. Doing one hop per
 * completion (rather than the whole transitive set at once) is
 * what keeps a chain correct: C must re-stack only AFTER B's branch carries
 * the new code, not racing B's restack task.
 *
 * A direct dependent is re-stackable only if it has STARTED (released/terminal
 * with a branch). Its merge-list is its predecessors' current head branches —
 * the changed node + any sibling predecessors that have a branch — so a
 * diamond fan-in re-merges every arm it depends on.
 *
 * @param children full orchestration child snapshot (excl. meta)
 * @param changedSubIssueId the node whose branch just changed
 * @returns the direct dependents to re-stack now (deterministic by id); empty
 *   if none have started.
 */
export function planDirectRestack(
  children: readonly OrchestrationChildRow[],
  changedSubIssueId: string,
): readonly RestackStep[] {
  const byId = new Map(children.map((c) => [c.sub_issue_id, c]));
  if (!byId.has(changedSubIssueId)) return [];

  const directDependents = children
    .filter((c) => c.depends_on.includes(changedSubIssueId))
    .filter((c) => c.child_branch_name && RELEASED_OR_TERMINAL.has(c.child_status))
    .sort((a, b) => a.sub_issue_id.localeCompare(b.sub_issue_id));

  return directDependents
    .map((child) => {
      // Merge every predecessor that currently has a branch — the changed
      // node plus any sibling predecessors (so a diamond fan-in re-merges all
      // arms, not just the one that changed).
      const mergeBranches = child.depends_on
        .map((dep) => byId.get(dep)?.child_branch_name)
        .filter((b): b is string => Boolean(b));
      return { child, mergeBranches };
    })
    .filter((step) => step.mergeBranches.length > 0);
}
