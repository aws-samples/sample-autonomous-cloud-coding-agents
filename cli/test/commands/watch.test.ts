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
    expect(mockCatchUpEvents).toHaveBeenCalledWith('task-dedup', 'evt-002');
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
    expect(mockCatchUpEvents).toHaveBeenCalledWith('task-big', 'evt-100');
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
});
