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
 * A6 re-stack planning (#305) — pure logic.
 *
 * When a predecessor sub-issue's PR branch changes after a dependent already
 * merged it in, the dependent is STALE. This module computes WHICH dependents
 * must be re-stacked and IN WHAT ORDER, given an orchestration snapshot and
 * the sub-issue whose branch changed. No I/O — the handler does the GitHub /
 * DynamoDB / task-creation side effects using this plan.
 *
 * Rules:
 *  - Re-stack only the changed node's TRANSITIVE dependents (everything
 *    downstream that built on it, directly or indirectly).
 *  - A dependent is re-stackable only if it has actually started — it carries
 *    a ``child_task_id`` + ``child_branch_name`` (released). A still-``blocked``
 *    dependent will pick up the new predecessor code when it is first
 *    released (A4), so it needs no re-stack.
 *  - Order dependents in topological order (a dependent is re-stacked only
 *    after the predecessors it merges have been re-stacked), so each re-stack
 *    merges already-current predecessor branches.
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
 * Compute the ordered re-stack plan for ``changedSubIssueId``.
 *
 * @param children the orchestration's child rows (full snapshot, excl. meta)
 * @param changedSubIssueId the sub-issue whose PR branch changed
 * @returns dependents to re-stack, in topological order; empty if none
 *   (the changed node has no started dependents, or isn't in the graph).
 */
export function planRestack(
  children: readonly OrchestrationChildRow[],
  changedSubIssueId: string,
): readonly RestackStep[] {
  const byId = new Map(children.map((c) => [c.sub_issue_id, c]));
  if (!byId.has(changedSubIssueId)) return [];

  // ── 1. Transitive dependents of the changed node (BFS down the DAG). ──
  // successorsOf[x] = nodes that depend ON x.
  const successors = new Map<string, string[]>();
  for (const c of children) {
    for (const dep of c.depends_on) {
      (successors.get(dep) ?? successors.set(dep, []).get(dep)!).push(c.sub_issue_id);
    }
  }
  const affected = new Set<string>();
  const queue = [...(successors.get(changedSubIssueId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (affected.has(id)) continue;
    affected.add(id);
    for (const next of successors.get(id) ?? []) queue.push(next);
  }

  // ── 2. Keep only dependents that have STARTED (have a branch to re-stack).
  // A blocked dependent will see the new code when it is first released.
  const restackable = [...affected]
    .map((id) => byId.get(id)!)
    .filter((c) => c.child_branch_name && RELEASED_OR_TERMINAL.has(c.child_status));

  // ── 3. Topological order over the affected sub-graph, so a dependent is
  // re-stacked after the predecessors it will merge. Kahn over edges among
  // the restackable set (+ the changed node as the always-ready source).
  const inScope = new Set(restackable.map((c) => c.sub_issue_id));
  const ordered = topoOrder(restackable, inScope);

  // ── 4. For each, the branches to merge = its predecessors' current head
  // branches that are in scope (the changed node + affected predecessors).
  // The changed node's own branch is included so direct dependents re-merge it.
  return ordered.map((child) => {
    const mergeBranches = child.depends_on
      .filter((dep) => dep === changedSubIssueId || inScope.has(dep))
      .map((dep) => byId.get(dep)?.child_branch_name)
      .filter((b): b is string => Boolean(b));
    return { child, mergeBranches };
  }).filter((step) => step.mergeBranches.length > 0);
}

/** Kahn's algorithm over the in-scope sub-graph (deterministic by id). */
function topoOrder(
  nodes: readonly OrchestrationChildRow[],
  inScope: ReadonlySet<string>,
): readonly OrchestrationChildRow[] {
  const byId = new Map(nodes.map((c) => [c.sub_issue_id, c]));
  const indeg = new Map<string, number>();
  for (const c of nodes) {
    indeg.set(c.sub_issue_id, c.depends_on.filter((d) => inScope.has(d)).length);
  }
  const ready = nodes
    .filter((c) => (indeg.get(c.sub_issue_id) ?? 0) === 0)
    .map((c) => c.sub_issue_id)
    .sort();
  const out: OrchestrationChildRow[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    out.push(byId.get(id)!);
    // decrement successors within scope
    for (const c of nodes) {
      if (c.depends_on.includes(id)) {
        const d = (indeg.get(c.sub_issue_id) ?? 0) - 1;
        indeg.set(c.sub_issue_id, d);
        if (d === 0) {
          ready.push(c.sub_issue_id);
          ready.sort();
        }
      }
    }
  }
  return out;
}
