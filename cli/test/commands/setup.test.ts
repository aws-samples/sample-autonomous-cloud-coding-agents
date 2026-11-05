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
import {
  conflictingContextOverrides,
  ExistingStack,
  identityLabel,
  makeSetupCommand,
  parseContextArgs,
  parseStateBearingChanges,
  runSetup,
  SETUP_CANCELLED_EXIT_CODE,
  setupCancelled,
  SetupDeps,
  SetupOptions,
} from '../../src/commands/setup';
import { DEPLOYMENT_PROFILE_FILE, MINIMAL_DEPLOYMENT_FEATURES, serializeDeploymentProfile } from '../../src/deployment-profile';
import { CliConfig } from '../../src/types';

const BUNDLE: CliConfig = {
  api_url: 'https://api.example.com/v1/', region: 'us-east-1', user_pool_id: 'pool', client_id: 'client',
};
const NO_CHANGES = 'Stack backgroundagent-dev\nThere were no differences\n';
/** Shape of real `cdk diff` output (aws-cdk 2.x formatter): the impact word ends each resource line. */
const DELETES_SLACK_TABLE = [
  'Stack backgroundagent-dev',
  'Resources',
  '[-] AWS::DynamoDB::Table SlackIntegration/InstallationTable SlackIntegrationInstallationTable0F3B destroy',
  '[-] AWS::Lambda::Function SlackIntegration/EventsFn SlackIntegrationEventsFn1A2B destroy',
].join('\n');

let root: string;
let configDir: string;
let out: string[];
let runs: { args: readonly string[]; env: NodeJS.ProcessEnv; logFile: string; profileAtRun?: string }[];
/** Everything the wizard printed, as plain text. */
const text = () => out.join('');
/** Deploy event lines in `cdk deploy --progress events` format. */
const event = (n: number, total: number, status: string, constructPath: string, id: string, reason = '') =>
  `backgroundagent-dev | ${n}/${total} | 1:00:00 PM | ${status.padEnd(20)} | AWS::Lambda::Function | backgroundagent-dev/${constructPath}/Resource (${id}) ${reason}`;

function stack(outputs: Record<string, string>, status = 'UPDATE_COMPLETE', parameters: Record<string, string> = {}): ExistingStack {
  return { outputs: new Map(Object.entries(outputs)), parameters: new Map(Object.entries(parameters)), status, account: '123456789012' };
}

/** A current ABCA bootstrap that already allows AgentCore. */
const BOOTSTRAPPED = stack({ BootstrapPolicyVersion: '1.8.0' }, 'UPDATE_COMPLETE', { ComputeTypes: 'agentcore' });

/** Name-aware stack lookup: only the listed stacks (plus a current bootstrap unless overridden) exist. */
const stacks = (byName: Record<string, ExistingStack | null>) => async (_region: string, name: string) =>
  (name in byName ? byName[name] : name === 'CDKToolkit' ? BOOTSTRAPPED : null) ?? null;

type FakeOptions = Partial<SetupDeps> & {
  answers?: string[]; diff?: string; diffCode?: number; deployCode?: number; deployLines?: string[];
};

function deps(overrides: FakeOptions = {}): SetupDeps {
  const answers = [...(overrides.answers ?? [])];
  return {
    cwd: root,
    interactive: true,
    describeStack: stacks({}),
    hasToolGateway: async () => false,
    containerEngine: async () => 'docker',
    setBootstrapComputeTypes: async () => undefined,
    callerIdentity: async () => ({ account: '123456789012', arn: 'arn:aws:sts::123456789012:assumed-role/Admin/me' }),
    listDeployments: async () => [],
    // Running out of scripted answers behaves like a closed terminal.
    ask: async () => {
      if (answers.length === 0) throw setupCancelled();
      return answers.shift()!;
    },
    run: async (args, options) => {
      const profilePath = path.join(root, DEPLOYMENT_PROFILE_FILE);
      runs.push({ ...options, args, profileAtRun: fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf-8') : undefined });
      if (args[0] === '//cdk:diff') {
        // The candidate profile must exist while the diff runs.
        const candidate = args[args.length - 1].replace('deploymentProfile=', '');
        expect(fs.existsSync(candidate)).toBe(true);
        return { code: overrides.diffCode ?? 0, output: overrides.diff ?? NO_CHANGES };
      }
      for (const line of overrides.deployLines ?? []) options.onLine?.(line);
      return { code: overrides.deployCode ?? 0, output: '' };
    },
    configureFromStack: async () => BUNDLE,
    screen: { tty: false, write: chunk => { out.push(chunk); } },
    now: (() => { let t = 0; return () => (t += 30_000); })(),
    ...overrides,
  };
}

const profileOnDisk = () => {
  const file = path.join(root, DEPLOYMENT_PROFILE_FILE);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')).features : undefined;
};
/** Most tests name the stack; the picker has its own tests below. */
const setup = (opts: SetupOptions, d: SetupDeps) => runSetup({ region: 'us-east-1', stackName: 'backgroundagent-dev', ...opts }, d);
/** Accept the account confirmation (defaults to yes). */
const ACCOUNT_OK = '';
const ENTER_ALL = ['', '', '', '', '', ''];
/** Accept the preselected compute (AgentCore) on a new installation. */
const COMPUTE_DEFAULT = '';
const profileFile = () => JSON.parse(fs.readFileSync(path.join(root, DEPLOYMENT_PROFILE_FILE), 'utf-8'));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-setup-test-'));
  fs.mkdirSync(path.join(root, 'cdk'));
  fs.writeFileSync(path.join(root, 'cdk', 'cdk.json'), JSON.stringify({ context: { bedrockGeoRegion: 'global' } }));
  fs.writeFileSync(path.join(root, 'mise.toml'), '');
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-setup-config-'));
  process.env.BGAGENT_CONFIG_DIR = configDir;
  out = [];
  runs = [];
  process.exitCode = undefined;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  delete process.env.BGAGENT_CONFIG_DIR;
  process.exitCode = undefined;
});

