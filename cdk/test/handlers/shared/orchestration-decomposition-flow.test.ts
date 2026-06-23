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
  runDecompositionProposal,
  runPlanVerdict,
  type DecompositionEffects,
} from '../../../src/handlers/shared/orchestration-decomposition-flow';
import type { PlannerInput } from '../../../src/handlers/shared/orchestration-decomposition-planner';
import type { ProjectDecompositionCaps } from '../../../src/handlers/shared/orchestration-decomposition-types';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const PARENT = 'parent-uuid';
const PLANNER_INPUT: PlannerInput = { title: 'T', description: 'd', repo: 'a/b', maxSubIssues: 8 };
const CAPS: ProjectDecompositionCaps = { decompose_allowed: true, max_sub_issues: 8 };

/** A planner response that decomposes into a 2-node chain. */
const CHAIN_PLAN = JSON.stringify({
  should_decompose: true,
  reasoning: 'two units',
  sub_issues: [
    { title: 'A', description: 'a', size: 'S', depends_on: [] },
    { title: 'B', description: 'b', size: 'M', depends_on: [0] },
  ],
});

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
    invokeModel: jest.fn().mockResolvedValue(CHAIN_PLAN),
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

  test('a word merely CONTAINING approve in a work request is not a verdict', () => {
    expect(parsePlanVerdict('also approve the dialog copy and rename the button')).toBe('none');
    expect(parsePlanVerdict('change the approval banner color')).toBe('none');
  });

  test('empty / unrelated → none', () => {
    expect(parsePlanVerdict('')).toBe('none');
    expect(parsePlanVerdict('make the header blue')).toBe('none');
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
  test('single-task verdict → posts a note, single_task (caller makes one task, no write-back)', async () => {
    const e = effects({ invokeModel: jest.fn().mockResolvedValue(JSON.stringify({ should_decompose: false, reasoning: 'small', sub_issues: [] })) });
    const r = await runDecompositionProposal({ parentIssueId: PARENT, plannerInput: PLANNER_INPUT, caps: CAPS, autoRun: false, effects: e });
    expect(r).toEqual({ kind: 'single_task', reason: 'judge_declined' });
    expect(e.putPendingPlan).not.toHaveBeenCalled();
  });

  test('planner error → note + single_task fallback', async () => {
    const e = effects({ invokeModel: jest.fn().mockRejectedValue(new Error('bedrock down')) });
    const r = await runDecompositionProposal({ parentIssueId: PARENT, plannerInput: PLANNER_INPUT, caps: CAPS, autoRun: false, effects: e });
    expect(r).toEqual({ kind: 'single_task', reason: 'planner_error' });
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
