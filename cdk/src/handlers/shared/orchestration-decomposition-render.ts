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
  // Plain-English headers — a reviewer shouldn't have to decode an internal
  // "round N" loop counter (customer-caught jargon). "Updated breakdown" reads
  // as the natural result of "I asked for a change"; the count of edits isn't
  // something the human needs to track.
  const header = round > 0
    ? `**Updated breakdown** — ${plan.nodes.length} sub-issues`
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
  const n = plan.nodes.length;
  // Plain-English summary. "critical path" and "cost ceiling" are developer
  // terms (customer-caught jargon) — say what they MEAN instead: how many will
  // run one-after-another, and the most it could cost. Three real shapes:
  //  - cp <= 1        → every sub-issue independent: "all at the same time".
  //  - cp === n       → a pure chain: EVERY piece is in the sequence, so there
  //                     is no "rest" running in parallel (PM-5: the old copy
  //                     tacked on "(the rest run at the same time)" even here).
  //  - 1 < cp < n     → mixed: a chain of ``cp`` with the remainder parallel.
  let sequencing: string;
  if (cp <= 1) {
    sequencing = 'they can all run at the same time';
  } else if (cp >= n) {
    sequencing = 'they run one after another';
  } else {
    sequencing = `up to ${cp} run one after another (the rest run at the same time)`;
  }
  lines.push(
    `**In short:** ${plan.nodes.length} pieces — ${sequencing}. `
    + `Most this could cost is **$${formatUsd(totalBudget(plan))}** `
    + '(usually less — that\'s the ceiling, not the estimate).',
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
 * #299 revise loop: posted on a pending plan when the reviewer's comment is NOT an
 * actionable verdict/change. Two cases:
 *  - a bare "@bgagent" with no text (F-bare-mention — previously a silent drop that
 *    fell through to the A6 standalone path and no-op'd), and
 *  - an AMBIGUOUS soft negation ("no", "no thanks", "don't approve", "no, looks
 *    wrong") that could mean discard OR "change it" — we nudge rather than
 *    guess-and-destroy the plan (F-reject-revision).
 * The three options make disambiguation explicit: approve / reject (discard) /
 * describe a change. Bot-prefixed so the self-trigger guard skips it.
 */
export function renderPendingPlanNudge(): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} There's a proposed breakdown above waiting on you. Reply `
    + '`@bgagent approve` to create the sub-issues and start, `@bgagent reject` to discard it, '
    + 'or tell me what to change (e.g. "make it 2 tasks") and I\'ll re-plan.'
  );
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

/**
 * PM-6: the IMMEDIATE ack posted the instant a ``:decompose``/``:auto`` label
 * dispatches the planning agent. Planning clones the repo and reasons over full
 * context — 30-120s — during which the issue was previously silent (the first
 * comment the user saw was the finished plan, so a slow plan read as "nothing
 * happened"). This kills that gap, mirroring the 👀 ack a normal task posts at
 * trigger time. ``auto`` tunes the copy: :auto starts right after planning (no
 * approval), :decompose posts a plan to approve first.
 */
export function renderDecomposeStartedNote(auto: boolean): string {
  return auto
    ? `${PLAN_PROPOSAL_PREFIX} On it — working out how to break this up, then I'll create the pieces and start. `
      + 'This takes a moment while I read the repo.'
    : `${PLAN_PROPOSAL_PREFIX} On it — working out how to break this into a plan for you to approve. `
      + 'This takes a moment while I read the repo; I\'ll post the breakdown here shortly.';
}

/**
 * #299 revise loop: the ack posted when a re-plan is dispatched from feedback.
 * The ``round`` argument is kept for the caller's logging/signature stability
 * but is intentionally NOT surfaced in the copy — a reviewer shouldn't see an
 * internal loop counter (customer-caught jargon).
 */
export function renderRevisingNote(_round: number): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} On it — updating the breakdown based on your notes. `
    + "I'll post the new version here in a moment."
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

/**
 * Render the one-time explainer posted when someone applies the ``<base>:help``
 * label (customer-caught: a first-time user couldn't tell the labels apart).
 * Explains each trigger label in plain English and creates no task. ``base`` is
 * the project's trigger label (default ``bgagent``) so the copy matches the
 * workspace's actual label names.
 */
export function renderLabelHelp(base: string): string {
  return [
    `${PLAN_PROPOSAL_PREFIX} **How to use ABCA on a Linear issue**`,
    '',
    'Add one of these labels to an issue and I\'ll get to work. Here\'s what each does:',
    '',
    `- **\`${base}\`** — Do it. I read the issue, make the change, and open a pull request. `
      + 'Best for a single, well-defined piece of work.',
    `- **\`${base}:decompose\`** — Plan it first. For a bigger issue with several parts: I break it `
      + 'into a set of smaller pieces and post the plan here for you to approve before anything runs. '
      + 'You can reply with changes (e.g. "make it 2 tasks instead of 3") and I\'ll redo the plan.',
    `- **\`${base}:auto\`** — Plan it AND start immediately, no approval step. Use when you trust me to `
      + 'split the work and just get going.',
    '',
    'A few things worth knowing:',
    '- If an issue already has sub-issues, I just run those in order — no need for a special label.',
    // The reply MENTION is my Linear app handle (@bgagent) — fixed, and separate
    // from the trigger LABEL (which the project can rename). PM-2: this line used
    // to derive it from the label base (`@${base}`), telling users to reply
    // `@abca` when only `@bgagent` fires. Match the real, working mention token.
    '- Once I\'m working, you can reply to my comments with **`@bgagent <what you want>`** to ask a '
      + 'question or request a change.',
    '- Not sure which to use? Use `' + base + ':decompose` for anything with more than one part — '
      + 'you\'ll see the plan and cost before I spend anything.',
    '',
    '_(You can remove this label now — it\'s just here to explain things.)_',
  ].join('\n');
}

