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
  runDecompositionProposal,
  runPlanVerdict,
  type DecompositionEffects,
} from '../../../src/handlers/shared/orchestration-decomposition-flow';
import type { DecompositionResult, PlannerInput } from '../../../src/handlers/shared/orchestration-decomposition-planner';
import type { DecompositionPlan, ProjectDecompositionCaps } from '../../../src/handlers/shared/orchestration-decomposition-types';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const PARENT = 'parent-uuid';
// A WELL-SPECIFIED input: description long enough that a decline is trusted as a
// genuine one-cohesive-unit judgement (not "underspecified"). ABCA-492 added the
// thin-description guard — the shared input must be substantial so the existing
// judge_declined tests exercise the confident-decline path, not the ask-for-detail one.
const PLANNER_INPUT: PlannerInput = {
  title: 'T',
  description: 'This change reworks the single authentication middleware so that token '
    + 'validation, refresh, and error mapping all live in one cohesive module with a shared '
    + 'config surface. The pieces are tightly coupled and only make sense together: the refresh '
    + 'path reads the same in-memory token cache the validation path writes, and the error mapper '
    + 'translates failures from both into a single response contract. Splitting these across '
    + 'sub-issues would force error-prone hand-offs over shared mutable state with no standalone '
    + 'value per piece, so this is deliberately described as one well-specified cohesive unit.',
  repo: 'a/b',
  maxSubIssues: 8,
};
const CAPS: ProjectDecompositionCaps = { decompose_allowed: true, max_sub_issues: 8 };

/** The decomposer's 2-node chain breakdown (stage 2 shape). */
const CHAIN_PLAN = JSON.stringify({
  reasoning: 'two units',
  sub_issues: [
    { title: 'A', description: 'a', size: 'S', depends_on: [] },
    { title: 'B', description: 'b', size: 'M', depends_on: [0] },
  ],
});

/**
 * A two-stage planner mock: returns the assessor verdict for stage-1 prompts
 * (they ask for ``"decompose": boolean``) and the decomposer breakdown for
 * stage-2 prompts. ``decompose`` controls the assessor's verdict.
 */
function twoStageInvoke(decompose: boolean, plan: string = CHAIN_PLAN): jest.Mock {
  return jest.fn(async (prompt: string) => {
    if (prompt.includes('"decompose": boolean')) {
      return JSON.stringify({ decompose, reasoning: decompose ? 'multi-part' : 'cohesive' });
    }
    return plan; // stage 2 — the decomposer breakdown
  });
}

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

