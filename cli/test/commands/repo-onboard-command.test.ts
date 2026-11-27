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
import { makeRepoCommand } from '../../src/commands/repo';
import { onboardRepo, offboardRepo } from '../../src/repo-onboard';
import { getStackOutput, getStackOutputs } from '../../src/stack-outputs';

jest.mock('../../src/repo-onboard');
jest.mock('../../src/stack-outputs');

describe('repo onboard/offboard commands', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const originalRegion = process.env.AWS_REGION;

  // The files that --system-prompt-file reads; the test tables below name their paths.
  const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-repo-onboard-'));
  const promptFile = (name: string, content: string | Buffer): string => {
    const file = path.join(promptDir, name);
    fs.writeFileSync(file, content);
    return file;
  };
  afterAll(() => fs.rmSync(promptDir, { recursive: true, force: true }));

  beforeEach(() => {
    process.env.AWS_REGION = 'us-east-1';
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    (getStackOutput as jest.Mock).mockImplementation(async (_r: string, _s: string, key: string) => {
      if (key === 'RepoTableName') return 'RepoTable';
      if (key === 'RuntimeArn') return 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform';
      if (key === 'GitHubTokenSecretArn') return 'arn:aws:secretsmanager:us-east-1:123:secret:platform';
      return null;
    });
    (getStackOutputs as jest.Mock).mockImplementation(async (region: string, stack: string, keys: readonly string[]) => {
      const outputs: Record<string, string | null> = {};
      for (const key of keys) outputs[key] = await getStackOutput(region, stack, key);
      return outputs;
    });
    (onboardRepo as jest.Mock).mockResolvedValue({
      config: { repo: 'acme/a', status: 'active' },
    });
    (offboardRepo as jest.Mock).mockResolvedValue({
      repo: 'acme/a',
      status: 'removed',
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    if (originalRegion === undefined) {
      delete process.env.AWS_REGION;
    } else {
      process.env.AWS_REGION = originalRegion;
    }
  });

  test('repo onboard invokes onboardRepo', async () => {
    const cmd = makeRepoCommand();
    await cmd.parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1']);

    expect(onboardRepo).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('onboarded');
    expect(output).toContain('RepoTable only');
    expect(output).toContain('CDK Blueprint');
  });

  test('repo onboard warns when custom runtime is stored', async () => {
    (onboardRepo as jest.Mock).mockResolvedValue({
      config: {
        repo: 'acme/a',
        status: 'active',
        runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom',
      },
    });

    const cmd = makeRepoCommand();
    await cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a',
      '--region', 'us-east-1',
      '--runtime-arn', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom',
    ]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('additionalRuntimeArns');
  });

  test('repo onboard does not warn when the stored runtime and token are the platform outputs', async () => {
    (onboardRepo as jest.Mock).mockResolvedValue({
      config: {
        repo: 'acme/a',
        status: 'active',
        runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
        github_token_secret_arn: 'arn:aws:secretsmanager:us-east-1:123:secret:platform',
      },
    });

    const cmd = makeRepoCommand();
    await cmd.parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', '--output', 'json']);

    const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect((payload.notes as string[]).join('\n')).not.toContain('WARNING');
  });

  test('repo onboard JSON output includes notes', async () => {
    const cmd = makeRepoCommand();
    await cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a',
      '--region', 'us-east-1',
      '--output', 'json',
    ]);

    const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(payload.repo.repo).toBe('acme/a');
    expect(payload.notes.length).toBeGreaterThan(0);
  });

  test.each([
    [undefined, 'onboarded'],
    ['active', 'updated'],
    ['removed', 're-activated'],
  ])('repo onboard reports a row whose status was %s as %s', async (status, change) => {
    (onboardRepo as jest.Mock).mockResolvedValue({
      config: { repo: 'acme/a', status: 'active' },
      previous: status && { repo: 'acme/a', status },
    });

    await makeRepoCommand().parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1']);
    expect(consoleSpy.mock.calls[0][0]).toBe(`Repository 'acme/a' ${change} (status: active).`);

    consoleSpy.mockClear();
    await makeRepoCommand().parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', '--output', 'json']);
    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string).change).toBe(change);
  });

  test('repo onboard rejects invalid compute type', async () => {
    const cmd = makeRepoCommand();
    await expect(cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a',
      '--region', 'us-east-1',
      '--compute-type', 'lambda',
    ])).rejects.toThrow("compute-type must be 'agentcore', 'ecs', or 'lambda-microvm'");
  });

  test('repo onboard accepts lambda-microvm compute type', async () => {
    const cmd = makeRepoCommand();
    await cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a',
      '--region', 'us-east-1',
      '--compute-type', 'lambda-microvm',
    ]);

    expect((onboardRepo as jest.Mock).mock.calls[0][3]).toEqual(
      expect.objectContaining({ set: expect.objectContaining({ compute_type: 'lambda-microvm' }) }),
    );
  });

  test.each([
    [['--compute-type', ' ecs '], { compute_type: 'ecs' }, []],
    [['--runtime-arn', ' arn:runtime '], { runtime_arn: 'arn:runtime' }, []],
    [['--model', ' global.anthropic.claude-opus-5-5 '], { model_id: 'global.anthropic.claude-opus-5-5' }, []],
    [['--token-secret-arn', ' arn:secret '], { github_token_secret_arn: 'arn:secret' }, []],
    [['--max-turns', '1'], { max_turns: 1 }, []],
    [['--max-turns', '500'], { max_turns: 500 }, []],
    [['--poll-interval', '0'], { poll_interval_ms: 0 }, []],
    [['--max-budget', '0.01'], { max_budget_usd: 0.01 }, []],
    [['--max-budget', '100'], { max_budget_usd: 100 }, []],
    [['--max-budget', '007.50'], { max_budget_usd: 7.5 }, []],
    [['--memory-token-budget', '1'], { memory_token_budget: 1 }, []],
    [['--memory-token-budget', '9007199254740991'], { memory_token_budget: Number.MAX_SAFE_INTEGER }, []],
    [['--approval-gate-cap', '1'], { approval_gate_cap: 1 }, []],
    [['--approval-gate-cap', '500'], { approval_gate_cap: 500 }, []],
    [['--build-command', ' npm run build && npm test '], { build_command: 'npm run build && npm test' }, []],
    [['--lint-command', ' npm run lint '], { lint_command: 'npm run lint' }, []],
    [['--system-prompt-file', promptFile('prompt.md', '\nPrefer small commits.\nNo force pushes.\n')], { system_prompt_overrides: 'Prefer small commits.\nNo force pushes.' }, []],
    [
      ['--compute-type', 'agentcore', '--runtime-arn', 'arn:runtime', '--token-secret-arn', 'arn:secret', '--max-turns', '50', '--poll-interval', '1000'],
      { compute_type: 'agentcore', runtime_arn: 'arn:runtime', github_token_secret_arn: 'arn:secret', max_turns: 50, poll_interval_ms: 1000 },
      [],
    ],
    [
      ['--max-budget', '2.5', '--memory-token-budget', '4000', '--approval-gate-cap', '20', '--build-command', 'make', '--lint-command', 'make lint'],
      { max_budget_usd: 2.5, memory_token_budget: 4000, approval_gate_cap: 20, build_command: 'make', lint_command: 'make lint' },
      [],
    ],
    // A column without a flag can still be removed.
    [['--unset', 'mcp_servers', '--unset', 'cedar_policies'], {}, ['mcp_servers', 'cedar_policies']],
    // onboardRepo refuses a column that is both set and unset; the command passes both on.
    [['--unset', 'model_id', '--model', 'global.anthropic.claude-opus-5-5'], { model_id: 'global.anthropic.claude-opus-5-5' }, ['model_id']],
  ])('repo onboard %j passes the deployment, set %j and unset %j', async (flags, set, unset) => {
    await makeRepoCommand().parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', ...flags]);

    expect((onboardRepo as jest.Mock).mock.calls[0][3]).toStrictEqual({
      deployment: { stackName: 'backgroundagent-dev', computeSubstrate: null, computeDeploymentMode: null, computeTypes: null },
      set,
      unset,
    });
  });

  test('repo onboard stores a --system-prompt-file of exactly 64 KB', async () => {
    const text = 'é'.repeat(32 * 1024);
    await makeRepoCommand().parseAsync([
      'node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', '--system-prompt-file', promptFile('limit.md', text),
    ]);

    expect((onboardRepo as jest.Mock).mock.calls[0][3].set).toStrictEqual({ system_prompt_overrides: text });
  });

  const COMPUTE_TYPE_REFUSAL = "--compute-type must be 'agentcore', 'ecs', or 'lambda-microvm'.";
  const MAX_TURNS_REFUSAL = '--max-turns must be an integer between 1 and 500 (use --unset max_turns for the platform default).';
  const POLL_INTERVAL_REFUSAL = '--poll-interval must be a whole number of milliseconds.';
  const MAX_BUDGET_REFUSAL = '--max-budget must be a number between 0.01 and 100 (use --unset max_budget_usd to remove the budget).';
  const MEMORY_TOKEN_BUDGET_REFUSAL = '--memory-token-budget must be an integer between 1 and 9007199254740991 '
    + '(use --unset memory_token_budget for the platform default).';
  const APPROVAL_GATE_CAP_REFUSAL = '--approval-gate-cap must be an integer between 1 and 500 (use --unset approval_gate_cap for the platform default).';
  const emptyRefusal = (flag: string, column: string): string => `${flag} must not be empty (use --unset ${column} to remove the setting).`;
  const ABSENT_FILE = path.join(promptDir, 'absent.md');
  const LATIN1_FILE = promptFile('latin1.md', Buffer.from('café', 'latin1'));
  // ASCII text in UTF-16 without a byte order mark is valid UTF-8, with a NUL after every character.
  const UTF16_FILE = promptFile('utf16.md', Buffer.from('Prefer small commits.', 'utf16le'));
  const COLUMNS = 'compute_type, runtime_arn, model_id, github_token_secret_arn, max_turns, poll_interval_ms, max_budget_usd, '
    + 'memory_token_budget, approval_gate_cap, build_command, lint_command, system_prompt_overrides, cedar_policies, mcp_servers, '
    + 'cedar_policy_modules, skills';

  test.each([
    ['--compute-type', '', COMPUTE_TYPE_REFUSAL],
    ['--compute-type', ' ', COMPUTE_TYPE_REFUSAL],
    ['--runtime-arn', '', emptyRefusal('--runtime-arn', 'runtime_arn')],
    ['--model', ' ', emptyRefusal('--model', 'model_id')],
    ['--token-secret-arn', '', emptyRefusal('--token-secret-arn', 'github_token_secret_arn')],
    ['--max-turns', '0', MAX_TURNS_REFUSAL],
    ['--max-turns', '501', MAX_TURNS_REFUSAL],
    ['--max-turns', '12abc', MAX_TURNS_REFUSAL],
    ['--max-turns', '0x10', MAX_TURNS_REFUSAL],
    ['--max-turns', '1e2', MAX_TURNS_REFUSAL],
    ['--max-turns', '+5', MAX_TURNS_REFUSAL],
    ['--max-turns', '1.5', MAX_TURNS_REFUSAL],
    ['--max-turns', '', MAX_TURNS_REFUSAL],
    ['--max-turns', ' 50 ', MAX_TURNS_REFUSAL],
    ['--poll-interval', '12abc', POLL_INTERVAL_REFUSAL],
    ['--poll-interval', '-1', POLL_INTERVAL_REFUSAL],
    ['--poll-interval', '9007199254740993', POLL_INTERVAL_REFUSAL],
    ['--max-budget', '0', MAX_BUDGET_REFUSAL],
    ['--max-budget', '0.009', MAX_BUDGET_REFUSAL],
    ['--max-budget', '100.01', MAX_BUDGET_REFUSAL],
    ['--max-budget', '1e2', MAX_BUDGET_REFUSAL],
    ['--max-budget', '.5', MAX_BUDGET_REFUSAL],
    ['--max-budget', '5.', MAX_BUDGET_REFUSAL],
    ['--max-budget', '+5', MAX_BUDGET_REFUSAL],
    ['--max-budget', '5usd', MAX_BUDGET_REFUSAL],
    ['--max-budget', ' 5 ', MAX_BUDGET_REFUSAL],
    ['--max-budget', '', MAX_BUDGET_REFUSAL],
    ['--memory-token-budget', '0', MEMORY_TOKEN_BUDGET_REFUSAL],
    ['--memory-token-budget', '1.5', MEMORY_TOKEN_BUDGET_REFUSAL],
    ['--memory-token-budget', '9007199254740993', MEMORY_TOKEN_BUDGET_REFUSAL],
    ['--approval-gate-cap', '0', APPROVAL_GATE_CAP_REFUSAL],
    ['--approval-gate-cap', '501', APPROVAL_GATE_CAP_REFUSAL],
    ['--approval-gate-cap', '5.0', APPROVAL_GATE_CAP_REFUSAL],
    ['--build-command', '', emptyRefusal('--build-command', 'build_command')],
    ['--lint-command', ' ', emptyRefusal('--lint-command', 'lint_command')],
    ['--system-prompt-file', ABSENT_FILE, `Cannot read --system-prompt-file '${ABSENT_FILE}': ENOENT`],
    ['--system-prompt-file', LATIN1_FILE, `Cannot read --system-prompt-file '${LATIN1_FILE}': `],
    ['--system-prompt-file', UTF16_FILE, `Cannot read --system-prompt-file '${UTF16_FILE}': the file holds a NUL character (UTF-16 or binary?)`],
    ['--system-prompt-file', promptFile('blank.md', ' \n\t\n'), emptyRefusal('--system-prompt-file', 'system_prompt_overrides')],
    // 65,537 bytes of UTF-8 in 32,769 characters.
    ['--system-prompt-file', promptFile('large.md', `${'é'.repeat(32 * 1024)}a`), '--system-prompt-file: 65537 bytes exceed the limit of 65536.'],
    ['--unset', 'nope', `--unset 'nope' is not a per-repo setting. Valid names: ${COLUMNS}.`],
    ['--unset', 'toString', "--unset 'toString' is not a per-repo setting."],
  ])('repo onboard refuses %s %p before it reads the stack', async (flag, value, message) => {
    await expect(makeRepoCommand().parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', flag, value]))
      .rejects.toThrow(message);

    expect(getStackOutputs).not.toHaveBeenCalled();
    expect(onboardRepo).not.toHaveBeenCalled();
  });

  test('repo onboard --help names every setting flag and every column that --unset accepts', () => {
    const help = makeRepoCommand().commands.find((command) => command.name() === 'onboard')?.helpInformation();

    for (const name of [
      '--compute-type <type>', '--runtime-arn <arn>', '--model <model-id>', '--token-secret-arn <arn>', '--max-turns <n>',
      '--poll-interval <ms>', '--max-budget <usd>', '--memory-token-budget <tokens>', '--approval-gate-cap <n>',
      '--build-command <command>', '--lint-command <command>', '--system-prompt-file <path>', '--unset <column>', ...COLUMNS.split(', '),
    ]) {
      expect(help).toContain(name);
    }
  });

  test('reads BedrockGeoRegion and BedrockModelIds by their exact output names', async () => {
    // Both new checks read stack outputs by literal name, and a typo in either makes
    // them silent no-ops with the suite still green: `getStackOutput` returns null for
    // an unknown key, and null means "stack does not export this — skip". So a
    // misspelling degrades the guard to nothing rather than failing loudly.
    //
    // Asserted on the KEYS requested, which is the only place the literal appears.
    const cmd = makeRepoCommand();
    await cmd.parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1']);

    const keys = (getStackOutput as jest.Mock).mock.calls.map((c) => c[2]);
    expect(keys).toContain('BedrockGeoRegion');
    expect(keys).toContain('BedrockModelIds');
  });

  test('rejects a --model whose geography the stack does not grant', async () => {
    // End-to-end through the command, not just the guard in isolation: proves the
    // output value actually reaches assertModelIdUsable and that a rejection aborts
    // before onboardRepo writes anything.
    (getStackOutput as jest.Mock).mockImplementation(async (_r: string, _s: string, key: string) => {
      if (key === 'RepoTableName') return 'RepoTable';
      if (key === 'BedrockGeoRegion') return 'global';
      return null;
    });
    const cmd = makeRepoCommand();
    await expect(cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1',
      '--model', 'us.anthropic.claude-opus-5',
    ])).rejects.toThrow(/grants 'global' profiles/);
    expect(onboardRepo).not.toHaveBeenCalled();
  });

  test('rejects a --model outside the set the stack grants', async () => {
    // Without the granted set the check is skipped, as on a stack that does not export the set.
    (getStackOutput as jest.Mock).mockImplementation(async (_r: string, _s: string, key: string) => {
      if (key === 'RepoTableName') return 'RepoTable';
      if (key === 'BedrockGeoRegion') return 'global';
      if (key === 'BedrockModelIds') return 'anthropic.claude-haiku-5-5';
      return null;
    });
    const cmd = makeRepoCommand();
    await expect(cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1',
      '--model', 'global.anthropic.claude-opus-5-5',
    ])).rejects.toThrow(/is not granted by stack/);
    expect(onboardRepo).not.toHaveBeenCalled();
  });

  test('repo offboard invokes offboardRepo', async () => {
    const cmd = makeRepoCommand();
    await cmd.parseAsync(['node', 'test', 'offboard', 'acme/a', '--region', 'us-east-1']);

    expect(offboardRepo).toHaveBeenCalled();
    expect(consoleSpy.mock.calls[0][0]).toContain('offboarded');
  });
});
