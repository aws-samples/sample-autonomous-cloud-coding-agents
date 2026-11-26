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
import { LINEAR_ISSUE_INDEX_NAME } from '../../constructs/task-table-indexes';
import { logger } from './logger';

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
  /**
   * The Linear workspace the task was created for, from its `channel_metadata`.
   * Callers acting on a webhook match this against the delivery's workspace.
   */
  readonly linear_workspace_id?: string;
}

/**
 * Outcome of an issue → newest-task lookup.
 *
 *  - ``found`` — the issue has an ABCA task; iterate on it.
 *  - ``none`` — the issue genuinely has no task, or its task predates the
 *    ``linear_issue_id`` hoist and so is invisible to this sparse GSI.
 *  - ``error`` — the Query failed.
 */
export type LinearIssueTaskLookup =
  | { readonly kind: 'found'; readonly task: LinearIssueTask }
  | { readonly kind: 'none' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Resolve a Linear issue UUID → its NEWEST ABCA task via the sparse
 * ``LinearIssueIndex`` GSI.
 *
 * Never throws. Reports a miss and a failure distinctly — see
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
      IndexName: LINEAR_ISSUE_INDEX_NAME,
      KeyConditionExpression: 'linear_issue_id = :iid',
      ExpressionAttributeValues: { ':iid': linearIssueId },
      ScanIndexForward: false,
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
        ...(typeof item.channel_metadata?.linear_workspace_id === 'string' && {
          linear_workspace_id: item.channel_metadata.linear_workspace_id as string,
        }),
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
