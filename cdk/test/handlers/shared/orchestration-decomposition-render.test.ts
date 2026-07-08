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

import { isBotAuthoredComment } from '../../../src/handlers/shared/orchestration-comment-trigger';
import {
  criticalPathLength,
  PLAN_PROPOSAL_PREFIX,
  renderAlreadyDecomposedNote,
  renderApprovedPlanReference,
  renderCapRejection,
  renderDecomposeStartedNote,
  renderDecomposeUnavailableNote,
  renderDiscardedPlanReference,
  renderLabelHelp,
  renderMultiPartHint,
  renderPlannerErrorNote,
  renderPlanProposal,
  renderRevisingNote,
  renderPendingPlanNudge,
  renderRevisionCapNote,
  renderRevisionOverCapNote,
  renderRevisionFailedNote,
  renderSingleTaskNote,
  renderUnderspecifiedDecomposeNote,
  renderWrongMentionNudge,
} from '../../../src/handlers/shared/orchestration-decomposition-render';
import type { DecompositionPlan, PlannedSubIssue } from '../../../src/handlers/shared/orchestration-decomposition-types';

function node(o: Partial<PlannedSubIssue> = {}): PlannedSubIssue {
  return { title: 'T', description: 'd', size: 'M', max_budget_usd: 3, depends_on: [], ...o };
}

const FANOUT: DecompositionPlan = {
  shouldDecompose: true,
  reasoning: 'Three independent surfaces.',
  nodes: [
    node({ title: 'Pricing route', size: 'M', max_budget_usd: 3 }),
    node({ title: 'Comparison table', size: 'S', max_budget_usd: 1 }),
    node({ title: 'Stripe checkout', size: 'L', max_budget_usd: 6 }),
  ],
};

const CHAIN: DecompositionPlan = {
  shouldDecompose: true,
  reasoning: 'Sequential.',
  nodes: [
    node({ title: 'Schema', size: 'S', max_budget_usd: 1, depends_on: [] }),
    node({ title: 'API', size: 'M', max_budget_usd: 3, depends_on: [0] }),
    node({ title: 'UI', size: 'M', max_budget_usd: 3, depends_on: [1] }),
  ],
};

const DIAMOND: DecompositionPlan = {
  shouldDecompose: true,
  reasoning: 'Fan-out then integrate.',
  nodes: [
    node({ title: 'Base', depends_on: [] }),
    node({ title: 'Left', depends_on: [0] }),
    node({ title: 'Right', depends_on: [0] }),
    node({ title: 'Merge', depends_on: [1, 2] }),
  ],
};

describe('criticalPathLength', () => {
  test('fan-out (all independent) → 1 layer', () => {
    expect(criticalPathLength(FANOUT)).toBe(1);
  });

  test('chain A→B→C → 3 layers', () => {
    expect(criticalPathLength(CHAIN)).toBe(3);
  });

  test('diamond A→{B,C}→D → 3 layers', () => {
    expect(criticalPathLength(DIAMOND)).toBe(3);
  });

  test('empty plan → 0', () => {
    expect(criticalPathLength({ shouldDecompose: false, reasoning: '', nodes: [] })).toBe(0);
  });
});