describe('new installation', () => {
  test('recommends the minimal profile, diffs a candidate, then writes, deploys and configures', async () => {
    await setup({}, deps({ answers: [ACCOUNT_OK, COMPUTE_DEFAULT, ...ENTER_ALL, 'y'] }));
    expect(text()).toContain('New installation: every optional feature defaults to off (the governed minimal profile).');
    expect(profileOnDisk()).toEqual(MINIMAL_DEPLOYMENT_FEATURES);
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff', '//cdk:deploy']);
    // Diff ran before the repository profile existed; deploy ran after, on that same file.
    expect(runs[0].profileAtRun).toBeUndefined();
    expect(runs[1].profileAtRun).toBe(serializeDeploymentProfile({ features: MINIMAL_DEPLOYMENT_FEATURES, compute: ['agentcore'] }));
    expect(runs[0].args).toEqual(expect.arrayContaining(['-c', 'stackName=backgroundagent-dev']));
    expect(runs[1].args).toEqual([
      '//cdk:deploy', '--', '-c', 'stackName=backgroundagent-dev',
      '-c', `deploymentProfile=${path.join(root, DEPLOYMENT_PROFILE_FILE)}`, '--all', '--require-approval', 'never', '--progress', 'events',
    ]);
    // Raw CDK output goes to log files, not the terminal.
    expect(runs.map(r => path.basename(r.logFile))).toEqual(['setup-changes.log', 'setup-deploy.log']);
    expect(text()).toContain('Deployment complete in');
    expect(text()).toContain(`API      ${BUNDLE.api_url}`);
    expect(runs[0].env).toMatchObject({ AWS_REGION: 'us-east-1', CDK_DEFAULT_REGION: 'us-east-1', MISE_EXPERIMENTAL: '1' });
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'))).toEqual({ ...BUNDLE, stack_name: 'backgroundagent-dev' });
  });

  test('asks about each available feature and records the answers', async () => {
    await setup({}, deps({ answers: [ACCOUNT_OK, COMPUTE_DEFAULT, 'y', 'n', 'y', 'n', 'n', 'n', 'y'] }));
    expect(profileOnDisk()).toEqual({ ...MINIMAL_DEPLOYMENT_FEATURES, slack: true, jira: true });
  });

  test('marks Region-unavailable features and never asks about them', async () => {
    const asked: string[] = [];
    const d = deps({ answers: [ACCOUNT_OK, COMPUTE_DEFAULT, 'n', 'n', 'n', 'n', 'n', 'y'] });
    await runSetup({ region: 'eu-west-3', stackName: 'backgroundagent-dev' }, { ...d, ask: async q => { asked.push(q); return d.ask(q); } });
    expect(text()).toContain('✗ AWS Agent Registry — not available in eu-west-3');
    expect(asked.some(q => q.includes('AWS Agent Registry'))).toBe(false);
    expect(profileOnDisk().agentRegistry).toBe(false);
  });

  test('shows the account and identity the credentials resolve to', async () => {
    await setup({ features: 'none', yes: true }, deps({ callerIdentity: async () => ({ account: '123456789012', arn: 'arn:aws:iam::123456789012:user/ops' }) }));
    expect(text()).toContain('Account  123456789012  ops (IAM user)');
  });

  test('prompts for the Region when none is configured', async () => {
    const saved = { AWS_REGION: process.env.AWS_REGION, AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION };
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      await runSetup({ stackName: 'backgroundagent-dev' }, deps({ answers: ['us-west-2', ACCOUNT_OK, COMPUTE_DEFAULT, ...ENTER_ALL, 'y'] }));
      expect(text()).toContain('Region   us-west-2');
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
    }
  });

  test('rejects a Region without the core AgentCore services', async () => {
    await expect(runSetup({ region: 'us-west-1' }, deps())).rejects.toThrow(/ABCA cannot be deployed to us-west-1/);
    expect(runs).toEqual([]);
  });
});

