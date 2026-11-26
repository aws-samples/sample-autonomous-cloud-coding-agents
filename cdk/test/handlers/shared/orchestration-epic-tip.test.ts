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

const node = (id: string, depends_on: string[] = [], child_status = 'succeeded'): TipCandidate =>
  ({ sub_issue_id: id, depends_on, child_status });

describe('resolveEpicTip — where a new node with no declared dependency stacks', () => {
  test('empty epic → no tip (degrade to a root node off the default branch)', () => {
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
    const epic = [node('R'), node('B', ['R']), node('C', ['R'])];
    expect(resolveEpicTip(epic)).toEqual(['B', 'C']);
  });

  test('integration node present → it IS the combined tip (stack on it alone, no redundant diamond)', () => {
    const epic = [
      node('A'),
      node('B'),
      node('orch_x__integration', ['A', 'B']),
    ];
    expect(resolveEpicTip(epic)).toEqual(['orch_x__integration']);
  });

  test('a leaf beside the integration node → both, so the new node builds on all of the work', () => {
    const epic = [node('A'), node('B'), node('orch_x__integration', ['A', 'B']), node('C', ['B'])];
    expect(resolveEpicTip(epic)).toEqual(['C', 'orch_x__integration']);
  });

  test('multiple roots, one chain → only the genuine leaf is the tip', () => {
    const epic = [node('A'), node('B', ['A']), node('D')];
    expect(resolveEpicTip(epic)).toEqual(['B', 'D']);
  });

  test('deterministic ordering regardless of input order', () => {
    const epic = [node('C', ['R']), node('R'), node('B', ['R'])];
    expect(resolveEpicTip(epic)).toEqual(['B', 'C']);
  });

  describe('a failed or skipped node is no tip', () => {
    test('one of two leaves failed, the integration node was skipped → tip is the leaf that succeeded', () => {
      const epic = [
        node('A', [], 'failed'),
        node('B', [], 'succeeded'),
        node('orch_x__integration', ['A', 'B'], 'skipped'),
      ];
      expect(resolveEpicTip(epic)).toEqual(['B']);
    });

    test('chain broken in the middle → tip is the last step in front of the failure', () => {
      const epic = [node('A', [], 'succeeded'), node('B', ['A'], 'failed'), node('C', ['B'], 'skipped')];
      expect(resolveEpicTip(epic)).toEqual(['A']);
    });

    test('integration node itself failed → tip is the leaves it could not combine', () => {
      const epic = [node('A'), node('B'), node('orch_x__integration', ['A', 'B'], 'failed')];
      expect(resolveEpicTip(epic)).toEqual(['A', 'B']);
    });

    test('nothing but failed and skipped nodes → no tip (a root node off the default branch)', () => {
      expect(resolveEpicTip([node('A', [], 'failed'), node('B', ['A'], 'skipped')])).toEqual([]);
    });

    test('a node that waits or runs is still the tip', () => {
      const epic = [node('A', [], 'released'), node('B', ['A'], 'blocked')];
      expect(resolveEpicTip(epic)).toEqual(['B']);
    });

    test('a node that waits behind a failed one is no tip: A failed, B blocked on A, no tip', () => {
      expect(resolveEpicTip([node('A', [], 'failed'), node('B', ['A'], 'blocked')])).toEqual([]);
    });

    test('an integration node that waits behind a failed leaf is no tip: the leaves that succeeded are', () => {
      const epic = [
        node('A'),
        node('B'),
        node('X', [], 'failed'),
        node('orch_x__integration', ['A', 'B', 'X'], 'blocked'),
      ];
      expect(resolveEpicTip(epic)).toEqual(['A', 'B']);
    });
  });
});
