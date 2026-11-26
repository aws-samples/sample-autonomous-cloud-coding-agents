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

import {
  computeEpicRetryPlan,
  computeReconcilePlan,
  computeRecoveryPlan,
  type ReconcileChild,
  type TerminalOutcome,
} from '../../../src/handlers/shared/orchestration-reconcile';
import type { ChildStatus } from '../../../src/handlers/shared/orchestration-store';

const row = (
  sub_issue_id: string,
  child_status: ChildStatus,
  depends_on: readonly string[] = [],
): ReconcileChild => ({ sub_issue_id, depends_on, child_status });

function updatesById(plan: ReturnType<typeof computeReconcilePlan>): Record<string, ChildStatus> {
  return Object.fromEntries(plan.statusUpdates.map((u) => [u.sub_issue_id, u.child_status]));
}

describe('computeReconcilePlan — success releases dependents', () => {
  test('A succeeds → releases its blocked dependent B', () => {
    const children = [row('A', 'released'), row('B', 'blocked', ['A'])];
    const outcome: TerminalOutcome = { sub_issue_id: 'A', status: 'COMPLETED' };
    const plan = computeReconcilePlan(outcome, children);

    expect(plan.terminalSucceeded).toBe(true);
    expect(updatesById(plan).A).toBe('succeeded');
    expect(plan.toRelease).toEqual(['B']);
  });

  test('linear chain: A succeeds releases B but NOT C (C still blocked on B)', () => {
    const children = [
      row('A', 'released'),
      row('B', 'blocked', ['A']),
      row('C', 'blocked', ['B']),
    ];
    const plan = computeReconcilePlan({ sub_issue_id: 'A', status: 'COMPLETED' }, children);
    expect(plan.toRelease).toEqual(['B']);
  });

  test('COMPLETED with build_passed=true is a success', () => {
    const children = [row('A', 'released'), row('B', 'blocked', ['A'])];
    const plan = computeReconcilePlan({ sub_issue_id: 'A', status: 'COMPLETED', build_passed: true }, children);
    expect(plan.terminalSucceeded).toBe(true);
    expect(plan.toRelease).toEqual(['B']);
  });

  test('build_passed undefined still counts as success (legacy records)', () => {
    const children = [row('A', 'released'), row('B', 'blocked', ['A'])];
    const plan = computeReconcilePlan({ sub_issue_id: 'A', status: 'COMPLETED' }, children);
    expect(plan.terminalSucceeded).toBe(true);
  });
});

describe('computeReconcilePlan — case 1: COMPLETED but build failed', () => {
  test('build_passed=false is NOT a success; dependents are skipped', () => {
    const children = [row('A', 'released'), row('B', 'blocked', ['A'])];
    const plan = computeReconcilePlan({ sub_issue_id: 'A', status: 'COMPLETED', build_passed: false }, children);

    expect(plan.terminalSucceeded).toBe(false);
    expect(updatesById(plan).A).toBe('failed');
    expect(plan.toRelease).toEqual([]);
    expect(updatesById(plan).B).toBe('skipped');
  });
});

describe('computeReconcilePlan — case 2: diamond needs ALL predecessors', () => {
  test('D depends on B+C; B succeeds while C still running → D NOT released', () => {
    const children = [
      row('B', 'released'),
      row('C', 'released'),
      row('D', 'blocked', ['B', 'C']),
    ];
    const plan = computeReconcilePlan({ sub_issue_id: 'B', status: 'COMPLETED' }, children);
    expect(plan.toRelease).toEqual([]);
  });

  test('D released only once BOTH B and C have succeeded', () => {
    const children = [
      row('B', 'succeeded'),
      row('C', 'released'),
      row('D', 'blocked', ['B', 'C']),
    ];
    const plan = computeReconcilePlan({ sub_issue_id: 'C', status: 'COMPLETED' }, children);
    expect(plan.toRelease).toEqual(['D']);
  });

  test('diamond with a failed leg: C fails → D skipped even though B succeeded', () => {
    const children = [
      row('B', 'succeeded'),
      row('C', 'released'),
      row('D', 'blocked', ['B', 'C']),
    ];
    const plan = computeReconcilePlan({ sub_issue_id: 'C', status: 'FAILED' }, children);
    expect(updatesById(plan).C).toBe('failed');
    expect(updatesById(plan).D).toBe('skipped');
    expect(plan.toRelease).toEqual([]);
  });
});

