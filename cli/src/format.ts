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

import { CreateWebhookResponse, TaskDetail, TaskEvent, TaskSummary, WebhookDetail } from './types';

/** Format a TaskDetail as a key-value detail view. */
export function formatTaskDetail(task: TaskDetail): string {
  const lines: string[] = [
    `Task:        ${task.task_id}`,
    `Status:      ${task.status}`,
    `Repo:        ${task.repo}`,
  ];
  if (task.task_type && task.task_type !== 'new_task') {
    lines.push(`Type:        ${task.task_type}`);
  }
  if (task.pr_number !== null) {
    lines.push(`PR #:        ${task.pr_number}`);
  }
  if (task.issue_number !== null) {
    lines.push(`Issue:       #${task.issue_number}`);
  }
  if (task.task_description) {
    lines.push(`Description: ${task.task_description}`);
  }
  lines.push(`Branch:      ${task.branch_name}`);
  if (task.max_turns !== null) {
    lines.push(`Max Turns:   ${task.max_turns}`);
  }
  if (task.max_budget_usd !== null) {
    lines.push(`Max Budget:  $${task.max_budget_usd}`);
  }
  if (task.session_id) {
    lines.push(`Session:     ${task.session_id}`);
  }
  if (task.pr_url) {
    lines.push(`PR:          ${task.pr_url}`);
  }
  if (task.error_message) {
    lines.push(`Error:       ${task.error_message}`);
  }
  lines.push(`Created:     ${task.created_at}`);
  if (task.started_at) {
    lines.push(`Started:     ${task.started_at}`);
  }
  if (task.completed_at) {
    lines.push(`Completed:   ${task.completed_at}`);
  }
  if (task.duration_s !== null) {
    lines.push(`Duration:    ${task.duration_s}s`);
  }
  if (task.cost_usd != null) {
    lines.push(`Cost:        $${Number(task.cost_usd).toFixed(4)}`);
  }
  if (task.build_passed !== null) {
    lines.push(`Build:       ${task.build_passed ? 'PASSED' : 'FAILED'}`);
  }
  return lines.join('\n');
}

/** Format a list of TaskSummary as an aligned table. */
export function formatTaskList(tasks: TaskSummary[]): string {
  if (tasks.length === 0) {
    return 'No tasks found.';
  }

  const headers = ['TASK ID', 'STATUS', 'REPO', 'CREATED', 'DESCRIPTION'];
  const rows = tasks.map(t => {
    let desc = t.task_description || (t.issue_number !== null ? `#${t.issue_number}` : '-');
    if (t.task_type === 'pr_iteration' && t.pr_number !== null) {
      desc = `PR #${t.pr_number}` + (t.task_description ? `: ${t.task_description}` : '');
    }
    return [
      t.task_id,
      t.status,
      t.repo,
      t.created_at,
      truncate(desc, 40),
    ];
  });

  return formatTable(headers, rows);
}

/** Format task events as a timeline. */
export function formatEvents(events: TaskEvent[]): string {
  if (events.length === 0) {
    return 'No events found.';
  }

  const headers = ['TIMESTAMP', 'EVENT TYPE', 'METADATA'];
  const rows = events.map(e => [
    e.timestamp,
    e.event_type,
    Object.keys(e.metadata).length > 0 ? JSON.stringify(e.metadata) : '',
  ]);

  return formatTable(headers, rows);
}

/** Format a newly created webhook (includes the one-time secret). */
export function formatWebhookCreated(res: CreateWebhookResponse): string {
  return [
    `Webhook:     ${res.webhook_id}`,
    `Name:        ${res.name}`,
    `Created:     ${res.created_at}`,
    '',
    'Secret (store securely — shown only once):',
    res.secret,
  ].join('\n');
}

/** Format a list of WebhookDetail as an aligned table. */
export function formatWebhookList(webhooks: WebhookDetail[]): string {
  if (webhooks.length === 0) {
    return 'No webhooks found.';
  }

  const headers = ['WEBHOOK ID', 'NAME', 'STATUS', 'CREATED'];
  const rows = webhooks.map(w => [
    w.webhook_id,
    w.name,
    w.status,
    w.created_at,
  ]);

  return formatTable(headers, rows);
}

/** Format a WebhookDetail as a key-value detail view. */
export function formatWebhookDetail(webhook: WebhookDetail): string {
  const lines: string[] = [
    `Webhook:     ${webhook.webhook_id}`,
    `Name:        ${webhook.name}`,
    `Status:      ${webhook.status}`,
    `Created:     ${webhook.created_at}`,
    `Updated:     ${webhook.updated_at}`,
  ];
  if (webhook.revoked_at) {
    lines.push(`Revoked:     ${webhook.revoked_at}`);
  }
  return lines.join('\n');
}

/** Format data as JSON. */
export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] || '').length)),
  );

  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  const separator = widths.map(w => '-'.repeat(w)).join('  ');
  const dataLines = rows.map(row =>
    row.map((cell, i) => (cell || '').padEnd(widths[i])).join('  '),
  );

  return [headerLine, separator, ...dataLines].join('\n');
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
