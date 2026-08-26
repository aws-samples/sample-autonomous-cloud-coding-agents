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
 * Mid-run liveness heartbeat sweep (scheduled).
 *
 * Observed in practice: a comment-triggered iteration ran 22 min showing only
 * "🤖 Starting on this issue" then a terminal ❌ — a silent black box. This
 * scheduled Lambda runs every couple of minutes, finds RUNNING comment-triggered
 * iteration tasks, and EDITS THE EXISTING maturing reply in place to show
 * liveness ("🔄 Working — updating PR #N… _8m elapsed_"). It never posts a new
 * comment (the user's "don't clutter the Linear UI" constraint) — it reuses the
 * one reply comment id the trigger-time ack stamped on the task.
 *
 * Eligibility + body are decided by the pure {@link planHeartbeat}; this handler
 * owns only the I/O: a ``StatusIndex`` query for RUNNING tasks, the field
 * extraction off each record's ``channel_metadata``, and the best-effort reply
 * edit. Idempotent: editing to the same body is a no-op; the terminal settle
 * (reconciler) later overwrites the working line with ✅/❌ as today.
 */

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { planHeartbeat, type HeartbeatTaskView } from './shared/iteration-heartbeat';
import { terminalReplyClaimed } from './shared/iteration-reply-claim';
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

/** Hard cap on tasks edited per sweep — a backstop against an unexpected flood. */
const MAX_EDITS_PER_SWEEP = 50;

interface DdbMap { [k: string]: { S?: string; N?: string; BOOL?: boolean; M?: DdbMap } }

/** Map a RUNNING task's DDB image → the heartbeat view (channel_metadata is nested). */
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
    // The issue the reply lives on. The orchestration path stamps
    // ``trigger_comment_issue_id`` (the parent epic, for a routed comment);
    // the STANDALONE path stamps only ``linear_issue_id`` (the reply is on that
    // same issue). Fall back to it so standalone iterations get a heartbeat —
    // the reconciler's reply path uses the same precedence.
    ...((cm.trigger_comment_issue_id?.S ?? cm.linear_issue_id?.S ?? cm.jira_issue_key?.S) !== undefined && {
      triggerCommentIssueId:
        cm.trigger_comment_issue_id?.S ?? cm.linear_issue_id?.S ?? cm.jira_issue_key?.S,
    }),
    isIteration: cm.orchestration_iteration?.S === 'true',
    ...(prNumberRaw !== undefined && { prNumber: Number(prNumberRaw) }),
    ...(img.pr_url?.S !== undefined && { prUrl: img.pr_url.S }),
  };
}

/** Query every RUNNING task via the StatusIndex GSI (paginated). */
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
 * logged and skipped; the sweep never throws (a heartbeat is cosmetic — it must
 * never wedge or alarm).
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

  let edited = 0;
  for (const plan of plans.slice(0, MAX_EDITS_PER_SWEEP)) {
    try {
      if (await terminalReplyClaimed(docDdb, TASK_TABLE, plan.taskId)) continue;
      const channel = channelForSource(plan.channelSource, CHANNEL_REGISTRY_TABLES);
      if (!channel) continue;
      const issue = { issueId: plan.issueId, credentialsRef: plan.credentialsRef };
      const ref = plan.channelSource === 'linear' && plan.parentCommentId
        ? await channel.upsertThreadedReply?.(
          issue,
          { commentId: plan.parentCommentId },
          plan.body,
          { commentId: plan.replyId },
          {
            // Keep any already-landed deploy-preview block (a heartbeat must never
            // clobber the screenshot the webhook may have appended).
            preservePreview: true,
            // A liveness tick is the LEAST important writer of this reply: if the
            // task has already settled, saying "working" again would un-settle it
            // in the reader's eyes.
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
  logger.info('Heartbeat sweep complete', { edited });
}
