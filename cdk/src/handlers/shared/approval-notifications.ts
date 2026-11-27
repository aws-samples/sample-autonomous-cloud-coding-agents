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
import { TaskStatus, TERMINAL_STATUSES } from '../../constructs/task-status';
import { scanDenyReason } from './deny-reason-scanner';
import { logger } from './logger';
import type { TaskRecord } from './types';

const REQUEST_ID_MAX_LENGTH = 128;
const SEVERITY_MAX_LENGTH = 20;
const SCOPE_MAX_LENGTH = 150;

/**
 * Approval messages for a task's channel. Requests are rendered from the saved
 * approval row; outcomes are acknowledged when the decision commits. A task
 * cancelled while waiting is reported by the channel's terminal message.
 */
export const APPROVAL_NOTIFICATION_EVENTS = [
  'approval_requested', 'approval_decision_recorded', 'approval_timed_out', 'approval_stranded',
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
  /** When a pending request is denied unanswered (ISO), if it has a timeout. */
  readonly deadline?: string;
}

/** Where a notice goes. A Linear agent session answers with buttons, not a comment reply. */
export type ApprovalChannel = 'slack' | 'linear' | 'linear_session';

function text(value: unknown, max = 500): string {
  if (typeof value !== 'string') return '';
  // Redact before truncation so cutting a token cannot hide its recognizable shape.
  const clean = scanDenyReason(value)
    // eslint-disable-next-line no-control-regex -- strips terminal escape sequences from untrusted text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // Control and bidi characters, and the line breaks a reader takes for a new line
    // besides the line feed (U+0085, U+2028, U+2029). The line feed stays for text the
    // notice shows as is; a field that must stay on its line is quoted.
    // eslint-disable-next-line no-control-regex -- strips control and bidi characters from untrusted text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0085\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');
  return clean.length > max ? `${clean.slice(0, max)}… [shortened]` : clean;
}

/**
 * Tools whose arguments carry file content, and the argument that names the file.
 * A notice shows only the file: content written to ``.env`` or a credentials file
 * holds secrets the scanner cannot recognise (``DB_PASSWORD=...``), and a Linear
 * issue is read by more people than the task owner.
 */
const FILE_CONTENT_TOOLS: Readonly<Record<string, string>> = {
  Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path',
};

/** Describe only recorded arguments; tool names cannot establish intent or safety. */
function describeAction(row: Record<string, unknown>, task: TaskRecord): string[] {
  const tool = text(row.tool_name, 100);
  const preview = typeof row.tool_input_preview === 'string' ? row.tool_input_preview : '';
  let input: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(preview);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
  } catch {
    // The guest stores a bounded preview, which may end partway through JSON.
  }
  const quote = (value: unknown) => JSON.stringify(text(value));
  const pathKey = FILE_CONTENT_TOOLS[tool] ?? 'file_path';
  const path = typeof input?.[pathKey] === 'string' ? input[pathKey] : '';
  const workspace = `/workspace/${task.task_id}/`;
  const target = quote(path.startsWith(workspace) ? path.slice(workspace.length) : path);
  const repository = task.repo ? [`Repository: ${text(task.repo)}`] : [];
  if (tool in FILE_CONTENT_TOOLS) {
    const change = !path
      ? `The agent wants to change a file with the tool ${quote(tool)}. Its path could not be read from the saved arguments.`
      : tool === 'Write' ? `The agent wants to write to ${target}, creating the file or replacing its contents.`
        : tool === 'NotebookEdit' ? `The agent wants to change the notebook ${target}.`
          : `The agent wants to change text in ${target}.`;
    return [change, ...repository, 'The new content is not shown here. Run bgagent pending to see it.'];
  }
  let action: string;
  if (tool === 'Read' && path) {
    action = `The agent wants to read the file ${target}.`;
  } else if (tool === 'Bash') {
    action = 'The agent wants to run a shell command.';
  } else if (tool === 'WebFetch' && typeof input?.url === 'string') {
    action = `The agent wants to fetch content from ${quote(input.url)}.`;
  } else if (tool === 'Glob' || tool === 'Grep') {
    action = `The agent wants to search ${tool === 'Glob' ? 'file names' : 'file contents'}.`;
  } else {
    action = `The agent wants to call the tool ${quote(tool)}.`;
  }
  const lines = [action, ...repository];
  if (typeof input?.description === 'string' && input.description.trim()) {
    lines.push(`Agent's explanation: ${quote(input.description)}`);
  }
  if (tool === 'Bash' && typeof input?.command === 'string') {
    lines.push(`Command: ${quote(input.command)}`);
  }
  // Always retain the preview: summaries must not hide flags, ranges or edits.
  lines.push(`Saved arguments: ${text(preview) || '(not available)'}`);
  if (!input || preview.endsWith('...') || preview.length > 500) {
    lines.push('The saved arguments are incomplete or could not be interpreted. They may not show the full action.');
  }
  return lines;
}

