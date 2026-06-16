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
 * rules command tests (issue #230).
 */

import { ApiClient } from '../../src/api-client';
import { makeRulesCommand } from '../../src/commands/rules';
import { ApiError } from '../../src/errors';

jest.mock('../../src/api-client');

/** Run `rules eval` for a fixture and capture stdout + resulting exit code. */
async function runEval(args: string[]): Promise<{ lines: string[]; exitCode: number }> {
  const cmd = makeRulesCommand();
  const prevExitCode = process.exitCode;
  process.exitCode = undefined;
  const lines: string[] = [];
  const logSpy = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(' '));
  });
  try {
    await cmd.parseAsync(['eval', ...args], { from: 'user' });
    return { lines, exitCode: process.exitCode ?? 0 };
  } finally {
    logSpy.mockRestore();
    process.exitCode = prevExitCode;
  }
}

describe('bgagent rules eval', () => {
  test('matches observe-repo-setup fixture (text output)', async () => {
    const { lines, exitCode } = await runEval(['--fixture', 'observe-repo-setup']);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('OK');
  });

  test('matches aggregate cost-ceiling fixture', async () => {
    const { lines, exitCode } = await runEval(['--fixture', 'aggregate-cost-cancel']);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('cost-ceiling');
  });

  test('matches aggregate turn-count fixture', async () => {
    const { lines, exitCode } = await runEval(['--fixture', 'aggregate-turn-count-escalate']);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('turn-ceiling');
  });

  test('matches async notify-on-pr fixture (milestone event name)', async () => {
    const { lines, exitCode } = await runEval(['--fixture', 'async-notify-pr']);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('notify-on-pr');
  });

  test('emits JSON when --output json', async () => {
    const { lines } = await runEval(['--fixture', 'observe-repo-setup', '--output', 'json']);
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.ok).toBe(true);
    expect(parsed.matched).toEqual(parsed.expected);
  });
});

describe('bgagent rules list', () => {
  const mockListEventRules = jest.fn();
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    mockListEventRules.mockReset();
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      listEventRules: mockListEventRules,
    }) as unknown as ApiClient);
  });

  afterEach(() => consoleSpy.mockRestore());

  async function runList(args: string[]): Promise<void> {
    await makeRulesCommand().parseAsync(['list', ...args], { from: 'user' });
  }

  test('renders rules with pack and reason', async () => {
    mockListEventRules.mockResolvedValue({
      repo_id: 'org/repo',
      event_rule_pack: { id: 'platform-default', version: 'v1' },
      rules: [
        { rule_id: 'r1', on: 'pr_created', action: 'notify', mode: 'enforce', evaluation: 'async', reason: 'ping' },
        { rule_id: 'r2', on: 'checkpoint:before_execution', action: 'require_approval', mode: 'observe_only', evaluation: 'sync' },
      ],
      registry_packs: [],
    });
    await runList(['--repo', 'org/repo']);
    const out = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(out).toContain('platform-default@v1');
    expect(out).toContain('r1');
    expect(out).toContain('ping');
    expect(out).toContain('[observe] r2');
  });

  test('reports empty rule set', async () => {
    mockListEventRules.mockResolvedValue({ repo_id: 'org/repo', rules: [], registry_packs: [] });
    await runList(['--repo', 'org/repo']);
    const out = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(out).toContain('(no rules configured)');
  });

  test('emits JSON when --output json', async () => {
    const payload = { repo_id: 'org/repo', rules: [], registry_packs: [] };
    mockListEventRules.mockResolvedValue(payload);
    await runList(['--repo', 'org/repo', '--output', 'json']);
    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual(payload);
  });

  test('wraps ApiError as CliError', async () => {
    mockListEventRules.mockRejectedValue(new ApiError(500, 'INTERNAL', 'boom', 'req-1'));
    await expect(runList(['--repo', 'org/repo'])).rejects.toThrow('boom');
  });
});
