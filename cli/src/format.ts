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

import { ApiKeyDetail, CreateApiKeyResponse, CreateWebhookResponse, DEFAULT_CODING_WORKFLOW_ID, PaginatedResponse, ReplayBundle, TaskDetail, TaskEvent, TaskSummary, TERMINAL_STATUSES, WebhookDetail } from './types';

export const COST_USD_DECIMALS = 4;

function formatCostUsd(cost: number | string): string {
  return `$${Number(cost).toFixed(COST_USD_DECIMALS)}`;
}

function formatVerdict(passed: boolean | null, dash = '—'): string {
  return passed === null ? dash : passed ? 'PASSED' : 'FAILED';
}

/**
 * Format a TaskDetail as a key-value detail view.
 *
 * @param task - the task detail from ``GET /tasks/{id}``.
 * @param now - reference time for relative durations (epoch ms).
 */
export function formatTaskDetail(task: TaskDetail, now: number = Date.now()): string {
  const lines: string[] = [
    `Task:        ${task.task_id}`,
    `Status:      ${task.status}`,
    `Repo:        ${task.repo ?? '— (repo-less)'}`,
  ];
  if (task.resolved_workflow && task.resolved_workflow.id !== DEFAULT_CODING_WORKFLOW_ID) {
    lines.push(`Workflow:    ${task.resolved_workflow.id}`);
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
  if (task.branch_name) {
    lines.push(`Branch:      ${task.branch_name}`);
  }
  if (task.status === 'QUEUED' && task.queue_position !== null) {
    lines.push(`Queue:       position ${task.queue_position}${formatQueueEta(task.estimated_wait_s)}`);
  }
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
  if (task.artifact_uri) {
    lines.push(`Artifact:    ${task.artifact_uri}`);
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
  const heartbeat = liveHeartbeat(task);
  if (heartbeat) {
    lines.push(`Heartbeat:   ${heartbeat} (${heartbeatAge(heartbeat, now)})`);
  }
  if (task.duration_s !== null) {
    lines.push(`Duration:    ${task.duration_s}s`);
  }
  if (task.cost_usd != null) {
    lines.push(`Cost:        ${formatCostUsd(task.cost_usd)}`);
  }
  if (task.build_passed !== null) {
    lines.push(`Build:       ${formatVerdict(task.build_passed)}`);
  }
  return lines.join('\n');
}

function formatQueueEta(estimatedWaitS: number | null): string {
  if (estimatedWaitS === null || !Number.isFinite(estimatedWaitS)) {
    return '';
  }
  const minutes = Math.max(1, Math.round(estimatedWaitS / 60));
  return ` (est. wait ~${minutes}m)`;
}

/**
 * Format a list of TaskSummary as an aligned table.
 *
 * @param tasks - the summaries from ``GET /v1/tasks``.
 * @param now - reference time for the HEARTBEAT column's relative age (epoch ms).
 */
export function formatTaskList(tasks: TaskSummary[], now: number = Date.now()): string {
  if (tasks.length === 0) {
    return 'No tasks found.';
  }

  const headers = ['TASK ID', 'STATUS', 'REPO', 'CREATED', 'HEARTBEAT', 'DESCRIPTION'];
  const rows = tasks.map(t => {
    let desc = t.task_description || (t.issue_number !== null ? `#${t.issue_number}` : '-');
    if (t.resolved_workflow?.id === 'coding/pr-iteration-v1' && t.pr_number !== null) {
      desc = `PR #${t.pr_number}` + (t.task_description ? `: ${t.task_description}` : '');
    }
    const heartbeat = liveHeartbeat(t);
    return [
      t.task_id,
      t.status,
      t.repo ?? '—',
      t.created_at,
      heartbeat ? `${heartbeatAge(heartbeat, now)} ago` : PLACEHOLDER,
      truncate(desc, DESCRIPTION_COLUMN_WIDTH),
    ];
  });

  return formatTable(headers, rows);
}

/**
 * Render the deterministic ``bgagent status`` snapshot described in
 * ``docs/design/INTERACTIVE_AGENTS.md`` §5.2.
 *
 * Degrades gracefully when fields are missing (just-submitted task, no
 * events yet, no cost recorded) by emitting a placeholder (``—``) rather
 * than ``undefined`` or ``NaN``.
 *
 * @param task - the task detail from ``GET /tasks/{id}``.
 * @param events - up to N recent events, ordered newest-first.
 * @param now - the reference time for relative durations (epoch ms).
 */
export function formatStatusSnapshot(
  task: TaskDetail,
  events: readonly TaskEvent[],
  now: number = Date.now(),
): string {
  // ULIDs are lexicographically time-sortable.
  const sorted = [...events].sort((a, b) => b.event_id.localeCompare(a.event_id));

  const header = `Task ${task.task_id} — ${task.status} (${elapsedDescription(task, now)})`;

  const milestoneEvent = findLatest(sorted, 'agent_milestone');
  const lastCostEvent = findLatest(sorted, 'agent_cost_update');
  const lastTurnEvent = findLatest(sorted, 'agent_turn');
  const lastActivityEvent = findLatestActivity(sorted);
  const blockerEvent = findLatest(sorted, 'agent_blocked');

  const lastEventTs = sorted[0]?.timestamp;
  const lastEventLine = typeof lastEventTs === 'string' && lastEventTs.length > 0
    ? lastEventTs
    : PLACEHOLDER;

  const lines: string[] = [
    header,
    `  Repo:          ${task.repo ?? '— (repo-less)'}`,
    `  Channel:       ${task.channel_source || PLACEHOLDER}`,
  ];
  if (task.resolved_workflow && task.resolved_workflow.id !== DEFAULT_CODING_WORKFLOW_ID) {
    const prSuffix = task.pr_number !== null ? ` (PR #${task.pr_number})` : '';
    lines.push(`  Workflow:      ${task.resolved_workflow.id}${prSuffix}`);
  }
  if (task.task_description) {
    lines.push(...formatDescriptionLines(task.task_description));
  }
  if (task.status === 'QUEUED' && task.queue_position !== null) {
    lines.push(`  Queue:         position ${task.queue_position}${formatQueueEta(task.estimated_wait_s)}`);
  }
  lines.push(
    `  Turn:          ${describeTurn(task, lastTurnEvent)}`,
    `  Last milestone: ${describeMilestone(milestoneEvent, now)}`,
    `  Current:       ${describeCurrent(task, lastActivityEvent)}`,
    `  Cost:          ${describeCost(task, lastCostEvent)}`,
  );
  const blockerLine = task.status === 'COMPLETED' ? null : describeBlocker(blockerEvent, now);
  if (blockerLine !== null) {
    lines.push(`  Blocker:       ${blockerLine}`);
  }
  const reasonLine = describeReason(task);
  if (reasonLine !== null) {
    lines.push(`  Reason:        ${reasonLine}`);
  }
  if (task.pr_url) {
    lines.push(`  PR:            ${task.pr_url}`);
  }
  if (task.trace_s3_uri) {
    lines.push(`  Trace S3:      ${task.trace_s3_uri}`);
  }
  if (task.artifact_uri) {
    lines.push(`  Artifact:      ${task.artifact_uri}`);
  }
  const heartbeat = liveHeartbeat(task);
  if (heartbeat) {
    const age = relativeTime(heartbeat, now) ?? PLACEHOLDER;
    lines.push(`  Heartbeat:     ${age} ago`);
  }
  lines.push(`  Last event:    ${lastEventLine}`);

  return lines.join('\n');
}

const DESCRIPTION_WRAP_WIDTH = 60;

function formatDescriptionLines(description: string): string[] {
  const label = '  Description:   ';
  const indent = ' '.repeat(label.length);
  const words = description.trim().split(/\s+/);
  if (words.length === 0 || (words.length === 1 && words[0] === '')) return [];

  const wrapped: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= DESCRIPTION_WRAP_WIDTH) {
      current += ' ' + word;
    } else {
      wrapped.push(current);
      current = word;
    }
  }
  if (current.length > 0) wrapped.push(current);

  return wrapped.map((line, i) => (i === 0 ? label + line : indent + line));
}

