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

import { planRestack } from '../../../src/handlers/shared/orchestration-restack';
import type { OrchestrationChildRow } from '../../../src/handlers/shared/orchestration-store';

/** Build a child row. `started` → released with a branch; else blocked. */
function row(
  sub: string,
  deps: string[] = [],
  opts: { started?: boolean; status?: string } = {},
): OrchestrationChildRow {
  const started = opts.started ?? true;
  return {
    orchestration_id: 'orch_1',
    sub_issue_id: sub,
    parent_linear_issue_id: 'PARENT',
    linear_workspace_id: 'WS',
    repo: 'o/r',
    depends_on: deps,
    child_status: (opts.status ?? (started ? 'released' : 'blocked')) as never,
    created_at: 'now',
    updated_at: 'now',
    ...(started && { child_task_id: `task-${sub}`, child_branch_name: `branch-${sub}` }),
  };
}

describe('planRestack', () => {
  test('linear chain A→B→C, A changes → re-stack B then C (topo order)', () => {
    const steps = planRestack([row('A'), row('B', ['A']), row('C', ['B'])], 'A');
    expect(steps.map((s) => s.child.sub_issue_id)).toEqual(['B', 'C']);
    // B merges A's branch; C merges B's branch (both in scope).
    expect(steps[0].mergeBranches).toEqual(['branch-A']);
    expect(steps[1].mergeBranches).toEqual(['branch-B']);
  });

  test('the changed node itself is never re-stacked', () => {
    const steps = planRestack([row('A'), row('B', ['A'])], 'A');
    expect(steps.map((s) => s.child.sub_issue_id)).not.toContain('A');
  });

  test('only STARTED dependents are re-stacked; blocked ones are skipped', () => {
    // A changed; B started (released), C still blocked.
    const steps = planRestack([row('A'), row('B', ['A']), row('C', ['B'], { started: false })], 'A');
    expect(steps.map((s) => s.child.sub_issue_id)).toEqual(['B']); // C will get fresh code on its first release
  });

  test('diamond A→{B,C}→D, A changes → B, C, then D (D merges both updated preds)', () => {
    const steps = planRestack(
      [row('A'), row('B', ['A']), row('C', ['A']), row('D', ['B', 'C'])],
      'A',
    );
    const ids = steps.map((s) => s.child.sub_issue_id);
    expect(ids).toContain('B');
    expect(ids).toContain('C');
    expect(ids[ids.length - 1]).toBe('D'); // D is last (depends on B + C)
    const dStep = steps.find((s) => s.child.sub_issue_id === 'D')!;
    expect([...dStep.mergeBranches].sort()).toEqual(['branch-B', 'branch-C']);
  });

  test('mid-chain change A→B→C→D, C changes → only D re-stacks', () => {
    const steps = planRestack(
      [row('A'), row('B', ['A']), row('C', ['B']), row('D', ['C'])],
      'C',
    );
    expect(steps.map((s) => s.child.sub_issue_id)).toEqual(['D']);
    expect(steps[0].mergeBranches).toEqual(['branch-C']);
  });

  test('changed node with no dependents → empty plan', () => {
    expect(planRestack([row('A'), row('B', ['A'])], 'B')).toEqual([]);
  });

  test('unknown changed node → empty plan', () => {
    expect(planRestack([row('A')], 'nonexistent')).toEqual([]);
  });

  test('a re-stack with no resolvable predecessor branch is dropped', () => {
    // B depends on A, but A somehow has no branch — nothing to merge.
    const a = { ...row('A'), child_branch_name: undefined };
    const steps = planRestack([a, row('B', ['A'])], 'A');
    expect(steps).toEqual([]); // B's only predecessor (A) has no branch → no merge → dropped
  });
});
