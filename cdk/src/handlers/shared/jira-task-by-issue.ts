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
import { JIRA_ISSUE_INDEX_NAME } from '../../constructs/task-table-indexes';

const QUERY_PAGE_SIZE = 25;

export interface JiraIssueTask {
  readonly task_id: string;
  readonly user_id?: string;
  readonly repo?: string;
  readonly pr_url?: string;
  readonly pr_number?: number;
  readonly status?: string;
  readonly channel_metadata?: Record<string, string>;
}

/** Tenant-scoped sparse-index key for a Jira issue. */
export function jiraIssueIdentity(cloudId: string, issueKey: string): string {
  return `${cloudId}#${issueKey}`;
}

/**
 * Resolve a Jira issue to its newest PR-producing ABCA task.
 *
 * Newer attempts that never opened a PR are skipped. Query pagination is
 * required because DynamoDB applies Limit before any client-side selection;
 * stopping after a PR-less first page could hide an older valid PR target.
 */
export async function resolveTaskByJiraIssue(
  ddb: DynamoDBDocumentClient,
  taskTableName: string,
  cloudId: string,
  issueKey: string,
): Promise<JiraIssueTask | null> {
  const identity = jiraIssueIdentity(cloudId, issueKey);
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(new QueryCommand({
      TableName: taskTableName,
      IndexName: JIRA_ISSUE_INDEX_NAME,
      KeyConditionExpression: 'jira_issue_identity = :identity',
      ExpressionAttributeValues: { ':identity': identity },
      ScanIndexForward: false,
      Limit: QUERY_PAGE_SIZE,
      ExclusiveStartKey: exclusiveStartKey,
    }));

    for (const item of result.Items ?? []) {
      if (prNumberFromTask(item) === null || typeof item.task_id !== 'string') {
        continue;
      }
      return {
        task_id: item.task_id,
        ...(typeof item.user_id === 'string' && { user_id: item.user_id }),
        ...(typeof item.repo === 'string' && { repo: item.repo }),
        ...(typeof item.pr_url === 'string' && { pr_url: item.pr_url }),
        ...(typeof item.pr_number === 'number' && { pr_number: item.pr_number }),
        ...(typeof item.status === 'string' && { status: item.status }),
        ...(isStringRecord(item.channel_metadata) && { channel_metadata: item.channel_metadata }),
      };
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return null;
}

/** Extract a PR number from the canonical field or a persisted GitHub PR URL. */
export function prNumberFromTask(task: { pr_number?: unknown; pr_url?: unknown }): number | null {
  if (
    typeof task.pr_number === 'number'
    && Number.isInteger(task.pr_number)
    && task.pr_number > 0
  ) {
    return task.pr_number;
  }
  if (typeof task.pr_url === 'string') {
    const match = task.pr_url.match(/\/pull\/(\d+)\b/);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && Object.values(value).every((entry) => typeof entry === 'string');
}
