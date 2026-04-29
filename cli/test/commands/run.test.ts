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
import { makeRunCommand } from '../../src/commands/run';
import { loadConfig as loadConfigMocked } from '../../src/config';
import { SseClientOptions, runSseClient as runSseClientMocked } from '../../src/sse-client';

jest.mock('../../src/api-client');

jest.mock('../../src/config', () => ({
  loadConfig: jest.fn(),
}));

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
  getAccessToken: jest.fn().mockResolvedValue('test-access-token'),
}));

const loadConfig = loadConfigMocked as jest.MockedFunction<typeof loadConfigMocked>;
const runSseClient = runSseClientMocked as jest.MockedFunction<typeof runSseClientMocked>;

const CONFIG_WITH_SSE = {
  api_url: 'https://api.example.com',
  region: 'us-east-1',
  user_pool_id: 'us-east-1_test',
  client_id: 'test-client-id',
  runtime_jwt_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/abca_agent_jwt-XYZ',
};

const CONFIG_WITHOUT_RUNTIME = {
  api_url: 'https://api.example.com',
  region: 'us-east-1',
  user_pool_id: 'us-east-1_test',
  client_id: 'test-client-id',
};

const TASK_DETAIL_RUNNING = {
  task_id: 'task-run-1',
  status: 'SUBMITTED',
  repo: 'owner/repo',
  issue_number: null,
  task_type: 'new_task',
  pr_number: null,
  task_description: 'demo task',
  branch_name: 'bgagent/task-run-1/demo',
  session_id: null,
  pr_url: null,
  error_message: null,
  created_at: '2026-04-21T00:00:00Z',
  updated_at: '2026-04-21T00:00:00Z',
  started_at: null,
  completed_at: null,
  duration_s: null,
  cost_usd: null,
  build_passed: null,
  max_turns: null,
  max_budget_usd: null,
};

