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

import { ACTIVE_STATUSES, TaskStatus, TaskStatusType, TERMINAL_STATUSES, VALID_TRANSITIONS } from '../../src/constructs/task-status';

const ALL_STATUSES: TaskStatusType[] = Object.values(TaskStatus);

describe('TaskStatus', () => {
  test('defines exactly 9 states', () => {
    // 8 original + AWAITING_APPROVAL (Cedar HITL gates, §10.3).
    expect(ALL_STATUSES).toHaveLength(9);
  });

  test('contains all expected states', () => {
    expect(ALL_STATUSES).toEqual(expect.arrayContaining([
      'SUBMITTED', 'HYDRATING', 'RUNNING', 'AWAITING_APPROVAL', 'FINALIZING',
      'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT',
    ]));
  });

  test('AWAITING_APPROVAL is included as a distinct state', () => {
    expect(TaskStatus.AWAITING_APPROVAL).toBe('AWAITING_APPROVAL');
    expect(ALL_STATUSES).toContain('AWAITING_APPROVAL');
  });
});

describe('TERMINAL_STATUSES', () => {
  test('contains exactly 4 terminal states', () => {
    expect(TERMINAL_STATUSES).toHaveLength(4);
  });

  test('contains COMPLETED, FAILED, CANCELLED, TIMED_OUT', () => {
    expect(TERMINAL_STATUSES).toEqual(expect.arrayContaining([
      TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.TIMED_OUT,
    ]));
  });

  test('AWAITING_APPROVAL is NOT terminal', () => {
    // Tasks in AWAITING_APPROVAL are alive — just paused on a human
    // decision. Classifying it as terminal would break cancel semantics
    // and `bgagent list` active-task filtering.
    expect(TERMINAL_STATUSES).not.toContain(TaskStatus.AWAITING_APPROVAL);
  });
});

describe('ACTIVE_STATUSES', () => {
  test('contains exactly 5 active states', () => {
    // SUBMITTED, HYDRATING, RUNNING, AWAITING_APPROVAL, FINALIZING.
    expect(ACTIVE_STATUSES).toHaveLength(5);
  });

  test('contains AWAITING_APPROVAL alongside the other non-terminal states', () => {
    expect(ACTIVE_STATUSES).toEqual(expect.arrayContaining([
      TaskStatus.SUBMITTED, TaskStatus.HYDRATING,
      TaskStatus.RUNNING, TaskStatus.AWAITING_APPROVAL, TaskStatus.FINALIZING,
    ]));
  });
});

describe('TERMINAL_STATUSES and ACTIVE_STATUSES', () => {
  test('are disjoint (no overlap)', () => {
    const overlap = TERMINAL_STATUSES.filter(s => ACTIVE_STATUSES.includes(s));
    expect(overlap).toHaveLength(0);
  });

  test('together cover all states', () => {
    const combined = [...TERMINAL_STATUSES, ...ACTIVE_STATUSES];
    expect(combined).toHaveLength(ALL_STATUSES.length);
    expect(combined).toEqual(expect.arrayContaining(ALL_STATUSES));
  });
});

describe('VALID_TRANSITIONS', () => {
  test('has an entry for every state', () => {
    for (const status of ALL_STATUSES) {
      expect(VALID_TRANSITIONS).toHaveProperty(status);
    }
  });

  test('terminal states have no outgoing transitions', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(VALID_TRANSITIONS[status]).toHaveLength(0);
    }
  });

  test('active states have at least one outgoing transition', () => {
    for (const status of ACTIVE_STATUSES) {
      expect(VALID_TRANSITIONS[status].length).toBeGreaterThan(0);
    }
  });

  test('all transition targets are valid states', () => {
    for (const status of ALL_STATUSES) {
      for (const target of VALID_TRANSITIONS[status]) {
        expect(ALL_STATUSES).toContain(target);
      }
    }
  });

  test('RUNNING can transition to AWAITING_APPROVAL (soft-deny entry)', () => {
    expect(VALID_TRANSITIONS[TaskStatus.RUNNING]).toContain(TaskStatus.AWAITING_APPROVAL);
  });

  test('AWAITING_APPROVAL can resume to RUNNING', () => {
    // The resume transition lands here when ApproveTaskFn / DenyTaskFn
    // (Chunk 5) flips the approval row and the agent confirms the
    // cross-table TransactWriteItems.
    expect(VALID_TRANSITIONS[TaskStatus.AWAITING_APPROVAL]).toContain(TaskStatus.RUNNING);
  });

  test('AWAITING_APPROVAL can transition to CANCELLED (user cancel mid-approval)', () => {
    expect(VALID_TRANSITIONS[TaskStatus.AWAITING_APPROVAL]).toContain(TaskStatus.CANCELLED);
  });

  test('AWAITING_APPROVAL can transition to FAILED (stranded-approval reconciler)', () => {
    expect(VALID_TRANSITIONS[TaskStatus.AWAITING_APPROVAL]).toContain(TaskStatus.FAILED);
  });

  test('AWAITING_APPROVAL cannot skip RUNNING on the way to FINALIZING', () => {
    // §10.3: approval resume always lands back at RUNNING. FINALIZING
    // is only reachable from RUNNING, preventing an approve-during-cleanup
    // race from confusing the orchestrator.
    expect(VALID_TRANSITIONS[TaskStatus.AWAITING_APPROVAL]).not.toContain(TaskStatus.FINALIZING);
  });

  test('AWAITING_APPROVAL cannot transition directly to a COMPLETED-equivalent terminal', () => {
    expect(VALID_TRANSITIONS[TaskStatus.AWAITING_APPROVAL]).not.toContain(TaskStatus.COMPLETED);
    expect(VALID_TRANSITIONS[TaskStatus.AWAITING_APPROVAL]).not.toContain(TaskStatus.TIMED_OUT);
  });

  test('HYDRATING can enter AWAITING_APPROVAL (rare but allowed, §10.3)', () => {
    // Rare: a PreToolUse hook that fires during HYDRATING's hydration
    // step (e.g. the first Bash for `git clone`). Kept valid so the
    // gate can still fire; §10.3 explicitly lists it.
    expect(VALID_TRANSITIONS[TaskStatus.HYDRATING]).toContain(TaskStatus.AWAITING_APPROVAL);
  });
});