describe('computeReconcilePlan — transitive skip + sibling isolation', () => {
  test('A fails → B (dep A) and C (dep B) both skipped; independent D untouched', () => {
    const children = [
      row('A', 'released'),
      row('B', 'blocked', ['A']),
      row('C', 'blocked', ['B']),
      row('D', 'blocked'),
    ];
    const plan = computeReconcilePlan({ sub_issue_id: 'A', status: 'FAILED' }, children);
    const u = updatesById(plan);
    expect(u.A).toBe('failed');
    expect(u.B).toBe('skipped');
    expect(u.C).toBe('skipped');
    expect(u.D).toBeUndefined();
  });

  test('CANCELLED and TIMED_OUT are failures for gating', () => {
    for (const status of ['CANCELLED', 'TIMED_OUT'] as const) {
      const children = [row('A', 'released'), row('B', 'blocked', ['A'])];
      const plan = computeReconcilePlan({ sub_issue_id: 'A', status }, children);
      expect(plan.terminalSucceeded).toBe(false);
      expect(updatesById(plan).B).toBe('skipped');
    }
  });

  test('does not skip a dependent that already started (released)', () => {
    const children = [row('A', 'released'), row('B', 'released', ['A'])];
    const plan = computeReconcilePlan({ sub_issue_id: 'A', status: 'FAILED' }, children);
    expect(updatesById(plan).B).toBeUndefined();
  });
});

describe('computeReconcilePlan — orchestrationComplete', () => {
  test('true when the last child reaches terminal', () => {
    const children = [row('A', 'succeeded'), row('B', 'released', ['A'])];
    const plan = computeReconcilePlan({ sub_issue_id: 'B', status: 'COMPLETED' }, children);
    expect(plan.orchestrationComplete).toBe(true);
  });

  test('false while a released sibling is still running', () => {
    const children = [
      row('A', 'released'),
      row('B', 'released'),
    ];
    const plan = computeReconcilePlan({ sub_issue_id: 'A', status: 'COMPLETED' }, children);
    expect(plan.orchestrationComplete).toBe(false);
  });

  test('true when a failure skips all remaining work', () => {
    const children = [row('A', 'released'), row('B', 'blocked', ['A'])];
    const plan = computeReconcilePlan({ sub_issue_id: 'A', status: 'FAILED' }, children);
    expect(plan.orchestrationComplete).toBe(true);
  });
});

function recoveryUpdatesById(
  plan: ReturnType<typeof computeRecoveryPlan>,
): Record<string, ChildStatus> {
  return Object.fromEntries(plan.statusUpdates.map((u) => [u.sub_issue_id, u.child_status]));
}

describe('computeRecoveryPlan — comment-fixing a failed child re-releases its skipped dependents', () => {
  test('BAD failed, DEP skipped → fixing BAD un-fails it + re-releases DEP', () => {
    const children = [
      row('OK', 'succeeded'),
      row('BAD', 'failed'),
      row('DEP', 'skipped', ['BAD']),
    ];
    const plan = computeRecoveryPlan('BAD', children);
    const u = recoveryUpdatesById(plan);
    expect(u.BAD).toBe('succeeded');
    expect(u.DEP).toBe('blocked');
    expect(plan.toRelease).toEqual(['DEP']);
  });

  test('no-op when the node is not currently failed (healthy iteration)', () => {
    const children = [row('A', 'succeeded'), row('B', 'released', ['A'])];
    const plan = computeRecoveryPlan('A', children);
    expect(plan.statusUpdates).toHaveLength(0);
    expect(plan.toRelease).toHaveLength(0);
  });

  test('no-op for an unknown node id', () => {
    const plan = computeRecoveryPlan('ghost', [row('A', 'failed')]);
    expect(plan.statusUpdates).toHaveLength(0);
    expect(plan.toRelease).toHaveLength(0);
  });

  test('a dependent with ANOTHER still-failed predecessor is reset to blocked but NOT released', () => {
    const children = [
      row('B', 'failed'),
      row('C', 'failed'),
      row('D', 'skipped', ['B', 'C']),
    ];
    const plan = computeRecoveryPlan('B', children);
    const u = recoveryUpdatesById(plan);
    expect(u.B).toBe('succeeded');
    expect(u.D).toBe('blocked');
    expect(plan.toRelease).toEqual([]);
  });

  test('diamond: fixing the apex re-releases BOTH skipped legs (predecessors satisfied)', () => {
    const children = [
      row('A', 'failed'),
      row('B', 'skipped', ['A']),
      row('C', 'skipped', ['A']),
      row('D', 'skipped', ['B', 'C']),
    ];
    const plan = computeRecoveryPlan('A', children);
    const u = recoveryUpdatesById(plan);
    expect(u.A).toBe('succeeded');
    expect(u.B).toBe('blocked');
    expect(u.C).toBe('blocked');
    expect(u.D).toBe('blocked');
    expect([...plan.toRelease].sort()).toEqual(['B', 'C']);
  });

  test('chain: fixing the head releases only the immediate next node; deeper nodes reset to blocked', () => {
    const children = [
      row('A', 'failed'),
      row('B', 'skipped', ['A']),
      row('C', 'skipped', ['B']),
    ];
    const plan = computeRecoveryPlan('A', children);
    const u = recoveryUpdatesById(plan);
    expect(u.A).toBe('succeeded');
    expect(u.B).toBe('blocked');
    expect(u.C).toBe('blocked');
    expect(plan.toRelease).toEqual(['B']);
  });

  test('integration node re-releases once all its (now-recovered) leaf deps succeeded', () => {
    const children = [
      row('GOOD', 'succeeded'),
      row('BAD', 'failed'),
      row('INTEG', 'skipped', ['GOOD', 'BAD']),
    ];
    const plan = computeRecoveryPlan('BAD', children);
    const u = recoveryUpdatesById(plan);
    expect(u.BAD).toBe('succeeded');
    expect(u.INTEG).toBe('blocked');
    expect(plan.toRelease).toEqual(['INTEG']);
  });
});

