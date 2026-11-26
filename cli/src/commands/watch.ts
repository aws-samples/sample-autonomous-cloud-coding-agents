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

import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { debug, isVerbose } from '../debug';
import { CliError } from '../errors';
import { COST_USD_DECIMALS, formatJson } from '../format';
import { abortableSleep, isTransientError, transientRetryDelayMs } from '../retry';
import { TERMINAL_STATUSES, TaskDetail, TaskEvent, TaskStatusType } from '../types';
import { EXIT_CODE_WAIT_ABORTED, exitCodeForStatus } from '../wait';

const POLL_FAST_INTERVAL_MS = 500;
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- the ladder IS the named constant
const BACKOFF_INTERVALS_MS: readonly number[] = [1_000, 2_000, 5_000];

interface PollCadenceState {
  intervalMs: number;
  consecutiveEmptyPolls: number;
}

export function nextCadence(state: PollCadenceState, sawEvents: boolean): PollCadenceState {
  if (sawEvents) {
    return { intervalMs: POLL_FAST_INTERVAL_MS, consecutiveEmptyPolls: 0 };
  }
  const nextEmpty = state.consecutiveEmptyPolls + 1;
  const idx = Math.min(nextEmpty - 1, BACKOFF_INTERVALS_MS.length - 1);
  return { intervalMs: BACKOFF_INTERVALS_MS[idx], consecutiveEmptyPolls: nextEmpty };
}

const MAX_TRANSIENT_RETRIES = 5;

let sessionRetries = 0;
let flapWarnEmitted = false;

const SESSION_FLAP_THRESHOLD = 10;

export function _getSessionRetries(): number {
  return sessionRetries;
}

export function _resetSessionRetries(): void {
  sessionRetries = 0;
  flapWarnEmitted = false;
}

const EXIT_CODE_SIGINT = 130;
const SNAPSHOT_PAGE_SIZE = 100;

const PROGRESS_EVENT_TYPES = new Set([
  'agent_turn',
  'agent_tool_call',
  'agent_tool_result',
  'agent_milestone',
  'agent_cost_update',
  'agent_error',
  'agent_blocked',
]);

function formatTime(isoTimestamp: string): string {
  try {
    const date = new Date(isoTimestamp);
    return date.toLocaleTimeString();
  } catch {
    return isoTimestamp;
  }
}

const MILESTONE_NOISE_KEYS = new Set(['milestone', 'details']);

function renderMilestoneSuffix(meta: Record<string, unknown>): string {
  const details = meta.details;
  if (typeof details === 'string' && details.length > 0) {
    return `: ${details}`;
  }

  const parts: string[] = [];
  if (meta.severity != null) parts.push(`[sev=${String(meta.severity)}]`);
  if (meta.request_id != null) parts.push(`request_id=${String(meta.request_id)}`);
  if (meta.scope != null) parts.push(`scope=${String(meta.scope)}`);
  if (meta.timeout_s != null) parts.push(`timeout=${String(meta.timeout_s)}s`);
  const ruleIds = meta.matching_rule_ids;
  if (Array.isArray(ruleIds) && ruleIds.length > 0) {
    parts.push(`rules=${ruleIds.map(String).join(',')}`);
  }
  if (parts.length > 0) {
    return ` ${parts.join(' ')}`;
  }

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!MILESTONE_NOISE_KEYS.has(k)) rest[k] = v;
  }
  if (Object.keys(rest).length > 0) {
    return ` ${JSON.stringify(rest)}`;
  }
  return '';
}

