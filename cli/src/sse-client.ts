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

/**
 * SSE transport wrapper for the Phase 1b AgentCore streaming path.
 *
 * Decision D3 (hybrid): imports `@ag-ui/core` for TypeScript types and Zod
 * schemas only; owns the transport with native `fetch` + `eventsource-parser`.
 * Does NOT use `@ag-ui/client` `HttpAgent` — that library is pre-1.0, has no
 * built-in reconnection/backoff/token-refresh, and would have to be wrapped
 * anyway. See design doc §9.11 and §9.12.
 *
 * Responsibilities of this module:
 *   - POST to the AgentCore data-plane `/invocations` endpoint on Runtime-JWT
 *     with `Accept: text/event-stream`.
 *   - Parse SSE frames with `eventsource-parser`.
 *   - Validate each frame's JSON against `@ag-ui/core` schemas (skip invalid
 *     frames, never crash the stream).
 *   - Reconnect with exponential backoff on network error, keepalive timeout,
 *     proactive 60-min restart (§9.12 AgentCore cap), non-terminal RUN_ERROR,
 *     or abrupt TCP close.
 *   - On reconnect, call `catchUp(lastSeenEventId)` to pull missed events from
 *     DDB, emit them (deduplicated), then resume the live stream.
 *   - Refresh the JWT on 401 and retry once; surface UNAUTHORIZED on double-401.
 *   - Honour external cancellation via `AbortSignal`.
 *
 * Consumer-facing concerns (rendering, quiet/verbose modes, REST-polling
 * fallback) live in `cli/src/commands/watch.ts`.
 */

import { EventSchemas, EventType } from '@ag-ui/core';
import { createParser, EventSourceMessage } from 'eventsource-parser';
import { debug } from './debug';
import { CliError } from './errors';
import { isApiError } from './types';

/* ------------------------------------------------------------------------ */
/*  Public types                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Minimum shape we rely on for an AG-UI event. The real object is validated
 * against `@ag-ui/core`'s `EventSchemas` discriminated union at parse time,
 * but all downstream consumers only need ``type`` plus a best-effort id for
 * deduplication. Treating the event as an open record matches the AG-UI wire
 * format (passthrough schemas — additional fields are allowed).
 */
export interface AgUiEvent {
  readonly type: string;
  readonly timestamp?: number;
  readonly messageId?: string;
  readonly toolCallId?: string;
  readonly stepName?: string;
  readonly threadId?: string;
  readonly runId?: string;
  readonly code?: string;
  readonly message?: string;
  readonly name?: string;
  readonly value?: unknown;
  readonly rawEvent?: unknown;
  /** Opaque id injected by the catch-up translator so the CLI can correlate
   *  DDB event_ids with live-stream AG-UI events for cursor advancement. */
  readonly id?: string;
  readonly [key: string]: unknown;
}

/** Reason why the SSE client is reconnecting. Emitted via ``onReconnecting``. */
export type ReconnectReason =
  | 'network_error'
  | 'keepalive_timeout'
  | 'proactive_60min_restart'
  | 'non_terminal_run_error'
  | 'http_error'
  | 'unauthorized_retry'
  | 'stream_closed';

/** Exponential-backoff knobs. */
export interface BackoffConfig {
  readonly initial: number;
  readonly max: number;
  readonly factor: number;
}