function describeReason(task: TaskDetail): string | null {
  if (task.status === 'COMPLETED') return null;
  if (!TERMINAL_STATUSES.includes(task.status)) return null;
  const cls = task.error_classification;
  const msg = task.error_message?.trim();
  if (cls && cls.category !== 'unknown') {
    if (msg) {
      const firstLine = msg.split(/\r?\n/, 1)[0];
      return `${cls.category}: ${cls.title} — ${firstLine}`;
    }
    return `${cls.category}: ${cls.title}`;
  }
  if (msg) return msg;
  if (cls) return `${cls.category}: ${cls.title}`;
  return null;
}

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
  const lines = [
    `Webhook:     ${res.webhook_id}`,
    `Name:        ${res.name}`,
    `Created:     ${res.created_at}`,
  ];
  if (res.webhook_url) {
    lines.push(
      `URL:         ${res.webhook_url}`,
      '             (the endpoint to enter in the webhook settings of the external system)',
    );
  }
  lines.push('', 'Secret (store securely — shown only once):', res.secret);
  return lines.join('\n');
}

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

/** Format a newly created API key (includes the one-time key material). */
export function formatApiKeyCreated(res: CreateApiKeyResponse): string {
  return [
    `Key ID:      ${res.key_id}`,
    `Name:        ${res.name}`,
    `Scopes:      ${res.scopes.join(', ')}`,
    `Expires:     ${res.expires_at ?? 'never'}`,
    `Created:     ${res.created_at}`,
    '',
    'API key (store securely — shown only once):',
    res.key,
    '',
    'Use it with `--api-key <key>` or the BGAGENT_API_KEY environment variable.',
  ].join('\n');
}

