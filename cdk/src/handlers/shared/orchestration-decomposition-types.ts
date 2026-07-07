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
 * Shared types for the #299 Mode B decomposition planner. Kept in one
 * dependency-free module so the label parser (B1), caps (B2), planner (B3),
 * plan renderer (B4), and write-back (B5) all agree on the plan shape without
 * importing each other.
 */

/** Per-child effort sizing the planner assigns; informs the budget ceiling. */
export type SubIssueSize = 'S' | 'M' | 'L';

/**
 * One proposed sub-issue in a decomposition plan, BEFORE it is written back to
 * Linear as a real issue. Dependencies are expressed as **indices** into the
 * plan's ``nodes`` array (the nodes have no Linear ids yet — those are assigned
 * at write-back time, B5).
 */
export interface PlannedSubIssue {
  /** Sub-issue title (becomes the Linear issue title at write-back). */
  readonly title: string;
  /** One-paragraph scope for the child task (becomes the issue description). */
  readonly description: string;
  /** Effort sizing the planner assigned. */
  readonly size: SubIssueSize;
  /**
   * Per-child spend ceiling (USD). Σ over all nodes is the plan's worst-case
   * cost ceiling. Threaded onto the child task's ``max_budget_usd`` at release.
   */
  readonly max_budget_usd: number;
  /**
   * Indices (into the plan's ``nodes``) of the sub-issues this one is blocked
   * by — i.e. its predecessors. Empty = a root (runs immediately). Becomes a
   * Linear ``blockedBy`` relation at write-back.
   */
  readonly depends_on: readonly number[];
}

/**
 * A decomposition proposal produced by the planner (B3). Either a decision NOT
 * to decompose (``shouldDecompose: false`` → fall back to a single task) or a
 * full breakdown.
 */
export interface DecompositionPlan {
  /** The planner's verdict: is this issue worth decomposing at all? */
  readonly shouldDecompose: boolean;
  /** The proposed sub-issues. Empty when ``shouldDecompose`` is false. */
  readonly nodes: readonly PlannedSubIssue[];
  /**
   * Short human-readable rationale for the verdict/breakdown, surfaced on the
   * plan comment. (e.g. "spans 3 independent surfaces; decomposed into …" or
   * "single cohesive change — running as one task".)
   */
  readonly reasoning: string;
  /**
   * #299 BLOCKER-1 (revise-forgets-edits): on a REVISION, the agent's one-sentence
   * plain-language diff of what it changed from the prior breakdown and what it
   * kept (e.g. "Split the checkout work into two and left the other three as they
   * were."). Surfaced ABOVE the updated plan so the reviewer can catch an
   * unintended revert — the whole point of the fix is that the delta is visible,
   * not silent. Empty/absent on a first-time (round-0) plan.
   */
  readonly changeSummary?: string;
}

/**
 * Per-project decomposition caps, read from the ``LinearProjectMappingTable``
 * row (admin-set at ``onboard-project``). Bounds the blast radius of Mode B.
 */
export interface ProjectDecompositionCaps {
  /**
   * Master switch. Decomposition spins up N agent runs and N·$ of spend, so it
   * is OFF unless an admin opts the project in. Default false.
   */
  readonly decompose_allowed: boolean;
  /** Max sub-issues a plan may contain. Default {@link DEFAULT_MAX_SUB_ISSUES}. */
  readonly max_sub_issues: number;
  /**
   * Max worst-case plan cost (Σ child ``max_budget_usd``), USD. ``undefined`` =
   * unbounded (the per-child + per-user concurrency caps still apply).
   */
  readonly max_parent_budget_usd?: number;
}

/** Default sub-issue cap when a project doesn't set one (#299). */
export const DEFAULT_MAX_SUB_ISSUES = 8;