/** Options accepted by {@link runSseClient}. */
export interface SseClientOptions {
  /** ARN of the Cognito-JWT-auth AgentCore Runtime (CFN output ``RuntimeJwtArn``). */
  readonly runtimeJwtArn: string;
  /** AWS region, e.g. ``us-east-1``. */
  readonly region: string;
  /** Task identifier; used as ``X-Amzn-Bedrock-AgentCore-Runtime-Session-Id``. */
  readonly taskId: string;
  /** Additional invocation payload merged under ``{"input": {...}}``. The
   *  ``task_id`` field is always added automatically. */
  readonly invocationInput?: Record<string, unknown>;
  /** Returns a fresh Cognito ID token; called on each (re)connect, and again
   *  on 401 to force a refresh. */
  readonly getAuthToken: () => Promise<string>;
  /** Catch-up callback: return events with ``event_id > afterEventId`` from
   *  the REST control plane, translated into AG-UI shape. Supplied by
   *  ``watch.ts`` (wraps ``ApiClient.catchUpEvents``). */
  readonly catchUp: (afterEventId: string) => Promise<AgUiEvent[]>;
  /** Initial cursor used for the very first catch-up call (empty string means
   *  "from the beginning of the task"). Subsequent catch-ups advance this
   *  automatically from the last emitted event id. */
  readonly initialCatchUpCursor?: string;
  /** Proactive restart deadline in seconds. Default 3500 (~58 min — safely
   *  under AgentCore's 60-min streaming cap, §9.12). */
  readonly maxStreamSeconds?: number;
  /** Exponential-backoff tuning. Defaults: ``{initial:1000, max:30000, factor:2.0}``. */
  readonly reconnectBackoffMs?: Partial<BackoffConfig>;
  /** If no bytes (data or keepalive) arrive within this window, treat the
   *  stream as dead and reconnect. Default 30 000 ms. */
  readonly keepaliveGraceMs?: number;
  /** Cap for the in-memory dedup Set. When exceeded, the oldest half is
   *  discarded. Default 10 000. */
  readonly dedupCap?: number;
  /** Called for every validated AG-UI event (both live and catch-up). */
  readonly onEvent: (event: AgUiEvent) => void;
  /** Called on non-fatal errors (bad frame, transient disconnect) and on
   *  fatal errors just before the promise rejects. ``willRetry=true`` means
   *  a reconnect will follow. */
  readonly onError?: (err: Error, willRetry: boolean) => void;
  /** Called before each reconnect attempt, after backoff is computed but
   *  before the sleep. */
  readonly onReconnecting?: (attempt: number, reason: ReconnectReason, delayMs: number) => void;
  /** Called after each successful catch-up batch. */
  readonly onCatchUp?: (count: number, fromEventId: string) => void;
  /** External cancellation token (e.g. Ctrl+C). */
  readonly signal?: AbortSignal;
}

/** Result object returned when the stream terminates cleanly (terminal event
 *  or external cancellation) or when the client gives up. */
export interface SseRunResult {
  /** The RUN_FINISHED or terminal RUN_ERROR that closed the stream, if any. */
  readonly terminalEvent: AgUiEvent | null;
  /** Number of reconnects performed (0 for a single-shot stream). */
  readonly reconnectCount: number;
  /** Total AG-UI events emitted via ``onEvent`` (live + catch-up, dedup-filtered). */
  readonly eventsReceived: number;
  /** Events suppressed by the dedup filter. */
  readonly eventsDeduplicated: number;
  /** Wall-clock duration from first connect to terminate, in ms. */
  readonly totalDurationMs: number;
}

/* ------------------------------------------------------------------------ */
/*  Constants and helpers                                                    */
/* ------------------------------------------------------------------------ */

const DEFAULT_MAX_STREAM_SECONDS = 3500;
const DEFAULT_KEEPALIVE_GRACE_MS = 30_000;
const DEFAULT_DEDUP_CAP = 10_000;
const DEFAULT_BACKOFF: BackoffConfig = { initial: 1000, max: 30_000, factor: 2.0 };
const PROACTIVE_RESTART_LOG_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** Fatal RUN_ERROR codes — do NOT reconnect when the server sends one. */
const TERMINAL_RUN_ERROR_CODES: ReadonlySet<string> = new Set([
  'AGENT_ERROR',
  'AgentError',
  'UNAUTHORIZED',
  'ACCESS_DENIED',
]);

/** Build the AgentCore data-plane invocations URL for a given runtime ARN.
 *
 *  Shape: ``https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<urlencoded-arn>/invocations?qualifier=DEFAULT``
 *
 *  The runtime ARN contains ``:`` and ``/`` characters that must be
 *  percent-encoded; ``encodeURIComponent`` handles both.
 */
export function buildInvocationUrl(region: string, runtimeArn: string, qualifier = 'DEFAULT'): string {
  const encoded = encodeURIComponent(runtimeArn);
  return `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encoded}/invocations?qualifier=${qualifier}`;
}