export function renderEvent(event: TaskEvent): string {
  const time = formatTime(event.timestamp);
  const meta = event.metadata;

  switch (event.event_type) {
    case 'agent_turn': {
      const turn = meta.turn ?? '?';
      const model = meta.model ?? '';
      const tools = meta.tool_calls_count ?? 0;
      let line = `[${time}] Turn #${turn} (${model}, ${tools} tool call${tools === 1 ? '' : 's'})`;
      if (meta.thinking_preview) {
        line += `\n         Thinking: ${meta.thinking_preview}`;
      }
      if (meta.text_preview) {
        line += `\n         Text: ${meta.text_preview}`;
      }
      return line;
    }
    case 'agent_tool_call': {
      const tool = meta.tool_name ?? 'unknown';
      const preview = meta.tool_input_preview ?? '';
      return `[${time}]   ▶ ${tool}: ${preview}`;
    }
    case 'agent_tool_result': {
      const tool = meta.tool_name ?? '';
      const isError = meta.is_error ? ' [ERROR]' : '';
      const preview = meta.content_preview ?? '';
      return `[${time}]   ◀ ${tool}${isError}: ${preview}`;
    }
    case 'agent_milestone': {
      const milestone = String(meta.milestone ?? '');
      return `[${time}] ★ ${milestone}${renderMilestoneSuffix(meta)}`;
    }
    case 'agent_cost_update': {
      const cost = meta.cost_usd != null ? `$${Number(meta.cost_usd).toFixed(COST_USD_DECIMALS)}` : '$?';
      const input = meta.input_tokens ?? 0;
      const output = meta.output_tokens ?? 0;
      return `[${time}] Cost: ${cost} (${input} in / ${output} out tokens)`;
    }
    case 'agent_error': {
      const errType = meta.error_type ?? 'Error';
      const msg = meta.message_preview ?? '';
      return `[${time}] ✖ ${errType}: ${msg}`;
    }
    case 'agent_blocked': {
      const kind = String(meta.kind ?? 'unknown_environmental');
      const resource = meta.resource != null ? ` [${String(meta.resource)}]` : '';
      const detail = meta.detail ? `: ${String(meta.detail)}` : '';
      let line = `[${time}] ⛔ BLOCKED (${kind})${resource}${detail}`;
      if (meta.remediation_hint) {
        line += `\n         ↳ ${String(meta.remediation_hint)}`;
      }
      return line;
    }
    default:
      return `[${time}] ${event.event_type}: ${JSON.stringify(meta)}`;
  }
}