describe('renderPlanProposal — content', () => {
  test('lists every sub-issue with its size and 1-based number', () => {
    const md = renderPlanProposal(FANOUT, { autoRun: false });
    expect(md).toContain('1. **Pricing route** `M`');
    expect(md).toContain('2. **Comparison table** `S`');
    expect(md).toContain('3. **Stripe checkout** `L`');
  });

  test('shows the reasoning as a blockquote', () => {
    expect(renderPlanProposal(FANOUT, { autoRun: false })).toContain('> Three independent surfaces.');
  });

  test('summarises count, sequencing, and max cost in PLAIN ENGLISH (no jargon, no absolute time)', () => {
    const md = renderPlanProposal(FANOUT, { autoRun: false });
    expect(md).toContain('3 pieces');
    // Customer-caught jargon: "critical path" / "cost ceiling" are dev terms.
    expect(md).not.toMatch(/critical path/i);
    expect(md).not.toMatch(/cost ceiling/i);
    // FANOUT is all-independent (cp === 1) → phrased as "run at the same time".
    expect(md).toContain('run at the same time');
    expect(md).toContain('$10'); // 3 + 1 + 6, still the worst-case number
    expect(md).not.toMatch(/\bminutes?\b|\bhours?\b/i); // no absolute-time estimate (#299)
  });

  test('POLISH-9: the cost line is framed as a spending CAP, not an estimate', () => {
    const md = renderPlanProposal(FANOUT, { autoRun: false });
    // Reads as a guardrail ("cap"/"safety limit"), not a forecast that anchors
    // the reviewer at ~10x actual (QA: $0.42 actual vs a $4 cap).
    expect(md).toMatch(/cap|safety limit/i);
    expect(md).toMatch(/not an estimate|fraction/i);
    expect(md).toContain('$10'); // still the real ceiling number
  });

  test('a PURE chain (cp === n) says they run one after another, with NO phantom "the rest" clause', () => {
    const md = renderPlanProposal(CHAIN, { autoRun: false }); // 3-deep chain, all 3 nodes in sequence
    expect(md).toContain('they run one after another');
    // PM-5: a pure chain has no parallel remainder — must NOT claim "the rest run at the same time".
    expect(md).not.toMatch(/the rest run at the same time/i);
    expect(md).not.toMatch(/critical path/i);
  });

  test('a MIXED graph (1 < cp < n) says how many are sequential AND that the rest parallelise', () => {
    const md = renderPlanProposal(DIAMOND, { autoRun: false }); // 4 nodes, cp === 3
    expect(md).toContain('up to 3 run one after another');
    expect(md).toContain('the rest run at the same time');
  });

  test('renders dependency notes for non-root nodes (1-based refs)', () => {
    const md = renderPlanProposal(DIAMOND, { autoRun: false });
    expect(md).toContain('2. **Left** `M` _(after #1)_');
    expect(md).toContain('4. **Merge** `M` _(after #2, #3)_');
    // The root has no "after" note.
    expect(md).toContain('1. **Base** `M`');
    expect(md.split('\n').find((l) => l.startsWith('1. **Base**'))).not.toContain('after');
  });

  test('manual mode footer prompts for @bgagent approve / reject', () => {
    const md = renderPlanProposal(FANOUT, { autoRun: false });
    expect(md).toContain('@bgagent approve');
    expect(md).toContain('@bgagent reject');
  });

  test('auto mode footer says starting now (still offers reject)', () => {
    const md = renderPlanProposal(FANOUT, { autoRun: true });
    expect(md).toContain('Auto-run is on');
    expect(md).toContain('@bgagent reject');
    expect(md).not.toContain('@bgagent approve');
  });

  test('#299 revise loop: revisionRound>0 renders a plain "Updated breakdown" (NO "round N" jargon)', () => {
    const orig = renderPlanProposal(FANOUT, { autoRun: false });
    expect(orig).toContain('Proposed breakdown');
    expect(orig).not.toContain('Updated breakdown');
    const rev = renderPlanProposal(FANOUT, { autoRun: false, revisionRound: 2 });
    expect(rev).toContain('Updated breakdown');
    expect(rev).not.toContain('Proposed breakdown');
    // Customer-caught jargon: the reviewer shouldn't see an internal loop counter.
    expect(rev).not.toMatch(/round \d/i);
    // Footer invites more feedback (the iterative loop), not just approve/reject.
    expect(rev).toMatch(/reply with .*@bgagent/i);
  });

  test('#299 BLOCKER-1: a revision with a changeSummary leads with "What changed" so a revert is visible', () => {
    const revised: DecompositionPlan = {
      ...FANOUT,
      changeSummary: 'Split the checkout work into two and left the other two as they were.',
    };
    const md = renderPlanProposal(revised, { autoRun: false, revisionRound: 1 });
    expect(md).toContain('**What changed:**');
    expect(md).toContain('Split the checkout work into two and left the other two as they were.');
    // It sits ABOVE the numbered plan (so the reviewer reads the diff first).
    expect(md.indexOf('What changed')).toBeLessThan(md.indexOf('1. **'));
  });

  test('a fresh round-0 plan with NO changeSummary reads "Proposed breakdown", no "What changed"', () => {
    const md = renderPlanProposal(FANOUT, { autoRun: false });
    expect(md).toContain('Proposed breakdown');
    expect(md).not.toContain('What changed');
  });

  test('F-command-ack-stuck: a changeSummary present (structural command, round 0) shows "Updated" + the diff', () => {
    // A drop/merge/size command edit produces a computed changeSummary without
    // bumping the revise round. The render must still read "Updated breakdown"
    // (it WAS edited — never leave it "Proposed") and lead with the diff.
    const edited: DecompositionPlan = { ...FANOUT, changeSummary: 'Removed “Comparison table”.' };
    const md = renderPlanProposal(edited, { autoRun: false });
    expect(md).toContain('Updated breakdown');
    expect(md).toContain('**What changed:** Removed “Comparison table”.');
    expect(md.indexOf('What changed')).toBeLessThan(md.indexOf('1. **'));
  });

  test('#299 BLOCKER-1: a revision with NO changeSummary (older agent) omits the line cleanly', () => {
    const md = renderPlanProposal(FANOUT, { autoRun: false, revisionRound: 2 });
    expect(md).not.toContain('What changed');
    expect(md).toContain('Updated breakdown'); // still a normal revision render
  });
});

