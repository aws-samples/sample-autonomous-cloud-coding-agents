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
 * Scheduled backstop for Linear orchestration (#247 A3, gap #303).
 *
 * The live reconciler (``orchestration-reconciler``) releases
 * dependency-unblocked children by reacting to TaskTable-stream terminal
 * events. If the reconciler is unavailable when a child reaches terminal
 * state (deploy window, throttle, OOM, a poison-record batch parked in
 * the DLQ), **that stream event is lost and never reprocessed** — the
 * dependent children never get released and the orchestration stalls
 * forever with no recovery.
 *
 * Observed live on dev (2026-06-09): a child reached COMPLETED during a
 * reconciler OOM window; after the fix deployed, the completion event was
 * gone, so its dependent stayed ``blocked`` until a manual nudge.
 *
 * This scheduled sweep is the recovery path. It also fixes the
 * crash-after-flip hole that the F2 fix relies on (a child stuck
 * ``released`` whose task is long-terminal, or a ``ready`` child whose
 * release never created a task — see
 * ``docs/research/orchestration-reconciler-correctness.md``).
 *
 * For each active orchestration it re-derives the gating truth from
 * persisted state and:
 *   - releases any ``blocked``/``ready`` child whose predecessors are all
 *     ``succeeded`` (lost release-event recovery), and
 *   - re-evaluates children whose own task already reached terminal but
 *     whose row never advanced (lost terminal-event recovery), advancing
 *     the row + cascading skips/releases accordingly.
 *
 * Idempotent: ``releaseChild`` is idempotency-keyed and the row flips are
 * conditional, so re-running the sweep (or racing the live reconciler) is
 * safe.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { createTaskCore } from './shared/create-task-core';
import { logger } from './shared/logger';
import {
  loadOrchestration,
  ORCHESTRATION_META_SK,
  type OrchestrationChildRow,
} from './shared/orchestration-store';
import { readConcurrencyBudget, releaseReadyChildren } from './shared/orchestration-release';
import { TaskStatus, type TaskStatusType } from '../constructs/task-status';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
// #331: throttle the sweep's releases to the user's free concurrency budget
// too (it is the drain path for children left ``ready`` by the live
// reconciler's throttle). Unset → release-all (back-compat; admission gates).
const USER_CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');

/** Terminal child-statuses (orchestration-local). */
const TERMINAL_CHILD = new Set(['succeeded', 'failed', 'skipped']);

/** A task is success for gating iff COMPLETED with build not-failed. */
function taskIsSuccess(rec: Record<string, unknown> | undefined): boolean {
  return rec?.status === TaskStatus.COMPLETED && rec?.build_passed !== false;
}
function taskIsTerminal(status: TaskStatusType | undefined): boolean {
  return status === TaskStatus.COMPLETED || status === TaskStatus.FAILED
    || status === TaskStatus.CANCELLED || status === TaskStatus.TIMED_OUT;
}

/** Scan the table for parent-meta rows → one per orchestration. */
async function findOrchestrationIds(): Promise<string[]> {
  const ids: string[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await ddb.send(new ScanCommand({
      TableName: ORCHESTRATION_TABLE,
      FilterExpression: 'sub_issue_id = :meta',
      ExpressionAttributeValues: { ':meta': ORCHESTRATION_META_SK },
      ProjectionExpression: 'orchestration_id',
      ExclusiveStartKey: lastKey as Record<string, never> | undefined,
    }));
    for (const item of resp.Items ?? []) {
      if (item.orchestration_id) ids.push(item.orchestration_id as string);
    }
    lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return ids;
}

/** Fetch a released child's task record (status + build_passed). */
async function getTaskRecord(taskId: string): Promise<Record<string, unknown> | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TASK_TABLE, Key: { task_id: taskId } }));
  return res.Item;
}

/**
 * Reconcile one orchestration from persisted truth. Returns the number of
 * children released by this pass (for logging/metrics).
 */
