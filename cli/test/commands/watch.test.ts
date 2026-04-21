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
import { makeWatchCommand, renderEvent } from '../../src/commands/watch';
import { loadConfig as loadConfigMocked } from '../../src/config';
import { CliError } from '../../src/errors';
import { AgUiEvent, SseClientOptions, runSseClient as runSseClientMocked } from '../../src/sse-client';
import { TaskEvent } from '../../src/types';

jest.mock('../../src/api-client');

// Config is mocked per-test to toggle runtime_jwt_arn presence.
jest.mock('../../src/config', () => ({
  loadConfig: jest.fn(),
}));

// Mock the SSE client module so we can assert on its invocation options.
jest.mock('../../src/sse-client', () => {
  const actual = jest.requireActual('../../src/sse-client');
  return {
    ...actual,
    runSseClient: jest.fn(),
  };
});

// Auth token fetch is stubbed — the real getAuthToken loads config + credentials.
jest.mock('../../src/auth', () => ({
  getAuthToken: jest.fn().mockResolvedValue('test-id-token'),
}));

const loadConfig = loadConfigMocked as jest.MockedFunction<typeof loadConfigMocked>;
const runSseClient = runSseClientMocked as jest.MockedFunction<typeof runSseClientMocked>;

/** Default config without runtime_jwt_arn (Phase 1a-compatible). */
const CONFIG_POLLING = {
  api_url: 'https://api.example.com',
  region: 'us-east-1',
  user_pool_id: 'us-east-1_test',
  client_id: 'test-client-id',
};