/** The body of a request that is still waiting for a decision: the action, why, the deadline and how to answer. */
function pendingLines(
  row: Record<string, unknown>,
  task: TaskRecord,
  requestId: string,
  channel: ApprovalChannel,
): string[] {
  const lines: string[] = [];
  lines.push('', ...describeAction(row, task), '');
  const reason = text(row.reason);
  lines.push(reason.startsWith('Soft-deny:')
    ? 'Why approval is required: your configured policy requires a human decision for this action.'
    : `Why approval is required: ${reason || 'No explanation was saved with this request.'}`);
  lines.push('Approve: allow this action once.',
    'Deny: block this action and return the decision to the agent.');
  const deadline = Date.parse(String(row.created_at)) + Number(row.timeout_s) * 1000;
  if (Number.isFinite(deadline) && Number(row.timeout_s) > 0) {
    lines.push(`Decision deadline: ${new Date(deadline).toISOString()}`);
  }
  if (channel === 'linear') {
    lines.push('', 'Reply approve, or deny with an optional reason (for example "deny use the staging config"),',
      'to this comment while signed in as the task owner.');
  } else if (channel === 'linear_session') {
    lines.push('', 'Choose Approve or Deny below, or reply deny with a reason (for example "deny use the staging config").',
      'Only the task owner can decide.');
  }
  lines.push('', 'Technical details / CLI alternative',
    `Task: ${task.task_id}`, `Request: ${requestId}`,
    `Tool: ${text(row.tool_name, 100)}`, `Policy severity: ${text(row.severity, SEVERITY_MAX_LENGTH)}`,
    `Policy detail: ${reason}`);
  // Never interpolate untrusted text into suggested shell commands.
  if ([task.task_id, requestId].every(id => /^[A-Za-z0-9_-]{1,128}$/.test(id))) {
    lines.push('Respond using the CLI while signed in as the task owner:',
      `bgagent approve ${task.task_id} ${requestId} --scope this_call`,
      `bgagent deny ${task.task_id} ${requestId}`);
  }
  lines.push('Run bgagent pending to see currently open requests.');
  return lines;
}

/** The notification's title and text lines for an approval row in `status`. */
function renderApproval(
  status: string,
  row: Record<string, unknown>,
  task: TaskRecord,
  requestId: string,
  channel: ApprovalChannel,
): { title: string; lines: string[] } {
  const title = status === 'PENDING' ? 'Approval needed'
    : status === 'APPROVED' ? 'Approval recorded'
      : status === 'DENIED' ? 'Denial recorded'
        : status === 'TIMED_OUT' ? 'Approval request timed out' : 'Approval wait could not continue';
  const lines = [title];
  if (status === 'PENDING') {
    lines.push(...pendingLines(row, task, requestId, channel));
  } else if (status === 'APPROVED') {
    lines.push(`Task: ${task.task_id}`, `Request: ${requestId}`);
    lines.push(`Scope: ${text(row.scope, SCOPE_MAX_LENGTH)}`);
    lines.push(TERMINAL_STATUSES.includes(task.status)
      ? `The decision is saved. Task status: ${task.status}. The task has already ended.`
      : 'The decision is saved. The agent continues with this action.');
  } else if (status === 'DENIED') {
    lines.push(`Task: ${task.task_id}`, `Request: ${requestId}`);
    lines.push(`Reason: ${text(row.deny_reason) || 'No reason supplied.'}`);
    lines.push(TERMINAL_STATUSES.includes(task.status)
      ? `The decision is saved. Task status: ${task.status}. The task has already ended.`
      : 'The decision is saved. The agent receives the denial and continues without this action.');
  } else {
    lines.push(`Task: ${task.task_id}`, `Request: ${requestId}`);
    // reason is the original policy explanation, not the cause of closure.
    // The agent stores a polling failure in deny_reason on its timeout path.
    const reason = status === 'TIMED_OUT'
      ? text(row.deny_reason) || 'The configured decision deadline was reached.'
      : text(task.error_message) || 'The agent could not continue this approval wait.';
    lines.push(`Reason: ${reason}`);
  }
  return { title, lines };
}

/** Read saved state instead of showing an old, delayed "please approve" event. */
export async function loadApprovalNotification(
  ddb: DynamoDBDocumentClient,
  task: TaskRecord,
  eventType: string,
  metadata: Record<string, unknown>,
  channel: ApprovalChannel,
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
      : eventType === 'approval_timed_out' ? ['TIMED_OUT'] : ['STRANDED'];
  if (!expected.includes(status)) return null;
  if (status === 'PENDING'
    && (task.status !== 'AWAITING_APPROVAL' || task.awaiting_approval_request_id !== requestId)) return null;

  const { title, lines } = renderApproval(status, row, task, requestId, channel);
  const deadlineMs = Date.parse(String(row.created_at)) + Number(row.timeout_s) * 1000;
  const deadline = status === 'PENDING' && Number.isFinite(deadlineMs) && Number(row.timeout_s) > 0
    ? new Date(deadlineMs).toISOString() : undefined;
  return {
    title,
    text: lines.join('\n'),
    taskId: task.task_id,
    requestId,
    userId: task.user_id,
    marker,
    ...(deadline && { deadline }),
  };
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

/** Escape preview Markdown, including backticks, so repository text cannot break out of its code fence. */
export function approvalNotificationMarkdown(notification: ApprovalNotification): string {
  return `\`\`\`text\n${notification.text.replace(/`/g, 'ˋ')}\n\`\`\``;
}