/** Extract a stable id from an AG-UI event for deduplication.
 *
 *  Preference order: explicit ``id`` (injected by the catch-up translator) →
 *  ``messageId`` (TEXT_MESSAGE_*) → ``toolCallId`` (TOOL_CALL_*) →
 *  ``stepName`` paired with timestamp (STEP_*). For terminal events
 *  (RUN_STARTED/FINISHED/ERROR) the ``runId`` + ``type`` combo is stable.
 *  Falls back to a type+timestamp synthesis which is NOT guaranteed unique
 *  but is the best we can do for CUSTOM / RAW without payload hashing.
 */
/**
 * Build a Runtime session ID from the task ID that satisfies AgentCore's
 * ``>= 33 characters`` constraint. Task IDs are 26-character ULIDs; we
 * prefix with a deterministic ``bgagent-watch-`` (14 chars) → 40 chars total.
 *
 * Determinism is load-bearing: reconnect attempts must re-use the same
 * session ID so AgentCore routes to the same microVM (preserving
 * in-progress session state). Do NOT substitute a random UUID per call.
 *
 * Exported for unit testing.
 */
export function buildRuntimeSessionId(taskId: string): string {
  const prefix = 'bgagent-watch-';
  const candidate = `${prefix}${taskId}`;
  if (candidate.length >= 33) return candidate;
  // Pad deterministically with 'x' to reach the minimum. Only fires if the
  // task ID is unusually short (shouldn't happen with ULIDs).
  return candidate.padEnd(33, 'x');
}

export function extractDedupId(ev: AgUiEvent): string {
  if (ev.id) return `id:${ev.id}`;
  if (ev.messageId) return `msg:${ev.type}:${ev.messageId}`;
  if (ev.toolCallId) return `tool:${ev.type}:${ev.toolCallId}`;
  if (ev.type === 'RUN_STARTED' || ev.type === 'RUN_FINISHED' || ev.type === 'RUN_ERROR') {
    return `run:${ev.type}:${ev.runId ?? ''}`;
  }
  if (ev.stepName) return `step:${ev.type}:${ev.stepName}:${ev.timestamp ?? 0}`;
  if (ev.type === 'CUSTOM' && ev.name) {
    return `custom:${ev.name}:${ev.timestamp ?? 0}`;
  }
  return `misc:${ev.type}:${ev.timestamp ?? 0}`;
}

/** Pretty-print backoff inputs into a capped delay (ms). */
function computeBackoff(attempt: number, cfg: BackoffConfig): number {
  const raw = cfg.initial * Math.pow(cfg.factor, attempt);
  return Math.min(raw, cfg.max);
}

/** Redact everything except the last 8 chars of an ARN / token for logs. */
function redactSuffix(value: string): string {
  if (!value) return '<empty>';
  if (value.length <= 12) return '<redacted>';
  return `***${value.slice(-8)}`;
}

/** Sleep that honours an AbortSignal — rejects with ``AbortError`` on abort. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort);
  });
}

/** Best-effort: extract the AG-UI EventType enum value from an unvalidated
 *  frame. Used before Zod validation to short-circuit terminal-event handling
 *  even on unknown passthrough fields. */
function shallowEventType(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = (raw as { type?: unknown }).type;
  return typeof t === 'string' ? t : null;
}

/* ------------------------------------------------------------------------ */
/*  Internal state                                                           */
/* ------------------------------------------------------------------------ */

interface StreamAttemptOutcome {
  /** If set, a terminal AG-UI event closed the stream — do not reconnect. */
  readonly terminalEvent?: AgUiEvent;
  /** Reason to reconnect, if any. */
  readonly reconnectReason?: ReconnectReason;
  /** Error associated with the outcome. */
  readonly error?: Error;
  /** External abort fired. */
  readonly aborted?: boolean;
  /** HTTP 401 encountered — caller decides whether to refresh+retry or fail. */
  readonly unauthorized?: boolean;
}

/** Map of categorised emission outcomes from the SSE frame handler. */
interface EmissionSummary {
  readonly terminal?: AgUiEvent;
  readonly nonTerminalRunError?: AgUiEvent;
}

/* ------------------------------------------------------------------------ */
/*  Main entry point                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Run the SSE client. Resolves when the stream terminates cleanly (terminal
 * AG-UI event, cancellation), rejects on non-retryable auth failure or when
 * the caller-supplied ``catchUp`` throws irrecoverably.
 *
 * @param options - client configuration; see {@link SseClientOptions}.
 * @returns a summary of the run.
 */
