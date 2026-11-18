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
 * Scheduled backstop for Linear orchestration.
 *
 * The live reconciler (``orchestration-reconciler``) releases
 * dependency-unblocked children by reacting to TaskTable-stream terminal
 * events. If the reconciler is unavailable when a child reaches terminal
 * state (deploy window, throttle, OOM, a poison-record batch parked in
 * the DLQ), **that stream event is lost and never reprocessed** — the
 * dependent children never get released and the orchestration stalls
 * forever with no recovery.
 *
 * Observed in practice: a child reached COMPLETED during a
 * reconciler OOM window; after the fix deployed, the completion event was
 * gone, so its dependent stayed ``blocked`` until a manual nudge.
 *
 * This scheduled sweep is the recovery path. It also closes the
 * crash-after-flip hole in the release path: a child stuck
 * ``released`` whose task is long-terminal, or a ``ready`` child whose
 * release never created a task. (The failure modes this covers are
 * analysed in ``docs/research/orchestration-reconciler-correctness.md``.)
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

import {
  ScanCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { TaskStatus, type TaskStatusType } from '../constructs/task-status';
import { refreshPanelAndSettle } from './orchestration-reconciler';
import { createTaskCore } from './shared/create-task-core';
import { logger } from './shared/logger';
import { applyTerminalCreateFailures, readConcurrencyBudget, releaseReadyChildren } from './shared/orchestration-release';
import {
  loadOrchestration,
  ORCHESTRATION_META_SK,
  type OrchestrationChildRow,
} from './shared/orchestration-store';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
// Throttle the sweep's releases to the user's free concurrency budget
// too (it is the drain path for children left ``ready`` by the live
// reconciler's throttle). Unset → release-all (back-compat; admission gates).
const USER_CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');

/** Terminal child-statuses (orchestration-local). */
const TERMINAL_CHILD = new Set(['succeeded', 'failed', 'skipped']);

/**
 * How old a ``releasing`` claim must be before the sweep takes it for crashed.
 * A releaser stamps the claim with a time read inside its own invocation and
 * creates the task while it holds it, so the claim can be live for as long as
 * that Lambda may run. Resetting a live one lets a second releaser create a
 * second task for the same child (task creation deduplicates through an
 * eventually consistent index, which a create still in flight is not in).
 * Twice the longest timeout among the Lambdas that release (5 minutes: the
 * Jira webhook processor and this sweep) — keep it above that timeout.
 */
const RELEASING_GRACE_MS = 10 * 60 * 1000;

/**
 * How long after an epic was settled the sweep still settles it again. Rows of
 * finished epics stay in the table, and each settle renders the panel anew and
 * edits its comment: with no limit every run would do that for every epic that
 * ever finished, and a render made after the epic's task records have expired
 * has no pull request links left to show. The hour leaves the repeat what it
 * is good for: about six more attempts at a panel edit that failed right after
 * the stamp was written, or at a link that landed late.
 */
const SETTLED_GRACE_MS = 60 * 60 * 1000;

/** A task is success for gating iff COMPLETED with build not-failed. */
function taskIsSuccess(rec: Record<string, unknown> | undefined): boolean {
  return rec?.status === TaskStatus.COMPLETED && rec?.build_passed !== false;
}
function taskIsTerminal(status: TaskStatusType | undefined): boolean {
  return status === TaskStatus.COMPLETED || status === TaskStatus.FAILED
    || status === TaskStatus.CANCELLED || status === TaskStatus.TIMED_OUT;
}

/** What the sweep's scan reads of a parent-meta row. */
interface ScannedMeta {
  readonly orchestration_id: string;
  /** When the epic was settled (``claimRollup``); absent until then, and removed
   *  by whatever re-opens the epic. */
  readonly rollup_posted_at?: string;
}

/** Scan the table for parent-meta rows → one per orchestration. */
async function findOrchestrations(): Promise<ScannedMeta[]> {
  const metas: ScannedMeta[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await ddb.send(new ScanCommand({
      TableName: ORCHESTRATION_TABLE,
      FilterExpression: 'sub_issue_id = :meta',
      ExpressionAttributeValues: { ':meta': ORCHESTRATION_META_SK },
      ProjectionExpression: 'orchestration_id, rollup_posted_at',
      ExclusiveStartKey: lastKey as Record<string, never> | undefined,
    }));
    for (const item of resp.Items ?? []) {
      if (item.orchestration_id) metas.push(item as ScannedMeta);
    }
    lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return metas;
}

/** Fetch a released child's task record (status + build_passed). */
async function getTaskRecord(taskId: string): Promise<Record<string, unknown> | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TASK_TABLE, Key: { task_id: taskId } }));
  return res.Item;
}

