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
 * Ties the B2/B4/B5 pieces into the caps→propose/seed logic Mode B needs, with
 * all I/O injected so the control flow is unit-testable without Linear / DDB:
 *
 *  1. {@link applyDecompositionResult} — given an already-PRODUCED plan (parsed
 *     from the ``coding/decompose-v1`` agent's plan artifact by the reconciler),
 *     caps (B2) → either post a proposal and persist a pending plan (manual), or
 *     write back + return the graph for immediate seeding (auto).
 *  2. {@link runPlanVerdict} — an ``@bgagent approve``/``reject`` comment on the
 *     parent. Approve → consume the pending plan → write back → return the
 *     graph for seeding. Reject → discard + acknowledge.
 *
 * Both return a discriminated result the caller maps to its existing machinery:
 * a ``seed`` result carries a ``SubIssueNode[]`` handed to ``discoverOrchestration``
 * via ``declarativeGraphSource`` (then releases roots exactly as Mode A does);
 * the other results are terminal (a comment was posted, nothing to seed).
 *
 * #299 agent-native planning: the MODEL-INVOKE head (the old ``runDecompositionProposal``
 * that called Bedrock inline) was RETIRED — planning moved into the agent, which
 * clones the repo and plans with full context. This module keeps only the parts
 * downstream of "a plan exists".
 */

import type { SubIssueNode } from './linear-subissue-fetch';
import { logger } from './logger';
import { applyPlanCaps } from './orchestration-decomposition-caps';
import type { DecompositionResult } from './orchestration-decomposition-planner';
import {
  renderAlreadyDecomposedNote,
  renderCapRejection,
  renderPlannerErrorNote,
  renderPlanProposal,
  renderRevisionOverCapNote,
  renderSingleTaskNote,
  renderSingleTaskProposal,
  renderUnderspecifiedDecomposeNote,
} from './orchestration-decomposition-render';
import type { DecompositionPlan, ProjectDecompositionCaps } from './orchestration-decomposition-types';
import { writeBackPlan, type GraphqlFn } from './orchestration-decomposition-writeback';

/**
 * Injected effects the flow needs. Each is a thin async fn the processor wires
 * to its real helpers; tests pass spies. Keeping them granular (vs. passing the
 * whole processor) is what makes the flow testable in isolation.
 *
 * #299 agent-native planning: the model-invoke boundary was RETIRED here —
 * planning now runs in a ``coding/decompose-v1`` agent (full repo context), so
 * this flow only PROPOSES/SEEDS an already-produced plan. The verdict path
 * (approve/reject) still lives here; the reconciler's plan-artifact consumer
 * reuses {@link applyDecompositionResult} via a narrowed effects Pick.
 */
