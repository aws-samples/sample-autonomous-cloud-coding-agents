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
  // "Updated breakdown" whenever this render reflects a change to a prior plan —
  // either a semantic revise round (round > 0) OR a structural command edit that
  // produced a computed diff (changeSummary present even at round 0, since a
  // command edit doesn't consume the revise-round budget). Plain-English header:
  // a reviewer shouldn't have to decode an internal loop counter (customer-caught
  // jargon), and an edited plan should never still read "Proposed".
  const edited = round > 0 || Boolean(plan.changeSummary);
  const header = edited
    ? `**Updated breakdown** — ${plan.nodes.length} sub-issues`
    : `**Proposed breakdown** — ${plan.nodes.length} sub-issues`;
  lines.push(`${PLAN_PROPOSAL_PREFIX} ${header}`);
  // #299 BLOCKER-1 (revise-forgets-edits): lead with the COMPUTED before→after
  // diff (never model self-report) so the reviewer can immediately catch an
  // unintended revert (a dropped node reappearing, a title snapping back) instead
  // of re-reading the whole breakdown. Shown whenever a change actually happened.
  if (edited && plan.changeSummary) {
    lines.push('');
    lines.push(`**What changed:** ${plan.changeSummary}`);
  }
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
  // POLISH-9: the number here is a SPENDING CAP (Σ of per-size safety limits),
  // not a forecast — actual spend ran ~10× lower in QA ($0.42 vs a $4 cap). The
  // old copy "Most this could cost is $X" read as an estimate and anchored the
  // reviewer at the ceiling. Frame it as the guardrail it is ("I'll stop at") so
  // it's not mistaken for a budget figure. (A real typical estimate needs per-repo
  // cost history wired into the planner — not available yet; deferred.)
  lines.push(
    `**In short:** ${plan.nodes.length} pieces — ${sequencing}. `
    + `I'll cap spending at **$${formatUsd(totalBudget(plan))}** — that's a safety limit, `
    + 'not an estimate; actual cost is usually a small fraction of it.',
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
 * #299 BLOCKER-2 (@abca black hole): posted when a reviewer addresses the bot by
 * the WRONG handle (most often ``@abca`` — mistaking the trigger LABEL for the
 * mention handle — or a boundary-miss like ``@bgagentx``). Previously such a
 * comment fell into a silent black hole (parseCommentTrigger returned
 * ``triggered: false`` → dropped, no reply, no reaction), so the reviewer never
 * learned their instruction wasn't seen. This one-liner tells them the right
 * handle. Bot-prefixed (👋) so the self-trigger guard skips it.
 */
export function renderWrongMentionNudge(): string {
  return (
    '👋 I answer to `@bgagent` — I don\'t pick up other @-names (the labels are '
    + '`…:decompose` / `…:auto`, but to talk to me in a comment, mention `@bgagent`). '
    + 'Re-send your message mentioning `@bgagent` and I\'ll get right on it.'
  );
}

/**
 * #299 plan-mode T4: posted when a structural command ("drop 5", "merge 2 and 7")
 * names a sub-issue that isn't in the plan (out-of-range index). The plan is left
 * untouched + approvable; ``detail`` carries the specifics ("There's no sub-issue
 * #5 — the plan has 3 …"). Bot-prefixed so the self-trigger guard skips it.
 */
export function renderPlanCommandError(detail: string): string {
  return `${PLAN_PROPOSAL_PREFIX} ${detail} The plan above is unchanged — `
    + 'try again with a number from the list, `@bgagent approve` to run it, or tell me what to change.';
}

/**
 * #299 plan-mode T4: posted when a structural command (drop/merge) would collapse
 * the plan to fewer than 2 sub-issues — nothing left to orchestrate. We do NOT
 * apply it (the plan stays as-is, approvable); hand the reviewer the decision, the
 * same way a revision-to-single is handled.
 */
export function renderCommandCollapseNote(): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} That edit would leave just one unit — there's nothing left to split. `
    + 'The plan above is unchanged: reply `@bgagent approve` to run it, `@bgagent reject` to discard '
    + 'it, or tell me what to change.'
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
 * #299 BLOCKER-1 (deterministic revise): posted when the interpreter couldn't turn
 * the reviewer's comment into a concrete edit — it wasn't clear which sub-issue was
 * meant, or it was a question rather than a change. Carries the interpreter's short
 * clarifying ask (``detail``) so the reviewer knows exactly what to say next. The
 * current plan is untouched + approvable. Bot-prefixed so the self-trigger guard skips it.
 */
