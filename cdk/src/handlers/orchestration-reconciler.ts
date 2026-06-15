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
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { createTaskCore } from './shared/create-task-core';
import { logger } from './shared/logger';
import { ORCH_LOG } from './shared/orchestration-log-events';
import {
  computeReconcilePlan,
  type ReconcileChild,
  type TerminalOutcome,
} from './shared/orchestration-reconcile';
import { readConcurrencyBudget, releaseReadyChildren } from './shared/orchestration-release';
import { planDirectRestack, type RestackStep } from './shared/orchestration-restack';
import { postRollup, renderStatusBlock, rollupKindFromChildren } from './shared/orchestration-rollup';
import { postIssueComment, upsertStatusComment } from './shared/linear-feedback';
import { isIntegrationNode } from './shared/orchestration-integration-node';
import {
  claimRollup,
  loadOrchestration,
  type OrchestrationChildRow,
} from './shared/orchestration-store';
import type { ChannelSource } from './shared/types';
import { OrchestrationTable } from '../constructs/orchestration-table';
import { TaskStatus, type TaskStatusType } from '../constructs/task-status';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
// A5: registry table for the parent rollup comment's per-workspace OAuth
// token. Unset → rollup is skipped (gating still works).
const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
// #331: throttle releases to the user's free concurrency budget so a wide
// fan-out doesn't over-release children that admission then hard-fails. Unset
// table → no throttle (release-all, back-compat; admission still gates).
const USER_CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');

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

  // A6 cascade marker: an iteration/restack task names the node it acted on
  // via channel_metadata. A restack task also carries
  // ``restack_predecessor_sub_issue_id`` — its presence (or the explicit
  // ``orchestration_iteration`` flag the comment trigger sets) marks this as
  // a cascade SOURCE rather than a normal child task. We resolve the acted-on
  // node from ``orchestration_sub_issue_id`` and confirm "is this a child row?"
  // in the handler (a child-row task drives normal gating; a non-child-row
  // task with this marker drives the cascade).
  const cm = img.channel_metadata?.M;
  const isCascadeSource =
    cm?.restack_predecessor_sub_issue_id?.S !== undefined
    || cm?.orchestration_iteration?.S === 'true';
  const cascadeSubIssueId = isCascadeSource ? cm?.orchestration_sub_issue_id?.S : undefined;

  return {
    taskId,
    status,
    ...(buildPassed !== undefined && { buildPassed }),
    orchestrationId,
    ...(cascadeSubIssueId !== undefined && { cascadeSubIssueId }),
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
    .filter((c) => c.child_status === 'blocked' && c.depends_on.every((d) => succeeded.has(d)))
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

  // Completion check against the fresh view: every child terminal
  // (succeeded/failed/skipped — released is NOT terminal).
  const allTerminal = freshChildren.every((c) =>
    c.child_status === 'succeeded' || c.child_status === 'failed' || c.child_status === 'skipped',
  );

  // #247 #3: while the orchestration is still in flight, edit the live
  // status block on the parent so "where are we" stays current on every
  // child transition. Skipped when all-terminal (the final rollup below
  // replaces the body with the completion view). Best-effort; only when a
  // status comment was created at seed.
  if (!allTerminal && WORKSPACE_REGISTRY_TABLE) {
    const liveMeta = (fresh ?? snapshot).meta;
    if (liveMeta.status_comment_id) {
      // #323: link each child's PR in the live block as soon as it is known.
      const prUrls = await resolveChildPrUrls(freshChildren);
      const childViews = freshChildren.map((c) => ({
        sub_issue_id: c.sub_issue_id,
        ...(c.linear_identifier !== undefined && { linear_identifier: c.linear_identifier }),
        ...(c.title !== undefined && { title: c.title }),
        child_status: c.child_status,
        ...(prUrls[c.sub_issue_id] !== undefined && { pr_url: prUrls[c.sub_issue_id] }),
      }));
      await upsertStatusComment(
        { linearWorkspaceId: liveMeta.linear_workspace_id, registryTableName: WORKSPACE_REGISTRY_TABLE },
        liveMeta.parent_linear_issue_id,
        renderStatusBlock(childViews),
        liveMeta.status_comment_id,
      );
    }
  }

  if (allTerminal) {
    const meta = (fresh ?? snapshot).meta;
    const counts = {
      succeeded: freshChildren.filter((c) => c.child_status === 'succeeded').length,
      failed: freshChildren.filter((c) => c.child_status === 'failed').length,
      skipped: freshChildren.filter((c) => c.child_status === 'skipped').length,
    };
    logger.info('Orchestration complete', {
      event: ORCH_LOG.orchestrationComplete,
      orchestration_id: orchestrationId,
      parent_linear_issue_id: meta.parent_linear_issue_id,
      ...counts,
    });
    // A5: post the aggregate rollup comment on the PARENT issue (the
    // fan-out plane only comments per-child sub-issue). Best-effort.
    //
    // Idempotency: the orchestration can reach "all terminal" on more
    // than one stream event (the last child's record often gets two
    // MODIFYs), which posted the rollup twice. claimRollup conditionally
    // stamps the meta row — only the first caller posts.
    if (WORKSPACE_REGISTRY_TABLE) {
      const won = await claimRollup(ddb, ORCHESTRATION_TABLE, orchestrationId, now);
      if (won) {
        // #323: resolve each child's PR url so the rollup links every
        // sub-issue's PR + the integration node's combined PR.
        const prUrls = await resolveChildPrUrls(freshChildren);
        await postRollup({
          ctx: { linearWorkspaceId: meta.linear_workspace_id, registryTableName: WORKSPACE_REGISTRY_TABLE },
          orchestrationId,
          parentLinearIssueId: meta.parent_linear_issue_id,
          kind: rollupKindFromChildren(freshChildren),
          children: freshChildren,
          prUrls,
          // #247 trigger-agnostic: dispatch the rollup to the channel that
          // seeded the orchestration (defaults to 'linear' inside postRollup).
          ...(meta.release_context.channel_source !== undefined && {
            channelSource: meta.release_context.channel_source as ChannelSource,
          }),
          // #247 #3: edit the live status block in place into the final
          // rollup (one comment for the whole run, no stream). Falls back to
          // a fresh comment inside postRollup when no id was stamped at seed.
          ...(meta.status_comment_id !== undefined && {
            statusCommentId: meta.status_comment_id,
          }),
        });
      } else {
        logger.info('Rollup already claimed — skipping duplicate', {
          event: ORCH_LOG.orchestrationComplete,
          orchestration_id: orchestrationId,
          duplicate_suppressed: true,
        });
      }
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

  // Only a successful change should cascade onto dependents.
  if (evt.status !== TaskStatus.COMPLETED || evt.buildPassed === false) {
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

  const steps = planDirectRestack(snapshot.children, changedSubIssueId);
  if (steps.length === 0) {
    logger.info('A6 cascade: no started direct dependents to re-stack', {
      orchestration_id: orchestrationId,
      changed_sub_issue_id: changedSubIssueId,
    });
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
  const changedLabel = changedRow?.linear_identifier ?? changedRow?.title ?? 'a predecessor';

  const feedbackCtx = WORKSPACE_REGISTRY_TABLE
    ? { linearWorkspaceId: meta.linear_workspace_id, registryTableName: WORKSPACE_REGISTRY_TABLE }
    : undefined;

  const restackedLabels: string[] = [];
  for (const step of steps) {
    const created = await spawnRestackTask(step, meta.release_context.platform_user_id, evt.taskId, changedSubIssueId);
    // Surface ONLY on a genuinely NEW restack task (201). A 200 means an
    // idempotent replay (the cascade source's stream record is redelivered
    // multiple times — observed 3× live), and surfacing on those would post
    // duplicate comments. ``false`` means the spawn failed/was skipped.
    if (created !== 'created') continue;
    const dep = step.child;
    restackedLabels.push(dep.linear_identifier ?? dep.sub_issue_id);
    // A6 surfacing (#34): tell the DEPENDENT's sub-issue it was re-stacked, so
    // a reviewer watching that issue sees its PR was updated to pick up the
    // predecessor's change. Skip synthetic integration nodes (no Linear issue).
    if (feedbackCtx && !isIntegrationNode(dep.sub_issue_id)) {
      try {
        await postIssueComment(
          feedbackCtx,
          dep.sub_issue_id,
          `🔄 **Re-stacked** — picked up changes from ${changedLabel} and updated this PR. `
          + 'No action needed; review the refreshed PR when ready.',
        );
      } catch (err) {
        logger.warn('A6 cascade: dependent re-stack comment failed (non-fatal)', {
          orchestration_id: orchestrationId, sub_issue_id: dep.sub_issue_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // A6 surfacing (#35): the parent rollup is frozen from the original run, so a
  // post-completion comment-triggered change is otherwise invisible at the
  // epic level. Post a concise cascade note on the PARENT so the
  // comment-to-change loop is visible there. Best-effort; Linear plane only.
  if (feedbackCtx && restackedLabels.length > 0) {
    try {
      const list = restackedLabels.join(', ');
      await postIssueComment(
        feedbackCtx,
        meta.parent_linear_issue_id,
        `🔄 **${changedLabel} was revised** (via a comment) → re-stacked `
        + `${restackedLabels.length} dependent${restackedLabels.length === 1 ? '' : 's'}: ${list}. `
        + 'Their PRs were updated to include the change.',
      );
    } catch (err) {
      logger.warn('A6 cascade: parent cascade note failed (non-fatal)', {
        orchestration_id: orchestrationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
  const idempotencyKey = `restack_${child.sub_issue_id}_${sourceTaskId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);

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
export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  let processed = 0;
  for (const record of event.Records) {
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
