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
  computeReconcilePlan,
  computeRecoveryPlan,
  type ReconcileChild,
  type TerminalOutcome,
} from '../../../src/handlers/shared/orchestration-reconcile';
import type { ChildStatus } from '../../../src/handlers/shared/orchestration-store';

const row = (
  sub_issue_id: string,
  child_status: ChildStatus,
  depends_on: string[] = [],
): ReconcileChild => ({ sub_issue_id, depends_on, child_status });

/** Helper: map sub_issue_id → new status from a plan's updates. */
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
      row('C', 'released'), // C's task is running, not yet succeeded
      row('D', 'blocked', ['B', 'C']),
    ];
    const plan = computeReconcilePlan({ sub_issue_id: 'B', status: 'COMPLETED' }, children);
    expect(plan.toRelease).toEqual([]); // C hasn't succeeded yet
  });

  test('D released only once BOTH B and C have succeeded', () => {
    // C is the last to finish; B already succeeded.
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
      row('D', 'blocked'), // independent root that hasn't started
    ];
    const plan = computeReconcilePlan({ sub_issue_id: 'A', status: 'FAILED' }, children);
    const u = updatesById(plan);
    expect(u.A).toBe('failed');
    expect(u.B).toBe('skipped');
    expect(u.C).toBe('skipped');
    expect(u.D).toBeUndefined(); // independent sibling not touched
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
    // B is already released (its task is running) when A fails — leave it
    // to its own terminal event; do not retroactively skip.
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
      row('B', 'released'), // independent, still running
    ];
    const plan = computeReconcilePlan({ sub_issue_id: 'A', status: 'COMPLETED' }, children);
    expect(plan.orchestrationComplete).toBe(false);
  });

  test('true when a failure skips all remaining work', () => {
    const children = [row('A', 'released'), row('B', 'blocked', ['A'])];
    const plan = computeReconcilePlan({ sub_issue_id: 'A', status: 'FAILED' }, children);
    // A→failed, B→skipped → all terminal.
    expect(plan.orchestrationComplete).toBe(true);
  });
});

/** Helper: map sub_issue_id → new status from a recovery plan's updates. */
function recoveryUpdatesById(
  plan: ReturnType<typeof computeRecoveryPlan>,
): Record<string, ChildStatus> {
  return Object.fromEntries(plan.statusUpdates.map((u) => [u.sub_issue_id, u.child_status]));
}

describe('computeRecoveryPlan (#75 — comment-fix a failed child re-releases skipped deps)', () => {
  test('the demo case: BAD failed, DEP skipped → fixing BAD un-fails it + re-releases DEP', () => {
    // OK succeeded, BAD failed, DEP (deps=BAD) was transitively skipped.
    const children = [
      row('OK', 'succeeded'),
      row('BAD', 'failed'),
      row('DEP', 'skipped', ['BAD']),
    ];
    const plan = computeRecoveryPlan('BAD', children);
    const u = recoveryUpdatesById(plan);
    expect(u.BAD).toBe('succeeded'); // un-failed
    expect(u.DEP).toBe('ready'); // un-skipped, now releasable
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

  test('a dependent with ANOTHER still-failed predecessor stays skipped', () => {
    // D depends on both B and C. B is being fixed, but C is still failed →
    // D must NOT release (recovery is gated the same as the original).
    const children = [
      row('B', 'failed'),
      row('C', 'failed'),
      row('D', 'skipped', ['B', 'C']),
    ];
    const plan = computeRecoveryPlan('B', children);
    const u = recoveryUpdatesById(plan);
    expect(u.B).toBe('succeeded');
    expect(u.D).toBeUndefined(); // not touched — C still failed
    expect(plan.toRelease).toEqual([]);
  });

  test('diamond: fixing the apex re-releases BOTH skipped legs (predecessors satisfied)', () => {
    // A succeeded feeds B and C; ROOT failed also feeds B and C; D depends on B,C.
    // Actually model: A(apex) failed, B & C skipped (deps=A), D skipped (deps=B,C).
    const children = [
      row('A', 'failed'),
      row('B', 'skipped', ['A']),
      row('C', 'skipped', ['A']),
      row('D', 'skipped', ['B', 'C']),
    ];
    const plan = computeRecoveryPlan('A', children);
    const u = recoveryUpdatesById(plan);
    expect(u.A).toBe('succeeded');
    // B and C release now (A succeeded). D does NOT — B/C are only 'ready',
    // not yet 'succeeded'; D releases later via the forward cascade when B & C land.
    expect(u.B).toBe('ready');
    expect(u.C).toBe('ready');
    expect(u.D).toBeUndefined();
    expect(plan.toRelease.sort()).toEqual(['B', 'C']);
  });

  test('chain: fixing the head re-releases only the immediate next node, not the whole chain', () => {
    // A failed → B,C skipped (B deps A, C deps B). Fixing A frees B only; C waits
    // for B to actually succeed (forward cascade), not just be released.
    const children = [
      row('A', 'failed'),
      row('B', 'skipped', ['A']),
      row('C', 'skipped', ['B']),
    ];
    const plan = computeRecoveryPlan('A', children);
    const u = recoveryUpdatesById(plan);
    expect(u.A).toBe('succeeded');
    expect(u.B).toBe('ready');
    expect(u.C).toBeUndefined(); // B is only 'ready', not 'succeeded' → C still waits
    expect(plan.toRelease).toEqual(['B']);
  });

  test('integration node re-releases once all its (now-recovered) leaf deps succeeded', () => {
    // Two leaves: GOOD succeeded, BAD failed; integration (deps GOOD,BAD) skipped.
    // Fixing BAD makes both leaves succeeded → integration releases.
    const children = [
      row('GOOD', 'succeeded'),
      row('BAD', 'failed'),
      row('INTEG', 'skipped', ['GOOD', 'BAD']),
    ];
    const plan = computeRecoveryPlan('BAD', children);
    const u = recoveryUpdatesById(plan);
    expect(u.BAD).toBe('succeeded');
    expect(u.INTEG).toBe('ready'); // both deps now succeeded
    expect(plan.toRelease).toEqual(['INTEG']);
  });
});