export function renderReviseUnclearNote(detail: string): string {
  const ask = detail.trim() || 'which sub-issue would you like to change, and how?';
  return `${PLAN_PROPOSAL_PREFIX} ${ask} The breakdown above is unchanged — `
    + 'tell me the change (e.g. "drop the careers page", "merge the first two") or reply '
    + '`@bgagent approve` to run it as-is.';
}

/**
 * #299 BLOCKER-1: posted when an edit resolved cleanly but changed NOTHING (a no-op —
 * e.g. "keep it as is", or an edit that matches the current state). Honest: says
 * nothing changed rather than a misleading "Updated". The computed diff drives this
 * (an empty {@link PlanDiff}); never a model claim. Bot-prefixed.
 */
export function renderReviseNoChangeNote(): string {
  return `${PLAN_PROPOSAL_PREFIX} That leaves the breakdown exactly as it is above — nothing to change. `
    + 'Reply `@bgagent approve` to run it, or tell me a different change.';
}

/**
 * #299 BLOCKER-1: the ack posted when a revise needs a closer look at the code (the
 * interpreter returned ``needs_repo`` — feasibility / new-scope the cached repo notes
 * can't settle), so we escalate to a repo-cloning revise. ``reason`` names what's being
 * checked. Honest about the short wait, mirrors renderDecomposeStartedNote's "~1-2 min".
 * Bot-prefixed. The current plan stays approvable while this runs.
 */
export function renderReviseEscalatedNote(reason: string): string {
  const why = reason.trim() ? ` (${reason.trim()})` : '';
  return `${PLAN_PROPOSAL_PREFIX} Taking a closer look at the code to get this right${why} — `
    + 'this takes ~1-2 minutes; I\'ll update the breakdown above when it\'s ready.';
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
  // CONFUSING-3: "shortly" oversold a 30-120s wait (the tester waited ~2.5 min
  // and thought it had stalled). Give an honest "~1-2 minutes" so the silence is
  // expected, not alarming.
  return auto
    ? `${PLAN_PROPOSAL_PREFIX} On it — working out how to break this up, then I'll create the pieces and start. `
      + 'I need to read the repo first, so this takes ~1-2 minutes.'
    : `${PLAN_PROPOSAL_PREFIX} On it — working out how to break this into a plan for you to approve. `
      + 'I need to read the repo first, so this takes ~1-2 minutes; I\'ll post the breakdown here when it\'s ready.';
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
    '- If some sub-issues fail, reply **`@bgagent retry`** on the epic (or remove and re-apply the '
      + `\`${base}\` label) — either way re-runs only the failed/skipped work; the succeeded parts are kept.`,
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
 *
 * POLISH-6: when this fires on the ``:auto`` path (``autoRun`` true), name WHY it
 * ran without asking — on a single-task issue ``abca`` / ``:auto`` / ``:decompose``
 * all produce the same outcome, so the reviewer can't otherwise tell the labels
 * apart at the moment it matters. The explainer makes the ``:auto`` choice visible.
 */
export function renderSingleTaskNote(reasoning: string, autoRun = false): string {
  const auto = autoRun
    ? ' Starting now without asking first, since you used the auto-run label (`:auto`).'
    : '';
  return (
    `${PLAN_PROPOSAL_PREFIX} This issue looks like a single cohesive change, so I'm running it as `
    + `one task rather than decomposing it.${reasoning ? ` (${reasoning})` : ''}${auto}`
  );
}

/** #299 single-task gate: the note posted when a single-task proposal is rejected. */
export function renderSingleTaskCancelled(): string {
  return `${PLAN_PROPOSAL_PREFIX} Cancelled — nothing was run.`;
}

/**
 * #299 single-task gate (F-single-gate): the PROPOSE-and-wait note for a
 * ``:decompose`` (approve-first) run that declined to split. Unlike
 * {@link renderSingleTaskNote} (which announces an immediate auto-run), this asks
 * for approval first — because the user chose the spend-safe ``:decompose`` label,
 * so nothing should run until they say go. ``:auto`` still uses the auto-run note.
 */
export function renderSingleTaskProposal(reasoning: string): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} This looks like a single cohesive change — not worth splitting into `
    + `sub-issues.${reasoning ? ` (${reasoning})` : ''} Reply \`@bgagent approve\` to run it as one `
    + 'task, or `@bgagent reject` to cancel. (You used the approve-first label, so I haven\'t started '
    + 'anything yet.)'
  );
}

/**
 * PM-P1-1 (2026-07-24): freeze the SINGLE-task proposal comment when it is
 * APPROVED into a durable "Approved" reference — the single-task analogue of
 * {@link renderApprovedPlanReference}. Before this, the single-task approve path
 * swept the whole planning thread with nothing frozen, so Linear kept NO record
 * of what was proposed/approved (a reviewer couldn't audit the authorized scope
 * against the PR). Keeps exactly ONE durable line, dropping the now-stale
 * approve/reject footer. Still ``🗂️``-prefixed so the self-trigger guard skips it.
 */
