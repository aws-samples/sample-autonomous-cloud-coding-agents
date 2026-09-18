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
 * Scheduled handler: find and fail stranded tasks.
 *
 * A stranded task is one whose admission write landed in TaskTable but
 * whose pipeline never started — typically because the orchestrator
 * Lambda crashed between the TaskTable write and the InvokeAgentRuntime
 * call, or because the agent container crashed during startup before
 * writing its first heartbeat.
 *
 * RUNNING / FINALIZING tasks are handled separately by `pollTaskStatus`
 * in `orchestrator.ts` via the `agent_heartbeat_at` timeout path — this
 * reconciler targets `SUBMITTED`, `HYDRATING`, and `AWAITING_APPROVAL`.
 *
 * AWAITING_APPROVAL tasks with a saved MicroVM checkpoint belong to the
 * continuation manager and can remain open across workers. For other tasks,
 * the backstop allows the full eight-hour worker lifetime plus cleanup grace;
 * it detects a lost worker/coordinator, not an unanswered human deadline.
 */

import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { ulid } from 'ulid';
import { closeTaskApprovals } from './shared/close-task-approvals';
import { logger } from './shared/logger';
import { releaseTaskSlot } from './shared/task-concurrency';
import { makeClient } from './shared/ua';

const ddb = makeClient(DynamoDBClient);
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE = process.env.TASK_EVENTS_TABLE_NAME!;

/** Stranded-task timeout. The orchestrator Lambda is async-invoked and
 *  the agent runtime has a cold-start path; 1200 s covers Lambda retries
 *  + AgentCore container warm-up without false positives. */
const STRANDED_TIMEOUT_SECONDS = Number(
  process.env.STRANDED_TIMEOUT_SECONDS ?? '1200',
);

const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');

/**
 * Backstop for approval waits without a recoverable checkpoint: the worker's
 * eight-hour lifetime plus 30 minutes for its coordinator to close the task.
 * Approval records do not expire merely because their worker stopped.
 */
const APPROVAL_STRANDED_TIMEOUT_SECONDS = Number(
  process.env.APPROVAL_STRANDED_TIMEOUT_SECONDS ?? '30600',
);

interface StrandedCandidate {
  readonly task_id: string;
  readonly user_id: string;
  readonly status: string;
  readonly created_at: string;
  readonly age_seconds: number;
}

/**
 * Query TaskTable by (status, created_at) via the StatusIndex GSI and
 * return rows older than the stranded timeout.
 *
 * One query per status (SUBMITTED, HYDRATING) using a sort-key condition
 * `created_at < :cutoff`.
 */
async function findStrandedCandidates(
  status: 'SUBMITTED' | 'HYDRATING' | 'AWAITING_APPROVAL',
  now: Date,
): Promise<StrandedCandidate[]> {
  const timeoutSeconds = status === 'AWAITING_APPROVAL'
    ? APPROVAL_STRANDED_TIMEOUT_SECONDS
    : STRANDED_TIMEOUT_SECONDS;
  const cutoff = new Date(now.getTime() - timeoutSeconds * 1000);

  const matches: StrandedCandidate[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: TASK_TABLE,
      IndexName: 'StatusIndex',
      KeyConditionExpression: '#s = :status AND created_at < :cutoff',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':status': { S: status },
        ':cutoff': { S: cutoff.toISOString() },
      },
      ExclusiveStartKey: lastKey as Record<string, never> | undefined,
    }));

    for (const item of resp.Items ?? []) {
      const taskId = item.task_id?.S;
      const userId = item.user_id?.S;
      const createdAt = item.created_at?.S;
      if (!taskId || !userId || !createdAt) continue;
      const continuationState = item.continuation?.M?.state?.S;
      if (status === 'AWAITING_APPROVAL'
        && ['READY', 'FENCED', 'PARKED', 'STARTING', 'RESTORING'].includes(continuationState ?? '')) continue;

      // Age by time-in-CURRENT-status, not creation time (#441). A task
      // that waited in the admission queue longer than the stranded
      // timeout and was then picked up (QUEUED -> SUBMITTED) has an old
      // created_at but a fresh status entry — failing it here would kill
      // it before its pipeline attaches. status_created_at is
      // `<STATUS>#<iso>`; created_at <= status-entry time always, so the
      // GSI cutoff on created_at remains a correct superset pre-filter.
      // Records missing/with a malformed status_created_at fall back to
      // created_at (pre-#441 behavior).
      const statusEnteredAt = item.status_created_at?.S?.split('#')[1];
      const ageAnchor = statusEnteredAt && !Number.isNaN(Date.parse(statusEnteredAt))
        ? statusEnteredAt
        : createdAt;
      const anchorMs = Date.parse(ageAnchor);
      const ageSec = Math.floor((now.getTime() - anchorMs) / 1000);
      if (ageSec < timeoutSeconds) continue;

      matches.push({
        task_id: taskId,
        user_id: userId,
        status,
        created_at: createdAt,
        age_seconds: ageSec,
      });
    }

    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  return matches;
}

