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

import { parsePlanVerdict } from '../../../src/handlers/shared/orchestration-comment-trigger';
import {
  applyDecompositionResult,
  runPlanVerdict,
  type DecompositionEffects,
} from '../../../src/handlers/shared/orchestration-decomposition-flow';
import type { DecompositionResult } from '../../../src/handlers/shared/orchestration-decomposition-planner';
import type { DecompositionPlan, ProjectDecompositionCaps } from '../../../src/handlers/shared/orchestration-decomposition-types';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const PARENT = 'parent-uuid';
const CAPS: ProjectDecompositionCaps = { decompose_allowed: true, max_sub_issues: 8 };

/** A fake Linear that creates issues new-<title> and accepts relations. */
function fakeGraphql() {
  let n = 0;
  return jest.fn(async (query: string, vars: Record<string, unknown>) => {
    if (query.includes('query ParentState')) return { issue: { team: { id: 't' }, children: { nodes: [] } } };
    if (query.includes('mutation CreateSubIssue')) {
      n++;
      return { issueCreate: { success: true, issue: { id: `new-${vars.title}`, identifier: `E-${n}` } } };
    }
    if (query.includes('mutation CreateBlockingRelation')) return { issueRelationCreate: { success: true } };
    throw new Error('unexpected');
  });
}

