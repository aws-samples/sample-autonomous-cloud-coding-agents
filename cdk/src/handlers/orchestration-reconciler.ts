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
 * Orchestration reconciler (issue #247, Mode A — PR A3).
 *
 * Consumes the **TaskTable DynamoDB stream** (sole consumer — TaskTable
 * had no stream before this; TaskEventsTable's is at its 2-consumer
 * limit, see that construct's note). On each child task that reaches a
 * terminal status, it:
 *   1. resolves the task's orchestration via the ChildTaskIndex GSI
 *      (skips non-orchestration tasks — they have no orchestration_id),
 *   2. loads the orchestration snapshot,
 *   3. computes the gating plan (pure: orchestration-reconcile.ts),
 *   4. persists child-status updates and releases newly-unblocked
 *      children via the shared release helper.
 *
 * Idempotent: stream redelivery re-runs the same plan; status updates
 * are conditional and releaseChild is idempotency-keyed, so a replayed
 * terminal event neither double-releases nor regresses state.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { createTaskCore } from './shared/create-task-core';
import { renderFailureReply, renderPanelFailureReason } from './shared/failure-reply';
import { isNoChangeIteration, renderMaturingReply } from './shared/iteration-reply';
import { EMOJI_FAILURE, EMOJI_NEEDS_INPUT, EMOJI_SUCCESS, type LinearFeedbackContext, replyToComment, swapCommentReaction, transitionIssueState, upsertStatusComment, upsertThreadedReply } from './shared/linear-feedback';
import { resolveLinearOauthToken } from './shared/linear-oauth-resolver';
import type { SubIssueNode } from './shared/linear-subissue-fetch';
import { logger } from './shared/logger';
import { applyDecompositionResult } from './shared/orchestration-decomposition-flow';
import { parseDecomposerResponse } from './shared/orchestration-decomposition-planner';
import { renderDecomposeUnavailableNote, renderRevisionToSingleNote } from './shared/orchestration-decomposition-render';
import { getPendingPlan, putPendingPlan, replacePendingPlan } from './shared/orchestration-decomposition-store';
import type { ProjectDecompositionCaps } from './shared/orchestration-decomposition-types';
import { linearGraphqlFn } from './shared/orchestration-decomposition-writeback';
import { discoverOrchestration } from './shared/orchestration-discovery';
import { declarativeGraphSource } from './shared/orchestration-graph-source';
import { isIntegrationNode } from './shared/orchestration-integration-node';
import { ORCH_LOG } from './shared/orchestration-log-events';
import {
  computeReconcilePlan,
  computeRecoveryPlan,
  type ReconcileChild,
  type TerminalOutcome,
} from './shared/orchestration-reconcile';
import { readConcurrencyBudget, releaseReadyChildren } from './shared/orchestration-release';
import { planDirectRestack, type RestackStep } from './shared/orchestration-restack';
import { cascadeNodeLabel, upsertEpicPanel } from './shared/orchestration-rollup';
import {
  claimCommentAck,
  claimRollup,
  clearRollupClaim,
  deriveOrchestrationId,
  loadOrchestration,
  setStatusCommentId,
  type OrchestrationChildRow,
  type OrchestrationReleaseContext,
} from './shared/orchestration-store';
import { encodeMarkdownUrl } from './shared/screenshot-url';
import type { ChannelSource } from './shared/types';
import { OrchestrationTable } from '../constructs/orchestration-table';
import { TaskStatus, type TaskStatusType } from '../constructs/task-status';
import { TaskTable } from '../constructs/task-table';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
// A5: registry table for the parent rollup comment's per-workspace OAuth
// token. Unset → rollup is skipped (gating still works).
const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
// createTaskCore rejects idempotency keys longer than this; synthesized keys
// slice to fit the validated /^[A-Za-z0-9_-]{1,128}$/ pattern.
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
// #331: throttle releases to the user's free concurrency budget so a wide
// fan-out doesn't over-release children that admission then hard-fails. Unset
// table → no throttle (release-all, back-compat; admission still gates).
const USER_CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');
// #299 agent-native planning: the artifacts bucket a coding/decompose-v1 task
// wrote its plan JSON to (artifacts/{task_id}/result.md). Unset → the decompose
// terminal branch can't read plans and logs+skips (defensive; the construct
// wires this alongside the read grant).
const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET_NAME;
// #299 TTL for a persisted pending plan awaiting @bgagent approve — mirrors the
// webhook's PENDING_PLAN_TTL_SECONDS (a week).
const PENDING_PLAN_TTL_SECONDS = 604_800;
let sharedS3: S3Client | undefined;
function s3(): S3Client {
  if (!sharedS3) sharedS3 = new S3Client({});
  return sharedS3;
}

/** Terminal task statuses that the reconciler reacts to. */
const TERMINAL: ReadonlySet<TaskStatusType> = new Set<TaskStatusType>([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
  TaskStatus.TIMED_OUT,
]);

/** A terminal task event extracted from a TaskTable stream record. */
interface TerminalTaskEvent {
  readonly taskId: string;
  readonly status: TaskStatusType;
  readonly buildPassed?: boolean;
  /** Raw agent error_message, if any — drives the UX.5 failure-reply detail. */
  readonly errorMessage?: string;
  readonly orchestrationId?: string;
  /**
   * A6 cascade (#247 redesign): set when this terminal task is an
   * ITERATION or RESTACK on an orchestration node (carries
   * ``orchestration_sub_issue_id`` in channel_metadata but is NOT itself a
   * child-row task — its task_id isn't a ``child_task_id``). On COMPLETED we
   * re-stack that node's DIRECT dependents. The marker is set by the comment
   * trigger (pr-iteration) and by restack tasks themselves (so a restack's
   * completion cascades the next hop).
   */
  readonly cascadeSubIssueId?: string;
  /**
   * True when the cascade source was an ITERATION (a human @bgagent comment),
   * vs a restack (a predecessor-change ripple). Drives the panel's "updating
   * per <X>'s comment" vs "updating to include <X>'s change" phrasing.
   */
  readonly cascadeIsIteration?: boolean;
  /**
   * #247 UX.3: the Linear comment id that triggered this iteration (set only
   * for iterations — a human @bgagent comment). When the iteration task lands,
   * the reconciler posts a threaded ✅/❌ reply BENEATH this comment, closing
   * the conversation the human opened. Absent on restack cascades (no human
   * comment to reply to).
   */
  readonly triggerCommentId?: string;
  /**
   * #247 UX.19: the Linear ISSUE the trigger comment lives on. Usually the
   * iterated sub-issue, but for a comment left on the PARENT epic (routed to a
   * sub-issue via UX.18) it's the PARENT issue id. The threaded ✅/❌ reply must
   * use THIS as commentCreate's issueId — Linear rejects a reply whose parentId
   * belongs to a different issue. Absent on older tasks → reply falls back to
   * the sub-issue id (the prior behavior).
   */
  readonly triggerCommentIssueId?: string;
  /**
   * A6/#299: whether this iteration advanced the PR branch (a real commit) vs.
   * ran with no change (a question-only comment). ``undefined`` for pre-fix
   * tasks / non-iterations → the success reply defaults to "✅ Updated".
   */
  readonly codeChanged?: boolean;
  /** A6/#299: the agent's answer, surfaced on a no-change iteration reply. */
  readonly answerText?: string;
  /**
   * iteration-UX: the maturing "👀 On it" reply posted at trigger time. When
   * present, the settle EDITS this reply (👀→✅/💬) instead of posting a fresh
   * one. Absent on pre-fix tasks → falls back to a new threaded reply.
   */
  readonly iterationReplyId?: string;
  /** iteration-UX: this iteration's cost (USD) — folded into the settle reply. */
  readonly costUsd?: number;
  /** iteration-UX: this iteration's wall-clock seconds — folded into the reply. */
  readonly durationS?: number;
}

/**
 * Extract a terminal-task event from a TaskTable stream record. Returns
 * null for records we don't act on (inserts, non-terminal MODIFYs,
 * non-orchestration tasks, malformed images).
 */
export function parseTerminalTaskRecord(record: DynamoDBRecord): TerminalTaskEvent | null {
  if (record.eventName !== 'MODIFY' && record.eventName !== 'INSERT') return null;
  const img = record.dynamodb?.NewImage;
  if (!img) return null;

  const taskId = img.task_id?.S;
  const status = img.status?.S as TaskStatusType | undefined;
  if (!taskId || !status) return null;
  if (!TERMINAL.has(status)) return null;

  // Only orchestration children carry orchestration_id. Non-orchestration
  // tasks stream through here too (single consumer on the whole table) —
  // skip them cheaply.
  //
  // createTaskCore persists channel metadata as a nested ``channel_metadata``
  // MAP, NOT as a top-level attribute — so read orchestration_id from there.
  // (A top-level ``orchestration_id`` exists on the TaskRecord type for
  // future use, but createTaskCore doesn't populate it from channel context;
  // releaseChild threads the id via channelMetadata.orchestration_id.)
  const orchestrationId =
    img.orchestration_id?.S
    ?? img.channel_metadata?.M?.orchestration_id?.S;
  if (!orchestrationId) return null;

  const buildPassed = img.build_passed?.BOOL;
  const errorMessage = img.error_message?.S;
  // A6/#299: did this iteration commit anything, and (if not) what did the agent say?
  const codeChanged = img.code_changed?.BOOL;
  const answerText = img.answer_text?.S;
  // iteration-UX: the maturing reply to edit + this run's cost/duration.
  const iterationReplyId = img.channel_metadata?.M?.iteration_reply_comment_id?.S;
  const costUsd = img.cost_usd?.N !== undefined ? Number(img.cost_usd.N)
    : (img.cost_usd?.S !== undefined ? Number(img.cost_usd.S) : undefined);
  const durationS = img.duration_s?.N !== undefined ? Number(img.duration_s.N)
    : (img.duration_s?.S !== undefined ? Number(img.duration_s.S) : undefined);

  // A6 cascade marker: an iteration/restack task names the node it acted on
  // via channel_metadata. A restack task also carries
  // ``restack_predecessor_sub_issue_id`` — its presence (or the explicit
  // ``orchestration_iteration`` flag the comment trigger sets) marks this as
  // a cascade SOURCE rather than a normal child task. We resolve the acted-on
  // node from ``orchestration_sub_issue_id`` and confirm "is this a child row?"
  // in the handler (a child-row task drives normal gating; a non-child-row
  // task with this marker drives the cascade).
  const cm = img.channel_metadata?.M;
  const isIteration = cm?.orchestration_iteration?.S === 'true';
  const isCascadeSource =
    cm?.restack_predecessor_sub_issue_id?.S !== undefined || isIteration;
  const cascadeSubIssueId = isCascadeSource ? cm?.orchestration_sub_issue_id?.S : undefined;
  // #247 UX.3: the human comment that triggered this iteration, if any.
  const triggerCommentId = isIteration ? cm?.trigger_comment_id?.S : undefined;
  // #247 UX.19: the issue that comment lives on (parent epic for a UX.18
  // parent-routed comment; the sub-issue for a direct comment).
  const triggerCommentIssueId = isIteration ? cm?.trigger_comment_issue_id?.S : undefined;

  return {
    taskId,
    status,
    ...(buildPassed !== undefined && { buildPassed }),
    ...(errorMessage !== undefined && { errorMessage }),
    orchestrationId,
    ...(cascadeSubIssueId !== undefined && { cascadeSubIssueId }),
    ...(cascadeSubIssueId !== undefined && { cascadeIsIteration: isIteration }),
    ...(triggerCommentId !== undefined && { triggerCommentId }),
    ...(triggerCommentIssueId !== undefined && { triggerCommentIssueId }),
    ...(codeChanged !== undefined && { codeChanged }),
    ...(answerText !== undefined && { answerText }),
    ...(iterationReplyId !== undefined && { iterationReplyId }),
    ...(costUsd !== undefined && Number.isFinite(costUsd) && { costUsd }),
    ...(durationS !== undefined && Number.isFinite(durationS) && { durationS }),
  };
}

/**
 * Resolve the sub_issue_id for a terminal task within its orchestration.
 * Prefers the ChildTaskIndex GSI (task_id → row); the orchestration_id on
 * the task record is the authoritative grouping.
 */
async function resolveSubIssueId(taskId: string): Promise<string | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: ORCHESTRATION_TABLE,
    IndexName: OrchestrationTable.CHILD_TASK_INDEX,
    KeyConditionExpression: 'child_task_id = :tid',
    ExpressionAttributeValues: { ':tid': taskId },
    Limit: 1,
  }));
  const item = res.Items?.[0] as OrchestrationChildRow | undefined;
  return item?.sub_issue_id ?? null;
}

