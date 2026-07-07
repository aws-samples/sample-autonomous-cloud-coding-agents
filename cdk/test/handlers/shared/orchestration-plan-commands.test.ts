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

import type { PlannedSubIssue } from '../../../src/handlers/shared/orchestration-decomposition-types';
import {
  applyPlanCommand,
  parsePlanCommand,
} from '../../../src/handlers/shared/orchestration-plan-commands';

/** Build a plan of N nodes with the given per-node depends_on (0-based indices). */
function plan(deps: number[][]): PlannedSubIssue[] {
  return deps.map((d, i) => ({
    title: `Node ${i + 1}`,
    description: `scope ${i + 1}`,
    size: 'M' as const,
    max_budget_usd: 3,
    depends_on: d,
  }));
}

describe('parsePlanCommand', () => {
  test('drop: verb + indices (bare, #-prefixed, ordinal), 1-based → 0-based', () => {
    expect(parsePlanCommand('drop 3')).toEqual({ kind: 'drop', indices: [2] });
    expect(parsePlanCommand('remove #2 and #4')).toEqual({ kind: 'drop', indices: [1, 3] });
    expect(parsePlanCommand('delete 2, 3')).toEqual({ kind: 'drop', indices: [1, 2] });
    expect(parsePlanCommand('drop the 1st')).toEqual({ kind: 'drop', indices: [0] });
  });

  test('merge: verb + ≥2 indices', () => {
    expect(parsePlanCommand('merge 1 and 2')).toEqual({ kind: 'merge', indices: [0, 1] });
    expect(parsePlanCommand('combine #2, #3')).toEqual({ kind: 'merge', indices: [1, 2] });
    expect(parsePlanCommand('merge 1 3 5')).toEqual({ kind: 'merge', indices: [0, 2, 4] });
  });

  test('size: verb + one index + size token', () => {
    expect(parsePlanCommand('make #2 small')).toEqual({ kind: 'size', index: 1, size: 'S' });
    expect(parsePlanCommand('size 3 L')).toEqual({ kind: 'size', index: 2, size: 'L' });
    expect(parsePlanCommand('set 1 to medium')).toEqual({ kind: 'size', index: 0, size: 'M' });
    expect(parsePlanCommand('resize #4 large')).toEqual({ kind: 'size', index: 3, size: 'L' });
  });

  test('NOT a command → null (falls through to the semantic revise loop)', () => {
    // The T1 revise phrase must NOT be captured as a command (no size token).
    expect(parsePlanCommand('make it 2 tasks')).toBeNull();
    expect(parsePlanCommand('no, just 2 tasks')).toBeNull();
    expect(parsePlanCommand('split the API into read and write')).toBeNull();
    expect(parsePlanCommand('drop the last one')).toBeNull(); // no numeric index
    expect(parsePlanCommand('merge them all')).toBeNull(); // no numeric index → vague
    expect(parsePlanCommand('make it simpler')).toBeNull(); // size verb, no (index,size)
    expect(parsePlanCommand('approve')).toBeNull();
    expect(parsePlanCommand('')).toBeNull();
  });

  test('ABCA-598: explicit-but-invalid merge is a COMMAND (apply rejects it), NOT a silent re-plan', () => {
    // Regression: "merge 1 1" / "merge 2" have a merge verb + a concrete index, so
    // they're an explicit structural intent. They must return a merge command (which
    // applyPlanCommand then rejects, leaving the plan untouched) — NOT null, which
    // used to fall through to the semantic re-plan and fabricate a "merge the first
    // two" edit that silently rewrote the plan.
    expect(parsePlanCommand('merge 1 1')).toEqual({ kind: 'merge', indices: [0] });
    expect(parsePlanCommand('merge 2')).toEqual({ kind: 'merge', indices: [1] });
    // and applyPlanCommand rejects the self-merge with a clear message, plan intact:
    const nodes = plan([[], [0], [1]]); // 3-node chain
    const r = applyPlanCommand(nodes, { kind: 'merge', indices: [0] });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/two distinct/i);
  });

  test('dedupe repeated indices', () => {
    expect(parsePlanCommand('drop 2 2 2')).toEqual({ kind: 'drop', indices: [1] });
  });
});