async function reconcileOrchestration(orchestrationId: string): Promise<number> {
  const snap = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!snap) return 0;

  // Skip orchestrations already fully terminal — nothing to recover.
  const allTerminal = snap.children.every((c) => TERMINAL_CHILD.has(c.child_status));
  if (allTerminal) return 0;

  const now = new Date().toISOString();

  // 1. Recover LOST TERMINAL events: a ``released`` child whose task has
  //    already reached terminal but whose row never advanced. Advance the
  //    row to succeeded/failed so step 2 can gate dependents correctly.
  for (const child of snap.children) {
    if (child.child_status !== 'released' || !child.child_task_id) continue;
    const rec = await getTaskRecord(child.child_task_id);
    if (!taskIsTerminal(rec?.status as TaskStatusType | undefined)) continue; // still running
    const newStatus = taskIsSuccess(rec) ? 'succeeded' : 'failed';
    await advanceChildStatus(orchestrationId, child.sub_issue_id, newStatus, now);
  }

  // 2. Re-load (statuses may have advanced) and release any blocked/ready
  //    child whose predecessors are all succeeded, plus skip children with
  //    a failed predecessor. Derive everything from the fresh persisted
  //    state — the same truth the live reconciler uses.
  const fresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!fresh) return 0;

  const statusOf = new Map(fresh.children.map((c) => [c.sub_issue_id, c.child_status]));

  // Cascade skips: any child with a failed/skipped predecessor → skipped.
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of fresh.children) {
      if (statusOf.get(c.sub_issue_id) !== 'blocked' && statusOf.get(c.sub_issue_id) !== 'ready') continue;
      const deadDep = c.depends_on.some((d) => {
        const s = statusOf.get(d);
        return s === 'failed' || s === 'skipped';
      });
      if (deadDep) {
        await advanceChildStatus(orchestrationId, c.sub_issue_id, 'skipped', now);
        statusOf.set(c.sub_issue_id, 'skipped');
        changed = true;
      }
    }
  }

  // Releasable: children whose deps are ALL succeeded and that have NOT yet
  // started a task. Includes:
  //   - ``blocked`` children (lost release-event recovery), and
  //   - ``ready`` children with no ``child_task_id`` — left un-started by the
  //     live reconciler's #331 concurrency throttle (or a prior create_failed).
  //     A ``ready`` child that already has a task was genuinely released; re-
  //     releasing is idempotent, but we skip it to keep the budget for new work.
  const releasableRows: OrchestrationChildRow[] = fresh.children
    .filter((c) => {
      const s = statusOf.get(c.sub_issue_id);
      const depsReady = c.depends_on.every((d) => statusOf.get(d) === 'succeeded');
      if (!depsReady) return false;
      if (s === 'blocked') return true;
      if (s === 'ready' && !c.child_task_id) return true; // throttle-deferred
      return false;
    })
    .map((c) => ({ ...c, child_status: 'ready' as const }));

  if (releasableRows.length === 0) return 0;

  // #331: throttle the sweep's releases to the free budget too.
  const budget = USER_CONCURRENCY_TABLE
    ? await readConcurrencyBudget(ddb, USER_CONCURRENCY_TABLE, fresh.meta.release_context.platform_user_id, MAX_CONCURRENT)
    : undefined;
  const results = await releaseReadyChildren(
    ddb, ORCHESTRATION_TABLE, releasableRows, fresh.meta.release_context, createTaskCore, now,
    // #247 A4: full child set for predecessor-branch-derived base selection.
    fresh.children,
    'main',
    budget,
  );
  const released = results.filter((r) => r.kind === 'released').length;
  if (released > 0) {
    logger.warn('Stranded orchestration recovered — released children the live reconciler missed', {
      orchestration_id: orchestrationId,
      released,
      candidates: releasableRows.length,
    });
  }
  return released;
}

/** Conditionally advance a child row's status (no-op if already there). */
async function advanceChildStatus(
  orchestrationId: string,
  subIssueId: string,
  status: string,
  now: string,
): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: ORCHESTRATION_TABLE,
      Key: { orchestration_id: orchestrationId, sub_issue_id: subIssueId },
      UpdateExpression: 'SET child_status = :s, updated_at = :now',
      ConditionExpression: 'child_status <> :s',
      ExpressionAttributeValues: { ':s': status, ':now': now },
    }));
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return;
    throw err;
  }
}

/**
 * Scheduled entry point. Sweeps every active orchestration. A failure on
 * one orchestration is logged and does not abort the rest.
 */
export async function handler(): Promise<void> {
  const ids = await findOrchestrationIds();
  let totalReleased = 0;
  let swept = 0;
  for (const id of ids) {
    try {
      totalReleased += await reconcileOrchestration(id);
      swept += 1;
    } catch (err) {
      logger.error('Stranded-orchestration sweep failed for one orchestration (continuing)', {
        orchestration_id: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info('Stranded-orchestration sweep complete', {
    orchestrations_swept: swept,
    orchestrations_found: ids.length,
    children_released: totalReleased,
  });
}
