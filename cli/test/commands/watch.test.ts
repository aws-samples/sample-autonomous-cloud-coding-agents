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
import {
  _getSessionRetries,
  _resetSessionRetries,
  formatTerminalMessage,
  makeWatchCommand,
  nextCadence,
  renderEvent,
} from '../../src/commands/watch';
import { loadConfig as loadConfigMocked } from '../../src/config';
import { ApiError, CliError } from '../../src/errors';
import { transientRetryDelayMs } from '../../src/retry';
import { TaskEvent } from '../../src/types';

jest.mock('../../src/api-client');

jest.mock('../../src/config', () => ({
  loadConfig: jest.fn(),
}));

jest.mock('../../src/auth', () => ({
  getAuthToken: jest.fn().mockResolvedValue('test-id-token'),
}));

const loadConfig = loadConfigMocked as jest.MockedFunction<typeof loadConfigMocked>;

const CONFIG_POLLING = {
  api_url: 'https://api.example.com',
  region: 'us-east-1',
  user_pool_id: 'us-east-1_test',
  client_id: 'test-client-id',
};

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

  test('renders approval milestone metadata when details is absent', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: {
        milestone: 'approval_requested',
        severity: 'high',
        request_id: 'req-abc',
        timeout_s: 300,
        matching_rule_ids: ['rule-1', 'rule-2'],
        scope: 'this_call',
      },
    });
    const output = renderEvent(event);
    expect(output).toContain('★ approval_requested');
    expect(output).toContain('[sev=high]');
    expect(output).toContain('request_id=req-abc');
    expect(output).toContain('timeout=300s');
    expect(output).toContain('rules=rule-1,rule-2');
    expect(output).toContain('scope=this_call');
  });

  test('renders policy_decision milestone metadata', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: {
        milestone: 'policy_decision',
        severity: 'medium',
        matching_rule_ids: ['deny-net'],
      },
    });
    const output = renderEvent(event);
    expect(output).toContain('★ policy_decision');
    expect(output).toContain('[sev=medium]');
    expect(output).toContain('rules=deny-net');
  });

  test('falls back to a compact JSON dump for unrecognized milestone metadata', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: { milestone: 'custom_phase', phase: 7, note: 'halfway' },
    });
    const output = renderEvent(event);
    expect(output).toContain('★ custom_phase');
    expect(output).toContain('"phase":7');
    expect(output).toContain('"note":"halfway"');
    expect(output).not.toContain('"milestone"');
  });

  test('renders a bare milestone with no metadata', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: { milestone: 'started' },
    });
    const output = renderEvent(event);
    expect(output).toContain('★ started');
    expect(output).not.toContain('{');
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

  test('renders agent_blocked with kind, resource, and remediation hint', () => {
    const event = makeEvent({
      event_type: 'agent_blocked',
      metadata: {
        kind: 'egress_denied',
        detail: 'connection to registry.npmjs.org refused',
        remediation_hint: 'allowlist registry.npmjs.org in DNS Firewall',
        retryable: false,
        resource: 'registry.npmjs.org',
      },
    });
    const output = renderEvent(event);
    expect(output).toContain('⛔ BLOCKED (egress_denied)');
    expect(output).toContain('[registry.npmjs.org]');
    expect(output).toContain('connection to registry.npmjs.org refused');
    expect(output).toContain('↳ allowlist registry.npmjs.org in DNS Firewall');
  });

  test('renders agent_blocked without a resource', () => {
    const event = makeEvent({
      event_type: 'agent_blocked',
      metadata: {
        kind: 'policy_fail_closed',
        detail: 'Cedar engine unavailable',
        remediation_hint: 'check policy engine health',
        retryable: false,
      },
    });
    const output = renderEvent(event);
    expect(output).toContain('⛔ BLOCKED (policy_fail_closed)');
    expect(output).not.toContain('[undefined]');
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
    _resetSessionRetries();

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
    // Jest's sandboxed `process` writes the real exitCode: a value left set becomes the exit code of a green in-band run.
    process.exitCode = undefined;
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

    expect(consoleSpy.mock.calls.length).toBe(3);
    expect(mockCatchUpEvents).toHaveBeenCalledWith(
      'task-dedup',
      'evt-002',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  test('polling drains all events past the 100-item page limit (regression: BLOCKER silent-stall)', async () => {
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

    expect(consoleSpy.mock.calls.length).toBe(150);
    expect(mockCatchUpEvents).toHaveBeenCalledWith(
      'task-big',
      'evt-100',
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

  test('retries transient 5xx on getTaskEvents and exits cleanly when the next call succeeds', async () => {
    mockGetTaskEvents
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } })
      .mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'svc down', 'req-1'))
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } });

    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING' })
      .mockResolvedValueOnce({ status: 'COMPLETED' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-retry-5xx']);

    expect(process.exitCode).toBe(0);
    expect(mockGetTaskEvents).toHaveBeenCalledTimes(3);
  });

  test('does not retry on 4xx — deterministic errors propagate immediately', async () => {
    mockGetTaskEvents
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } })
      .mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'nope', 'req-1'));

    mockGetTask.mockResolvedValueOnce({ status: 'RUNNING' });

    const cmd = makeWatchCommand();
    await expect(cmd.parseAsync(['node', 'test', 'task-403'])).rejects.toThrow();

    expect(mockGetTaskEvents).toHaveBeenCalledTimes(2);
  });

  test('does not retry on 401 auth-expired — surfaces login hint immediately', async () => {
    mockGetTaskEvents
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } })
      .mockRejectedValueOnce(new ApiError(401, 'UNAUTHORIZED', 'token expired', 'req-1'));

    mockGetTask.mockResolvedValueOnce({ status: 'RUNNING' });

    const cmd = makeWatchCommand();
    await expect(cmd.parseAsync(['node', 'test', 'task-401'])).rejects.toThrow(/token expired/);
    expect(mockGetTaskEvents).toHaveBeenCalledTimes(2);
  });

  test('does not retry on CliError (programmer / contract violation) — propagates first failure', async () => {
    mockGetTaskEvents
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } })
      .mockRejectedValueOnce(new CliError('bad response shape'));

    mockGetTask.mockResolvedValueOnce({ status: 'RUNNING' });

    const cmd = makeWatchCommand();
    await expect(cmd.parseAsync(['node', 'test', 'task-cli-err'])).rejects.toThrow(/bad response shape/);
    expect(mockGetTaskEvents).toHaveBeenCalledTimes(2);
  });

  test('SIGINT mid-poll sets exit code 130 (POSIX convention)', async () => {
    mockGetTaskEvents
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } })
      .mockImplementationOnce(async () => {
        process.emit('SIGINT' as never);
        return { data: [], pagination: { next_token: null, has_more: false } };
      });

    mockGetTask.mockResolvedValue({ status: 'RUNNING' });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-sigint']);

    expect(process.exitCode).toBe(130);
  });

  test('session-level retry counter surfaces a "flapping" stderr warn exactly once (L3 item 5)', async () => {
    _resetSessionRetries();
    const realSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: () => void) => {
      queueMicrotask(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;

    try {
      mockGetTaskEvents.mockResolvedValueOnce({
        data: [],
        pagination: { next_token: null, has_more: false },
      });

      for (let i = 0; i < 12; i += 1) {
        mockGetTaskEvents.mockRejectedValueOnce(
          new ApiError(503, 'SERVICE_UNAVAILABLE', 'flap', `req-${i}`),
        );
        mockGetTaskEvents.mockResolvedValueOnce({
          data: [],
          pagination: { next_token: null, has_more: false },
        });
      }

      let taskCallCount = 0;
      mockGetTask.mockImplementation(async () => {
        taskCallCount += 1;
        return { status: taskCallCount >= 13 ? 'COMPLETED' : 'RUNNING' };
      });

      const cmd = makeWatchCommand();
      await cmd.parseAsync(['node', 'test', 'task-flapping']);

      expect(_getSessionRetries()).toBeGreaterThanOrEqual(10);

      const stderrOutput = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      const warnMatches = stderrOutput.match(/upstream is flapping/g) ?? [];
      expect(warnMatches).toHaveLength(1);
      expect(stderrOutput).toMatch(/retries so far; results may be delayed/);
    } finally {
      global.setTimeout = realSetTimeout;
      _resetSessionRetries();
    }
  });

  test('exhausted retry budget throws a "re-run to resume" message', async () => {
    const realSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: () => void) => {
      queueMicrotask(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;
    try {
      mockGetTaskEvents.mockResolvedValueOnce({
        data: [],
        pagination: { next_token: null, has_more: false },
      });
      for (let i = 0; i < 6; i += 1) {
        mockGetTaskEvents.mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'svc down', `req-${i}`));
      }

      mockGetTask.mockResolvedValueOnce({ status: 'RUNNING' });

      const cmd = makeWatchCommand();
      const run = cmd.parseAsync(['node', 'test', 'task-503-storm']);
      await expect(run).rejects.toThrow(
        /Exceeded retry budget.*Re-run .bgagent watch/,
      );
      await expect(run).rejects.toThrow(/after 6 transient failures/);
      await expect(run).rejects.toBeInstanceOf(CliError);
      await expect(run).rejects.toHaveProperty('exitCode', 2);
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  test('SIGINT during initial snapshot exits 130 without logging a failure', async () => {
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
    mockGetTaskEvents.mockRejectedValueOnce(
      new ApiError(401, 'UNAUTHORIZED', 'token expired (UNAUTHORIZED)\nHint: Run `bgagent login`', 'req-1'),
    );
    mockGetTask.mockRejectedValueOnce(
      new ApiError(401, 'UNAUTHORIZED', 'token expired (UNAUTHORIZED)\nHint: Run `bgagent login`', 'req-2'),
    );

    const cmd = makeWatchCommand();
    await expect(cmd.parseAsync(['node', 'test', 'task-real-err'])).rejects.toThrow(/token expired/);
    expect(process.exitCode).not.toBe(130);
  });

  test('initial snapshot retries transient errors before giving up (cold-start hardening)', async () => {
    _resetSessionRetries();
    const realSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: () => void) => {
      queueMicrotask(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;

    try {
      mockGetTaskEvents
        .mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'cold-start 1', 'req-1'))
        .mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'cold-start 2', 'req-2'))
        .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } })
        .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } });

      mockGetTask.mockResolvedValueOnce({ status: 'RUNNING' })
        .mockResolvedValueOnce({ status: 'COMPLETED' });

      const cmd = makeWatchCommand();
      await cmd.parseAsync(['node', 'test', 'task-cold-start']);

      expect(mockGetTaskEvents).toHaveBeenCalledTimes(4);
      expect(process.exitCode).toBe(0);
      expect(_getSessionRetries()).toBeGreaterThanOrEqual(2);
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  test('initial snapshot exhausts retry budget on persistent 5xx and surfaces a "re-run" hint', async () => {
    _resetSessionRetries();
    const realSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: () => void) => {
      queueMicrotask(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;

    try {
      mockGetTaskEvents.mockRejectedValue(
        new ApiError(503, 'SERVICE_UNAVAILABLE', 'persistent flap', 'req-x'),
      );
      mockGetTask.mockResolvedValue({ status: 'RUNNING' });

      const cmd = makeWatchCommand();
      const run = cmd.parseAsync(['node', 'test', 'task-exhaust']);
      await expect(run).rejects.toThrow(
        /Exceeded retry budget .* Re-run `bgagent watch/,
      );
      await expect(run).rejects.toHaveProperty('exitCode', 2);
      expect(mockGetTaskEvents).toHaveBeenCalledTimes(6);
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  test('snapshot error aborts the shared controller so a sibling retry loop terminates (resource-leak guard)', async () => {
    _resetSessionRetries();
    const realSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: () => void) => {
      queueMicrotask(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;

    try {
      mockGetTaskEvents.mockRejectedValueOnce(
        new ApiError(401, 'UNAUTHORIZED', 'token expired', 'req-e'),
      );
      let taskAttempts = 0;
      mockGetTask.mockImplementation(async () => {
        taskAttempts += 1;
        throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'slow flap', 'req-t');
      });

      const cmd = makeWatchCommand();
      await expect(cmd.parseAsync(['node', 'test', 'task-abort'])).rejects.toThrow(/token expired/);

      expect(taskAttempts).toBeLessThan(6);
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  test('initial snapshot does NOT retry 4xx errors (auth failures should surface immediately)', async () => {
    mockGetTaskEvents.mockRejectedValueOnce(
      new ApiError(401, 'UNAUTHORIZED', 'token expired', 'req-1'),
    );
    mockGetTask.mockRejectedValueOnce(
      new ApiError(401, 'UNAUTHORIZED', 'token expired', 'req-2'),
    );

    const cmd = makeWatchCommand();
    await expect(cmd.parseAsync(['node', 'test', 'task-401'])).rejects.toThrow(/token expired/);
    expect(mockGetTaskEvents).toHaveBeenCalledTimes(1);
  });

  test('SIGINT after terminal status lands still honors exit 130 (POSIX contract)', async () => {
    mockGetTaskEvents
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } })
      .mockResolvedValueOnce({ data: [], pagination: { next_token: null, has_more: false } });

    mockGetTask
      .mockResolvedValueOnce({ status: 'RUNNING' })
      .mockImplementationOnce(async () => {
        process.emit('SIGINT' as never);
        return { status: 'COMPLETED' };
      });

    const cmd = makeWatchCommand();
    await cmd.parseAsync(['node', 'test', 'task-sigint-vs-terminal']);

    expect(process.exitCode).toBe(130);
  });
});

describe('transientRetryDelayMs (equal-jitter backoff)', () => {
  test('never returns 0 — equal-jitter floor prevents retry storms', () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      for (let i = 0; i < 200; i += 1) {
        const ms = transientRetryDelayMs(attempt);
        expect(ms).toBeGreaterThan(0);
      }
    }
  });

  test('respects the 5000 ms ladder ceiling', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(transientRetryDelayMs(10)).toBeLessThanOrEqual(5_000);
    }
  });

  test('pins the backoff curve: 1-based attempts → 1000/2000/4000/5000ms bases', () => {
    const expectedBases = [1000, 2000, 4000, 5000, 5000];
    expectedBases.forEach((base, idx) => {
      const attempt = idx + 1;
      for (let i = 0; i < 100; i += 1) {
        const ms = transientRetryDelayMs(attempt);
        expect(ms).toBeGreaterThanOrEqual(base / 2);
        expect(ms).toBeLessThan(base);
      }
    });
  });
});

describe('nextCadence (adaptive polling state)', () => {
  test('stays at 500 ms when events are arriving', () => {
    const s0 = { intervalMs: 500, consecutiveEmptyPolls: 0 };
    const s1 = nextCadence(s0, true);
    expect(s1).toEqual({ intervalMs: 500, consecutiveEmptyPolls: 0 });
  });

  test('climbs the backoff ladder on consecutive empty polls', () => {
    let s = { intervalMs: 500, consecutiveEmptyPolls: 0 };
    s = nextCadence(s, false);
    expect(s).toEqual({ intervalMs: 1_000, consecutiveEmptyPolls: 1 });
    s = nextCadence(s, false);
    expect(s).toEqual({ intervalMs: 2_000, consecutiveEmptyPolls: 2 });
    s = nextCadence(s, false);
    expect(s).toEqual({ intervalMs: 5_000, consecutiveEmptyPolls: 3 });
    s = nextCadence(s, false);
    expect(s).toEqual({ intervalMs: 5_000, consecutiveEmptyPolls: 4 });
  });

  test('resets to fast cadence on the next event, regardless of how deep the backoff was', () => {
    const deepBackoff = { intervalMs: 5_000, consecutiveEmptyPolls: 7 };
    const reset = nextCadence(deepBackoff, true);
    expect(reset).toEqual({ intervalMs: 500, consecutiveEmptyPolls: 0 });
  });
});

describe('formatTerminalMessage', () => {
  test('COMPLETED renders task_id + status without an error clause', () => {
    expect(formatTerminalMessage({
      task_id: '01KQ...XXX',
      status: 'COMPLETED',
      error_classification: null,
      error_message: null,
    })).toBe('Task 01KQ...XXX completed.');
  });

  test('FAILED with structured classification renders category + title + raw first line', () => {
    expect(formatTerminalMessage({
      task_id: 'T1',
      status: 'FAILED',
      error_classification: {
        category: 'guardrail',
        title: 'PR context blocked',
        description: 'Bedrock Guardrail flagged the PR context',
        remedy: 'Tune the guardrail or redact the triggering content',
        retryable: false,
      },
      error_message: 'Guardrail blocked: PR context blocked by content policy: CONTENT/PROMPT_ATTACK (LOW)',
    })).toBe(
      'Task T1 failed. guardrail: PR context blocked — Guardrail blocked: PR context blocked by content policy: CONTENT/PROMPT_ATTACK (LOW)',
    );
  });

  test('FAILED with known classification but no error_message keeps the classification-only path', () => {
    expect(formatTerminalMessage({
      task_id: 'T1b',
      status: 'FAILED',
      error_classification: {
        category: 'guardrail',
        title: 'PR context blocked',
        description: '',
        remedy: '',
        retryable: false,
      },
      error_message: null,
    })).toBe('Task T1b failed. guardrail: PR context blocked');
  });

  test('FAILED with UNKNOWN classification prefers raw error_message over the bland title', () => {
    expect(formatTerminalMessage({
      task_id: 'T1c',
      status: 'FAILED',
      error_classification: {
        category: 'unknown',
        title: 'Unexpected error',
        description: 'An unrecognized error occurred during task execution.',
        remedy: 'Check the full error message and agent logs for details.',
        retryable: false,
      },
      error_message: 'missing built-in hard-deny policies: /app/policies/hard_deny.cedar',
    })).toBe(
      'Task T1c failed. missing built-in hard-deny policies: /app/policies/hard_deny.cedar',
    );
  });

  test('FAILED with UNKNOWN classification and no error_message falls back to the bland title', () => {
    expect(formatTerminalMessage({
      task_id: 'T1d',
      status: 'FAILED',
      error_classification: {
        category: 'unknown',
        title: 'Unexpected error',
        description: '',
        remedy: '',
        retryable: false,
      },
      error_message: null,
    })).toBe('Task T1d failed. unknown: Unexpected error');
  });

  test('FAILED without classification falls back to error_message', () => {
    expect(formatTerminalMessage({
      task_id: 'T2',
      status: 'FAILED',
      error_classification: null,
      error_message: '  raw server message with whitespace\n',
    })).toBe('Task T2 failed. raw server message with whitespace');
  });

  test('FAILED with neither classification nor message degrades to bare prefix', () => {
    expect(formatTerminalMessage({
      task_id: 'T3',
      status: 'FAILED',
      error_classification: null,
      error_message: null,
    })).toBe('Task T3 failed.');
  });

  test('CANCELLED with non-unknown classification still renders category + title + first line', () => {
    expect(formatTerminalMessage({
      task_id: 'T4',
      status: 'CANCELLED',
      error_classification: {
        category: 'guardrail',
        title: 'PR context blocked',
        description: '',
        remedy: '',
        retryable: false,
      },
      error_message: 'Guardrail blocked: PR context',
    })).toBe(
      'Task T4 cancelled. guardrail: PR context blocked — Guardrail blocked: PR context',
    );
  });
});
