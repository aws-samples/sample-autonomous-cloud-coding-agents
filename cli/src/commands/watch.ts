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
import { ApiError } from '../errors';
import { formatJson } from '../format';
import { TERMINAL_STATUSES, TaskEvent } from '../types';

/**
 * Adaptive polling cadence (design INTERACTIVE_AGENTS.md §5.3).
 *
 * While events are arriving we stay at ``POLL_FAST_INTERVAL_MS``. When a
 * poll returns zero events we back off through the ``BACKOFF_INTERVALS_MS``
 * ladder, resetting to fast on the next poll that delivers events. The
 * ladder caps at 5 s to keep status freshness bounded during idle
 * stretches without hammering DDB.
 */
const POLL_FAST_INTERVAL_MS = 500;
const BACKOFF_INTERVALS_MS: readonly number[] = [1_000, 2_000, 5_000];

/** Adaptive polling state, threaded through the poll loop. */
interface PollCadenceState {
  intervalMs: number;
  consecutiveEmptyPolls: number;
}

/** Compute the next cadence from whether the last poll delivered events.
 *  Pure so the state machine is test-coverable without timers. */
export function nextCadence(state: PollCadenceState, sawEvents: boolean): PollCadenceState {
  if (sawEvents) {
    return { intervalMs: POLL_FAST_INTERVAL_MS, consecutiveEmptyPolls: 0 };
  }
  const nextEmpty = state.consecutiveEmptyPolls + 1;
  // Ladder index is ``nextEmpty - 1`` (first empty poll picks slot 0 =
  // 1 s). After the ladder is exhausted we pin at the cap.
  const idx = Math.min(nextEmpty - 1, BACKOFF_INTERVALS_MS.length - 1);
  return { intervalMs: BACKOFF_INTERVALS_MS[idx], consecutiveEmptyPolls: nextEmpty };
}

/** Retry budget for transient 5xx / network failures. Exhausting it exits
 *  the watch loop with a clear "rerun to resume" message. 4xx errors are
 *  deterministic and never retried. */
const MAX_TRANSIENT_RETRIES = 5;

/** Exponential backoff with **equal-jitter** (AWS Architecture Blog
 *  variant): half of the base delay is fixed, the other half is
 *  randomized. This prevents the degenerate case where ``Math.random()``
 *  rolls near-zero on every retry and the CLI retry-spams a degraded
 *  service with no wait between attempts. Bounded at the ladder cap so
 *  a retry storm never walks longer than the adaptive poll ceiling. */
export function transientRetryDelayMs(attempt: number): number {
  const base = Math.min(5_000, POLL_FAST_INTERVAL_MS * 2 ** attempt);
  const half = Math.floor(base / 2);
  return half + Math.floor(Math.random() * (base - half));
}

/** Classify an error into retryable vs. terminal. We use a **whitelist**
 *  rather than a blacklist: only conditions we specifically recognize as
 *  transient retry. Everything else (programmer errors, JSON parse
 *  failures, auth-token-expired, CliError) propagates immediately so
 *  users see an actionable message instead of "re-run to resume" that
 *  would never succeed.
 *
 *  Transient:
 *    - ``ApiError`` with status 5xx (server-side hiccup)
 *    - Network failures surfaced by ``fetch`` as a ``TypeError`` —
 *      Node's undici implementation reports connect refused / reset /
 *      DNS failure this way on Node 22+.
 *
 *  Non-transient (propagates with its original message):
 *    - ``ApiError`` with status 4xx (including 401 auth-expired — the
 *      ``bgagent login`` hint is already in the message)
 *    - ``CliError`` (our own deterministic contract-violation signal)
 *    - Anything else (``TypeError`` that is *not* a fetch failure,
 *      ``SyntaxError`` from a bad code path, etc.) — a real bug.
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.statusCode >= 500 && err.statusCode < 600;
  }
  // Node 22+ fetch surfaces network failures as a ``TypeError`` with a
  // "fetch failed" message (undici wraps the underlying cause). Match
  // loosely so we tolerate both direct ``TypeError`` and DOMException
  // lookalikes without retrying genuine programmer ``TypeError``s.
  if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) {
    return true;
  }
  return false;
}

/** Exit code 130 is the conventional POSIX code for "terminated by
 *  SIGINT". Using it lets shell scripts distinguish Ctrl+C from a failed
 *  task run. */
const EXIT_CODE_SIGINT = 130;
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
 * Poll ``GET /tasks/{id}/events`` and ``GET /tasks/{id}`` on an adaptive
 * cadence: 500 ms while events are arriving, backing off through
 * 1 s / 2 s / 5 s on consecutive empty polls and resetting to fast on
 * the next event. Invokes ``onEvent`` for each new event and
 * ``onTerminal`` once the task reaches a terminal status. Resolves when
 * the task terminates or the abort signal fires.
 *
 * Transient 5xx / network errors are retried with jittered exponential
 * backoff up to ``MAX_TRANSIENT_RETRIES`` times; 4xx errors propagate
 * immediately (the next call would return the same failure). On retry
 * exhaustion we throw a ``CliError``-like message that tells the user
 * to re-run ``bgagent watch`` — the event cursor is durable, so
 * resuming is safe.
 */
