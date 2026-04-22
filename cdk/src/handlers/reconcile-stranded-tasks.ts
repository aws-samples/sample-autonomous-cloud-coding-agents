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
 * Scheduled handler: find and fail stranded tasks (rev-5, addresses P0-c
 * from the pre-push validation pass).
 *
 * A stranded task is one whose admission write landed in TaskTable but
 * whose pipeline never started — either because:
 *
 * - (interactive) the CLI died between `POST /v1/tasks` (201) and the
 *   subsequent SSE connect to Runtime-JWT, so server.py never saw the
 *   `/invocations` request and never spawned a pipeline; OR
 * - (orchestrator) the orchestrator Lambda crashed between the TaskTable
 *   write and the Runtime-IAM sync invocation.
 *
 * The `bgagent run` CLI (rev-5 `run.ts`) auto-cancels on SSE fatal
 * errors, which handles the common case. This reconciler exists for the
 * edge cases that the CLI can't catch (`kill -9`, hard network partition,
 * orchestrator crash).
 *
 * RUNNING / FINALIZING tasks are handled separately by `pollTaskStatus`
 * in `orchestrator.ts` via the `agent_heartbeat_at` timeout path — this
 * reconciler only targets `SUBMITTED` and `HYDRATING`.
 */

import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { ulid } from 'ulid';
import { logger } from './shared/logger';

const ddb = new DynamoDBClient({});
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const EVENTS_TABLE = process.env.TASK_EVENTS_TABLE_NAME!;
const CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME!;

/** Timeout for interactive tasks. A CLI that opens SSE promptly hits
 *  Runtime-JWT within seconds of admission; 300 s is generous. */
const INTERACTIVE_TIMEOUT_SECONDS = Number(
  process.env.STRANDED_INTERACTIVE_TIMEOUT_SECONDS ?? '300',
);

/** Timeout for orchestrator tasks. The orchestrator Lambda is async-
 *  invoked and Runtime-IAM has a cold-start path; 1200 s covers Lambda
 *  retries + AgentCore container warm-up without false positives. Also
 *  applies to legacy tasks (no `execution_mode` field, treated as
 *  orchestrator by the server). */
const ORCHESTRATOR_TIMEOUT_SECONDS = Number(
  process.env.STRANDED_ORCHESTRATOR_TIMEOUT_SECONDS ?? '1200',
);

const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');

interface StrandedCandidate {
  readonly task_id: string;
  readonly user_id: string;
  readonly status: string;
  readonly execution_mode: string;
  readonly created_at: string;
  readonly age_seconds: number;
}

/**
 * Query TaskTable by (status, created_at) via the StatusIndex GSI and
 * return rows older than their applicable timeout.
 *
 * One query per status (SUBMITTED, HYDRATING) using a sort-key condition
 * `created_at < :cutoff`. Cutoff is the LOOSER of the two timeouts
 * (orchestrator's 1200s) so the query pulls every potential stranded
 * candidate; per-row filtering below classifies each by its
 * `execution_mode` using the stricter interactive threshold where
 * applicable.
 */
async function findStrandedCandidates(
  status: 'SUBMITTED' | 'HYDRATING',
  now: Date,
): Promise<StrandedCandidate[]> {
  const looserCutoff = new Date(now.getTime() - ORCHESTRATOR_TIMEOUT_SECONDS * 1000);
  const stricterCutoff = new Date(now.getTime() - INTERACTIVE_TIMEOUT_SECONDS * 1000);

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
        ':cutoff': { S: stricterCutoff.toISOString() },
      },
      ExclusiveStartKey: lastKey as Record<string, never> | undefined,
    }));

    for (const item of resp.Items ?? []) {
      const taskId = item.task_id?.S;
      const userId = item.user_id?.S;
      const createdAt = item.created_at?.S;
      const executionMode = item.execution_mode?.S ?? 'orchestrator';
      if (!taskId || !userId || !createdAt) continue;

      const createdMs = Date.parse(createdAt);
      const ageSec = Math.floor((now.getTime() - createdMs) / 1000);

      // Apply the per-mode threshold.
      const threshold = executionMode === 'interactive'
        ? INTERACTIVE_TIMEOUT_SECONDS
        : ORCHESTRATOR_TIMEOUT_SECONDS;

      if (ageSec < threshold) {
        // Caught by the loose cutoff but not actually stranded for its mode.
        continue;
      }

      // Defensive: confirm the row is still older than the orchestrator
      // loose cutoff (should always be true given the sort-key condition,
      // but guard against clock skew).
      if (createdMs >= looserCutoff.getTime() && executionMode !== 'interactive') {
        continue;
      }

      matches.push({
        task_id: taskId,
        user_id: userId,
        status,
        execution_mode: executionMode,
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
  const errorMessage = `Stranded: ${task.status} for ${task.age_seconds}s (execution_mode=${task.execution_mode}) — `
    + 'no pipeline attached before the stranded-task timeout. '
    + 'This usually means the CLI crashed between admission and SSE connect, '
    + 'or the orchestrator Lambda crashed before invoking the runtime.';

  // 1. Conditional status transition — only if still in the stranded state.
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TASK_TABLE,
      Key: { task_id: { S: task.task_id } },
      UpdateExpression:
        'SET #s = :failed, updated_at = :now, completed_at = :now, '
        + 'error_message = :err, status_created_at = :sca',
      ConditionExpression: '#s = :expected',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':failed': { S: 'FAILED' },
        ':expected': { S: task.status },
        ':now': { S: now },
        ':err': { S: errorMessage },
        ':sca': { S: `FAILED#${now}` },
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
            execution_mode: { S: task.execution_mode },
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

  // 3. Release the concurrency slot. Best-effort; drift is later corrected
  //    by the concurrency reconciler.
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: CONCURRENCY_TABLE,
      Key: { user_id: { S: task.user_id } },
      UpdateExpression: 'SET active_count = active_count - :one, updated_at = :now',
      ConditionExpression: 'active_count > :zero',
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':zero': { N: '0' },
        ':now': { S: now },
      },
    }));
  } catch (decrErr: unknown) {
    if (decrErr && typeof decrErr === 'object' && 'name' in decrErr
        && decrErr.name !== 'ConditionalCheckFailedException') {
      logger.warn('Failed to decrement concurrency for stranded task', {
        task_id: task.task_id,
        user_id: task.user_id,
        error: decrErr instanceof Error ? decrErr.message : String(decrErr),
      });
    }
    // ConditionalCheckFailedException means the counter is already 0 —
    // drift the concurrency reconciler will eventually catch.
  }

  return true;
}

export async function handler(): Promise<void> {
  logger.info('Stranded-task reconciler started', {
    interactive_timeout_s: INTERACTIVE_TIMEOUT_SECONDS,
    orchestrator_timeout_s: ORCHESTRATOR_TIMEOUT_SECONDS,
  });

  const now = new Date();
  const statuses: ('SUBMITTED' | 'HYDRATING')[] = ['SUBMITTED', 'HYDRATING'];
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
        execution_mode: task.execution_mode,
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

  logger.info('Stranded-task reconciler finished', {
    stranded: totalStranded,
    failed: totalFailed,
    skipped: totalSkipped,
    errors: totalErrors,
  });
}