export async function runSseClient(options: SseClientOptions): Promise<SseRunResult> {
  const backoff: BackoffConfig = {
    ...DEFAULT_BACKOFF,
    ...(options.reconnectBackoffMs ?? {}),
  };
  const maxStreamSeconds = options.maxStreamSeconds ?? DEFAULT_MAX_STREAM_SECONDS;
  const keepaliveGraceMs = options.keepaliveGraceMs ?? DEFAULT_KEEPALIVE_GRACE_MS;
  const dedupCap = options.dedupCap ?? DEFAULT_DEDUP_CAP;
  const url = buildInvocationUrl(options.region, options.runtimeJwtArn);

  const seenIds: Set<string> = new Set();
  // Insertion-ordered eviction array — mirrors the Set so we can trim oldest
  // half when the cap is hit without scanning the Set itself.
  const seenOrder: string[] = [];
  let catchUpCursor = options.initialCatchUpCursor ?? '';
  let reconnectCount = 0;
  let attempt = 0;
  let eventsReceived = 0;
  let eventsDeduplicated = 0;
  const startedAt = Date.now();
  let terminalEvent: AgUiEvent | null = null;
  // Per-run one-shot 401 retry flag (do NOT share across runSseClient calls).
  let unauthorizedAlreadyRetried = false;

  const emit = (ev: AgUiEvent): void => {
    const id = extractDedupId(ev);
    if (seenIds.has(id)) {
      eventsDeduplicated += 1;
      debug(`[sse] dedup-skip id=${id} type=${ev.type}`);
      if (options.onError) {
        // Surface as a warning-level note via onError. `willRetry=true` is a
        // conservative choice — callers filter by error message if needed.
        options.onError(new Error(`duplicate event skipped: ${id}`), true);
      }
      return;
    }
    seenIds.add(id);
    seenOrder.push(id);
    if (seenOrder.length > dedupCap) {
      const half = Math.floor(dedupCap / 2);
      const evicted = seenOrder.splice(0, half);
      for (const e of evicted) seenIds.delete(e);
      debug(`[sse] dedup-evict count=${evicted.length} remaining=${seenIds.size}`);
    }
    // If the event carries an explicit ``id`` (our catch-up convention — DDB
    // event_id injected into the AG-UI object), advance the catch-up cursor
    // so the next reconnect resumes strictly after it.
    if (typeof ev.id === 'string' && ev.id > catchUpCursor) {
      catchUpCursor = ev.id;
    }
    eventsReceived += 1;
    options.onEvent(ev);
  };

  // Perform catch-up before/after each (re)connect. Swallow transient errors
  // and let the stream proceed — the catch-up is best-effort. Fatal errors
  // (CliError thrown by watch.ts) bubble up and reject the main promise.
  const doCatchUp = async (): Promise<void> => {
    const cursor = catchUpCursor;
    debug(`[sse] catchUp start cursor=${cursor || '<empty>'}`);
    try {
      const events = await options.catchUp(cursor);
      if (!events.length) {
        debug('[sse] catchUp empty — no missed events');
        return;
      }
      debug(`[sse] catchUp fetched count=${events.length}`);
      for (const ev of events) emit(ev);
      if (options.onCatchUp) options.onCatchUp(events.length, cursor);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e instanceof CliError) throw e;
      debug(`[sse] catchUp failed (non-fatal): ${e.message}`);
      if (options.onError) options.onError(e, true);
    }
  };

  // Main loop: one iteration per connect attempt.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (options.signal?.aborted) {
      debug('[sse] external abort before connect — exiting');
      if (options.onError) options.onError(new Error('cancelled'), false);
      break;
    }

    // Always catch up FIRST so a freshly-started stream replays anything
    // ProgressWriter wrote to DDB before we connected (including events
    // that would have been emitted during previous reconnect windows).
    if (attempt > 0) {
      await doCatchUp();
    } else if (catchUpCursor) {
      // First connect with a caller-supplied cursor — honour it.
      await doCatchUp();
    }

    let token: string;
    try {
      token = await options.getAuthToken();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (options.onError) options.onError(e, false);
      throw e;
    }

    const outcome = await openAndDrainStream({
      url,
      token,
      options,
      maxStreamSeconds,
      keepaliveGraceMs,
      emit,
      reconnectAttempt: reconnectCount,
    });

    if (outcome.aborted) {
      debug('[sse] external abort during stream — exiting cleanly');
      if (options.onError) options.onError(new Error('cancelled'), false);
      break;
    }

    if (outcome.terminalEvent) {
      terminalEvent = outcome.terminalEvent;
      debug(`[sse] terminal event received type=${terminalEvent.type}`);
      break;
    }

    if (outcome.unauthorized) {
      // One-shot refresh + retry. ``attempt`` does NOT count the 401 itself
      // toward exponential backoff, but if the retry also 401s we give up.
      if (!unauthorizedAlreadyRetried) {
        unauthorizedAlreadyRetried = true;
        debug('[sse] 401 received; forcing token refresh and retrying once');
        if (options.onError) {
          options.onError(new Error('token refresh triggered on 401'), true);
        }
        attempt += 1;
        reconnectCount += 1;
        if (options.onReconnecting) {
          options.onReconnecting(attempt, 'unauthorized_retry', 0);
        }
        continue; // skip backoff sleep — auth refresh is the dominant cost
      } else {
        const err = new CliError(
          'UNAUTHORIZED: AgentCore streaming endpoint rejected JWT after refresh. ' +
          'Run `bgagent login` to re-authenticate.',
        );
        if (options.onError) options.onError(err, false);
        throw err;
      }
    }

    // Any other reconnectable reason falls through here.
    const reason = outcome.reconnectReason ?? 'network_error';
    const err = outcome.error ?? new Error(`stream ended with reason=${reason}`);
    reconnectCount += 1;
    attempt += 1;
    const delay = computeBackoff(attempt - 1, backoff);
    debug(`[sse] scheduling reconnect attempt=${attempt} reason=${reason} delayMs=${delay}`);
    if (options.onError) options.onError(err, true);
    if (options.onReconnecting) options.onReconnecting(attempt, reason, delay);

    try {
      await abortableSleep(delay, options.signal);
    } catch {
      debug('[sse] external abort during backoff sleep — exiting');
      if (options.onError) options.onError(new Error('cancelled'), false);
      break;
    }
  }

  return {
    terminalEvent,
    reconnectCount,
    eventsReceived,
    eventsDeduplicated,
    totalDurationMs: Date.now() - startedAt,
  };
}