export function formatApiKeyList(keys: ApiKeyDetail[]): string {
  if (keys.length === 0) {
    return 'No API keys found.';
  }

  const headers = ['KEY ID', 'NAME', 'SCOPES', 'STATUS', 'EXPIRES', 'CREATED'];
  const rows = keys.map(k => [
    k.key_id,
    k.name,
    k.scopes.join(','),
    k.status,
    k.expires_at ?? 'never',
    k.created_at,
  ]);

  return formatTable(headers, rows);
}

export function formatApiKeyDetail(key: ApiKeyDetail): string {
  const lines: string[] = [
    `Key ID:      ${key.key_id}`,
    `Name:        ${key.name}`,
    `Scopes:      ${key.scopes.join(', ')}`,
    `Status:      ${key.status}`,
    `Expires:     ${key.expires_at ?? 'never'}`,
    `Created:     ${key.created_at}`,
    `Updated:     ${key.updated_at}`,
  ];
  if (key.revoked_at) {
    lines.push(`Revoked:     ${key.revoked_at}`);
  }
  return lines.join('\n');
}

const DEFAULT_LIST_LIMIT = 20;

/**
 * The rows a `list` command prints: its first page and the pages that follow. A page can hold
 * fewer rows than asked for, or none, while more exist: next_token is followed until the rows
 * asked for are there or the list ends. Each further request asks only for the rows still
 * missing. `maxRequests` counts the first request too.
 */
