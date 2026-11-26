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

import type { OrchestrationChildRow } from './orchestration-store';

export interface RestackStep {
  readonly child: OrchestrationChildRow;
  /**
   * The branches to merge into the dependent's branch — its predecessors'
   * CURRENT head branches (the changed node's branch + any sibling
   * predecessor branches the dependent also depends on).
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

  const restackable = [...affected]
    .map((id) => byId.get(id)!)
    .filter((c) => c.child_branch_name && RELEASED_OR_TERMINAL.has(c.child_status));

  const inScope = new Set(restackable.map((c) => c.sub_issue_id));
  const ordered = topoOrder(restackable, inScope);

  return ordered.map((child) => {
    const mergeBranches = child.depends_on
      .filter((dep) => dep === changedSubIssueId || inScope.has(dep))
      .map((dep) => byId.get(dep)?.child_branch_name)
      .filter((b): b is string => Boolean(b));
    return { child, mergeBranches };
  }).filter((step) => step.mergeBranches.length > 0);
}

/**
 * Plan the re-stack of a changed node's DIRECT (one-hop) started dependents.
 *
 * A direct dependent is re-stackable only if it has STARTED (released/terminal
 * with a branch). Its merge-list is its predecessors' current head branches —
 * the changed node + any sibling predecessors that have a branch.
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
      const mergeBranches = child.depends_on
        .map((dep) => byId.get(dep)?.child_branch_name)
        .filter((b): b is string => Boolean(b));
      return { child, mergeBranches };
    })
    .filter((step) => step.mergeBranches.length > 0);
}

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
