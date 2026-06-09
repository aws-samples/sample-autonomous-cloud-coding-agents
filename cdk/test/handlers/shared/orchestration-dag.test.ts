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

import { validateDag, topologicalOrder, type DagNode } from '../../../src/handlers/shared/orchestration-dag';

const node = (id: string, ...depends_on: string[]): DagNode => ({ id, depends_on });

describe('validateDag — valid graphs', () => {
  test('empty graph is valid with no layers', () => {
    const result = validateDag([]);
    expect(result).toEqual({ ok: true, layers: [] });
  });

  test('single root node → one layer', () => {
    const result = validateDag([node('A')]);
    expect(result).toEqual({ ok: true, layers: [['A']] });
  });

  test('independent siblings all land in layer 0', () => {
    const result = validateDag([node('A'), node('B'), node('C')]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.layers).toEqual([['A', 'B', 'C']]);
  });

  test('linear chain A→B→C produces three single-node layers', () => {
    // B depends on A, C depends on B.
    const result = validateDag([node('C', 'B'), node('B', 'A'), node('A')]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.layers).toEqual([['A'], ['B'], ['C']]);
  });

  test('diamond A→{B,C}→D layers B and C together, D last', () => {
    const result = validateDag([
      node('A'),
      node('B', 'A'),
      node('C', 'A'),
      node('D', 'B', 'C'),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.layers).toEqual([['A'], ['B', 'C'], ['D']]);
  });

  test('layers are sorted for deterministic output', () => {
    const result = validateDag([node('z'), node('a'), node('m')]);
    if (result.ok) expect(result.layers[0]).toEqual(['a', 'm', 'z']);
  });

  test('tolerates a duplicated edge to the same predecessor', () => {
    // depends_on lists A twice — should not double-count in-degree.
    const result = validateDag([node('A'), { id: 'B', depends_on: ['A', 'A'] }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.layers).toEqual([['A'], ['B']]);
  });
});

describe('validateDag — rejected graphs', () => {
  test('self-loop is a cycle', () => {
    const result = validateDag([node('A', 'A')]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cycle');
      expect(result.offendingIds).toEqual(['A']);
    }
  });

  test('two-node cycle A↔B', () => {
    const result = validateDag([node('A', 'B'), node('B', 'A')]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cycle');
      expect(result.offendingIds).toEqual(['A', 'B']);
    }
  });

  test('cycle is reported even when valid roots exist', () => {
    // R is a clean root; X→Y→Z→X is a cycle hanging off nothing.
    const result = validateDag([
      node('R'),
      node('X', 'Z'),
      node('Y', 'X'),
      node('Z', 'Y'),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cycle');
      expect(result.offendingIds).toEqual(['X', 'Y', 'Z']);
    }
  });

  test('dangling edge → depends_on points outside the node set', () => {
    const result = validateDag([node('A'), node('B', 'GHOST')]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('dangling_edge');
      expect(result.offendingIds).toEqual(['B']);
    }
  });

  test('duplicate id', () => {
    const result = validateDag([node('A'), node('A')]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('duplicate_id');
      expect(result.offendingIds).toEqual(['A']);
    }
  });

  test('duplicate-id check precedes dangling/cycle checks', () => {
    // Duplicate A plus a dangling edge — duplicate wins (checked first).
    const result = validateDag([node('A'), node('A', 'GHOST')]);
    if (!result.ok) expect(result.reason).toBe('duplicate_id');
  });

  test('rejection carries a user-facing message', () => {
    const result = validateDag([node('A', 'B'), node('B', 'A')]);
    if (!result.ok) {
      expect(result.message).toMatch(/cycle/i);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe('topologicalOrder', () => {
  test('returns a flat valid order for an accepted graph', () => {
    const order = topologicalOrder([node('C', 'B'), node('B', 'A'), node('A')]);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  test('throws on an invalid graph', () => {
    expect(() => topologicalOrder([node('A', 'B'), node('B', 'A')])).toThrow(/invalid dependency graph/i);
  });
});
