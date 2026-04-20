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
import {
  SemanticEvent,
  TaskEventRecord,
  agUiToSemantic,
  translateDbRowToAgUi,
} from '../ag-ui-translator';
import { ApiClient } from '../api-client';
import { getAuthToken } from '../auth';
import { loadConfig } from '../config';
import { debug, isVerbose } from '../debug';
import { CliError } from '../errors';
import { formatJson } from '../format';
import { AgUiEvent, runSseClient } from '../sse-client';
import { TERMINAL_STATUSES, TaskEvent } from '../types';

const POLL_INTERVAL_MS = 2_000;
/** Default stream timeout — 58 min, pre-empts AgentCore's 60-min streaming cap. */
const DEFAULT_STREAM_TIMEOUT_SECONDS = 3500;
/** Size of the initial snapshot fetch used to detect already-terminal tasks
 *  and seed the catch-up cursor. */
const SNAPSHOT_PAGE_SIZE = 100;

type Transport = 'sse' | 'polling' | 'auto';

/** Progress event types emitted by the agent ProgressWriter. */
const PROGRESS_EVENT_TYPES = new Set([
  'agent_turn',
  'agent_tool_call',
  'agent_tool_result',
  'agent_milestone',
  'agent_cost_update',
  'agent_error',
]);

/** Format an event timestamp to a short local time string. */
function formatTime(isoTimestamp: string): string {
  try {
    const date = new Date(isoTimestamp);
    return date.toLocaleTimeString();
  } catch {
    return isoTimestamp;
  }
}

/** Render a single progress event as a human-readable line. */
export function renderEvent(event: SemanticEvent | TaskEvent): string {
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
      return `[${time}]   \u25B6 ${tool}: ${preview}`;
    }
    case 'agent_tool_result': {
      const tool = meta.tool_name ?? '';
      const isError = meta.is_error ? ' [ERROR]' : '';
      const preview = meta.content_preview ?? '';
      return `[${time}]   \u25C0 ${tool}${isError}: ${preview}`;
    }
    case 'agent_milestone': {
      const milestone = meta.milestone ?? '';
      const details = meta.details ?? '';
      return `[${time}] \u2605 ${milestone}${details ? ': ' + details : ''}`;
    }
    case 'agent_cost_update': {
      const cost = meta.cost_usd != null ? `$${Number(meta.cost_usd).toFixed(4)}` : '$?';
      const input = meta.input_tokens ?? 0;
      const output = meta.output_tokens ?? 0;
      return `[${time}] Cost: ${cost} (${input} in / ${output} out tokens)`;
    }
    case 'agent_error': {
      const errType = meta.error_type ?? 'Error';
      const msg = meta.message_preview ?? '';
      return `[${time}] \u2716 ${errType}: ${msg}`;
    }
    default:
      return `[${time}] ${event.event_type}: ${JSON.stringify(meta)}`;
  }
}

/* ------------------------------------------------------------------------ */
/*  Structured logging helpers                                               */
/* ------------------------------------------------------------------------ */

/** Log an INFO-level message to stderr. Suppressed in JSON mode so stdout
 *  remains pure NDJSON. */
