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
 * Pure dependency-graph (DAG) logic for Linear parent/sub-issue
 * orchestration (issue #247, Mode A — PR A2). No I/O: takes a set of
 * nodes with ``depends_on`` edges and either rejects the graph (cycle,
 * dangling edge) or returns a topological layering used by the
 * reconciler (A3) to release children in dependency order.
 *
 * Kept deliberately free of Linear/AWS types so it is trivially unit-
 * testable and reusable by the Mode B planner (#299), which validates
 * its own generated graph with the same cycle check before writing
 * sub-issues back to Linear.
 */

/** A single node in the dependency graph (one Linear sub-issue). */
export interface DagNode {
  /** Stable identifier — the Linear sub-issue id (the orchestration SK). */
  readonly id: string;
  /** Ids this node is blocked by; must all reach terminal-success first. */
  readonly depends_on: readonly string[];
}

/** Why a graph was rejected. Surfaced to the user as a terminal comment. */
export type DagRejectionReason = 'cycle' | 'dangling_edge' | 'duplicate_id';

export interface DagValidationOk {
  readonly ok: true;
  /**
   * Topological layers. ``layers[0]`` are roots (no predecessors);
   * every node in ``layers[n]`` depends only on nodes in
   * ``layers[<n]``. The reconciler uses layer 0 as the initial release
   * set; deeper layers are released as predecessors succeed. The flat
   * order (``layers.flat()``) is a valid topological sort.
   */
  readonly layers: readonly (readonly string[])[];
}

export interface DagValidationError {
  readonly ok: false;
  readonly reason: DagRejectionReason;
  /**
   * The node ids implicated in the rejection — the cycle members, the
   * nodes carrying dangling edges, or the duplicated ids. Sorted for
   * stable, testable output.
   */
  readonly offendingIds: readonly string[];
  /** Human-readable, user-facing explanation (used verbatim in the Linear comment). */
  readonly message: string;
}

export type DagValidationResult = DagValidationOk | DagValidationError;

/**
 * Validate a dependency graph and, on success, return its topological
 * layering.
 *
 * Rejects (fail-closed — a bad graph must never start any child):
 * - ``duplicate_id``  — two nodes share an id (ambiguous gating).
 * - ``dangling_edge`` — a ``depends_on`` points at an id not in the node set.
 * - ``cycle``         — the edges form a cycle (no valid start order exists).
 *
 * Uses Kahn's algorithm: repeatedly peel off nodes with zero remaining
 * predecessors. Each peel is one layer. If nodes remain when no node
 * has zero in-degree, those nodes form (or feed) a cycle.
 */
export function validateDag(nodes: readonly DagNode[]): DagValidationResult {
  // ── Duplicate ids ────────────────────────────────────────────────
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) duplicates.add(n.id);
    seen.add(n.id);
  }
  if (duplicates.size > 0) {
    const ids = [...duplicates].sort();
    return {
      ok: false,
      reason: 'duplicate_id',
      offendingIds: ids,
      message:
        `Duplicate sub-issue id(s) in the dependency graph: ${ids.join(', ')}. `
        + 'Each sub-issue must appear once.',
    };
  }

  // ── Dangling edges (depends_on → unknown id) ─────────────────────
  const ids = new Set(nodes.map((n) => n.id));
  const dangling = new Set<string>();
  for (const n of nodes) {
    for (const dep of n.depends_on) {
      if (!ids.has(dep)) dangling.add(n.id);
    }
  }
  if (dangling.size > 0) {
    const offending = [...dangling].sort();
    return {
      ok: false,
      reason: 'dangling_edge',
      offendingIds: offending,
      message:
        `Sub-issue(s) ${offending.join(', ')} depend on an issue that isn't part `
        + 'of this parent\'s sub-issue set. Blocking relations must stay within the epic.',
    };
  }

  // ── Kahn's algorithm: peel zero-in-degree nodes into layers ──────
  // in-degree = number of (deduplicated) predecessors still unresolved.
  const remainingDeps = new Map<string, Set<string>>();
  for (const n of nodes) {
    remainingDeps.set(n.id, new Set(n.depends_on));
  }

  // Reverse adjacency: dep -> nodes that depend on it (to decrement fast).
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    for (const dep of new Set(n.depends_on)) {
      const list = dependents.get(dep) ?? [];
      list.push(n.id);
      dependents.set(dep, list);
    }
  }

  const layers: string[][] = [];
  let frontier = nodes.filter((n) => remainingDeps.get(n.id)!.size === 0).map((n) => n.id);
  let resolvedCount = 0;

  while (frontier.length > 0) {
    // Sort each layer for deterministic, testable output.
    const layer = [...frontier].sort();
    layers.push(layer);
    resolvedCount += layer.length;

    const next: string[] = [];
    for (const resolvedId of layer) {
      for (const dependentId of dependents.get(resolvedId) ?? []) {
        const deps = remainingDeps.get(dependentId)!;
        deps.delete(resolvedId);
        if (deps.size === 0) next.push(dependentId);
      }
    }
    frontier = next;
  }

  if (resolvedCount < nodes.length) {
    // Whatever never resolved is in (or downstream of) a cycle.
    const stuck = nodes
      .filter((n) => remainingDeps.get(n.id)!.size > 0)
      .map((n) => n.id)
      .sort();
    return {
      ok: false,
      reason: 'cycle',
      offendingIds: stuck,
      message:
        'The sub-issue blocking relations form a cycle '
        + `(involving: ${stuck.join(', ')}), so there is no valid order to start them. `
        + 'Remove the circular `blocked by` relation and re-apply the trigger.',
    };
  }

  return { ok: true, layers };
}

/**
 * Convenience: the flat topological order (roots first). Only valid to
 * call on a graph ``validateDag`` accepted; throws otherwise so a caller
 * can't accidentally order a rejected graph.
 */
export function topologicalOrder(nodes: readonly DagNode[]): readonly string[] {
  const result = validateDag(nodes);
  if (!result.ok) {
    throw new Error(`Cannot order an invalid dependency graph: ${result.reason}`);
  }
  return result.layers.flat();
}
