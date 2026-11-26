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

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { planHeartbeat, type HeartbeatTaskView } from './shared/iteration-heartbeat';
import { terminalReplyClaimed } from './shared/iteration-reply-claim';
import { buildAdfDocument, parseMarkdownRuns } from './shared/jira-feedback';
import { updateJiraIterationComment } from './shared/jira-iteration-comment';
import { logger } from './shared/logger';
import {
  channelForSource,
  type ChannelRegistryTables,
} from './shared/orchestration-channel-factory';
import { makeClient } from './shared/ua';

const ddb = makeClient(DynamoDBClient);
const docDdb = DynamoDBDocumentClient.from(ddb);
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const STATUS_INDEX = process.env.TASK_STATUS_INDEX_NAME ?? 'StatusIndex';
const CHANNEL_REGISTRY_TABLES: ChannelRegistryTables = {
  linear: process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME,
  jira: process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME,
};

const MAX_EDITS_PER_SWEEP = 50;

interface DdbMap { [k: string]: { S?: string; N?: string; BOOL?: boolean; M?: DdbMap } }

function toView(img: DdbMap): HeartbeatTaskView {
  const cm = img.channel_metadata?.M ?? {};
  const prNumberRaw = img.pr_number?.N;
  return {
    taskId: img.task_id?.S ?? '',
    status: img.status?.S ?? '',
    ...(img.created_at?.S !== undefined && { createdAt: img.created_at.S }),
    ...(img.channel_source?.S !== undefined && { channelSource: img.channel_source.S }),
    ...(cm.linear_workspace_id?.S !== undefined && { linearWorkspaceId: cm.linear_workspace_id.S }),
    ...(cm.jira_cloud_id?.S !== undefined && { jiraCloudId: cm.jira_cloud_id.S }),
    ...(cm.iteration_reply_comment_id?.S !== undefined && { iterationReplyCommentId: cm.iteration_reply_comment_id.S }),
    ...(cm.trigger_comment_id?.S !== undefined && { triggerCommentId: cm.trigger_comment_id.S }),
    ...((cm.trigger_comment_issue_id?.S ?? cm.linear_issue_id?.S ?? cm.jira_issue_key?.S) !== undefined && {
      triggerCommentIssueId:
        cm.trigger_comment_issue_id?.S ?? cm.linear_issue_id?.S ?? cm.jira_issue_key?.S,
    }),
    isIteration: cm.orchestration_iteration?.S === 'true',
    ...(prNumberRaw !== undefined && { prNumber: Number(prNumberRaw) }),
    ...(img.pr_url?.S !== undefined && { prUrl: img.pr_url.S }),
  };
}

async function loadRunningTasks(): Promise<DdbMap[]> {
  const items: DdbMap[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: TASK_TABLE,
      IndexName: STATUS_INDEX,
      KeyConditionExpression: '#s = :running',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':running': { S: 'RUNNING' } },
      ExclusiveStartKey: lastKey as Record<string, never> | undefined,
    }));
    items.push(...((resp.Items ?? []) as unknown as DdbMap[]));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/**
 * Scheduled entrypoint. Best-effort throughout: a single task's edit failure is
 * logged and skipped; the sweep never throws.
 */
export async function handler(): Promise<void> {
  if (!CHANNEL_REGISTRY_TABLES.linear && !CHANNEL_REGISTRY_TABLES.jira) {
    logger.info('Heartbeat sweep skipped — no channel credentials registry configured');
    return;
  }

  const nowMs = Date.now();
  let running: DdbMap[];
  try {
    running = await loadRunningTasks();
  } catch (err) {
    logger.warn('Heartbeat sweep: StatusIndex query failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const plans = running
    .map(toView)
    .map((v) => planHeartbeat(v, nowMs))
    .filter((p): p is NonNullable<typeof p> => p !== null);

  logger.info('Heartbeat sweep', {
    running_count: running.length,
    eligible: plans.length,
    edited_cap: MAX_EDITS_PER_SWEEP,
  });

  let attempted = 0;
  let edited = 0;
  for (const plan of plans.slice(0, MAX_EDITS_PER_SWEEP)) {
    try {
      if (await terminalReplyClaimed(docDdb, TASK_TABLE, plan.taskId)) continue;
      const channel = channelForSource(plan.channelSource, CHANNEL_REGISTRY_TABLES);
      if (!channel) continue;
      attempted += 1;
      const issue = { issueId: plan.issueId, credentialsRef: plan.credentialsRef };
      if (plan.channelSource === 'jira') {
        const result = await updateJiraIterationComment(
          docDdb, TASK_TABLE, plan.taskId,
          { cloudId: plan.credentialsRef, registryTableName: CHANNEL_REGISTRY_TABLES.jira! },
          plan.issueId, plan.replyId,
          { body: buildAdfDocument(plan.body.split('\n').map(parseMarkdownRuns)), terminal: false },
        );
        if (result.ok) {
          edited += 1;
        } else {
          logger.warn('Heartbeat sweep: reply edit failed (non-fatal)', {
            task_id: plan.taskId,
            retryable: result.retryable,
          });
        }
        continue;
      }
      const ref = plan.channelSource === 'linear' && plan.parentCommentId
        ? await channel.upsertThreadedReply?.(
          issue,
          { commentId: plan.parentCommentId },
          plan.body,
          { commentId: plan.replyId },
          {
            preservePreview: true,
            skipIfSettled: true,
          },
        )
        : await channel.upsertComment(
          issue,
          plan.body,
          { commentId: plan.replyId },
        );
      if (ref) edited += 1;
    } catch (err) {
      logger.warn('Heartbeat sweep: reply edit failed (non-fatal)', {
        task_id: plan.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (plans.length > MAX_EDITS_PER_SWEEP) {
    logger.warn('Heartbeat sweep: capped — some eligible tasks not edited this round', {
      eligible: plans.length, cap: MAX_EDITS_PER_SWEEP,
    });
  }
  logger.info('Heartbeat sweep complete', { attempted, edited });
}
