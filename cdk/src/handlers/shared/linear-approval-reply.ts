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

import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { linearApprovalRefusal } from './approval-notifications';
import { withoutLeadingMention } from './linear-agent-session-event';
import {
  closeLinearApprovalThread, linearApprovalCommentId, parseLinearApprovalReply, readLinearApprovalThread,
  type LinearApprovalReply, type LinearApprovalThread,
} from './linear-approval-thread';
import { postIdentifiedComment, readLinearApprovalComment } from './linear-feedback';
import { logger } from './logger';

interface ApprovalReplyEvent {
  action: string;
  organizationId?: string;
  actor?: { id?: string };
  data: { id: string; body?: string; parentId?: string; issueId?: string; issue?: { id?: string } };
}

interface ApprovalReplyDependencies {
  ddb: DynamoDBDocumentClient;
  approvalsTable: string;
  taskTable: string;
  registryTable: string;
  lookupUser: (workspaceId: string, actorId: string) => Promise<string | null>;
}

function sameReply(a: LinearApprovalReply | null, b: LinearApprovalReply): boolean {
  return a?.decision === b.decision && (a.reason ?? '') === (b.reason ?? '');
}

/** The answer in a reply: ``approve`` or ``deny [reason]``, also after a leading mention of the app. */
function parseReply(body: unknown): LinearApprovalReply | null {
  return typeof body === 'string' ? parseLinearApprovalReply(withoutLeadingMention(body)) : null;
}

/**
 * A verified webhook may decide only the exact gate bound to its thread. Any other
 * reply under a notice whose request is still open is answered with how to decide,
 * and kept from the comment trigger: taken as a task request, ``@bgagent approve``
 * written some other way would start a pull-request iteration. True when handled.
 */
export async function handleLinearApprovalReply(
  event: ApprovalReplyEvent, deps: ApprovalReplyDependencies,
): Promise<boolean> {
  const workspaceId = event.organizationId;
  const parentId = event.data.parentId;
  if (event.action !== 'create' || !workspaceId || !parentId || !event.data.id) return false;
  const thread = await readLinearApprovalThread(deps.ddb, deps.approvalsTable, workspaceId, parentId);
  if (!thread) return false;
  const reply = parseReply(event.data.body);
  if (!reply && !await isRequestOpen(deps, thread)) return false;
  const issueId = event.data.issueId ?? event.data.issue?.id;
  if (issueId !== thread.issueId) return true;
  const ctx = { linearWorkspaceId: workspaceId, registryTableName: deps.registryTable };
  const comment = await readLinearApprovalComment(ctx, event.data.id);
  if (!comment || comment.id !== event.data.id || comment.botActor || !comment.user?.id
    || comment.issue?.id !== issueId || comment.parent?.id !== parentId
    || (reply && !sameReply(parseReply(comment.body), reply))) {
    logger.warn('Linear approval webhook does not match a human comment', {
      task_id: thread.taskId, request_id: thread.requestId, comment_id: event.data.id,
    });
    return true;
  }
  const respond = async (body: string): Promise<void> => {
    const posted = await postIdentifiedComment(ctx, {
      id: linearApprovalCommentId({ ...thread, requestId: `${thread.requestId}#reply#${event.data.id}` }),
      issueId,
      parentId,
      body,
    });
    if (!posted.ok) {
      logger.warn('Linear approval acknowledgement failed', {
        task_id: thread.taskId, request_id: thread.requestId, comment_id: event.data.id, retryable: posted.retryable,
      });
      if (posted.retryable) throw new Error('Retryable Linear approval acknowledgement failure');
    }
  };
  if (!reply) {
    await respond(NOT_AN_ANSWER_MESSAGE);
    return true;
  }
  if (!comment.noticeUnchanged) {
    logger.warn('Linear approval reply under a notice that was edited or not posted by ABCA', {
      task_id: thread.taskId, request_id: thread.requestId, comment_id: event.data.id,
    });
    await respond('This notice was changed after ABCA posted it, so it can\'t be answered here, and nothing was decided. '
      + 'Run bgagent pending to see the request, then decide with bgagent approve or bgagent deny.');
    return true;
  }
  const { decision } = reply;
  const userId = await deps.lookupUser(workspaceId, comment.user.id);
  if (!userId || userId !== thread.userId) {
    await respond('Only the task owner can decide this request. Link your Linear account to ABCA, then reply again.');
    return true;
  }
  const task = (await deps.ddb.send(new GetCommand({
    TableName: deps.taskTable, Key: { task_id: thread.taskId }, ConsistentRead: true,
  }))).Item;
  if (!task || task.user_id !== userId || task.channel_source !== 'linear'
    || task.channel_metadata?.linear_workspace_id !== workspaceId
    || task.channel_metadata?.linear_issue_id !== issueId) {
    await respond('This approval is no longer available for this task. No decision was recorded.');
    return true;
  }
  const source = JSON.stringify(['linear', workspaceId, event.data.id]);
  if (!await recordReply(deps, thread, userId, reply, source, respond)) return true;
  await closeLinearApprovalThread(deps.ddb, deps.approvalsTable, thread);
  await respond(decision === 'approve'
    ? 'Approved for this action once. The decision is saved and the agent continues.'
    : 'Denied. The decision is saved and the agent receives your denial.');
  logger.info('Linear approval reply recorded', {
    task_id: thread.taskId, request_id: thread.requestId, comment_id: event.data.id, decision,
  });
  return true;
}