/**
 * Transition a stranded task to FAILED, emit a task_stranded event, and
 * release its concurrency slot. Best-effort and idempotent — a concurrent
 * legitimate status transition wins (conditional check fails cleanly).
 */
async function failStrandedTask(task: StrandedCandidate): Promise<boolean> {
  const now = new Date().toISOString();
  const errorMessage = task.status === 'AWAITING_APPROVAL'
    ? `Approval stranded: task paused for approval for ${task.age_seconds}s with `
      + 'no resume transition. Typically caused by the agent container being '
      + 'evicted mid-approval. Resubmit the task if the work is still needed.'
    : `Stranded: ${task.status} for ${task.age_seconds}s — `
      + 'no pipeline attached before the stranded-task timeout. '
      + 'This usually means the orchestrator Lambda crashed before invoking '
      + 'the runtime, or the agent container crashed during startup.';

  // 1. Conditional status transition — only if still in the stranded state.
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TASK_TABLE,
      Key: { task_id: { S: task.task_id } },
      UpdateExpression:
        'SET #s = :failed, updated_at = :now, completed_at = :now, '
        + 'error_message = :err, status_created_at = :sca',
      ConditionExpression: '#s = :expected' + (task.status === 'AWAITING_APPROVAL'
        ? ' AND (attribute_not_exists(continuation.#state) OR NOT (continuation.#state IN (:ready, :fenced, :parked, :starting, :restoring)))'
        : ''),
      ExpressionAttributeNames: { '#s': 'status', ...(task.status === 'AWAITING_APPROVAL' && { '#state': 'state' }) },
      ExpressionAttributeValues: {
        ':failed': { S: 'FAILED' },
        ':expected': { S: task.status },
        ':now': { S: now },
        ':err': { S: errorMessage },
        ':sca': { S: `FAILED#${now}` },
        ...(task.status === 'AWAITING_APPROVAL' && {
          ':ready': { S: 'READY' },
          ':fenced': { S: 'FENCED' },
          ':parked': { S: 'PARKED' },
          ':starting': { S: 'STARTING' },
          ':restoring': { S: 'RESTORING' },
        }),
      },
    }));
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'name' in err && err.name === 'ConditionalCheckFailedException') {
      // The task advanced out of SUBMITTED/HYDRATING while we were looking
      // at it — legit, no action needed.
      logger.info('Task advanced before transition — skipping', {
        task_id: task.task_id,
        reason: 'advanced_during_reconcile',
      });
      return false;
    }
    throw err;
  }

  // 2. Emit task_stranded + task_failed events. Best-effort — loss of an
  //    event is acceptable; the task record is the source of truth.
  const ttl = Math.floor(Date.now() / 1000) + TASK_RETENTION_DAYS * 24 * 3600;
  try {
    await ddb.send(new PutItemCommand({
      TableName: EVENTS_TABLE,
      Item: {
        task_id: { S: task.task_id },
        event_id: { S: ulid() },
        event_type: { S: 'task_stranded' },
        timestamp: { S: now },
        ttl: { N: String(ttl) },
        metadata: {
          M: {
            code: { S: 'STRANDED_NO_HEARTBEAT' },
            prior_status: { S: task.status },
            age_seconds: { N: String(task.age_seconds) },
          },
        },
      },
    }));
  } catch (eventErr) {
    logger.warn('Failed to write task_stranded event (best-effort)', {
      task_id: task.task_id,
      error: eventErr instanceof Error ? eventErr.message : String(eventErr),
    });
  }

  try {
    await ddb.send(new PutItemCommand({
      TableName: EVENTS_TABLE,
      Item: {
        task_id: { S: task.task_id },
        event_id: { S: ulid() },
        event_type: { S: 'task_failed' },
        timestamp: { S: now },
        ttl: { N: String(ttl) },
        metadata: { M: { error_message: { S: errorMessage } } },
      },
    }));
  } catch (eventErr) {
    logger.warn('Failed to write task_failed event (best-effort)', {
      task_id: task.task_id,
      error: eventErr instanceof Error ? eventErr.message : String(eventErr),
    });
  }

  // Chunk 10 (full-branch review B2): when the stranded task was
  // AWAITING_APPROVAL, also emit an ``agent_milestone`` with
  // ``milestone: "approval_stranded"`` so the ApprovalMetricsPublisher
  // Lambda picks it up (the publisher's event-source filter is keyed
  // on ``event_type: agent_milestone`` — ``task_stranded`` events
  // never reach it). Without this branch, a 100 %-eviction scenario
  // looks identical to "no approval traffic" on the dashboard —
  // invisible failure mode. Design §11.1 labels ``approval_stranded``
  // as Reconciler-sourced, this wiring fulfills that.
  if (task.status === 'AWAITING_APPROVAL') {
    try {
      await ddb.send(new PutItemCommand({
        TableName: EVENTS_TABLE,
        Item: {
          task_id: { S: task.task_id },
          event_id: { S: ulid() },
          event_type: { S: 'agent_milestone' },
          timestamp: { S: now },
          ttl: { N: String(ttl) },
          metadata: {
            M: {
              milestone: { S: 'approval_stranded' },
              age_s: { N: String(task.age_seconds) },
              reason: { S: 'STRANDED_NO_HEARTBEAT' },
            },
          },
        },
      }));
    } catch (eventErr) {
      logger.warn('Failed to write approval_stranded milestone (best-effort)', {
        task_id: task.task_id,
        error: eventErr instanceof Error ? eventErr.message : String(eventErr),
      });
    }
  }

  // 3. Cooperate with normal finalization through the task-owned marker.
  // If this fails after the terminal write, the capacity reconciler retries
  // release for terminal held reservations on its next sweep.
  await releaseTaskSlot(task.task_id, task.user_id);
  await closeTaskApprovals(task.task_id, task.user_id);

  return true;
}

