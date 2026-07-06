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
  renderCapRejection,
  renderLabelHelp,
  renderMultiPartHint,
  renderPlannerErrorNote,
  renderPlanProposal,
  renderRevisingNote,
  renderRevisionCapNote,
  renderRevisionFailedNote,
  renderSingleTaskNote,
  renderUnderspecifiedDecomposeNote,
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

  test('a chain (cp>1) says how many run one after another, in plain English', () => {
    const md = renderPlanProposal(CHAIN, { autoRun: false }); // 3-deep chain
    expect(md).toContain('3 run one after another');
    expect(md).not.toMatch(/critical path/i);
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
});

describe('the note renderers', () => {
  test('cap rejection embeds the cap message', () => {
    expect(renderCapRejection('over the limit of 8')).toContain('over the limit of 8');
  });

  test('single-task note includes the reasoning when present', () => {
    expect(renderSingleTaskNote('one cohesive change')).toContain('one cohesive change');
    expect(renderSingleTaskNote('')).not.toContain('()');
  });

  test('already-decomposed note explains the no-op', () => {
    expect(renderAlreadyDecomposedNote()).toContain('already has sub-issues');
  });

  test('planner-error note is honest + remedy-bearing, NOT the "single cohesive change" copy (ABCA-490)', () => {
    const note = renderPlannerErrorNote();
    // Honest about the failure, not a fake "single cohesive change" verdict.
    expect(note).toMatch(/couldn't plan a breakdown/i);
    expect(note).not.toMatch(/single cohesive change/i);
    // Still tells the user the work falls back to one task.
    expect(note).toMatch(/single task/i);
    // Carries a concrete remedy (re-apply :decompose OR split manually).
    expect(note).toMatch(/:decompose/);
    expect(note).toMatch(/split the issue/i);
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

  test('label help uses the project custom base label everywhere', () => {
    const md = renderLabelHelp('ship');
    expect(md).toContain('`ship`');
    expect(md).toContain('`ship:decompose`');
    expect(md).toContain('`ship:auto`');
    expect(md).not.toContain('bgagent');
  });

  test('multi-part hint points at :decompose without blocking the run, bot-authored', () => {
    const md = renderMultiPartHint('bgagent');
    expect(md).toMatch(/single task/i); // acknowledges it IS running now
    expect(md).toContain('`bgagent:decompose`'); // the suggested alternative
    expect(md).toMatch(/plan to approve/i);
    expect(isBotAuthoredComment(md)).toBe(true);
  });
});
