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

  // The files that --system-prompt-file and --cedar-policy-file read; the test tables below name their paths.
  const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-repo-onboard-'));
  const promptFile = (name: string, content: string | Buffer): string => {
    const file = path.join(promptDir, name);
    fs.writeFileSync(file, content);
    return file;
  };
  afterAll(() => fs.rmSync(promptDir, { recursive: true, force: true }));

  const HARD_RULE = '@tier("hard")\n@rule_id("no_terraform_destroy")\n'
    + 'forbid (principal, action == Agent::Action::"execute_bash", resource)\nwhen { context.command like "*terraform destroy*" };';
  const SOFT_RULE = '@tier("soft")\n@rule_id("ask_before_publish")\n@approval_timeout_s("300")\n@severity("medium")\n'
    + 'forbid (principal, action == Agent::Action::"execute_bash", resource)\nwhen { context.command like "*npm publish*" };';
  const MCP_REF = 'registry://mcp_server/acme/aws-knowledge@^1.0.0';
  const MODULE_REF = 'registry://cedar_policy_module/acme/guard@^1.0.0';
  const SKILL_REF = 'registry://skill/acme/readme-helper@^1.0.0';

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
    expect(output).toContain('still need a CDK deploy');
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
      ['--cedar-policy-file', promptFile('hard.cedar', `\n${HARD_RULE}\n`), '--cedar-policy-file', promptFile('soft.cedar', SOFT_RULE)],
      { cedar_policies: [HARD_RULE, SOFT_RULE] },
      [],
    ],
    [['--mcp-server', ` ${MCP_REF} `], { mcp_servers: [MCP_REF] }, []],
    [['--cedar-policy-module', MODULE_REF], { cedar_policy_modules: [MODULE_REF] }, []],
    [['--skill', SKILL_REF, '--skill', 'registry://skill/acme/changelog@1.2.3'], { skills: [SKILL_REF, 'registry://skill/acme/changelog@1.2.3'] }, []],
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
    // No setting flag: nothing is set. A list flag that is not given is not an empty list.
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

  test('repo onboard holds the --cedar-policy-file texts together to the size the agent accepts', async () => {
    // The agent refuses more operator rules than this, so the CLI's copy of the number has to follow it.
    const policy = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'agent', 'src', 'policy.py'), 'utf-8');
    const [, kib, bytesPerKib] = /^POLICIES_MAX_BYTES: int = (\d+) \* (\d+)\b/m.exec(policy) ?? [];
    const limit = Number(kib) * Number(bytesPerKib);
    expect(limit).toBeGreaterThan(0);
    // Two bytes per character: a count of characters would let both commands through.
    const most = 'é'.repeat(limit / 2 - 1);
    const onboard = (last: string): Promise<unknown> => makeRepoCommand().parseAsync([
      'node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1',
      '--cedar-policy-file', promptFile('most.cedar', most), '--cedar-policy-file', promptFile('last.cedar', last),
    ]);

    await onboard('é');
    expect((onboardRepo as jest.Mock).mock.calls[0][3].set).toStrictEqual({ cedar_policies: [most, 'é'] });

    await expect(onboard('éa')).rejects.toThrow(`--cedar-policy-file: ${limit + 1} bytes exceed the limit of ${limit}.`);
    expect(onboardRepo).toHaveBeenCalledTimes(1);
  });

  test('repo onboard says which stored lists it replaced, in front of the other notes', async () => {
    (onboardRepo as jest.Mock).mockResolvedValue({
      config: { repo: 'acme/a', status: 'active' },
      previous: {
        repo: 'acme/a',
        status: 'active',
        cedar_policies: [HARD_RULE],
        mcp_servers: ['registry://mcp_server/acme/docs@1.0.0', 'registry://mcp_server/acme/search@1.0.0'],
        cedar_policy_modules: [],
      },
    });
    const onboard = ['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1'];

    // No note for a list that is stored but not given, that is stored empty, or that is not stored.
    await makeRepoCommand().parseAsync([...onboard, '--mcp-server', MCP_REF, '--cedar-policy-module', MODULE_REF, '--skill', SKILL_REF]);
    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    expect(lines.slice(0, 4)).toEqual([
      "Repository 'acme/a' updated (status: active).",
      undefined,
      'mcp_servers: stored entries replaced (2 before, 1 now).',
      expect.stringContaining('RepoTable only'),
    ]);

    consoleSpy.mockClear();
    await makeRepoCommand().parseAsync([
      ...onboard, '--output', 'json', '--mcp-server', MCP_REF,
      '--cedar-policy-file', promptFile('one.cedar', HARD_RULE), '--cedar-policy-file', promptFile('two.cedar', SOFT_RULE),
    ]);
    const { notes } = JSON.parse(consoleSpy.mock.calls[0][0] as string) as { notes: string[] };
    expect(notes.slice(0, 3)).toEqual([
      'cedar_policies: stored entries replaced (1 before, 2 now).',
      'mcp_servers: stored entries replaced (2 before, 1 now).',
      expect.stringContaining('RepoTable only'),
    ]);
  });

  test.each([
    [' ', '--skill must not be empty (use --unset skills to remove the setting).'],
    [MODULE_REF, `--skill must start with registry://skill/ (got '${MODULE_REF}').`],
  ])('repo onboard refuses a second --skill %p after a good one', async (second, message) => {
    await expect(makeRepoCommand().parseAsync([
      'node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', '--skill', SKILL_REF, '--skill', second,
    ])).rejects.toThrow(message);

    expect(getStackOutputs).not.toHaveBeenCalled();
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
    ['--cedar-policy-file', ABSENT_FILE, `Cannot read --cedar-policy-file '${ABSENT_FILE}': ENOENT`],
    ['--cedar-policy-file', UTF16_FILE, `Cannot read --cedar-policy-file '${UTF16_FILE}': the file holds a NUL character (UTF-16 or binary?)`],
    ['--cedar-policy-file', promptFile('blank.cedar', ' \n\t\n'), emptyRefusal('--cedar-policy-file', 'cedar_policies')],
    ['--mcp-server', SKILL_REF, `--mcp-server must start with registry://mcp_server/ (got '${SKILL_REF}').`],
    ['--mcp-server', `x${MCP_REF}`, `--mcp-server must start with registry://mcp_server/ (got 'x${MCP_REF}').`],
    ['--cedar-policy-module', MCP_REF, `--cedar-policy-module must start with registry://cedar_policy_module/ (got '${MCP_REF}').`],
    // A kind that only begins like the flag's.
    ['--skill', 'registry://skills/acme/readme-helper@^1.0.0', "--skill must start with registry://skill/ (got 'registry://skills/acme/readme-helper@^1.0.0')."],
    ['--skill', ' ', emptyRefusal('--skill', 'skills')],
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
      '--build-command <command>', '--lint-command <command>', '--system-prompt-file <path>', '--cedar-policy-file <path>',
      '--mcp-server <ref>', '--cedar-policy-module <ref>', '--skill <ref>', '--unset <column>', ...COLUMNS.split(', '),
    ]) {
      expect(help).toContain(name);
    }
  });

  test.each([
    ['--cedar-policy-file', 'The files given replace the stored rules. One tier per file: hard and soft rules go in separate files. The files are UTF-8, at most 64 KB together.'],
    ['--mcp-server', 'registry://mcp_server/namespace/name@constraint (repeatable). The refs given replace the stored list.'],
    ['--cedar-policy-module', 'registry://cedar_policy_module/namespace/name@constraint (repeatable). The refs given replace the stored list.'],
    ['--skill', 'registry://skill/namespace/name@constraint (repeatable). The refs given replace the stored list.'],
  ])('repo onboard --help says of %s that it replaces what is stored, and prints no default behind that', (flag, sentence) => {
    const onboard = makeRepoCommand().commands.find((command) => command.name() === 'onboard');
    const option = onboard?.options.find((candidate) => candidate.long === flag);

    expect(option?.description).toContain(sentence);
    // "(default: [])" behind the sentence would read as: without the flag, the stored list is replaced by an empty one.
    expect(option?.defaultValue).toBeUndefined();
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

  const stackDeploying = (features: string | null) => async (_r: string, _s: string, key: string) =>
    ({ RepoTableName: 'RepoTable', DeploymentFeatures: features } as Record<string, string | null>)[key] ?? null;

  test.each([
    ['--mcp-server', MCP_REF, 'slack,toolGateway'],
    ['--cedar-policy-module', MODULE_REF, 'slack,toolGateway'],
    ['--skill', SKILL_REF, 'none'],
  ])('rejects %s %s on a stack that deploys %s: without the registry every task of the repository would fail', async (flag, ref, features) => {
    (getStackOutput as jest.Mock).mockImplementation(stackDeploying(features));

    await expect(makeRepoCommand().parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', flag, ref]))
      .rejects.toThrow("AWS Agent Registry is not deployed in stack 'backgroundagent-dev'.");
    expect(onboardRepo).not.toHaveBeenCalled();
  });

  test.each([
    ['a pin on a stack that deploys the registry', ['--skill', SKILL_REF], 'slack, agentRegistry'],
    ['a pin on an older stack, which does not say what it deploys', ['--skill', SKILL_REF], null],
    // Rule text is no pin, and neither is the removal of pins.
    ['settings that pin nothing on a stack without the registry', ['--cedar-policy-file', promptFile('rules.cedar', SOFT_RULE), '--unset', 'skills'], 'none'],
  ])('accepts %s', async (_case, flags, features) => {
    (getStackOutput as jest.Mock).mockImplementation(stackDeploying(features));

    await makeRepoCommand().parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', ...flags]);

    expect(onboardRepo).toHaveBeenCalledTimes(1);
  });

  test('repo offboard invokes offboardRepo', async () => {
    const cmd = makeRepoCommand();
    await cmd.parseAsync(['node', 'test', 'offboard', 'acme/a', '--region', 'us-east-1']);

    expect(offboardRepo).toHaveBeenCalled();
    expect(consoleSpy.mock.calls[0][0]).toContain('offboarded');
  });
});