function effects(over: Partial<DecompositionEffects> = {}): DecompositionEffects {
  return {
    invokeModel: twoStageInvoke(true),
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

  test('NATURAL rejections', () => {
    for (const s of ['no', 'nope', 'cancel', 'stop', 'discard', 'abort', "don't", '-1']) {
      expect(parsePlanVerdict(s)).toBe('reject');
    }
  });

  test('emoji verdicts', () => {
    expect(parsePlanVerdict('👍')).toBe('approve');
    expect(parsePlanVerdict('✅ go')).toBe('approve');
    expect(parsePlanVerdict('👎')).toBe('reject');
    expect(parsePlanVerdict('🛑 not yet')).toBe('reject');
  });

  test('reject wins when both signals appear', () => {
    expect(parsePlanVerdict("don't approve this")).toBe('reject');
    expect(parsePlanVerdict('no, looks wrong')).toBe('reject');
  });

  test('a LONG work request that merely contains a verdict word is NOT a verdict', () => {
    // >6 words and not verdict-first → treated as an edit instruction, not approval.
    expect(parsePlanVerdict('also approve the dialog copy and rename the button')).toBe('none');
    expect(parsePlanVerdict('change the approval banner color to green please')).toBe('none');
    expect(parsePlanVerdict('the yes button should be larger and more prominent now')).toBe('none');
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

describe('runDecompositionProposal — manual (:decompose)', () => {
  test('posts a proposal + persists a pending plan, returns handled/awaiting', async () => {
    const e = effects();
    const r = await runDecompositionProposal({ parentIssueId: PARENT, plannerInput: PLANNER_INPUT, caps: CAPS, autoRun: false, effects: e });
    expect(r).toEqual({ kind: 'handled', reason: 'awaiting_approval' });
    expect(e.postComment).toHaveBeenCalledTimes(1);
    expect((e.postComment as jest.Mock).mock.calls[0][1]).toContain('@bgagent approve');
    expect(e.putPendingPlan).toHaveBeenCalledTimes(1);
    // The proposal comment id is threaded into the pending plan.
    expect((e.putPendingPlan as jest.Mock).mock.calls[0][0].proposalCommentId).toBe('comment-1');
    // Manual mode does NOT write back yet.
    expect(e.graphql).not.toHaveBeenCalled();
  });

  test('a redelivery (pending plan already existed) → noop', async () => {
    const e = effects({ putPendingPlan: jest.fn().mockResolvedValue(false) });
    const r = await runDecompositionProposal({ parentIssueId: PARENT, plannerInput: PLANNER_INPUT, caps: CAPS, autoRun: false, effects: e });
    expect(r.kind).toBe('noop');
  });
});

describe('runDecompositionProposal — auto (:auto)', () => {
  test('writes back immediately and returns a seed graph with real ids', async () => {
    const e = effects();
    const r = await runDecompositionProposal({ parentIssueId: PARENT, plannerInput: PLANNER_INPUT, caps: CAPS, autoRun: true, effects: e });
    expect(r.kind).toBe('seed');
    if (r.kind === 'seed') {
      expect(r.children.map((c) => c.id)).toEqual(['new-A', 'new-B']);
      expect(r.children[1].depends_on).toEqual(['new-A']);
    }
    // Auto posts the proposal (informational) and does NOT persist a pending plan.
    expect(e.putPendingPlan).not.toHaveBeenCalled();
    expect((e.postComment as jest.Mock).mock.calls[0][1]).toContain('Auto-run is on');
  });
});

describe('runDecompositionProposal — judge + caps gates', () => {
  test(':auto + one-cohesive-unit verdict → single_task, one model call, no write-back', async () => {
    // The assessor's verdict stands; the decomposer is never reached.
    const invokeModel = twoStageInvoke(false);
    const e = effects({ invokeModel });
    const r = await runDecompositionProposal({ parentIssueId: PARENT, plannerInput: PLANNER_INPUT, caps: CAPS, autoRun: true, effects: e });
    expect(r).toEqual({ kind: 'single_task', reason: 'judge_declined' });
    expect(invokeModel).toHaveBeenCalledTimes(1); // assessor only, no decomposer
    expect(e.putPendingPlan).not.toHaveBeenCalled();
  });

  test(':decompose + one-cohesive-unit verdict → single_task with reasoning (NO forced plan)', async () => {
    // The agent's assessment drives for BOTH labels. On an explicit :decompose the
    // verdict still stands — we post the reasoning and run one task; we do NOT
    // manufacture a breakdown the assessor judged incoherent (that could only be
    // the layer-split anti-pattern). The label affects only the approval gate.
    const invokeModel = twoStageInvoke(false);
    const e = effects({ invokeModel });
    const r = await runDecompositionProposal({ parentIssueId: PARENT, plannerInput: PLANNER_INPUT, caps: CAPS, autoRun: false, effects: e });
    expect(r).toEqual({ kind: 'single_task', reason: 'judge_declined' });
    expect(invokeModel).toHaveBeenCalledTimes(1); // assessor only — decomposer never forced
    expect(e.putPendingPlan).not.toHaveBeenCalled();
    // posts the single-task note explaining WHY it wasn't split (the reasoning)
    const note = (e.postComment as jest.Mock).mock.calls[0][1];
    expect(note).toMatch(/single cohesive change/i);
    expect(note).toContain('cohesive'); // the assessor's rationale
  });

  test('ABCA-492: :decompose + decline on a THIN issue → HOLD + ask for detail, NO single task', async () => {
    // A one-line ":decompose" epic the planner declined: we can't trust "one
    // cohesive unit" (the planner may just have had nothing to find seams in),
    // and silently running one giant task is the worst outcome for a spend-safe
    // request. Hold (kind: handled) and post the underspecified note — do NOT
    // fall through to a single task.
    const invokeModel = twoStageInvoke(false); // assessor declines
    const e = effects({ invokeModel });
    const thin: PlannerInput = { title: 'slack parity with linear', description: 'make slack like linear', repo: 'a/b', maxSubIssues: 8 };
    const r = await runDecompositionProposal({ parentIssueId: PARENT, plannerInput: thin, caps: CAPS, autoRun: false, effects: e });
    expect(r).toEqual({ kind: 'handled', reason: 'underspecified' });
    const note = (e.postComment as jest.Mock).mock.calls[0][1];
    expect(note).toMatch(/couldn't confidently break this issue/i);
    expect(note).toMatch(/add a bit more detail/i);
    expect(note).not.toMatch(/single cohesive change/i); // NOT the confident-decline copy
  });

  test('ABCA-492: a thin issue with repo context that STILL declines is treated as underspecified (asks for detail)', async () => {
    // The description is the issue-specific scope signal; repo context is generic
    // background and can be present yet a decline still be wrong (ABCA-492 live).
    // So a thin description that declines → ask for detail regardless of context.
    const invokeModel = twoStageInvoke(false);
    const e = effects({ invokeModel });
    const thinWithCtx: PlannerInput = { title: 'slack parity', description: 'do the slack thing', repo: 'a/b', maxSubIssues: 8, repoContext: 'README: a big platform\nsrc/... many files' };
    const r = await runDecompositionProposal({ parentIssueId: PARENT, plannerInput: thinWithCtx, caps: CAPS, autoRun: false, effects: e });
    expect(r).toEqual({ kind: 'handled', reason: 'underspecified' });
  });

  test('planner error → HONEST error note (not "single cohesive change") + single_task fallback', async () => {
    // ABCA-490: a planner error/timeout must NOT be dressed up as a "single
    // cohesive change" verdict — that's a lie when the truth is the planner
    // failed. Assert the note explains it couldn't plan + gives a remedy, and is
    // distinct from the judge-declined single-task copy.
    const e = effects({ invokeModel: jest.fn().mockRejectedValue(new Error('bedrock down')) });
    const r = await runDecompositionProposal({ parentIssueId: PARENT, plannerInput: PLANNER_INPUT, caps: CAPS, autoRun: false, effects: e });
    expect(r).toEqual({ kind: 'single_task', reason: 'planner_error' });
    const note = (e.postComment as jest.Mock).mock.calls[0][1];
    expect(note).not.toMatch(/single cohesive change/i);
    expect(note).toMatch(/couldn't plan a breakdown/i);
    expect(note).toMatch(/single task/i); // still honest that it falls back to one task
    expect(note).toMatch(/:decompose|split the issue/i); // remedy present
  });

  test('planner TIMEOUT (AbortSignal.timeout fires) → same honest error path', async () => {
    // ABCA-490 core: the real failure is a slow call aborted by the client
    // deadline, surfacing as a TimeoutError — the flow must treat it exactly like
    // any planner error (honest note + single-task fallback), NOT hang.
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    const e = effects({ invokeModel: jest.fn().mockRejectedValue(timeoutErr) });
    const r = await runDecompositionProposal({ parentIssueId: PARENT, plannerInput: PLANNER_INPUT, caps: CAPS, autoRun: false, effects: e });
    expect(r).toEqual({ kind: 'single_task', reason: 'planner_error' });
    expect((e.postComment as jest.Mock).mock.calls[0][1]).toMatch(/couldn't plan a breakdown/i);
  });

  test('over-cap plan → rejection comment, handled/too_many_sub_issues (never trimmed/seeded, NOT a single giant task)', async () => {
    const e = effects();
    const tightCaps: ProjectDecompositionCaps = { decompose_allowed: true, max_sub_issues: 1 };
    const r = await runDecompositionProposal({ parentIssueId: PARENT, plannerInput: PLANNER_INPUT, caps: tightCaps, autoRun: true, effects: e });
    expect(r).toEqual({ kind: 'handled', reason: 'too_many_sub_issues' });
    expect((e.postComment as jest.Mock).mock.calls[0][1]).toContain('limit');
    expect(e.graphql).not.toHaveBeenCalled(); // no write-back on rejection
  });

  test('decompose disabled → single-task note, single_task/not_allowed', async () => {
    const e = effects();
    const r = await runDecompositionProposal({ parentIssueId: PARENT, plannerInput: PLANNER_INPUT, caps: { decompose_allowed: false, max_sub_issues: 8 }, autoRun: false, effects: e });
    expect(r).toEqual({ kind: 'single_task', reason: 'not_allowed' });
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
    // The tail never plans — invokeModel isn't even on the Pick'd effects here.
    expect(e.invokeModel).not.toHaveBeenCalled();
    expect(e.graphql).not.toHaveBeenCalled();
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
    }
    expect(e.putPendingPlan).not.toHaveBeenCalled();
  });

  test('agent decline is TRUSTED (underspecified:false) → single_task, NOT the ask-for-detail path', async () => {
    // The agent planned with full repo context, so a decline is a confident
    // one-cohesive-unit judgement — even for a short reasoning. The reconciler
    // always passes underspecified:false; assert we never route to the HOLD note.
    const e = effects();
    const declined: DecompositionResult = { kind: 'single_task', reasoning: 'one cohesive change' };
    const r = await applyDecompositionResult({
      parentIssueId: PARENT,
      planned: declined,
      underspecified: false,
      caps: CAPS,
      autoRun: false,
      effects: e,
    });
    expect(r).toEqual({ kind: 'single_task', reason: 'judge_declined' });
    const note = (e.postComment as jest.Mock).mock.calls[0][1];
    expect(note).toMatch(/single cohesive change/i);
    expect(note).not.toMatch(/add a bit more detail/i);
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
    expect((e.postComment as jest.Mock).mock.calls[0][1]).toMatch(/couldn't plan a breakdown/i);
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