/** Config with runtime_jwt_arn present — SSE auto/sse modes will use it. */
const CONFIG_WITH_SSE = {
  ...CONFIG_POLLING,
  runtime_jwt_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/abca_agent_jwt-XYZ',
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
    expect(output).toContain('\u25B6 Bash');
    expect(output).toContain('ls -la');
  });

  test('renders agent_tool_result', () => {
    const event = makeEvent({
      event_type: 'agent_tool_result',
      metadata: { tool_name: 'Bash', is_error: true, content_preview: 'not found', turn: 1 },
    });
    const output = renderEvent(event);
    expect(output).toContain('\u25C0 Bash');
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
    expect(output).toContain('\u2605 repo_setup_complete');
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
    expect(output).toContain('\u2716 RuntimeError');
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
// watch command — polling path (Phase 1a parity)
// ---------------------------------------------------------------------------

describe('watch command — polling (Phase 1a parity)', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
  const mockGetTaskEvents = jest.fn();
  const mockGetTask = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockGetTaskEvents.mockReset();
    mockGetTask.mockReset();
    runSseClient.mockReset();
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

    expect(mockGetTaskEvents).toHaveBeenCalledWith('task-1', { limit: 100 });
    expect(mockGetTask).toHaveBeenCalledWith('task-1');
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
    // Snapshot returns 2 events + status=RUNNING; polling then adds 1 more + COMPLETED.
    const firstEvents = [
      makeEvent({ event_id: 'evt-001', event_type: 'agent_milestone', metadata: { milestone: 'repo_setup', details: '' } }),
      makeEvent({ event_id: 'evt-002', event_type: 'agent_turn', metadata: { turn: 1, model: 'c4', tool_calls_count: 0 } }),
    ];
    const secondEvents = [
      ...firstEvents,
      makeEvent({ event_id: 'evt-003', event_type: 'agent_milestone', metadata: { milestone: 'done', details: '' } }),
    ];

    let pollCount = 0;
    mockGetTaskEvents.mockImplementation(async () => {
      pollCount++;
      return {
        data: pollCount === 1 ? firstEvents : secondEvents,
        pagination: { next_token: null, has_more: false },
      };
    });

    let taskPollCount = 0;
    mockGetTask.mockImplementation(async () => {
      taskPollCount++;
      return { status: taskPollCount >= 2 ? 'COMPLETED' : 'RUNNING' };
    });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-dedup']);

    // Snapshot prints 2, polling iteration adds 1 → 3 total console.log calls.
    expect(consoleSpy.mock.calls.length).toBe(3);
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
});

// ---------------------------------------------------------------------------
// watch command — transport resolution and SSE wiring (Phase 1b Step 6)
// ---------------------------------------------------------------------------

describe('watch command — transport resolution', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  const mockGetTaskEvents = jest.fn();
  const mockGetTask = jest.fn();
  const mockCatchUpEvents = jest.fn();

  beforeEach(() => {
    stdoutWrites = [];
    stderrWrites = [];
    consoleSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
      stdoutWrites.push(args.map(a => String(a)).join(' '));
    });
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    mockGetTaskEvents.mockReset();
    mockGetTask.mockReset();
    mockCatchUpEvents.mockReset();
    runSseClient.mockReset();
    loadConfig.mockReset();
    process.exitCode = undefined;

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

    // Default snapshot: empty events + RUNNING status so the code enters live
    // streaming. Individual tests override as needed.
    mockGetTaskEvents.mockResolvedValue({
      data: [],
      pagination: { next_token: null, has_more: false },
    });
    // Default snapshot: interactive mode so SSE is attempted (this describe
    // exercises the SSE code path). Tests that specifically want polling
    // override mockGetTask with execution_mode: 'orchestrator' or null.
    mockGetTask.mockResolvedValue({ status: 'RUNNING', execution_mode: 'interactive' });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  const joinStderr = () => stderrWrites.join('');

  // -----------------------------------------------------------------------
  // Test 1: --transport sse happy path
  // -----------------------------------------------------------------------
  test('--transport sse: happy path — events flow to formatter, exit 0', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);

    // Mock runSseClient: call onEvent twice, then resolve with terminalEvent.
    runSseClient.mockImplementation(async (opts: SseClientOptions) => {
      // Simulate a milestone event arriving over SSE.
      opts.onEvent({
        type: 'STEP_FINISHED',
        id: 'evt-001:step-finished',
        timestamp: Date.parse('2026-04-18T12:00:00Z'),
        stepName: 'repo_ready',
        details: 'branch=main',
      });
      // Terminal RUN_FINISHED.
      opts.onEvent({
        type: 'RUN_FINISHED',
        id: 'run-finish',
        runId: 'task-sse-1',
      });
      return {
        terminalEvent: {
          type: 'RUN_FINISHED',
          id: 'run-finish',
          runId: 'task-sse-1',
        } as AgUiEvent,
        reconnectCount: 0,
        eventsReceived: 2,
        eventsDeduplicated: 0,
        totalDurationMs: 42,
      };
    });

    // After SSE terminates the command calls getTask to get authoritative status.
    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING', execution_mode: 'interactive' }) // snapshot
      .mockResolvedValueOnce({ status: 'COMPLETED' }); // post-SSE

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-sse-1', '--transport', 'sse']);

    expect(runSseClient).toHaveBeenCalledTimes(1);
    // Formatter rendered the STEP_FINISHED as agent_milestone.
    expect(stdoutWrites.some(l => l.includes('repo_ready'))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 2: --transport sse unrecoverable failure → exit 1
  // -----------------------------------------------------------------------
  test('--transport sse: unrecoverable failure → exit 1 with error message', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    runSseClient.mockRejectedValue(new CliError('UNAUTHORIZED: token rejected'));

    const cmd = makeWatchCommand();
    await expect(
      cmd.parseAsync(['node', 'test', 'task-sse-fail', '--transport', 'sse']),
    ).rejects.toThrow(/UNAUTHORIZED/);

    expect(joinStderr()).toMatch(/ERROR.*SSE transport failed/);
  });

  // -----------------------------------------------------------------------
  // Test 3: --transport auto happy SSE path
  // -----------------------------------------------------------------------
  test('--transport auto: SSE works → no fallback, polling never invoked', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    runSseClient.mockImplementation(async (opts: SseClientOptions) => {
      opts.onEvent({
        type: 'RUN_FINISHED',
        runId: 'task-auto-ok',
        id: 'rf',
      });
      return {
        terminalEvent: { type: 'RUN_FINISHED', runId: 'task-auto-ok' } as AgUiEvent,
        reconnectCount: 0,
        eventsReceived: 1,
        eventsDeduplicated: 0,
        totalDurationMs: 1,
      };
    });
    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING', execution_mode: 'interactive' })
      .mockResolvedValueOnce({ status: 'COMPLETED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-auto-ok', '--transport', 'auto']);

    expect(runSseClient).toHaveBeenCalledTimes(1);
    // Polling would have required a second getTaskEvents call; there was only
    // one (the snapshot).
    expect(mockGetTaskEvents).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 4: --transport auto SSE fails → falls back to polling
  // -----------------------------------------------------------------------
  test('--transport auto: SSE fails → WARN + polling fallback completes task', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    runSseClient.mockRejectedValue(new Error('ECONNREFUSED'));

    // After fallback, polling: one more getTaskEvents + getTask → COMPLETED.
    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING', execution_mode: 'interactive' }) // snapshot
      .mockResolvedValueOnce({ status: 'COMPLETED' }); // polling

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-auto-fallback', '--transport', 'auto']);

    expect(runSseClient).toHaveBeenCalledTimes(1);
    expect(joinStderr()).toMatch(/WARN.*falling back to polling/);
    // Polling ran: snapshot + poll iteration = 2 getTaskEvents calls.
    expect(mockGetTaskEvents.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(process.exitCode).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 5: --transport polling never invokes runSseClient
  // -----------------------------------------------------------------------
  test('--transport polling: explicit polling never calls runSseClient', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE); // even with ARN, polling wins
    // Snapshot: RUNNING (so resolveTransport actually runs); poll: COMPLETED.
    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING', execution_mode: 'interactive' })
      .mockResolvedValueOnce({ status: 'COMPLETED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-poll', '--transport', 'polling']);

    expect(runSseClient).not.toHaveBeenCalled();
    expect(joinStderr()).toMatch(/Using polling transport/);
  });

  // -----------------------------------------------------------------------
  // Test 6: Missing runtime_jwt_arn + --transport auto → WARN + polling
  // -----------------------------------------------------------------------
  test('--transport auto without runtime_jwt_arn: WARN + falls back to polling', async () => {
    loadConfig.mockReturnValue(CONFIG_POLLING);
    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING', execution_mode: 'interactive' }) // snapshot
      .mockResolvedValueOnce({ status: 'COMPLETED' }); // polling

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-no-arn', '--transport', 'auto']);

    expect(runSseClient).not.toHaveBeenCalled();
    expect(joinStderr()).toMatch(/WARN.*runtime_jwt_arn.*not configured/);
  });

  // -----------------------------------------------------------------------
  // Test 7: Missing runtime_jwt_arn + --transport sse → error exit 1
  // -----------------------------------------------------------------------
  test('--transport sse without runtime_jwt_arn: error exit 1 with configure hint', async () => {
    loadConfig.mockReturnValue(CONFIG_POLLING);

    const cmd = makeWatchCommand();
    await expect(
      cmd.parseAsync(['node', 'test', 'task-no-arn-sse', '--transport', 'sse']),
    ).rejects.toThrow(/runtime_jwt_arn/);

    expect(joinStderr()).toMatch(/ERROR.*SSE transport requires.*runtime_jwt_arn/);
    expect(joinStderr()).toMatch(/bgagent configure --runtime-jwt-arn/);
    expect(runSseClient).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 8: Task already COMPLETED on start → prints tail, no SSE, exit 0
  // -----------------------------------------------------------------------
  test('already-COMPLETED task: prints snapshot tail, no SSE, exit 0', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
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

    expect(runSseClient).not.toHaveBeenCalled();
    expect(stdoutWrites.some(l => l.includes('done'))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 8b: RUN_ELSEWHERE guard (rev 5) — orchestrator-mode task skips SSE
  // -----------------------------------------------------------------------
  test('orchestrator-mode task with --transport auto: skips SSE, uses polling', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    mockGetTaskEvents.mockResolvedValueOnce({
      data: [makeEvent({ event_id: 'evt-1', event_type: 'agent_milestone', metadata: { milestone: 'start', details: '' } })],
      pagination: { next_token: null, has_more: false },
    });
    mockGetTaskEvents.mockResolvedValue({
      data: [makeEvent({ event_id: 'evt-1', event_type: 'agent_milestone', metadata: { milestone: 'start', details: '' } })],
      pagination: { next_token: null, has_more: false },
    });
    // Snapshot returns RUNNING + execution_mode=orchestrator — polling path.
    mockGetTask.mockResolvedValueOnce({ status: 'RUNNING', execution_mode: 'orchestrator' });
    mockGetTask.mockResolvedValueOnce({ status: 'COMPLETED', execution_mode: 'orchestrator' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-orch', '--transport', 'auto']);

    // SSE must NOT be attempted — avoids the 424 reconnect storm.
    expect(runSseClient).not.toHaveBeenCalled();
    expect(joinStderr()).toMatch(/execution_mode=orchestrator/);
    expect(process.exitCode).toBe(0);
  });

  test('legacy task (null execution_mode) with --transport auto: defaults to polling', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    mockGetTaskEvents.mockResolvedValue({
      data: [],
      pagination: { next_token: null, has_more: false },
    });
    // No execution_mode field at all — legacy task.
    mockGetTask.mockResolvedValueOnce({ status: 'RUNNING' });
    mockGetTask.mockResolvedValueOnce({ status: 'COMPLETED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-legacy', '--transport', 'auto']);

    expect(runSseClient).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 9: Task already FAILED on start → prints tail, no SSE, exit 1
  // -----------------------------------------------------------------------
  test('already-FAILED task: prints snapshot tail, no SSE, exit 1', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    mockGetTaskEvents.mockResolvedValue({
      data: [],
      pagination: { next_token: null, has_more: false },
    });
    mockGetTask.mockResolvedValue({ status: 'FAILED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-already-failed']);

    expect(runSseClient).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 10: SIGINT during SSE → abort propagates, clean exit
  // -----------------------------------------------------------------------
  test('SIGINT during SSE: abort signal is forwarded to runSseClient', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    let capturedSignal: AbortSignal | undefined;
    runSseClient.mockImplementation(async (opts: SseClientOptions) => {
      capturedSignal = opts.signal;
      return {
        terminalEvent: null,
        reconnectCount: 0,
        eventsReceived: 0,
        eventsDeduplicated: 0,
        totalDurationMs: 1,
      };
    });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-sigint', '--transport', 'sse']);

    expect(capturedSignal).toBeDefined();
    // The signal was a real AbortSignal wired from the watch command's controller.
    expect(typeof capturedSignal?.aborted).toBe('boolean');
  });

  // -----------------------------------------------------------------------
  // Test 11: --output json — events go to stdout, logs go to stderr
  // -----------------------------------------------------------------------
  test('--output json: events on stdout, logs on stderr', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    runSseClient.mockImplementation(async (opts: SseClientOptions) => {
      opts.onEvent({
        type: 'STEP_FINISHED',
        id: 'evt-42:step-finished',
        timestamp: Date.parse('2026-04-18T12:00:00Z'),
        stepName: 'json_stream_test',
        details: '',
      });
      return {
        terminalEvent: { type: 'RUN_FINISHED', runId: 'x' } as AgUiEvent,
        reconnectCount: 0,
        eventsReceived: 1,
        eventsDeduplicated: 0,
        totalDurationMs: 1,
      };
    });
    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING', execution_mode: 'interactive' })
      .mockResolvedValueOnce({ status: 'COMPLETED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync([
      'node', 'test', 'task-json-sse',
      '--transport', 'sse',
      '--output', 'json',
    ]);

    // stdout should contain pure NDJSON (parseable per line).
    const nonEmptyStdout = stdoutWrites.filter(l => l.trim().length > 0);
    for (const line of nonEmptyStdout) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // Parsed event is the semantic form.
    const parsed = JSON.parse(nonEmptyStdout[0]);
    expect(parsed.event_type).toBe('agent_milestone');
    expect(parsed.metadata.milestone).toBe('json_stream_test');

    // Log messages (like "Using SSE transport") should NOT be on stdout.
    expect(nonEmptyStdout.every(l => !l.includes('Using SSE transport'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 12: exit code 0 on RUN_FINISHED + COMPLETED
  // -----------------------------------------------------------------------
  test('exit code 0 on RUN_FINISHED + COMPLETED final status', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    runSseClient.mockResolvedValue({
      terminalEvent: { type: 'RUN_FINISHED', runId: 'r' } as AgUiEvent,
      reconnectCount: 0,
      eventsReceived: 1,
      eventsDeduplicated: 0,
      totalDurationMs: 1,
    });
    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING', execution_mode: 'interactive' })
      .mockResolvedValueOnce({ status: 'COMPLETED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-exit-0', '--transport', 'sse']);
    expect(process.exitCode).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 13: exit code 1 on RUN_ERROR / FAILED
  // -----------------------------------------------------------------------
  test('exit code 1 on RUN_ERROR + FAILED final status', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    runSseClient.mockResolvedValue({
      terminalEvent: {
        type: 'RUN_ERROR',
        runId: 'r',
        code: 'AGENT_ERROR',
        message: 'agent broke',
      } as AgUiEvent,
      reconnectCount: 0,
      eventsReceived: 1,
      eventsDeduplicated: 0,
      totalDurationMs: 1,
    });
    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING', execution_mode: 'interactive' })
      .mockResolvedValueOnce({ status: 'FAILED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-exit-1', '--transport', 'sse']);
    expect(process.exitCode).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 14: catch-up events all carry id (verified via mocked catchUp closure)
  // -----------------------------------------------------------------------
  test('catch-up: every AG-UI event from translator carries an id', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);

    // Seed catchUpEvents to return a mix of semantic event types.
    mockCatchUpEvents.mockResolvedValue([
      makeEvent({ event_id: 'evt-AAA', event_type: 'agent_turn', metadata: { turn: 1, text_preview: 'x', tool_calls_count: 0, model: 'c4' } }),
      makeEvent({ event_id: 'evt-BBB', event_type: 'agent_tool_call', metadata: { tool_name: 'Bash', tool_input_preview: 'ls', turn: 1 } }),
      makeEvent({ event_id: 'evt-CCC', event_type: 'agent_milestone', metadata: { milestone: 'm', details: '' } }),
    ]);

    let capturedCatchUp: ((afterEventId: string) => Promise<AgUiEvent[]>) | undefined;
    runSseClient.mockImplementation(async (opts: SseClientOptions) => {
      capturedCatchUp = opts.catchUp;
      return {
        terminalEvent: { type: 'RUN_FINISHED', runId: 'r' } as AgUiEvent,
        reconnectCount: 0,
        eventsReceived: 0,
        eventsDeduplicated: 0,
        totalDurationMs: 1,
      };
    });
    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING', execution_mode: 'interactive' })
      .mockResolvedValueOnce({ status: 'COMPLETED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-catchup', '--transport', 'sse']);

    expect(capturedCatchUp).toBeDefined();
    // Invoke the captured catchUp as runSseClient would.
    const results = await capturedCatchUp!('evt-000');
    expect(results.length).toBeGreaterThan(0);
    // Every AG-UI event must carry an id derived from the DDB event_id.
    for (const ev of results) {
      expect(typeof ev.id).toBe('string');
      expect((ev.id as string).length).toBeGreaterThan(0);
    }
    // At least one id should start with each semantic row's event_id.
    const idPrefixes = new Set(results.map(ev => (ev.id as string).split(':')[0]));
    expect(idPrefixes.has('evt-AAA')).toBe(true);
    expect(idPrefixes.has('evt-BBB')).toBe(true);
    expect(idPrefixes.has('evt-CCC')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 15: Fallback preserves cursor — no duplicate rendering post-fallback
  // -----------------------------------------------------------------------
  test('SSE→polling fallback: polling resumes after snapshot cursor (no duplicates)', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    const snapshotEvent = makeEvent({
      event_id: 'evt-001',
      event_type: 'agent_milestone',
      metadata: { milestone: 'from_snapshot', details: '' },
    });
    const postFallbackEvent = makeEvent({
      event_id: 'evt-002',
      event_type: 'agent_milestone',
      metadata: { milestone: 'post_fallback', details: '' },
    });

    // Snapshot returns 1 event; polling returns both (only evt-002 is new
    // since cursor is evt-001).
    mockGetTaskEvents
      .mockResolvedValueOnce({
        data: [snapshotEvent],
        pagination: { next_token: null, has_more: false },
      })
      .mockResolvedValueOnce({
        data: [snapshotEvent, postFallbackEvent],
        pagination: { next_token: null, has_more: false },
      });
    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING', execution_mode: 'interactive' }) // snapshot
      .mockResolvedValueOnce({ status: 'COMPLETED' }); // polling

    runSseClient.mockRejectedValue(new Error('SSE down'));

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-fallback-dedup', '--transport', 'auto']);

    // Count how many times each milestone was printed.
    const snapshotHits = stdoutWrites.filter(l => l.includes('from_snapshot')).length;
    const postHits = stdoutWrites.filter(l => l.includes('post_fallback')).length;
    expect(snapshotHits).toBe(1); // from snapshot
    expect(postHits).toBe(1); // from polling (not re-emitted)
  });

  // -----------------------------------------------------------------------
  // Test 16: Invalid --transport value → error
  // -----------------------------------------------------------------------
  test('invalid --transport value → CliError', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    const cmd = makeWatchCommand();
    await expect(
      cmd.parseAsync(['node', 'test', 'task-bad', '--transport', 'websocket']),
    ).rejects.toThrow(/Invalid --transport/);
  });

  // -----------------------------------------------------------------------
  // Test 17: --stream-timeout-seconds is forwarded to runSseClient
  // -----------------------------------------------------------------------
  test('--stream-timeout-seconds flag is forwarded to runSseClient', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    let capturedOpts: SseClientOptions | undefined;
    runSseClient.mockImplementation(async (opts: SseClientOptions) => {
      capturedOpts = opts;
      return {
        terminalEvent: { type: 'RUN_FINISHED', runId: 'r' } as AgUiEvent,
        reconnectCount: 0,
        eventsReceived: 0,
        eventsDeduplicated: 0,
        totalDurationMs: 1,
      };
    });
    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING', execution_mode: 'interactive' })
      .mockResolvedValueOnce({ status: 'COMPLETED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync([
      'node', 'test', 'task-timeout',
      '--transport', 'sse',
      '--stream-timeout-seconds', '120',
    ]);

    expect(capturedOpts?.maxStreamSeconds).toBe(120);
  });

  // -----------------------------------------------------------------------
  // Test 18: invalid --stream-timeout-seconds → CliError
  // -----------------------------------------------------------------------
  test('invalid --stream-timeout-seconds → CliError', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    const cmd = makeWatchCommand();
    await expect(
      cmd.parseAsync([
        'node', 'test', 'task-bad-timeout',
        '--transport', 'sse',
        '--stream-timeout-seconds', 'abc',
      ]),
    ).rejects.toThrow(/Invalid --stream-timeout-seconds/);
  });
});
