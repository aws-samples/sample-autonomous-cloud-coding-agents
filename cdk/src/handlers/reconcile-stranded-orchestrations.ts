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
const USER_CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');

const TERMINAL_CHILD = new Set(['succeeded', 'failed', 'skipped']);

const RELEASING_GRACE_MS = 10 * 60 * 1000;

const SETTLED_GRACE_MS = 60 * 60 * 1000;

function taskIsSuccess(rec: Record<string, unknown> | undefined): boolean {
  return rec?.status === TaskStatus.COMPLETED && rec?.build_passed !== false;
}
function taskIsTerminal(status: TaskStatusType | undefined): boolean {
  return status === TaskStatus.COMPLETED || status === TaskStatus.FAILED
    || status === TaskStatus.CANCELLED || status === TaskStatus.TIMED_OUT;
}

interface ScannedMeta {
  readonly orchestration_id: string;
  readonly rollup_posted_at?: string;
}

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

async function getTaskRecord(taskId: string): Promise<Record<string, unknown> | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TASK_TABLE, Key: { task_id: taskId } }));
  return res.Item;
}

async function reconcileOrchestration(orchestrationId: string, rollupPostedAt?: string): Promise<number> {
  const snap = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!snap) return 0;

  const now = new Date().toISOString();

  const allTerminal = snap.children.every((c) => TERMINAL_CHILD.has(c.child_status));
  if (allTerminal) {
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
      if ((err as { name?: string })?.name !== 'ConditionalCheckFailedException') {
        logger.warn('Failed to recover releasing child (will retry next sweep)', {
          orchestration_id: orchestrationId,
          sub_issue_id: child.sub_issue_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  for (const child of snap.children) {
    if (child.child_status !== 'released' || !child.child_task_id) continue;
    const rec = await getTaskRecord(child.child_task_id);
    if (!taskIsTerminal(rec?.status as TaskStatusType | undefined)) continue;
    const newStatus = taskIsSuccess(rec) ? 'succeeded' : 'failed';
    await advanceChildStatus(orchestrationId, child.sub_issue_id, newStatus, now);
  }

  const fresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!fresh) return 0;

  const statusOf = new Map(fresh.children.map((c) => [c.sub_issue_id, c.child_status]));

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
        await advanceChildStatus(orchestrationId, c.sub_issue_id, 'skipped', now, ['blocked', 'ready']);
        statusOf.set(c.sub_issue_id, 'skipped');
        changed = true;
        cascaded = true;
      }
    }
  }

  const releasableRows: OrchestrationChildRow[] = fresh.children
    .filter((c) => {
      const s = statusOf.get(c.sub_issue_id);
      const depsReady = c.depends_on.every((d) => statusOf.get(d) === 'succeeded');
      if (!depsReady) return false;
      if (s === 'blocked') return true;
      if (s === 'ready') return true;
      return false;
    })
    .map((c) => ({ ...c, child_status: 'ready' as const }));

  const settleIfEnded = async (reload: boolean): Promise<void> => {
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

  const budget = USER_CONCURRENCY_TABLE
    ? await readConcurrencyBudget(ddb, USER_CONCURRENCY_TABLE, fresh.meta.release_context.platform_user_id, MAX_CONCURRENT)
    : undefined;
  const results = await releaseReadyChildren(
    ddb, ORCHESTRATION_TABLE, releasableRows, fresh.meta.release_context, createTaskCore, now,
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
  if (results.some((r) => r.kind === 'create_failed_terminal')) {
    await applyTerminalCreateFailures(ddb, ORCHESTRATION_TABLE, orchestrationId, fresh.children, results, now);
    await settleIfEnded(true);
  }
  return released;
}

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