describe('run command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
  const mockCreateTask = jest.fn();
  const mockGetTask = jest.fn();
  const mockGetTaskEvents = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockCreateTask.mockReset();
    mockGetTask.mockReset();
    mockGetTaskEvents.mockReset();
    runSseClient.mockReset();
    loadConfig.mockReset();
    process.exitCode = undefined;

    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: mockCreateTask,
      listTasks: jest.fn(),
      getTask: mockGetTask,
      cancelTask: jest.fn(),
      getTaskEvents: mockGetTaskEvents,
      catchUpEvents: jest.fn().mockResolvedValue([]),
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
    }) as unknown as ApiClient);

    // Default: empty snapshot, RUNNING status so SSE path is entered.
    mockGetTaskEvents.mockResolvedValue({
      data: [],
      pagination: { next_token: null, has_more: false },
    });
    mockGetTask.mockResolvedValue({ ...TASK_DETAIL_RUNNING, status: 'RUNNING' });
    mockCreateTask.mockResolvedValue(TASK_DETAIL_RUNNING);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  test('calls createTask with execution_mode: interactive', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    // Make runSseClient terminate immediately with RUN_FINISHED.
    runSseClient.mockResolvedValue({
      terminalEvent: { type: 'RUN_FINISHED', threadId: 't', runId: 'r' } as never,
      reconnectCount: 0,
      eventsReceived: 0,
      eventsDeduplicated: 0,
      totalDurationMs: 1,
    });
    mockGetTask.mockResolvedValueOnce({ ...TASK_DETAIL_RUNNING, status: 'RUNNING' });
    mockGetTask.mockResolvedValue({ ...TASK_DETAIL_RUNNING, status: 'COMPLETED' });

    const cmd = makeRunCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--task', 'Fix the bug',
    ]);

    expect(mockCreateTask).toHaveBeenCalledWith(
      {
        repo: 'owner/repo',
        execution_mode: 'interactive',
        task_description: 'Fix the bug',
      },
      undefined,
    );
  });

  test('forwards idempotency key to createTask', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    runSseClient.mockResolvedValue({
      terminalEvent: { type: 'RUN_FINISHED', threadId: 't', runId: 'r' } as never,
      reconnectCount: 0,
      eventsReceived: 0,
      eventsDeduplicated: 0,
      totalDurationMs: 1,
    });
    mockGetTask.mockResolvedValue({ ...TASK_DETAIL_RUNNING, status: 'COMPLETED' });

    const cmd = makeRunCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--task', 'go',
      '--idempotency-key', 'idem-abc',
    ]);

    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ execution_mode: 'interactive' }),
      'idem-abc',
    );
  });

  test('errors when runtime_jwt_arn is not configured', async () => {
    loadConfig.mockReturnValue(CONFIG_WITHOUT_RUNTIME);

    const cmd = makeRunCommand();
    await expect(cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--task', 'go',
    ])).rejects.toThrow('runtime_jwt_arn');

    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  test('invokes runSse with correct runtimeJwtArn and taskId', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    let capturedOpts: SseClientOptions | null = null;
    runSseClient.mockImplementation(async (opts: SseClientOptions) => {
      capturedOpts = opts;
      return {
        terminalEvent: { type: 'RUN_FINISHED', threadId: 't', runId: 'r' } as never,
        reconnectCount: 0,
        eventsReceived: 0,
        eventsDeduplicated: 0,
        totalDurationMs: 1,
      };
    });
    mockGetTask.mockResolvedValueOnce({ ...TASK_DETAIL_RUNNING, status: 'RUNNING' });
    mockGetTask.mockResolvedValue({ ...TASK_DETAIL_RUNNING, status: 'COMPLETED' });

    const cmd = makeRunCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--task', 'go',
    ]);

    expect(runSseClient).toHaveBeenCalledTimes(1);
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.runtimeJwtArn).toBe(CONFIG_WITH_SSE.runtime_jwt_arn);
    expect(capturedOpts!.taskId).toBe(TASK_DETAIL_RUNNING.task_id);
    expect(capturedOpts!.region).toBe('us-east-1');
  });

  test('exit code 0 when task completes successfully', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    runSseClient.mockResolvedValue({
      terminalEvent: { type: 'RUN_FINISHED', threadId: 't', runId: 'r' } as never,
      reconnectCount: 0,
      eventsReceived: 0,
      eventsDeduplicated: 0,
      totalDurationMs: 1,
    });
    // Final getTask is the second call — first is for the snapshot.
    mockGetTask.mockResolvedValueOnce({ ...TASK_DETAIL_RUNNING, status: 'RUNNING' });
    mockGetTask.mockResolvedValueOnce({ ...TASK_DETAIL_RUNNING, status: 'COMPLETED' });

    const cmd = makeRunCommand();
    await cmd.parseAsync(['node', 'test', '--repo', 'owner/repo', '--task', 'go']);

    expect(process.exitCode).toBe(0);
  });

  test('exit code 1 when task fails', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    runSseClient.mockResolvedValue({
      terminalEvent: { type: 'RUN_ERROR', threadId: 't', runId: 'r', message: 'boom' } as never,
      reconnectCount: 0,
      eventsReceived: 0,
      eventsDeduplicated: 0,
      totalDurationMs: 1,
    });
    mockGetTask.mockResolvedValueOnce({ ...TASK_DETAIL_RUNNING, status: 'RUNNING' });
    mockGetTask.mockResolvedValueOnce({ ...TASK_DETAIL_RUNNING, status: 'FAILED' });

    const cmd = makeRunCommand();
    await cmd.parseAsync(['node', 'test', '--repo', 'owner/repo', '--task', 'go']);

    expect(process.exitCode).toBe(1);
  });

  test('errors for invalid --max-turns value', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);

    const cmd = makeRunCommand();
    await expect(cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--task', 'go',
      '--max-turns', '0',
    ])).rejects.toThrow('--max-turns must be an integer between 1 and 500');
  });

  test('errors when neither --issue nor --task nor --pr provided', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);

    const cmd = makeRunCommand();
    await expect(cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
    ])).rejects.toThrow('At least one of --issue, --task, --pr, or --review-pr is required');
  });

  test('rejects --pr and --review-pr together', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);

    const cmd = makeRunCommand();
    await expect(cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--pr', '42',
      '--review-pr', '55',
    ])).rejects.toThrow('--pr and --review-pr cannot be used together');
  });

  test('short-circuits when task is already terminal', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    mockCreateTask.mockResolvedValue(TASK_DETAIL_RUNNING);
    // Snapshot returns COMPLETED — bypass SSE entirely.
    mockGetTask.mockResolvedValueOnce({ ...TASK_DETAIL_RUNNING, status: 'COMPLETED' });

    const cmd = makeRunCommand();
    await cmd.parseAsync(['node', 'test', '--repo', 'owner/repo', '--task', 'go']);

    expect(runSseClient).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  test('--output json still invokes SSE and gets final status via REST', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    runSseClient.mockResolvedValue({
      terminalEvent: { type: 'RUN_FINISHED', threadId: 't', runId: 'r' } as never,
      reconnectCount: 0,
      eventsReceived: 0,
      eventsDeduplicated: 0,
      totalDurationMs: 1,
    });
    mockGetTask.mockResolvedValueOnce({ ...TASK_DETAIL_RUNNING, status: 'RUNNING' });
    mockGetTask.mockResolvedValueOnce({ ...TASK_DETAIL_RUNNING, status: 'COMPLETED' });

    const cmd = makeRunCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--task', 'go',
      '--output', 'json',
    ]);

    expect(runSseClient).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });

  // --------------------------------------------------------------------
  // P0-d: fatal SSE error → cancel task + user-visible recovery hint
  // --------------------------------------------------------------------

  test('SSE fails immediately → cancels the task and surfaces a resume hint', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    // Snapshot: brand-new task, RUNNING, execution_mode=interactive.
    mockGetTask.mockResolvedValueOnce({
      ...TASK_DETAIL_RUNNING,
      status: 'RUNNING',
      execution_mode: 'interactive',
    });
    // SSE rejects fatally.
    runSseClient.mockRejectedValue(new Error('424 Failed Dependency'));

    // Spy on cancelTask to assert it was called.
    const mockCancelTask = jest.fn().mockResolvedValue({
      task_id: TASK_DETAIL_RUNNING.task_id,
      status: 'CANCELLED',
      cancelled_at: '2026-04-21T00:00:00Z',
    });
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: mockCreateTask,
      listTasks: jest.fn(),
      getTask: mockGetTask,
      cancelTask: mockCancelTask,
      getTaskEvents: mockGetTaskEvents,
      catchUpEvents: jest.fn().mockResolvedValue([]),
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
    }) as unknown as ApiClient);

    const localStderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const cmd = makeRunCommand();
      await expect(cmd.parseAsync([
        'node', 'test',
        '--repo', 'owner/repo',
        '--task', 'go',
      ])).rejects.toThrow(/run failed/);

      // Task must be cancelled so it doesn't sit stranded in SUBMITTED.
      expect(mockCancelTask).toHaveBeenCalledWith(TASK_DETAIL_RUNNING.task_id);
      // Stderr must carry a resume hint referencing the task id.
      const stderr = localStderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(stderr).toContain(TASK_DETAIL_RUNNING.task_id);
      expect(stderr).toMatch(/bgagent status/);
    } finally {
      localStderrSpy.mockRestore();
    }
  });

  test('SSE failure + cancel also fails → still rejects with original SSE error', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    mockGetTask.mockResolvedValueOnce({
      ...TASK_DETAIL_RUNNING,
      status: 'RUNNING',
      execution_mode: 'interactive',
    });
    runSseClient.mockRejectedValue(new Error('ECONNREFUSED'));

    const mockCancelTask = jest.fn().mockRejectedValue(new Error('cancel also broken'));
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: mockCreateTask,
      listTasks: jest.fn(),
      getTask: mockGetTask,
      cancelTask: mockCancelTask,
      getTaskEvents: mockGetTaskEvents,
      catchUpEvents: jest.fn().mockResolvedValue([]),
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
    }) as unknown as ApiClient);

    const localStderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const cmd = makeRunCommand();
      // Must still reject with the SSE error, not the cancel error.
      await expect(cmd.parseAsync([
        'node', 'test',
        '--repo', 'owner/repo',
        '--task', 'go',
      ])).rejects.toThrow(/ECONNREFUSED|run failed/);
      expect(mockCancelTask).toHaveBeenCalledTimes(1);
    } finally {
      localStderrSpy.mockRestore();
    }
  });

  test('SIGINT during SSE stream forwards abort signal to runSseClient', async () => {
    loadConfig.mockReturnValue(CONFIG_WITH_SSE);
    mockGetTask.mockResolvedValueOnce({
      ...TASK_DETAIL_RUNNING,
      status: 'RUNNING',
      execution_mode: 'interactive',
    });
    // Final status check after SSE resolves.
    mockGetTask.mockResolvedValue({ ...TASK_DETAIL_RUNNING, status: 'CANCELLED' });

    let capturedAbortController: AbortController | null = null;
    runSseClient.mockImplementation(async (opts: SseClientOptions) => {
      // Listen for abort so this mock resolves cleanly after SIGINT.
      capturedAbortController = { signal: opts.signal } as unknown as AbortController;
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) {
          resolve();
          return;
        }
        opts.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        terminalEvent: null,
        reconnectCount: 0,
        eventsReceived: 0,
        eventsDeduplicated: 0,
        totalDurationMs: 1,
      } as never;
    });

    const cmd = makeRunCommand();
    const run = cmd.parseAsync(['node', 'test', '--repo', 'owner/repo', '--task', 'go']);
    // Give the mock a tick to begin listening for abort.
    await new Promise(r => setTimeout(r, 10));
    process.emit('SIGINT');

    await run;

    expect(capturedAbortController).not.toBeNull();
    expect(capturedAbortController!.signal.aborted).toBe(true);
  });
});
