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
