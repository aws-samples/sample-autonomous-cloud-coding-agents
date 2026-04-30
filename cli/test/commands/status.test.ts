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
    consoleSpy.mockRestore();
  });

  test('renders the deterministic snapshot from a combined task + events payload', async () => {
    mockGetStatusSnapshot.mockResolvedValue({
      task: {
        task_id: 'abc',
        status: 'RUNNING',
        repo: 'owner/repo',
        issue_number: null,
        task_type: 'new_task',
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
});
