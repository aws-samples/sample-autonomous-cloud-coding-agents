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
 * Pure "epic tip" selection — where a NEWLY-ADDED sub-issue with NO declared
 * dependency should stack.
 *
 * The rule: a node added to an in-flight epic must NOT branch off bare
 * ``main`` — it inherits the epic's accumulated,
 * unmerged work by stacking on the epic's TIP (the most-recent leaf the rest
 * of the graph already builds on). "Fall back to ``main`` only when the
 * predecessor is genuinely merged (branch gone)" is handled downstream by the
 * agent's runtime base-branch fetch fallback (``agent/src/repo.py`` — a base
 * branch that no longer exists on origin degrades to a branch off default),
 * so this layer only needs to NAME the tip; it never has to detect merge.
 *
 * The tip is the **leaf frontier**: the nodes that nothing else depends on,
 * among the nodes that can be built on (neither failed nor skipped). This
 * keeps the common "epic was a chain, add one more step" case a clean linear
 * stack; a fan-out epic with multiple independent leaves yields a
 * multi-predecessor (diamond) implicit dependency so the new node sees ALL of
 * the accumulated work.
 */

/** Minimal shape needed to compute the tip — a subset of OrchestrationChildRow. */
export interface TipCandidate {
  readonly sub_issue_id: string;
  readonly depends_on: readonly string[];
  readonly child_status: string;
}

/**
 * Resolve the implicit predecessor set for a new unconstrained node added to
 * an existing epic. Returns the sub_issue_ids the new node should stack on /
 * merge in (its synthetic ``depends_on``), or ``[]`` when the epic has no
 * usable tip (e.g. empty epic — degrade to root/main).
 *
 * Algorithm:
 *  1. Consider only the EXISTING nodes (the new node isn't in the graph yet),
 *     and of those only the ones that have not ``failed`` or been ``skipped``:
 *     a node that depends on one of these never runs, it is skipped in turn.
 *  2. The leaf frontier = nodes that appear in no other node's ``depends_on``.
 *     An INTEGRATION node depends on every leaf it was made for, so it is the
 *     single combined tip (no redundant diamond that re-merges what it already
 *     merged) — unless a sub-issue was added beside it since, which is then a
 *     leaf too.
 *  3. Return every leaf. One leaf → a clean linear stack; many leaves → a
 *     diamond so the new node inherits all parallel branches.
 *
 * Pure + deterministic (ties broken by sub_issue_id); no I/O.
 */
export function resolveEpicTip(existing: readonly TipCandidate[]): string[] {
  // Not failed or skipped, and not waiting behind such a node: the sweep skips those next.
  const dead = new Set(existing
    .filter((n) => n.child_status === 'failed' || n.child_status === 'skipped')
    .map((n) => n.sub_issue_id));
  for (let grew = true; grew;) {
    grew = false;
    for (const n of existing) {
      const waits = n.child_status === 'blocked' || n.child_status === 'ready';
      if (waits && !dead.has(n.sub_issue_id) && n.depends_on.some((d) => dead.has(d))) {
        dead.add(n.sub_issue_id);
        grew = true;
      }
    }
  }
  const alive = existing.filter((n) => !dead.has(n.sub_issue_id));

  // A node is depended-upon if it appears in the depends_on of another of these.
  const dependedUpon = new Set<string>();
  for (const node of alive) {
    for (const dep of node.depends_on) dependedUpon.add(dep);
  }

  // One leaf → linear stack; many → diamond; none (an empty epic, or nothing
  // left to build on) → root. Sorted for deterministic depends_on ordering.
  return alive
    .filter((n) => !dependedUpon.has(n.sub_issue_id))
    .map((n) => n.sub_issue_id)
    .sort();
}
