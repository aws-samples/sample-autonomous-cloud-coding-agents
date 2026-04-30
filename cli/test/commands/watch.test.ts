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

import { ApiClient } from '../../src/api-client';
import { makeWatchCommand, nextCadence, renderEvent, transientRetryDelayMs } from '../../src/commands/watch';
import { loadConfig as loadConfigMocked } from '../../src/config';
import { ApiError, CliError } from '../../src/errors';
import { TaskEvent } from '../../src/types';

jest.mock('../../src/api-client');

// Config is mocked per-test.
jest.mock('../../src/config', () => ({
  loadConfig: jest.fn(),
}));

// Auth token fetch is stubbed — the real getAuthToken loads config + credentials.
jest.mock('../../src/auth', () => ({
  getAuthToken: jest.fn().mockResolvedValue('test-id-token'),
}));

const loadConfig = loadConfigMocked as jest.MockedFunction<typeof loadConfigMocked>;

/** Default config for polling tests. */
const CONFIG_POLLING = {
  api_url: 'https://api.example.com',
  region: 'us-east-1',
  user_pool_id: 'us-east-1_test',
  client_id: 'test-client-id',
};

// Helper to create a TaskEvent
function makeEvent(overrides: Partial<TaskEvent> & { event_type: string }): TaskEvent {
  const { event_id, event_type, timestamp, metadata, ...rest } = overrides;
  return {
    event_id: event_id ?? 'evt-001',
    event_type,
    timestamp: timestamp ?? '2026-04-16T12:00:00Z',
    metadata: metadata ?? {},
    ...rest,
  } as TaskEvent;
}

// ---------------------------------------------------------------------------
// renderEvent — formatting
// ---------------------------------------------------------------------------

describe('renderEvent', () => {
  test('renders agent_turn', () => {
    const event = makeEvent({
      event_type: 'agent_turn',
      metadata: { turn: 1, model: 'claude-4', tool_calls_count: 2, thinking_preview: 'hmm', text_preview: 'hello' },
    });
    const output = renderEvent(event);
    expect(output).toContain('Turn #1');
    expect(output).toContain('claude-4');
    expect(output).toContain('2 tool calls');
    expect(output).toContain('Thinking: hmm');
    expect(output).toContain('Text: hello');
  });

  test('renders agent_tool_call', () => {
    const event = makeEvent({
      event_type: 'agent_tool_call',
      metadata: { tool_name: 'Bash', tool_input_preview: 'ls -la', turn: 1 },
    });
    const output = renderEvent(event);
    expect(output).toContain('▶ Bash');
    expect(output).toContain('ls -la');
  });

  test('renders agent_tool_result', () => {
    const event = makeEvent({
      event_type: 'agent_tool_result',
      metadata: { tool_name: 'Bash', is_error: true, content_preview: 'not found', turn: 1 },
    });
    const output = renderEvent(event);
    expect(output).toContain('◀ Bash');
    expect(output).toContain('[ERROR]');
    expect(output).toContain('not found');
  });

  test('renders agent_tool_result without error flag', () => {
    const event = makeEvent({
      event_type: 'agent_tool_result',
      metadata: { tool_name: 'Bash', is_error: false, content_preview: 'ok', turn: 1 },
    });
    const output = renderEvent(event);
    expect(output).not.toContain('[ERROR]');
  });

  test('renders agent_milestone', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: { milestone: 'repo_setup_complete', details: 'branch=main' },
    });
    const output = renderEvent(event);
    expect(output).toContain('★ repo_setup_complete');
    expect(output).toContain('branch=main');
  });

  test('renders agent_cost_update', () => {
    const event = makeEvent({
      event_type: 'agent_cost_update',
      metadata: { cost_usd: 0.0512, input_tokens: 1000, output_tokens: 500, turn: 5 },
    });
    const output = renderEvent(event);
    expect(output).toContain('$0.0512');
    expect(output).toContain('1000 in');
    expect(output).toContain('500 out');
  });

  test('renders agent_error', () => {
    const event = makeEvent({
      event_type: 'agent_error',
      metadata: { error_type: 'RuntimeError', message_preview: 'something broke' },
    });
    const output = renderEvent(event);
    expect(output).toContain('✖ RuntimeError');
    expect(output).toContain('something broke');
  });

  test('renders unknown event type with JSON metadata', () => {
    const event = makeEvent({
      event_type: 'custom_event',
      metadata: { foo: 'bar' },
    });
    const output = renderEvent(event);
    expect(output).toContain('custom_event');
    expect(output).toContain('"foo"');
  });

  test('renders agent_turn with 1 tool call (singular)', () => {
    const event = makeEvent({
      event_type: 'agent_turn',
      metadata: { turn: 1, model: 'claude-4', tool_calls_count: 1 },
    });
    const output = renderEvent(event);
    expect(output).toContain('1 tool call)');
    expect(output).not.toContain('1 tool calls');
  });
});

