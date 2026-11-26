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
 *  3. Return every leaf. One leaf → a clean linear stack; many leaves → a
 *     diamond so the new node inherits all parallel branches.
 *
 * Pure + deterministic (ties broken by sub_issue_id); no I/O.
 */
export function resolveEpicTip(existing: readonly TipCandidate[]): string[] {
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

  const dependedUpon = new Set<string>();
  for (const node of alive) {
    for (const dep of node.depends_on) dependedUpon.add(dep);
  }

  return alive
    .filter((n) => !dependedUpon.has(n.sub_issue_id))
    .map((n) => n.sub_issue_id)
    .sort();
}
