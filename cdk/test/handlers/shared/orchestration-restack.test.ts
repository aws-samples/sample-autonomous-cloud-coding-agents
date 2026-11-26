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

import { planDirectRestack } from '../../../src/handlers/shared/orchestration-restack';
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
    parent_issue_ref: 'PARENT',
    credentials_ref: 'WS',
    repo: 'o/r',
    depends_on: deps,
    child_status: (opts.status ?? (started ? 'released' : 'blocked')) as never,
    created_at: 'now',
    updated_at: 'now',
    ...(started && { child_task_id: `task-${sub}`, child_branch_name: `branch-${sub}` }),
  };
}

describe('planDirectRestack (reconciler cascade — one hop)', () => {
  test('linear chain A→B→C, A changes → re-stacks ONLY B (its direct dependent)', () => {
    // C is NOT re-stacked now — it cascades when B's restack task completes.
    const steps = planDirectRestack([row('A'), row('B', ['A']), row('C', ['B'])], 'A');
    expect(steps.map((s) => s.child.sub_issue_id)).toEqual(['B']);
    expect(steps[0].mergeBranches).toEqual(['branch-A']);
  });

  test('next hop: B changes → re-stacks ONLY C', () => {
    const steps = planDirectRestack([row('A'), row('B', ['A']), row('C', ['B'])], 'B');
    expect(steps.map((s) => s.child.sub_issue_id)).toEqual(['C']);
    expect(steps[0].mergeBranches).toEqual(['branch-B']);
  });

  test('diamond A→{B,C}→D, A changes → re-stacks B and C (both direct), NOT D', () => {
    const steps = planDirectRestack(
      [row('A'), row('B', ['A']), row('C', ['A']), row('D', ['B', 'C'])], 'A',
    );
    expect(steps.map((s) => s.child.sub_issue_id)).toEqual(['B', 'C']);
  });

  test('diamond fan-in: B changes → D re-stacks merging BOTH arms (B + C current branches)', () => {
    const steps = planDirectRestack(
      [row('A'), row('B', ['A']), row('C', ['A']), row('D', ['B', 'C'])], 'B',
    );
    expect(steps.map((s) => s.child.sub_issue_id)).toEqual(['D']);
    expect([...steps[0].mergeBranches].sort()).toEqual(['branch-B', 'branch-C']);
  });

  test('changed node itself is never in the plan', () => {
    const steps = planDirectRestack([row('A'), row('B', ['A'])], 'A');
    expect(steps.map((s) => s.child.sub_issue_id)).not.toContain('A');
  });

  test('only STARTED direct dependents are re-stacked', () => {
    const steps = planDirectRestack([row('A'), row('B', ['A'], { started: false })], 'A');
    expect(steps).toEqual([]); // B not started → gets fresh code on its first release
  });

  test('changed node with no dependents → empty', () => {
    expect(planDirectRestack([row('A'), row('B', ['A'])], 'B')).toEqual([]);
  });

  test('unknown changed node → empty', () => {
    expect(planDirectRestack([row('A')], 'nope')).toEqual([]);
  });

  test('direct dependent whose every predecessor lacks a branch is dropped', () => {
    const a = { ...row('A'), child_branch_name: undefined };
    expect(planDirectRestack([a, row('B', ['A'])], 'A')).toEqual([]);
  });

  test('does NOT recurse: grandchild is untouched even when started', () => {
    // A→B→C all started; A changes → only B (C waits for B to finish).
    const steps = planDirectRestack([row('A'), row('B', ['A']), row('C', ['B'])], 'A');
    expect(steps.map((s) => s.child.sub_issue_id)).not.toContain('C');
  });
});
