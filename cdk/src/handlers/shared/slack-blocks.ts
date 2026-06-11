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

import { formatDuration, truncate } from './slack-format';
import type { TaskRecord } from './types';

/** A Slack Block Kit mrkdwn text object. */
interface MrkdwnText {
  readonly type: 'mrkdwn';
  readonly text: string;
}

/** A Slack Block Kit plain_text text object. */
interface PlainText {
  readonly type: 'plain_text';
  readonly text: string;
  readonly emoji?: boolean;
}

/** Section block: a single line/paragraph of mrkdwn content. */
export interface SectionBlock {
  readonly type: 'section';
  readonly text: MrkdwnText;
  readonly block_id?: string;
}

/** Link-out button: opens a URL in a new tab. No action_id needed. */
export interface LinkButtonElement {
  readonly type: 'button';
  readonly text: PlainText;
  readonly url: string;
  readonly style?: 'primary' | 'danger';
}

/** Actionable button: triggers a Block Kit interaction callback via action_id. */
export interface ActionButtonElement {
  readonly type: 'button';
  readonly text: PlainText;
  readonly action_id: string;
  readonly style?: 'primary' | 'danger';
  readonly confirm?: {
    readonly title: PlainText;
    readonly text: MrkdwnText;
    readonly confirm: PlainText;
    readonly deny: PlainText;
  };
}

export type ButtonElement = LinkButtonElement | ActionButtonElement;

/** Actions block: a row of interactive elements (buttons, menus, etc.). */
export interface ActionsBlock {
  readonly type: 'actions';
  readonly block_id: string;
  readonly elements: ReadonlyArray<ButtonElement>;
}

/** Any Block Kit block this module renders. */
export type SlackBlock = SectionBlock | ActionsBlock;

/** A Slack message payload suitable for chat.postMessage. */
export interface SlackMessage {
  /** Fallback plain-text for notifications. */
  readonly text: string;
  /** Block Kit blocks for rich rendering. */
  readonly blocks: SlackBlock[];
  /** If set, post as a threaded reply. */
  readonly thread_ts?: string;
}

/**
 * Render a task event as a Slack Block Kit message.
 *
 * @param eventType - the task event type (e.g. 'task_created', 'task_completed').
 * @param task - the task record with current state.
 * @param eventMetadata - optional metadata from the event record.
 * @returns a SlackMessage payload.
 */
export function renderSlackBlocks(
  eventType: string,
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'task_description' | 'pr_url' | 'error_message' | 'cost_usd' | 'duration_s' | 'status'>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  switch (eventType) {
    case 'task_created':
      return taskCreatedMessage(task);
    case 'session_started':
      return sessionStartedMessage(task);
    case 'task_completed':
      return taskCompletedMessage(task);
    case 'task_failed':
      return taskFailedMessage(task, eventMetadata);
    case 'task_cancelled':
      return simpleStatusMessage(task, ':no_entry_sign: Task cancelled');
    case 'task_timed_out':
      return taskTimedOutMessage(task);
    case 'task_stranded':
      // Emitted by reconcile-stranded-tasks when a task's heartbeat
      // stops. Operators see this on stranded Slack-origin tasks; the
      // generic "Event: ..." fallback would be a UX regression
      // (issue #64 review Cat 7).
      return taskStrandedMessage(task, eventMetadata);
    case 'agent_error':
      return agentErrorMessage(task, eventMetadata);
    case 'approval_requested':
      return approvalRequestedMessage(task, eventMetadata);
    case 'approval_stranded':
      return approvalStrandedMessage(task, eventMetadata);
    default:
      return simpleStatusMessage(task, `Event: ${eventType}`);
  }
}

/**
 * Cedar HITL severities that may be decided via Slack buttons.
 * `high` gates require a fresh CLI Cognito flow (§11.2 finding #4) —
 * the message renders without buttons and points at the CLI instead.
 */
export const SLACK_APPROVABLE_SEVERITIES: ReadonlySet<string> = new Set(['low', 'medium']);

/**
 * `approval_requested` — the Cedar HITL gate fired and the task is
 * paused in AWAITING_APPROVAL (issue #112).
 *
 * The action_id carries `approve_action:{task_id}:{request_id}` (or
 * `deny_action:…`) — the interactions handler splits on `:` to address
 * the approval row. Both ids are ULIDs (no `:` in the alphabet), so the
 * separator is unambiguous. The Slack-side identity → platform user
 * mapping and the severity re-check happen in `slack-interactions.ts`;
 * the buttons here are UX, not authorization.
 */
function approvalRequestedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  const requestId = typeof eventMetadata?.request_id === 'string' ? eventMetadata.request_id : undefined;
  const toolName = typeof eventMetadata?.tool_name === 'string' ? eventMetadata.tool_name : 'a tool';
  const inputPreview = typeof eventMetadata?.input_preview === 'string' ? eventMetadata.input_preview : '';
  const reason = typeof eventMetadata?.reason === 'string' ? eventMetadata.reason : '';
  const severity = typeof eventMetadata?.severity === 'string' ? eventMetadata.severity : 'medium';
  const timeoutS = typeof eventMetadata?.timeout_s === 'number' ? eventMetadata.timeout_s : undefined;

  const lines = [`:lock: *Approval required* for \`${task.repo}\``];
  lines.push(`_Tool:_ \`${toolName}\`${inputPreview ? ` — \`${truncate(inputPreview, 150)}\`` : ''}`);
  if (reason) lines.push(`_Reason:_ ${truncate(reason, 200)}`);
  lines.push(`_Severity:_ ${severity}${timeoutS ? ` · _times out in ${formatDuration(timeoutS)}_` : ''}`);
  const text = lines.join('\n');

  const blocks: SlackBlock[] = [section(text)];

  if (requestId && SLACK_APPROVABLE_SEVERITIES.has(severity)) {
    blocks.push(actions(task.task_id, [
      approveButton(task.task_id, requestId),
      denyButton(task.task_id, requestId),
    ]));
  } else if (requestId) {
    // High severity: CLI-only per §11.2 finding #4 — a compromised
    // Slack identity must not be able to approve the riskiest gates.
    blocks.push(section(
      `:shield: High-severity gate — approve via CLI: \`bgagent approve ${task.task_id} ${requestId}\``,
    ));
  }

  return {
    text: `Approval required for ${task.repo}`,
    blocks,
  };
}

/**
 * `approval_stranded` — the reconciler found a PENDING gate whose task
 * stopped heartbeating. Informational; nothing left to click.
 */
function approvalStrandedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  const requestId = typeof eventMetadata?.request_id === 'string'
    ? `\n_Request:_ \`${eventMetadata.request_id}\``
    : '';
  const text = `:warning: *Approval request stranded* for \`${task.repo}\` — the task stopped before a decision was recorded.${requestId}`;
  return {
    text: `Approval request stranded for ${task.repo}`,
    blocks: [section(text)],
  };
}

function taskCreatedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'task_description'>,
): SlackMessage {
  const desc = task.task_description
    ? `\n${truncate(task.task_description, 200)}`
    : '';
  const text = `:rocket: *Task submitted* for \`${task.repo}\`${desc}\n_ID:_ \`${task.task_id}\``;
  return {
    text: `Task submitted for ${task.repo}`,
    blocks: [section(text)],
  };
}

function taskCompletedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'pr_url' | 'cost_usd' | 'duration_s'>,
): SlackMessage {
  const parts = [`:white_check_mark: *Task completed* for \`${task.repo}\``];
  const stats: string[] = [];
  if (task.duration_s != null) stats.push(formatDuration(task.duration_s));
  if (task.cost_usd != null) stats.push(`$${Number(task.cost_usd).toFixed(2)}`);
  if (stats.length > 0) parts.push(stats.join(' · '));
  const text = parts.join('\n');

  const blocks: SlackBlock[] = [section(text)];

  // "View PR" button — no inline link text, so Slack won't unfurl a big preview card.
  if (task.pr_url) {
    blocks.push(actions(task.task_id, [
      linkButton(`View PR ${prLabel(task.pr_url)}`, task.pr_url),
    ]));
  }

  return {
    text: `Task completed for ${task.repo}`,
    blocks,
  };
}

function taskFailedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'error_message'>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  const reason = task.error_message
    ?? (eventMetadata?.error as string | undefined)
    ?? 'Unknown error';
  const text = `:x: *Task failed* for \`${task.repo}\`\n_Reason:_ ${truncate(reason, 300)}`;
  return {
    text: `Task failed for ${task.repo}`,
    blocks: [section(text)],
  };
}

function taskTimedOutMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'duration_s'>,
): SlackMessage {
  const duration = task.duration_s != null ? ` after ${formatDuration(task.duration_s)}` : '';
  const text = `:hourglass: *Task timed out* for \`${task.repo}\`${duration}`;
  return {
    text: `Task timed out for ${task.repo}`,
    blocks: [section(text)],
  };
}

function sessionStartedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'>,
): SlackMessage {
  const text = `:hourglass_flowing_sand: Agent started working on \`${task.repo}\``;
  return {
    text: `Agent started working on ${task.repo}`,
    blocks: [
      section(text),
      actions(task.task_id, [
        dangerButton('Cancel Task', `cancel_task:${task.task_id}`),
      ]),
    ],
  };
}

function taskStrandedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  // The reconciler stamps ``code: STRANDED_NO_HEARTBEAT`` and
  // ``prior_status`` on the event metadata (see
  // handlers/reconcile-stranded-tasks.ts). Surface the prior status so
  // operators can tell at a glance whether the task hung in HYDRATING
  // vs RUNNING.
  const priorStatus = typeof eventMetadata?.prior_status === 'string'
    ? eventMetadata.prior_status
    : undefined;
  const detail = priorStatus ? ` (last status: ${priorStatus})` : '';
  const text = `:warning: *Task stranded* for \`${task.repo}\`${detail}`;
  return {
    text: `Task stranded for ${task.repo}`,
    blocks: [section(text)],
  };
}

function agentErrorMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  // ``agent/src/progress_writer.py::write_agent_error`` carries
  // ``error_type`` and ``message_preview``. Render whichever is
  // present without leaking the full preview if it's noisy.
  const errorType = typeof eventMetadata?.error_type === 'string'
    ? eventMetadata.error_type
    : undefined;
  const preview = typeof eventMetadata?.message_preview === 'string'
    ? eventMetadata.message_preview
    : undefined;
  const detail = errorType
    ? `\n_Type:_ \`${errorType}\``
    : '';
  const previewLine = preview ? `\n${truncate(preview, 200)}` : '';
  const text = `:rotating_light: *Agent error* during \`${task.repo}\`${detail}${previewLine}`;
  return {
    text: `Agent error during ${task.repo}`,
    blocks: [section(text)],
  };
}

function simpleStatusMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'>,
  label: string,
): SlackMessage {
  const text = `${label} for \`${task.repo}\`\n_ID:_ \`${task.task_id}\``;
  return {
    text: `${label} for ${task.repo}`,
    blocks: [section(text)],
  };
}

function section(text: string): SectionBlock {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function actions(blockId: string, elements: ReadonlyArray<ButtonElement>): ActionsBlock {
  return { type: 'actions', block_id: blockId, elements };
}

function linkButton(label: string, url: string): LinkButtonElement {
  return {
    type: 'button',
    text: { type: 'plain_text', text: label },
    url,
    style: 'primary',
  };
}

function dangerButton(label: string, actionId: string): ActionButtonElement {
  return {
    type: 'button',
    text: { type: 'plain_text', text: label },
    action_id: actionId,
    style: 'danger',
    confirm: {
      title: { type: 'plain_text', text: 'Cancel task?' },
      text: { type: 'mrkdwn', text: 'This will stop the running agent.' },
      confirm: { type: 'plain_text', text: 'Cancel' },
      deny: { type: 'plain_text', text: 'Keep running' },
    },
  };
}

function approveButton(taskId: string, requestId: string): ActionButtonElement {
  return {
    type: 'button',
    text: { type: 'plain_text', text: '✅ Approve' },
    action_id: `approve_action:${taskId}:${requestId}`,
    style: 'primary',
    confirm: {
      title: { type: 'plain_text', text: 'Approve this tool call?' },
      text: { type: 'mrkdwn', text: 'The agent will run the gated tool call and continue.' },
      confirm: { type: 'plain_text', text: 'Approve' },
      deny: { type: 'plain_text', text: 'Go back' },
    },
  };
}

function denyButton(taskId: string, requestId: string): ActionButtonElement {
  return {
    type: 'button',
    text: { type: 'plain_text', text: '❌ Deny' },
    action_id: `deny_action:${taskId}:${requestId}`,
    style: 'danger',
    confirm: {
      title: { type: 'plain_text', text: 'Deny this tool call?' },
      text: { type: 'mrkdwn', text: 'The agent will skip the gated tool call and adjust.' },
      confirm: { type: 'plain_text', text: 'Deny' },
      deny: { type: 'plain_text', text: 'Go back' },
    },
  };
}

function prLabel(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)$/);
  return match ? `#${match[1]}` : 'Pull Request';
}