// ---------------------------------------------------------------------------
// watch command — polling path
// ---------------------------------------------------------------------------

describe('watch command — polling', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
  const mockGetTaskEvents = jest.fn();
  const mockGetTask = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockGetTaskEvents.mockReset();
    mockGetTask.mockReset();
    loadConfig.mockReset();
    loadConfig.mockReturnValue(CONFIG_POLLING);
    process.exitCode = undefined;

    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: jest.fn(),
      listTasks: jest.fn(),
      getTask: mockGetTask,
      cancelTask: jest.fn(),
      getTaskEvents: mockGetTaskEvents,
      catchUpEvents: jest.fn().mockResolvedValue([]),
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  test('polls events and exits on terminal state', async () => {
    const events = [
      makeEvent({ event_id: 'evt-001', event_type: 'agent_milestone', metadata: { milestone: 'start', details: '' } }),
    ];

    mockGetTaskEvents.mockResolvedValue({
      data: events,
      pagination: { next_token: null, has_more: false },
    });
    mockGetTask.mockResolvedValue({ status: 'COMPLETED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-1']);

    expect(mockGetTaskEvents).toHaveBeenCalledWith('task-1', expect.objectContaining({ limit: 100 }));
    expect(mockGetTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ signal: expect.anything() }));
    expect(process.exitCode).toBe(0);
  });

  test('sets exit code 1 for FAILED task', async () => {
    mockGetTaskEvents.mockResolvedValue({
      data: [],
      pagination: { next_token: null, has_more: false },
    });
    mockGetTask.mockResolvedValue({ status: 'FAILED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-2']);

    expect(process.exitCode).toBe(1);
  });

  test('does not re-display already seen events', async () => {
    // Snapshot returns 2 events + status=RUNNING; polling then catches up
    // with exactly the 1 new event past the cursor, then COMPLETED.
    const snapshotEvents = [
      makeEvent({ event_id: 'evt-001', event_type: 'agent_milestone', metadata: { milestone: 'repo_setup', details: '' } }),
      makeEvent({ event_id: 'evt-002', event_type: 'agent_turn', metadata: { turn: 1, model: 'c4', tool_calls_count: 0 } }),
    ];
    const newEvent = makeEvent({
      event_id: 'evt-003',
      event_type: 'agent_milestone',
      metadata: { milestone: 'done', details: '' },
    });

    mockGetTaskEvents.mockResolvedValue({
      data: snapshotEvents,
      pagination: { next_token: null, has_more: false },
    });

    const mockCatchUpEvents = jest.fn().mockResolvedValue([newEvent]);
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: jest.fn(),
      listTasks: jest.fn(),
      getTask: mockGetTask,
      cancelTask: jest.fn(),
      getTaskEvents: mockGetTaskEvents,
      catchUpEvents: mockCatchUpEvents,
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
    }) as unknown as ApiClient);

    let taskPollCount = 0;
    mockGetTask.mockImplementation(async () => {
      taskPollCount++;
      return { status: taskPollCount >= 2 ? 'COMPLETED' : 'RUNNING' };
    });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-dedup']);

    // Snapshot prints 2, catchUp returns 1 → 3 total console.log calls.
    expect(consoleSpy.mock.calls.length).toBe(3);
    // catchUp must be called with the snapshot's last event_id as the cursor.
    // Chunk H added a ``{signal}`` trailing arg for Ctrl+C propagation.
    expect(mockCatchUpEvents).toHaveBeenCalledWith(
      'task-dedup',
      'evt-002',
      100,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  test('polling drains all events past the 100-item page limit (regression: BLOCKER silent-stall)', async () => {
    // Snapshot returns the first 100 events; server reports has_more=true.
    // Polling must call catchUpEvents(taskId, 'evt-100'), which drains the
    // tail. Regression guard for the silent-stall bug where watch passed
    // {limit: 100} with no after-cursor and the server replayed the same
    // oldest 100 events forever.
    const snapshotEvents = Array.from({ length: 100 }, (_, i) =>
      makeEvent({
        event_id: `evt-${String(i + 1).padStart(3, '0')}`,
        event_type: 'agent_milestone',
        metadata: { milestone: `m${i + 1}`, details: '' },
      }),
    );
    const tailEvents = Array.from({ length: 50 }, (_, i) =>
      makeEvent({
        event_id: `evt-${String(i + 101).padStart(3, '0')}`,
        event_type: 'agent_milestone',
        metadata: { milestone: `m${i + 101}`, details: '' },
      }),
    );

    mockGetTaskEvents.mockResolvedValue({
      data: snapshotEvents,
      pagination: { next_token: 'token-after-100', has_more: true },
    });

    const mockCatchUpEvents = jest.fn().mockResolvedValue(tailEvents);
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: jest.fn(),
      listTasks: jest.fn(),
      getTask: mockGetTask,
      cancelTask: jest.fn(),
      getTaskEvents: mockGetTaskEvents,
      catchUpEvents: mockCatchUpEvents,
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
    }) as unknown as ApiClient);

    let taskPollCount = 0;
    mockGetTask.mockImplementation(async () => {
      taskPollCount++;
      return { status: taskPollCount >= 2 ? 'COMPLETED' : 'RUNNING' };
    });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-big']);

    // Snapshot prints 100 events, catchUp returns the 50-event tail.
    expect(consoleSpy.mock.calls.length).toBe(150);
    expect(mockCatchUpEvents).toHaveBeenCalledWith(
      'task-big',
      'evt-100',
      100,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  test('outputs JSON when --output json', async () => {
    const event = makeEvent({ event_id: 'evt-001', event_type: 'agent_milestone', metadata: { milestone: 'test', details: '' } });
    mockGetTaskEvents.mockResolvedValue({
      data: [event],
      pagination: { next_token: null, has_more: false },
    });
    mockGetTask.mockResolvedValue({ status: 'COMPLETED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-json', '--output', 'json']);

    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.event_type).toBe('agent_milestone');
  });

  test('shows stderr message for terminal state', async () => {
    mockGetTaskEvents.mockResolvedValue({
      data: [],
      pagination: { next_token: null, has_more: false },
    });
    mockGetTask.mockResolvedValue({ status: 'COMPLETED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-done']);

    const stderrOutput = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(stderrOutput).toContain('completed');
  });

  test('prints snapshot tail + exit 0 when task already COMPLETED', async () => {
    const tail = [
      makeEvent({ event_id: 'evt-001', event_type: 'agent_milestone', metadata: { milestone: 'done', details: 'ok' } }),
    ];
    mockGetTaskEvents.mockResolvedValue({
      data: tail,
      pagination: { next_token: null, has_more: false },
    });
    mockGetTask.mockResolvedValue({ status: 'COMPLETED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-already-done']);

    // The snapshot event should have been rendered exactly once.
    const stdout = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(stdout).toContain('done');
    expect(process.exitCode).toBe(0);
  });

  test('prints snapshot tail + exit 1 when task already FAILED', async () => {
    mockGetTaskEvents.mockResolvedValue({
      data: [],
      pagination: { next_token: null, has_more: false },
    });
    mockGetTask.mockResolvedValue({ status: 'FAILED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-already-failed']);

    expect(process.exitCode).toBe(1);
  });

  // -------- Chunk H: transient retry + abort propagation --------

  test('retries transient 5xx on getTaskEvents and exits cleanly when the next call succeeds', async () => {
    // Empty snapshot → polling loop fires getTaskEvents. First call 503s,
    // retry succeeds with an empty page, then the task-detail poll returns
    // COMPLETED. The command must exit 0, not propagate the 503.
    mockGetTaskEvents
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } }) // snapshot
      .mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'svc down', 'req-1'))
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } });

    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING' }) // snapshot
      .mockResolvedValueOnce({ status: 'COMPLETED' }); // after retry succeeded

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-retry-5xx']);

    expect(process.exitCode).toBe(0);
    // Three getTaskEvents calls total: snapshot, failed, retry-succeeded.
    expect(mockGetTaskEvents).toHaveBeenCalledTimes(3);
  });

  test('does not retry on 4xx — deterministic errors propagate immediately', async () => {
    // Snapshot succeeds with RUNNING; the first poll returns a 403 which is
    // deterministic. The command must surface it without retrying.
    mockGetTaskEvents
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } })
      .mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'nope', 'req-1'));

    mockGetTask.mockResolvedValueOnce({ status: 'RUNNING' });

    const cmd = makeWatchCommand();
    await expect(cmd.parseAsync(['node', 'test', 'task-403'])).rejects.toThrow();

    // Exactly one failing poll after the snapshot; no retries on 4xx.
    expect(mockGetTaskEvents).toHaveBeenCalledTimes(2);
  });

  test('does not retry on 401 auth-expired — surfaces login hint immediately', async () => {
    // A token that expires mid-session previously got silently retried 5
    // times then presented with a misleading "re-run to resume" message.
    // The retry classifier must treat 401 as non-transient so the user
    // sees the real ``bgagent login`` hint on the first failure.
    mockGetTaskEvents
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } })
      .mockRejectedValueOnce(new ApiError(401, 'UNAUTHORIZED', 'token expired', 'req-1'));

    mockGetTask.mockResolvedValueOnce({ status: 'RUNNING' });

    const cmd = makeWatchCommand();
    await expect(cmd.parseAsync(['node', 'test', 'task-401'])).rejects.toThrow(/token expired/);
    expect(mockGetTaskEvents).toHaveBeenCalledTimes(2);
  });

  test('does not retry on CliError (programmer / contract violation) — propagates first failure', async () => {
    // Whitelist contract: only 5xx ApiError + TypeError('fetch failed')
    // retry. Everything else (including our own CliError) is terminal so
    // real bugs surface immediately instead of hiding behind 5 silent
    // retries.
    mockGetTaskEvents
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } })
      .mockRejectedValueOnce(new CliError('bad response shape'));

    mockGetTask.mockResolvedValueOnce({ status: 'RUNNING' });

    const cmd = makeWatchCommand();
    await expect(cmd.parseAsync(['node', 'test', 'task-cli-err'])).rejects.toThrow(/bad response shape/);
    expect(mockGetTaskEvents).toHaveBeenCalledTimes(2);
  });

  test('SIGINT mid-poll sets exit code 130 (POSIX convention)', async () => {
    // Snapshot succeeds with RUNNING; the first poll's getTaskEvents is
    // set up to fire SIGINT on the *next* event loop tick before it
    // resolves. The poll loop should check signal.aborted and exit via
    // the aborted branch — process.exitCode must be 130, not 0/1.
    mockGetTaskEvents
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } }) // snapshot
      .mockImplementationOnce(async () => {
        // Fire SIGINT just before returning so the poll loop sees
        // signal.aborted === true after the await.
        process.emit('SIGINT' as never);
        return { data: [], pagination: { next_token: null, has_more: false } };
      });

    mockGetTask.mockResolvedValue({ status: 'RUNNING' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-sigint']);

    expect(process.exitCode).toBe(130);
  });

  test('exhausted retry budget throws a "re-run to resume" message', async () => {
    // Snapshot succeeds; then every subsequent events call fails with 503.
    // Budget is 5 retries, so the command must reject with a clear message
    // pointing the user back at ``bgagent watch``. We stub ``setTimeout``
    // globally to run synchronously so the jittered backoff sleeps don't
    // blow the Jest timeout.
    const realSetTimeout = global.setTimeout;
    // Run every scheduled timer on the next microtask — retry sleeps +
    // cadence sleeps both resolve promptly so the poll loop can churn
    // through the failure budget without blowing the Jest timeout. Using
    // ``queueMicrotask`` (rather than a synchronous ``fn()``) preserves
    // the callback/handler ordering the real implementation expects
    // inside ``abortableSleep``.
    global.setTimeout = ((fn: () => void) => {
      queueMicrotask(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;
    try {
      mockGetTaskEvents.mockResolvedValueOnce({
        data: [],
        pagination: { next_token: null, has_more: false },
      });
      // MAX_TRANSIENT_RETRIES = 5 → 1 initial failure + 5 retries = 6 total.
      // Queuing exactly 6 makes the test's intent obvious.
      for (let i = 0; i < 6; i += 1) {
        mockGetTaskEvents.mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'svc down', `req-${i}`));
      }

      mockGetTask.mockResolvedValueOnce({ status: 'RUNNING' });

      const cmd = makeWatchCommand();
      await expect(cmd.parseAsync(['node', 'test', 'task-503-storm'])).rejects.toThrow(
        /Exceeded retry budget.*Re-run .bgagent watch/,
      );
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  test('SIGINT during initial snapshot exits 130 without logging a failure', async () => {
    // Snapshot-level abort must surface as exit 130, NOT as an
    // "Initial snapshot failed: The operation was aborted" error log.
    // The snapshot mock throws an AbortError after the user interrupt.
    mockGetTaskEvents.mockImplementationOnce(async () => {
      process.emit('SIGINT' as never);
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    mockGetTask.mockResolvedValue({ status: 'RUNNING' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-snap-abort']);

    expect(process.exitCode).toBe(130);
    const stderrOutput = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(stderrOutput).not.toMatch(/Initial snapshot failed/);
  });

  test('non-abort error during snapshot still propagates with its original message', async () => {
    // Race guard: a real error (e.g. token expired) during snapshot
    // must NOT be swallowed by the exit-130 path even if the user
    // coincidentally hits Ctrl+C at the same moment. The snapshot
    // catch branch only honors 130 for actual AbortError from our
    // signal; other errors carry their ``bgagent login`` hint through.
    mockGetTaskEvents.mockRejectedValueOnce(
      new ApiError(401, 'UNAUTHORIZED', 'token expired (UNAUTHORIZED)\nHint: Run `bgagent login`', 'req-1'),
    );
    mockGetTask.mockRejectedValueOnce(
      new ApiError(401, 'UNAUTHORIZED', 'token expired (UNAUTHORIZED)\nHint: Run `bgagent login`', 'req-2'),
    );

    const cmd = makeWatchCommand();
    await expect(cmd.parseAsync(['node', 'test', 'task-real-err'])).rejects.toThrow(/token expired/);
    // Must NOT have exited 130 — real errors win over coincidental abort.
    expect(process.exitCode).not.toBe(130);
  });

  test('SIGINT after terminal status lands still honors exit 130 (POSIX contract)', async () => {
    // If the user Ctrl+Cs between onTerminal firing and the command
    // resolving, their intent to interrupt is the load-bearing signal.
    // The ``signal.aborted`` check must come before ``finalStatus`` so
    // shells see 130, not 0.
    mockGetTaskEvents
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } }) // snapshot
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } }); // first poll

    // Task returns COMPLETED on first poll; we abort during the
    // task-detail call so ``finalStatus`` AND ``signal.aborted`` are
    // both set by the time runPolling evaluates its exit-code block.
    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING' }) // snapshot
      .mockImplementationOnce(async () => {
        process.emit('SIGINT' as never);
        return { status: 'COMPLETED' };
      });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-sigint-vs-terminal']);

    expect(process.exitCode).toBe(130);
  });
});

