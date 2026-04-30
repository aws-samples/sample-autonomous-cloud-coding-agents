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
import { formatJson } from '../format';
import { TERMINAL_STATUSES, TaskEvent } from '../types';

/**
 * Polling cadence for the REST-based `watch` loop.
 *
 * Design §9.13.1 calls for 500 ms polling. We adopt that for the first
 * POLL_FAST_WINDOW_MS window (users are watching fresh, active tasks)
 * and decay to POLL_SLOW_INTERVAL_MS for long-running observations so
 * we don't hammer REST for hours at 500 ms.
 *
 * Chunk H will make this adaptive; the simple decaying cadence is kept
 * in the meantime.
 */
const POLL_FAST_INTERVAL_MS = 500;
const POLL_SLOW_INTERVAL_MS = 2_000;
const POLL_FAST_WINDOW_MS = 3 * 60 * 1_000; // 3 min of fast polling

function currentPollInterval(startedAt: number): number {
  return Date.now() - startedAt < POLL_FAST_WINDOW_MS
    ? POLL_FAST_INTERVAL_MS
    : POLL_SLOW_INTERVAL_MS;
}
/** Size of the initial snapshot fetch used to detect already-terminal tasks
 *  and seed the catch-up cursor. */
const SNAPSHOT_PAGE_SIZE = 100;

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
      const milestone = meta.milestone ?? '';
      const details = meta.details ?? '';
      return `[${time}] ★ ${milestone}${details ? ': ' + details : ''}`;
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
      return `[${time}] ✖ ${errType}: ${msg}`;
    }
    default:
      return `[${time}] ${event.event_type}: ${JSON.stringify(meta)}`;
  }
}

/* ------------------------------------------------------------------------ */
/*  Structured logging helpers                                               */
/* ------------------------------------------------------------------------ */

/** Log an INFO-level message to stderr. Stdout stays pure NDJSON in either
 *  mode because info messages never go there; the ``isJson`` parameter is
 *  kept for call-site documentation of the mode. */
function logInfo(_isJson: boolean, message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Log an ERROR-level message to stderr regardless of output mode. */
function logError(message: string): void {
  process.stderr.write(`ERROR: ${message}\n`);
}

/* ------------------------------------------------------------------------ */
/*  Formatter boundary                                                        */
/* ------------------------------------------------------------------------ */

/**
 * A formatter that accepts `TaskEvent` rows (from REST polling) and
 * produces human-readable output (text mode) or NDJSON (json mode).
 */
interface Formatter {
  emit(ev: TaskEvent): void;
}

export function makeFormatter(isJson: boolean): Formatter {
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

/* ------------------------------------------------------------------------ */
/*  Polling loop                                                             */
/* ------------------------------------------------------------------------ */

interface PollOptions {
  readonly signal: AbortSignal;
  readonly afterEventId?: string;
  readonly onEvent: (ev: TaskEvent) => void;
  readonly onTerminal: (finalStatus: string) => void;
}

/**
 * Poll ``GET /tasks/{id}/events`` and ``GET /tasks/{id}`` on a
 * decaying interval (500 ms for the first 3 min, then 2 s), invoking
 * ``onEvent`` for each new event and ``onTerminal`` once the task
 * reaches a terminal status. Resolves when the task terminates or the
 * signal fires.
 */
async function pollTaskEvents(
  apiClient: ApiClient,
  taskId: string,
  options: PollOptions,
): Promise<void> {
  let lastSeenEventId: string | null = options.afterEventId ?? null;
  const pollStartedAt = Date.now();
  debug(`[watch/poll] starting polling loop afterEventId=${lastSeenEventId ?? '<none>'}`);

  while (!options.signal.aborted) {
    // Fetch every event past our cursor. ``catchUpEvents`` seeds with
    // ``after=lastSeenEventId`` and drains the server's ``next_token``
    // pagination so we see all events — not just the first 100.
    let newEvents: TaskEvent[];
    try {
      if (lastSeenEventId) {
        newEvents = await apiClient.catchUpEvents(taskId, lastSeenEventId);
      } else {
        // First iteration without a seed cursor: snapshot already emitted
        // history; grab any events the server picked up since.
        const result = await apiClient.getTaskEvents(taskId, { limit: 100 });
        newEvents = result.data;
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      debug(`[watch/poll] getTaskEvents failed: ${e.message}`);
      throw e;
    }

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
    await abortableSleep(currentPollInterval(pollStartedAt), options.signal);
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
 *  seed the polling cursor so we don't re-emit the snapshot's contents on
 *  the first poll iteration.
 *
 *  Emitted event ordering: events are returned in ascending event_id
 *  order (REST contract). */
export async function fetchInitialSnapshot(apiClient: ApiClient, taskId: string): Promise<SnapshotResult> {
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
    .action(async (taskId: string, opts) => {
      const isJson = opts.output === 'json';
      const apiClient = new ApiClient();

      debug(`[watch] task=${taskId} isJson=${isJson} verbose=${isVerbose()}`);

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
            formatter.emit(ev);
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
    onEvent: (ev) => formatter.emit(ev),
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