describe('existing deployments', () => {
  test('preselects published features so accepting defaults removes nothing', async () => {
    const d = deps({ describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'slack,linear' }) }), answers: [ACCOUNT_OK, ...ENTER_ALL, 'y'] });
    await setup({}, d);
    expect(text()).toContain('Deployed Slack, Linear');
    expect(text()).toContain('Account  123456789012');
    expect(profileOnDisk()).toEqual({ ...MINIMAL_DEPLOYMENT_FEATURES, slack: true, linear: true });
    expect(text()).not.toContain('will be removed');
  });

  test('infers features on stacks that predate profiles, including the Tool Gateway', async () => {
    const legacy = stack({
      SlackAppManifestJson: '{}', LinearWebhookSecretArn: 'a', JiraWebhookSecretArn: 'b', GitHubWebhookUrl: 'c', RegistryApiUrl: 'd',
    });
    await setup({ yes: true }, deps({ describeStack: stacks({ 'backgroundagent-dev': legacy }), hasToolGateway: async () => true }));
    expect(text()).toContain('(detected)');
    expect(profileOnDisk()).toEqual({
      slack: true, linear: true, jira: true, deployPreviewScreenshots: true, agentRegistry: true, toolGateway: true,
    });
  });

  test('refuses to run while the stack is mid-operation', async () => {
    await expect(setup({ yes: true }, deps({ describeStack: stacks({ 'backgroundagent-dev': stack({}, 'UPDATE_IN_PROGRESS') }) })))
      .rejects.toThrow(/UPDATE_IN_PROGRESS/);
  });

  test('surfaces stack read failures instead of treating the stack as new', async () => {
    const describeStack = async () => { throw new Error('AccessDenied'); };
    await expect(setup({ yes: true }, deps({ describeStack }))).rejects.toThrow('AccessDenied');
    expect(runs).toEqual([]);
  });

  test('refuses to rewrite a profile for features this CLI does not know', async () => {
    const d = deps({ describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'slack,teams' }) }) });
    await expect(setup({ yes: true }, d)).rejects.toThrow(/Upgrade the CLI/);
  });

  test('flags removed features and requires typing the stack name for data loss', async () => {
    const d = deps({
      describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'slack' }) }),
      diff: DELETES_SLACK_TABLE,
      answers: [ACCOUNT_OK, 'n', '', '', '', '', '', 'backgroundagent-dev'],
    });
    await setup({}, d);
    expect(text()).toMatch(/✗ Slack\s+will be removed/);
    expect(text()).toContain('• Slack: 1 table');
    expect(profileOnDisk()).toEqual(MINIMAL_DEPLOYMENT_FEATURES);
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff', '//cdk:deploy']);
  });

  test('cancels data loss on a wrong confirmation without touching the repository', async () => {
    const d = deps({
      describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'slack' }) }), diff: DELETES_SLACK_TABLE, answers: [ACCOUNT_OK, 'yes'],
    });
    const error = await setup({ features: 'none' }, d).catch((err: unknown) => err);
    expect(error).toMatchObject({ message: expect.stringMatching(/Setup cancelled/), exitCode: SETUP_CANCELLED_EXIT_CODE });
    expect(profileOnDisk()).toBeUndefined();
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff']);
  });

  test('refuses to remove a deployed feature the catalog calls unavailable', async () => {
    const d = deps({ describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'agentRegistry' }) }) });
    await expect(runSetup({ region: 'eu-west-3', yes: true }, d)).rejects.toThrow(/may be stale/);
  });

  test('keeps the compute an existing stack was deployed with and records it in the profile', async () => {
    const existing = stack({ DeploymentFeatures: 'none', ComputeTypes: 'agentcore,ecs' });
    await setup({ yes: true }, deps({ describeStack: stacks({ 'backgroundagent-dev': existing }) }));
    expect(profileFile().compute).toEqual(['agentcore', 'ecs']);
    expect(text()).toContain('AgentCore Runtime + ECS Fargate (deployed)');
  });

  test('refuses to remove a deployed compute backend', async () => {
    const existing = stack({ DeploymentFeatures: 'none', ComputeTypes: 'agentcore,ecs' });
    await expect(setup({ yes: true, compute: 'agentcore' }, deps({ describeStack: stacks({ 'backgroundagent-dev': existing }) })))
      .rejects.toThrow(/will not remove ECS Fargate/);
    expect(runs).toEqual([]);
  });

  test('rejects compute selection through --context', () => {
    expect(() => parseContextArgs(['compute_types=ecs'])).toThrow(/managed by setup/);
  });

  test('requires networkTopology=split when a network stack exists', async () => {
    const d = deps({ describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'none' }), 'backgroundagent-dev-network': stack({}) }) });
    await expect(setup({ yes: true }, d)).rejects.toThrow(/--context networkTopology=split/);
    fs.writeFileSync(path.join(root, 'cdk', 'cdk.json'), JSON.stringify({ context: { networkTopology: 'split' } }));
    await setup({ yes: true }, d);
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff', '//cdk:deploy']);
  });
});

describe('stack names the bootstrap can deploy', () => {
  test('rejects a new --stack-name that ABCA\'s least-privilege bootstrap cannot deploy, before any diff', async () => {
    await expect(setup({ features: 'none', yes: true, stackName: 'team-b' }, deps()))
      .rejects.toThrow("Cannot create 'team-b': ABCA's least-privilege bootstrap only deploys stacks named backgroundagent-dev or backgroundagent-dev-<suffix>; try backgroundagent-dev-team-b.");
    expect(runs).toEqual([]);
  });

  test('applies the same rule when setup will install the bootstrap', async () => {
    await expect(setup({ features: 'none', yes: true, stackName: 'team-b' }, deps({ describeStack: stacks({ CDKToolkit: null }) })))
      .rejects.toThrow(/least-privilege bootstrap only deploys/);
  });

  test('accepts any name on a standard CDK bootstrap, which deploys with admin rights', async () => {
    await setup({ features: 'none', yes: true, stackName: 'team-b' }, deps({ describeStack: stacks({ CDKToolkit: stack({}) }) }));
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff', '//cdk:deploy']);
  });

  test('re-asks at the prompt with a name the bootstrap covers', async () => {
    const answers = [ACCOUNT_OK, 'team-c', 'backgroundagent-dev-c', COMPUTE_DEFAULT, 'y'];
    await runSetup({ region: 'us-east-1', features: 'none' }, deps({ answers }));
    expect(text()).toContain('try backgroundagent-dev-team-c.');
    expect(runs[0].args).toEqual(expect.arrayContaining(['-c', 'stackName=backgroundagent-dev-c']));
  });
});

describe('compute of stacks that predate ComputeTypes', () => {
  const preComputeTypes = stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'none', ComputeSubstrate: 'ecs' }) });

  test('fails closed instead of reading an ECS stack as AgentCore-only', async () => {
    await expect(setup({ yes: true, acceptDataLoss: true }, deps({ describeStack: preComputeTypes })))
      .rejects.toThrow("Stack 'backgroundagent-dev' predates the ComputeTypes output and reports ComputeSubstrate=ecs. Pass --compute");
    expect(runs).toEqual([]);
  });

  test('keeps that backend once --compute names it', async () => {
    await setup({ yes: true, compute: 'agentcore,ecs' }, deps({ describeStack: preComputeTypes }));
    expect(profileFile().compute).toEqual(['agentcore', 'ecs']);
  });

  test('still refuses an explicit --compute that drops it', async () => {
    await expect(setup({ yes: true, compute: 'agentcore' }, deps({ describeStack: preComputeTypes }))).rejects.toThrow(/will not remove ECS Fargate/);
  });
});

