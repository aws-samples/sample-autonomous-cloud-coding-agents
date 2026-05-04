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

import { CreateWebhookResponse, TaskDetail, TaskEvent, TaskSummary, TERMINAL_STATUSES, WebhookDetail } from './types';

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
  if (task.trace_s3_uri) {
    lines.push(`Trace S3:    ${task.trace_s3_uri}`);
  }
  if (task.error_message) {
    lines.push(...formatErrorLines(task));
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

/**
 * Render the deterministic ``bgagent status`` snapshot described in
 * ``docs/design/INTERACTIVE_AGENTS.md`` §5.2.
 *
 * Pure function: takes the task detail, a small window of recent events
 * (newest first), and an anchor ``now`` so callers can freeze time in
 * tests. Never calls an LLM and never fabricates state — every rendered
 * field is either read directly from ``task`` / ``events`` or is a
 * simple relative-time derivation.
 *
 * Degrades gracefully when fields are missing (just-submitted task, no
 * events yet, no cost recorded) by emitting a placeholder (``—``) rather
 * than ``undefined`` or ``NaN``. This is the contract users rely on when
 * calling ``status`` repeatedly during a task's lifetime.
 *
 * @param task - the task detail from ``GET /tasks/{id}``.
 * @param events - up to N recent events, ordered newest-first.
 * @param now - the reference time for relative durations (epoch ms).
 *   Defaults to ``Date.now()`` in production; tests pass a fixed value.
 */
export function formatStatusSnapshot(
  task: TaskDetail,
  events: readonly TaskEvent[],
  now: number = Date.now(),
): string {
  // Defensive sort. The server contract (``?desc=1`` on
  // ``GET /tasks/{id}/events``) returns newest-first, and every helper
  // below relies on ``events[0]`` being the most recent event. If that
  // invariant is ever violated upstream — a GSI reconfig, a middleware
  // reorder, a caller wiring the formatter to a different endpoint — a
  // front-to-back walk would silently render the *oldest* tool call as
  // "Current" with no user-visible signal. ULIDs are lexicographically
  // time-sortable, so a descending ``localeCompare`` is always correct.
  const sorted = [...events].sort((a, b) => b.event_id.localeCompare(a.event_id));

  const header = `Task ${task.task_id} — ${task.status} (${elapsedDescription(task, now)})`;

  const milestoneEvent = findLatest(sorted, 'agent_milestone');
  const lastCostEvent = findLatest(sorted, 'agent_cost_update');
  const lastTurnEvent = findLatest(sorted, 'agent_turn');
  const lastActivityEvent = findLatestActivity(sorted);

  // ``TaskEvent.timestamp`` is typed ``string``, but the event table is
  // weakly typed at the storage layer — an agent regression could write
  // a row without a valid timestamp. Guard so a missing field renders
  // as the placeholder rather than the literal ``undefined``.
  const lastEventTs = sorted[0]?.timestamp;
  const lastEventLine = typeof lastEventTs === 'string' && lastEventTs.length > 0
    ? lastEventTs
    : PLACEHOLDER;

  const lines: string[] = [
    header,
    `  Repo:          ${task.repo}`,
    `  Turn:          ${describeTurn(task, lastTurnEvent)}`,
    `  Last milestone: ${describeMilestone(milestoneEvent, now)}`,
    `  Current:       ${describeCurrent(task, lastActivityEvent)}`,
    `  Cost:          ${describeCost(task, lastCostEvent)}`,
  ];
  if (task.trace_s3_uri) {
    lines.push(`  Trace S3:      ${task.trace_s3_uri}`);
  }
  lines.push(`  Last event:    ${lastEventLine}`);

  return lines.join('\n');
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

function formatErrorLines(task: TaskDetail): string[] {
  if (!task.error_classification) {
    return [`Error:       ${task.error_message}`];
  }
  const { category, title, description, remedy, retryable } = task.error_classification;
  return [
    `Error:       [${category.toUpperCase()}] ${title}`,
    `             ${description}`,
    `  Remedy:    ${remedy}`,
    `  Retryable: ${retryable ? 'yes' : 'no'}`,
    `  Detail:    ${task.error_message}`,
  ];
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

// -- status-snapshot helpers --------------------------------------------------

const PLACEHOLDER = '—';

function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

function elapsedDescription(task: TaskDetail, now: number): string {
  // Prefer the authoritative SDK-reported duration once the task has
  // landed terminal — it accounts for clock drift between the orchestrator
  // and agent. Fall back to ``completed_at - started_at`` so the status
  // snapshot still renders something sensible if ``duration_s`` is missing.
  if (isTerminalStatus(task.status) && task.duration_s != null) {
    return `${humanizeSeconds(task.duration_s)} total`;
  }
  const start = task.started_at ?? task.created_at;
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) return PLACEHOLDER;
  const endMs = task.completed_at ? Date.parse(task.completed_at) : now;
  if (Number.isNaN(endMs)) return PLACEHOLDER;
  const diffS = Math.max(0, Math.round((endMs - startMs) / 1000));
  return `${humanizeSeconds(diffS)} elapsed`;
}

function describeTurn(task: TaskDetail, turnEvent: TaskEvent | null): string {
  // Prefer the live ``turn`` from the most recent ``agent_turn`` event
  // over the persisted ``turns_attempted`` — the former updates mid-task
  // (the latter is written on terminal completion in most paths).
  const liveTurn = readNumberField(turnEvent?.metadata, 'turn');
  const currentTurn = liveTurn ?? task.turns_attempted ?? null;
  const maxTurns = task.max_turns ?? null;
  if (currentTurn == null && maxTurns == null) return PLACEHOLDER;
  const left = currentTurn == null ? PLACEHOLDER : String(currentTurn);
  const right = maxTurns == null ? PLACEHOLDER : String(maxTurns);
  return `${left} / ~${right}`;
}

function describeMilestone(milestoneEvent: TaskEvent | null, now: number): string {
  if (!milestoneEvent) return PLACEHOLDER;
  const name = readStringField(milestoneEvent.metadata, 'milestone') ?? 'milestone';
  const ago = relativeTime(milestoneEvent.timestamp, now);
  return ago ? `${name} (${ago} ago)` : name;
}

function describeCurrent(task: TaskDetail, activity: TaskEvent | null): string {
  if (isTerminalStatus(task.status)) {
    return `task ${task.status.toLowerCase()}`;
  }
  if (!activity) return PLACEHOLDER;
  if (activity.event_type === 'agent_tool_call') {
    const toolName = readStringField(activity.metadata, 'tool_name') ?? 'tool';
    return `${toolName} tool call`;
  }
  if (activity.event_type === 'agent_turn') {
    const turn = readNumberField(activity.metadata, 'turn');
    return turn != null ? `agent turn ${turn}` : 'agent turn';
  }
  return activity.event_type;
}

function describeCost(task: TaskDetail, costEvent: TaskEvent | null): string {
  const liveCost = readNumberField(costEvent?.metadata, 'cost_usd');
  const cost = liveCost ?? task.cost_usd ?? null;
  const budget = task.max_budget_usd ?? null;
  const costStr = cost == null ? PLACEHOLDER : `$${cost.toFixed(2)}`;
  const budgetStr = budget == null ? PLACEHOLDER : `$${budget.toFixed(2)}`;
  return `${costStr} / budget ${budgetStr}`;
}

function findLatest(events: readonly TaskEvent[], eventType: string): TaskEvent | null {
  // ``events`` is newest-first; the first match is the latest one.
  for (const e of events) {
    if (e.event_type === eventType) return e;
  }
  return null;
}

function findLatestActivity(events: readonly TaskEvent[]): TaskEvent | null {
  for (const e of events) {
    if (e.event_type === 'agent_tool_call' || e.event_type === 'agent_turn') {
      return e;
    }
  }
  return null;
}

// ``TaskEvent.metadata`` is non-optional, but callers routinely pass
// ``event?.metadata`` where ``event`` may itself be ``null`` (no matching
// event found). The ``!meta`` guard handles that path — do not remove as
// "dead" without also auditing every callsite.
function readStringField(meta: Record<string, unknown> | undefined, key: string): string | null {
  if (!meta) return null;
  const v = meta[key];
  return typeof v === 'string' ? v : null;
}

function readNumberField(meta: Record<string, unknown> | undefined, key: string): number | null {
  if (!meta) return null;
  const v = meta[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Compact relative time like "42s", "3m 14s", "1h 02m". Returns null if
 * the timestamp does not parse — callers fall back to a placeholder.
 */
function relativeTime(isoTimestamp: string, now: number): string | null {
  const t = Date.parse(isoTimestamp);
  if (Number.isNaN(t)) return null;
  const diffS = Math.max(0, Math.round((now - t) / 1000));
  return humanizeSeconds(diffS);
}

function humanizeSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${String(remMin).padStart(2, '0')}m`;
}
