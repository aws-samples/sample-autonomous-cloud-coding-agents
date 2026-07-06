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
   * #299 revise loop: revision number (0/absent = original proposal; N≥1 = the
   * Nth re-plan from reviewer feedback). Drives the "Revised breakdown (round N)"
   * header so the reviewer sees this is an iteration, not a duplicate.
   */
  readonly revisionRound?: number;
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
  const round = opts.revisionRound ?? 0;
  const header = round > 0
    ? `**Revised breakdown (round ${round})** — ${plan.nodes.length} sub-issues`
    : `**Proposed breakdown** — ${plan.nodes.length} sub-issues`;
  lines.push(`${PLAN_PROPOSAL_PREFIX} ${header}`);
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

  if (opts.autoRun) {
    lines.push('▶️ Auto-run is on — creating these sub-issues and starting now. Reply `@bgagent reject` to stop.');
  } else {
    lines.push('Reply `@bgagent approve` to create these sub-issues and start, or `@bgagent reject` to discard.');
    // #299 revise loop: feedback IS the way to iterate — no need to re-label.
    lines.push('To adjust, reply with `@bgagent <what to change>` (e.g. "split the API work in two") and I\'ll re-plan.');
  }

  return lines.join('\n');
}

/**
 * #299 revise loop: posted when a REVISION collapses the plan to a single unit
 * (the reviewer's feedback merged everything). We do NOT auto-run — the reviewer
 * is mid-planning, so hand them the decision rather than spawning a task from the
 * revision meta-prompt (Bug A). They approve to run it as one task, or keep iterating.
 */
export function renderRevisionToSingleNote(): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} Your feedback collapses this into a single cohesive unit — there's nothing `
    + 'left to split. Reply `@bgagent approve` to run it as one task, or give more feedback to re-plan.'
  );
}

/**
 * #299 revise loop: posted when a re-plan could NOT be dispatched (e.g. a
 * transient platform error). Honest + reassuring: it does NOT surface the raw
 * "blocked by content policy" string (which reads as if the reviewer did
 * something wrong — customer-caught), and it makes NO promise of a plan that
 * won't arrive. The current plan is untouched and still approvable.
 */
export function renderRevisionFailedNote(): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} I couldn't re-plan from that just now — the current breakdown above is `
    + 'unchanged and still valid. Reply `@bgagent approve` to run it as-is, or try rephrasing your '
    + 'change (e.g. "combine the API tasks into one" or "make it 2 sub-issues").'
  );
}

/** #299 revise loop: the ack posted when a re-plan is dispatched from feedback. */
export function renderRevisingNote(round: number): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} On it — re-planning the breakdown from your feedback (round ${round}). `
    + "I'll post the revised plan shortly."
  );
}

/**
 * #299 revise loop: posted when the per-plan revision cap is hit. Stops the
 * re-plan loop (each round is a full clone+plan run) and lays out the options.
 */
export function renderRevisionCapNote(maxRevisions: number): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} I've revised this plan ${maxRevisions} times already. To keep costs sane `
    + "I won't auto-re-plan again — reply `@bgagent approve` to run the current plan, `@bgagent reject` "
    + 'to discard it, or edit the issue and re-apply the label to start over.'
  );
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
 * Render the note posted when the planner could NOT produce a breakdown — the
 * model errored, timed out, or returned an unusable plan (ABCA-490). This is
 * distinct from {@link renderSingleTaskNote}: we must NOT claim the issue "looks
 * like a single cohesive change" (that's a lie when the truth is the planner
 * failed). We fall back to running it as ONE task so the work still happens, but
 * we say so honestly and tell the user how to get a breakdown anyway. Kept
 * remedy-bearing (re-apply / split manually) rather than a dead end.
 */
export function renderPlannerErrorNote(): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} I couldn't plan a breakdown for this issue in time, so I'm running it `
    + 'as a single task. This usually means the issue is large enough that planning it took too '
    + 'long. To get a decomposition, try again by re-applying the `:decompose` label, or split the '
    + 'issue into sub-issues yourself and re-trigger (ABCA runs an existing sub-issue graph directly).'
  );
}

/**
 * Render the note posted when ``:decompose`` was applied to a THIN issue that
 * the planner declined to split (ABCA-492). The user explicitly asked for a
 * breakdown, but the one-line description didn't give the planner enough to
 * find separable units — and the repo context didn't either. Rather than
 * silently burn one giant agent run on an underspecified epic (``:decompose``
 * is the spend-safe label — the user wanted a plan to approve, not a surprise
 * PR), we hold and ask for the detail we'd need. Actionable, not a dead end.
 */
export function renderUnderspecifiedDecomposeNote(): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} I couldn't confidently break this issue into sub-issues — the description `
    + "is brief enough that I can't tell what the separable pieces are, and the repository didn't make "
    + "them obvious either. Rather than run it as one large task (you asked to decompose it), I've held "
    + 'off. To get a breakdown, add a bit more detail — the distinct capabilities or deliverables this '
    + 'covers — and re-apply the `:decompose` label. (Or, if it really is one cohesive change, apply the '
    + 'plain trigger label to run it as a single task.)'
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
