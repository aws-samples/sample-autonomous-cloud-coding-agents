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
 * #299 Mode B — the decomposition FLOW orchestrator (B6 core).
 *
 * Ties the B1–B5 pieces into the two events Mode B reacts to, with all I/O
 * injected so the control flow is unit-testable without Bedrock / Linear / DDB:
 *
 *  1. {@link runDecompositionProposal} — a ``:decompose`` / ``:auto`` label on
 *     an UNDECOMPOSED issue. Judge+plan (B3) → caps (B2) → either post a
 *     proposal and persist a pending plan (manual), or write back + return the
 *     graph for immediate seeding (auto).
 *  2. {@link runPlanVerdict} — an ``@bgagent approve``/``reject`` comment on the
 *     parent. Approve → consume the pending plan → write back → return the
 *     graph for seeding. Reject → discard + acknowledge.
 *
 * Both return a discriminated result the processor maps to its existing
 * machinery: a ``seed`` result carries a ``SubIssueNode[]`` the processor hands
 * to ``discoverOrchestration`` via ``declarativeGraphSource`` (then releases
 * roots exactly as Mode A does); the other results are terminal (a comment was
 * posted, nothing to seed).
 */

import type { SubIssueNode } from './linear-subissue-fetch';
import { logger } from './logger';
import { applyPlanCaps } from './orchestration-decomposition-caps';
import { planDecomposition, type InvokeModelFn, type PlannerInput } from './orchestration-decomposition-planner';
import {
  renderAlreadyDecomposedNote,
  renderCapRejection,
  renderPlanProposal,
  renderSingleTaskNote,
} from './orchestration-decomposition-render';
import type { DecompositionPlan, ProjectDecompositionCaps } from './orchestration-decomposition-types';
import { writeBackPlan, type GraphqlFn } from './orchestration-decomposition-writeback';

/**
 * Injected effects the flow needs. Each is a thin async fn the processor wires
 * to its real helpers; tests pass spies. Keeping them granular (vs. passing the
 * whole processor) is what makes the flow testable in isolation.
 */
export interface DecompositionEffects {
  /** The LLM boundary (planner B3). */
  readonly invokeModel: InvokeModelFn;
  /** Linear GraphQL transport for write-back (B5). */
  readonly graphql: GraphqlFn;
  /** Post a top-level comment on the parent; returns the new comment id (or null). */
  readonly postComment: (issueId: string, body: string) => Promise<string | null>;
  /** Persist a pending plan (create-once). Returns true if this call persisted it. */
  readonly putPendingPlan: (args: {
    nodes: DecompositionPlan['nodes'];
    proposalCommentId?: string;
  }) => Promise<boolean>;
  /** Atomically take the pending plan (approve). Returns its nodes, or null. */
  readonly consumePendingPlan: () => Promise<{ nodes: DecompositionPlan['nodes'] } | null>;
  /** Discard the pending plan (reject). Idempotent. */
  readonly discardPendingPlan: () => Promise<void>;
}

export interface RunProposalParams {
  readonly parentIssueId: string;
  readonly plannerInput: PlannerInput;
  readonly caps: ProjectDecompositionCaps;
  /** ``:auto`` skips the approval gate; ``:decompose`` waits. */
  readonly autoRun: boolean;
  readonly effects: DecompositionEffects;
}

/** Outcome of a proposal/verdict run — tells the processor exactly what to do next. */
export type DecompositionFlowResult =
  // The graph is ready: seed the executor from these real-Linear-id nodes.
  | { readonly kind: 'seed'; readonly children: readonly SubIssueNode[] }
  // Mode B DECLINED (planner said single, errored, or decomposition disabled).
  // A note was posted; the processor should create the normal single task.
  | { readonly kind: 'single_task'; readonly reason: string }
  // Mode B handled it terminally (proposal posted + awaiting approval, rejected,
  // over-cap, or write-back error). A comment was posted; do NOT create a task.
  | { readonly kind: 'handled'; readonly reason: string }
  // Idempotent no-op (redelivery) — do NOT create a task.
  | { readonly kind: 'noop'; readonly reason: string };

/**
 * Handle a ``:decompose``/``:auto`` label on an undecomposed issue.
 * Never throws — all failures post a note and return ``terminal``.
 */