/* ------------------------------------------------------------------------ */
/*  Per-attempt stream machinery                                             */
/* ------------------------------------------------------------------------ */

interface StreamAttemptArgs {
  readonly url: string;
  readonly token: string;
  readonly options: SseClientOptions;
  readonly maxStreamSeconds: number;
  readonly keepaliveGraceMs: number;
  readonly emit: (ev: AgUiEvent) => void;
  readonly reconnectAttempt: number;
}

/**
 * Open a single SSE connection, drain it until it terminates or needs to
 * reconnect, and return the outcome. Never throws for reconnectable failures
 * — those are encoded in {@link StreamAttemptOutcome}.
 */
async function openAndDrainStream(args: StreamAttemptArgs): Promise<StreamAttemptOutcome> {
  const { url, token, options, maxStreamSeconds, keepaliveGraceMs, emit, reconnectAttempt } = args;

  const body = JSON.stringify({
    input: {
      task_id: options.taskId,
      ...(options.invocationInput ?? {}),
    },
  });

  // AgentCore Runtime requires `runtimeSessionId` >= 33 chars (verified by
  // error responses; matches cdk/src/handlers/shared/strategies/agentcore-
  // strategy.ts which uses randomUUID() = 36 chars). Task IDs are 26-char
  // ULIDs — too short. We prefix with a deterministic 'bgagent-watch-'
  // (14 chars) → 40 chars total. Determinism is load-bearing: reconnect
  // attempts must re-use the same session ID so AgentCore maps back to
  // the same microVM (preserving in-progress session state).
  const sessionId = buildRuntimeSessionId(options.taskId);

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
  };

  debug(
    `[sse] connecting url=${url} ` +
    `authorization=Bearer ${redactSuffix(token)} ` +
    `session=${sessionId} ` +
    `bodyBytes=${body.length} ` +
    `reconnectAttempt=${reconnectAttempt}`,
  );

  // AbortControllers: one for the HTTP request, one for the overall stream
  // lifecycle (so we can cancel independently from the external signal).
  const reqController = new AbortController();
  const externalSignal = options.signal;
  const onExternalAbort = () => reqController.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      reqController.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: reqController.signal,
    });
  } catch (err) {
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    if (externalSignal?.aborted) {
      return { aborted: true };
    }
    const e = err instanceof Error ? err : new Error(String(err));
    debug(`[sse] connect fetch threw: ${e.name}: ${e.message}`);
    return { reconnectReason: 'network_error', error: e };
  }

  debug(`[sse] connected status=${response.status} ${response.statusText}`);

  if (response.status === 401) {
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    // Fire-and-forget body cleanup — no value comes back, and waiting for the
    // cancel promise would block the caller's retry path unnecessarily.
    void response.body?.cancel().catch(() => { /* ignore cancel errors */ });
    return { unauthorized: true, error: new Error('401 Unauthorized') };
  }

  // 409 responses on the SSE path are terminal, not retryable.
  //
  // * RUN_ELSEWHERE (rev 5, §9.13.4) — server.py rejects SSE for tasks
  //   submitted via the orchestrator path. Surfacing as CliError lets
  //   `watch --transport auto` fall back to polling.
  // * Any other 409 (non-JSON body, unexpected shape, proxy-injected
  //   gateway error) — reconnect would just retry the same rejection
  //   indefinitely. Treat as terminal and surface the body in the error
  //   so the user / logs can see why the server refused.
  if (response.status === 409) {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      // If the body isn't readable, we still want 409 to be terminal —
      // just with less detail in the error message.
    }
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // Non-JSON 409 body — `parsed` stays undefined; fall through.
    }

    if (isApiError(parsed, 'RUN_ELSEWHERE')) {
      throw new CliError(
        'RUN_ELSEWHERE: task is running on a different runtime; '
        + 'falling back to polling.',
      );
    }
    // Unknown 409 — still terminal. Include a truncated body excerpt so
    // operators can see what the server said without flooding the log.
    const preview = bodyText.length > 500
      ? `${bodyText.slice(0, 500)}... (${bodyText.length} bytes total)`
      : bodyText;
    throw new CliError(
      `HTTP 409 from SSE endpoint (non-retriable); body: ${preview || '<empty>'}`,
    );
  }

  if (!response.ok) {
    const e = new Error(`HTTP ${response.status} ${response.statusText}`);
    debug(`[sse] non-ok response: ${e.message}`);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    void response.body?.cancel().catch(() => { /* ignore cancel errors */ });
    return { reconnectReason: 'http_error', error: e };
  }

  if (!response.body) {
    const e = new Error('Response has no body stream');
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    return { reconnectReason: 'http_error', error: e };
  }

  const streamStartedAt = Date.now();
  let lastByteAt = streamStartedAt;
  let lastRestartLogAt = streamStartedAt;
  let summary: EmissionSummary = {};
  let proactiveRestart = false;
  let keepaliveTimeout = false;

  const parser = createParser({
    onEvent: (msg) => {
      summary = processFrame(msg, emit, summary);
    },
    onError: (parseErr) => {
      // Parser-level errors are never fatal — log and drop the bad frame.
      debug(`[sse] parser error (skipping frame): ${parseErr.message}`);
      if (options.onError) options.onError(parseErr, true);
    },
    onComment: () => {
      // SSE comment frames (``: ping\n\n``) reset the keepalive timer via
      // the byte-level update below. Nothing else to do.
      debug('[sse] keepalive ping received');
    },
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  // Keepalive watchdog loop — runs concurrently with the reader.
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      if (Date.now() - lastByteAt >= keepaliveGraceMs) {
        debug(`[sse] keepalive watchdog fired — graceMs=${keepaliveGraceMs}`);
        keepaliveTimeout = true;
        reqController.abort();
      } else {
        scheduleWatchdog();
      }
    }, Math.max(keepaliveGraceMs - (Date.now() - lastByteAt), 100));
  };
  scheduleWatchdog();

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Proactive 60-minute restart check.
      const streamAgeMs = Date.now() - streamStartedAt;
      if (streamAgeMs >= maxStreamSeconds * 1000) {
        debug(`[sse] proactive restart triggered at ageMs=${streamAgeMs}`);
        proactiveRestart = true;
        reqController.abort();
        break;
      }
      if (streamAgeMs - (lastRestartLogAt - streamStartedAt) >= PROACTIVE_RESTART_LOG_INTERVAL_MS) {
        lastRestartLogAt = Date.now();
        const remainingMs = maxStreamSeconds * 1000 - streamAgeMs;
        debug(`[sse] proactive restart countdown remainingMs=${remainingMs}`);
      }

      const readResult = await reader.read();
      if (readResult.done) {
        debug('[sse] reader signalled done (stream closed by peer)');
        break;
      }
      lastByteAt = Date.now();
      const chunk = decoder.decode(readResult.value, { stream: true });
      parser.feed(chunk);

      if (summary.terminal) break;
    }
  } catch (err) {
    // AbortError is how we exit the read loop for keepalive/proactive/
    // external-abort paths. Distinguish them below.
    const e = err instanceof Error ? err : new Error(String(err));
    debug(`[sse] read loop exited via throw: ${e.name}: ${e.message}`);
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    try { reader.releaseLock(); } catch { /* ignore */ }
    try { await response.body.cancel(); } catch { /* ignore */ }
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }

  if (externalSignal?.aborted) {
    return { aborted: true };
  }
  if (summary.terminal) {
    return { terminalEvent: summary.terminal };
  }
  if (proactiveRestart) {
    return { reconnectReason: 'proactive_60min_restart' };
  }
  if (keepaliveTimeout) {
    return {
      reconnectReason: 'keepalive_timeout',
      error: new Error(`no data within ${keepaliveGraceMs}ms`),
    };
  }
  if (summary.nonTerminalRunError) {
    return {
      reconnectReason: 'non_terminal_run_error',
      error: new Error(`non-terminal RUN_ERROR: ${summary.nonTerminalRunError.code ?? 'unknown'}`),
    };
  }
  return { reconnectReason: 'stream_closed', error: new Error('stream ended without terminal event') };
}

