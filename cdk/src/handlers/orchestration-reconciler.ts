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
  DynamoDBDocumentClient,
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
import { releaseReadyChildren } from './shared/orchestration-release';
import { postRollup, rollupKindFromChildren } from './shared/orchestration-rollup';
import {
  loadOrchestration,
  type OrchestrationChildRow,
} from './shared/orchestration-store';
import { OrchestrationTable } from '../constructs/orchestration-table';
import { TaskStatus, type TaskStatusType } from '../constructs/task-status';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME!;
// A5: registry table for the parent rollup comment's per-workspace OAuth
// token. Unset → rollup is skipped (gating still works).
const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;

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

  return {
    taskId,
    status,
    ...(buildPassed !== undefined && { buildPassed }),
    orchestrationId,
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
    const results = await releaseReadyChildren(
      ddb,
      ORCHESTRATION_TABLE,
      releasableRows,
      (fresh ?? snapshot).meta.release_context,
      createTaskCore,
      now,
      // #247 A4: pass the full child set so each releasable child's base
      // branch can be derived from its predecessors' persisted branches.
      freshChildren,
    );
    logger.info('Reconciler released children', {
      orchestration_id: orchestrationId,
      trigger_sub_issue_id: subIssueId,
      released: results.filter((r) => r.kind === 'released').length,
      requested: releasableRows.length,
    });
  }

  // Completion check against the fresh view: every child terminal
  // (succeeded/failed/skipped — released is NOT terminal).
  const allTerminal = freshChildren.every((c) =>
    c.child_status === 'succeeded' || c.child_status === 'failed' || c.child_status === 'skipped',
  );
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
    if (WORKSPACE_REGISTRY_TABLE) {
      await postRollup({
        ctx: { linearWorkspaceId: meta.linear_workspace_id, registryTableName: WORKSPACE_REGISTRY_TABLE },
        orchestrationId,
        parentLinearIssueId: meta.parent_linear_issue_id,
        kind: rollupKindFromChildren(freshChildren),
        children: freshChildren,
      });
    }
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
    await reconcileTerminalChild(evt);
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
