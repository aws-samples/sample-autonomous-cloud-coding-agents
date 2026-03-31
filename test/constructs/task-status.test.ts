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
  test('defines exactly 8 states', () => {
    expect(ALL_STATUSES).toHaveLength(8);
  });

  test('contains all expected states', () => {
    expect(ALL_STATUSES).toEqual(expect.arrayContaining([
      'SUBMITTED', 'HYDRATING', 'RUNNING', 'FINALIZING',
      'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT',
    ]));
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
});

describe('ACTIVE_STATUSES', () => {
  test('contains exactly 4 active states', () => {
    expect(ACTIVE_STATUSES).toHaveLength(4);
  });

  test('contains SUBMITTED, HYDRATING, RUNNING, FINALIZING', () => {
    expect(ACTIVE_STATUSES).toEqual(expect.arrayContaining([
      TaskStatus.SUBMITTED, TaskStatus.HYDRATING,
      TaskStatus.RUNNING, TaskStatus.FINALIZING,
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
});