describe('compute changes on the review screen', () => {
  test('says which backend is being added rather than calling it deployed', async () => {
    const existing = stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'none', ComputeTypes: 'agentcore' }) });
    await setup({ yes: true, compute: 'agentcore,ecs' }, deps({ describeStack: existing }));
    expect(text()).toContain('AgentCore Runtime + ECS Fargate (adding ECS Fargate)');
  });

  test('warns when reordering moves the repository default, and asks interactively', async () => {
    const existing = stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'none', ComputeTypes: 'agentcore,ecs' }) });
    await setup({ yes: true, compute: 'ecs,agentcore' }, deps({ describeStack: existing }));
    expect(text()).toContain('The repository default changes from AgentCore Runtime to ECS Fargate.');
    const error = await setup({ features: 'none', compute: 'ecs,agentcore' }, deps({ describeStack: existing, answers: [ACCOUNT_OK, 'n'] }))
      .catch((err: unknown) => err);
    expect(error).toMatchObject({ exitCode: SETUP_CANCELLED_EXIT_CODE });
  });
});

describe('non-interactive operation', () => {
  test('deploys the requested features with --yes and no prompts', async () => {
    const d = deps({ interactive: false, ask: async () => { throw new Error('must not prompt'); } });
    await setup({ features: 'slack,jira', yes: true }, d);
    expect(profileOnDisk()).toEqual({ ...MINIMAL_DEPLOYMENT_FEATURES, slack: true, jira: true });
    expect(runs[1].args).toEqual(expect.arrayContaining(['--require-approval', 'never']));
  });

  test('--features none --no-deploy only writes the profile', async () => {
    await setup({ features: 'none', deploy: false }, deps({ interactive: false }));
    expect(profileOnDisk()).toEqual(MINIMAL_DEPLOYMENT_FEATURES);
    expect(runs).toEqual([]);
  });

  test('--no-deploy that removes stateful features needs --accept-data-loss', async () => {
    const d = deps({ interactive: false, describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'linear' }) }) });
    await expect(setup({ features: 'none', deploy: false }, d)).rejects.toThrow(/--accept-data-loss/);
    expect(profileOnDisk()).toBeUndefined();
    await setup({ features: 'none', deploy: false, acceptDataLoss: true }, d);
    expect(profileOnDisk()).toEqual(MINIMAL_DEPLOYMENT_FEATURES);
  });

  test('fails clearly on a feature the Region does not support', async () => {
    await expect(runSetup({ region: 'eu-west-3', features: 'agentRegistry', yes: true }, deps({ interactive: false })))
      .rejects.toThrow(/AWS Agent Registry \('agentRegistry'\) is unavailable in eu-west-3/);
    expect(profileOnDisk()).toBeUndefined();
    expect(runs).toEqual([]);
  });

  test('validates a repository profile against the Region before diffing', async () => {
    const withRegistry = { ...MINIMAL_DEPLOYMENT_FEATURES, agentRegistry: true };
    fs.writeFileSync(path.join(root, DEPLOYMENT_PROFILE_FILE), serializeDeploymentProfile({ features: withRegistry }));
    await expect(runSetup({ region: 'eu-west-3', yes: true }, deps({ interactive: false }))).rejects.toThrow(/unavailable in eu-west-3/);
    expect(runs).toEqual([]);
  });

  test('requires --accept-data-loss to delete state-bearing resources', async () => {
    const d = deps({ interactive: false, describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'slack' }) }), diff: DELETES_SLACK_TABLE });
    await expect(setup({ features: 'none', yes: true }, d)).rejects.toThrow(/--accept-data-loss/);
    expect(profileOnDisk()).toBeUndefined();
    await setup({ features: 'none', yes: true, acceptDataLoss: true }, d);
    expect(profileOnDisk()).toEqual(MINIMAL_DEPLOYMENT_FEATURES);
  });

  test('refuses to guess without a terminal or explicit flags', async () => {
    await expect(setup({}, deps({ interactive: false }))).rejects.toThrow(/No terminal detected/);
  });

  test('fails before the diff when deploying without a terminal or --yes', async () => {
    await expect(setup({ features: 'slack' }, deps({ interactive: false }))).rejects.toThrow(/require --yes/);
    expect(runs).toEqual([]);
  });

  test('rejects an unknown feature name', async () => {
    await expect(setup({ features: 'teams', yes: true }, deps())).rejects.toThrow(/Unknown feature 'teams'/);
  });
});