// ---------------------------------------------------------------------------
// Chunk H: transient retry jitter — pure function
// ---------------------------------------------------------------------------

describe('transientRetryDelayMs (equal-jitter backoff)', () => {
  test('never returns 0 — equal-jitter floor prevents retry storms', () => {
    // Self-DOS guard: a full-jitter impl (``Math.random() * base``)
    // can produce 0 delays and tight-loop a degraded service. Equal
    // jitter pins at least half the base delay as a fixed floor.
    // Sample enough attempts and values to catch any leak.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      for (let i = 0; i < 200; i += 1) {
        const ms = transientRetryDelayMs(attempt);
        expect(ms).toBeGreaterThan(0);
      }
    }
  });

  test('respects the 5000 ms ladder ceiling', () => {
    for (let i = 0; i < 200; i += 1) {
      // Attempt 10 would produce base = 500 * 1024 if unbounded.
      expect(transientRetryDelayMs(10)).toBeLessThanOrEqual(5_000);
    }
  });
});

// ---------------------------------------------------------------------------
// Chunk H: adaptive cadence state machine — pure function
// ---------------------------------------------------------------------------

describe('nextCadence (adaptive polling state)', () => {
  test('stays at 500 ms when events are arriving', () => {
    const s0 = { intervalMs: 500, consecutiveEmptyPolls: 0 };
    const s1 = nextCadence(s0, true);
    expect(s1).toEqual({ intervalMs: 500, consecutiveEmptyPolls: 0 });
  });

  test('climbs the backoff ladder on consecutive empty polls', () => {
    // Ladder is 1 s → 2 s → 5 s and caps at 5 s.
    let s = { intervalMs: 500, consecutiveEmptyPolls: 0 };
    s = nextCadence(s, false);
    expect(s).toEqual({ intervalMs: 1_000, consecutiveEmptyPolls: 1 });
    s = nextCadence(s, false);
    expect(s).toEqual({ intervalMs: 2_000, consecutiveEmptyPolls: 2 });
    s = nextCadence(s, false);
    expect(s).toEqual({ intervalMs: 5_000, consecutiveEmptyPolls: 3 });
    // Further empty polls stay pinned at the cap — don't escalate beyond 5 s.
    s = nextCadence(s, false);
    expect(s).toEqual({ intervalMs: 5_000, consecutiveEmptyPolls: 4 });
  });

  test('resets to fast cadence on the next event, regardless of how deep the backoff was', () => {
    const deepBackoff = { intervalMs: 5_000, consecutiveEmptyPolls: 7 };
    const reset = nextCadence(deepBackoff, true);
    expect(reset).toEqual({ intervalMs: 500, consecutiveEmptyPolls: 0 });
  });
});
