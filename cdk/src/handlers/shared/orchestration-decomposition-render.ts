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
 * Pure renderers for the #299 Mode B plan-proposal comment (B4).
 *
 * After the planner (B3) produces a {@link DecompositionPlan} and caps (B2) pass,
 * Mode B posts ONE comment on the parent issue describing the proposed breakdown
 * and how to act on it. These functions build that comment markdown (and the
 * over-cap rejection / single-task notes) deterministically, with no I/O — the
 * processor does the posting.
 *
 * The comment carries everything #299 asks for: sub-issues, dependency edges,
 * per-child S/M/L, the Σ cost CEILING (no absolute-time estimate — see #299),
 * and the critical-path length (longest dependency chain). Critical-path length
 * is the topological layer count from {@link validateDag}: it is the inherent
 * serial floor of the orchestration (Θ(L) agent runs), the number that actually
 * predicts "how long this feels".
 */

import { validateDag, type DagNode } from './orchestration-dag';
import {
  type DecompositionPlan,
  type PlannedSubIssue,
  type SubIssueSize,
} from './orchestration-decomposition-types';

/** Bot-comment prefix so the self-trigger guard (UX.20) skips our own plan post. */
export const PLAN_PROPOSAL_PREFIX = '🗂️';

/** A short glyph per size for compact rendering. */
const SIZE_GLYPH: Readonly<Record<SubIssueSize, string>> = { S: 'S', M: 'M', L: 'L' };

/**
 * The longest dependency chain in the plan = number of topological layers.
 * This is the orchestration's serial floor (Θ(L·T) wall-clock, see the perf
 * review): no amount of parallelism beats it. Returns 0 for an empty plan.
 * The plan is already DAG-valid by the time we render, but we fall back to a
 * safe ``nodes.length`` upper bound if (defensively) validation fails.
 */
export function criticalPathLength(plan: DecompositionPlan): number {
  if (plan.nodes.length === 0) return 0;
  const dagNodes: DagNode[] = plan.nodes.map((n, i) => ({
    id: `n${i}`,
    depends_on: n.depends_on.map((d) => `n${d}`),
  }));
  const v = validateDag(dagNodes);
  return v.ok ? v.layers.length : plan.nodes.length;
}

/** Σ of per-child budgets — the plan's worst-case cost ceiling. */
function totalBudget(plan: DecompositionPlan): number {
  return plan.nodes.reduce((s, n) => s + (Number.isFinite(n.max_budget_usd) ? n.max_budget_usd : 0), 0);
}

/** Render one child's dependency note (e.g. "after #1, #3"; "" for a root). */
function dependsNote(node: PlannedSubIssue): string {
  if (node.depends_on.length === 0) return '';
  // Show 1-based positions to match the human-numbered list below.
  const refs = [...node.depends_on].sort((a, b) => a - b).map((d) => `#${d + 1}`).join(', ');
  return ` _(after ${refs})_`;
}

export interface RenderPlanProposalOptions {
  /**
   * When true, the issue was labelled ``bgagent:auto`` — the plan runs without
   * waiting for approval, so the footer says "starting now" rather than
   * prompting for ``@bgagent approve``.
   */
  readonly autoRun: boolean;
  /**
   * DJ-2 — the critical assessor judged this issue better as ONE task, but the
   * user explicitly applied ``:decompose`` so we drafted a breakdown anyway. When
   * set, this is the assessor's rationale, surfaced as an informational caveat
   * above the action footer so the user can decide with eyes open (approve the
   * plan, or relabel ``abca`` to one-shot it). Absent = the assessor agreed.
   */
  readonly oneShotCaveat?: string;
}

/**
 * Render the plan-proposal comment posted on the parent issue. Markdown.
 *
 * Layout: header + reasoning → numbered sub-issue list (title, size, scope,
 * deps) → summary (count, critical path, cost ceiling) → action footer.
 */
export function renderPlanProposal(
  plan: DecompositionPlan,
  opts: RenderPlanProposalOptions,
): string {
  const lines: string[] = [];
  lines.push(`${PLAN_PROPOSAL_PREFIX} **Proposed breakdown** — ${plan.nodes.length} sub-issues`);
  if (plan.reasoning) {
    lines.push('');
    lines.push(`> ${plan.reasoning}`);
  }
  lines.push('');

  plan.nodes.forEach((node, i) => {
    lines.push(`${i + 1}. **${node.title}** \`${SIZE_GLYPH[node.size]}\`${dependsNote(node)}`);
    if (node.description && node.description !== node.title) {
      lines.push(`   ${node.description}`);
    }
  });

  lines.push('');
  lines.push('---');
  const cp = criticalPathLength(plan);
  lines.push(
    `**Summary:** ${plan.nodes.length} sub-issues · critical path ${cp} `
    + `(longest chain that must run in sequence) · cost ceiling **$${formatUsd(totalBudget(plan))}** `
    + '(worst-case, Σ of per-task caps — actual spend is typically lower)',
  );
  lines.push('');

  // DJ-2: the assessor leaned one-shot but the user explicitly asked to
  // decompose — surface that as info (not a veto) so they decide with eyes open.
  if (opts.oneShotCaveat) {
    lines.push(
      `ℹ️ Heads up — I'd lean toward running this as **one task**: ${opts.oneShotCaveat} `
      + 'You asked to decompose, so here\'s the breakdown anyway. Approve to proceed, '
      + 'or relabel `abca` to run it as a single task.',
    );
    lines.push('');
  }

  if (opts.autoRun) {
    lines.push('▶️ Auto-run is on — creating these sub-issues and starting now. Reply `@bgagent reject` to stop.');
  } else {
    lines.push('Reply `@bgagent approve` to create these sub-issues and start, or `@bgagent reject` to discard.');
    lines.push('To adjust first, edit the issue and re-apply the label, or split it into a smaller epic.');
  }

  return lines.join('\n');
}

/** Render the comment posted when a plan is rejected by project caps (B2). */
export function renderCapRejection(capMessage: string): string {
  return `${PLAN_PROPOSAL_PREFIX} **Decomposition not started.** ${capMessage}`;
}

/**
 * Render the note posted when the planner judged the issue NOT worth
 * decomposing — the issue runs as a single task (the normal path) and we just
 * explain why, so a user who asked for decomposition isn't left confused.
 */
export function renderSingleTaskNote(reasoning: string): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} This issue looks like a single cohesive change, so I'm running it as `
    + `one task rather than decomposing it.${reasoning ? ` (${reasoning})` : ''}`
  );
}

/**
 * Render the note posted when ``:decompose``/``:auto`` was applied to an issue
 * that ALREADY has sub-issues — the suffix is a no-op and we run the existing
 * graph (Mode A). Surfaced so the user's stated intent isn't silently ignored.
 */
export function renderAlreadyDecomposedNote(): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} This issue already has sub-issues, so there's nothing to auto-decompose — `
    + 'running the existing sub-issue graph.'
  );
}

/** Money with at most 2 decimals, trailing zeros trimmed. */
function formatUsd(n: number): string {
  return Number(n.toFixed(2)).toString();
}