export async function handler(): Promise<void> {
  logger.info('Stranded-task reconciler started', {
    stranded_timeout_s: STRANDED_TIMEOUT_SECONDS,
  });

  const now = new Date();
  const statuses: ('SUBMITTED' | 'HYDRATING' | 'AWAITING_APPROVAL')[] = [
    'SUBMITTED',
    'HYDRATING',
    'AWAITING_APPROVAL',
  ];
  let totalStranded = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const status of statuses) {
    let candidates: StrandedCandidate[];
    try {
      candidates = await findStrandedCandidates(status, now);
    } catch (queryErr) {
      logger.error('Query for stranded candidates failed — skipping status', {
        status,
        error: queryErr instanceof Error ? queryErr.message : String(queryErr),
      });
      totalErrors++;
      continue;
    }

    totalStranded += candidates.length;
    for (const task of candidates) {
      logger.info('Detected stranded task', {
        task_id: task.task_id,
        status: task.status,
        age_seconds: task.age_seconds,
      });
      try {
        const applied = await failStrandedTask(task);
        if (applied) {
          totalFailed++;
        } else {
          totalSkipped++;
        }
      } catch (err) {
        totalErrors++;
        logger.warn('Per-task failStrandedTask failed, continuing', {
          task_id: task.task_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Severity escalation for the final log line.
  //
  // Per-task failures upstream are caught and swallowed (logged at WARN)
  // so one flaky DDB call doesn't abort the entire reconcile window. But
  // a systemic failure — IAM outage, table-level throttling, schema
  // corruption — can silently strand 100% of candidates while each
  // individual WARN line looks ignorable. We classify the terminal log
  // three ways so CloudWatch Log Insights / metric filters can alarm on
  // the dedicated `error_id` strings:
  //
  //   1. totalStranded > 0 AND totalFailed == 0 AND totalErrors > 0
  //      → SYSTEMIC failure. Every candidate hit an exception. Log ERROR
  //        with error_id='RECONCILER_TOTAL_FAILURE' (alarm-worthy).
  //   2. totalErrors > 0 AND totalFailed > 0
  //      → PARTIAL failure. Some tasks transitioned, some didn't. Log
  //        WARN with error_id='RECONCILER_PARTIAL_FAILURE' (dashboard
  //        signal, not an alarm — expected under occasional DDB flakes).
  //   3. Otherwise (no stranded, or all-success with zero errors)
  //      → SUCCESS. Log INFO as before.
  //
  // We do NOT throw — the EventBridge schedule invocation should still
  // complete "normally" (no retry storm against an already-degraded
  // DDB). The log-level escalation IS the alarm signal.
  const finalPayload = {
    stranded: totalStranded,
    failed: totalFailed,
    skipped: totalSkipped,
    errors: totalErrors,
  };
  if (totalStranded > 0 && totalFailed === 0 && totalErrors > 0) {
    logger.error('Stranded-task reconciler finished — every candidate failed to transition', {
      ...finalPayload,
      error_id: 'RECONCILER_TOTAL_FAILURE',
    });
  } else if (totalErrors > 0 && totalFailed > 0) {
    logger.warn('Stranded-task reconciler finished with partial failures', {
      ...finalPayload,
      error_id: 'RECONCILER_PARTIAL_FAILURE',
    });
  } else {
    logger.info('Stranded-task reconciler finished', finalPayload);
  }
}
