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
import { planDecomposition, type DecompositionResult, type InvokeModelFn, type PlannerInput } from './orchestration-decomposition-planner';
import {
  renderAlreadyDecomposedNote,
  renderCapRejection,
  renderPlannerErrorNote,
  renderPlanProposal,
  renderSingleTaskNote,
  renderUnderspecifiedDecomposeNote,
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
 * Character floor below which a decompose issue's description is considered too
 * thin to break down on its own. Chosen from the ABCA-492 dogfood: a 236-char
 * one-liner ("consider UX, look at slack api docs, testing…") that named no
 * separable deliverables sat under this; a normal multi-part epic description
 * runs well over it. Not a hard rule — combined with the repo-context signal.
 */
const THIN_DESCRIPTION_CHARS = 400;

/**
 * Whether a declined ``:decompose`` issue was UNDERSPECIFIED (→ ask for detail)
 * vs a confident cohesive-unit decline (→ run one task). The signal is the
 * ISSUE description length: the description is the only issue-specific statement
 * of scope the planner has (repo context is generic background, and ABCA-492
 * proved a decline can be wrong even WITH repo context — the fork's docs simply
 * didn't enumerate the parity features). So on a THIN-description ``:decompose``
 * that the planner still declined, we can't trust "it's one cohesive unit" —
 * the planner may just have had nothing to find seams in. Ask for the missing
 * detail rather than silently burn one large run on a spend-safe request. A
 * substantial description that declines is trusted (the planner had enough to
 * judge). Pure — unit-testable.
 */
export function isUnderspecifiedForDecompose(input: PlannerInput): boolean {
  return (input.description ?? '').trim().length < THIN_DESCRIPTION_CHARS;
}

/**
 * Handle a ``:decompose``/``:auto`` label on an undecomposed issue.
 * Never throws — all failures post a note and return ``terminal``.
 *
 * NOTE (#299 agent-native planning): this inline-planner path is being retired
 * in favour of the ``coding/decompose-v1`` agent workflow (planning runs in a
 * real clone with full repo context, then the reconciler consumes the plan
 * artifact). The caps→propose/seed TAIL is shared with that path via
 * {@link applyDecompositionResult} — only the "how the plan was produced" head
 * (a blind Bedrock call here, an agent artifact there) differs.
 */
export async function runDecompositionProposal(
  params: RunProposalParams,
): Promise<DecompositionFlowResult> {
  const { parentIssueId, plannerInput, caps, autoRun, effects } = params;

  // 1. Assess + (if warranted) decompose — two-stage planner. The AGENT'S
  // ASSESSMENT decides whether to split, for BOTH labels: a one-cohesive-unit
  // verdict returns single_task with the reasoning (we never manufacture a
  // breakdown the assessor judged incoherent just because the label asked — that
  // only yields the layer-split anti-pattern). The label affects only the
  // downstream approval gate (manual vs auto), handled below.
  const planned = await planDecomposition(plannerInput, effects.invokeModel);
  return applyDecompositionResult({
    parentIssueId,
    planned,
    // ABCA-492 thin-issue heuristic: the inline (repo-blind) planner may decline
    // simply because it couldn't see the seams. Only meaningful for THIS path.
    underspecified: isUnderspecifiedForDecompose(plannerInput),
    caps,
    autoRun,
    effects,
  });
}

export interface ApplyDecompositionResultParams {
  readonly parentIssueId: string;
  /** The produced plan/decline/error — from the inline planner OR an agent artifact. */
  readonly planned: DecompositionResult;
  /**
   * Whether a ``single_task`` decline should be treated as UNDERSPECIFIED (ask
   * for detail) rather than a confident cohesive-unit decline. The inline planner
   * passes {@link isUnderspecifiedForDecompose}; the agent-native path passes
   * ``false`` — the agent planned with full repo context, so a decline is trusted
   * (there is no repo-blindness left to compensate for).
   */
  readonly underspecified: boolean;
  readonly caps: ProjectDecompositionCaps;
  readonly autoRun: boolean;
  /**
   * Only the boundaries the tail actually touches — posting the note/proposal,
   * persisting a pending plan (manual gate), and the GraphQL transport for
   * write-back (auto). The agent-native caller (reconciler) supplies just these
   * three; it never invokes a model or consumes/discards a pending plan here.
   */
  readonly effects: Pick<DecompositionEffects, 'postComment' | 'putPendingPlan' | 'graphql'>;
}

/**
 * Shared caps → propose/seed tail. Given an already-PRODUCED decomposition
 * result, gate it against project caps and either seed (auto), propose + persist
 * a pending plan (manual), or decline with the right note. Extracted so the
 * inline planner ({@link runDecompositionProposal}) and the #299 agent-native
 * planner (the reconciler's plan-artifact consumer) run the SAME caps + approval
 * logic — the only difference between them is where ``planned`` came from.
 * Never throws.
 */
export async function applyDecompositionResult(
  params: ApplyDecompositionResultParams,
): Promise<DecompositionFlowResult> {
  const { parentIssueId, planned, underspecified, caps, autoRun, effects } = params;

  if (planned.kind === 'error') {
    // ABCA-490: the planner errored or TIMED OUT. Post the honest,
    // remedy-bearing note — NOT renderSingleTaskNote, which would falsely claim
    // "single cohesive change". We still fall back to one task so the work happens.
    await effects.postComment(parentIssueId, renderPlannerErrorNote());
    return { kind: 'single_task', reason: 'planner_error' };
  }
  if (planned.kind === 'single_task') {
    // ABCA-492: distinguish a CONFIDENT decline (well-specified + genuinely
    // cohesive — trust it, run one task) from an UNDERSPECIFIED one (nothing to
    // break down was visible). Silently one-shotting the latter is the worst
    // outcome for a spend-safe ":decompose"; HOLD and ask for detail instead.
    if (underspecified) {
      await effects.postComment(parentIssueId, renderUnderspecifiedDecomposeNote());
      return { kind: 'handled', reason: 'underspecified' };
    }
    await effects.postComment(parentIssueId, renderSingleTaskNote(planned.reasoning));
    return { kind: 'single_task', reason: 'judge_declined' };
  }

  // Caps (B2). Over-cap → reject with a message (never trim).
  const capResult = applyPlanCaps(planned.plan, caps);
  if (capResult.kind === 'not_allowed') {
    await effects.postComment(parentIssueId, renderSingleTaskNote(
      'Auto-decomposition is not enabled for this project — running as a single task.',
    ));
    return { kind: 'single_task', reason: 'not_allowed' };
  }
  if (capResult.kind === 'rejected') {
    // Over-cap is a HARD stop (raise the cap / split) — NOT a silent giant task.
    await effects.postComment(parentIssueId, renderCapRejection(capResult.message));
    return { kind: 'handled', reason: capResult.reason };
  }

  // AUTO: write back immediately, return the graph to seed.
  if (autoRun) {
    await effects.postComment(parentIssueId, renderPlanProposal(planned.plan, { autoRun: true }));
    return finalizeWriteBack(parentIssueId, planned.plan, effects);
  }

  // MANUAL: persist the pending plan + post the proposal, then wait for approval.
  const proposalCommentId = await effects.postComment(
    parentIssueId, renderPlanProposal(planned.plan, { autoRun: false }),
  );
  const persisted = await effects.putPendingPlan({
    nodes: planned.plan.nodes,
    ...(proposalCommentId !== null && { proposalCommentId }),
  });
  if (!persisted) {
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
  effects: Pick<DecompositionEffects, 'postComment' | 'graphql'>,
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