/**
 * Reconcile one orchestration from persisted truth. Returns the number of
 * children released by this pass (for logging/metrics).
 *
 * ``rollupPostedAt`` is the meta row's settle stamp as the scan read it.
 */
async function reconcileOrchestration(orchestrationId: string, rollupPostedAt?: string): Promise<number> {
  const snap = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!snap) return 0;

  const now = new Date().toISOString();

  // Already fully terminal: no children to release/recover — BUT the parent may
  // never have been settled (the last terminal event was lost, so the DDB rows
  // are all terminal yet the Linear parent is stuck 🔄 In Progress
  // forever). Attempt the idempotent settle before returning, instead of the old
  // bare skip that guaranteed the epic never closed on the lossy path.
  const allTerminal = snap.children.every((c) => TERMINAL_CHILD.has(c.child_status));
  if (allTerminal) {
    // Settled long enough ago: leave it alone (see SETTLED_GRACE_MS).
    if (rollupPostedAt && Date.now() - Date.parse(rollupPostedAt) > SETTLED_GRACE_MS) return 0;
    try {
      await refreshPanelAndSettle(orchestrationId, snap.children, snap.meta, now);
    } catch (err) {
      logger.warn('Sweep settle (already-terminal epic) failed (will retry next sweep)', {
        orchestration_id: orchestrationId, error: err instanceof Error ? err.message : String(err),
      });
    }
    return 0;
  }

  // 1a. Recover a child STUCK in the transient ``releasing`` state (the
  //     flip-then-create claim): a releaser won the blocked|ready→releasing claim but
  //     crashed before createTaskCore (or before its rollback). No task exists,
  //     so reset it to ``ready`` — step 2 re-releases it under a fresh claim.
  //     Only a claim older than RELEASING_GRACE_MS is taken for crashed, and the
  //     reset is conditional on the row still carrying that very claim
  //     (``updated_at`` is the claim's stamp), so we race neither a live create
  //     nor a claim that replaced the dead one after we read it.
  for (const child of snap.children) {
    if (child.child_status !== 'releasing') continue;
    if (Date.now() - Date.parse(child.updated_at) < RELEASING_GRACE_MS) continue;
    try {
      await ddb.send(new UpdateCommand({
        TableName: ORCHESTRATION_TABLE,
        Key: { orchestration_id: orchestrationId, sub_issue_id: child.sub_issue_id },
        UpdateExpression: 'SET child_status = :ready, updated_at = :now',
        ConditionExpression: 'child_status = :releasing AND updated_at = :seen',
        ExpressionAttributeValues: {
          ':ready': 'ready', ':releasing': 'releasing', ':now': now, ':seen': child.updated_at,
        },
      }));
      logger.info('Recovered orchestration child stuck in releasing → ready (crashed mid-release)', {
        orchestration_id: orchestrationId, sub_issue_id: child.sub_issue_id,
      });
    } catch (err) {
      // ConditionalCheckFailed = the row moved off 'releasing' (a live finalize
      // won) or the claim changed hands — fine, nothing to recover. Anything
      // else: log and let the next sweep retry.
      if ((err as { name?: string })?.name !== 'ConditionalCheckFailedException') {
        logger.warn('Failed to recover releasing child (will retry next sweep)', {
          orchestration_id: orchestrationId,
          sub_issue_id: child.sub_issue_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 1b. Recover LOST TERMINAL events: a ``released`` child whose task has
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
  let cascaded = false;
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
        // Only skip from blocked/ready. A concurrent recovery could
        // have re-released this child (blocked → releasing/released) between our
        // snapshot and this write; the source-state guard makes that write a
        // no-op instead of clobbering a running child into terminal 'skipped'.
        await advanceChildStatus(orchestrationId, c.sub_issue_id, 'skipped', now, ['blocked', 'ready']);
        statusOf.set(c.sub_issue_id, 'skipped');
        changed = true;
        cascaded = true;
      }
    }
  }

  // Releasable: children whose deps are ALL succeeded and that have NOT yet
  // started a task. Includes:
  //   - ``blocked`` children (lost release-event recovery), and
  //   - ``ready`` children with no ``child_task_id`` — left un-started by the
  //     live reconciler's concurrency throttle (or a prior create_failed).
  //     A ``ready`` child that already has a task was genuinely released; re-
  //     releasing is idempotent, but we skip it to keep the budget for new work.
  const releasableRows: OrchestrationChildRow[] = fresh.children
    .filter((c) => {
      const s = statusOf.get(c.sub_issue_id);
      const depsReady = c.depends_on.every((d) => statusOf.get(d) === 'succeeded');
      if (!depsReady) return false;
      if (s === 'blocked') return true;
      // `ready`, deliberately id-agnostic: a ready child left un-released by the
      // concurrency throttle OR reset-to-ready by an epic retry (which KEEPS its
      // prior child_task_id to salt the idempotency key). The old
      // `!child_task_id` gate stranded retried children forever. Re-releasing is
      // safe: the salt spawns a fresh task and the flip-then-create claim is the
      // race guard.
      if (s === 'ready') return true;
      return false;
    })
    .map((c) => ({ ...c, child_status: 'ready' as const }));

  // Settle the parent if the epic has ended. ``reload``: this pass has written
  // terminal statuses that ``fresh`` does not show, so the rows are read again
  // (not patched in: a skip is refused when its row has moved on).
  const settleIfEnded = async (reload: boolean): Promise<void> => {
    // Nothing left to release. If EVERY child is now terminal
    // but the parent was never settled — because the last child's terminal stream
    // event was lost (the exact failure this sweep exists to recover) — the epic
    // is 'done' in DynamoDB yet stuck showing 🔄 In Progress in Linear forever.
    // The panel/rollup/settle side-effects lived ONLY on the (lossy) live-event
    // path. Call the shared settle here so the sweep closes the loop: post the
    // rollup + transition the parent. refreshPanelAndSettle is idempotent (body
    // edit is a no-op if unchanged; the parent-state mirror is claimed once), so
    // racing the live reconciler is safe.
    const last = reload ? (await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId)) ?? fresh : fresh;
    if (last.children.every((c) => TERMINAL_CHILD.has(c.child_status))) {
      try {
        await refreshPanelAndSettle(orchestrationId, last.children, last.meta, now);
        logger.warn('Stranded orchestration settled by sweep — parent was never settled', {
          orchestration_id: orchestrationId, parent_linear_issue_id: last.meta.parent_issue_ref,
        });
      } catch (err) {
        logger.warn('Sweep settle failed (will retry next sweep)', {
          orchestration_id: orchestrationId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  if (releasableRows.length === 0) {
    await settleIfEnded(cascaded);
    return 0;
  }

  // Throttle the sweep's releases to the free budget too.
  const budget = USER_CONCURRENCY_TABLE
    ? await readConcurrencyBudget(ddb, USER_CONCURRENCY_TABLE, fresh.meta.release_context.platform_user_id, MAX_CONCURRENT)
    : undefined;
  const results = await releaseReadyChildren(
    ddb, ORCHESTRATION_TABLE, releasableRows, fresh.meta.release_context, createTaskCore, now,
    // Full child set for predecessor-branch-derived base selection.
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
  // A create refused for good (guardrail, validation, budget) left its child
  // ``failed`` without a task, so no event will ever wake the live reconciler
  // for it. Skip its dependents now, as the live reconciler and the seed paths
  // do, and settle if that ended the epic.
  if (results.some((r) => r.kind === 'create_failed_terminal')) {
    await applyTerminalCreateFailures(ddb, ORCHESTRATION_TABLE, orchestrationId, fresh.children, results, now);
    await settleIfEnded(true);
  }
  return released;
}

/**
 * Conditionally advance a child row's status (no-op if already there).
 *
 * ``fromStates``: when provided, the write additionally
 * asserts the CURRENT status is one of them — so a transition can't clobber a
 * child that has since moved to a state outside the allowed source set. The skip
 * cascade passes ``['blocked','ready']`` so a live ``released``/``releasing``
 * child (a recovery re-released it while this sweep raced) is NEVER stamped the
 * terminal ``skipped`` — which would let the epic claim its once-only rollup
 * while that child's work is still running. Recovery advances (released →
 * succeeded/failed) pass no ``fromStates`` (any non-target source is fine).
 */
async function advanceChildStatus(
  orchestrationId: string,
  subIssueId: string,
  status: string,
  now: string,
  fromStates?: readonly string[],
): Promise<void> {
  const values: Record<string, unknown> = { ':s': status, ':now': now };
  let condition = 'child_status <> :s';
  if (fromStates && fromStates.length > 0) {
    const names = fromStates.map((st, i) => {
      values[`:from${i}`] = st;
      return `:from${i}`;
    });
    condition = `child_status <> :s AND child_status IN (${names.join(', ')})`;
  }
  try {
    await ddb.send(new UpdateCommand({
      TableName: ORCHESTRATION_TABLE,
      Key: { orchestration_id: orchestrationId, sub_issue_id: subIssueId },
      UpdateExpression: 'SET child_status = :s, updated_at = :now',
      ConditionExpression: condition,
      ExpressionAttributeValues: values,
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
  const metas = await findOrchestrations();
  let totalReleased = 0;
  let swept = 0;
  for (const { orchestration_id: id, rollup_posted_at: rollupPostedAt } of metas) {
    try {
      totalReleased += await reconcileOrchestration(id, rollupPostedAt);
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
    orchestrations_found: metas.length,
    children_released: totalReleased,
  });
}
