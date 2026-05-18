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
import { makeSubmitCommand } from '../../src/commands/submit';

jest.mock('../../src/api-client');

describe('submit command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockCreateTask = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockCreateTask.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: mockCreateTask,
      listTasks: jest.fn(),
      getTask: jest.fn(),
      cancelTask: jest.fn(),
      getTaskEvents: jest.fn(),
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('submits a task with issue number', async () => {
    mockCreateTask.mockResolvedValue({
      task_id: 'abc',
      status: 'SUBMITTED',
      repo: 'owner/repo',
      issue_number: 42,
      task_type: 'new_task',
      pr_number: null,
      task_description: null,
      branch_name: 'bgagent/abc/fix',
      session_id: null,
      pr_url: null,
      error_message: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      started_at: null,
      completed_at: null,
      duration_s: null,
      cost_usd: null,
      build_passed: null,
      max_turns: null,
      max_budget_usd: null,
    });

    const cmd = makeSubmitCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--issue', '42',
    ]);

    expect(mockCreateTask).toHaveBeenCalledWith(
      { repo: 'owner/repo', issue_number: 42 },
      undefined,
    );
    expect(consoleSpy).toHaveBeenCalled();
  });

  test('submits a task with description', async () => {
    mockCreateTask.mockResolvedValue({
      task_id: 'abc',
      status: 'SUBMITTED',
      repo: 'owner/repo',
      issue_number: null,
      task_type: 'new_task',
      pr_number: null,
      task_description: 'Fix the bug',
      branch_name: 'bgagent/abc/fix',
      session_id: null,
      pr_url: null,
      error_message: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      started_at: null,
      completed_at: null,
      duration_s: null,
      cost_usd: null,
      build_passed: null,
      max_turns: null,
      max_budget_usd: null,
    });

    const cmd = makeSubmitCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--task', 'Fix the bug',
    ]);

    expect(mockCreateTask).toHaveBeenCalledWith(
      { repo: 'owner/repo', task_description: 'Fix the bug' },
      undefined,
    );
  });

  test('outputs JSON when --output json', async () => {
    const taskData = { task_id: 'abc', status: 'SUBMITTED' };
    mockCreateTask.mockResolvedValue(taskData);

    const cmd = makeSubmitCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--task', 'test',
      '--output', 'json',
    ]);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(taskData, null, 2));
  });

  test('submits a task with --max-turns', async () => {
    mockCreateTask.mockResolvedValue({
      task_id: 'abc',
      status: 'SUBMITTED',
      repo: 'owner/repo',
      issue_number: null,
      task_type: 'new_task',
      pr_number: null,
      task_description: 'Fix the bug',
      branch_name: 'bgagent/abc/fix',
      session_id: null,
      pr_url: null,
      error_message: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      started_at: null,
      completed_at: null,
      duration_s: null,
      cost_usd: null,
      build_passed: null,
      max_turns: 50,
      max_budget_usd: null,
    });

    const cmd = makeSubmitCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--task', 'Fix the bug',
      '--max-turns', '50',
    ]);

    expect(mockCreateTask).toHaveBeenCalledWith(
      { repo: 'owner/repo', task_description: 'Fix the bug', max_turns: 50 },
      undefined,
    );
  });

  test('errors for invalid --max-turns value', async () => {
    const cmd = makeSubmitCommand();
    await expect(
      cmd.parseAsync([
        'node', 'test',
        '--repo', 'owner/repo',
        '--task', 'Fix it',
        '--max-turns', '0',
      ]),
    ).rejects.toThrow('--max-turns must be an integer between 1 and 500');
  });

  test('errors when neither --issue nor --task nor --pr provided', async () => {
    const cmd = makeSubmitCommand();
    await expect(
      cmd.parseAsync([
        'node', 'test',
        '--repo', 'owner/repo',
      ]),
    ).rejects.toThrow('At least one of --issue, --task, --pr, or --review-pr is required');
  });

  test('submits a pr_iteration task with --pr', async () => {
    mockCreateTask.mockResolvedValue({
      task_id: 'pr-abc',
      status: 'SUBMITTED',
      repo: 'owner/repo',
      issue_number: null,
      task_type: 'pr_iteration',
      pr_number: 42,
      task_description: null,
      branch_name: 'pending:pr_resolution',
      session_id: null,
      pr_url: null,
      error_message: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      started_at: null,
      completed_at: null,
      duration_s: null,
      cost_usd: null,
      build_passed: null,
      max_turns: null,
      max_budget_usd: null,
    });

    const cmd = makeSubmitCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--pr', '42',
    ]);

    expect(mockCreateTask).toHaveBeenCalledWith(
      { repo: 'owner/repo', task_type: 'pr_iteration', pr_number: 42 },
      undefined,
    );
    expect(consoleSpy).toHaveBeenCalled();
  });

  test('submits a pr_review task with --review-pr', async () => {
    mockCreateTask.mockResolvedValue({
      task_id: 'review-abc',
      status: 'SUBMITTED',
      repo: 'owner/repo',
      issue_number: null,
      task_type: 'pr_review',
      pr_number: 55,
      task_description: null,
      branch_name: 'pending:pr_resolution',
      session_id: null,
      pr_url: null,
      error_message: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      started_at: null,
      completed_at: null,
      duration_s: null,
      cost_usd: null,
      build_passed: null,
      max_turns: null,
      max_budget_usd: null,
    });

    const cmd = makeSubmitCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--review-pr', '55',
    ]);

    expect(mockCreateTask).toHaveBeenCalledWith(
      { repo: 'owner/repo', task_type: 'pr_review', pr_number: 55 },
      undefined,
    );
    expect(consoleSpy).toHaveBeenCalled();
  });

  test('rejects --pr and --review-pr together', async () => {
    const cmd = makeSubmitCommand();
    await expect(
      cmd.parseAsync([
        'node', 'test',
        '--repo', 'owner/repo',
        '--pr', '42',
        '--review-pr', '55',
      ]),
    ).rejects.toThrow('--pr and --review-pr cannot be used together');
  });

  test('--trace sets trace:true in the create-task request body', async () => {
    mockCreateTask.mockResolvedValue({ task_id: 't-trace', status: 'SUBMITTED' });

    const cmd = makeSubmitCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--task', 'deep debugging',
      '--trace',
    ]);

    expect(mockCreateTask).toHaveBeenCalledWith(
      { repo: 'owner/repo', task_description: 'deep debugging', trace: true },
      undefined,
    );
  });

  test('--trace is opt-in — absent flag omits the field entirely (not false)', async () => {
    // Keeping the wire payload slim: omit rather than send ``trace:
    // false`` so the server's default-false branch is the common path.
    mockCreateTask.mockResolvedValue({ task_id: 't-normal', status: 'SUBMITTED' });

    const cmd = makeSubmitCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--task', 'normal task',
    ]);

    const [body] = mockCreateTask.mock.calls[0];
    expect(body).not.toHaveProperty('trace');
  });

  test('submits a pr_iteration task with --pr and --task', async () => {
    mockCreateTask.mockResolvedValue({
      task_id: 'pr-abc',
      status: 'SUBMITTED',
      repo: 'owner/repo',
      issue_number: null,
      task_type: 'pr_iteration',
      pr_number: 42,
      task_description: 'Fix the null check',
      branch_name: 'pending:pr_resolution',
      session_id: null,
      pr_url: null,
      error_message: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      started_at: null,
      completed_at: null,
      duration_s: null,
      cost_usd: null,
      build_passed: null,
      max_turns: null,
      max_budget_usd: null,
    });

    const cmd = makeSubmitCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--pr', '42',
      '--task', 'Fix the null check',
    ]);

    expect(mockCreateTask).toHaveBeenCalledWith(
      {
        repo: 'owner/repo',
        task_description: 'Fix the null check',
        task_type: 'pr_iteration',
        pr_number: 42,
      },
      undefined,
    );
  });

  describe('Cedar HITL extensions', () => {
    // --approval-timeout ------------------------------------------------------

    test('forwards --approval-timeout as approval_timeout_s', async () => {
      mockCreateTask.mockResolvedValue({ task_id: 't-at', status: 'SUBMITTED' });
      const cmd = makeSubmitCommand();
      await cmd.parseAsync([
        'node', 'test',
        '--repo', 'owner/repo',
        '--task', 'ok',
        '--approval-timeout', '120',
      ]);
      const [body] = mockCreateTask.mock.calls[0];
      expect(body).toEqual({
        repo: 'owner/repo',
        task_description: 'ok',
        approval_timeout_s: 120,
      });
    });

    test('--approval-timeout omitted leaves approval_timeout_s off the wire', async () => {
      mockCreateTask.mockResolvedValue({ task_id: 't-at', status: 'SUBMITTED' });
      const cmd = makeSubmitCommand();
      await cmd.parseAsync([
        'node', 'test',
        '--repo', 'owner/repo',
        '--task', 'ok',
      ]);
      const [body] = mockCreateTask.mock.calls[0];
      expect(body).not.toHaveProperty('approval_timeout_s');
    });

    test('--approval-timeout below floor rejected', async () => {
      const cmd = makeSubmitCommand();
      cmd.exitOverride();
      await expect(
        cmd.parseAsync([
          'node', 'test',
          '--repo', 'owner/repo',
          '--task', 'ok',
          '--approval-timeout', '29',
        ]),
      ).rejects.toThrow(/between 30 and 3600/);
      expect(mockCreateTask).not.toHaveBeenCalled();
    });

    test('--approval-timeout above ceiling rejected', async () => {
      const cmd = makeSubmitCommand();
      cmd.exitOverride();
      await expect(
        cmd.parseAsync([
          'node', 'test',
          '--repo', 'owner/repo',
          '--task', 'ok',
          '--approval-timeout', '3601',
        ]),
      ).rejects.toThrow(/between 30 and 3600/);
      expect(mockCreateTask).not.toHaveBeenCalled();
    });

    test('--approval-timeout non-integer rejected', async () => {
      const cmd = makeSubmitCommand();
      cmd.exitOverride();
      await expect(
        cmd.parseAsync([
          'node', 'test',
          '--repo', 'owner/repo',
          '--task', 'ok',
          '--approval-timeout', 'nope',
        ]),
      ).rejects.toThrow(/between 30 and 3600/);
      expect(mockCreateTask).not.toHaveBeenCalled();
    });

    // --pre-approve (repeatable) ---------------------------------------------

    test('--pre-approve accepts short-form scope', async () => {
      mockCreateTask.mockResolvedValue({ task_id: 't-pa', status: 'SUBMITTED' });
      const cmd = makeSubmitCommand();
      await cmd.parseAsync([
        'node', 'test',
        '--repo', 'owner/repo',
        '--task', 'ok',
        '--pre-approve', 'tool_type_session',
      ]);
      const [body] = mockCreateTask.mock.calls[0];
      expect(body.initial_approvals).toEqual(['tool_type_session']);
    });

    test('--pre-approve accepts prefixed scope and is repeatable', async () => {
      mockCreateTask.mockResolvedValue({ task_id: 't-pa', status: 'SUBMITTED' });
      const cmd = makeSubmitCommand();
      await cmd.parseAsync([
        'node', 'test',
        '--repo', 'owner/repo',
        '--task', 'ok',
        '--pre-approve', 'rule:force_push_any',
        '--pre-approve', 'tool_type:Read',
      ]);
      const [body] = mockCreateTask.mock.calls[0];
      expect(body.initial_approvals).toEqual(['rule:force_push_any', 'tool_type:Read']);
    });

    test('--pre-approve omitted leaves initial_approvals off the wire', async () => {
      mockCreateTask.mockResolvedValue({ task_id: 't-pa', status: 'SUBMITTED' });
      const cmd = makeSubmitCommand();
      await cmd.parseAsync([
        'node', 'test',
        '--repo', 'owner/repo',
        '--task', 'ok',
      ]);
      const [body] = mockCreateTask.mock.calls[0];
      expect(body).not.toHaveProperty('initial_approvals');
    });

    test('--pre-approve rejects missing prefix', async () => {
      const cmd = makeSubmitCommand();
      cmd.exitOverride();
      await expect(
        cmd.parseAsync([
          'node', 'test',
          '--repo', 'owner/repo',
          '--task', 'ok',
          '--pre-approve', 'force_push_any',
        ]),
      ).rejects.toThrow(/invalid scope/);
      expect(mockCreateTask).not.toHaveBeenCalled();
    });

    test('--pre-approve rejects empty prefix body', async () => {
      // ``rule:`` alone has a prefix match but no scope body — the CLI
      // needs to reject rather than silently forward a placeholder to
      // the server (which would also reject, just with an extra round
      // trip).
      const cmd = makeSubmitCommand();
      cmd.exitOverride();
      await expect(
        cmd.parseAsync([
          'node', 'test',
          '--repo', 'owner/repo',
          '--task', 'ok',
          '--pre-approve', 'rule:',
        ]),
      ).rejects.toThrow(/invalid scope/);
      expect(mockCreateTask).not.toHaveBeenCalled();
    });

    test('--pre-approve rejects over-long entry', async () => {
      const cmd = makeSubmitCommand();
      cmd.exitOverride();
      const longName = 'x'.repeat(130);
      await expect(
        cmd.parseAsync([
          'node', 'test',
          '--repo', 'owner/repo',
          '--task', 'ok',
          '--pre-approve', `rule:${longName}`,
        ]),
      ).rejects.toThrow(/exceeds 128 characters/);
      expect(mockCreateTask).not.toHaveBeenCalled();
    });

    test('--pre-approve rejects more than 20 entries', async () => {
      const cmd = makeSubmitCommand();
      cmd.exitOverride();
      const argv: string[] = ['node', 'test', '--repo', 'owner/repo', '--task', 'ok'];
      for (let i = 0; i < 21; i++) {
        argv.push('--pre-approve', `rule:r${i}`);
      }
      await expect(cmd.parseAsync(argv)).rejects.toThrow(/exceeds 20 entries/);
      expect(mockCreateTask).not.toHaveBeenCalled();
    });
  });
});