export async function runDecompositionProposal(
  params: RunProposalParams,
): Promise<DecompositionFlowResult> {
  const { parentIssueId, plannerInput, caps, autoRun, effects } = params;

  // 1. Assess + (if warranted) decompose — two-stage planner (DJ-1). On an
  // explicit ``:decompose`` (manual, not autoRun) we FORCE the decomposer so the
  // user always sees a breakdown to approve, even if the assessor leaned one-shot
  // (DJ-2 — surface, don't silently veto). On ``:auto`` the assessor's verdict
  // stands (no human to ask), so a one-shot verdict short-circuits to single_task.
  const forceDecompose = !autoRun;
  const planned = await planDecomposition(
    { ...plannerInput, forceDecompose },
    effects.invokeModel,
  );
  if (planned.kind === 'error') {
    await effects.postComment(parentIssueId, renderSingleTaskNote(
      "I couldn't plan a breakdown for this issue, so I'm running it as a single task.",
    ));
    return { kind: 'single_task', reason: 'planner_error' };
  }
  if (planned.kind === 'single_task') {
    await effects.postComment(parentIssueId, renderSingleTaskNote(planned.reasoning));
    // Caller still creates the single task (Mode B declined to decompose).
    return { kind: 'single_task', reason: 'judge_declined' };
  }

  // 2. Caps (B2). Over-cap → reject with a message (never trim).
  const capResult = applyPlanCaps(planned.plan, caps);
  if (capResult.kind === 'not_allowed') {
    // Decomposition isn't enabled for this project — fall back to single task,
    // explained. (Shouldn't reach here — the label gate checks too — but be safe.)
    await effects.postComment(parentIssueId, renderSingleTaskNote(
      'Auto-decomposition is not enabled for this project — running as a single task.',
    ));
    return { kind: 'single_task', reason: 'not_allowed' };
  }
  if (capResult.kind === 'rejected') {
    // Over-cap is a HARD stop (user must raise the cap / split) — NOT a silent
    // fall-through to a single giant task. Handled terminally.
    await effects.postComment(parentIssueId, renderCapRejection(capResult.message));
    return { kind: 'handled', reason: capResult.reason };
  }

  // 3a. AUTO: write back immediately, return the graph to seed. (On :auto the
  // assessor's verdict stood, so a 'plan' result here means it agreed to
  // decompose — no caveat.)
  if (autoRun) {
    await effects.postComment(parentIssueId, renderPlanProposal(planned.plan, { autoRun: true }));
    return finalizeWriteBack(parentIssueId, planned.plan, effects);
  }

  // 3b. MANUAL: persist the pending plan + post the proposal, then wait.
  // DJ-2: if the assessor would have one-shot this but the user forced a plan,
  // surface its rationale as an informational caveat (no veto, no new label).
  const oneShotCaveat = planned.assessedDecompose ? undefined : (planned.assessedReasoning || 'this looks fairly cohesive.');
  const proposalCommentId = await effects.postComment(
    parentIssueId,
    renderPlanProposal(planned.plan, {
      autoRun: false,
      ...(oneShotCaveat !== undefined && { oneShotCaveat }),
    }),
  );
  const persisted = await effects.putPendingPlan({
    nodes: planned.plan.nodes,
    ...(proposalCommentId !== null && { proposalCommentId }),
  });
  if (!persisted) {
    // A redelivery already persisted + posted; this is a duplicate proposal.
    logger.info('Mode B proposal: pending plan already existed (redelivery)', { parent_issue_id: parentIssueId });
    return { kind: 'noop', reason: 'duplicate_proposal' };
  }
  return { kind: 'handled', reason: 'awaiting_approval' };
}

export interface RunVerdictParams {
  readonly parentIssueId: string;
  readonly verdict: 'approve' | 'reject';
  readonly effects: DecompositionEffects;
}

/**
 * Handle an ``@bgagent approve``/``reject`` comment on a parent that has a
 * pending plan. Approve → consume + write back + seed. Reject → discard.
 * Returns ``noop`` when there is no pending plan (the comment wasn't a verdict
 * on a live plan — the processor falls through to its normal comment paths).
 * Never throws.
 */
export async function runPlanVerdict(params: RunVerdictParams): Promise<DecompositionFlowResult> {
  const { parentIssueId, verdict, effects } = params;

  if (verdict === 'reject') {
    const taken = await effects.consumePendingPlan();
    if (!taken) return { kind: 'noop', reason: 'no_pending_plan' };
    await effects.discardPendingPlan();
    await effects.postComment(parentIssueId, renderCapRejection('Plan discarded — no sub-issues created.'));
    return { kind: 'handled', reason: 'rejected' };
  }

  // approve: atomically take the plan so a racing second approve can't double-seed.
  const taken = await effects.consumePendingPlan();
  if (!taken) return { kind: 'noop', reason: 'no_pending_plan' };
  const result = await finalizeWriteBack(parentIssueId, { shouldDecompose: true, reasoning: '', nodes: taken.nodes }, effects);
  // If write-back failed, RESTORE the pending plan we consumed — otherwise the
  // "re-approving will resume" message is a lie (the plan is gone) and the user
  // is stuck. Write-back is idempotent (reuse-by-title), so a genuine re-approve
  // resumes from the partial state. Best-effort: a restore failure just means
  // the user re-labels instead of re-approving.
  if (result.kind === 'handled' && result.reason === 'writeback_error') {
    try {
      await effects.putPendingPlan({ nodes: taken.nodes });
    } catch {
      // swallow — the error comment already told the user; re-label is the fallback
    }
  }
  return result;
}

/** Write the plan back to Linear and return either a seed graph or a terminal error. */
async function finalizeWriteBack(
  parentIssueId: string,
  plan: DecompositionPlan,
  effects: DecompositionEffects,
): Promise<DecompositionFlowResult> {
  const wb = await writeBackPlan({ graphql: effects.graphql, parentIssueId, nodes: plan.nodes });
  if (wb.kind === 'error') {
    await effects.postComment(parentIssueId, renderCapRejection(wb.message));
    return { kind: 'handled', reason: 'writeback_error' };
  }
  logger.info('Mode B: plan written back — handing graph to the executor', {
    parent_issue_id: parentIssueId, created: wb.created, reused: wb.reused,
  });
  return { kind: 'seed', children: wb.children };
}

/** Convenience for the suffix-suppressed (already-decomposed) note (B6 routing). */
export async function postAlreadyDecomposedNote(
  effects: Pick<DecompositionEffects, 'postComment'>,
  parentIssueId: string,
): Promise<void> {
  await effects.postComment(parentIssueId, renderAlreadyDecomposedNote());
}