/**
 * Batch-read each child's PR url from the TaskTable for the final rollup
 * (#323). pr_url lands on the TaskRecord in a separate write from the
 * status transition, so it is not on the orchestration row — but by the
 * time the orchestration is all-terminal the PRs have settled, so a read
 * here is reliable. Best-effort: a failed/partial read just yields fewer
 * links (never throws out of the reconcile). Returns ``sub_issue_id → pr_url``.
 */
async function resolveChildPrUrls(
  children: readonly OrchestrationChildRow[],
): Promise<Record<string, string>> {
  const withTask = children.filter((c) => c.child_task_id);
  if (withTask.length === 0) return {};
  const taskToSub = new Map(withTask.map((c) => [c.child_task_id!, c.sub_issue_id]));
  const keys = [...taskToSub.keys()].map((task_id) => ({ task_id }));
  const out: Record<string, string> = {};
  try {
    // BatchGet caps at 100 keys/request; an orchestration is far smaller,
    // but chunk defensively so a large epic never throws on the limit.
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const res = await ddb.send(new BatchGetCommand({
        RequestItems: { [TASK_TABLE]: { Keys: chunk, ProjectionExpression: 'task_id, pr_url' } },
      }));
      for (const rec of res.Responses?.[TASK_TABLE] ?? []) {
        const taskId = rec.task_id as string | undefined;
        const prUrl = rec.pr_url as string | undefined;
        const sub = taskId ? taskToSub.get(taskId) : undefined;
        if (sub && prUrl) out[sub] = prUrl;
      }
    }
  } catch (err) {
    logger.warn('Rollup pr_url batch-read failed (non-fatal) — rollup posts without links', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

/**
 * K1: batch-read each FAILED child's failure detail from the
 * TaskTable so the panel can render WHY it failed + WHERE to read it. Mirrors
 * {@link resolveChildPrUrls}: ``error_message`` / ``build_passed`` land on the
 * TaskRecord (not the orchestration row), and by the time the epic settles
 * they've been written. Only failed children with a task id are read. Composes
 * the one-line reason via {@link renderPanelFailureReason}, tagging the
 * synthetic integration node so its copy names the combined merge build — the
 * exact failure that was previously surfaced as a bare "❌ … failed".
 * Best-effort: a read miss just yields no sub-line (never throws out of the
 * reconcile). Returns ``sub_issue_id → reason``.
 */
async function resolveChildFailureReasons(
  children: readonly OrchestrationChildRow[],
): Promise<Record<string, string>> {
  const failed = children.filter((c) => c.child_status === 'failed' && c.child_task_id);
  if (failed.length === 0) return {};
  const taskToSub = new Map(failed.map((c) => [c.child_task_id!, c.sub_issue_id]));
  const isIntegration = new Map(failed.map((c) => [c.sub_issue_id, isIntegrationNode(c.sub_issue_id)]));
  const keys = [...taskToSub.keys()].map((task_id) => ({ task_id }));
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const res = await ddb.send(new BatchGetCommand({
        RequestItems: {
          [TASK_TABLE]: { Keys: chunk, ProjectionExpression: 'task_id, error_message, build_passed' },
        },
      }));
      for (const rec of res.Responses?.[TASK_TABLE] ?? []) {
        const taskId = rec.task_id as string | undefined;
        const sub = taskId ? taskToSub.get(taskId) : undefined;
        if (!sub || !taskId) continue;
        const reason = renderPanelFailureReason({
          ...(typeof rec.build_passed === 'boolean' && { buildPassed: rec.build_passed as boolean }),
          ...(typeof rec.error_message === 'string' && { errorMessage: rec.error_message as string }),
          taskId,
          isIntegration: isIntegration.get(sub) ?? false,
        });
        if (reason) out[sub] = reason;
      }
    }
  } catch (err) {
    logger.warn('Panel failure-reason batch-read failed (non-fatal) — panel posts without sub-lines', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

/**
 * #247: read the integration node's deploy-preview screenshot URL from its
 * TaskRecord (persisted by the screenshot pipeline) so the parent panel can
 * embed the combined preview. Best-effort — null when the node has no task,
 * no preview deployed yet, or the read fails. Only the integration node is
 * read (one Get), since that's the only node whose preview is "combined".
 */
async function resolveCombinedScreenshotUrl(
  taskId?: string,
): Promise<{ url: string; previewUrl?: string } | null> {
  if (!taskId) return null;
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
      ProjectionExpression: 'screenshot_url, screenshot_preview_url',
    }));
    const url = res.Item?.screenshot_url;
    if (typeof url !== 'string' || url.length === 0) return null;
    const previewUrl = res.Item?.screenshot_preview_url;
    // #247 UX.17: the live preview-deploy URL makes the panel's combined
    // preview a clickable deep-link to the running combined site.
    return {
      url,
      ...(typeof previewUrl === 'string' && previewUrl.length > 0 && { previewUrl }),
    };
  } catch (err) {
    logger.warn('Combined screenshot read failed (non-fatal) — panel posts without it', {
      task_id: taskId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * iteration-UX: strongly-consistent re-read of the iteration task's screenshot +
 * deploy URL, taken right before the settle renders. Mirrors the fanout
 * (standalone) path's ``reloadScreenshotFields``: the screenshot webhook persists
 * ``screenshot_url`` onto this task durably but AFTER the deploy, so a non-
 * consistent read (or relying only on the comment-append convergence) can miss
 * it and the terminal-settle re-render then clobbers the preview (ABCA-438 class,
 * left unfixed on the orchestration path). ConsistentRead beats the lag. Returns
 * nulls on any failure (best-effort). Caller renders the thumbnail when present.
 */
async function reloadIterationScreenshot(taskId?: string): Promise<{ screenshotUrl: string | null; deployUrl: string | null }> {
  if (!taskId) return { screenshotUrl: null, deployUrl: null };
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
      ProjectionExpression: 'screenshot_url, screenshot_preview_url',
      ConsistentRead: true,
    }));
    const s = res.Item?.screenshot_url;
    const d = res.Item?.screenshot_preview_url;
    return {
      screenshotUrl: typeof s === 'string' && s.length > 0 ? s : null,
      deployUrl: typeof d === 'string' && d.length > 0 ? d : null,
    };
  } catch (err) {
    logger.warn('Iteration screenshot re-read failed (non-fatal)', {
      task_id: taskId, error: err instanceof Error ? err.message : String(err),
    });
    return { screenshotUrl: null, deployUrl: null };
  }
}

