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

import { GetCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { postIssueCommentAdf, updateIssueCommentAdf } from './jira-feedback';
import { jiraPreviewDocument, updateJiraIterationComment } from './jira-preview';
import { jiraIssueIdentity } from './jira-task-by-issue';
import { logger } from './logger';
import { isIntegrationNode } from './orchestration-integration-node';
import type { TaskRecord } from './types';
import { JIRA_ISSUE_INDEX_NAME } from '../../constructs/task-table-indexes';

const MAX_LOOKUP_PAGES = 10;
const LOOKUP_PAGE_SIZE = 25;

/** Best-effort Jira delivery, routed exclusively by the authoritative task. */
export async function deliverJiraDeploymentPreview(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  registryTableName: string,
  original: TaskRecord,
  repo: string,
  sha: string,
  screenshotUrl: string,
  previewUrl: string,
): Promise<void> {
  if (original.channel_source !== 'jira') return;
  try {
    if (original.repo !== repo) throw new Error('Deployment repository does not match the task');
    const metadata = original.channel_metadata;
    const cloudId = metadata?.jira_cloud_id;
    const issueKey = metadata?.jira_issue_key;
    // A synthetic integration node has no Jira issue. The screenshot update on
    // its task wakes the shared reconciler, which refreshes the parent rollup.
    if (isIntegrationNode(metadata?.orchestration_sub_issue_id ?? '')) return;
    if (!cloudId || !issueKey) throw new Error('Jira deployment task is missing channel metadata');
    if (isIntegrationNode(issueKey)) throw new Error('Synthetic node is not a Jira issue');
    let task = original;
    if (!metadata?.trigger_comment_id) {
      let cursor: Record<string, unknown> | undefined;
      let pages = 0;
      let matched = false;
      let sawIteration = false;
      do {
        if (pages++ >= MAX_LOOKUP_PAGES) throw new Error('Jira preview task lookup exceeded page limit');
        const page = await ddb.send(new QueryCommand({
          TableName: tableName,
          IndexName: JIRA_ISSUE_INDEX_NAME,
          KeyConditionExpression: 'jira_issue_identity = :identity',
          ExpressionAttributeValues: { ':identity': jiraIssueIdentity(cloudId, issueKey) },
          ScanIndexForward: false,
          ExclusiveStartKey: cursor,
          Limit: LOOKUP_PAGE_SIZE,
        }));
        for (const candidate of page.Items ?? []) {
          if (!candidate.channel_metadata?.trigger_comment_id) continue;
          sawIteration = true;
          const result = await ddb.send(new GetCommand({
            TableName: tableName, Key: { task_id: candidate.task_id }, ConsistentRead: true,
          }));
          const current = result.Item as TaskRecord | undefined;
          if (current?.head_sha !== sha || current.code_changed === false || current.channel_source !== 'jira'
            || current.repo !== repo || current.channel_metadata?.jira_cloud_id !== cloudId
            || current.channel_metadata?.jira_issue_key !== issueKey) continue;
          task = current;
          matched = true;
          break;
        }
        cursor = page.LastEvaluatedKey;
      } while (cursor && !matched);
      // Never guess "newest iteration": overlapping deployments can belong to
      // different replies. A known original SHA can still be delivered normally.
      if (!matched && (sawIteration || original.head_sha) && original.head_sha !== sha) {
        throw new Error('No Jira task matches the deployment SHA');
      }
    } else if (task.head_sha && task.head_sha !== sha) {
      throw new Error('Jira iteration SHA does not match the deployment');
    }
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { task_id: task.task_id },
      UpdateExpression: 'SET screenshot_url = :s, screenshot_preview_url = :p',
      ConditionExpression: 'attribute_exists(task_id)',
      ExpressionAttributeValues: { ':s': screenshotUrl, ':p': previewUrl },
    }));
    const ctx = { cloudId, registryTableName };
    if (task.channel_metadata?.trigger_comment_id) {
      const replyId = task.channel_metadata.iteration_reply_comment_id;
      const target = task.channel_metadata.trigger_comment_issue_id ?? issueKey;
      if (!replyId || isIntegrationNode(target)) throw new Error('Jira iteration has no addressable status comment');
      const result = await updateJiraIterationComment(ddb, tableName, task.task_id, ctx, target, replyId);
      if (!result.ok) throw new Error('Jira iteration preview update failed');
      return;
    }
    // Claim before POST: duplicate events, including concurrent deliveries, must
    // never create a second comment. Keep uncertain/failed POSTs claimed because
    // Jira may have committed before a transport timeout. Failures are observable.
    try {
      await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { task_id: task.task_id },
        UpdateExpression: 'SET jira_preview_claimed = :yes',
        ConditionExpression: 'attribute_exists(task_id) AND attribute_not_exists(jira_preview_claimed)',
        ExpressionAttributeValues: { ':yes': true },
      }));
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      const existing = await ddb.send(new GetCommand({
        TableName: tableName, Key: { task_id: task.task_id }, ConsistentRead: true,
      }));
      const commentId = existing.Item?.jira_preview_comment_id;
      if (typeof commentId === 'string') {
        const result = await updateIssueCommentAdf(ctx, issueKey, commentId, jiraPreviewDocument(screenshotUrl, previewUrl));
        if (!result.ok) throw new Error('Jira preview comment update failed');
      } else {
        logger.warn('Jira preview POST already claimed without a saved comment id', {
          event: 'screenshot.jira_delivery_claimed', task_id: task.task_id,
        });
      }
      return;
    }
    const result = await postIssueCommentAdf(ctx, issueKey, jiraPreviewDocument(screenshotUrl, previewUrl));
    if (!result.ok) throw new Error('Jira preview comment creation failed');
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { task_id: task.task_id },
      UpdateExpression: 'SET jira_preview_comment_id = :id',
      ConditionExpression: 'attribute_exists(task_id)',
      ExpressionAttributeValues: { ':id': result.commentId },
    }));
  } catch (error) {
    logger.warn('Jira deployment preview feedback failed (non-fatal)', {
      event: 'screenshot.jira_delivery_failed',
      task_id: original.task_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