describe('failures and cancellation', () => {
  test('declining the deploy leaves the repository unchanged', async () => {
    await expect(setup({ features: 'slack' }, deps({ answers: [ACCOUNT_OK, COMPUTE_DEFAULT, 'n'] }))).rejects.toThrow(/Setup cancelled/);
    expect(profileOnDisk()).toBeUndefined();
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff']);
  });

  test('closing the terminal at a prompt cancels with a non-zero exit', async () => {
    const error = await setup({}, deps({ answers: [] })).catch((err: unknown) => err);
    expect(error).toMatchObject({ exitCode: SETUP_CANCELLED_EXIT_CODE });
    expect(profileOnDisk()).toBeUndefined();
    expect(runs).toEqual([]);
  });

  test('a failing diff writes and deploys nothing and shows the error line, not the whole output', async () => {
    const diff = 'Bundling asset...\nlots of noise\nError: Deployment profile is not deployable in us-east-1\n';
    await expect(setup({ features: 'slack', yes: true }, deps({ diffCode: 1, diff })))
      .rejects.toThrow(/Nothing was written or deployed/);
    expect(text()).toContain('✗ Checking what will change  could not compute the changes');
    expect(text()).toContain('Error: Deployment profile is not deployable in us-east-1');
    expect(text()).not.toContain('lots of noise');
    expect(profileOnDisk()).toBeUndefined();
  });

  test('a failing deploy names the failed component and reason, and keeps the profile', async () => {
    const deployLines = [
      'Building assets...',
      event(1, 3, 'CREATE_COMPLETE', 'TaskTable/Table', 'TaskTable1'),
      event(2, 3, 'CREATE_FAILED', 'SlackIntegration/EventsFn', 'SlackEvents1', 'Resource handler returned message: "Code storage limit exceeded"'),
      event(3, 3, 'CREATE_FAILED', 'TaskApi/Api', 'Api1', 'Resource creation cancelled'),
    ];
    await setup({ features: 'slack', yes: true }, deps({ deployCode: 1, deployLines }));
    expect(process.exitCode).toBe(1);
    expect(text()).toContain('✗ Deployment failed after');
    expect(text()).toContain('Slack — SlackIntegration/EventsFn');
    expect(text()).toContain('Code storage limit exceeded');
    // A cancellation is a consequence, not a cause.
    expect(text()).not.toContain('Resource creation cancelled');
    // The CLI abbreviates paths under $HOME to `~`; on CI runners os.tmpdir() lives under $HOME.
    const deployLog = path.join(configDir, 'logs', 'backgroundagent-dev', 'setup-deploy.log');
    const home = os.homedir();
    const shownLog = deployLog.startsWith(`${home}${path.sep}`) ? `~${deployLog.slice(home.length)}` : deployLog;
    expect(text()).toContain(`Full log: ${shownLog}`);
    // Logs live outside the repository, where the deploy's cdk.out cleanup cannot remove them.
    expect(runs.every(run => run.logFile.startsWith(configDir))).toBe(true);
    expect(profileOnDisk()?.slack).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(false);
  });

  test('a deploy that fails before CloudFormation shows the error from the output', async () => {
    const deployLines = ['Building agent image', 'docker: Cannot connect to the Docker daemon', 'ERROR: failed to build asset'];
    await setup({ features: 'slack', yes: true }, deps({ deployCode: 1, deployLines }));
    expect(text()).toContain('✗ Preparing deployment');
    expect(text()).toContain('ERROR: failed to build asset');
  });

  test('shows deploy progress per component and finishes every component with a check mark', async () => {
    const diff = ['Stack backgroundagent-dev', '[+] AWS::DynamoDB::Table TaskTable/Table T1', '[+] AWS::Lambda::Function SlackIntegration/EventsFn S1'].join('\n');
    const deployLines = [
      event(1, 2, 'CREATE_IN_PROGRESS', 'TaskTable/Table', 'T1'),
      event(1, 2, 'CREATE_COMPLETE', 'TaskTable/Table', 'T1'),
      event(2, 2, 'CREATE_COMPLETE', 'SlackIntegration/EventsFn', 'S1'),
    ];
    await setup({ features: 'slack', yes: true }, deps({ diff, deployLines }));
    expect(text()).toContain('✓ Checking what will change  2 to create · 0 to update · 0 to remove');
    expect(text()).toContain('✓ Task data & storage');
    expect(text()).toContain('✓ Slack');
    expect(text()).toMatch(/✓ Deploying\s+█+ 100%/);
  });

  test('blocks CDK context that would override the confirmed selection', async () => {
    fs.writeFileSync(path.join(root, 'cdk', 'cdk.context.json'), JSON.stringify({ enableSlack: true }));
    await expect(setup({ features: 'none', yes: true }, deps())).rejects.toThrow(/cdk\/cdk.context.json sets enableSlack=true/);
  });

  test('drops a stale registry URL from the CLI config after removing the Registry', async () => {
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ ...BUNDLE, registry_api_url: 'https://old/' }));
    await setup({ features: 'none', yes: true }, deps());
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'))).toEqual({ ...BUNDLE, stack_name: 'backgroundagent-dev' });
  });

  test('rejects an invalid stack name before any AWS call', async () => {
    const describeStack = jest.fn();
    await expect(setup({ stackName: 'bad name', yes: true }, deps({ describeStack }))).rejects.toThrow(/Invalid stack name/);
    expect(describeStack).not.toHaveBeenCalled();
  });
});

describe('data-loss gate and post-deploy state', () => {
  test('gates on the catalog even when the diff shows no state-bearing change', async () => {
    const d = deps({ interactive: false, describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'slack' }) }) });
    await expect(setup({ features: 'none', yes: true }, d)).rejects.toThrow(/--accept-data-loss/);
    expect(profileOnDisk()).toBeUndefined();
    await setup({ features: 'none', yes: true, acceptDataLoss: true }, d);
    expect(text()).toContain('• Slack: all of its data');
  });

  test('does not write the profile when account preparation fails', async () => {
    const base = deps({ describeStack: stacks({ CDKToolkit: null }) });
    const run: SetupDeps['run'] = async (args, options) => (args[0] === '//cdk:bootstrap'
      ? { code: 1, output: 'AccessDenied: not authorized to perform cloudformation:CreateStack' } : base.run(args, options));
    await expect(setup({ features: 'none', yes: true }, { ...base, run })).rejects.toThrow(/nothing was deployed/);
    expect(profileOnDisk()).toBeUndefined();
  });

  test('explains a CLI-configuration failure after a successful deploy', async () => {
    const configureFromStack = async () => { throw new Error('Stack is missing output ApiUrl'); };
    await expect(setup({ features: 'none', yes: true }, deps({ configureFromStack })))
      .rejects.toThrow('backgroundagent-dev deployed, but the CLI could not be pointed at it (Stack is missing output ApiUrl). '
        + 'Run `bgagent configure --stack-name backgroundagent-dev --region us-east-1`.');
  });

  test('drops cached tokens when the CLI moves to another user pool, and keeps them otherwise', async () => {
    const credentials = path.join(configDir, 'credentials.json');
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(BUNDLE));
    fs.writeFileSync(credentials, '{}');
    await setup({ features: 'none', yes: true }, deps());
    expect(fs.existsSync(credentials)).toBe(true);
    await setup({ features: 'none', yes: true }, deps({ configureFromStack: async () => ({ ...BUNDLE, user_pool_id: 'other-pool' }) }));
    expect(fs.existsSync(credentials)).toBe(false);
  });

  test('creates the log directory owner-only', async () => {
    await setup({ features: 'none', yes: true }, deps());
    expect((fs.statSync(path.join(configDir, 'logs')).mode % 0o1000).toString(8)).toBe('700');
  });

  test('lists only the steps an update still needs', async () => {
    const existing = stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'jira' }) });
    await setup({ features: 'jira,slack', yes: true }, deps({ describeStack: existing }));
    expect(text()).toContain('Connect Slack');
    expect(text()).toContain('bgagent slack setup --region us-east-1');
    expect(text()).not.toContain('Create your user');
    expect(text()).not.toContain('bgagent jira setup');
  });

  test('a new installation adds the setup step of each selected tracker', async () => {
    await setup({ features: 'linear', yes: true }, deps());
    expect(text()).toContain('Create your user');
    expect(text()).toContain('bgagent linear setup <workspace-slug> --region us-east-1');
  });
});