async function pollTaskEvents(
  apiClient: ApiClient,
  taskId: string,
  options: PollOptions,
): Promise<void> {
  let lastSeenEventId: string | null = options.afterEventId ?? null;
  let cadence: PollCadenceState = { intervalMs: POLL_FAST_INTERVAL_MS, consecutiveEmptyPolls: 0 };
  debug(`[watch/poll] starting polling loop afterEventId=${lastSeenEventId ?? '<none>'}`);

  while (!options.signal.aborted) {
    // Fetch every event past our cursor. ``catchUpEvents`` seeds with
    // ``after=lastSeenEventId`` and drains the server's ``next_token``
    // pagination so we see all events — not just the first 100.
    const newEvents = await withTransientRetry(
      () => (lastSeenEventId
        ? apiClient.catchUpEvents(taskId, lastSeenEventId, 100, { signal: options.signal })
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

    if ((TERMINAL_STATUSES as readonly string[]).includes(task.status)) {
      debug(`[watch/poll] task reached terminal status=${task.status}`);
      options.onTerminal(task.status);
      return;
    }

    cadence = nextCadence(cadence, newEvents.length > 0);
    debug(`[watch/poll] cadence=${cadence.intervalMs}ms emptyPolls=${cadence.consecutiveEmptyPolls}`);
    await abortableSleep(cadence.intervalMs, options.signal);
  }
}

/**
 * Execute an API call with retry-on-transient semantics:
 *   - 5xx / network errors → retry after jittered backoff, up to
 *     ``MAX_TRANSIENT_RETRIES`` total attempts.
 *   - 4xx errors → rethrow immediately (deterministic; retrying is futile).
 *   - Exhausted retries → throw with a "re-run to resume" hint.
 *   - Abort during retry sleep → throw the original error up (caller will
 *     check ``signal.aborted`` and exit cleanly).
 *
 * ``label`` is used only for debug logging so operators can see *which*
 * call is retrying during a degraded poll window.
 */
async function withTransientRetry<T>(
  op: () => Promise<T>,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
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
      if (attempt > MAX_TRANSIENT_RETRIES) {
        const e = err instanceof Error ? err : new Error(String(err));
        throw new Error(
          `Exceeded retry budget after ${MAX_TRANSIENT_RETRIES} transient failures `
          + `(${label}): ${e.message}. Re-run \`bgagent watch <id>\` to resume.`,
        );
      }
      const delayMs = transientRetryDelayMs(attempt);
      debug(`[watch/retry] ${label}: attempt ${attempt}/${MAX_TRANSIENT_RETRIES} after ${delayMs}ms`);
      await abortableSleep(delayMs, signal);
    }
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
export async function fetchInitialSnapshot(
  apiClient: ApiClient,
  taskId: string,
  opts?: { signal?: AbortSignal },
): Promise<SnapshotResult> {
  debug(`[watch/snapshot] fetching initial snapshot task=${taskId}`);
  const signal = opts?.signal;
  const [eventsPage, task] = await Promise.all([
    apiClient.getTaskEvents(taskId, { limit: SNAPSHOT_PAGE_SIZE, signal }),
    apiClient.getTask(taskId, { signal }),
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
          snapshot = await fetchInitialSnapshot(apiClient, taskId, { signal: abortController.signal });
        } catch (err) {
          // Only exit 130 if the error IS the abort — i.e., an AbortError
          // from our signal. Checking only ``signal.aborted`` would race:
          // a real 401 from an expired token that happens to throw at the
          // same moment the user Ctrl+Cs would get silently swallowed as
          // a clean interrupt, and the user would miss the ``bgagent
          // login`` hint.
          const isAbortError = err instanceof Error && err.name === 'AbortError';
          if (isAbortError && abortController.signal.aborted) {
            process.exitCode = EXIT_CODE_SIGINT;
            return;
          }
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

  // SIGINT always wins. Check ``signal.aborted`` BEFORE ``finalStatus``
  // so a user who Ctrl+C's between ``onTerminal`` firing and this block
  // evaluating still gets exit 130 — their intent to interrupt is the
  // load-bearing signal, not the coincidental terminal status. POSIX:
  // 128 + SIGINT (2) = 130.
  if (signal.aborted) {
    logInfo(isJson, 'Aborted.');
    process.exitCode = EXIT_CODE_SIGINT;
    return;
  }

  if (finalStatus !== null) {
    if (!isJson) {
      logInfo(isJson, `Task ${(finalStatus as string).toLowerCase()}.`);
    }
    process.exitCode = finalStatus === 'COMPLETED' ? 0 : 1;
  }
}