export async function followPages<T>(
  first: PaginatedResponse<T>,
  limit: number | undefined,
  fetchNext: (rows: number, nextToken: string) => Promise<PaginatedResponse<T>>,
  maxRequests = 100,
): Promise<PaginatedResponse<T>> {
  const wanted = limit !== undefined && limit > 0 ? limit : DEFAULT_LIST_LIMIT;
  let result = first;
  for (let request = 1; request < maxRequests && result.data.length < wanted && result.pagination.next_token; request += 1) {
    const next = await fetchNext(wanted - result.data.length, result.pagination.next_token);
    result = { data: [...result.data, ...next.data], pagination: next.pagination };
  }
  return result;
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Format a replay bundle (#515) as a human-readable summary: the correlation
 * metadata as aligned key-value lines, then a compact chronological event list.
 * Use {@link formatJson} for the machine-readable form. Absent fields render as
 * ``—``.
 */
export function formatReplay(bundle: ReplayBundle): string {
  const dash = '—';
  const lines: string[] = [
    `Task:        ${bundle.task_id}`,
    `Workflow:    ${bundle.resolved_workflow ? `${bundle.resolved_workflow.id}@${bundle.resolved_workflow.version}` : (bundle.workflow_ref ?? dash)}`,
    `Prompt ver:  ${bundle.prompt_version ?? dash}`,
    `Cost:        ${bundle.cost_usd != null ? formatCostUsd(bundle.cost_usd) : dash}`,
    `OTEL trace:  ${bundle.otel_trace_id ?? dash}`,
    `Session:     ${bundle.session_id ?? dash}`,
    `Trace URI:   ${bundle.trace_uri ?? dash}`,
  ];
  if (bundle.verification) {
    const v = bundle.verification;
    lines.push(`Build:       ${formatVerdict(v.build_passed, dash)}`);
    lines.push(`Lint:        ${formatVerdict(v.lint_passed, dash)}`);
  } else {
    lines.push(`Verification: ${dash} (no gate result persisted)`);
  }
  lines.push(`Collected:   ${bundle.collected_at}`);
  lines.push('');
  const truncated = bundle.events_truncation;
  lines.push(`Events (${bundle.events.length}${truncated ? ', TRUNCATED' : ''}):`);
  if (bundle.events.length === 0) {
    lines.push('  (none)');
  } else {
    for (const e of bundle.events) {
      lines.push(`  ${e.timestamp}  ${e.event_type}`);
    }
  }
  if (truncated) {
    const cap = truncated.reason === 'max_bytes' ? 'size' : 'count';
    lines.push(`  … list clipped at the ${cap} cap — use \`bgagent events ${bundle.task_id}\` for the full feed.`);
  }
  return lines.join('\n');
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

const DESCRIPTION_COLUMN_WIDTH = 40;

const ELLIPSIS = '...';

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - ELLIPSIS.length) + ELLIPSIS;
}

const PLACEHOLDER = '—';

function elapsedDescription(task: TaskDetail, now: number): string {
  const start = task.started_at ?? task.created_at;
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) {
    if (TERMINAL_STATUSES.includes(task.status) && task.duration_s != null) {
      return `${humanizeSeconds(task.duration_s)} total`;
    }
    return PLACEHOLDER;
  }
  const endMs = task.completed_at ? Date.parse(task.completed_at) : now;
  if (Number.isNaN(endMs)) return PLACEHOLDER;
  const diffS = Math.max(0, Math.round((endMs - startMs) / 1000));
  const suffix = TERMINAL_STATUSES.includes(task.status) ? 'total' : 'elapsed';
  return `${humanizeSeconds(diffS)} ${suffix}`;
}

function describeTurn(task: TaskDetail, turnEvent: TaskEvent | null): string {
  const recorded = TERMINAL_STATUSES.includes(task.status) ? task.turns_completed : null;
  const currentTurn = recorded || readNumberField(turnEvent?.metadata, 'turn');
  const maxTurns = task.max_turns ?? null;
  if (currentTurn == null && maxTurns == null) return PLACEHOLDER;
  const left = currentTurn == null ? PLACEHOLDER : String(currentTurn);
  const right = maxTurns == null ? PLACEHOLDER : String(maxTurns);
  return `${left} / ${right}`;
}

function describeMilestone(milestoneEvent: TaskEvent | null, now: number): string {
  if (!milestoneEvent) return PLACEHOLDER;
  const name = readStringField(milestoneEvent.metadata, 'milestone') ?? 'milestone';
  const ago = relativeTime(milestoneEvent.timestamp, now);
  return ago ? `${name} (${ago} ago)` : name;
}

function describeBlocker(blockerEvent: TaskEvent | null, now: number): string | null {
  if (!blockerEvent) return null;
  const kind = readStringField(blockerEvent.metadata, 'kind') ?? 'unknown_environmental';
  const resource = readStringField(blockerEvent.metadata, 'resource');
  const hint = readStringField(blockerEvent.metadata, 'remediation_hint');
  const ago = relativeTime(blockerEvent.timestamp, now);
  let line = kind;
  if (resource) line += ` [${resource}]`;
  if (ago) line += ` (${ago} ago)`;
  if (hint) line += ` — ${hint}`;
  return line;
}

function describeCurrent(task: TaskDetail, activity: TaskEvent | null): string {
  if (TERMINAL_STATUSES.includes(task.status)) {
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

function liveHeartbeat(task: Pick<TaskSummary, 'status' | 'agent_heartbeat_at' | 'compute_type'>): string | null {
  if (TERMINAL_STATUSES.includes(task.status) || task.compute_type === 'ecs') return null;
  return task.agent_heartbeat_at;
}

function heartbeatAge(isoTimestamp: string, now: number): string {
  return relativeTime(isoTimestamp, now) ?? PLACEHOLDER;
}

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