function logInfo(_isJson: boolean, message: string): void {
  process.stderr.write(`${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`ERROR: ${message}\n`);
}

/**
 * Render the terminal-line message shown when a watch session ends
 * because the task reached a terminal state. Includes the task_id
 * and, for non-COMPLETED terminals, a short failure-classification
 * hint.
 */
export function formatTerminalMessage(task: Pick<TaskDetail, 'task_id' | 'status' | 'error_classification' | 'error_message'>): string {
  const status = task.status.toLowerCase();
  const prefix = `Task ${task.task_id} ${status}.`;
  if (task.status === 'COMPLETED') return prefix;
  const cls = task.error_classification;
  const msg = task.error_message?.trim();
  if (cls && cls.category !== 'unknown') {
    if (msg) {
      const firstLine = msg.split(/\r?\n/, 1)[0];
      return `${prefix} ${cls.category}: ${cls.title} — ${firstLine}`;
    }
    return `${prefix} ${cls.category}: ${cls.title}`;
  }
  if (msg) return `${prefix} ${msg}`;
  if (cls) return `${prefix} ${cls.category}: ${cls.title}`;
  return prefix;
}

interface Formatter {
  emit(ev: TaskEvent): void;
}

function makeFormatter(isJson: boolean): Formatter {
  return {
    emit(ev: TaskEvent): void {
      if (isJson) {
        console.log(formatJson(ev));
        return;
      }
      if (PROGRESS_EVENT_TYPES.has(ev.event_type)) {
        console.log(renderEvent(ev));
      }
    },
  };
}

interface PollOptions {
  readonly signal: AbortSignal;
  readonly afterEventId?: string;
  readonly onEvent: (ev: TaskEvent) => void;
  readonly onTerminal: (finalTask: TaskDetail) => void;
}

async function pollTaskEvents(
  apiClient: ApiClient,
  taskId: string,
  options: PollOptions,
): Promise<void> {
  let lastSeenEventId: string | null = options.afterEventId ?? null;
  let cadence: PollCadenceState = { intervalMs: POLL_FAST_INTERVAL_MS, consecutiveEmptyPolls: 0 };
  debug(`[watch/poll] starting polling loop afterEventId=${lastSeenEventId ?? '<none>'}`);

  while (!options.signal.aborted) {
    const newEvents = await withTransientRetry(
      () => (lastSeenEventId
        ? apiClient.catchUpEvents(taskId, lastSeenEventId, { signal: options.signal })
        : apiClient.getTaskEvents(taskId, { limit: 100, signal: options.signal })
          .then(r => r.data)),
      options.signal,
      'getTaskEvents',
    );

    if (options.signal.aborted) return;

    if (newEvents.length > 0) {
      lastSeenEventId = newEvents[newEvents.length - 1].event_id;
      debug(`[watch/poll] emitting ${newEvents.length} new events, advanced cursor to ${lastSeenEventId}`);
      for (const ev of newEvents) {
        options.onEvent(ev);
      }
    }

    const task = await withTransientRetry(
      () => apiClient.getTask(taskId, { signal: options.signal }),
      options.signal,
      'getTask',
    );

    if (options.signal.aborted) return;

    if (TERMINAL_STATUSES.includes(task.status)) {
      debug(`[watch/poll] task reached terminal status=${task.status}`);
      options.onTerminal(task);
      return;
    }

    cadence = nextCadence(cadence, newEvents.length > 0);
    debug(`[watch/poll] cadence=${cadence.intervalMs}ms emptyPolls=${cadence.consecutiveEmptyPolls}`);
    await abortableSleep(cadence.intervalMs, options.signal);
  }
}

async function withTransientRetry<T>(
  op: () => Promise<T>,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await op();
    } catch (err) {
      if (signal.aborted) throw err;
      if (!isTransientError(err)) {
        debug(`[watch/retry] ${label}: non-transient error, propagating: ${String(err)}`);
        throw err;
      }
      attempt += 1;
      sessionRetries += 1;
      if (sessionRetries >= SESSION_FLAP_THRESHOLD && !flapWarnEmitted) {
        flapWarnEmitted = true;
        process.stderr.write(
          `[watch] upstream is flapping — ${sessionRetries} retries so far; results may be delayed\n`,
        );
      }
      if (attempt > MAX_TRANSIENT_RETRIES) {
        const e = err instanceof Error ? err : new Error(String(err));
        throw new CliError(
          `Exceeded retry budget after ${attempt} transient failures `
          + `(${label}): ${e.message}. Re-run \`bgagent watch <id>\` to resume.`,
          EXIT_CODE_WAIT_ABORTED,
        );
      }
      const delayMs = transientRetryDelayMs(attempt);
      debug(`[watch/retry] ${label}: attempt ${attempt}/${MAX_TRANSIENT_RETRIES} after ${delayMs}ms`);
      await abortableSleep(delayMs, signal);
    }
  }
}

interface SnapshotResult {
  readonly latestEventId: string | null;
  readonly events: TaskEvent[];
  readonly taskStatus: TaskStatusType;
}

async function fetchInitialSnapshot(
  apiClient: ApiClient,
  taskId: string,
  opts: { signal: AbortSignal },
): Promise<SnapshotResult> {
  debug(`[watch/snapshot] fetching initial snapshot task=${taskId}`);
  const { signal } = opts;
  const [eventsPage, task] = await Promise.all([
    withTransientRetry(
      () => apiClient.getTaskEvents(taskId, { limit: SNAPSHOT_PAGE_SIZE, signal }),
      signal,
      'initialSnapshot.getTaskEvents',
    ),
    withTransientRetry(
      () => apiClient.getTask(taskId, { signal }),
      signal,
      'initialSnapshot.getTask',
    ),
  ]);
  const events = eventsPage.data;
  const latestEventId = events.length > 0 ? events[events.length - 1].event_id : null;
  debug(
    `[watch/snapshot] events=${events.length} latestEventId=${latestEventId ?? '<none>'} `
    + `status=${task.status}`,
  );
  return { latestEventId, events, taskStatus: task.status };
}

