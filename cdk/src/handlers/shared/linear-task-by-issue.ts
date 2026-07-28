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

import { type DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import { TaskTable } from '../../constructs/task-table';

/**
 * The fields the standalone comment trigger needs from the newest
 * ABCA task that worked on a given Linear issue. Projected by the
 * ``LinearIssueIndex`` GSI.
 */
export interface LinearIssueTask {
  readonly task_id: string;
  readonly user_id?: string;
  readonly repo?: string;
  readonly pr_url?: string;
  readonly pr_number?: number;
  readonly status?: string;
}

/**
 * Outcome of an issue → newest-task lookup. Deliberately three-valued rather
 * than ``task | null``: "no task" and "the lookup broke" demand different
 * behaviour, and collapsing them is how an addressed ``@bgagent`` comment gets
 * dropped in silence.
 *
 *  - ``found`` — the issue has an ABCA task; iterate on it.
 *  - ``none`` — the issue genuinely has no task, or its task predates the
 *    ``linear_issue_id`` hoist and so is invisible to this sparse GSI. Cannot be
 *    distinguished from each other here, which matters: after this feature is
 *    first deployed, EVERY task created by the previously-running code lands in
 *    this bucket, since nothing back-fills the attribute.
 *  - ``error`` — the Query failed. Nothing can be concluded about the issue, so
 *    treating it as "not ours" would be a guess presented as a fact.
 */
export type LinearIssueTaskLookup =
  | { readonly kind: 'found'; readonly task: LinearIssueTask }
  | { readonly kind: 'none' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Resolve a Linear issue UUID → its NEWEST ABCA task via the sparse
 * ``LinearIssueIndex`` GSI. The GSI is keyed
 * ``(linear_issue_id, created_at)``; we query descending and take the first
 * row, so a re-labelled / re-run issue resolves to its latest task (the one
 * holding the live PR).
 *
 * Best-effort: never throws. Reports a miss and a failure distinctly so the
 * caller can tell the user something rather than ignoring them — see
 * {@link LinearIssueTaskLookup}.
 */
export async function lookupTaskByLinearIssue(
  ddb: DynamoDBDocumentClient,
  taskTableName: string,
  linearIssueId: string,
): Promise<LinearIssueTaskLookup> {
  try {
    const res = await ddb.send(new QueryCommand({
      TableName: taskTableName,
      IndexName: TaskTable.LINEAR_ISSUE_INDEX,
      KeyConditionExpression: 'linear_issue_id = :iid',
      ExpressionAttributeValues: { ':iid': linearIssueId },
      ScanIndexForward: false, // newest created_at first
      Limit: 1,
    }));
    const item = res.Items?.[0];
    if (!item) return { kind: 'none' };
    return {
      kind: 'found',
      task: {
        task_id: item.task_id as string,
        ...(item.user_id !== undefined && { user_id: item.user_id as string }),
        ...(item.repo !== undefined && { repo: item.repo as string }),
        ...(item.pr_url !== undefined && { pr_url: item.pr_url as string }),
        ...(item.pr_number !== undefined && { pr_number: item.pr_number as number }),
        ...(item.status !== undefined && { status: item.status as string }),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('LinearIssueIndex query failed — cannot tell whether this issue has a task', {
      linear_issue_id: linearIssueId,
      error: message,
    });
    return { kind: 'error', message };
  }
}

/**
 * Back-compatible wrapper: the task, or null for both a miss and a failure.
 *
 * Prefer {@link lookupTaskByLinearIssue} on any path that replies to a user, so a
 * lookup failure isn't reported to them as "this isn't an ABCA issue".
 */
export async function resolveTaskByLinearIssue(
  ddb: DynamoDBDocumentClient,
  taskTableName: string,
  linearIssueId: string,
): Promise<LinearIssueTask | null> {
  const res = await lookupTaskByLinearIssue(ddb, taskTableName, linearIssueId);
  return res.kind === 'found' ? res.task : null;
}

/**
 * Extract a PR number from a task's ``pr_number`` (preferred) or by parsing
 * ``/pull/<n>`` out of ``pr_url``. Returns null when neither yields a number —
 * the task ran but never opened a PR, so there's nothing to iterate on.
 */
export function prNumberFromTask(task: LinearIssueTask): number | null {
  if (typeof task.pr_number === 'number') return task.pr_number;
  if (typeof task.pr_url === 'string') {
    const m = task.pr_url.match(/\/pull\/(\d+)\b/);
    if (m) return Number(m[1]);
  }
  return null;
}