describe('renderRevisingNote / renderRevisionCapNote (#299 revise loop)', () => {
  test('revising note is plain-English + bot-authored, and does NOT leak the round counter', () => {
    const md = renderRevisingNote(2);
    // Customer-caught jargon: no internal "round N" in the ack the reviewer sees.
    expect(md).not.toMatch(/round \d/i);
    expect(md).toMatch(/updating the breakdown/i);
    expect(isBotAuthoredComment(md)).toBe(true);
  });

  test('cap note states the limit, offers approve/reject/relabel, is bot-authored', () => {
    const md = renderRevisionCapNote(3);
    expect(md).toContain('3');
    expect(md).toContain('@bgagent approve');
    expect(md).toContain('@bgagent reject');
    expect(isBotAuthoredComment(md)).toBe(true);
  });

  test('bare-mention nudge lists approve/reject/change and is bot-authored (F-bare-mention)', () => {
    const md = renderPendingPlanNudge();
    expect(md).toContain('@bgagent approve');
    expect(md).toContain('@bgagent reject');
    expect(md).toMatch(/what to change|re-plan/i);
    expect(isBotAuthoredComment(md)).toBe(true);
  });

  test('#299 BLOCKER-2: wrong-mention nudge names the right handle and is bot-authored (no self-loop)', () => {
    const md = renderWrongMentionNudge();
    expect(md).toContain('@bgagent');
    // Bot-authored (👋-prefixed) so parseCommentTrigger/detectNearMissMention skip it.
    expect(isBotAuthoredComment(md)).toBe(true);
    // Steers the reviewer to re-send mentioning the right handle.
    expect(md).toMatch(/re-?send|mention/i);
  });

  test('over-cap REVISION note keeps the prior plan approvable — no "not started"/"re-label" dead-end', () => {
    // F-overcap-revise: distinct from renderCapRejection (round-0). Carries the
    // caps message, points at approve-the-previous + smaller-feedback, bot-authored.
    const md = renderRevisionOverCapNote("This would need **9** sub-issues, over this project's limit of **6**.");
    expect(md).toContain('limit of **6**');
    expect(md).toContain('@bgagent approve');
    expect(md).toMatch(/still here|ready/i);
    expect(md).not.toMatch(/not started/i);
    expect(md).not.toMatch(/re-?label/i);
    expect(isBotAuthoredComment(md)).toBe(true);
  });

  test('revision-failed note is honest, keeps the plan approvable, and NEVER leaks scary internals', () => {
    // Customer-caught: a failed re-plan surfaced a raw "blocked by content policy"
    // that read as if the user misbehaved, plus a dangling "revised plan shortly".
    const md = renderRevisionFailedNote();
    expect(md).not.toMatch(/content policy/i);
    expect(md).not.toMatch(/blocked/i);
    expect(md).not.toMatch(/shortly/i); // no promise it can't keep
    expect(md).toContain('unchanged'); // reassure: current plan is intact
    expect(md).toContain('@bgagent approve');
    expect(isBotAuthoredComment(md)).toBe(true);
  });
});

describe('renderPlanProposal — self-trigger guard (UX.20)', () => {
  // The proposal embeds literal "@bgagent approve" text. The comment-trigger
  // parser MUST treat our own proposal as bot-authored, or posting it would
  // re-trigger ourselves. The prefix glyph is the guard signal.
  test('the rendered proposal is recognised as a bot-authored comment', () => {
    expect(renderPlanProposal(FANOUT, { autoRun: false }).startsWith(PLAN_PROPOSAL_PREFIX)).toBe(true);
    expect(isBotAuthoredComment(renderPlanProposal(FANOUT, { autoRun: false }))).toBe(true);
    expect(isBotAuthoredComment(renderPlanProposal(FANOUT, { autoRun: true }))).toBe(true);
  });

  test('the cap-rejection / single-task / already-decomposed / planner-error / underspecified notes are also bot-authored', () => {
    expect(isBotAuthoredComment(renderCapRejection('over cap'))).toBe(true);
    expect(isBotAuthoredComment(renderSingleTaskNote('small fix'))).toBe(true);
    expect(isBotAuthoredComment(renderAlreadyDecomposedNote())).toBe(true);
    expect(isBotAuthoredComment(renderPlannerErrorNote())).toBe(true);
    expect(isBotAuthoredComment(renderUnderspecifiedDecomposeNote())).toBe(true);
  });

  test('the frozen plan-reference renderers are bot-authored (never re-trigger)', () => {
    // The reference is EDITED IN PLACE onto the proposal comment; it must keep
    // reading as bot-authored so a webhook update-event can't loop.
    expect(isBotAuthoredComment(renderApprovedPlanReference(FANOUT))).toBe(true);
    expect(isBotAuthoredComment(renderDiscardedPlanReference())).toBe(true);
  });
});