describe('computeEpicRetryPlan — re-triggering a terminal epic retries its failed/skipped children', () => {
  function retryUpdatesById(plan: ReturnType<typeof computeEpicRetryPlan>): Record<string, ChildStatus> {
    return Object.fromEntries(plan.statusUpdates.map((u) => [u.sub_issue_id, u.child_status]));
  }

  test('a failed root with skipped dependents → reset them all, release the root', () => {
    const children = [
      row('660', 'failed'),
      row('661', 'skipped', ['660']),
      row('662', 'skipped', ['660']),
      row('663', 'failed'),
      row('INTEG', 'skipped', ['660', '661', '662', '663']),
    ];
    const plan = computeEpicRetryPlan(children);
    const u = retryUpdatesById(plan);
    expect(plan.failedCount).toBe(2);
    expect(plan.skippedCount).toBe(3);
    expect(plan.succeededCount).toBe(0);
    expect(u['660']).toBe('ready');
    expect(u['663']).toBe('ready');
    expect(u['661']).toBe('blocked');
    expect(u['662']).toBe('blocked');
    expect(u.INTEG).toBe('blocked');
    expect([...plan.toRelease].sort()).toEqual(['660', '663']);
  });

  test('a failed node BEHIND another failed node resets to blocked (waits for the cascade), not ready', () => {
    const children = [
      row('A', 'failed'),
      row('B', 'failed', ['A']),
    ];
    const plan = computeEpicRetryPlan(children);
    const u = retryUpdatesById(plan);
    expect(u.A).toBe('ready');
    expect(u.B).toBe('blocked');
    expect(plan.toRelease).toEqual(['A']);
  });

  test('succeeded nodes are NEVER touched or re-run', () => {
    const children = [
      row('A', 'succeeded'),
      row('B', 'failed', ['A']),
    ];
    const plan = computeEpicRetryPlan(children);
    const u = retryUpdatesById(plan);
    expect(u.A).toBeUndefined();
    expect(u.B).toBe('ready');
    expect(plan.toRelease).toEqual(['B']);
    expect(plan.succeededCount).toBe(1);
  });

  test('nothing failed/skipped → empty plan (still-running or all-succeeded epic)', () => {
    const running = computeEpicRetryPlan([row('A', 'released'), row('B', 'blocked', ['A'])]);
    expect(running.statusUpdates).toEqual([]);
    expect(running.toRelease).toEqual([]);

    const done = computeEpicRetryPlan([row('A', 'succeeded'), row('B', 'succeeded', ['A'])]);
    expect(done.statusUpdates).toEqual([]);
    expect(done.succeededCount).toBe(2);
  });

  test('idempotent: re-running the plan on the reset graph is a no-op', () => {
    const children = [row('A', 'failed'), row('B', 'skipped', ['A'])];
    const first = computeEpicRetryPlan(children);
    const applied = children.map((c) => {
      const upd = first.statusUpdates.find((u) => u.sub_issue_id === c.sub_issue_id);
      return upd ? row(c.sub_issue_id, upd.child_status, c.depends_on) : c;
    });
    const second = computeEpicRetryPlan(applied);
    expect(second.statusUpdates).toEqual([]);
  });
});
