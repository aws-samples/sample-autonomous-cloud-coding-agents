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

import { selectBaseBranch } from '../../../src/handlers/shared/orchestration-base-branch';

const pred = (sub_issue_id: string, branch_name: string) => ({ sub_issue_id, branch_name });

describe('selectBaseBranch', () => {
  test('root (no predecessors) → default branch, no merges', () => {
    expect(selectBaseBranch({ predecessors: [] })).toEqual({
      base_branch: 'main', merge_branches: [], shape: 'root',
    });
  });

  test('respects a custom default branch for roots', () => {
    expect(selectBaseBranch({ predecessors: [], defaultBranch: 'develop' }).base_branch).toBe('develop');
  });

  test('linear (1 predecessor) → stack on its branch, no merges', () => {
    const sel = selectBaseBranch({ predecessors: [pred('A', 'bgagent/taskA/step-a')] });
    expect(sel).toEqual({
      base_branch: 'bgagent/taskA/step-a', merge_branches: [], shape: 'linear',
    });
  });

  test('diamond (2 predecessors) → base main + merge both branches', () => {
    const sel = selectBaseBranch({
      predecessors: [pred('B', 'bgagent/taskB/b'), pred('C', 'bgagent/taskC/c')],
    });
    expect(sel.shape).toBe('diamond');
    expect(sel.base_branch).toBe('main');
    expect(sel.merge_branches).toEqual(['bgagent/taskB/b', 'bgagent/taskC/c']);
  });

  test('diamond merge list is deduped and sorted (deterministic)', () => {
    const sel = selectBaseBranch({
      predecessors: [pred('C', 'z-branch'), pred('B', 'a-branch'), pred('D', 'a-branch')],
    });
    expect(sel.merge_branches).toEqual(['a-branch', 'z-branch']);
  });

  test('diamond uses default branch as base, not a predecessor', () => {
    const sel = selectBaseBranch({
      predecessors: [pred('B', 'feat-b'), pred('C', 'feat-c')], defaultBranch: 'trunk',
    });
    expect(sel.base_branch).toBe('trunk');
  });

  test('predecessors missing a branch_name are ignored', () => {
    // One real predecessor branch + one empty → degrades to linear on the real one.
    const sel = selectBaseBranch({ predecessors: [pred('A', 'feat-a'), pred('B', '')] });
    expect(sel.shape).toBe('linear');
    expect(sel.base_branch).toBe('feat-a');
  });

  test('all predecessors missing branches → degrade to root (never invalid base)', () => {
    const sel = selectBaseBranch({ predecessors: [pred('A', ''), pred('B', '')] });
    expect(sel).toEqual({ base_branch: 'main', merge_branches: [], shape: 'root' });
  });

  test('two predecessors that share a branch collapse to a single (linear) merge', () => {
    // After dedup, only one distinct branch → treated as linear, not diamond.
    const sel = selectBaseBranch({ predecessors: [pred('A', 'same'), pred('B', 'same')] });
    expect(sel.shape).toBe('linear');
    expect(sel.base_branch).toBe('same');
    expect(sel.merge_branches).toEqual([]);
  });
});
