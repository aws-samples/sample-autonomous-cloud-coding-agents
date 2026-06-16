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
import { makeStatusCommand } from '../../src/commands/status';

jest.mock('../../src/api-client');

describe('status command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockGetTask = jest.fn();
  const mockGetStatusSnapshot = jest.fn();

  beforeEach(() => {
    // The command under test sets process.exitCode; without resetting it,
    // a test that legitimately asserts exitCode=1 leaks that value into
    // the Jest process itself, which then exits 1 with green assertions.
    // Same pattern as watch.test.ts.
    process.exitCode = undefined;
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockGetTask.mockReset();
    mockGetStatusSnapshot.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: jest.fn(),
      listTasks: jest.fn(),
      getTask: mockGetTask,
      cancelTask: jest.fn(),
      getTaskEvents: jest.fn(),
      getStatusSnapshot: mockGetStatusSnapshot,
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    // Reset here too: beforeEach only covers between-tests; without this,
    // the LAST test's exitCode (1) survives into the Jest worker's own
    // exit, failing the test command with green assertions.
    process.exitCode = undefined;
    consoleSpy.mockRestore();
  });

  test('renders the deterministic snapshot from a combined task + events payload', async () => {
    mockGetStatusSnapshot.mockResolvedValue({
      task: {
        task_id: 'abc',
        status: 'RUNNING',
        repo: 'owner/repo',
        issue_number: null,
        resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
        pr_number: null,
        task_description: 'Fix bug',
        branch_name: 'bgagent/abc/fix',
        session_id: null,
        pr_url: null,
        error_message: null,
        error_classification: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        started_at: '2026-01-01T00:00:00Z',
        completed_at: null,
        duration_s: null,
        cost_usd: null,
        build_passed: null,
        max_turns: 12,
        max_budget_usd: null,
        turns_attempted: null,
        turns_completed: null,
      },
      recentEvents: [],
    });

    const cmd = makeStatusCommand();
    await cmd.parseAsync(['node', 'test', 'abc']);

    expect(mockGetStatusSnapshot).toHaveBeenCalledWith('abc');
    // The raw ``getTask`` path is only used by ``--output json``.
    expect(mockGetTask).not.toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain('Task abc — RUNNING');
    expect(output).toContain('Repo:          owner/repo');
  });

  test('outputs raw TaskDetail JSON when --output json', async () => {
    const taskData = { task_id: 'abc', status: 'RUNNING' };
    mockGetTask.mockResolvedValue(taskData);

    const cmd = makeStatusCommand();
    await cmd.parseAsync(['node', 'test', 'abc', '--output', 'json']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(taskData, null, 2));
    // JSON consumers keep the existing ``TaskDetail`` contract — no snapshot fetch.
    expect(mockGetStatusSnapshot).not.toHaveBeenCalled();
  });

  test('--wait renders the SAME snapshot layout as the default path (no format bifurcation)', async () => {
    // PR #52 UX carry-forward: pre-fix, ``--wait`` rendered a completely
    // different ``formatTaskDetail`` view, confusing users who wondered
    // why they had to add a blocking flag to see a richer output.
    // The new contract: ``--wait`` is a pure blocking flag; same
    // snapshot layout renders whether or not it was passed.
    const terminalTask = {
      task_id: 'abc',
      status: 'COMPLETED',
      repo: 'owner/repo',
      issue_number: null,
      resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
      pr_number: null,
      task_description: 'Fix bug',
      branch_name: 'bgagent/abc/fix',
      session_id: null,
      pr_url: 'https://github.com/owner/repo/pull/1',
      error_message: null,
      error_classification: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:01:00Z',
      started_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T00:01:00Z',
      duration_s: 60,
      cost_usd: 0.05,
      build_passed: true,
      max_turns: 12,
      max_budget_usd: null,
      turns_attempted: 5,
      turns_completed: 5,
    };
    mockGetTask.mockResolvedValue(terminalTask);
    mockGetStatusSnapshot.mockResolvedValue({ task: terminalTask, recentEvents: [] });

    const cmd = makeStatusCommand();
    await cmd.parseAsync(['node', 'test', 'abc', '--wait']);

    // ``waitForTask`` polled the task (at least once) and the snapshot
    // formatter was invoked — not the old ``formatTaskDetail`` split.
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain('Task abc — COMPLETED');
    expect(output).toContain('Repo:          owner/repo');
    // Exit code reflects the terminal status.
    expect(process.exitCode).toBe(0);
  });

  test('--wait with --output json still returns raw TaskDetail (unchanged for scripting)', async () => {
    const terminal = { task_id: 'abc', status: 'FAILED' };
    mockGetTask.mockResolvedValue(terminal);

    const cmd = makeStatusCommand();
    await cmd.parseAsync(['node', 'test', 'abc', '--wait', '--output', 'json']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(terminal, null, 2));
    expect(process.exitCode).toBe(1);
  });

  test('--wait --max-wait <seconds> overrides the 24h ceiling', async () => {
    // A task stuck in RUNNING must trip the user-provided ceiling, not
    // poll for the default 24h. (--max-wait 1 → ceiling check fires on
    // the second loop iteration; the first poll resolves immediately.)
    jest.useFakeTimers();
    try {
      mockGetTask.mockResolvedValue({ task_id: 'abc', status: 'RUNNING' });

      const cmd = makeStatusCommand();
      const parsed = cmd.parseAsync(['node', 'test', 'abc', '--wait', '--max-wait', '1']);
      const assertion = expect(parsed).rejects.toThrow(/Timed out waiting/);
      // Drain poll sleeps until the ceiling trips.
      for (let i = 0; i < 3; i += 1) {
        await Promise.resolve();
        jest.advanceTimersByTime(6_000);
        await Promise.resolve();
      }
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  test('rejects a non-positive --max-wait', async () => {
    const cmd = makeStatusCommand();
    await expect(
      cmd.parseAsync(['node', 'test', 'abc', '--wait', '--max-wait', '0']),
    ).rejects.toThrow('--max-wait must be a positive integer');
    expect(mockGetTask).not.toHaveBeenCalled();
  });
});
