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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiClient } from '../../src/api-client';
import { makeSubmitCommand } from '../../src/commands/submit';
import { ApiError } from '../../src/errors';
import { abortableSleep } from '../../src/retry';
import { Attachment } from '../../src/types';

jest.mock('../../src/api-client');
// The pauses between two reads of a task whose uploads are being confirmed: over at once.
jest.mock('../../src/retry', () => ({
  ...jest.requireActual('../../src/retry'),
  abortableSleep: jest.fn(() => Promise.resolve()),
}));

describe('submit command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockCreateTask = jest.fn();
  const mockConfirmUploads = jest.fn();
  const mockGetTask = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockCreateTask.mockReset();
    mockConfirmUploads.mockReset();
    mockGetTask.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: mockCreateTask,
      confirmUploads: mockConfirmUploads,
      listTasks: jest.fn(),
      getTask: mockGetTask,
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
      resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
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
      { repo: 'owner/repo', issue_number: 42, workflow_ref: 'coding/new-task-v1' },
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
      resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
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
      { repo: 'owner/repo', task_description: 'Fix the bug', workflow_ref: 'coding/new-task-v1' },
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
      resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
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
      { repo: 'owner/repo', task_description: 'Fix the bug', max_turns: 50, workflow_ref: 'coding/new-task-v1' },
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

  test('errors when --repo is omitted without --workflow', async () => {
    // #248 LOW: --repo is no longer a hard requiredOption (repo-less workflows
    // need to be submittable), but it stays mandatory unless --workflow selects
    // a workflow the server can admit repo-less.
    const cmd = makeSubmitCommand();
    await expect(
      cmd.parseAsync([
        'node', 'test',
        '--task', 'Research the tradeoffs',
      ]),
    ).rejects.toThrow('--repo is required');
  });

  test('errors when --repo is omitted with --pr (PR workflows need a repo)', async () => {
    const cmd = makeSubmitCommand();
    await expect(
      cmd.parseAsync([
        'node', 'test',
        '--pr', '42',
        '--workflow', 'coding/pr-iteration-v1',
      ]),
    ).rejects.toThrow('--repo is required with --pr/--review-pr');
  });

  test('submits a repo-less task: --workflow + --task, no --repo (#248 Phase 3)', async () => {
    mockCreateTask.mockResolvedValue({
      task_id: 'abc',
      status: 'SUBMITTED',
      repo: null,
      issue_number: null,
      resolved_workflow: { id: 'knowledge/web-research-v1', version: '1.0.0' },
      pr_number: null,
      task_description: 'Research the tradeoffs',
      branch_name: null,
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
      '--workflow', 'knowledge/web-research-v1',
      '--task', 'Research the tradeoffs',
    ]);

    // No ``repo`` key in the body — the server admits it as repo-less.
    expect(mockCreateTask).toHaveBeenCalledWith(
      { workflow_ref: 'knowledge/web-research-v1', task_description: 'Research the tradeoffs' },
      undefined,
    );
  });

  test('submits a pr_iteration task with --pr', async () => {
    mockCreateTask.mockResolvedValue({
      task_id: 'pr-abc',
      status: 'SUBMITTED',
      repo: 'owner/repo',
      issue_number: null,
      resolved_workflow: { id: 'coding/pr-iteration-v1', version: '1.0.0' },
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
      { repo: 'owner/repo', workflow_ref: 'coding/pr-iteration-v1', pr_number: 42 },
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
      resolved_workflow: { id: 'coding/pr-review-v1', version: '1.0.0' },
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
      { repo: 'owner/repo', workflow_ref: 'coding/pr-review-v1', pr_number: 55 },
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
      { repo: 'owner/repo', task_description: 'deep debugging', trace: true, workflow_ref: 'coding/new-task-v1' },
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
      resolved_workflow: { id: 'coding/pr-iteration-v1', version: '1.0.0' },
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
        workflow_ref: 'coding/pr-iteration-v1',
        pr_number: 42,
      },
      undefined,
    );
  });

  describe('Cedar HITL extensions', () => {
    test.each([['off', 0], ['0', 0], ['30', 30], ['600', 600], ['3600', 3600]])(
      'forwards MicroVM sleep delay %s without changing approval timeout', async (value, expected) => {
        mockCreateTask.mockResolvedValue({ task_id: 't-sleep', status: 'SUBMITTED' });
        await makeSubmitCommand().parseAsync([
          'node', 'test', '--repo', 'owner/repo', '--task', 'ok', '--microvm-sleep-after', String(value),
        ]);
        const [body] = mockCreateTask.mock.calls[0];
        expect(body.microvm_sleep_after_s).toBe(expected);
        expect(body).not.toHaveProperty('approval_timeout_s');
      },
    );
    test.each(['-1', '3601', '1.5', '30seconds', '1e2', '', ' ', 'NaN'])('rejects malformed MicroVM delay %j', async value => {
      await expect(makeSubmitCommand().parseAsync([
        'node', 'test', '--repo', 'owner/repo', '--task', 'ok', '--microvm-sleep-after', value,
      ])).rejects.toThrow(/--microvm-sleep-after must be off or an integer/);
      expect(mockCreateTask).not.toHaveBeenCalled();
    });
    test('omits the sleep override so the server captures its default', async () => {
      mockCreateTask.mockResolvedValue({ task_id: 't-sleep', status: 'SUBMITTED' });
      await makeSubmitCommand().parseAsync(['node', 'test', '--repo', 'owner/repo', '--task', 'ok']);
      expect(mockCreateTask.mock.calls[0][0]).not.toHaveProperty('microvm_sleep_after_s');
    });
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
        workflow_ref: 'coding/new-task-v1',
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
        '--pre-approve', 'all_session',
      ]);
      const [body] = mockCreateTask.mock.calls[0];
      expect(body.initial_approvals).toEqual(['all_session']);
    });

    test.each(['this_call', 'tool_type_session', 'tool_group_session'])(
      '--pre-approve rejects %s, which stands for a call that is waiting for approval',
      async (scope) => {
        // The agent cannot start a task with one of these as a pre-approval.
        mockCreateTask.mockResolvedValue({ task_id: 't-pa', status: 'SUBMITTED' });
        const cmd = makeSubmitCommand();
        cmd.exitOverride();
        await expect(
          cmd.parseAsync([
            'node', 'test',
            '--repo', 'owner/repo',
            '--task', 'ok',
            '--pre-approve', scope,
          ]),
        ).rejects.toThrow(/invalid scope/);
        expect(mockCreateTask).not.toHaveBeenCalled();
      },
    );

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

  describe('attachments', () => {
    const originalFetch = global.fetch;
    const submitted = { task_id: 'task-1', status: 'SUBMITTED' };
    let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
    let cwdSpy: jest.SpiedFunction<typeof process.cwd>;
    let dir: string;

    beforeEach(() => {
      // What the command takes for the working directory: an attachment has to be inside it.
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-submit-'));
      cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(dir);
      stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      global.fetch = jest.fn(async () => new Response(null, { status: 204 })) as typeof global.fetch;
      mockCreateTask.mockResolvedValue(submitted);
      mockConfirmUploads.mockResolvedValue(submitted);
    });

    afterEach(() => {
      global.fetch = originalFetch;
      cwdSpy.mockRestore();
      stderrSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const submitWith = (...files: string[]) => makeSubmitCommand().parseAsync([
      'node', 'test',
      '--repo', 'owner/repo',
      '--task', 'look at these',
      ...files.flatMap(file => ['--attachment', path.join(dir, file)]),
    ]);

    /** What the API answers when it waits for the upload of each of these files. */
    const pendingUploads = (...filenames: string[]) => ({
      task_id: 'task-1',
      status: 'PENDING_UPLOADS',
      upload_instructions: filenames.map((filename, i) => ({
        attachment_id: `att-${i}`,
        filename,
        upload_url: 'https://attachments.example/',
        upload_fields: { 'key': `attachments/user-1/task-1/att-${i}/${filename}`, 'Content-Type': 'image/png' },
        upload_expires_at: '2026-01-01T00:10:00Z',
      })),
    });

    // The API takes PNG and JPEG images only: validateAttachments answers 400 for the other two.
    test.each(['.gif', '.webp'])('refuses a %s file before anything is sent', async (ext) => {
      fs.writeFileSync(path.join(dir, `diagram${ext}`), 'x');

      await expect(submitWith(`diagram${ext}`)).rejects.toThrow(new RegExp(
        `^Unsupported file type '\\${ext}' .* Supported: \\.png, \\.jpg, \\.jpeg, \\.txt, \\.log, \\.csv, \\.md, \\.json, \\.pdf$`,
      ));
      expect(mockCreateTask).not.toHaveBeenCalled();
    });

    test('sends at most 3 MB of files inline and uploads the ones beyond it', async () => {
      // Seven files of 450 KB: each is small enough to go inline, together they are 3.08 MB,
      // and the API refuses a request that carries more than 3 MB of inline data.
      const names = [1, 2, 3, 4, 5, 6, 7].map(n => `shot-${n}.png`);
      for (const name of names) fs.writeFileSync(path.join(dir, name), Buffer.alloc(450 * 1024));
      mockCreateTask.mockResolvedValue(pendingUploads('shot-7.png'));

      await submitWith(...names);

      const sent = mockCreateTask.mock.calls[0][0].attachments as Attachment[];
      expect(sent.map(a => a.filename)).toEqual(names);
      expect(sent.slice(0, 6).map(a => Buffer.from(a.data ?? '', 'base64').length)).toEqual(Array(6).fill(450 * 1024));
      expect(sent[6]).toEqual({ type: 'image', content_type: 'image/png', filename: 'shot-7.png', expected_size_bytes: 450 * 1024 });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(mockConfirmUploads).toHaveBeenCalledWith('task-1');
    });

    test('uploads the right file for each upload when files have the same name', async () => {
      // "shot.png" in three folders: the first is small and goes inline, the other two are over
      // the 500 KB inline limit, so the API answers with two uploads of "shot.png".
      for (const [folder, size, content] of [['first', 10, 1], ['second', 600 * 1024, 2], ['third', 600 * 1024, 3]] as const) {
        fs.mkdirSync(path.join(dir, folder));
        fs.writeFileSync(path.join(dir, folder, 'shot.png'), Buffer.alloc(size, content));
      }
      mockCreateTask.mockResolvedValue(pendingUploads('shot.png', 'shot.png'));

      await submitWith('first/shot.png', 'second/shot.png', 'third/shot.png');

      const uploaded = await Promise.all(jest.mocked(global.fetch).mock.calls.map(async ([, init]) => {
        const file = (init?.body as FormData).get('file') as Blob;
        return new Uint8Array(await file.arrayBuffer())[0];
      }));
      expect(uploaded).toEqual([2, 3]);
    });

    test('fails when the API waits for an upload that no --attachment declared', async () => {
      fs.writeFileSync(path.join(dir, 'diagram.png'), Buffer.alloc(600 * 1024));
      mockCreateTask.mockResolvedValue(pendingUploads('other.png'));

      await expect(submitWith('diagram.png')).rejects.toThrow('No local file found for upload instruction: other.png');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test.each([
      ['with its reason', new TypeError('fetch failed'), 'Upload failed for diagram.png: fetch failed'],
      ['with a reason that is not an Error', 'socket closed', 'Upload failed for diagram.png: socket closed'],
      [
        'as a timeout when the request was aborted',
        Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
        'Upload timed out for diagram.png after 120s.',
      ],
    ])('reports an upload that fails %s', async (_how, thrown, message) => {
      fs.writeFileSync(path.join(dir, 'diagram.png'), Buffer.alloc(600 * 1024));
      mockCreateTask.mockResolvedValue(pendingUploads('diagram.png'));
      jest.mocked(global.fetch).mockRejectedValue(thrown);

      await expect(submitWith('diagram.png')).rejects.toThrow(message);
      expect(mockConfirmUploads).not.toHaveBeenCalled();
    });
  });

  describe('confirming presigned uploads', () => {
    const originalFetch = global.fetch;
    const submitted = { task_id: 'task-1', status: 'SUBMITTED' };
    let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
    let cwdSpy: jest.SpiedFunction<typeof process.cwd>;
    let dir: string;
    let argv: string[];

    beforeEach(() => {
      // A file over the 500 KB inline limit, inside what the command takes for the working directory.
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-submit-'));
      fs.writeFileSync(path.join(dir, 'diagram.png'), Buffer.alloc(600 * 1024));
      cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(dir);
      stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      global.fetch = jest.fn().mockResolvedValue(new Response(null, { status: 204 })) as typeof global.fetch;
      mockCreateTask.mockResolvedValue({
        task_id: 'task-1',
        status: 'PENDING_UPLOADS',
        upload_instructions: [{
          attachment_id: 'att-1',
          filename: 'diagram.png',
          upload_url: 'https://attachments.example/',
          upload_fields: { 'key': 'attachments/user-1/task-1/att-1/diagram.png', 'Content-Type': 'image/png' },
          upload_expires_at: '2026-01-01T00:10:00Z',
        }],
      });
      argv = [
        'node', 'test',
        '--repo', 'owner/repo',
        '--task', 'implement the spec',
        '--attachment', path.join(dir, 'diagram.png'),
        '--output', 'json',
      ];
    });

    afterEach(() => {
      global.fetch = originalFetch;
      cwdSpy.mockRestore();
      stderrSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // API Gateway ends the request after 29 s; the confirmation runs on behind it.
    const gatewayTimeout = () => new ApiError(504, 'HTTP_ERROR', 'HTTP 504: Gateway Timeout', '');
    const stillPending = { task_id: 'task-1', status: 'PENDING_UPLOADS' };

    test('after a gateway timeout, waits for the task to leave PENDING_UPLOADS and then confirms again', async () => {
      mockConfirmUploads.mockRejectedValueOnce(gatewayTimeout()).mockResolvedValueOnce(submitted);
      mockGetTask
        .mockResolvedValueOnce(stillPending)
        .mockResolvedValueOnce(stillPending)
        .mockResolvedValueOnce(submitted);

      await makeSubmitCommand().parseAsync(argv);

      expect(mockGetTask).toHaveBeenCalledTimes(3);
      expect(abortableSleep).toHaveBeenCalledTimes(3);
      expect(abortableSleep).toHaveBeenCalledWith(5_000);
      // Not a second confirmation beside the first one: it is sent once the task has moved on.
      expect(mockConfirmUploads).toHaveBeenCalledTimes(2);
      expect(mockConfirmUploads.mock.invocationCallOrder[1]).toBeGreaterThan(mockGetTask.mock.invocationCallOrder[2]);
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(submitted, null, 2));
    });

    test('confirms again when the first confirmation cannot be running any more', async () => {
      mockConfirmUploads.mockRejectedValueOnce(gatewayTimeout()).mockResolvedValueOnce(submitted);
      mockGetTask.mockResolvedValue(stillPending);

      await makeSubmitCommand().parseAsync(argv);

      // 33 reads 5 s apart are 165 s: a confirmation runs for 180 s at most, and 29 s had passed.
      expect(mockGetTask).toHaveBeenCalledTimes(33);
      expect(mockConfirmUploads).toHaveBeenCalledTimes(2);
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(submitted, null, 2));
    });

    // A read that fails for a moment says nothing about the confirmation, which runs on.
    test.each([
      ['is answered 502', new ApiError(502, 'HTTP_ERROR', 'HTTP 502: Bad Gateway', '')],
      ['loses its connection', new TypeError('fetch failed')],
    ])('keeps waiting when a read of the task %s', async (_how, readError) => {
      mockConfirmUploads.mockRejectedValueOnce(gatewayTimeout()).mockResolvedValueOnce(submitted);
      mockGetTask.mockRejectedValueOnce(readError).mockResolvedValueOnce(submitted);

      await makeSubmitCommand().parseAsync(argv);

      expect(mockGetTask).toHaveBeenCalledTimes(2);
      expect(mockConfirmUploads).toHaveBeenCalledTimes(2);
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(submitted, null, 2));
    });

    test('ends with the error of a read of the task that no later read can change', async () => {
      const notFound = new ApiError(404, 'TASK_NOT_FOUND', 'Task not found.', 'req-1');
      mockConfirmUploads.mockRejectedValueOnce(gatewayTimeout());
      mockGetTask.mockRejectedValue(notFound);

      await expect(makeSubmitCommand().parseAsync(argv)).rejects.toBe(notFound);
      expect(mockGetTask).toHaveBeenCalledTimes(1);
      expect(mockConfirmUploads).toHaveBeenCalledTimes(1);
    });

    test('reports the gateway timeout when the third confirmation times out too', async () => {
      const timeout = gatewayTimeout();
      mockConfirmUploads.mockRejectedValue(timeout);
      mockGetTask.mockResolvedValue(stillPending);

      await expect(makeSubmitCommand().parseAsync(argv)).rejects.toBe(timeout);
      expect(mockConfirmUploads).toHaveBeenCalledTimes(3);
    });

    test('does not wait or confirm again after an answer that is final', async () => {
      const blocked = new ApiError(400, 'ATTACHMENT_BLOCKED', "Attachment 'diagram.png' was blocked by content policy.", 'req-1');
      mockConfirmUploads.mockRejectedValue(blocked);

      await expect(makeSubmitCommand().parseAsync(argv)).rejects.toBe(blocked);
      expect(mockConfirmUploads).toHaveBeenCalledTimes(1);
      expect(mockGetTask).not.toHaveBeenCalled();
    });
  });
});
