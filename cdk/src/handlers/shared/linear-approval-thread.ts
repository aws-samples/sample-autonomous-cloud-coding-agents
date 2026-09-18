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

import { createHash } from 'node:crypto';
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const RETENTION_DAYS = 90;
const RETENTION_SECONDS = RETENTION_DAYS * 24 * 60 * 60;

export interface LinearApprovalThread {
  readonly workspaceId: string;
  readonly issueId: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly userId: string;
}

/** Linear requires UUIDv4; stable hash-derived bits make comment retries address the same ID. */
export function linearApprovalCommentId(thread: LinearApprovalThread): string {
  const hash = createHash('sha256').update(JSON.stringify([
    'abca-linear-approval-v1', thread.workspaceId, thread.issueId, thread.taskId, thread.requestId,
  ])).digest('hex');
  const groups = hash.match(/^(.{8})(.{4}).(.{3}).(.{3})(.{12})/)!;
  return `${groups[1]}-${groups[2]}-4${groups[3]}-a${groups[4]}-${groups[5]}`;
}

function threadKey(workspaceId: string, commentId: string): { task_id: string; request_id: string } {
  return { task_id: `LINEAR_COMMENT#${workspaceId}#${commentId}`, request_id: 'APPROVAL' };
}

/** Mapping is coordinator-owned: task-scoped worker credentials cannot write this key. */
export async function saveLinearApprovalThread(
  ddb: DynamoDBDocumentClient, tableName: string, thread: LinearApprovalThread,
): Promise<string> {
  const commentId = linearApprovalCommentId(thread);
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: threadKey(thread.workspaceId, commentId),
    UpdateExpression: 'SET #kind = :kind, #thread = :thread',
    ConditionExpression: 'attribute_not_exists(task_id) OR (#kind = :kind AND #thread = :thread)',
    ExpressionAttributeNames: { '#kind': 'kind', '#thread': 'thread' },
    ExpressionAttributeValues: { ':kind': 'linear_approval_thread', ':thread': thread },
  }));
  return commentId;
}

export async function readLinearApprovalThread(
  ddb: DynamoDBDocumentClient, tableName: string, workspaceId: string, commentId: string,
): Promise<LinearApprovalThread | null> {
  const result = await ddb.send(new GetCommand({
    TableName: tableName, Key: threadKey(workspaceId, commentId), ConsistentRead: true,
  }));
  const thread = result.Item?.thread as LinearApprovalThread | undefined;
  if (result.Item?.kind !== 'linear_approval_thread' || !thread
    || ![thread.workspaceId, thread.issueId, thread.taskId, thread.requestId, thread.userId]
      .every(value => typeof value === 'string' && value.length > 0)
    || thread.workspaceId !== workspaceId || linearApprovalCommentId(thread) !== commentId) return null;
  return thread;
}

/** Pending mappings have no TTL, like pending approvals; closure starts retention. */
export async function closeLinearApprovalThread(
  ddb: DynamoDBDocumentClient, tableName: string, thread: LinearApprovalThread,
): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: threadKey(thread.workspaceId, linearApprovalCommentId(thread)),
      UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl)',
      ConditionExpression: 'attribute_exists(task_id)',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':ttl': Math.floor(Date.now() / 1000) + RETENTION_SECONDS },
    }));
  } catch (error) {
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
  }
}

/** Only an explicit answer in an approval thread is a decision, never prose or an edit. */
export function parseLinearApprovalReply(body: unknown): 'approve' | 'deny' | null {
  if (typeof body !== 'string') return null;
  const match = /^(approve|deny)[.!]?$/i.exec(body.trim());
  return match ? match[1]!.toLowerCase() as 'approve' | 'deny' : null;
}
