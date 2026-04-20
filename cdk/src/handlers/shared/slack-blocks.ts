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

import type { TaskRecord } from './types';

/** A Slack Block Kit block element. */
export interface SlackBlock {
  readonly type: string;
  readonly text?: { readonly type: string; readonly text: string };
  readonly elements?: ReadonlyArray<Record<string, unknown>>;
  readonly block_id?: string;
}

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
    default:
      return simpleStatusMessage(task, `Event: ${eventType}`);
  }
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
  if (task.duration_s != null) stats.push(formatDuration(Number(task.duration_s)));
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

function section(text: string): SlackBlock {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remainM = m % 60;
  return remainM > 0 ? `${h}h ${remainM}m` : `${h}h`;
}

function actions(blockId: string, elements: Record<string, unknown>[]): SlackBlock {
  return { type: 'actions', block_id: blockId, elements } as unknown as SlackBlock;
}

function linkButton(label: string, url: string): Record<string, unknown> {
  return {
    type: 'button',
    text: { type: 'plain_text', text: label },
    url,
    style: 'primary',
  };
}

function dangerButton(label: string, actionId: string): Record<string, unknown> {
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

function prLabel(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)$/);
  return match ? `#${match[1]}` : 'Pull Request';
}