describe('renderApprovedPlanReference (#299 plan-cleanup)', () => {
  test('freezes to an "Approved plan" header with the sub-issue count + no action footer', () => {
    const ref = renderApprovedPlanReference(FANOUT);
    expect(ref.startsWith(PLAN_PROPOSAL_PREFIX)).toBe(true);
    expect(ref).toMatch(/Approved plan/);
    expect(ref).toContain('3 sub-issues');
    // The stale approve/reject prompt is GONE (the panel is live now).
    expect(ref).not.toMatch(/@bgagent approve/i);
    expect(ref).not.toMatch(/@bgagent reject/i);
    // Re-lists the agreed breakdown so it reads continuously with what was approved.
    expect(ref).toContain('Pricing route');
    expect(ref).toContain('Stripe checkout');
    // Points at the live panel for status.
    expect(ref).toMatch(/panel below/i);
  });

  test('no "refined over N rounds" footnote on a round-0 (never-revised) plan', () => {
    expect(renderApprovedPlanReference(FANOUT)).not.toMatch(/refined over/i);
    expect(renderApprovedPlanReference(FANOUT, { revisionRound: 0 })).not.toMatch(/refined over/i);
  });

  test('adds a singular/plural-correct "refined over N rounds" footnote when revised', () => {
    expect(renderApprovedPlanReference(FANOUT, { revisionRound: 1 })).toMatch(/refined over 1 round\b/);
    expect(renderApprovedPlanReference(FANOUT, { revisionRound: 3 })).toMatch(/refined over 3 rounds\b/);
  });

  test('preserves dependency notes from the plan (chain vs fan-out)', () => {
    const ref = renderApprovedPlanReference(CHAIN);
    // "API" depends on #1 (Schema) → the "after #1" note carries into the reference.
    expect(ref).toMatch(/after #1/);
  });
});

describe('renderDiscardedPlanReference (#299 plan-cleanup)', () => {
  test('one-line discarded record — nothing ran, no breakdown re-listed', () => {
    const ref = renderDiscardedPlanReference();
    expect(ref.startsWith(PLAN_PROPOSAL_PREFIX)).toBe(true);
    expect(ref).toMatch(/discarded/i);
    expect(ref).toMatch(/nothing ran/i);
    // A discard doesn't re-list sub-issues (there are none to keep).
    expect(ref).not.toMatch(/1\.\s+\*\*/);
  });
});

describe('the note renderers', () => {
  test('cap rejection embeds the cap message', () => {
    expect(renderCapRejection('over the limit of 8')).toContain('over the limit of 8');
  });

  test('single-task note includes the reasoning when present', () => {
    expect(renderSingleTaskNote('one cohesive change')).toContain('one cohesive change');
    expect(renderSingleTaskNote('')).not.toContain('()');
  });

  test('POLISH-6: the :auto single-task note names WHY it started without asking', () => {
    const auto = renderSingleTaskNote('small fix', true);
    expect(auto).toMatch(/:auto|auto-run/i);
    expect(auto).toMatch(/without asking|no approval|starting now/i);
    // The default (non-auto) note stays generic — no auto-run claim.
    const plain = renderSingleTaskNote('small fix');
    expect(plain).not.toMatch(/auto-run label/i);
  });

  test('already-decomposed note explains the no-op', () => {
    expect(renderAlreadyDecomposedNote()).toContain('already has sub-issues');
  });

  test('planner-error note (unusable plan → ran as single) is honest + remedy-bearing, no stale timeout copy', () => {
    const note = renderPlannerErrorNote();
    // Not a fake "single cohesive change" verdict.
    expect(note).not.toMatch(/single cohesive change/i);
    // Tells the user the work fell back to one task (this path DID create one).
    expect(note).toMatch(/single task/i);
    // Carries a concrete remedy (re-apply :decompose OR split manually).
    expect(note).toMatch(/:decompose/);
    expect(note).toMatch(/split the issue/i);
    // The agent-native planner runs on a real substrate — NO "took too long"
    // narrative (that was the retired 30s Lambda, ABCA-490).
    expect(note).not.toMatch(/too long/i);
    expect(note).not.toMatch(/in time/i);
  });

  test('decompose-unavailable note (planning RUN failed → nothing started) is honest: no false "single task"', () => {
    const note = renderDecomposeUnavailableNote();
    // Nothing ran/charged — must NOT claim it's running as a single task.
    expect(note).not.toMatch(/running it as a single task/i);
    expect(note).toMatch(/nothing was run/i);
    // Real next steps: retry planning OR run as one task via the plain label.
    expect(note).toMatch(/:decompose/);
    expect(note).toMatch(/single task/i);
    // No stale timeout narrative.
    expect(note).not.toMatch(/too long/i);
    expect(isBotAuthoredComment(note)).toBe(true);
  });

  test('underspecified-decompose note holds + asks for detail, not a false one-unit claim (ABCA-492)', () => {
    const note = renderUnderspecifiedDecomposeNote();
    expect(note).toMatch(/couldn't confidently break this issue/i);
    expect(note).toMatch(/add a bit more detail/i);
    expect(note).toMatch(/:decompose/); // remedy: re-apply after adding detail
    // must NOT claim it's a single cohesive change (that's the OTHER note)
    expect(note).not.toMatch(/single cohesive change/i);
  });
});

describe('renderLabelHelp / renderMultiPartHint (label discoverability)', () => {
  test('label help explains all three labels, in plain English, and is bot-authored', () => {
    const md = renderLabelHelp('bgagent');
    expect(md).toContain('`bgagent`');
    expect(md).toContain('`bgagent:decompose`');
    expect(md).toContain('`bgagent:auto`');
    // Plain-English intent words, not internal jargon.
    expect(md).toMatch(/pull request/i);
    expect(md).toMatch(/approve/i);
    // Self-trigger guard: our own comment must be recognised as bot-authored.
    expect(isBotAuthoredComment(md)).toBe(true);
  });

  test('label help uses the project custom base label for the LABELS', () => {
    const md = renderLabelHelp('ship');
    expect(md).toContain('`ship`');
    expect(md).toContain('`ship:decompose`');
    expect(md).toContain('`ship:auto`');
  });

  test('PM-2: the reply MENTION is always @bgagent (the app handle), even under a custom label base', () => {
    // The trigger LABEL is renameable (base = 'ship'), but the reply MENTION is
    // the Linear app's actor handle — fixed at @bgagent and the only token the
    // comment trigger fires on. The help used to say `@ship`, which never worked.
    const md = renderLabelHelp('ship');
    expect(md).toContain('`@bgagent <what you want>`');
    expect(md).not.toMatch(/@ship\b/); // must NOT promise a mention that doesn't fire
  });

  test('PM-6: upfront decompose ack — :decompose promises a plan to approve, :auto says it starts', () => {
    const propose = renderDecomposeStartedNote(false);
    expect(propose).toMatch(/on it/i);
    expect(propose).toMatch(/approve/i); // manual mode → a plan you approve first
    expect(isBotAuthoredComment(propose)).toBe(true);

    const auto = renderDecomposeStartedNote(true);
    expect(auto).toMatch(/on it/i);
    expect(auto).toMatch(/start/i); // auto mode → creates the pieces and starts
    // auto has no approval gate, so it must NOT promise an approve step.
    expect(auto).not.toMatch(/to approve/i);
    expect(isBotAuthoredComment(auto)).toBe(true);

    // CONFUSING-3: both branches set an honest expectation ("~1-2 minutes") and
    // drop the vague "shortly" that oversold a 30-120s wait (tester waited 2.5min).
    expect(propose).not.toMatch(/shortly/i);
    expect(propose).toMatch(/1-2 min/i);
    expect(auto).toMatch(/1-2 min/i);
  });

  test('multi-part hint points at :decompose without blocking the run, bot-authored', () => {
    const md = renderMultiPartHint('bgagent');
    expect(md).toMatch(/single task/i); // acknowledges it IS running now
    expect(md).toContain('`bgagent:decompose`'); // the suggested alternative
    expect(md).toMatch(/plan to approve/i);
    expect(isBotAuthoredComment(md)).toBe(true);
  });
});
