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

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { TaskTable } from '../../constructs/task-table';
import { logger } from './logger';

/**
 * The fields the #247 UX.3 standalone comment trigger needs from the newest
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
 * Resolve a Linear issue UUID → its NEWEST ABCA task via the sparse
 * ``LinearIssueIndex`` GSI (#247 UX.3). The GSI is keyed
 * ``(linear_issue_id, created_at)``; we query descending and take the first
 * row, so a re-labelled / re-run issue resolves to its latest task (the one
 * holding the live PR). Returns null when no task exists for the issue (the
 * issue was never run by ABCA, or its task predates the GSI back-fill) or on
 * any error — the caller treats null as "not an ABCA-owned issue, ignore".
 *
 * Best-effort: never throws.
 */
export async function resolveTaskByLinearIssue(
  ddb: DynamoDBDocumentClient,
  taskTableName: string,
  linearIssueId: string,
): Promise<LinearIssueTask | null> {
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
    if (!item) return null;
    return {
      task_id: item.task_id as string,
      ...(item.user_id !== undefined && { user_id: item.user_id as string }),
      ...(item.repo !== undefined && { repo: item.repo as string }),
      ...(item.pr_url !== undefined && { pr_url: item.pr_url as string }),
      ...(item.pr_number !== undefined && { pr_number: item.pr_number as number }),
      ...(item.status !== undefined && { status: item.status as string }),
    };
  } catch (err) {
    logger.warn('UX.3 standalone: LinearIssueIndex query failed — treating issue as non-ABCA', {
      linear_issue_id: linearIssueId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
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