export function renderSingleTaskApprovedReference(reasoning: string): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} **Approved** — running as a single task`
    + `${reasoning ? ` (${reasoning})` : ''}.\n\n_Progress is on the issue below._`
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

/**
 * ABCA-659 — re-trigger of an already-terminal epic that HAS failed/skipped
 * children: we're retrying them. Names exactly what's being re-run so the note
 * is honest (the old copy claimed "running the existing sub-issue graph" while
 * nothing actually re-ran). ``succeeded`` nodes are left alone and called out so
 * the user knows finished work isn't being redone.
 */
export function renderEpicRetryNote(counts: {
  failed: number;
  skipped: number;
  succeeded: number;
}): string {
  const retried = counts.failed + counts.skipped;
  const parts: string[] = [];
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  const kept = counts.succeeded > 0
    ? ` The ${counts.succeeded} that already succeeded ${counts.succeeded === 1 ? 'is' : 'are'} left as-is.`
    : '';
  return (
    `${PLAN_PROPOSAL_PREFIX} Re-running the parts of this epic that didn't finish — `
    + `${retried} sub-issue${retried === 1 ? '' : 's'} (${parts.join(' + ')}).${kept} `
    + "I'll update the panel below as they go."
  );
}

/**
 * ABCA-659 — re-trigger of an epic that already finished with EVERY child
 * succeeded. Nothing to retry; say so plainly instead of the misleading
 * "running the existing sub-issue graph".
 */
export function renderEpicAlreadyCompleteNote(): string {
  return (
    `${PLAN_PROPOSAL_PREFIX} This epic already finished — every sub-issue succeeded, so there's `
    + 'nothing to re-run. To change something, comment on the specific sub-issue with '
    + '`@bgagent <what to change>`.'
  );
}

/**
 * #299 plan-cleanup: freeze the plan-proposal comment into a static REFERENCE
 * once the plan is approved and the live epic panel takes over. The proposal's
 * action footer ("Reply `@bgagent approve`…") and the sequencing/cost preamble
 * are now stale — what the reviewer needs from here on is a compact record of
 * WHAT was agreed and its sub-issues, with the live status living on the panel
 * (Mode A). We re-render the numbered breakdown (same shape as the proposal, so
 * the reference reads continuously with what they approved) under a frozen
 * "Approved" header, dropping the footer entirely.
 *
 * ``revisionRound`` (>0) adds a plain-language "· refined over N rounds"
 * footnote — the one durable trace that the plan was iterated, since the
 * interim revise notes are swept at approval and Linear has no fold to tuck a
 * full history into (live-proven on ABCA-670: threaded replies don't collapse).
 * The last round's computed "What changed" line already lives in the proposal
 * body, so the most recent "why" survives; older rounds don't — the deliberate
 * "if it clutters, don't" trade-off the user chose.
 *
 * Still ``🗂️``-prefixed so the self-trigger guard keeps skipping it (UX.20).
 */
export function renderApprovedPlanReference(
  plan: DecompositionPlan,
  opts: { readonly revisionRound?: number } = {},
): string {
  const lines: string[] = [];
  const round = opts.revisionRound ?? 0;
  const refined = round > 0 ? ` · refined over ${round} ${round === 1 ? 'round' : 'rounds'}` : '';
  lines.push(`${PLAN_PROPOSAL_PREFIX} **Approved plan** — ${plan.nodes.length} sub-issues${refined}`);
  lines.push('');
  plan.nodes.forEach((node, i) => {
    lines.push(`${i + 1}. **${node.title}** \`${SIZE_GLYPH[node.size]}\`${dependsNote(node)}`);
    if (node.description && node.description !== node.title) {
      lines.push(`   ${node.description}`);
    }
  });
  lines.push('');
  lines.push('_Live status is on the orchestration panel below._');
  return lines.join('\n');
}

/**
 * #299 plan-cleanup: freeze the plan comment when the plan is REJECTED (discard).
 * The breakdown is gone, so we don't re-list it — just a one-line record that a
 * plan existed and was discarded (nothing ran). Replaces the transient
 * "Plan discarded" ack (which is swept with the other notes) so the thread keeps
 * exactly ONE durable line instead of a scatter. Bot-prefixed (self-trigger guard).
 */
export function renderDiscardedPlanReference(): string {
  return `${PLAN_PROPOSAL_PREFIX} **Plan discarded** — no sub-issues were created, nothing ran.`;
}

/** Money with at most 2 decimals, trailing zeros trimmed. */
function formatUsd(n: number): string {
  return Number(n.toFixed(2)).toString();
}
