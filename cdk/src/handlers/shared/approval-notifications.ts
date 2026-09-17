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

import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { scanDenyReason } from './deny-reason-scanner';
import { logger } from './logger';
import type { TaskRecord } from './types';
import { TaskStatus, TERMINAL_STATUSES } from '../../constructs/task-status';

const REQUEST_ID_MAX_LENGTH = 128;
const SEVERITY_MAX_LENGTH = 20;
const SCOPE_MAX_LENGTH = 150;

/** Decisions are acknowledged at commit time, even when the worker cannot wake. */
export const APPROVAL_NOTIFICATION_EVENTS = [
  'approval_requested', 'approval_decision_recorded', 'approval_timed_out',
  'approval_cancelled', 'approval_stranded',
] as const;

export function isApprovalNotification(eventType: string): boolean {
  return (APPROVAL_NOTIFICATION_EVENTS as readonly string[]).includes(eventType);
}

export interface ApprovalNotification {
  readonly title: string;
  readonly text: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly userId: string;
  readonly marker: string;
}

function text(value: unknown, max = 500): string {
  if (typeof value !== 'string') return '';
  // Redact before truncation so cutting a token cannot hide its recognizable shape.
  return scanDenyReason(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .slice(0, max);
}

/** Read saved state instead of showing an old, delayed "please approve" event. */
export async function loadApprovalNotification(
  ddb: DynamoDBDocumentClient,
  task: TaskRecord,
  eventType: string,
  metadata: Record<string, unknown>,
  channel: 'slack' | 'linear',
): Promise<ApprovalNotification | null> {
  if (!isApprovalNotification(eventType)) return null;
  const tableName = process.env.TASK_APPROVALS_TABLE_NAME;
  if (!tableName) throw new Error('Approval notifications require TASK_APPROVALS_TABLE_NAME');
  // The deployed stranded-task reconciler closes the task, leaves its approval
  // row PENDING, and emits a milestone without request_id. Recover that identity
  // only from the consistently read, failed owning task and its saved cause.
  const legacyStranded = eventType === 'approval_stranded'
    && task.status === TaskStatus.FAILED
    && metadata.reason === 'STRANDED_NO_HEARTBEAT'
    && task.error_message?.startsWith('Approval stranded:');
  const requestId = metadata.request_id ?? (legacyStranded ? task.awaiting_approval_request_id : undefined);
  if (!requestId && eventType === 'approval_stranded') {
    logger.warn('Stranded approval notification has no saved request identity', {
      event: 'approval_notification_request_missing', task_id: task.task_id,
    });
    return null;
  }
  if (typeof requestId !== 'string' || !requestId || requestId.length > REQUEST_ID_MAX_LENGTH) {
    throw new Error('Approval notification is missing a valid request_id');
  }
  const response = await ddb.send(new GetCommand({
    TableName: tableName, Key: { task_id: task.task_id, request_id: requestId }, ConsistentRead: true,
  }));
  const row = response.Item;
  const marker = `notified_${channel}_${eventType}`;
  if (!row || row.user_id !== task.user_id || row[marker]) return null;
  const status = legacyStranded && row.status === 'PENDING'
    && task.awaiting_approval_request_id === requestId ? 'STRANDED' : row.status;
  const expected = eventType === 'approval_requested' ? ['PENDING']
    : eventType === 'approval_decision_recorded' ? ['APPROVED', 'DENIED']
      : eventType === 'approval_timed_out' ? ['TIMED_OUT']
        : eventType === 'approval_cancelled' ? ['CANCELLED'] : ['STRANDED'];
  if (!expected.includes(status)) return null;
  if (status === 'PENDING'
    && (task.status !== 'AWAITING_APPROVAL' || task.awaiting_approval_request_id !== requestId)) return null;

  const title = status === 'PENDING' ? 'Approval needed'
    : status === 'APPROVED' ? 'Approval recorded'
      : status === 'DENIED' ? 'Denial recorded'
        : status === 'TIMED_OUT' ? 'Approval request timed out'
          : status === 'CANCELLED' ? 'Approval request cancelled' : 'Approval wait could not continue';
  const lines = [title, `Task: ${task.task_id}`, `Request: ${requestId}`];
  if (status === 'PENDING') {
    lines.push(`Tool: ${text(row.tool_name, 100)}`, `Severity: ${text(row.severity, SEVERITY_MAX_LENGTH)}`,
      `Reason: ${text(row.reason)}`, `Action preview: ${text(row.tool_input_preview)}`);
    const deadline = Date.parse(row.created_at) + Number(row.timeout_s) * 1000;
    if (Number.isFinite(deadline) && Number(row.timeout_s) > 0) {
      lines.push(`Decision deadline: ${new Date(deadline).toISOString()}`);
    }
    // Never interpolate untrusted text into suggested shell commands.
    if ([task.task_id, requestId].every(id => /^[A-Za-z0-9_-]{1,128}$/.test(id))) {
      lines.push('Respond using the CLI while signed in as the task owner:',
        `bgagent approve ${task.task_id} ${requestId} --scope this_call`,
        `bgagent deny ${task.task_id} ${requestId}`);
    }
    lines.push('Run bgagent pending to see currently open requests.');
  } else if (status === 'APPROVED') {
    lines.push(`Scope: ${text(row.scope, SCOPE_MAX_LENGTH)}`);
    lines.push(TERMINAL_STATUSES.includes(task.status)
      ? `The decision is saved. Task status: ${task.status}. The task has already ended.`
      : 'The decision is saved. The agent will continue when its worker is ready.');
  } else if (status === 'DENIED') {
    lines.push(`Reason: ${text(row.deny_reason) || 'No reason supplied.'}`);
    lines.push(TERMINAL_STATUSES.includes(task.status)
      ? `The decision is saved. Task status: ${task.status}. The task has already ended.`
      : 'The decision is saved. The agent will receive the denial when its worker is ready.');
  } else {
    // reason is the original policy explanation, not the cause of closure.
    // The guest stores a polling failure in deny_reason on its timeout path.
    const reason = status === 'TIMED_OUT'
      ? text(row.deny_reason) || 'The configured decision deadline was reached.'
      : status === 'CANCELLED'
        ? text(row.cancellation_reason) || 'Task cancelled by its owner.'
        : text(task.error_message) || 'The agent could not continue this approval wait.';
    lines.push(`Reason: ${reason}`);
  }
  return { title, text: lines.join('\n'), taskId: task.task_id, requestId, userId: task.user_id, marker };
}

/** Persist only after the external service accepted the message, so failures retry. */
export async function markApprovalNotificationDelivered(
  ddb: DynamoDBDocumentClient,
  notification: ApprovalNotification,
): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: process.env.TASK_APPROVALS_TABLE_NAME!,
      Key: { task_id: notification.taskId, request_id: notification.requestId },
      UpdateExpression: 'SET #marker = :now',
      ConditionExpression: 'attribute_exists(task_id) AND user_id = :user',
      ExpressionAttributeNames: { '#marker': notification.marker },
      ExpressionAttributeValues: { ':now': new Date().toISOString(), ':user': notification.userId },
    }));
  } catch (error) {
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    // TTL removal after a successful post must not recreate the approval row.
    logger.info('Approval disappeared before its notification receipt was saved', {
      event: 'approval_notification_receipt_missing', task_id: notification.taskId, request_id: notification.requestId,
    });
  }
}

/** Keep previews literal: repository text must not create mentions or Markdown links. */
export function approvalNotificationMarkdown(notification: ApprovalNotification): string {
  return `\`\`\`text\n${notification.text.replace(/`/g, 'ˋ')}\n\`\`\``;
}