/** Apply one terminal child's reconcile plan. */
async function reconcileTerminalChild(evt: TerminalTaskEvent): Promise<void> {
  const orchestrationId = evt.orchestrationId!;

  const subIssueId = await resolveSubIssueId(evt.taskId);
  if (!subIssueId) {
    logger.warn('Reconciler could not resolve sub_issue_id for terminal task', {
      task_id: evt.taskId,
      orchestration_id: orchestrationId,
    });
    return;
  }

  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!snapshot) {
    logger.warn('Reconciler found no orchestration snapshot (TTL-reaped?)', {
      orchestration_id: orchestrationId,
      task_id: evt.taskId,
    });
    return;
  }

  const children: ReconcileChild[] = snapshot.children.map((c) => ({
    sub_issue_id: c.sub_issue_id,
    depends_on: c.depends_on,
    child_status: c.child_status,
  }));

  const outcome: TerminalOutcome = {
    sub_issue_id: subIssueId,
    status: evt.status as TerminalOutcome['status'],
    ...(evt.buildPassed !== undefined && { build_passed: evt.buildPassed }),
  };

  const plan = computeReconcilePlan(outcome, children);
  const now = new Date().toISOString();

  // 1. Persist status updates (terminal child + any skips). Each is
  //    conditional on the row not already being in the target state so a
  //    replayed event is a no-op.
  for (const update of plan.statusUpdates) {
    // ``toRelease`` rows are handled by releaseChild below (which flips
    // them to released conditionally); skip them here to avoid a
    // double-write race.
    if (plan.toRelease.includes(update.sub_issue_id)) continue;
    try {
      await ddb.send(new UpdateCommand({
        TableName: ORCHESTRATION_TABLE,
        Key: { orchestration_id: orchestrationId, sub_issue_id: update.sub_issue_id },
        UpdateExpression: 'SET child_status = :s, updated_at = :now',
        ConditionExpression: 'child_status <> :s',
        ExpressionAttributeValues: { ':s': update.child_status, ':now': now },
      }));
    } catch (err) {
      if (isConditionalCheckFailed(err)) continue; // already in target state
      throw err;
    }
  }

  // 2. Re-evaluate releasability against a FRESH read, not the initial
  //    snapshot.
  //
  //    Concurrency (failure-matrix row 3): when two predecessors of the
  //    same child D finish simultaneously, each reconciler invocation
  //    loads its own snapshot, persists only ITS child as succeeded, and
  //    — working from its stale snapshot — sees D's OTHER predecessor not
  //    yet succeeded, so neither releases D and it strands ``blocked``.
  //    The plan's ``toRelease`` (computed from the initial snapshot) is
  //    therefore unreliable under concurrency. Reloading after the
  //    status write means whichever invocation reads last sees BOTH
  //    predecessors succeeded and releases D; the conditional
  //    ready→released flip in releaseChild dedups if both happen to see it.
  const fresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  const freshChildren = fresh?.children ?? snapshot.children;
  const succeeded = new Set(
    freshChildren.filter((c) => c.child_status === 'succeeded').map((c) => c.sub_issue_id),
  );
  const releasableRows = freshChildren
    .filter((c) =>
      // newly-unblocked: all predecessors now succeeded
      (c.child_status === 'blocked' && c.depends_on.every((d) => succeeded.has(d)))
      // OR throttle-deferred: a prior pass (#331) left this child `ready` but
      // un-started (no child_task_id) because the concurrency budget was full.
      // Re-pick it here so ANY sibling completion drains the backlog as slots
      // free, instead of it waiting up to ~10min for the #303 sweep. Roots have
      // no predecessors so depends_on.every(...) is vacuously true. Safe against
      // double-release: releaseReadyChildren's flip is conditional (ready→released).
      || (c.child_status === 'ready' && !c.child_task_id && c.depends_on.every((d) => succeeded.has(d))))
    .map((c) => ({ ...c, child_status: 'ready' as const }));

  if (releasableRows.length > 0) {
    const releaseCtx = (fresh ?? snapshot).meta.release_context;
    // #331: throttle this pass to the user's free concurrency budget so a
    // wide fan-out doesn't over-release children that admission then
    // hard-fails (the cap is a throttle, not a guillotine). Leftover ready
    // children are released by the next reconcile (a sibling completing
    // re-fires this handler) or the #303 sweep, as slots free. Unset table
    // → release all (back-compat; admission still gates).
    const budget = USER_CONCURRENCY_TABLE
      ? await readConcurrencyBudget(ddb, USER_CONCURRENCY_TABLE, releaseCtx.platform_user_id, MAX_CONCURRENT)
      : undefined;
    const results = await releaseReadyChildren(
      ddb,
      ORCHESTRATION_TABLE,
      releasableRows,
      releaseCtx,
      createTaskCore,
      now,
      // #247 A4: pass the full child set so each releasable child's base
      // branch can be derived from its predecessors' persisted branches.
      freshChildren,
      'main',
      budget,
    );
    logger.info('Reconciler released children', {
      orchestration_id: orchestrationId,
      trigger_sub_issue_id: subIssueId,
      released: results.filter((r) => r.kind === 'released').length,
      requested: releasableRows.length,
      ...(budget !== undefined && { concurrency_budget: budget }),
    });
  }

  // Refresh the panel + settle the parent state against the fresh view.
  await refreshPanelAndSettle(orchestrationId, freshChildren, (fresh ?? snapshot).meta, now);
}

/**
 * #247 UX.2: maintain the SINGLE maturing epic panel — one comment, edited in
 * place — and settle the parent state when the epic reaches all-terminal.
 * Shared by the normal child-gating path (``reconcileTerminalChild``) AND the
 * cascade path (``cascadeRestack``): a re-stack/iteration task completing must
 * ALSO clear its node's ``🔄 updating`` row and re-run the completion check, or
 * an epic whose only remaining activity is a cascade hangs forever at
 * "🔄 N/M" with a stale updating row (live-caught under the UX.6 stress test —
 * a re-stack of a no-dependents node returned early and never refreshed).
 *
 * Best-effort; only when the workspace registry is configured. The panel BODY
 * edit is idempotent (same body = no-op), so it always runs; the parent-STATE
 * mirror is claimed once via ``claimRollup`` on the first all-terminal caller.
 */