describe('applyPlanCommand — drop with edge re-indexing', () => {
  test('drop a middle node re-indexes surviving edges', () => {
    // 4 nodes: n0 root, n1←n0, n2←n1, n3←n2 (a chain). Drop n1 (index 1).
    const nodes = plan([[], [0], [1], [2]]);
    const r = applyPlanCommand(nodes, { kind: 'drop', indices: [1] });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.nodes).toHaveLength(3);
    // Surviving: old n0→new0, old n2→new1, old n3→new2.
    // old n2 depended on n1 (dropped) → edge removed → new1 has no deps.
    // old n3 depended on n2 → remapped to new1.
    expect(r.nodes[0].depends_on).toEqual([]); // was n0
    expect(r.nodes[1].depends_on).toEqual([]); // was n2, dep on dropped n1 removed
    expect(r.nodes[2].depends_on).toEqual([1]); // was n3, dep n2→new1
    expect(r.nodes.map((n) => n.title)).toEqual(['Node 1', 'Node 3', 'Node 4']);
  });

  test('drop multiple nodes at once', () => {
    // 5 nodes; drop 2 and 4 (indices 1,3). n4 depended on n3(dropped)+n0.
    const nodes = plan([[], [0], [0], [2], [3, 0]]);
    const r = applyPlanCommand(nodes, { kind: 'drop', indices: [1, 3] });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    // survivors old→new: 0→0, 2→1, 4→2.
    expect(r.nodes).toHaveLength(3);
    expect(r.nodes[0].depends_on).toEqual([]); // n0
    expect(r.nodes[1].depends_on).toEqual([0]); // n2←n0
    expect(r.nodes[2].depends_on).toEqual([0]); // n4←(n3 dropped, n0→0)
  });

  test('drop that would leave <2 nodes → collapses (plan untouched by caller)', () => {
    const nodes = plan([[], [0]]);
    const r = applyPlanCommand(nodes, { kind: 'drop', indices: [1] });
    expect(r).toEqual({ kind: 'collapses', remaining: 1 });
  });

  test('drop out-of-range index → error', () => {
    const nodes = plan([[], [0], [1]]);
    const r = applyPlanCommand(nodes, { kind: 'drop', indices: [5] });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('#6');
    expect(r.message).toContain('3');
  });
});

describe('applyPlanCommand — merge', () => {
  test('merge two nodes onto the lowest position, union edges, largest size', () => {
    // n0 root(S), n1←n0(L), n2←n1(M). Merge 2 and 3 (indices 1,2) → target index1.
    const nodes: PlannedSubIssue[] = [
      { title: 'A', description: 'a', size: 'S', max_budget_usd: 1, depends_on: [] },
      { title: 'B', description: 'b', size: 'L', max_budget_usd: 6, depends_on: [0] },
      { title: 'C', description: 'c', size: 'M', max_budget_usd: 3, depends_on: [1] },
    ];
    const r = applyPlanCommand(nodes, { kind: 'merge', indices: [1, 2] });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.nodes).toHaveLength(2);
    // merged node at new index1: union of {n0} and {n1}; n1 is a merge member →
    // self-edge dropped, leaving [n0→0]. Largest size L. Title joined.
    expect(r.nodes[1].title).toBe('B + C');
    expect(r.nodes[1].size).toBe('L');
    expect(r.nodes[1].depends_on).toEqual([0]);
  });

  test('merge dependents onto their predecessor drops the now-internal edge', () => {
    // n0←nothing, n1←n0. Merge 1 and 2 → one node, its self-edge removed.
    const nodes = plan([[], [0]]);
    const r = applyPlanCommand(nodes, { kind: 'merge', indices: [0, 1] });
    // 2 → 1 node → collapses (nothing left to orchestrate).
    expect(r).toEqual({ kind: 'collapses', remaining: 1 });
  });

  test('a downstream node pointing at a merged member is remapped to the merged slot', () => {
    // n0, n1, n2←n1, n3←n2. Merge n1+n2 (→ slot at new index1); n3 must point at it.
    const nodes = plan([[], [], [1], [2]]);
    const r = applyPlanCommand(nodes, { kind: 'merge', indices: [1, 2] });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    // old→new: 0→0, 1→1(target), 2→1(folded), 3→2.
    expect(r.nodes).toHaveLength(3);
    expect(r.nodes[2].title).toBe('Node 4');
    expect(r.nodes[2].depends_on).toEqual([1]); // n3←(n2 folded into new1)
  });
});

describe('applyPlanCommand — size', () => {
  test('size recomputes the budget ceiling', () => {
    const nodes = plan([[], [0]]);
    const r = applyPlanCommand(nodes, { kind: 'size', index: 1, size: 'S' });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.nodes[1].size).toBe('S');
    expect(r.nodes[1].max_budget_usd).toBe(1); // SIZE_DEFAULT_BUDGET_USD.S
    expect(r.nodes[0]).toEqual(nodes[0]); // others untouched
  });

  test('size out-of-range → error', () => {
    const nodes = plan([[], [0]]);
    const r = applyPlanCommand(nodes, { kind: 'size', index: 9, size: 'L' });
    expect(r.kind).toBe('error');
  });
});