/* ------------------------------------------------------------------------ */
/*  Per-frame handling                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Parse one SSE ``data:`` frame, validate against AG-UI schemas, classify it
 * (terminal / non-terminal RUN_ERROR / normal), emit to the consumer, and
 * return an updated summary.
 */
function processFrame(
  msg: EventSourceMessage,
  emit: (ev: AgUiEvent) => void,
  current: EmissionSummary,
): EmissionSummary {
  if (!msg.data) return current;

  let raw: unknown;
  try {
    raw = JSON.parse(msg.data);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    debug(`[sse] invalid JSON frame (skipping): ${e.message}`);
    return current;
  }

  // Fast path: sniff the type before running Zod. This lets us emit the raw
  // frame immediately for terminal events even if validation would fail on a
  // future AG-UI version's new optional field.
  const sniffedType = shallowEventType(raw);

  // Validate against the AG-UI discriminated union. Passthrough schemas
  // allow additional fields, so this is forgiving about extra attributes.
  const result = EventSchemas.safeParse(raw);
  let event: AgUiEvent;
  if (result.success) {
    event = result.data as AgUiEvent;
  } else {
    // Validation failed — fall back to the raw object if the shape is at
    // least object-with-type (so terminal detection still works). Surface
    // the validation error as onError via the parser callback path is not
    // available here; the caller's onError is wired at a higher level.
    if (sniffedType === null) {
      debug('[sse] frame missing "type" field — skipping');
      return current;
    }
    debug(`[sse] Zod validation failed for type=${sniffedType} — using raw frame`);
    event = raw as AgUiEvent;
  }

  const t = event.type;
  debug(`[sse] frame parsed type=${t} bytes=${msg.data.length}`);

  // Classify + emit.
  if (t === EventType.RUN_FINISHED) {
    emit(event);
    return { ...current, terminal: event };
  }
  if (t === EventType.RUN_ERROR) {
    const code = typeof event.code === 'string' ? event.code : '';
    const terminal = !code || TERMINAL_RUN_ERROR_CODES.has(code);
    emit(event);
    if (terminal) {
      return { ...current, terminal: event };
    }
    debug(`[sse] non-terminal RUN_ERROR code=${code} — will reconnect`);
    return { ...current, nonTerminalRunError: event };
  }
  emit(event);
  return current;
}
