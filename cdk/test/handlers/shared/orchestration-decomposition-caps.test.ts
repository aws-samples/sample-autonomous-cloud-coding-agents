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
  applyPlanCaps,
  planTotalBudgetUsd,
  readProjectCaps,
} from '../../../src/handlers/shared/orchestration-decomposition-caps';
import {
  DEFAULT_MAX_SUB_ISSUES,
  type DecompositionPlan,
  type PlannedSubIssue,
  type ProjectDecompositionCaps,
} from '../../../src/handlers/shared/orchestration-decomposition-types';

function node(overrides: Partial<PlannedSubIssue> = {}): PlannedSubIssue {
  return {
    title: 'A child',
    description: 'do a thing',
    size: 'M',
    max_budget_usd: 1,
    depends_on: [],
    ...overrides,
  };
}

function plan(n: number, perBudget = 1): DecompositionPlan {
  return {
    shouldDecompose: true,
    reasoning: 'spans multiple surfaces',
    nodes: Array.from({ length: n }, (_, i) => node({ title: `child ${i}`, max_budget_usd: perBudget })),
  };
}

function caps(overrides: Partial<ProjectDecompositionCaps> = {}): ProjectDecompositionCaps {
  return { decompose_allowed: true, max_sub_issues: DEFAULT_MAX_SUB_ISSUES, ...overrides };
}

describe('readProjectCaps — defaults + tolerant parsing', () => {
  test('absent/empty row → decomposition OFF, default cap, unbounded budget', () => {
    const c = readProjectCaps(undefined);
    expect(c.decompose_allowed).toBe(false);
    expect(c.max_sub_issues).toBe(DEFAULT_MAX_SUB_ISSUES);
    expect(c.max_parent_budget_usd).toBeUndefined();
  });

  test('reads boolean + numeric fields', () => {
    const c = readProjectCaps({ decompose_allowed: true, max_sub_issues: 5, max_parent_budget_usd: 12.5 });
    expect(c).toEqual({ decompose_allowed: true, max_sub_issues: 5, max_parent_budget_usd: 12.5 });
  });

  test('coerces string-encoded DDB values', () => {
    const c = readProjectCaps({ decompose_allowed: 'true', max_sub_issues: '6', max_parent_budget_usd: '20' });
    expect(c.decompose_allowed).toBe(true);
    expect(c.max_sub_issues).toBe(6);
    expect(c.max_parent_budget_usd).toBe(20);
  });

  test('floors fractional max_sub_issues; drops non-positive values', () => {
    expect(readProjectCaps({ max_sub_issues: 4.9 }).max_sub_issues).toBe(4);
    // 0 / negative / NaN → fall back to default
    expect(readProjectCaps({ max_sub_issues: 0 }).max_sub_issues).toBe(DEFAULT_MAX_SUB_ISSUES);
    expect(readProjectCaps({ max_sub_issues: -3 }).max_sub_issues).toBe(DEFAULT_MAX_SUB_ISSUES);
    expect(readProjectCaps({ max_parent_budget_usd: 0 }).max_parent_budget_usd).toBeUndefined();
  });

  test('decompose_allowed defaults false for any non-true value', () => {
    expect(readProjectCaps({ decompose_allowed: 'false' }).decompose_allowed).toBe(false);
    expect(readProjectCaps({ decompose_allowed: 'yes' }).decompose_allowed).toBe(false);
    expect(readProjectCaps({ decompose_allowed: 1 }).decompose_allowed).toBe(false);
  });
});

describe('planTotalBudgetUsd', () => {
  test('sums per-child budgets', () => {
    expect(planTotalBudgetUsd(plan(3, 2))).toBe(6);
  });

  test('treats non-finite per-child budgets as 0', () => {
    const p: DecompositionPlan = {
      shouldDecompose: true,
      reasoning: 'x',
      nodes: [node({ max_budget_usd: 2 }), node({ max_budget_usd: Number.NaN })],
    };
    expect(planTotalBudgetUsd(p)).toBe(2);
  });
});

describe('applyPlanCaps — gating', () => {
  test('decomposition disabled → not_allowed (regardless of plan)', () => {
    const r = applyPlanCaps(plan(2), caps({ decompose_allowed: false }));
    expect(r.kind).toBe('not_allowed');
  });

  test('within all caps → ok with total budget', () => {
    const r = applyPlanCaps(plan(4, 2), caps({ max_sub_issues: 8, max_parent_budget_usd: 20 }));
    expect(r).toEqual({ kind: 'ok', totalBudgetUsd: 8 });
  });

  test('exactly at the node cap → ok (boundary is inclusive)', () => {
    const r = applyPlanCaps(plan(8), caps({ max_sub_issues: 8 }));
    expect(r.kind).toBe('ok');
  });

  test('over the node cap → rejected/too_many_sub_issues with a message naming both numbers', () => {
    const r = applyPlanCaps(plan(9), caps({ max_sub_issues: 8 }));
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') {
      expect(r.reason).toBe('too_many_sub_issues');
      expect(r.message).toContain('9');
      expect(r.message).toContain('8');
      expect(r.message).toContain('--max-sub-issues');
    }
  });

  test('exactly at the budget cap → ok (boundary inclusive)', () => {
    const r = applyPlanCaps(plan(2, 5), caps({ max_parent_budget_usd: 10 }));
    expect(r.kind).toBe('ok');
  });

  test('over the budget cap → rejected/over_budget with both dollar figures', () => {
    const r = applyPlanCaps(plan(3, 5), caps({ max_parent_budget_usd: 10 }));
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') {
      expect(r.reason).toBe('over_budget');
      expect(r.message).toContain('$15');
      expect(r.message).toContain('$10');
      expect(r.message).toContain('--max-parent-budget-usd');
    }
  });

  test('unbounded budget cap → only node count gates', () => {
    const r = applyPlanCaps(plan(3, 1000), caps({ max_parent_budget_usd: undefined }));
    expect(r.kind).toBe('ok');
  });

  test('node-cap is checked before budget-cap (most fundamental first)', () => {
    // Both caps violated; the node-count message should win.
    const r = applyPlanCaps(plan(9, 100), caps({ max_sub_issues: 8, max_parent_budget_usd: 10 }));
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toBe('too_many_sub_issues');
  });
});