export interface DecompositionEffects {
  /** Linear GraphQL transport for write-back (B5). */
  readonly graphql: GraphqlFn;
  /**
   * Post a top-level comment on the parent; returns the new comment id (or null).
   * When ``existingCommentId`` is given, EDIT that comment in place instead of
   * posting a fresh one (#299 F-revise-in-place: a semantic revise matures the ONE
   * plan comment rather than stacking "Updated breakdown" comments) — returns the
   * same id on success, null on a failed edit.
   */
  readonly postComment: (issueId: string, body: string, existingCommentId?: string) => Promise<string | null>;
  /**
   * Persist a pending plan. Returns true if this call persisted it. The caller's
   * impl chooses create-once (round 0 — a redelivery returns false) vs. replace
   * (a revision — always true, overwrites the prior proposal). ``revisionRound``
   * (#299 revise loop) is recorded on the row for the next round's cap + header.
   */
  readonly putPendingPlan: (args: {
    nodes: DecompositionPlan['nodes'];
    proposalCommentId?: string;
    revisionRound?: number;
    /** #299 plan-mode T2: the agent's reusable repo digest + the sha it was built
     *  at, persisted for a later revise run to reuse. */
    repoDigest?: string;
    repoDigestSha?: string;
    /** #299 single-task gate: 'single' → approve runs one coding task, not seed. */
    pendingKind?: 'graph' | 'single';
    /** #299 single-task gate: the task_description approve should run (single kind). */
    singleTaskDescription?: string;
  }) => Promise<boolean>;
  /** Atomically take the pending plan (approve). Returns its nodes, or null. */
  readonly consumePendingPlan: () => Promise<{ nodes: DecompositionPlan['nodes'] } | null>;
  /** Discard the pending plan (reject). Idempotent. */
  readonly discardPendingPlan: () => Promise<void>;
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

export interface ApplyDecompositionResultParams {
  readonly parentIssueId: string;
  /** The produced plan/decline/error — parsed from the agent's plan artifact. */
  readonly planned: DecompositionResult;
  /**
   * Whether a ``single_task`` decline should be treated as UNDERSPECIFIED (ask
   * for detail — {@link renderUnderspecifiedDecomposeNote}) rather than a
   * confident cohesive-unit decline. The agent-native path (the only caller
   * today) passes ``false`` — the agent planned with FULL repo context, so a
   * decline is trusted (no repo-blindness left to compensate for, unlike the
   * retired inline planner that judged from title+description alone — ABCA-492).
   * Kept as a parameter so a future blind-planner caller can opt into the
   * ask-for-detail path.
   */
  readonly underspecified: boolean;
  readonly caps: ProjectDecompositionCaps;
  readonly autoRun: boolean;
  /**
   * #299 single-task gate (F-single-gate): the parent issue's own task_description,
   * used when a ``:decompose`` (manual) run declines to split. Instead of
   * auto-running the single task (which silently bypassed the approve-first
   * contract the ``:decompose`` label promises), we PROPOSE it — persist a
   * ``pending_kind:'single'`` plan carrying this description + post an approve
   * prompt — so nothing spends until ``@bgagent approve``. ``:auto`` still
   * auto-runs (it opted out of approval), and this is unused there. Absent → the
   * gate can't persist a single pending plan, so it falls back to the old
   * auto-run (back-compat; the reconciler always supplies it).
   */
  readonly singleTaskDescription?: string;
  /**
   * #299 F-revise-in-place: on a REVISION, the comment id of the plan proposal
   * already on the issue (from the pending-plan row). When present, the revised
   * plan EDITS that comment in place instead of posting a fresh "Updated
   * breakdown" — so the thread keeps ONE maturing plan comment. Absent on round 0
   * (nothing to edit yet → post fresh).
   */
  readonly priorProposalCommentId?: string;
  /**
   * #299 revise loop: revision number (0/absent = original proposal; N≥1 = the
   * Nth re-plan from reviewer feedback). Threaded into the proposal render
   * ("Revised breakdown (round N)") and passed to putPendingPlan so the persisted
   * row records it (drives the next round's cap check + header). Only meaningful
   * on the manual (approval-gated) path — a revision never auto-seeds.
   */
  readonly revisionRound?: number;
  /**
   * Only the boundaries the tail actually touches — posting the note/proposal,
   * persisting a pending plan (manual gate), and the GraphQL transport for
   * write-back (auto). The agent-native caller (reconciler) supplies just these
   * three; it never invokes a model or consumes/discards a pending plan here.
   * ``putPendingPlan`` may carry ``revisionRound`` so the caller can pick
   * create-once (round 0) vs. replace (revision) semantics.
   */
  readonly effects: Pick<DecompositionEffects, 'postComment' | 'putPendingPlan' | 'graphql'>;
}

/**
 * Shared caps → propose/seed tail. Given an already-PRODUCED decomposition
 * result, gate it against project caps and either seed (auto), propose + persist
 * a pending plan (manual), or decline with the right note. The #299 agent-native
 * planner (the reconciler's plan-artifact consumer) calls this after parsing the
 * agent's plan artifact; the ``@bgagent approve`` verdict path ({@link runPlanVerdict})
 * reuses its write-back tail. Consolidating here keeps caps + approval logic in
 * one place regardless of where ``planned`` came from.
 * Never throws.
 */
export async function applyDecompositionResult(
  params: ApplyDecompositionResultParams,
): Promise<DecompositionFlowResult> {
  const {
    parentIssueId, planned, underspecified, caps, autoRun, effects, revisionRound, singleTaskDescription,
    priorProposalCommentId,
  } = params;

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
    // #299 single-task gate (F-single-gate): a MANUAL (``:decompose``) run that
    // declines to split must still honor the approve-first contract — propose the
    // single task and WAIT for ``@bgagent approve`` rather than auto-running it
    // (the pre-fix code silently spent on one task, making ``:decompose`` behave
    // exactly like ``:auto`` on a single-cohesive issue — the whole point of the
    // approval gate was lost precisely there). ``:auto`` still auto-runs (it opted
    // out of approval). Requires the parent's task_description to persist for the
    // approve to run; without it (older caller) fall back to the old auto-run.
    if (!autoRun && singleTaskDescription) {
      await effects.postComment(parentIssueId, renderSingleTaskProposal(planned.reasoning));
      const persisted = await effects.putPendingPlan({
        nodes: [],
        pendingKind: 'single',
        singleTaskDescription,
        ...(revisionRound !== undefined && { revisionRound }),
      });
      if (!persisted) {
        logger.info('Mode B single-task proposal: pending plan already existed (redelivery)', { parent_issue_id: parentIssueId });
        return { kind: 'noop', reason: 'duplicate_single_proposal' };
      }
      return { kind: 'handled', reason: 'awaiting_single_approval' };
    }
    // ``:auto`` (or a caller without a task_description): trust the decline and
    // run one task now — applyDecompositionResult posted the note; the caller
    // creates the task on ``single_task``.
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
    // On a REVISION the prior round-N plan is still pending + approvable, so use a
    // revision-aware note (don't say "not started"/"re-label" — that's a dead-end
    // and re-labelling hits the stale plan; F-overcap-revise). We do NOT consume/
    // overwrite the pending plan here — returning 'handled' leaves it intact for
    // an approve or a smaller-feedback re-plan.
    await effects.postComment(
      parentIssueId,
      revisionRound !== undefined
        ? renderRevisionOverCapNote(capResult.summary) // no "re-label" remedy (stale-plan trap)
        : renderCapRejection(capResult.message),
    );
    return { kind: 'handled', reason: capResult.reason };
  }

