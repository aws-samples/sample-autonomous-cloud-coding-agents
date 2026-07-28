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

import { type DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import { TaskTable } from '../../constructs/task-table';

/**
 * Cap on the number of task rows summed for one issue.
 *
 * A bound is needed because each row costs a GetItem, so an issue with a
 * pathological number of iterations would otherwise fan out unboundedly inside a
 * single Lambda invocation. It is deliberately far above any real iteration count
 * (dozens at most) so it is a runaway guard, not a routine limit — and when it
 * does bite, {@link sumIterationCostForIssue} says so rather than quietly
 * reporting a smaller number as if it were the total.
 */
export const MAX_COST_TASKS_PER_ISSUE = 500;

/** Outcome of a running-total cost sum. */
export interface IterationCostTotal {
  /** Summed cost, or null when nothing is known (no rows, all unreadable). */
  readonly total: number | null;
  /**
   * True when the sum is known to be INCOMPLETE — the row cap was hit, or a read
   * failed partway. Callers that show this to a user should mark it as a partial
   * figure; a number presented as a total when it is not is worse than no number.
   */
  readonly partial: boolean;
}

/**
 * Sum ``cost_usd`` across every task recorded against one Linear issue — the
 * running total shown on an iteration's settle reply.
 *
 * Single implementation shared by the reconciler and the fan-out dispatcher. It
 * previously existed as two near-copies that had already drifted: one parsed a
 * string ``cost_usd`` and added it without a finite check (so a stringified cost
 * poisoned the whole total to NaN), the other guarded correctly. Cost accounting
 * that disagrees with itself depending on which handler ran is worse than either
 * behaviour on its own.
 *
 * PAGINATES. A DynamoDB Query returns at most 1 MB per page, and the previous
 * versions summed a single page as though it were everything — so past the page
 * boundary the user was shown a total that was silently short. Truncation here
 * surfaces as a wrong number rather than an error, which is exactly the failure
 * mode worth spending a loop to avoid.
 *
 * ``thisCost`` is added explicitly because the terminal task's GSI projection may
 * not have propagated yet; it is deduped by ``task_id`` so it cannot be counted
 * twice.
 *
 * Best-effort: never throws. On a read failure it returns what it has, flagged
 * ``partial``.
 */
export async function sumIterationCostForIssue(args: {
  ddb: DynamoDBDocumentClient;
  taskTableName: string;
  linearIssueId: string;
  thisTaskId: string;
  thisCost?: number;
  logLabel?: string;
}): Promise<IterationCostTotal> {
  const { ddb, taskTableName, linearIssueId, thisTaskId, thisCost, logLabel } = args;
  const base = typeof thisCost === 'number' && Number.isFinite(thisCost) ? thisCost : 0;
  const parseCost = (v: unknown): number =>
    typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : NaN);

  let total = 0;
  let sawThis = false;
  let partial = false;
  try {
    const ids: string[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const listed = await ddb.send(new QueryCommand({
        TableName: taskTableName,
        IndexName: TaskTable.LINEAR_ISSUE_INDEX,
        KeyConditionExpression: 'linear_issue_id = :iid',
        ProjectionExpression: 'task_id',
        ExpressionAttributeValues: { ':iid': linearIssueId },
        ...(startKey && { ExclusiveStartKey: startKey }),
      }));
      for (const item of (listed.Items ?? []) as Array<{ task_id?: string }>) {
        if (item.task_id) ids.push(item.task_id);
      }
      startKey = listed.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (ids.length >= MAX_COST_TASKS_PER_ISSUE) {
        // Say so rather than trimming in silence: a capped sum is not the total.
        logger.warn('Iteration cost sum hit the per-issue row cap — reporting a PARTIAL total', {
          linear_issue_id: linearIssueId, cap: MAX_COST_TASKS_PER_ISSUE, ...(logLabel && { source: logLabel }),
        });
        partial = true;
        break;
      }
    } while (startKey);

    // The GSI lists task ids but does not project cost_usd (a GSI projection
    // cannot be changed in place — see task-table.ts), so read each cost.
    for (const taskId of ids) {
      if (taskId === thisTaskId) {
        sawThis = true;
        total += base;
        continue;
      }
      const got = await ddb.send(new GetCommand({
        TableName: taskTableName, Key: { task_id: taskId }, ProjectionExpression: 'cost_usd',
      }));
      const c = parseCost(got.Item?.cost_usd);
      if (Number.isFinite(c)) total += c;
    }
  } catch (err) {
    logger.warn('Iteration running-total cost query failed — reporting a PARTIAL total', {
      task_id: thisTaskId,
      error: err instanceof Error ? err.message : String(err),
      ...(logLabel && { source: logLabel }),
    });
    partial = true;
  }

  if (!sawThis) total += base;
  return { total: total > 0 ? total : null, partial };
}