// #299 agent-native planning: the flow no longer invokes a model — the effects
// carry only the write-back / comment / pending-plan boundaries. applyDecompositionResult
// takes an already-parsed plan; runPlanVerdict handles approve/reject.
function effects(over: Partial<DecompositionEffects> = {}): DecompositionEffects {
  return {
    graphql: fakeGraphql(),
    postComment: jest.fn().mockResolvedValue('comment-1'),
    putPendingPlan: jest.fn().mockResolvedValue(true),
    consumePendingPlan: jest.fn().mockResolvedValue(null),
    discardPendingPlan: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('parsePlanVerdict', () => {
  test('bare approve / reject keywords', () => {
    expect(parsePlanVerdict('approve')).toBe('approve');
    expect(parsePlanVerdict('reject')).toBe('reject');
    expect(parsePlanVerdict('Approved!')).toBe('approve');
    expect(parsePlanVerdict('rejected — too many')).toBe('reject');
  });

  test('keyword followed by light filler still counts', () => {
    expect(parsePlanVerdict('approve this plan')).toBe('approve');
    expect(parsePlanVerdict('reject.')).toBe('reject');
  });

  test('NATURAL approvals a real reviewer types (live-confirmed gap)', () => {
    for (const s of ['lgtm', 'LGTM', 'yes', 'yes go ahead', 'sounds good', 'looks good',
      'ok', 'sure', 'proceed', 'ship it', 'do it', '+1', 'go for it', 'send it']) {
      expect(parsePlanVerdict(s)).toBe('approve');
    }
  });

  test('EXPLICIT rejections discard (irreversible → require explicit intent)', () => {
    for (const s of ['reject', 'cancel', 'stop', 'discard', 'abort', 'rejected — too many']) {
      expect(parsePlanVerdict(s)).toBe('reject');
    }
  });

  test('SOFT negations with no change instruction are AMBIGUOUS, not reject (F-reject-revision)', () => {
    // A bare "no" could mean "discard" OR "no, change it" — never guess-and-destroy
    // the plan on the most ambiguous input. The processor nudges the reviewer.
    for (const s of ['no', 'nope', 'nah', "don't", 'do not', '-1', 'no thanks']) {
      expect(parsePlanVerdict(s)).toBe('ambiguous');
    }
  });

  test('emoji verdicts', () => {
    expect(parsePlanVerdict('👍')).toBe('approve');
    expect(parsePlanVerdict('✅ go')).toBe('approve');
    expect(parsePlanVerdict('👎')).toBe('reject');
    expect(parsePlanVerdict('🛑 not yet')).toBe('reject');
  });

  test('a soft negation over an affirmative is AMBIGUOUS, not approve (and not a destroy)', () => {
    // "don't approve" must NOT read as approve; but a bare soft negation is also not
    // an explicit discard → ambiguous (nudge), never reject.
    expect(parsePlanVerdict("don't approve this")).toBe('ambiguous');
    expect(parsePlanVerdict('no, looks wrong')).toBe('ambiguous'); // pure negativity, no change instruction
  });

  test('a LONG work request that merely contains a verdict word is NOT a verdict', () => {
    // >6 words and not verdict-first → treated as an edit instruction, not approval.
    expect(parsePlanVerdict('also approve the dialog copy and rename the button')).toBe('none');
    expect(parsePlanVerdict('change the approval banner color to green please')).toBe('none');
    expect(parsePlanVerdict('the yes button should be larger and more prominent now')).toBe('none');
  });

  test('F-reject-revision: a LONG instruction LED BY a verdict word is a CHANGE REQUEST, not a verdict', () => {
    // Destructive live bug: these were parsed as reject/approve on the first word,
    // deleting the pending plan. A long comment is always a re-plan (→ 'none'),
    // regardless of its leading word.
    expect(parsePlanVerdict('no, go back to just two sub-issues: one API and one UI')).toBe('none');
    expect(parsePlanVerdict("don't split the schema work — keep it as a single task please")).toBe('none');
    expect(parsePlanVerdict('yes but also split the API into three endpoints and add tests')).toBe('none');
    expect(parsePlanVerdict('stop making the UI its own sub-issue and merge it into the API one')).toBe('none');
  });

  test('short verdicts still classify (the fix must not over-correct)', () => {
    // ≤6 words → verdict, including verdict-first with a little trailing text.
    expect(parsePlanVerdict('reject this plan')).toBe('reject'); // explicit discard
    expect(parsePlanVerdict('approve')).toBe('approve');
    expect(parsePlanVerdict('yes, this is the right breakdown')).toBe('approve'); // 6 words
    // Emoji is a verdict at any length.
    expect(parsePlanVerdict('👎 this whole breakdown is wrong, redo the api layer entirely')).toBe('reject');
  });

  test('F-short-negation-instruction: a SHORT negation carrying a change instruction REVISES, not discards (ABCA-562)', () => {
    // Live-caught destructive residual: "no, just 2 tasks" was short + firstWord
    // "no" → reject → the pending plan was DELETED. A negation followed by a change
    // instruction (verb or count) is a re-plan → 'none' → the revise loop.
    expect(parsePlanVerdict('no, just 2 tasks')).toBe('none');
    expect(parsePlanVerdict('no, make it 3 tasks')).toBe('none');
    expect(parsePlanVerdict("don't split the API")).toBe('none');
    expect(parsePlanVerdict('no, merge 1 and 2')).toBe('none');
    expect(parsePlanVerdict('nope, keep it as one')).toBe('none');
    expect(parsePlanVerdict('no, into 4 sub-issues')).toBe('none');
    expect(parsePlanVerdict('no, just 3')).toBe('none'); // count directive w/o a unit noun
  });

  test('a verdict-first short comment still wins even with trailing words', () => {
    expect(parsePlanVerdict('approve but watch the schema migration')).toBe('approve');
    expect(parsePlanVerdict('yes, this is the right breakdown')).toBe('approve');
  });

  test('empty / unrelated → none', () => {
    expect(parsePlanVerdict('')).toBe('none');
    expect(parsePlanVerdict('make the header blue')).toBe('none');
    expect(parsePlanVerdict('what does the third sub-issue cover?')).toBe('none');
  });
});

describe('applyDecompositionResult — #299 agent-native entry (pre-parsed plan, no model call)', () => {
  const PLAN: DecompositionPlan = {
    shouldDecompose: true,
    reasoning: 'two units',
    nodes: [
      { title: 'A', description: 'a', size: 'S', max_budget_usd: 1, depends_on: [] },
      { title: 'B', description: 'b', size: 'M', max_budget_usd: 3, depends_on: [0] },
    ],
  };
  const planResult: DecompositionResult = { kind: 'plan', plan: PLAN };

  test('manual (:decompose) → proposal + pending plan, handled/awaiting; never invokes a model', async () => {
    const e = effects();
    const r = await applyDecompositionResult({
      parentIssueId: PARENT,
      planned: planResult,
      underspecified: false,
      caps: CAPS,
      autoRun: false,
      effects: e,
    });
    expect(r).toEqual({ kind: 'handled', reason: 'awaiting_approval' });
    expect((e.postComment as jest.Mock).mock.calls[0][1]).toContain('@bgagent approve');
    expect((e.putPendingPlan as jest.Mock).mock.calls[0][0].proposalCommentId).toBe('comment-1');
    // Manual mode does NOT write back yet (no model invoke exists on this path).
    expect(e.graphql).not.toHaveBeenCalled();
  });

  test('#299 T2: a plan carrying repoDigest+sha threads them into putPendingPlan', async () => {
    const e = effects();
    const withDigest: DecompositionResult = {
      kind: 'plan', plan: PLAN, repoDigest: 'modules: api/, ui/', repoDigestSha: 'a1b2c3d4',
    };
    await applyDecompositionResult({
      parentIssueId: PARENT, planned: withDigest, underspecified: false, caps: CAPS, autoRun: false, effects: e,
    });
    const put = (e.putPendingPlan as jest.Mock).mock.calls[0][0];
    expect(put.repoDigest).toBe('modules: api/, ui/');
    expect(put.repoDigestSha).toBe('a1b2c3d4');
  });

  test('#299 F-revise-in-place: a revision with priorProposalCommentId EDITS that comment in place', async () => {
    const e = effects({ postComment: jest.fn().mockResolvedValue('plan-comment-1') });
    await applyDecompositionResult({
      parentIssueId: PARENT,
      planned: { kind: 'plan', plan: PLAN },
      underspecified: false,
      caps: CAPS,
      autoRun: false,
      revisionRound: 1,
      priorProposalCommentId: 'plan-comment-1',
      effects: e,
    });
    // postComment called with the existing comment id (3rd arg) → edit in place,
    // NOT a fresh post.
    const call = (e.postComment as jest.Mock).mock.calls[0];
    expect(call[2]).toBe('plan-comment-1');
    // Only one postComment (no fresh fallback, since the edit "succeeded").
    expect((e.postComment as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  test('#299 F-revise-in-place: a failed in-place edit (null) falls back to a fresh post', async () => {
    // First call (edit attempt) returns null → the revised plan must still land.
    const postComment = jest.fn()
      .mockResolvedValueOnce(null) // edit-in-place failed (comment gone)
      .mockResolvedValueOnce('new-comment'); // fresh fallback
    const e = effects({ postComment });
    const r = await applyDecompositionResult({
      parentIssueId: PARENT,
      planned: { kind: 'plan', plan: PLAN },
      underspecified: false,
      caps: CAPS,
      autoRun: false,
      revisionRound: 2,
      priorProposalCommentId: 'stale-id',
      effects: e,
    });
    expect(postComment).toHaveBeenCalledTimes(2); // edit attempt + fresh fallback
    expect(postComment.mock.calls[0][2]).toBe('stale-id'); // tried in place
    expect(postComment.mock.calls[1][2]).toBeUndefined(); // then fresh
    // The pending plan is persisted with the fallback comment id.
    expect((e.putPendingPlan as jest.Mock).mock.calls[0][0].proposalCommentId).toBe('new-comment');
    expect(r.kind).toBe('handled');
  });

  test('auto (:auto) → writes back immediately, returns a seed graph with real ids', async () => {
    const e = effects();
    const r = await applyDecompositionResult({
      parentIssueId: PARENT,
      planned: planResult,
      underspecified: false,
      caps: CAPS,
      autoRun: true,
      effects: e,
    });
    expect(r.kind).toBe('seed');
    if (r.kind === 'seed') {
      expect(r.children.map((c) => c.id)).toEqual(['new-A', 'new-B']);
      expect(r.children[1].depends_on).toEqual(['new-A']);
      // #299 plan-cleanup: the :auto seed carries the proposal comment id (the
      // effects mock's postComment returns 'comment-1') so the seed site can
      // freeze it into the "Approved plan" reference.
      expect(r.proposalCommentId).toBe('comment-1');
    }
    expect(e.putPendingPlan).not.toHaveBeenCalled();
  });

  test('agent decline is TRUSTED (underspecified:false), NOT the ask-for-detail path', async () => {
    // The agent planned with full repo context, so a decline is a confident
    // one-cohesive-unit judgement — even for a short reasoning. The reconciler
    // always passes underspecified:false; assert we never route to the HOLD note.
    // (autoRun:true = :auto → runs immediately; the :decompose GATE is tested below.)
    const e = effects();
    const declined: DecompositionResult = { kind: 'single_task', reasoning: 'one cohesive change' };
    const r = await applyDecompositionResult({
      parentIssueId: PARENT,
      planned: declined,
      underspecified: false,
      caps: CAPS,
      autoRun: true,
      effects: e,
    });
    expect(r).toEqual({ kind: 'single_task', reason: 'judge_declined' });
    const note = (e.postComment as jest.Mock).mock.calls[0][1];
    expect(note).toMatch(/single cohesive change/i);
    expect(note).not.toMatch(/add a bit more detail/i);
  });

  test('#299 F-single-gate: :decompose decline PROPOSES a single task + persists pending_kind:single (no auto-run)', async () => {
    const e = effects();
    const declined: DecompositionResult = { kind: 'single_task', reasoning: 'one cohesive change' };
    const r = await applyDecompositionResult({
      parentIssueId: PARENT,
      planned: declined,
      underspecified: false,
      caps: CAPS,
      autoRun: false, // :decompose (approve-first)
      singleTaskDescription: 'ABC-1: do the thing\n\nfull body',
      effects: e,
    });
    // Gated: handled + awaiting approval, NOT single_task (which would auto-run).
    expect(r).toEqual({ kind: 'handled', reason: 'awaiting_single_approval' });
    const note = (e.postComment as jest.Mock).mock.calls[0][1] as string;
    expect(note).toMatch(/@bgagent approve/);
    expect(note).toMatch(/haven't started/i);
    // Persisted a single-kind pending plan carrying the description approve will run.
    const put = (e.putPendingPlan as jest.Mock).mock.calls[0][0];
    expect(put.pendingKind).toBe('single');
    expect(put.singleTaskDescription).toBe('ABC-1: do the thing\n\nfull body');
    expect(put.nodes).toEqual([]);
  });

  test('#299 F-single-gate: :auto decline still auto-runs (opted out of approval)', async () => {
    const e = effects();
    const declined: DecompositionResult = { kind: 'single_task', reasoning: 'one cohesive change' };
    const r = await applyDecompositionResult({
      parentIssueId: PARENT,
      planned: declined,
      underspecified: false,
      caps: CAPS,
      autoRun: true, // :auto
      singleTaskDescription: 'ABC-1: do the thing',
      effects: e,
    });
    expect(r).toEqual({ kind: 'single_task', reason: 'judge_declined' });
    expect(e.putPendingPlan).not.toHaveBeenCalled();
    // POLISH-6: the :auto note names WHY it started without asking.
    const note = (e.postComment as jest.Mock).mock.calls[0][1] as string;
    expect(note).toMatch(/:auto|auto-run/i);
  });

  test('#299 F-single-gate: :decompose decline WITHOUT a description falls back to auto-run (back-compat)', async () => {
    const e = effects();
    const declined: DecompositionResult = { kind: 'single_task', reasoning: 'cohesive' };
    const r = await applyDecompositionResult({
      parentIssueId: PARENT, planned: declined, underspecified: false, caps: CAPS, autoRun: false, effects: e,
    });
    expect(r).toEqual({ kind: 'single_task', reason: 'judge_declined' });
    expect(e.putPendingPlan).not.toHaveBeenCalled();
  });

  test('unparseable/invalid plan (kind:error) → honest planner-error note + single_task', async () => {
    const e = effects();
    const errResult: DecompositionResult = { kind: 'error', message: 'bad plan' };
    const r = await applyDecompositionResult({
      parentIssueId: PARENT,
      planned: errResult,
      underspecified: false,
      caps: CAPS,
      autoRun: true,
      effects: e,
    });
    expect(r).toEqual({ kind: 'single_task', reason: 'planner_error' });
    // Honest "couldn't make a clean breakdown → running as one task" note; no
    // stale "took too long" timeout narrative (retired with the inline planner).
    const note = (e.postComment as jest.Mock).mock.calls[0][1] as string;
    expect(note).toMatch(/couldn't turn this into a clean breakdown/i);
    expect(note).toMatch(/single task/i);
    expect(note).not.toMatch(/too long/i);
    expect(e.graphql).not.toHaveBeenCalled();
  });

  test('over-cap plan → rejection comment, handled/too_many_sub_issues (no write-back)', async () => {
    const e = effects();
    const r = await applyDecompositionResult({
      parentIssueId: PARENT,
      planned: planResult,
      underspecified: false,
      caps: { decompose_allowed: true, max_sub_issues: 1 },
      autoRun: true,
      effects: e,
    });
    expect(r).toEqual({ kind: 'handled', reason: 'too_many_sub_issues' });
    expect(e.graphql).not.toHaveBeenCalled();
  });

  test('F-overcap-revise: over-cap on a REVISION posts a revision-aware note (keeps the prior plan approvable)', async () => {
    const e = effects();
    const r = await applyDecompositionResult({
      parentIssueId: PARENT,
      planned: planResult,
      underspecified: false,
      caps: { decompose_allowed: true, max_sub_issues: 1 },
      autoRun: false,
      revisionRound: 2,
      effects: e,
    });
    expect(r).toEqual({ kind: 'handled', reason: 'too_many_sub_issues' });
    const note = (e.postComment as jest.Mock).mock.calls[0][1] as string;
    // Revision-aware: points at approve-the-previous + smaller feedback; does NOT
    // claim "not started" (the prior plan IS still pending).
    expect(note).toMatch(/still here|approve/i);
    expect(note).not.toMatch(/not started/i);
    expect(note).not.toMatch(/re-?label/i);
    // Does not consume/overwrite the pending plan.
    expect(e.consumePendingPlan).not.toHaveBeenCalled();
    expect(e.putPendingPlan).not.toHaveBeenCalled();
    expect(e.graphql).not.toHaveBeenCalled();
  });

  test('over-cap on ROUND 0 (no revision) still uses the "not started" rejection copy', async () => {
    const e = effects();
    const r = await applyDecompositionResult({
      parentIssueId: PARENT,
      planned: planResult,
      underspecified: false,
      caps: { decompose_allowed: true, max_sub_issues: 1 },
      autoRun: false,
      effects: e,
    });
    expect(r.kind).toBe('handled');
    const note = (e.postComment as jest.Mock).mock.calls[0][1] as string;
    expect(note).toMatch(/not started/i);
  });
});

describe('runPlanVerdict — approve', () => {
  test('consumes the pending plan, writes back, returns seed graph', async () => {
    const e = effects({
      consumePendingPlan: jest.fn().mockResolvedValue({
        nodes: [
          { title: 'A', description: 'a', size: 'S', max_budget_usd: 1, depends_on: [] },
          { title: 'B', description: 'b', size: 'M', max_budget_usd: 3, depends_on: [0] },
        ],
      }),
    });
    const r = await runPlanVerdict({ parentIssueId: PARENT, verdict: 'approve', effects: e });
    expect(r.kind).toBe('seed');
    if (r.kind === 'seed') expect(r.children.map((c) => c.id)).toEqual(['new-A', 'new-B']);
    expect(e.consumePendingPlan).toHaveBeenCalledTimes(1);
  });

  test('no pending plan (already consumed / not a verdict on a live plan) → noop', async () => {
    const e = effects({ consumePendingPlan: jest.fn().mockResolvedValue(null) });
    const r = await runPlanVerdict({ parentIssueId: PARENT, verdict: 'approve', effects: e });
    expect(r).toEqual({ kind: 'noop', reason: 'no_pending_plan' });
    expect(e.graphql).not.toHaveBeenCalled();
  });

  test('write-back failure on approve → terminal error comment', async () => {
    const e = effects({
      consumePendingPlan: jest.fn().mockResolvedValue({ nodes: [{ title: 'A', description: 'a', size: 'S', max_budget_usd: 1, depends_on: [] }, { title: 'B', description: 'b', size: 'S', max_budget_usd: 1, depends_on: [0] }] }),
      graphql: jest.fn().mockResolvedValue(null), // state query fails → write-back error
    });
    const r = await runPlanVerdict({ parentIssueId: PARENT, verdict: 'approve', effects: e });
    expect(r).toEqual({ kind: 'handled', reason: 'writeback_error' });
  });

  test('write-back failure RESTORES the consumed pending plan (so re-approve resumes)', async () => {
    // The consume happens before write-back (race protection); if write-back
    // fails, the plan must be put back or "re-approving will resume" is a lie.
    const nodes = [
      { title: 'A', description: 'a', size: 'S' as const, max_budget_usd: 1, depends_on: [] },
      { title: 'B', description: 'b', size: 'S' as const, max_budget_usd: 1, depends_on: [0] },
    ];
    const e = effects({
      consumePendingPlan: jest.fn().mockResolvedValue({ nodes }),
      graphql: jest.fn().mockResolvedValue(null), // write-back errors
      putPendingPlan: jest.fn().mockResolvedValue(true),
    });
    const r = await runPlanVerdict({ parentIssueId: PARENT, verdict: 'approve', effects: e });
    expect(r.reason).toBe('writeback_error');
    // The plan was put back with the same nodes.
    expect(e.putPendingPlan).toHaveBeenCalledTimes(1);
    expect((e.putPendingPlan as jest.Mock).mock.calls[0][0].nodes).toEqual(nodes);
  });

  test('a successful approve does NOT restore a pending plan', async () => {
    const e = effects({
      consumePendingPlan: jest.fn().mockResolvedValue({
        nodes: [
          { title: 'A', description: 'a', size: 'S' as const, max_budget_usd: 1, depends_on: [] },
          { title: 'B', description: 'b', size: 'S' as const, max_budget_usd: 1, depends_on: [0] },
        ],
      }),
    });
    const r = await runPlanVerdict({ parentIssueId: PARENT, verdict: 'approve', effects: e });
    expect(r.kind).toBe('seed');
    expect(e.putPendingPlan).not.toHaveBeenCalled();
  });
});

describe('runPlanVerdict — reject', () => {
  test('consumes + discards + posts a discard note', async () => {
    const e = effects({ consumePendingPlan: jest.fn().mockResolvedValue({ nodes: [] }) });
    const r = await runPlanVerdict({ parentIssueId: PARENT, verdict: 'reject', effects: e });
    expect(r).toEqual({ kind: 'handled', reason: 'rejected' });
    expect(e.discardPendingPlan).toHaveBeenCalledTimes(1);
    expect((e.postComment as jest.Mock).mock.calls[0][1]).toContain('discarded');
  });

  test('reject with no pending plan → noop', async () => {
    const e = effects({ consumePendingPlan: jest.fn().mockResolvedValue(null) });
    const r = await runPlanVerdict({ parentIssueId: PARENT, verdict: 'reject', effects: e });
    expect(r.kind).toBe('noop');
  });
});