async function refreshPanelAndSettle(
  orchestrationId: string,
  children: readonly OrchestrationChildRow[],
  meta: { linear_workspace_id: string; parent_linear_issue_id: string; status_comment_id?: string; release_context: { channel_source?: string } },
  now: string,
): Promise<void> {
  if (!WORKSPACE_REGISTRY_TABLE) return;

  // Completion check: every child terminal (succeeded/failed/skipped —
  // released is NOT terminal).
  const allTerminal = children.every((c) =>
    c.child_status === 'succeeded' || c.child_status === 'failed' || c.child_status === 'skipped',
  );

  const prUrls = await resolveChildPrUrls(children);
  // K1: when any node failed, resolve its one-line reason + CloudWatch pointer
  // so the panel row carries a diagnostic sub-line (the integration node's
  // combined-build failure has no other surface). Only read on a failure —
  // healthy epics skip the extra BatchGet.
  const anyFailed = children.some((c) => c.child_status === 'failed');
  const failureReasons = anyFailed ? await resolveChildFailureReasons(children) : {};
  const integration = children.find((c) => isIntegrationNode(c.sub_issue_id));
  const combinedPrUrl = integration ? prUrls[integration.sub_issue_id] : undefined;
  // #247 (task #57): embed the integration node's combined deploy preview in
  // the panel when the epic is complete. Only read it on the all-terminal
  // settle (the integration node has deployed by then); skip the extra Get on
  // every in-flight edit.
  const combinedScreenshot = (allTerminal && integration)
    ? await resolveCombinedScreenshotUrl(integration.child_task_id)
    : null;

  if (allTerminal) {
    logger.info('Orchestration complete', {
      event: ORCH_LOG.orchestrationComplete,
      orchestration_id: orchestrationId,
      parent_linear_issue_id: meta.parent_linear_issue_id,
      succeeded: children.filter((c) => c.child_status === 'succeeded').length,
      failed: children.filter((c) => c.child_status === 'failed').length,
      skipped: children.filter((c) => c.child_status === 'skipped').length,
    });
  }

  // Idempotency for the PARENT-STATE mirror: the orchestration can reach "all
  // terminal" on more than one stream event. Mirror only once, on the first
  // all-terminal caller. The panel BODY edit is naturally idempotent.
  const won = !allTerminal || await claimRollup(ddb, ORCHESTRATION_TABLE, orchestrationId, now);

  const newId = await upsertEpicPanel({
    ctx: { linearWorkspaceId: meta.linear_workspace_id, registryTableName: WORKSPACE_REGISTRY_TABLE },
    parentLinearIssueId: meta.parent_linear_issue_id,
    ...(meta.status_comment_id !== undefined && { statusCommentId: meta.status_comment_id }),
    children,
    prUrls,
    ...(Object.keys(failureReasons).length > 0 && { failureReasons }),
    ...(combinedPrUrl !== undefined && { combinedPrUrl }),
    ...(combinedScreenshot !== null && { combinedScreenshotUrl: combinedScreenshot.url }),
    ...(combinedScreenshot?.previewUrl !== undefined && { combinedPreviewUrl: combinedScreenshot.previewUrl }),
    inProgress: !allTerminal,
    mirrorParentState: allTerminal ? won : false,
    ...(meta.release_context.channel_source !== undefined && {
      channelSource: meta.release_context.channel_source as ChannelSource,
    }),
  });
  // Persist a freshly-created panel comment id so later edits reuse it.
  if (newId && !meta.status_comment_id) {
    try {
      await setStatusCommentId(ddb, ORCHESTRATION_TABLE, orchestrationId, newId);
    } catch (err) {
      logger.warn('Failed to persist panel comment id (non-fatal)', {
        orchestration_id: orchestrationId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * A6 cascade (#247 redesign). A terminal ITERATION or RESTACK task on node X
 * just completed — re-stack X's DIRECT dependents so they pick up X's new
 * branch. Each dependent's own restack completion re-fires this handler and
 * cascades the next hop (see ``planDirectRestack``). Only on COMPLETED — a
 * failed iteration leaves dependents on the prior (still-valid) base.
 *
 * Idempotent: the per-dependent task's idempotency key includes the SOURCE
 * task id, so the same completion never spawns a dependent's restack twice;
 * a different source (the next real change) gets a new key. Best-effort —
 * a failure to spawn one dependent does not block the others.
 */
async function cascadeRestack(evt: TerminalTaskEvent): Promise<void> {
  const orchestrationId = evt.orchestrationId!;
  const changedSubIssueId = evt.cascadeSubIssueId!;
  const succeeded = evt.status === TaskStatus.COMPLETED && evt.buildPassed !== false;
  const now = new Date().toISOString();

  // #247 UX.3: an ITERATION carries the human comment that triggered it. When
  // it lands — success OR failure — reply ✅/❌ in a thread beneath that
  // comment, closing the conversation the human opened. This runs regardless
  // of whether there are dependents to re-stack (a leaf node has none) and
  // before the success-gate below (a failed iteration still gets its ❌ reply).
  if (evt.triggerCommentId) {
    await replyToIterationComment(evt, changedSubIssueId, succeeded);
  }

  // Only a successful change should cascade onto dependents.
  if (!succeeded) {
    logger.info('A6 cascade: source task not successful — not cascading', {
      orchestration_id: orchestrationId,
      changed_sub_issue_id: changedSubIssueId,
      status: evt.status,
    });
    return;
  }

  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!snapshot) {
    logger.warn('A6 cascade: orchestration snapshot not found', { orchestration_id: orchestrationId });
    return;
  }

  // #247 #75 — RECOVERY cascade. If this successful iteration was a fix on a
  // node that is currently ``failed`` (a human commented a fix on a ❌ sub-issue),
  // un-fail it and re-release the dependents that were transitively ``skipped``
  // when it first failed — so the WHOLE epic can recover, not just this one PR.
  // No-ops cleanly when the node wasn't failed (the normal forward cascade below
  // handles a healthy iteration's dependents).
  await maybeRecoverFailedNode(orchestrationId, snapshot, changedSubIssueId, now);

  const steps = planDirectRestack(snapshot.children, changedSubIssueId);
  if (steps.length === 0) {
    logger.info('A6 cascade: no started direct dependents to re-stack', {
      orchestration_id: orchestrationId,
      changed_sub_issue_id: changedSubIssueId,
    });
    // The cascade source (this re-stack/iteration) itself just completed and
    // carried a '🔄 updating' row on the panel. With no dependents to ripple
    // to, NOTHING else will fire for this node — so we MUST refresh here to
    // clear its updating row and re-run the completion check. Without this, an
    // epic whose only remaining activity is a leaf-node re-stack hangs forever
    // at "🔄 N/M" with a stale updating row (live-caught, UX.6 stress test).
    // Re-load so the panel reflects this node's freshly-persisted terminal
    // status, then settle.
    const fresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
    await refreshPanelAndSettle(orchestrationId, (fresh ?? snapshot).children, (fresh ?? snapshot).meta, now);
    return;
  }

  logger.info('A6 cascade: re-stacking direct dependents', {
    orchestration_id: orchestrationId,
    changed_sub_issue_id: changedSubIssueId,
    source_task_id: evt.taskId,
    dependent_count: steps.length,
  });

  // Human-readable label for the changed node (the predecessor that was
  // revised), used in the surfacing comments. Prefer its Linear identifier.
  const meta = snapshot.meta;
  const changedRow = snapshot.children.find((c) => c.sub_issue_id === changedSubIssueId);
  // Friendly short name — for the integration node this is "the integration",
  // NOT its raw synthetic title (which read clumsily in the possessive cascade
  // reason "…'s change"; live-caught under the UX.6 stress test).
  const changedLabel = cascadeNodeLabel(changedSubIssueId, changedRow?.linear_identifier, changedRow?.title);

  const feedbackCtx = WORKSPACE_REGISTRY_TABLE
    ? { linearWorkspaceId: meta.linear_workspace_id, registryTableName: WORKSPACE_REGISTRY_TABLE }
    : undefined;

  const updatingIds: string[] = [];
  for (const step of steps) {
    const created = await spawnRestackTask(step, meta.release_context.platform_user_id, evt.taskId, changedSubIssueId);
    // Surface ONLY on a genuinely NEW restack task (201). A 200 means an
    // idempotent replay (the cascade source's stream record is redelivered
    // multiple times — observed 3× live), so don't re-mark. 'failed' = skip.
    if (created !== 'created') continue;
    updatingIds.push(step.child.sub_issue_id);
  }

  // #247 UX.2: instead of standalone '🔄 Re-stacked' / 'revised' comments,
  // refresh the SINGLE epic panel so the impacted rows show '🔄 updating per
  // <reason>' and the header reverts to in-progress. The dependent's own
  // sub-issue gets the react/reply ack (UX.3), not a status comment here. The
  // 'updating' rows settle back to ✅ when their restack tasks complete — those
  // completions route to cascadeRestack (NOT reconcileTerminalChild) and clear
  // the row via refreshPanelAndSettle (the no-dependents path), per UX.15.
  if (feedbackCtx && updatingIds.length > 0) {
    // A cascade re-opened an epic that may have ALREADY completed (a comment on
    // a finished epic). Release the once-only rollup claim so the parent state
    // can re-settle (👀→✅) when the re-stacks finish — else claimRollup stays
    // failed forever and the reaction never re-mirrors (#247 UX.15 stress-caught).
    await clearRollupClaim(ddb, ORCHESTRATION_TABLE, orchestrationId, now);
    const reason = evt.cascadeIsIteration
      ? `per ${changedLabel}'s comment`
      : `to include ${changedLabel}'s change`;
    const updating: Record<string, string> = {};
    for (const id of updatingIds) updating[id] = reason;
    // Render from a FRESH read, not the pre-spawn snapshot: spawnRestackTask just
    // flipped the restacked rows to `released` and stamped branches, so the
    // snapshot is stale. The forward-gating path already re-loads after writes;
    // mirror that here so the panel reflects current child state (else a stale
    // row status shows for one event window). Fall back to the snapshot on a
    // read miss. (The `updating` overlay is driven by updatingIds, not statuses.)
    const cascadeFresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
    const panelChildren = cascadeFresh?.children ?? snapshot.children;
    const prUrls = await resolveChildPrUrls(panelChildren);
    const integration = panelChildren.find((c) => isIntegrationNode(c.sub_issue_id));
    await upsertEpicPanel({
      ctx: feedbackCtx,
      parentLinearIssueId: meta.parent_linear_issue_id,
      ...(meta.status_comment_id !== undefined && { statusCommentId: meta.status_comment_id }),
      children: panelChildren,
      prUrls,
      updating,
      ...(integration && prUrls[integration.sub_issue_id] !== undefined
        && { combinedPrUrl: prUrls[integration.sub_issue_id] }),
      inProgress: true, // a cascade re-opened the epic
      ...(meta.release_context.channel_source !== undefined
        && { channelSource: meta.release_context.channel_source as ChannelSource }),
    });
  }
}

/**
 * #247 #75 — RECOVERY cascade. A successful iteration on a node that is
 * currently ``failed`` (a human commented a fix on a ❌ sub-issue). Un-fail the
 * node and re-release the dependents that were transitively ``skipped`` when it
 * first failed, so the whole epic can recover rather than stranding at "finished
 * with failures". No-ops when the node isn't failed.
 *
 * Mirrors {@link reconcileTerminalChild}'s persist-then-release shape:
 *  1. {@link computeRecoveryPlan} decides the un-fail + un-skip writes.
 *  2. Persist each conditionally (skip the ones release will flip).
 *  3. Re-release the freed children via {@link releaseReadyChildren}, honoring
 *     the user's concurrency budget exactly like the forward path.
 * Best-effort + idempotent: a redelivered iteration event finds the node already
 * ``succeeded`` (recovery plan empty) and no-ops.
 */
async function maybeRecoverFailedNode(
  orchestrationId: string,
  snapshot: NonNullable<Awaited<ReturnType<typeof loadOrchestration>>>,
  recoveredSubIssueId: string,
  now: string,
): Promise<void> {
  const children: ReconcileChild[] = snapshot.children.map((c) => ({
    sub_issue_id: c.sub_issue_id,
    depends_on: c.depends_on,
    child_status: c.child_status,
  }));
  const plan = computeRecoveryPlan(recoveredSubIssueId, children);
  if (plan.statusUpdates.length === 0) return; // node wasn't failed — nothing to recover

  logger.info('A6 recovery: un-failing node + resetting skipped subtree', {
    orchestration_id: orchestrationId,
    recovered_sub_issue_id: recoveredSubIssueId,
    un_skipped: plan.statusUpdates.length - 1,
    re_releasing: plan.toRelease.length,
  });

  // 1. Persist ALL the un-fail (→succeeded) + un-skip (→blocked) writes,
  //    INCLUDING the toRelease rows. Unlike the forward path (reconcileTerminalChild),
  //    we must NOT exclude the toRelease rows here: there they're already
  //    'blocked' in the store so releaseReadyChildren can flip them; here they're
  //    still 'skipped', and releaseReadyChildren's conditional write only accepts
  //    child_status IN (blocked, ready) — so without first persisting
  //    skipped→'blocked' the release spawns the task but the row stays 'skipped'
  //    (live-caught: DEP ran + opened a PR yet the panel kept showing ⏭️ skipped
  //    and the epic never advanced). Persist blocked first, then release flips
  //    blocked→released.
  for (const update of plan.statusUpdates) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: ORCHESTRATION_TABLE,
        Key: { orchestration_id: orchestrationId, sub_issue_id: update.sub_issue_id },
        UpdateExpression: 'SET child_status = :s, updated_at = :now',
        ConditionExpression: 'child_status <> :s',
        ExpressionAttributeValues: { ':s': update.child_status, ':now': now },
      }));
    } catch (err) {
      if (isConditionalCheckFailed(err)) continue;
      throw err;
    }
  }

  // 2. The epic had settled to "⚠️ finished with failures" — its rollup claim is
  //    held and the parent carries the ❌ reaction. Recovery re-opens it: release
  //    the once-only rollup claim so the parent state can re-settle (❌→🔄→✅) as
  //    the recovered work lands. Without this the panel + parent reaction stay
  //    stuck at the failed snapshot even though work is running again (live-caught).
  await clearRollupClaim(ddb, ORCHESTRATION_TABLE, orchestrationId, now);

  // 3. Re-release the now-'blocked' freed children against a FRESH read (the
  //    un-skip writes above must be visible), gated on the concurrency budget
  //    like the forward path. releaseReadyChildren accepts child_status IN
  //    (blocked, ready); present them as ready.
  const fresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  const freshChildren = fresh?.children ?? snapshot.children;
  if (plan.toRelease.length > 0) {
    const releasableRows = freshChildren
      .filter((c) => plan.toRelease.includes(c.sub_issue_id))
      .map((c) => ({ ...c, child_status: 'ready' as const }));
    if (releasableRows.length > 0) {
      const releaseCtx = (fresh ?? snapshot).meta.release_context;
      const budget = USER_CONCURRENCY_TABLE
        ? await readConcurrencyBudget(ddb, USER_CONCURRENCY_TABLE, releaseCtx.platform_user_id, MAX_CONCURRENT)
        : undefined;
      const results = await releaseReadyChildren(
        ddb,
        ORCHESTRATION_TABLE,
        releasableRows,
        releaseCtx,
        createTaskCore,
        now,
        freshChildren,
        'main',
        budget,
      );
      logger.info('A6 recovery: re-released children', {
        orchestration_id: orchestrationId,
        recovered_sub_issue_id: recoveredSubIssueId,
        released: results.filter((r) => r.kind === 'released').length,
        requested: releasableRows.length,
      });
    }
  }

  // 4. Refresh the panel against the fresh post-recovery view so the un-skipped
  //    rows stop rendering ⏭️ and the header reverts from "finished with
  //    failures" to in-progress (the parent reaction re-settles on completion).
  const refreshed = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  await refreshPanelAndSettle(
    orchestrationId,
    (refreshed ?? fresh ?? snapshot).children,
    (refreshed ?? fresh ?? snapshot).meta,
    now,
  );
}