  // AUTO: write back immediately, return the graph to seed. (A revision is
  // always manual — never auto — so revisionRound doesn't apply here.)
  if (autoRun) {
    await effects.postComment(parentIssueId, renderPlanProposal(planned.plan, { autoRun: true }));
    return finalizeWriteBack(parentIssueId, planned.plan, effects);
  }

  // MANUAL: post/UPDATE the proposal + persist the pending plan, then wait for
  // approval. #299 F-revise-in-place: on a revision, EDIT the existing plan
  // comment in place (priorProposalCommentId) so the thread keeps ONE maturing
  // plan comment instead of stacking a fresh "Updated breakdown" each round. If
  // the edit fails (comment deleted, transient error) postComment returns null →
  // fall back to a fresh post so the revised plan is never lost.
  let proposalCommentId = await effects.postComment(
    parentIssueId,
    renderPlanProposal(planned.plan, { autoRun: false, ...(revisionRound !== undefined && { revisionRound }) }),
    priorProposalCommentId,
  );
  if (proposalCommentId === null && priorProposalCommentId !== undefined) {
    proposalCommentId = await effects.postComment(
      parentIssueId,
      renderPlanProposal(planned.plan, { autoRun: false, ...(revisionRound !== undefined && { revisionRound }) }),
    );
  }
  const persisted = await effects.putPendingPlan({
    nodes: planned.plan.nodes,
    ...(proposalCommentId !== null && { proposalCommentId }),
    ...(revisionRound !== undefined && { revisionRound }),
    // #299 plan-mode T2: persist the agent's repo digest + its sha so a later
    // revise run reuses the exploration instead of re-deriving it.
    ...(planned.repoDigest !== undefined && { repoDigest: planned.repoDigest }),
    ...(planned.repoDigestSha !== undefined && { repoDigestSha: planned.repoDigestSha }),
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