/**
 * Render the one-time hint posted when a PLAIN (``<base>``, no suffix) label
 * lands on an issue that {@link looksMultiPart}. It still runs the single task —
 * the hint only points out that ``:decompose`` would give a reviewable plan
 * first (customer-caught: a plain label on a multi-part issue built everything
 * at once with no plan). Non-blocking, posted alongside the normal run.
 */
export function renderMultiPartHint(base: string): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} Heads up — this issue looks like it has a few separate parts. I'm running `
    + `it as a single task (that's what the \`${base}\` label does). If you'd rather I break it into `
    + `smaller pieces and show you a plan to approve first, add the \`${base}:decompose\` label instead.`
  );
}

/** Render the comment posted when a plan is rejected by project caps (B2). */
export function renderCapRejection(capMessage: string): string {
  return `${PLAN_PROPOSAL_PREFIX} **Decomposition not started.** ${capMessage}`;
}

/**
 * #299 revise loop: posted when a REVISION would exceed the project cap. Unlike
 * {@link renderCapRejection} (round-0: nothing was pending, so "not started" is
 * true), a revision's PRIOR plan is still pending + approvable — so we must NOT
 * say "not started" or "re-label" (re-labelling hits the stale plan; live-caught
 * F-overcap-revise). Instead: name the over-cap, and point at the two real ways
 * forward — approve the plan that's already on the issue, or give feedback that
 * keeps it under the cap. ``capMessage`` carries the "N > M" specifics.
 */
export function renderRevisionOverCapNote(capMessage: string): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} That change would go over the limit. ${capMessage} `
    + 'Your previous breakdown above is still here and ready — reply `@bgagent approve` to run it as-is, '
    + 'or tell me a change that keeps it under the limit and I\'ll re-plan.'
  );
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
 * Render the note posted when the planner returned an UNUSABLE plan (couldn't be
 * parsed into a valid breakdown) and we fall back to running the issue as ONE
 * task so the work still happens. Distinct from {@link renderSingleTaskNote}: we
 * must NOT claim the issue "looks like a single cohesive change" (that's a lie
 * when the truth is the plan didn't come back usable). Honest + remedy-bearing.
 * Note: NO "took too long" narrative — the agent-native planner (#299) runs on a
 * real substrate, not the retired 30s Lambda that motivated that copy (ABCA-490).
 */
export function renderPlannerErrorNote(): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} I couldn't turn this into a clean breakdown, so I'm running it as a `
    + 'single task instead. To try for a breakdown again, re-apply the `:decompose` label — or '
    + 'split the issue into sub-issues yourself and re-trigger (ABCA runs an existing sub-issue '
    + 'graph directly).'
  );
}

/**
 * Render the note posted when the DECOMPOSE PLANNING RUN itself couldn't
 * complete — the planning agent's session failed to start / was cancelled, its
 * plan artifact was missing, or its workspace token couldn't be resolved. Unlike
 * {@link renderPlannerErrorNote}, NOTHING was started here (the reconciler posts
 * this and returns without creating a task), so we must NOT claim "running it as
 * a single task". Honest about the no-op + gives a real next step: re-apply
 * ``:decompose`` to retry planning, or apply the plain trigger label to just run
 * it as one task now. (Live-caught: an ecs-configured repo whose planning run hit
 * a substrate error was told "planning took too long, re-apply :decompose" — both
 * wrong: nothing timed out and re-applying looped the same failure.)
 */
export function renderDecomposeUnavailableNote(): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} I hit a problem while planning the breakdown and haven't started `
    + 'anything yet — nothing was run or charged. You can re-apply the `:decompose` label to try '
    + 'planning again, or apply the plain trigger label to run this as a single task right now.'
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