export function makeWatchCommand(): Command {
  return new Command('watch')
    .description('Watch task progress in real-time')
    .argument('<task-id>', 'Task ID')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action(async (taskId: string, opts) => {
      const isJson = opts.output === 'json';
      const apiClient = new ApiClient();

      debug(`[watch] task=${taskId} isJson=${isJson} verbose=${isVerbose()}`);

      const abortController = new AbortController();
      const onSignal = (): void => {
        debug('[watch] SIGINT/SIGTERM received, aborting');
        abortController.abort();
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);

      try {
        let snapshot: SnapshotResult;
        try {
          snapshot = await fetchInitialSnapshot(apiClient, taskId, { signal: abortController.signal });
        } catch (err) {
          const wasUserAborted = abortController.signal.aborted;
          abortController.abort();

          const isAbortError = err instanceof Error && err.name === 'AbortError';
          if (isAbortError && wasUserAborted) {
            process.exitCode = EXIT_CODE_SIGINT;
            return;
          }
          const e = err instanceof Error ? err : new Error(String(err));
          logError(`Initial snapshot failed: ${e.message}`);
          throw e;
        }

        const formatter = makeFormatter(isJson);

        if (TERMINAL_STATUSES.includes(snapshot.taskStatus)) {
          debug(`[watch] task already terminal status=${snapshot.taskStatus} — printing tail`);
          for (const ev of snapshot.events) {
            formatter.emit(ev);
          }
          if (!isJson) {
            let terminalTask: Pick<TaskDetail, 'task_id' | 'status' | 'error_classification' | 'error_message'> = {
              task_id: taskId,
              status: snapshot.taskStatus,
              error_classification: null,
              error_message: null,
            };
            try {
              terminalTask = await withTransientRetry(
                () => apiClient.getTask(taskId, { signal: abortController.signal }),
                abortController.signal,
                'alreadyTerminal.getTask',
              );
            } catch (err) {
              debug(`[watch] already-terminal getTask failed — printing minimal message: ${String(err)}`);
            }
            logInfo(isJson, formatTerminalMessage(terminalTask));
          }
          process.exitCode = exitCodeForStatus(snapshot.taskStatus);
          return;
        }

        for (const ev of snapshot.events) {
          formatter.emit(ev);
        }
        const seedCursor = snapshot.latestEventId ?? '';

        if (!isJson) {
          logInfo(isJson, `Watching task ${taskId}... (Ctrl+C to stop)`);
        }

        await runPolling(apiClient, taskId, seedCursor, formatter, abortController.signal, isJson);
      } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
    });
}

async function runPolling(
  apiClient: ApiClient,
  taskId: string,
  seedCursor: string,
  formatter: Formatter,
  signal: AbortSignal,
  isJson: boolean,
): Promise<void> {
  debug(`[watch/poll] runPolling seedCursor=${seedCursor || '<none>'}`);
  let finalTask: TaskDetail | null = null;

  await pollTaskEvents(apiClient, taskId, {
    signal,
    afterEventId: seedCursor || undefined,
    onEvent: (ev) => formatter.emit(ev),
    onTerminal: (task) => { finalTask = task; },
  });

  if (signal.aborted) {
    logInfo(isJson, 'Aborted.');
    process.exitCode = EXIT_CODE_SIGINT;
    return;
  }

  if (finalTask !== null) {
    const task = finalTask as TaskDetail;
    if (!isJson) {
      logInfo(isJson, formatTerminalMessage(task));
    }
    process.exitCode = exitCodeForStatus(task.status);
  }
}