describe('helpers', () => {
  test('parseStateBearingChanges finds exactly the data a real cdk diff removes', () => {
    // Captured from aws-cdk 2.1129 `cdk diff` of the legacy topology without Linear (IAM tables trimmed).
    const diff = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cdk-diff-remove-linear.txt'), 'utf-8');
    expect(parseStateBearingChanges(diff)).toEqual([
      { change: 'delete', type: 'AWS::DynamoDB::Table', id: 'LinearIntegration/ProjectMappingTable/Table' },
      { change: 'delete', type: 'AWS::DynamoDB::Table', id: 'LinearIntegration/UserMappingTable/Table' },
      { change: 'delete', type: 'AWS::DynamoDB::Table', id: 'LinearIntegration/WorkspaceRegistryTable/Table' },
      { change: 'delete', type: 'AWS::DynamoDB::Table', id: 'LinearIntegration/WebhookDedupTable' },
      { change: 'delete', type: 'AWS::SecretsManager::Secret', id: 'LinearIntegration/WebhookSecret' },
    ]);
  });

  test('parseStateBearingChanges reads the impact word on resource lines', () => {
    const diff = [
      'Stack backgroundagent-dev',
      '\u001b[31m[-]\u001b[39m AWS::SecretsManager::Secret JiraIntegration/WebhookSecret JiraSecret destroy',
      '[~] AWS::DynamoDB::Table TaskTable TaskTable123 replace',
      ' └─ [~] KeySchema (requires replacement)',
      '[~] AWS::S3::Bucket ScreenshotBucket Bucket1 may be replaced',
      '[~] AWS::Logs::LogGroup Logs Logs1',
      '[-] AWS::Cognito::UserPool Pool Pool1 orphan',
      '[-] AWS::Lambda::Function Fn Fn1 destroy',
      '[+] AWS::DynamoDB::Table New New1',
      'Stack backgroundagent-dev/AgentRegistryStack',
      '[-] AWS::CloudFormation::Stack AgentRegistryStack.NestedStack/AgentRegistryStack.NestedStackResource Nested1 destroy',
    ].join('\n');
    expect(parseStateBearingChanges(diff)).toEqual([
      { change: 'delete', type: 'AWS::SecretsManager::Secret', id: 'JiraIntegration/WebhookSecret' },
      { change: 'replace', type: 'AWS::DynamoDB::Table', id: 'TaskTable' },
      { change: 'replace', type: 'AWS::S3::Bucket', id: 'ScreenshotBucket' },
      { change: 'orphan', type: 'AWS::Cognito::UserPool', id: 'Pool' },
      { change: 'delete', type: 'AWS::CloudFormation::Stack', id: 'AgentRegistryStack.NestedStack/AgentRegistryStack.NestedStackResource' },
    ]);
  });

  test('conflictingContextOverrides ignores agreeing switches', () => {
    fs.writeFileSync(path.join(root, 'cdk', 'cdk.context.json'), JSON.stringify({ enableSlack: 'false', compute_type: 'ecs' }));
    expect(conflictingContextOverrides(root, MINIMAL_DEPLOYMENT_FEATURES)).toEqual([]);
    expect(conflictingContextOverrides(root, { ...MINIMAL_DEPLOYMENT_FEATURES, slack: true })).toEqual(['cdk/cdk.context.json sets enableSlack=false']);
  });

  test('parseContextArgs accepts key=value and rejects keys setup owns', () => {
    expect([...parseContextArgs(['networkTopology=split', 'alertEmail=a=b@example.com'])])
      .toEqual([['networkTopology', 'split'], ['alertEmail', 'a=b@example.com']]);
    expect(() => parseContextArgs(['nonsense'])).toThrow(/key=value/);
    expect(() => parseContextArgs(['enableSlack=true'])).toThrow(/use --stack-name or --features/);
    expect(() => parseContextArgs(['deploymentProfile=/tmp/x'])).toThrow(/managed by setup/);
  });

  test('makeSetupCommand wires flags into runSetup', async () => {
    const command = makeSetupCommand(() => deps({ interactive: false }));
    await command.parseAsync(['node', 'setup', '--region', 'us-east-1', '--features', 'jira', '--no-deploy'], { from: 'node' });
    expect(profileOnDisk()).toEqual({ ...MINIMAL_DEPLOYMENT_FEATURES, jira: true });
  });

  test('makeSetupCommand maps --yes, --accept-data-loss and repeated --context', async () => {
    const d = deps({ interactive: false, describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'slack' }) }), diff: DELETES_SLACK_TABLE });
    await makeSetupCommand(() => d).parseAsync([
      'node', 'setup', '--region', 'us-east-1', '--features', 'none', '--yes', '--accept-data-loss',
      '-c', 'alertEmail=ops@example.com', '--context', 'bedrockGeoRegion=us',
    ], { from: 'node' });
    expect(runs[1].args).toEqual(expect.arrayContaining(['-c', 'alertEmail=ops@example.com', '-c', 'bedrockGeoRegion=us', '--require-approval', 'never']));
  });
});