function logInfo(isJson: boolean, message: string): void {
  if (isJson) {
    process.stderr.write(`${message}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
}

/** Log a WARN-level message to stderr regardless of output mode. */
function logWarn(message: string): void {
  process.stderr.write(`WARN: ${message}\n`);
}

/** Log an ERROR-level message to stderr regardless of output mode. */
function logError(message: string): void {
  process.stderr.write(`ERROR: ${message}\n`);
}

/* ------------------------------------------------------------------------ */
/*  Formatter boundary (Option A)                                            */
/* ------------------------------------------------------------------------ */

/**
 * A formatter that accepts either AG-UI events (from SSE + catch-up) or
 * semantic events (from REST polling) and produces identical byte-for-byte
 * output regardless of transport. The SSE path calls {@link emitAgUi}; the
 * polling path calls {@link emitSemantic}.
 */
interface Formatter {
  emitAgUi(ev: AgUiEvent): void;
  emitSemantic(ev: SemanticEvent | TaskEvent): void;
}

function makeFormatter(isJson: boolean): Formatter {
  return {
    emitAgUi(ev: AgUiEvent): void {
      if (isJson) {
        // In JSON mode, emit the semantic form (matches Phase 1a output
        // schema) — pure NDJSON on stdout.
        const semantic = agUiToSemantic(ev);
        if (semantic) {
          console.log(formatJson(semantic));
        }
        return;
      }
      const semantic = agUiToSemantic(ev);
      if (semantic && PROGRESS_EVENT_TYPES.has(semantic.event_type)) {
        console.log(renderEvent(semantic));
      }
    },
    emitSemantic(ev: SemanticEvent | TaskEvent): void {
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

/* ------------------------------------------------------------------------ */
/*  Polling loop (Phase 1a behavior, extracted for reuse)                    */
/* ------------------------------------------------------------------------ */

interface PollOptions {
  readonly signal: AbortSignal;
  readonly afterEventId?: string;
  readonly onEvent: (ev: TaskEvent) => void;
  readonly onTerminal: (finalStatus: string) => void;
}

/**
 * Poll ``GET /tasks/{id}/events`` every ``POLL_INTERVAL_MS`` and
 * ``GET /tasks/{id}`` alongside, invoking ``onEvent`` for each new event and
 * ``onTerminal`` once the task reaches a terminal status. Resolves when the
 * task terminates or the signal fires.
 */
async function pollTaskEvents(
  apiClient: ApiClient,
  taskId: string,
  options: PollOptions,
): Promise<void> {
  let lastSeenEventId: string | null = options.afterEventId ?? null;
  debug(`[watch/poll] starting polling loop afterEventId=${lastSeenEventId ?? '<none>'}`);

  while (!options.signal.aborted) {
    let events: TaskEvent[];
    try {
      const result = await apiClient.getTaskEvents(taskId, { limit: 100 });
      events = result.data;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      debug(`[watch/poll] getTaskEvents failed: ${e.message}`);
      throw e;
    }

    const lastSeen = lastSeenEventId;
    const newEvents: TaskEvent[] = lastSeen
      ? events.filter(e => e.event_id > lastSeen)
      : events;

    if (newEvents.length > 0) {
      lastSeenEventId = newEvents[newEvents.length - 1].event_id;
      debug(`[watch/poll] emitting ${newEvents.length} new events, advanced cursor to ${lastSeenEventId}`);
      for (const ev of newEvents) {
        options.onEvent(ev);
      }
    }

    let task;
    try {
      task = await apiClient.getTask(taskId);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      debug(`[watch/poll] getTask failed: ${e.message}`);
      throw e;
    }

    if ((TERMINAL_STATUSES as readonly string[]).includes(task.status)) {
      debug(`[watch/poll] task reached terminal status=${task.status}`);
      options.onTerminal(task.status);
      return;
    }

    if (options.signal.aborted) {
      debug('[watch/poll] aborted after poll iteration, exiting');
      return;
    }
    await abortableSleep(POLL_INTERVAL_MS, options.signal);
  }
}

/** Sleep that honours an AbortSignal — resolves on abort instead of rejecting,
 *  so the polling loop can check ``signal.aborted`` and exit cleanly. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* ------------------------------------------------------------------------ */
/*  Initial snapshot — detect already-terminal tasks and seed cursor         */
/* ------------------------------------------------------------------------ */

interface SnapshotResult {
  readonly latestEventId: string | null;
  readonly events: TaskEvent[];
  readonly taskStatus: string;
}

/** Fetch the latest events + current task status. Used both to detect a
 *  task that already terminated before ``bgagent watch`` connected, and to
 *  seed the SSE catch-up cursor to ``latestEventId`` so we don't re-emit the
 *  snapshot's contents during the first SSE catch-up call.
 *
 *  Emitted event ordering: events are returned in ascending order (matching
 *  the REST contract from Phase 1b Step 4). */
async function fetchInitialSnapshot(apiClient: ApiClient, taskId: string): Promise<SnapshotResult> {
  debug(`[watch/snapshot] fetching initial snapshot task=${taskId}`);
  const [eventsPage, task] = await Promise.all([
    apiClient.getTaskEvents(taskId, { limit: SNAPSHOT_PAGE_SIZE }),
    apiClient.getTask(taskId),
  ]);
  const events = eventsPage.data;
  const latestEventId = events.length > 0 ? events[events.length - 1].event_id : null;
  debug(
    `[watch/snapshot] events=${events.length} latestEventId=${latestEventId ?? '<none>'} `
    + `status=${task.status}`,
  );
  return { latestEventId, events, taskStatus: task.status };
}

/* ------------------------------------------------------------------------ */
/*  Command definition                                                        */
/* ------------------------------------------------------------------------ */

export function makeWatchCommand(): Command {
  return new Command('watch')
    .description('Watch task progress in real-time')
    .argument('<task-id>', 'Task ID')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .option(
      '--transport <sse|polling|auto>',
      'Transport to use (auto tries SSE first, falls back to polling)',
      'auto',
    )
    .option(
      '--stream-timeout-seconds <n>',
      'SSE stream proactive-restart timeout in seconds (max 3500 = 58 min)',
      String(DEFAULT_STREAM_TIMEOUT_SECONDS),
    )
    .action(async (taskId: string, opts) => {
      const isJson = opts.output === 'json';
      const transport = validateTransport(opts.transport);
      const streamTimeoutSeconds = validateStreamTimeout(opts.streamTimeoutSeconds);
      const config = loadConfig();
      const apiClient = new ApiClient();

      debug(
        `[watch] task=${taskId} transport=${transport} isJson=${isJson} `
        + `streamTimeoutSeconds=${streamTimeoutSeconds} verbose=${isVerbose()}`,
      );

      // Abort controller for SIGINT / SIGTERM.
      const abortController = new AbortController();
      const onSignal = (): void => {
        debug('[watch] SIGINT/SIGTERM received, aborting');
        abortController.abort();
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);

      try {
        // -------- Snapshot: detect already-terminal tasks, seed cursor. --
        let snapshot: SnapshotResult;
        try {
          snapshot = await fetchInitialSnapshot(apiClient, taskId);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          logError(`Initial snapshot failed: ${e.message}`);
          throw e;
        }

        const formatter = makeFormatter(isJson);

        // Task already terminated — print the snapshot tail and exit.
        if ((TERMINAL_STATUSES as readonly string[]).includes(snapshot.taskStatus)) {
          debug(`[watch] task already terminal status=${snapshot.taskStatus} — printing tail`);
          for (const ev of snapshot.events) {
            formatter.emitSemantic(ev);
          }
          if (!isJson) {
            logInfo(isJson, `Task ${snapshot.taskStatus.toLowerCase()}.`);
          }
          process.exitCode = snapshot.taskStatus === 'COMPLETED' ? 0 : 1;
          return;
        }

        // Emit the snapshot events first so the user sees history before
        // live events start flowing.
        for (const ev of snapshot.events) {
          formatter.emitSemantic(ev);
        }
        const seedCursor = snapshot.latestEventId ?? '';

        if (!isJson) {
          logInfo(isJson, `Watching task ${taskId}... (Ctrl+C to stop)`);
        }

        // -------- Transport decision and execution. ---------------------
        const resolved = resolveTransport(transport, config.runtime_jwt_arn, isJson);
        if (resolved === 'polling') {
          await runPolling(apiClient, taskId, seedCursor, formatter, abortController.signal, isJson);
          return;
        }

        // SSE or AUTO with runtime_jwt_arn configured.
        try {
          await runSse({
            apiClient,
            taskId,
            seedCursor,
            runtimeJwtArn: config.runtime_jwt_arn as string,
            region: config.region,
            streamTimeoutSeconds,
            formatter,
            abortController,
            isJson,
          });
        } catch (err) {
          // Unrecoverable SSE failure. Behaviour depends on mode.
          const e = err instanceof Error ? err : new Error(String(err));
          if (transport === 'sse') {
            logError(`SSE transport failed: ${e.message}`);
            throw e;
          }
          // --transport auto: warn and fall back to polling.
          logWarn(
            `SSE transport failed (${e.message}) — falling back to polling.`,
          );
          debug('[watch] auto fallback to polling triggered');
          await runPolling(
            apiClient,
            taskId,
            seedCursor,
            formatter,
            abortController.signal,
            isJson,
          );
        }
      } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
    });
}

/* ------------------------------------------------------------------------ */
/*  Transport resolution                                                     */
/* ------------------------------------------------------------------------ */

function validateTransport(raw: unknown): Transport {
  if (raw === 'sse' || raw === 'polling' || raw === 'auto') return raw;
  throw new CliError(
    `Invalid --transport value: ${String(raw)}. Expected one of: sse, polling, auto.`,
  );
}

function validateStreamTimeout(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(
      `Invalid --stream-timeout-seconds value: ${String(raw)}. Must be a positive integer.`,
    );
  }
  return n;
}

/** Choose the actual transport given the requested mode and the availability
 *  of a Runtime-JWT ARN. Logs at INFO / WARN level as appropriate. */
function resolveTransport(
  requested: Transport,
  runtimeJwtArn: string | undefined,
  isJson: boolean,
): Transport {
  if (requested === 'polling') {
    logInfo(isJson, 'Using polling transport.');
    debug('[watch] transport=polling (explicit)');
    return 'polling';
  }
  if (requested === 'sse') {
    if (!runtimeJwtArn) {
      logError(
        'SSE transport requires `runtime_jwt_arn` in config. '
        + 'Run `bgagent configure --runtime-jwt-arn <arn>` and retry.',
      );
      throw new CliError('SSE transport unavailable: `runtime_jwt_arn` not configured.');
    }
    logInfo(isJson, 'Using SSE transport.');
    debug('[watch] transport=sse (explicit)');
    return 'sse';
  }
  // auto
  if (!runtimeJwtArn) {
    logWarn(
      '`runtime_jwt_arn` not configured — falling back to polling transport. '
      + 'Run `bgagent configure --runtime-jwt-arn <arn>` for real-time SSE streaming.',
    );
    debug('[watch] transport=polling (auto fallback: missing runtime_jwt_arn)');
    return 'polling';
  }
  logInfo(isJson, 'Using SSE transport (auto).');
  debug('[watch] transport=sse (auto)');
  return 'sse';
}

/* ------------------------------------------------------------------------ */
/*  SSE runner                                                               */
/* ------------------------------------------------------------------------ */

interface RunSseArgs {
  readonly apiClient: ApiClient;
  readonly taskId: string;
  readonly seedCursor: string;
  readonly runtimeJwtArn: string;
  readonly region: string;
  readonly streamTimeoutSeconds: number;
  readonly formatter: Formatter;
  readonly abortController: AbortController;
  readonly isJson: boolean;
}

async function runSse(args: RunSseArgs): Promise<void> {
  const {
    apiClient, taskId, seedCursor, runtimeJwtArn, region,
    streamTimeoutSeconds, formatter, abortController, isJson,
  } = args;

  let consecutiveReconnects = 0;

  const result = await runSseClient({
    runtimeJwtArn,
    region,
    taskId,
    getAuthToken: async () => getAuthToken(),
    catchUp: async (afterEventId: string): Promise<AgUiEvent[]> => {
      debug(`[watch/sse] catchUp afterEventId=${afterEventId || '<empty>'}`);
      const rows = await apiClient.catchUpEvents(taskId, afterEventId);
      debug(`[watch/sse] catchUp fetched ${rows.length} rows`);
      const agUi: AgUiEvent[] = [];
      for (const row of rows) {
        agUi.push(...translateDbRowToAgUi(row as TaskEventRecord));
      }
      return agUi;
    },
    initialCatchUpCursor: seedCursor,
    onEvent: (ev: AgUiEvent) => {
      debug(`[watch/sse] event type=${ev.type} id=${typeof ev.id === 'string' ? ev.id : '<none>'}`);
      // Reset consecutive-reconnect counter on successful event flow.
      consecutiveReconnects = 0;
      formatter.emitAgUi(ev);
    },
    onReconnecting: (attempt, reason, delayMs) => {
      consecutiveReconnects += 1;
      const msg = `Reconnecting (attempt ${attempt}, reason=${reason}, delayMs=${delayMs})`;
      if (!isJson) {
        logInfo(isJson, msg);
      } else {
        process.stderr.write(`${msg}\n`);
      }
      if (consecutiveReconnects > 3) {
        logWarn(
          `Stream reconnected ${consecutiveReconnects} times in a row — `
          + 'network may be flaky.',
        );
      }
      debug(`[watch/sse] reconnecting attempt=${attempt} reason=${reason} delayMs=${delayMs}`);
    },
    onCatchUp: (count, fromEventId) => {
      debug(`[watch/sse] catchUp summary count=${count} fromEventId=${fromEventId || '<empty>'}`);
      if (count > 0) {
        logInfo(isJson, `Replayed ${count} events.`);
      }
    },
    onError: (err, willRetry) => {
      if (willRetry) {
        debug(`[watch/sse] recoverable error (will retry): ${err.message}`);
      } else {
        debug(`[watch/sse] fatal error: ${err.message}`);
      }
    },
    signal: abortController.signal,
    maxStreamSeconds: streamTimeoutSeconds,
  });

  debug(
    `[watch/sse] run complete terminalEvent=${result.terminalEvent?.type ?? '<none>'} `
    + `reconnectCount=${result.reconnectCount} eventsReceived=${result.eventsReceived} `
    + `eventsDeduplicated=${result.eventsDeduplicated} durationMs=${result.totalDurationMs}`,
  );

  if (abortController.signal.aborted) {
    logInfo(isJson, 'Aborted.');
    return;
  }

  // After the stream terminates (RUN_FINISHED / RUN_ERROR), consult REST for
  // the authoritative final task status so the exit code reflects the truth
  // rather than just the AG-UI frame type.
  let finalStatus: string;
  try {
    const task = await apiClient.getTask(taskId);
    finalStatus = task.status;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    debug(`[watch/sse] getTask after RUN_FINISHED failed: ${e.message}`);
    // If we can't read the final status, infer from the terminal event.
    finalStatus = result.terminalEvent?.type === 'RUN_FINISHED' ? 'COMPLETED' : 'FAILED';
  }

  if (!isJson) {
    logInfo(isJson, `Task ${finalStatus.toLowerCase()}.`);
  }
  process.exitCode = finalStatus === 'COMPLETED' ? 0 : 1;
}

/* ------------------------------------------------------------------------ */
/*  Polling runner                                                           */
/* ------------------------------------------------------------------------ */

async function runPolling(
  apiClient: ApiClient,
  taskId: string,
  seedCursor: string,
  formatter: Formatter,
  signal: AbortSignal,
  isJson: boolean,
): Promise<void> {
  debug(`[watch/poll] runPolling seedCursor=${seedCursor || '<none>'}`);
  let finalStatus: string | null = null;

  await pollTaskEvents(apiClient, taskId, {
    signal,
    afterEventId: seedCursor || undefined,
    onEvent: (ev) => formatter.emitSemantic(ev),
    onTerminal: (status) => { finalStatus = status; },
  });

  if (signal.aborted && finalStatus === null) {
    logInfo(isJson, 'Aborted.');
    return;
  }

  if (finalStatus !== null) {
    if (!isJson) {
      logInfo(isJson, `Task ${(finalStatus as string).toLowerCase()}.`);
    }
    process.exitCode = finalStatus === 'COMPLETED' ? 0 : 1;
  }
}
