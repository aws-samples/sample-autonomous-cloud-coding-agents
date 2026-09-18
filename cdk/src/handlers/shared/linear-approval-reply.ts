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
import {
  closeLinearApprovalThread, linearApprovalCommentId, parseLinearApprovalReply, readLinearApprovalThread,
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

/** A verified webhook may decide only the exact gate bound to its thread. */
export async function handleLinearApprovalReply(
  event: ApprovalReplyEvent, deps: ApprovalReplyDependencies,
): Promise<boolean> {
  const decision = parseLinearApprovalReply(event.data.body);
  const workspaceId = event.organizationId;
  const parentId = event.data.parentId;
  if (event.action !== 'create' || !decision || !workspaceId || !parentId || !event.data.id) return false;
  const thread = await readLinearApprovalThread(deps.ddb, deps.approvalsTable, workspaceId, parentId);
  if (!thread) return false;
  const issueId = event.data.issueId ?? event.data.issue?.id;
  if (issueId !== thread.issueId) return true;
  const ctx = { linearWorkspaceId: workspaceId, registryTableName: deps.registryTable };
  const comment = await readLinearApprovalComment(ctx, event.data.id);
  if (!comment || comment.id !== event.data.id || comment.botActor || !comment.user?.id
    || comment.issue?.id !== issueId || comment.parent?.id !== parentId
    || parseLinearApprovalReply(comment.body) !== decision) {
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
  const expectedStatus = decision === 'approve' ? 'APPROVED' : 'DENIED';
  const readApproval = async () => (await deps.ddb.send(new GetCommand({
    TableName: deps.approvalsTable, Key: { task_id: thread.taskId, request_id: thread.requestId }, ConsistentRead: true,
  }))).Item;
  const alreadyRecorded = (row: Awaited<ReturnType<typeof readApproval>>) =>
    row?.user_id === userId && row.status === expectedStatus && row.decision_source === source;
  let recorded = alreadyRecorded(await readApproval());
  if (!recorded) {
    // Loaded only for configured approval integrations; ordinary comment paths
    // do not require the decision handlers' environment variables.
    const record = decision === 'approve'
      ? (await import('../approve-task.js')).recordApprovalForUser
      : (await import('../deny-task.js')).recordDenialForUser;
    const result = await record({
      userId,
      taskId: thread.taskId,
      decisionSource: source,
      body: JSON.stringify({ request_id: thread.requestId, decision }),
    });
    recorded = result.statusCode === 202 || alreadyRecorded(await readApproval());
    if (!recorded) {
      if (result.statusCode >= 500) throw new Error(`Linear approval decision failed: HTTP ${result.statusCode}`);
      await respond(result.statusCode === 429
        ? 'Too many approval decisions. Wait a minute, then send a new reply.'
        : 'This request is already closed, expired, or no longer waiting. No new decision was recorded.');
      return true;
    }
  }
  await closeLinearApprovalThread(deps.ddb, deps.approvalsTable, thread);
  await respond(decision === 'approve'
    ? 'Approved for this action once. The decision is saved; the agent will continue when its worker is ready.'
    : 'Denied. The decision is saved; the agent will receive your denial when its worker is ready.');
  logger.info('Linear approval reply recorded', {
    task_id: thread.taskId, request_id: thread.requestId, comment_id: event.data.id, decision,
  });
  return true;
}
