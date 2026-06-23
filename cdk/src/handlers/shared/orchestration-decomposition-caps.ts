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

/**
 * Pure cap-enforcement for the #299 Mode B planner (B2).
 *
 * Two responsibilities, both pure (no I/O):
 *  1. {@link readProjectCaps} — parse a (loosely-typed) ``LinearProjectMappingTable``
 *     row into typed {@link ProjectDecompositionCaps} with #299 defaults.
 *  2. {@link applyPlanCaps} — gate a proposed plan against those caps.
 *
 * Over-cap policy (chosen 2026-06-23): **reject with a message**, never trim.
 * Auto-trimming a graph can silently drop a node that others depend on,
 * producing a broken/partial result; rejecting forces an explicit human
 * decision (raise the cap, or split the issue). #299 acceptance criterion:
 * "over-cap plans are rejected … with a clear message".
 */

import {
  DEFAULT_MAX_SUB_ISSUES,
  type DecompositionPlan,
  type ProjectDecompositionCaps,
} from './orchestration-decomposition-types';

/**
 * Parse a project-mapping row (DynamoDB Document-client item, untyped) into
 * typed caps. Tolerant of the field being absent (pre-#299 rows) or stored as
 * a string (DDB number coercion). Defaults: decomposition OFF, 8 sub-issues,
 * budget unbounded.
 */
export function readProjectCaps(
  mappingItem: Record<string, unknown> | undefined | null,
): ProjectDecompositionCaps {
  const item = mappingItem ?? {};
  return {
    decompose_allowed: parseBool(item.decompose_allowed),
    max_sub_issues: parsePositiveInt(item.max_sub_issues) ?? DEFAULT_MAX_SUB_ISSUES,
    max_parent_budget_usd: parsePositiveNumber(item.max_parent_budget_usd),
  };
}

/** Outcome of gating a plan against project caps. */
export type PlanCapResult =
  | { readonly kind: 'ok'; readonly totalBudgetUsd: number }
  | { readonly kind: 'not_allowed' }
  | {
    readonly kind: 'rejected';
    /** Machine reason for logging/metrics. */
    readonly reason: 'too_many_sub_issues' | 'over_budget';
    /** User-facing one-liner for the Linear comment. */
    readonly message: string;
  };

/** Σ of per-child ``max_budget_usd`` — the plan's worst-case cost ceiling. */
export function planTotalBudgetUsd(plan: DecompositionPlan): number {
  return plan.nodes.reduce((sum, n) => sum + (Number.isFinite(n.max_budget_usd) ? n.max_budget_usd : 0), 0);
}

/**
 * Gate a proposed plan against a project's caps.
 *
 * Order of checks (most fundamental first): decomposition must be enabled →
 * node count within ``max_sub_issues`` → total budget within
 * ``max_parent_budget_usd``. The FIRST violated cap is reported (one clear
 * message, not a wall of failures).
 *
 * Note: only call this for a plan with ``shouldDecompose === true`` and at
 * least one node; a no-decompose verdict is handled upstream (single-task
 * fallback) and never reaches the caps.
 */
export function applyPlanCaps(
  plan: DecompositionPlan,
  caps: ProjectDecompositionCaps,
): PlanCapResult {
  if (!caps.decompose_allowed) {
    return { kind: 'not_allowed' };
  }

  const nodeCount = plan.nodes.length;
  if (nodeCount > caps.max_sub_issues) {
    return {
      kind: 'rejected',
      reason: 'too_many_sub_issues',
      message:
        `This issue would decompose into **${nodeCount}** sub-issues, but this project's `
        + `limit is **${caps.max_sub_issues}**. Raise the limit `
        + '(`bgagent linear onboard-project … --max-sub-issues N`) or split the issue '
        + 'into smaller epics, then re-label.',
    };
  }

  const totalBudgetUsd = planTotalBudgetUsd(plan);
  if (caps.max_parent_budget_usd !== undefined && totalBudgetUsd > caps.max_parent_budget_usd) {
    return {
      kind: 'rejected',
      reason: 'over_budget',
      message:
        `This plan's worst-case cost ceiling is **$${formatUsd(totalBudgetUsd)}**, over this `
        + `project's cap of **$${formatUsd(caps.max_parent_budget_usd)}**. Raise the cap `
        + '(`bgagent linear onboard-project … --max-parent-budget-usd N`) or split the issue, '
        + 'then re-label.',
    };
  }

  return { kind: 'ok', totalBudgetUsd };
}

// ── parsing helpers (DDB items are loosely typed) ────────────────────────

function parseBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return false;
}

/** A finite number > 0, else undefined. Accepts string-encoded numbers. */
function parsePositiveNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n;
  return undefined;
}

/** A positive integer (floored), else undefined. */
function parsePositiveInt(v: unknown): number | undefined {
  const n = parsePositiveNumber(v);
  return n === undefined ? undefined : Math.floor(n);
}

/** Money with at most 2 decimals, trailing zeros trimmed (12.50 → "12.5", 12 → "12"). */
function formatUsd(n: number): string {
  return Number(n.toFixed(2)).toString();
}
