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
import { TERMINAL_STATUSES, TaskDetail, TaskEvent } from '../types';

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

/**
 * Session-level retry counter (L3 item 5). ``withTransientRetry`` resets
 * its per-op ``attempt`` counter on every successful poll, which means a
 * flapping upstream at ~50% success rate never trips the 5-retry budget
 * even though the user is watching a degraded stream for minutes on end.
 * The session counter accumulates across all retries for the life of the
 * watch process so a ``SESSION_FLAP_THRESHOLD`` crossing can surface the
 * "upstream is flapping" stderr signal exactly once.
 *
 * Not exposed on any public surface — underscore-prefixed getter is for
 * tests only (module-level state makes this awkward to inject, and the
 * tradeoff isn't worth a full dependency-injection refactor).
 */
let sessionRetries = 0;
let flapWarnEmitted = false;

/** Emit-once threshold for the "upstream is flapping" warning. Picked so
 *  a sustained ~30% failure rate over a few-minute poll window lands
 *  above it without a transient 2-failure blip crossing. */
const SESSION_FLAP_THRESHOLD = 10;

/** Test-only accessor for the module-level retry counter. Prefixed with
 *  ``_`` to signal "not part of the stable API". */
export function _getSessionRetries(): number {
  return sessionRetries;
}

/** Test-only reset of the module-level state. Tests that exercise the
 *  flap warning need a clean slate because the counter is process-lived
 *  and Jest's module reset does not apply to values captured at import. */
export function _resetSessionRetries(): void {
  sessionRetries = 0;
  flapWarnEmitted = false;
}

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

/**
 * Render the terminal-line message shown when a watch session ends
 * because the task reached a terminal state. Includes the task_id (so
 * a user with multiple watches or a scroll-back log can correlate)
 * and, for non-COMPLETED terminals, a short failure-classification
 * hint so the cause is visible without a separate ``bgagent status``
 * round-trip.
 *
 * Exported for tests. Safe to call with a bare ``{task_id, status}``
 * shape or a full ``TaskDetail`` — only those fields plus
 * ``error_classification`` / ``error_message`` are read.
 */
export function formatTerminalMessage(task: Pick<TaskDetail, 'task_id' | 'status' | 'error_classification' | 'error_message'>): string {
  const status = task.status.toLowerCase();
  const prefix = `Task ${task.task_id} ${status}.`;
  if (task.status === 'COMPLETED') return prefix;
  // Prefer the structured classification (category + title) when the
  // server has computed one — it's both stable and user-oriented. Fall
  // back to the raw ``error_message`` so a classifier gap doesn't
  // swallow the only signal we have. Never return the whole prefix
  // with a trailing empty reason.
  const cls = task.error_classification;
  if (cls) return `${prefix} ${cls.category}: ${cls.title}`;
  const msg = task.error_message?.trim();
  if (msg) return `${prefix} ${msg}`;
  return prefix;
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
  readonly onTerminal: (finalTask: TaskDetail) => void;
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
      options.onTerminal(task);
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
      // Session-level counter (L3 item 5). ``attempt`` resets on every
      // successful op; ``sessionRetries`` does not, so a flapping upstream
      // that never exhausts the per-op budget still accumulates here.
      sessionRetries += 1;
      if (sessionRetries >= SESSION_FLAP_THRESHOLD && !flapWarnEmitted) {
        flapWarnEmitted = true;
        process.stderr.write(
          `[watch] upstream is flapping — ${sessionRetries} retries so far; results may be delayed\n`,
        );
      }
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
 *  Both API calls are wrapped in ``withTransientRetry`` so a cold-start
 *  hiccup on the Lambda (``fetch failed`` / 5xx / network transients)
 *  does not crash the watch command before the polling loop gets a
 *  chance to stabilise. The polling loop itself wraps every subsequent
 *  call; without the same wrap here, the first request was the weakest
 *  link (observed Scenario 2 deploy validation, where a cold-start
 *  failed once then succeeded on re-run).
 *
 *  ``signal`` is required so callers commit to a concrete abort
 *  controller — otherwise SIGINT during the snapshot's retry backoff
 *  could never abort a retrying call. The production watch command
 *  always passes its shared ``AbortController`` signal; tests that
 *  exercise this path do the same via ``makeWatchCommand``.
 *
 *  Emitted event ordering: events are returned in ascending event_id
 *  order (REST contract). */
export async function fetchInitialSnapshot(
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
          // Capture the pre-abort state so the SIGINT-vs-real-error
          // disambiguation below works. Then abort the shared controller
          // so any sibling ``Promise.all`` leg still inside
          // ``withTransientRetry`` stops backing off and burning retries
          // against the API. Idempotent — calling ``abort`` on an
          // already-aborted controller is a no-op.
          const wasUserAborted = abortController.signal.aborted;
          abortController.abort();

          // Only exit 130 if the error IS the abort — i.e., an AbortError
          // from our signal THAT WAS ALREADY ABORTED when the error fired.
          // Checking post-abort state would swallow a real 401 from an
          // expired token that happens to throw at the same moment the
          // user Ctrl+Cs as a clean interrupt, and the user would miss
          // the ``bgagent login`` hint.
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

        // Task already terminated — print the snapshot tail and exit.
        if ((TERMINAL_STATUSES as readonly string[]).includes(snapshot.taskStatus)) {
          debug(`[watch] task already terminal status=${snapshot.taskStatus} — printing tail`);
          for (const ev of snapshot.events) {
            formatter.emit(ev);
          }
          if (!isJson) {
            // Fetch the current task detail so the terminal-line can
            // include the error classification (``guardrail: PR context
            // blocked``, ``timeout: Exceeded max turns``, etc.). The
            // snapshot only carried ``taskStatus``. Best-effort: if the
            // GET fails transiently we still print a minimal message
            // rather than erroring out after already streaming the tail.
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
  let finalTask: TaskDetail | null = null;

  await pollTaskEvents(apiClient, taskId, {
    signal,
    afterEventId: seedCursor || undefined,
    onEvent: (ev) => formatter.emit(ev),
    onTerminal: (task) => { finalTask = task; },
  });

  // SIGINT always wins. Check ``signal.aborted`` BEFORE ``finalTask``
  // so a user who Ctrl+C's between ``onTerminal`` firing and this block
  // evaluating still gets exit 130 — their intent to interrupt is the
  // load-bearing signal, not the coincidental terminal status. POSIX:
  // 128 + SIGINT (2) = 130.
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
    process.exitCode = task.status === 'COMPLETED' ? 0 : 1;
  }
}
