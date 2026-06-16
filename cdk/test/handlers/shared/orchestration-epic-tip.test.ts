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

import { resolveEpicTip, type TipCandidate } from '../../../src/handlers/shared/orchestration-epic-tip';

const node = (id: string, depends_on: string[] = [], created_at = '2026-01-01'): TipCandidate =>
  ({ sub_issue_id: id, depends_on, created_at });

describe('resolveEpicTip (#247 UX.4 — where a new unconstrained node stacks)', () => {
  test('empty epic → no tip (degrade to root/main)', () => {
    expect(resolveEpicTip([])).toEqual([]);
  });

  test('linear chain A→B→C → tip is the single leaf C', () => {
    const epic = [node('A'), node('B', ['A']), node('C', ['B'])];
    expect(resolveEpicTip(epic)).toEqual(['C']);
  });

  test('single node epic → that node is the tip', () => {
    expect(resolveEpicTip([node('A')])).toEqual(['A']);
  });

  test('fan-out (two independent leaves) → diamond: both leaves, sorted', () => {
    // root R; B and C both depend on R, nothing depends on B or C.
    const epic = [node('R'), node('B', ['R']), node('C', ['R'])];
    expect(resolveEpicTip(epic)).toEqual(['B', 'C']);
  });

  test('integration node present → it IS the combined tip (stack on it alone, no redundant diamond)', () => {
    // A and B are leaves; the integration node depends on both, so it is the
    // single most-downstream node. A new node stacks on integration only.
    const epic = [
      node('A'),
      node('B'),
      node('orch_x__integration', ['A', 'B']),
    ];
    expect(resolveEpicTip(epic)).toEqual(['orch_x__integration']);
  });

  test('multiple roots, one chain → only the genuine leaf is the tip', () => {
    // A→B (B is a leaf); D is a standalone leaf. Two leaves → diamond.
    const epic = [node('A'), node('B', ['A']), node('D')];
    expect(resolveEpicTip(epic)).toEqual(['B', 'D']);
  });

  test('deterministic ordering regardless of input order', () => {
    const epic = [node('C', ['R']), node('R'), node('B', ['R'])];
    expect(resolveEpicTip(epic)).toEqual(['B', 'C']);
  });
});