describe('brand-new accounts', () => {
  const freshAccount = (extra: FakeOptions = {}) => deps({ describeStack: stacks({ CDKToolkit: null }), ...extra });

  test('asks where agents run, then prepares the account before deploying', async () => {
    const asked: string[] = [];
    const d = freshAccount({ answers: [ACCOUNT_OK, '2', ...ENTER_ALL, 'y'] });
    await setup({}, { ...d, ask: async q => { asked.push(q); return d.ask(q); } });
    expect(asked[1]).toBe('  Choose [1]: ');
    expect(text()).toContain('Where should agents run?');
    expect(text()).toMatch(/Compute\s+ECS Fargate\n/);
    expect(text()).toContain('Install the CDK bootstrap (one-time, least-privilege deploy roles)');
    expect(text()).toContain('Allow the selected compute in the CDK bootstrap');
    expect(profileFile().compute).toEqual(['ecs']);
    // Bootstrap runs after confirmation and before the deploy, pinned to the account and Region.
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff', '//cdk:bootstrap', '//cdk:deploy']);
    expect(runs[1].args).toEqual(['//cdk:bootstrap', '--', 'aws://123456789012/us-east-1']);
    expect(text()).toContain('✓ Preparing your AWS account (CDK bootstrap)');
    expect(text()).toContain('✓ Allowing ECS Fargate in the CDK bootstrap');
  });

  test('keeps AgentCore in the bootstrap compute list for an ECS-only install', async () => {
    const setBootstrapComputeTypes = jest.fn(async () => undefined);
    await setup({ compute: 'ecs', features: 'none', yes: true }, freshAccount({ setBootstrapComputeTypes }));
    expect(setBootstrapComputeTypes).toHaveBeenCalledWith('us-east-1', ['agentcore', 'ecs']);
    expect(runs[1].args).toEqual(['//cdk:bootstrap', '--', 'aws://123456789012/us-east-1']);
  });

  test('declining leaves the account and the repository untouched', async () => {
    await expect(setup({}, freshAccount({ answers: [ACCOUNT_OK, COMPUTE_DEFAULT, ...ENTER_ALL, 'n'] }))).rejects.toThrow(/Setup cancelled/);
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff']);
    expect(profileOnDisk()).toBeUndefined();
  });

  test('stops before deploying when the bootstrap fails', async () => {
    const d = freshAccount();
    const run: SetupDeps['run'] = async (args, options) => (args[0] === '//cdk:bootstrap'
      ? { code: 1, output: 'AccessDenied: not authorized to perform iam:CreateRole' }
      : d.run(args, options));
    await expect(setup({ features: 'none', yes: true }, { ...d, run })).rejects.toThrow(/could not be prepared, so nothing was deployed/);
    expect(text()).toContain('not authorized to perform iam:CreateRole');
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff']);
  });

  test('updates an outdated ABCA bootstrap and adds ECS to an AgentCore-only one', async () => {
    const outdated = stack({ BootstrapPolicyVersion: '1.5.2' }, 'UPDATE_COMPLETE', { ComputeTypes: 'agentcore' });
    const setBootstrapComputeTypes = jest.fn(async () => undefined);
    await setup({ compute: 'agentcore,ecs', features: 'none', yes: true }, deps({ describeStack: stacks({ CDKToolkit: outdated }), setBootstrapComputeTypes }));
    expect(text()).toContain('Update the CDK bootstrap to version 1.8.0');
    expect(setBootstrapComputeTypes).toHaveBeenCalledWith('us-east-1', ['agentcore', 'ecs']);
  });

  test('never modifies a standard CDK bootstrap shared with other apps', async () => {
    const standard = stack({ BucketName: 'cdk-assets' });
    const setBootstrapComputeTypes = jest.fn(async () => undefined);
    await setup({ compute: 'ecs', features: 'none', yes: true }, deps({ describeStack: stacks({ CDKToolkit: standard }), setBootstrapComputeTypes }));
    expect(text()).toContain('uses the standard CDK bootstrap');
    expect(setBootstrapComputeTypes).not.toHaveBeenCalled();
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff', '//cdk:deploy']);
  });

  test('fails early when no container engine is running', async () => {
    await expect(setup({ features: 'none', yes: true }, deps({ containerEngine: async () => undefined })))
      .rejects.toThrow(/No container engine is running.*Finch \(`finch vm start`\)/);
    expect(runs).toEqual([]);
  });

  test('builds with Finch when Docker is unavailable', async () => {
    await setup({ features: 'none', yes: true }, deps({ containerEngine: async () => 'finch' }));
    expect(text()).toContain('✓ Container engine Finch');
    expect(runs.every(run => run.env.CDK_DOCKER === 'finch')).toBe(true);
  });

  test('leaves CDK_DOCKER unset for Docker', async () => {
    const saved = process.env.CDK_DOCKER;
    delete process.env.CDK_DOCKER;
    try {
      await setup({ features: 'none', yes: true }, deps());
      expect(runs.every(run => run.env.CDK_DOCKER === undefined)).toBe(true);
    } finally {
      if (saved !== undefined) process.env.CDK_DOCKER = saved;
    }
  });

  test('ends with a next-steps checklist for the new stack', async () => {
    await setup({ features: 'none', yes: true, stackName: 'backgroundagent-dev-fork' }, deps());
    expect(text()).toContain('bgagent github set-token --region us-east-1 --stack-name backgroundagent-dev-fork');
    expect(text()).toContain('bgagent repo onboard owner/repo --region us-east-1 --stack-name backgroundagent-dev-fork');
  });
});

