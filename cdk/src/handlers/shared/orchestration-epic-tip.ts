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
 * Pure "epic tip" selection for #247 UX.4 — where a NEWLY-ADDED sub-issue with
 * NO declared dependency should stack.
 *
 * The user's rule (confirmed 2026-06-16): a node added to an in-flight epic
 * must NOT branch off bare ``main`` — it inherits the epic's accumulated,
 * unmerged work by stacking on the epic's TIP (the most-recent leaf the rest
 * of the graph already builds on). "Fall back to ``main`` only when the
 * predecessor is genuinely merged (branch gone)" is handled downstream by the
 * agent's runtime base-branch fetch fallback (``agent/src/repo.py`` — a base
 * branch that no longer exists on origin degrades to a branch off default),
 * so this layer only needs to NAME the tip; it never has to detect merge.
 *
 * The tip is the **leaf frontier**: nodes that nothing else depends on. Among
 * those, we pick the most-recently-created real (non-integration) leaf — the
 * single node a linear chain naturally extends from. This keeps the common
 * "epic was a chain, add one more step" case a clean linear stack; a fan-out
 * epic with multiple independent leaves yields a multi-predecessor (diamond)
 * implicit dependency so the new node sees ALL of the accumulated work.
 */

import { isIntegrationNode } from './orchestration-integration-node';

/** Minimal shape needed to compute the tip — a subset of OrchestrationChildRow. */
export interface TipCandidate {
  readonly sub_issue_id: string;
  readonly depends_on: readonly string[];
  readonly created_at: string;
}

/**
 * Resolve the implicit predecessor set for a new unconstrained node added to
 * an existing epic. Returns the sub_issue_ids the new node should stack on /
 * merge in (its synthetic ``depends_on``), or ``[]`` when the epic has no
 * usable tip (e.g. empty epic — degrade to root/main).
 *
 * Algorithm:
 *  1. Consider only the EXISTING nodes (the new node isn't in the graph yet).
 *  2. The leaf frontier = nodes that appear in no other node's ``depends_on``.
 *  3. If an INTEGRATION node exists, it already depends on every real leaf —
 *     it IS the single combined tip, so stack on it alone (avoids a redundant
 *     diamond that re-merges what integration already merged).
 *  4. Otherwise return every real leaf. One leaf → a clean linear stack; many
 *     leaves → a diamond so the new node inherits all parallel branches.
 *
 * Pure + deterministic (ties broken by sub_issue_id); no I/O.
 */
export function resolveEpicTip(existing: readonly TipCandidate[]): string[] {
  if (existing.length === 0) return [];

  // A node is depended-upon if it appears in any other node's depends_on.
  const dependedUpon = new Set<string>();
  for (const node of existing) {
    for (const dep of node.depends_on) dependedUpon.add(dep);
  }

  const leaves = existing.filter((n) => !dependedUpon.has(n.sub_issue_id));
  if (leaves.length === 0) {
    // Pathological (every node depended upon ⇒ a cycle, which the DAG
    // validator rejects upstream). Degrade to root rather than throw.
    return [];
  }

  // An integration node already merges all real leaves — it is the combined
  // tip. Stack on it alone.
  const integration = leaves.find((n) => isIntegrationNode(n.sub_issue_id));
  if (integration) return [integration.sub_issue_id];

  // Real leaves only (defensive — integration handled above). One → linear
  // stack; many → diamond. Sorted for deterministic depends_on ordering.
  return leaves
    .filter((n) => !isIntegrationNode(n.sub_issue_id))
    .map((n) => n.sub_issue_id)
    .sort();
}