/**
 * #247 UX.3: post the threaded ✅/❌ reply beneath the human ``@bgagent``
 * comment that triggered this iteration. The 👀 reaction already landed (the
 * processor's instant ack); this reply closes the loop when the work lands.
 *
 * Idempotent: the cascade source's stream record is redelivered multiple times
 * (observed 3× live), so we claim the right to reply exactly once by
 * conditionally stamping ``ack_replied_at`` on the iteration task's own
 * TaskTable record (its ``task_id`` is the per-iteration unit). The first
 * caller wins and posts; redeliveries lose the conditional write and skip.
 * Best-effort throughout — a Linear or DDB hiccup never blocks the cascade.
 */
async function replyToIterationComment(
  evt: TerminalTaskEvent,
  changedSubIssueId: string,
  succeeded: boolean,
): Promise<void> {
  if (!WORKSPACE_REGISTRY_TABLE) return;
  const commentId = evt.triggerCommentId!;

  // Resolve the workspace for the reply. The iteration task carries it in
  // channel_metadata; rather than re-read the record, load the orchestration
  // meta (already cached-cheap) for the workspace id.
  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, evt.orchestrationId!);
  if (!snapshot) return;
  const ctx = {
    linearWorkspaceId: snapshot.meta.linear_workspace_id,
    registryTableName: WORKSPACE_REGISTRY_TABLE,
  };

  // Claim the one reply for this iteration task.
  let won = false;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TASK_TABLE,
      Key: { task_id: evt.taskId },
      UpdateExpression: 'SET ack_replied_at = :now',
      ConditionExpression: 'attribute_not_exists(ack_replied_at)',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }));
    won = true;
  } catch (err) {
    if ((err as { name?: string })?.name !== 'ConditionalCheckFailedException') {
      logger.warn('UX.3 ack: claim write failed (skipping reply)', {
        task_id: evt.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return; // lost the claim (replay) or errored → don't double-reply
  }
  if (!won) return;

  // iteration-UX: mature the settle reply (👀→✅/💬) with cost + running total,
  // editing the trigger-time reply when its id was captured. A failure keeps the
  // existing UX.5 failure reply (replyable retry).
  const prNumber = await resolvePrNumber(evt.taskId);
  const prUrl = await resolvePrUrl(evt.taskId);
  const runningTotalUsd = await sumIterationCostForIssue(changedSubIssueId, evt.taskId, evt.costUsd);
  // iteration-UX: strongly-consistent re-read of this iteration's screenshot so
  // the settle renders the preview thumbnail itself (race-free against the
  // screenshot webhook's append), matching the fanout/standalone path. Only an
  // 'updated' (real edit) state folds the thumbnail in — a question didn't change UI.
  const isUpdated = !isNoChangeIteration(evt.codeChanged);
  const shot = isUpdated ? await reloadIterationScreenshot(evt.taskId) : { screenshotUrl: null, deployUrl: null };
  const body = succeeded
    ? renderMaturingReply({
      state: isNoChangeIteration(evt.codeChanged) ? 'answered' : 'updated',
      prNumber,
      ...(prUrl !== null && { prUrl }),
      ...(evt.answerText !== undefined && { answerText: evt.answerText }),
      ...(evt.costUsd !== undefined && { costUsd: evt.costUsd }),
      ...(evt.durationS !== undefined && { durationS: evt.durationS }),
      ...(runningTotalUsd !== null && { runningTotalUsd }),
      ...(shot.screenshotUrl ? { screenshotUrl: shot.screenshotUrl } : {}),
      ...(shot.screenshotUrl && shot.deployUrl ? { deployUrl: encodeMarkdownUrl(shot.deployUrl) } : {}),
    })
    : renderFailureReply({
      status: evt.status,
      buildPassed: evt.buildPassed,
      ...(evt.errorMessage !== undefined && { errorMessage: evt.errorMessage }),
      taskId: evt.taskId,
    });
  // The reply's issueId MUST be the issue the trigger comment lives on —
  // Linear rejects a threaded reply whose parentId belongs to a different
  // issue. For a comment left on the PARENT epic (UX.18 routing) that's the
  // parent issue, NOT changedSubIssueId. Fall back to the sub-issue id for
  // tasks created before UX.19 (no triggerCommentIssueId persisted).
  const replyIssueId = evt.triggerCommentIssueId ?? changedSubIssueId;
  // iteration-UX: EDIT the maturing reply posted at trigger time; fall back to a
  // fresh threaded reply for pre-fix tasks that captured no reply id.
  // preservePreview: converge with the screenshot webhook's async `[preview]`
  // append so this terminal re-render doesn't clobber it (ABCA-434 race).
  await upsertThreadedReply(ctx, replyIssueId, commentId, body, evt.iterationReplyId, { preservePreview: true });

  // #247 UX.21: settle the comment + sub-issue so all three views agree (panel
  // row, sub-issue state, comment reaction) — the platform owns this, not the
  // agent (whose prompt-driven state-setting flapped In Progress/In Review).
  //   - swap the TRIGGER comment's 👀 → ✅ (success) / ❌ (failure), so the
  //     comment itself reads done at a glance, not just the threaded reply.
  //   - on success, advance the SUB-ISSUE to In Review (its PR is updated &
  //     open, awaiting human merge — same convention the epic uses). On
  //     failure, leave the state (the ❌ + reply convey it). Never demote.
  // Best-effort + idempotent (the ack_replied_at claim above already gates this
  // to once per iteration; swapCommentReaction/transition re-converge anyway).
  // A6/#299: a no-change iteration (a question) is neither a success-edit nor a
  // failure — it's an answer. Don't stamp ✅ (implies "PR updated, merge-worthy")
  // and don't advance the sub-issue to In Review (nothing changed). Use 💬 and
  // leave the state untouched. A real edit keeps the ✅ + In Review convention.
  const noChange = succeeded && isNoChangeIteration(evt.codeChanged);
  await swapCommentReaction(
    ctx, commentId,
    noChange ? EMOJI_NEEDS_INPUT : (succeeded ? EMOJI_SUCCESS : EMOJI_FAILURE),
  );
  if (succeeded && !noChange) {
    await transitionIssueState(ctx, changedSubIssueId, 'started', ['In Review']);
  }
}

/**
 * iteration-UX: sum ``cost_usd`` across all iteration tasks on a sub-issue (the
 * running total shown on the settle reply). Queries the LinearIssueIndex by the
 * sub-issue's linear_issue_id; ``thisCost`` is added explicitly in case the
 * terminal task's projection hasn't propagated yet (deduped by task_id). Best-
 * effort: returns this task's cost on any read failure, null when nothing known.
 */
async function sumIterationCostForIssue(
  subIssueId: string,
  thisTaskId: string,
  thisCost?: number,
): Promise<number | null> {
  const base = typeof thisCost === 'number' && Number.isFinite(thisCost) ? thisCost : 0;
  const parseCost = (v: unknown): number =>
    typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : NaN);
  try {
    // The GSI lists task_ids for the issue but does NOT project cost_usd (a GSI
    // projection can't be changed in place — see task-table.ts), so GetItem each
    // task's cost. Iteration counts per issue are small → bounded reads.
    const listed = await ddb.send(new QueryCommand({
      TableName: TASK_TABLE,
      IndexName: TaskTable.LINEAR_ISSUE_INDEX,
      KeyConditionExpression: 'linear_issue_id = :iid',
      ProjectionExpression: 'task_id',
      ExpressionAttributeValues: { ':iid': subIssueId },
    }));
    let total = 0;
    let sawThis = false;
    for (const item of (listed.Items ?? []) as Array<{ task_id?: string }>) {
      if (!item.task_id) continue;
      if (item.task_id === thisTaskId) { sawThis = true; total += base; continue; }
      const got = await ddb.send(new GetCommand({
        TableName: TASK_TABLE, Key: { task_id: item.task_id }, ProjectionExpression: 'cost_usd',
      }));
      const c = parseCost(got.Item?.cost_usd);
      if (Number.isFinite(c)) total += c;
    }
    if (!sawThis) total += base;
    return total > 0 ? total : null;
  } catch (err) {
    logger.warn('iteration-UX: running-total cost query failed — using this task only', {
      task_id: thisTaskId, error: err instanceof Error ? err.message : String(err),
    });
    return base > 0 ? base : null;
  }
}

/**
 * Spawn one coding/restack-v1 task for a direct dependent. Best-effort.
 * Returns ``'created'`` for a genuinely new task (201), ``'exists'`` for an
 * idempotent replay (200 — the source event was redelivered), or ``'failed'``.
 * The caller surfaces the re-stack to the user ONLY on ``'created'`` so
 * redelivered stream records don't post duplicate comments.
 */
async function spawnRestackTask(
  step: RestackStep,
  platformUserId: string,
  sourceTaskId: string,
  changedSubIssueId: string,
): Promise<'created' | 'exists' | 'failed'> {
  const child = step.child;
  const prNumber = await resolvePrNumber(child.child_task_id);
  if (prNumber === null) {
    logger.warn('A6 cascade: dependent has no resolvable PR number — skipping', {
      orchestration_id: child.orchestration_id,
      sub_issue_id: child.sub_issue_id,
      child_task_id: child.child_task_id,
    });
    return 'failed';
  }

  // Idempotency keyed on the SOURCE task id: this exact completion re-stacks
  // a given dependent at most once. Within [A-Za-z0-9_-], ≤128 chars.
  const idempotencyKey = `restack_${child.sub_issue_id}_${sourceTaskId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);

  try {
    const result = await createTaskCore(
      {
        repo: child.repo,
        workflow_ref: 'coding/restack-v1',
        pr_number: prNumber,
      },
      {
        userId: platformUserId,
        channelSource: 'webhook',
        channelMetadata: {
          orchestration_id: child.orchestration_id,
          // This dependent is the next cascade SOURCE: when its restack
          // completes, parseTerminalTaskRecord sees restack_predecessor_*
          // and cascades to ITS dependents.
          orchestration_sub_issue_id: child.sub_issue_id,
          restack_predecessor_sub_issue_id: changedSubIssueId,
          // repo.py merges these updated predecessor branches into the
          // dependent's existing branch before the agent runs.
          orchestration_merge_branches: JSON.stringify(step.mergeBranches),
        },
        idempotencyKey,
      },
      idempotencyKey,
    );
    logger.info('A6 cascade: created restack task for dependent', {
      orchestration_id: child.orchestration_id,
      sub_issue_id: child.sub_issue_id,
      pr_number: prNumber,
      status_code: result.statusCode,
    });
    // 201 = newly created, 200 = idempotent replay (task already existed from a
    // prior delivery of this same source event). Only 201 should surface a
    // user-facing comment; 200 means we already did. Other codes = not created.
    if (result.statusCode === 201) return 'created';
    if (result.statusCode === 200) return 'exists';
    return 'failed';
  } catch (err) {
    logger.error('A6 cascade: createTaskCore threw for dependent', {
      orchestration_id: child.orchestration_id,
      sub_issue_id: child.sub_issue_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}

/**
 * Read a dependent's PR number from its TaskRecord. Prefers numeric
 * ``pr_number``; orchestration child tasks commonly persist only ``pr_url``
 * (``.../pull/N``) with ``pr_number`` null — fall back to parsing it.
 */
/** iteration-UX: the dependent's PR URL (for a clickable reply link). Null when absent. */
async function resolvePrUrl(taskId?: string): Promise<string | null> {
  if (!taskId) return null;
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TASK_TABLE, Key: { task_id: taskId }, ProjectionExpression: 'pr_url',
    }));
    return typeof res.Item?.pr_url === 'string' ? res.Item.pr_url : null;
  } catch {
    return null;
  }
}

async function resolvePrNumber(taskId?: string): Promise<number | null> {
  if (!taskId) return null;
  try {
    const res = await ddb.send(new GetCommand({ TableName: TASK_TABLE, Key: { task_id: taskId } }));
    const pr = res.Item?.pr_number;
    if (typeof pr === 'number') return pr;
    const url = res.Item?.pr_url;
    if (typeof url === 'string') {
      const m = url.match(/\/pull\/(\d+)\b/);
      if (m) return Number(m[1]);
    }
    return null;
  } catch (err) {
    logger.warn('A6 cascade: failed to read dependent TaskRecord for PR number', {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Lambda entry point — TaskTable stream handler.
 *
 * Processes records sequentially; a failure on one record throws so the
 * stream retries the batch (idempotent replay is safe). Non-terminal /
 * non-orchestration records are skipped cheaply.
 */
/**
 * #299 agent-native planning: a terminal ``coding/decompose-v1`` PLANNING task,
 * extracted from a TaskTable stream record. Distinct from {@link TerminalTaskEvent}
 * — it carries no orchestration_id (it CREATES the graph) and instead carries the
 * decompose mode + caps + parent + the plan-artifact URI (all set by the webhook
 * in channel_metadata / by the agent's deliver_artifact).
 */
interface DecomposePlanEvent {
  readonly taskId: string;
  readonly status: TaskStatusType;
  readonly parentIssueId: string;
  readonly workspaceId: string;
  readonly repo: string;
  readonly projectId: string;
  readonly platformUserId: string;
  readonly mode: 'decompose' | 'auto';
  readonly maxSubIssues: number;
  readonly decomposeAllowed: boolean;
  readonly maxParentBudgetUsd?: number;
  readonly artifactUri?: string;
  /**
   * The planning task's own task_description (the issue title+body — see the
   * webhook's buildDecompositionTaskDescription). Reused as the single-task
   * fallback description when the agent declines to decompose (the reconciler
   * doesn't re-fetch the Linear issue).
   */
  readonly taskDescription?: string;
  /**
   * #299 revise loop: 0/absent = original proposal; N≥1 = the Nth re-plan from
   * reviewer feedback. On a revision the reconciler REPLACES the pending plan
   * (upsert) instead of create-once, and the proposal renders "round N".
   */
  readonly revisionRound?: number;
  /**
   * #299 F-revise-in-place: the reviewer's FEEDBACK comment id (rides in
   * channel_metadata so it's task-scoped). The webhook put 👀 on it as the "on it"
   * ack; when the revised plan lands the reconciler swaps 👀 → ✅ on this SAME
   * comment so the reviewer can tell it finished (the 👀 previously never settled —
   * read as stuck). Absent on round 0.
   */
  readonly revisingFeedbackCommentId?: string;
}

/**
 * Detect + extract a terminal decompose-planning task from a stream record.
 * Returns null for anything that isn't a coding/decompose-v1 task (the common
 * case — the reconciler is the whole table's consumer). Keyed on the resolved
 * workflow id in the NewImage; the decompose_* channel_metadata (set by the
 * webhook) carries the mode/caps/parent so we act without re-deriving them.
 */
export function parseDecomposePlanRecord(record: DynamoDBRecord): DecomposePlanEvent | null {
  const img = record.dynamodb?.NewImage;
  if (!img) return null;
  const taskId = img.task_id?.S;
  const status = img.status?.S as TaskStatusType | undefined;
  if (!taskId || !status || !TERMINAL.has(status)) return null;

  // Only coding/decompose-v1 tasks. resolved_workflow persists as a MAP.
  const workflowId = img.resolved_workflow?.M?.id?.S;
  if (workflowId !== 'coding/decompose-v1') return null;

  const cm = img.channel_metadata?.M;
  const parentIssueId = cm?.decompose_parent_issue_id?.S ?? cm?.linear_issue_id?.S;
  const workspaceId = cm?.linear_workspace_id?.S;
  const projectId = cm?.linear_project_id?.S;
  const mode = cm?.decompose_mode?.S as ('decompose' | 'auto' | undefined);
  if (!parentIssueId || !workspaceId || !projectId || (mode !== 'decompose' && mode !== 'auto')) {
    logger.warn('Decompose plan task terminal but missing routing metadata — skipping', {
      task_id: taskId, parent_issue_id: parentIssueId, mode,
    });
    return null;
  }
  const platformUserId = img.user_id?.S ?? '';
  const repo = img.repo?.S ?? '';
  // Cap defaults MUST match readProjectCaps / DEFAULT_MAX_SUB_ISSUES (8) so a
  // task whose caps weren't stamped (older webhook) gates the same as the flow.
  const maxSubIssues = Number(cm?.decompose_caps_max_sub_issues?.S ?? '8');
  const decomposeAllowed = (cm?.decompose_caps_allowed?.S ?? 'true') === 'true';
  const budgetStr = cm?.decompose_caps_max_parent_budget_usd?.S;
  const artifactUri = img.artifact_uri?.S;
  const taskDescription = img.task_description?.S;
  const revisionRoundStr = cm?.decompose_revision_round?.S;
  const revisionRound = revisionRoundStr !== undefined && Number.isFinite(Number(revisionRoundStr))
    ? Number(revisionRoundStr) : undefined;
  const revisingFeedbackCommentId = cm?.decompose_revising_feedback_comment_id?.S;

  return {
    taskId,
    status,
    parentIssueId,
    workspaceId,
    repo,
    projectId,
    platformUserId,
    mode,
    maxSubIssues,
    decomposeAllowed,
    ...(budgetStr !== undefined && Number.isFinite(Number(budgetStr)) && { maxParentBudgetUsd: Number(budgetStr) }),
    ...(artifactUri !== undefined && { artifactUri }),
    ...(taskDescription !== undefined && { taskDescription }),
    ...(revisionRound !== undefined && { revisionRound }),
    ...(revisingFeedbackCommentId !== undefined && { revisingFeedbackCommentId }),
  };
}

/** Fetch the plan artifact (the agent's plan JSON at artifacts/{task_id}/result.md). */
async function fetchPlanArtifact(evt: DecomposePlanEvent): Promise<string | null> {
  if (!ARTIFACTS_BUCKET) {
    logger.warn('Decompose plan: ARTIFACTS_BUCKET_NAME unset — cannot read plan', { task_id: evt.taskId });
    return null;
  }
  // Prefer the URI the agent recorded; fall back to the conventional key.
  let bucket = ARTIFACTS_BUCKET;
  let key = `artifacts/${evt.taskId}/result.md`;
  if (evt.artifactUri?.startsWith('s3://')) {
    const rest = evt.artifactUri.slice('s3://'.length);
    const slash = rest.indexOf('/');
    if (slash > 0) { bucket = rest.slice(0, slash); key = rest.slice(slash + 1); }
  }
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body?.transformToString();
    return body ?? null;
  } catch (err) {
    logger.error('Decompose plan: failed to read plan artifact from S3', {
      task_id: evt.taskId, bucket, key, error: err instanceof Error ? err.message : String(err),
    });
    return null; // nosemgrep: ts-silent-success-masking -- best-effort plan read; null → reconcileDecomposePlan posts the planner-error note (honest fallback, not a masked success)
  }
}

/**
 * #299 agent-native planning terminal handler. A coding/decompose-v1 task
 * finished: read its plan artifact, then run the SAME caps → propose/seed tail
 * the inline webhook planner used ({@link applyDecompositionResult}) — either
 * PROPOSE the plan (``:decompose`` → comment + pending plan awaiting
 * ``@bgagent approve``) or SEED immediately (``:auto`` → write back sub-issues +
 * run Mode A). The only new thing vs the old planner is WHERE the plan came from
 * (an agent artifact, planned in a real clone with full repo context, instead of
 * a blind 30s Lambda Bedrock call). On a ``seed`` result we release roots +
 * post the panel via the reconciler's own primitives (mirrors the webhook's
 * seedAndReleaseFromGraph). Never throws — the handler loop treats a decompose
 * event as processed regardless.
 */
async function reconcileDecomposePlan(evt: DecomposePlanEvent): Promise<void> {
  if (!WORKSPACE_REGISTRY_TABLE) {
    // No per-workspace token source → can't post the proposal/note or write back.
    // (Same gate the webhook's Mode B path uses; without it there is nothing to do.)
    logger.warn('Decompose plan terminal but workspace registry table unset — skipping', {
      task_id: evt.taskId,
    });
    return;
  }
  const registryTable = WORKSPACE_REGISTRY_TABLE;

  // Idempotency: the TaskTable stream is at-least-once AND the agent writes the
  // terminal row several times (status, then artifact_uri, then cost/duration —
  // each a MODIFY that re-delivers this terminal event). Without a claim we'd
  // re-run the whole handler per delivery and post a fresh proposal comment each
  // time (live-caught on ABCA-498: 3 duplicate proposals; the pending-plan
  // create-once gate kept STATE correct but not the comment). Claim once per
  // planning task_id — the create-once conditional write means only the first
  // delivery proceeds; every replay no-ops here. (The webhook's inline path was
  // shielded by its 60s dedup table; the reconciler has no such upstream gate.)
  const claimOrchestrationId = deriveOrchestrationId(evt.parentIssueId);
  const claimed = await claimCommentAck(
    ddb, ORCHESTRATION_TABLE, claimOrchestrationId, `decompose#${evt.taskId}`,
    new Date().toISOString(), Math.floor(Date.now() / 1000) + PENDING_PLAN_TTL_SECONDS,
  );
  if (!claimed) {
    logger.info('Decompose plan already reconciled for this task — skipping redelivery', {
      task_id: evt.taskId, parent_issue_id: evt.parentIssueId,
    });
    return;
  }

  const feedbackCtx: LinearFeedbackContext = {
    linearWorkspaceId: evt.workspaceId, registryTableName: registryTable,
  };
  // #299 F-revise-in-place: forward an optional existingCommentId so the flow can
  // EDIT the plan comment in place on a revision (vs. posting a fresh one).
  const postComment = async (issueId: string, body: string, existingCommentId?: string): Promise<string | null> =>
    upsertStatusComment(feedbackCtx, issueId, body, existingCommentId);

  // Planning RUN did not complete (session failed to start — e.g. a compute
  // substrate error — cancelled, etc.). Post the honest "couldn't plan, nothing
  // started" note. We do NOT auto-create a single task here: the webhook
  // dispatched planning, and nothing has run. renderDecomposeUnavailableNote is
  // used (NOT renderPlannerErrorNote, which claims "running as a single task" —
  // false here, nothing ran).
  if (evt.status !== TaskStatus.COMPLETED) {
    logger.info('Decompose planning run did not complete — posting decompose-unavailable note', {
      task_id: evt.taskId, status: evt.status,
    });
    await postComment(evt.parentIssueId, renderDecomposeUnavailableNote());
    return;
  }

  const planText = await fetchPlanArtifact(evt);
  if (!planText) {
    // Run completed but produced no readable plan artifact — again nothing was
    // started, so the "unavailable, nothing run" note (not "running as single").
    await postComment(evt.parentIssueId, renderDecomposeUnavailableNote());
    return;
  }

  // Parse + validate the agent's plan JSON with the SAME helper the inline
  // planner's decomposer output flowed through (markdown-fence tolerant, <2-node
  // collapse to single_task, DAG-validated). Produces a DecompositionResult the
  // shared tail consumes exactly as it consumes planDecomposition's output.
  const parsed = parseDecomposerResponse(planText, evt.maxSubIssues, '');

  // Resolve the workspace token once — the :auto write-back needs a GraphQL
  // transport. A resolution failure only matters for the auto (write-back) path;
  // the manual proposal path posts via upsertStatusComment (own token) + persists
  // a pending plan (approve resolves its own token later).
  const resolved = await resolveLinearOauthToken(evt.workspaceId, registryTable);
  if (evt.mode === 'auto' && parsed.kind === 'plan' && !resolved) {
    logger.warn('Decompose :auto: could not resolve OAuth token for write-back', {
      parent_issue_id: evt.parentIssueId,
    });
    // Token unresolved → we can't write back the sub-issues; nothing started.
    await postComment(evt.parentIssueId, renderDecomposeUnavailableNote());
    return;
  }

  const caps: ProjectDecompositionCaps = {
    decompose_allowed: evt.decomposeAllowed,
    max_sub_issues: evt.maxSubIssues,
    ...(evt.maxParentBudgetUsd !== undefined && { max_parent_budget_usd: evt.maxParentBudgetUsd }),
  };

  // #299 F-revise-in-place: on a REVISION, read the prior plan proposal's comment
  // id so applyDecompositionResult edits THAT comment in place instead of stacking
  // a fresh "Updated breakdown". Only on a revision (round 0 has nothing to edit);
  // best-effort (a missing row just falls back to a fresh post).
  let priorProposalCommentId: string | undefined;
  if (evt.revisionRound !== undefined && evt.revisionRound > 0) {
    const existing = await getPendingPlan(ddb, ORCHESTRATION_TABLE, evt.parentIssueId);
    priorProposalCommentId = existing?.proposal_comment_id;
  }

  const result = await applyDecompositionResult({
    parentIssueId: evt.parentIssueId,
    planned: parsed,
    // The agent planned with FULL repo context (the whole point of #299), so a
    // decline is trusted — there is no repo-blindness left to compensate for, so
    // never route to the "underspecified, ask for detail" branch here.
    underspecified: false,
    caps,
    autoRun: evt.mode === 'auto',
    ...(evt.revisionRound !== undefined && { revisionRound: evt.revisionRound }),
    ...(priorProposalCommentId !== undefined && { priorProposalCommentId }),
    // #299 single-task gate: the parent's task_description, so a MANUAL
    // (``:decompose``) decline can PROPOSE the single task (persist a
    // pending_kind:'single' plan + wait for approve) instead of auto-running it.
    ...(evt.taskDescription !== undefined && { singleTaskDescription: evt.taskDescription }),
    effects: {
      postComment,
      putPendingPlan: async ({ nodes, proposalCommentId, revisionRound, repoDigest, repoDigestSha, pendingKind, singleTaskDescription }) => {
        const row = {
          ddb,
          tableName: ORCHESTRATION_TABLE,
          parentLinearIssueId: evt.parentIssueId,
          linearWorkspaceId: evt.workspaceId,
          repo: evt.repo,
          ...(evt.projectId && { linearProjectId: evt.projectId }),
          nodes,
          platformUserId: evt.platformUserId,
          ...(proposalCommentId !== undefined && { proposalCommentId }),
          ...(revisionRound !== undefined && { revisionRound }),
          // #299 plan-mode T2: persist the agent's repo digest + its sha so the
          // next revise run reuses the exploration.
          ...(repoDigest !== undefined && { repoDigest }),
          ...(repoDigestSha !== undefined && { repoDigestSha }),
          // #299 single-task gate: mark a 'single' pending plan + carry the
          // task_description approve will run.
          ...(pendingKind !== undefined && { pendingKind }),
          ...(singleTaskDescription !== undefined && { singleTaskDescription }),
          now: new Date().toISOString(),
          ttlEpochSeconds: Math.floor(Date.now() / 1000) + PENDING_PLAN_TTL_SECONDS,
        };
        // #299 revise loop: a revision (round ≥ 1) must OVERWRITE the prior
        // pending plan — create-once would silently keep the stale one and
        // approve would seed it. Round 0 stays create-once (redelivery-safe).
        return (revisionRound !== undefined && revisionRound > 0)
          ? replacePendingPlan(row)
          : putPendingPlan(row);
      },
      // Only used on the :auto path; a null token there was already handled above.
      graphql: linearGraphqlFn(resolved?.accessToken ?? ''),
    },
  });

  // #299 F-revise-in-place: the revised plan has now matured (edited in place, or a
  // collapse/over-cap note posted), so settle the reviewer's FEEDBACK comment
  // 👀 → ✅ — that's how they can tell the re-plan finished (the 👀 the webhook put
  // on it at dispatch previously never settled → read as stuck). The ONE plan
  // comment updated in place; their feedback comment now shows ✅. Best-effort —
  // never throws out of the reconcile. Only on a revision that carried the id.
  if (evt.revisingFeedbackCommentId) {
    try {
      await swapCommentReaction(feedbackCtx, evt.revisingFeedbackCommentId, EMOJI_SUCCESS);
    } catch (err) {
      logger.warn('F-revise-in-place: failed to settle feedback comment 👀→✅ (non-fatal)', {
        parent_issue_id: evt.parentIssueId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.kind === 'seed') {
    // :auto wrote back real Linear sub-issues → seed the executor + release roots.
    await seedDecomposedGraph(evt, result.children, resolved!.oauthSecretArn, resolved!.workspaceSlug);
    return;
  }
  if (result.kind === 'single_task') {
    // A REVISION that collapses to one unit must NOT auto-dispatch a coding task:
    // evt.taskDescription here is the revision META-PROMPT ("You previously
    // proposed a decomposition… REVISE…"), so createTaskCore would spawn a
    // nonsensical run (live-caught on ABCA-510). The reviewer explicitly opted
    // into planning and their feedback merged it into one unit — post an honest
    // note and let them decide (approve → run as single, or give more feedback);
    // don't silently burn a run from a meta-prompt.
    if (evt.revisionRound !== undefined) {
      logger.info('Decompose revision collapsed to single unit — awaiting user decision (no auto-run)', {
        parent_issue_id: evt.parentIssueId, revision_round: evt.revisionRound,
      });
      await postComment(evt.parentIssueId, renderRevisionToSingleNote());
      return;
    }
    // Round-0 decline: evt.taskDescription is the issue's own title+body, so
    // running it as a single task is correct — applyDecompositionResult already
    // posted the decline note; create the task so the work still happens.
    logger.info('Decompose planner declined — creating single task', {
      parent_issue_id: evt.parentIssueId, reason: result.reason,
    });
    // CONFUSING-3 (silent :auto window): thread the FULL Linear OAuth metadata —
    // this was the ~9.5-min "zero output" run the QA tester hit on the :auto
    // single-task path. Without linear_oauth_secret_arn / linear_workspace_slug
    // the agent can't authenticate to Linear, so it never posts "🤖 Starting",
    // never transitions state, and never reacts — the run is a total black box
    // until the PR lands (same metadata-dropping class as ABCA-487/488). The
    // secret arn rotates, so we pass the freshly-resolved one, not a stored id.
    await createTaskCore(
      {
        repo: evt.repo,
        task_description: evt.taskDescription ?? `Implement ${evt.parentIssueId}`,
      },
      {
        userId: evt.platformUserId,
        channelSource: 'linear',
        channelMetadata: {
          linear_issue_id: evt.parentIssueId,
          linear_workspace_id: evt.workspaceId,
          linear_project_id: evt.projectId,
          ...(resolved?.oauthSecretArn && { linear_oauth_secret_arn: resolved.oauthSecretArn }),
          ...(resolved?.workspaceSlug && { linear_workspace_slug: resolved.workspaceSlug }),
        },
      },
      `decompose-single-${evt.taskId}`.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH),
    );
    return;
  }
  // 'handled' (awaiting approval / over-cap / write-back error) or 'noop'
  // (redelivery) → nothing more; a comment was already posted.
  logger.info('Decompose plan reconciled', { parent_issue_id: evt.parentIssueId, result: result.kind, reason: result.reason });
}

/**
 * Seed the #247 orchestration from a decompose plan's written-back children +
 * release roots. Mirrors the webhook's seedAndReleaseFromGraph, using the
 * reconciler's own primitives (discoverOrchestration over a declarativeGraphSource
 * → releaseReadyChildren → panel).
 */
async function seedDecomposedGraph(
  evt: DecomposePlanEvent,
  children: readonly SubIssueNode[],
  oauthSecretArn: string,
  workspaceSlug: string,
): Promise<void> {
  const releaseContext: OrchestrationReleaseContext = {
    platform_user_id: evt.platformUserId,
    channel_source: 'linear',
    linear_oauth_secret_arn: oauthSecretArn,
    linear_workspace_slug: workspaceSlug,
    linear_project_id: evt.projectId,
  };
  const discovery = await discoverOrchestration({
    ddb,
    tableName: ORCHESTRATION_TABLE,
    accessToken: '',
    parentLinearIssueId: evt.parentIssueId,
    linearWorkspaceId: evt.workspaceId,
    repo: evt.repo,
    now: new Date().toISOString(),
    releaseContext,
    graphSource: declarativeGraphSource(children),
  });
  if (discovery.kind !== 'seeded') {
    logger.info('Decompose :auto seed: discovery non-seeded', { parent_issue_id: evt.parentIssueId, kind: discovery.kind });
    return;
  }
  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
  if (snapshot) {
    const budget = USER_CONCURRENCY_TABLE
      ? await readConcurrencyBudget(ddb, USER_CONCURRENCY_TABLE, snapshot.meta.release_context.platform_user_id, MAX_CONCURRENT)
      : undefined;
    await releaseReadyChildren(
      ddb, ORCHESTRATION_TABLE, snapshot.children, snapshot.meta.release_context,
      createTaskCore, new Date().toISOString(), snapshot.children, 'main', budget,
    );
  }
  if (WORKSPACE_REGISTRY_TABLE) {
    try {
      const fresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
      if (fresh) {
        const commentId = await upsertEpicPanel({
          ctx: { linearWorkspaceId: evt.workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE },
          parentLinearIssueId: evt.parentIssueId,
          children: fresh.children,
          inProgress: true,
          mirrorParentState: true,
        });
        if (commentId) await setStatusCommentId(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId, commentId);
      }
    } catch (err) {
      logger.warn('Decompose :auto seed: panel post failed (non-fatal)', {
        parent_issue_id: evt.parentIssueId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info('Decompose :auto: orchestration seeded from agent plan', {
    parent_issue_id: evt.parentIssueId, orchestration_id: discovery.orchestrationId, child_count: discovery.childCount,
  });
}

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  let processed = 0;
  for (const record of event.Records) {
    // #299 agent-native planning: a terminal coding/decompose-v1 PLANNING task
    // isn't an orchestration child (it has no orchestration_id — it CREATES the
    // graph). Detect + handle it BEFORE parseTerminalTaskRecord, which would
    // return null on it (no orchestration_id) and drop it silently.
    const decomposeEvt = parseDecomposePlanRecord(record);
    if (decomposeEvt) {
      await reconcileDecomposePlan(decomposeEvt);
      processed += 1;
      continue;
    }
    const evt = parseTerminalTaskRecord(record);
    if (!evt) continue;
    // A6 cascade: an iteration/restack task on a node X (NOT a child-row task)
    // re-stacks X's direct dependents. Routed here, not through child gating.
    if (evt.cascadeSubIssueId) {
      await cascadeRestack(evt);
    } else {
      await reconcileTerminalChild(evt);
    }
    processed += 1;
  }
  logger.info('Orchestration reconciler batch processed', {
    records: event.Records.length,
    reconciled: processed,
  });
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && 'name' in err
    && (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}