describe('account and deployment selection', () => {
  const pick = (extra: FakeOptions) => (opts: SetupOptions = {}) => runSetup({ region: 'us-east-1', features: 'none', ...opts }, deps(extra));
  const deployed = [
    { name: 'backgroundagent-dev', status: 'UPDATE_COMPLETE', features: 'slack,linear' },
    { name: 'team-b', status: 'CREATE_COMPLETE', features: 'none' },
  ];
  const existingStacks = stacks({
    'backgroundagent-dev': stack({ DeploymentFeatures: 'slack,linear' }),
    'team-b': stack({ DeploymentFeatures: 'none' }),
  });

  test('asks to confirm the account and stops without touching anything when declined', async () => {
    const error = await pick({ answers: ['n'] })().catch((err: unknown) => err);
    expect(error).toMatchObject({ exitCode: SETUP_CANCELLED_EXIT_CODE });
    expect(text()).toContain('Account  123456789012  Admin (assumed role)');
    expect(text()).toContain('Switch credentials');
    expect(runs).toEqual([]);
  });

  test('explains invalid credentials instead of failing later', async () => {
    const callerIdentity = async () => { throw new Error('ExpiredToken'); };
    await expect(pick({ callerIdentity })({ yes: true })).rejects.toThrow(/could not be verified \(ExpiredToken\)\. Sign in/);
  });

  test('keeps a gap between long deployment names and their status', async () => {
    const longName = 'backgroundagent-dev-pr973ecs';
    const listDeployments = async () => [...deployed, { name: longName, status: 'CREATE_COMPLETE', features: 'slack' }];
    await pick({ answers: [ACCOUNT_OK, '2', 'y'], listDeployments, describeStack: existingStacks })();
    expect(text()).toMatch(/3\) backgroundagent-dev-pr973ecs {2}CREATE_COMPLETE · Slack/);
    expect(text()).toMatch(/1\) backgroundagent-dev {11}UPDATE_COMPLETE/);
  });

  test('lists existing deployments and updates the chosen one', async () => {
    await pick({ answers: [ACCOUNT_OK, '2', 'y'], listDeployments: async () => deployed, describeStack: existingStacks })();
    expect(text()).toContain('Existing deployments in this account');
    expect(text()).toMatch(/1\) backgroundagent-dev\s+UPDATE_COMPLETE · Slack, Linear/);
    expect(text()).toMatch(/2\) team-b\s+CREATE_COMPLETE · core only/);
    expect(text()).toContain('3) Create a new deployment');
    expect(text()).toContain('Stack    team-b (existing');
    expect(runs[1].args).toEqual(expect.arrayContaining(['-c', 'stackName=team-b']));
    // An additional stack gets its own profile file; the shared one is untouched.
    expect(fs.existsSync(path.join(root, 'abca.deployment.team-b.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, DEPLOYMENT_PROFILE_FILE))).toBe(false);
  });

  test('creates a new deployment under a fresh name, re-asking for taken or invalid names', async () => {
    const answers = [ACCOUNT_OK, '3', 'team-b', 'Bad name', 'old-stack', '', COMPUTE_DEFAULT, 'y'];
    const describeStack = stacks({ 'backgroundagent-dev': stack({}), 'team-b': stack({}), 'old-stack': stack({}) });
    await pick({ answers, listDeployments: async () => deployed, describeStack })();
    expect(text()).toContain("'team-b' already exists");
    expect(text()).toContain('Use letters, numbers and hyphens');
    // A stack the picker did not list (e.g. a failed first create) is still detected, with a way out.
    expect(text()).toContain("'old-stack' exists (UPDATE_COMPLETE) but is not a working ABCA deployment; delete it, or rerun with --stack-name old-stack.");
    expect(text()).toContain('Stack    backgroundagent-dev-2 (new installation)');
    expect(text()).toContain('This adds a separate deployment alongside the existing one(s)');
    expect(runs[1].args).toEqual(expect.arrayContaining(['-c', 'stackName=backgroundagent-dev-2']));
    expect(fs.existsSync(path.join(root, 'abca.deployment.backgroundagent-dev-2.json'))).toBe(true);
  });

  test('asks for a name when the account has no deployment yet', async () => {
    const asked: string[] = [];
    const d = deps({ answers: [ACCOUNT_OK, 'backgroundagent-dev-fork', COMPUTE_DEFAULT, 'y'] });
    await runSetup({ region: 'us-east-1', features: 'none' }, { ...d, ask: async q => { asked.push(q); return d.ask(q); } });
    expect(asked[1]).toBe('  Name for the new deployment [backgroundagent-dev]: ');
    expect(runs[0].args).toEqual(expect.arrayContaining(['-c', 'stackName=backgroundagent-dev-fork']));
  });

  test('skips the picker when --stack-name is given', async () => {
    const listDeployments = jest.fn(async () => deployed);
    await pick({ answers: [ACCOUNT_OK, 'y'], listDeployments, describeStack: existingStacks })({ stackName: 'team-b' });
    expect(listDeployments).not.toHaveBeenCalled();
  });
});

test('identityLabel names the role or user behind the credentials', () => {
  expect(identityLabel('arn:aws:sts::123456789012:assumed-role/Admin/session')).toBe('Admin (assumed role)');
  expect(identityLabel('arn:aws:iam::123456789012:user/ops')).toBe('ops (IAM user)');
  expect(identityLabel('arn:aws:iam::123456789012:root')).toBe('account root');
});