const NOT_AN_ANSWER_MESSAGE = 'This request is waiting for a decision. To decide it, reply approve, or deny with an optional reason '
  + '(for example "deny use the staging config"). Nothing was decided, and this reply was not passed to the agent.';

/** Whether the thread's request is still waiting for a decision (read consistently). */
async function isRequestOpen(deps: ApprovalReplyDependencies, thread: LinearApprovalThread): Promise<boolean> {
  const { Item } = await deps.ddb.send(new GetCommand({
    TableName: deps.approvalsTable, Key: { task_id: thread.taskId, request_id: thread.requestId }, ConsistentRead: true,
  }));
  return Item?.status === 'PENDING';
}

/**
 * Record the owner's decision, unless it is recorded already (a duplicate delivery).
 * False when nothing was recorded; the reply then says why.
 */
async function recordReply(
  deps: ApprovalReplyDependencies,
  thread: LinearApprovalThread,
  userId: string,
  reply: LinearApprovalReply,
  source: string,
  respond: (body: string) => Promise<void>,
): Promise<boolean> {
  const { decision } = reply;
  const expectedStatus = decision === 'approve' ? 'APPROVED' : 'DENIED';
  const readApproval = async () => (await deps.ddb.send(new GetCommand({
    TableName: deps.approvalsTable, Key: { task_id: thread.taskId, request_id: thread.requestId }, ConsistentRead: true,
  }))).Item;
  const alreadyRecorded = (row: Awaited<ReturnType<typeof readApproval>>) =>
    row?.user_id === userId && row.status === expectedStatus && row.decision_source === source;
  const row = await readApproval();
  if (alreadyRecorded(row)) return true;
  const refusal = decision === 'approve' && row ? linearApprovalRefusal(row) : null;
  if (refusal) {
    await respond(`${refusal} No decision was recorded.`);
    return false;
  }
  // Loaded only for configured approval integrations; ordinary comment paths
  // do not require the decision handlers' environment variables.
  const record = decision === 'approve'
    ? (await import('../approve-task.js')).recordApprovalForUser
    : (await import('../deny-task.js')).recordDenialForUser;
  const result = await record({
    userId,
    taskId: thread.taskId,
    decisionSource: source,
    // The verified comment body (read back from Linear), not the webhook copy.
    body: JSON.stringify({
      request_id: thread.requestId,
      decision,
      ...(decision === 'deny' && reply.reason ? { reason: reply.reason } : {}),
    }),
  });
  if (result.statusCode === 202 || alreadyRecorded(await readApproval())) return true;
  if (result.statusCode >= 500) throw new Error(`Linear approval decision failed: HTTP ${result.statusCode}`);
  await respond(result.statusCode === 429
    ? 'Too many approval decisions. Wait a minute, then send a new reply.'
    : 'This request is already closed, expired, or no longer waiting. No new decision was recorded.');
  return false;
}
