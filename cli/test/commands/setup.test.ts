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
let log: string[];
let runs: { args: readonly string[]; env: NodeJS.ProcessEnv; capture: boolean; profileAtRun?: string }[];

function stack(outputs: Record<string, string>, status = 'UPDATE_COMPLETE'): ExistingStack {
  return { outputs: new Map(Object.entries(outputs)), status, account: '123456789012' };
}

/** Name-aware stack lookup: only the listed stacks exist. */
const stacks = (byName: Record<string, ExistingStack>) => async (_region: string, name: string) => byName[name] ?? null;

type FakeOptions = Partial<SetupDeps> & { answers?: string[]; diff?: string; diffCode?: number; deployCode?: number };

function deps(overrides: FakeOptions = {}): SetupDeps {
  const answers = [...(overrides.answers ?? [])];
  return {
    cwd: root,
    interactive: true,
    describeStack: async () => null,
    hasToolGateway: async () => false,
    resolveAccount: async () => undefined,
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
      return { code: overrides.deployCode ?? 0, output: '' };
    },
    configureFromStack: async () => BUNDLE,
    log: message => { log.push(message); },
    ...overrides,
  };
}

const profileOnDisk = () => {
  const file = path.join(root, DEPLOYMENT_PROFILE_FILE);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')).features : undefined;
};
const setup = (opts: SetupOptions, d: SetupDeps) => runSetup({ region: 'us-east-1', ...opts }, d);
const ENTER_ALL = ['', '', '', '', '', ''];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-setup-test-'));
  fs.mkdirSync(path.join(root, 'cdk'));
  fs.writeFileSync(path.join(root, 'cdk', 'cdk.json'), JSON.stringify({ context: { bedrockGeoRegion: 'global' } }));
  fs.writeFileSync(path.join(root, 'mise.toml'), '');
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-setup-config-'));
  process.env.BGAGENT_CONFIG_DIR = configDir;
  log = [];
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
    await setup({}, deps({ answers: [...ENTER_ALL, 'y'] }));
    expect(log).toContain('Recommended: the governed minimal profile (all optional features off).');
    expect(profileOnDisk()).toEqual(MINIMAL_DEPLOYMENT_FEATURES);
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff', '//cdk:deploy']);
    // Diff ran before the repository profile existed; deploy ran after, on that same file.
    expect(runs[0].profileAtRun).toBeUndefined();
    expect(runs[1].profileAtRun).toBe(serializeDeploymentProfile(MINIMAL_DEPLOYMENT_FEATURES));
    expect(runs[0].args).toEqual(expect.arrayContaining(['-c', 'stackName=backgroundagent-dev']));
    expect(runs[1].args).toEqual([
      '//cdk:deploy', '--', '-c', 'stackName=backgroundagent-dev',
      '-c', `deploymentProfile=${path.join(root, DEPLOYMENT_PROFILE_FILE)}`, '--all',
    ]);
    expect(runs[0].env).toMatchObject({ AWS_REGION: 'us-east-1', CDK_DEFAULT_REGION: 'us-east-1', MISE_EXPERIMENTAL: '1' });
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'))).toEqual(BUNDLE);
  });

  test('asks about each available feature and records the answers', async () => {
    await setup({}, deps({ answers: ['y', 'n', 'y', 'n', 'n', 'n', 'y'] }));
    expect(profileOnDisk()).toEqual({ ...MINIMAL_DEPLOYMENT_FEATURES, slack: true, jira: true });
  });

  test('marks Region-unavailable features and never asks about them', async () => {
    const asked: string[] = [];
    const d = deps({ answers: ['n', 'n', 'n', 'n', 'n', 'y'] });
    await runSetup({ region: 'eu-central-1' }, { ...d, ask: async q => { asked.push(q); return d.ask(q); } });
    expect(log.some(line => line.includes('✗ AWS Agent Registry: unavailable in eu-central-1 (supported: us-east-1'))).toBe(true);
    expect(asked.some(q => q.includes('AWS Agent Registry'))).toBe(false);
    expect(profileOnDisk().agentRegistry).toBe(false);
  });

  test('shows the account the credentials resolve to', async () => {
    await setup({ features: 'none', yes: true }, deps({ resolveAccount: async () => '123456789012' }));
    expect(log).toContain('Account:    123456789012');
  });

  test('prompts for the Region when none is configured', async () => {
    const saved = { AWS_REGION: process.env.AWS_REGION, AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION };
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      await runSetup({}, deps({ answers: ['us-west-2', ...ENTER_ALL, 'y'] }));
      expect(log).toContain('Region:     us-west-2');
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
    const d = deps({ describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'slack,linear' }) }), answers: [...ENTER_ALL, 'y'] });
    await setup({}, d);
    expect(log).toContain('Deployed:   slack, linear');
    expect(log).toContain('Account:    123456789012');
    expect(profileOnDisk()).toEqual({ ...MINIMAL_DEPLOYMENT_FEATURES, slack: true, linear: true });
    expect(log.some(line => line.includes('REMOVE'))).toBe(false);
  });

  test('infers features on stacks that predate profiles, including the Tool Gateway', async () => {
    const legacy = stack({
      SlackAppManifestJson: '{}', LinearWebhookSecretArn: 'a', JiraWebhookSecretArn: 'b', GitHubWebhookUrl: 'c', RegistryApiUrl: 'd',
    });
    await setup({ yes: true }, deps({ describeStack: stacks({ 'backgroundagent-dev': legacy }), hasToolGateway: async () => true }));
    expect(log.some(line => line.includes('(inferred from stack outputs)'))).toBe(true);
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
      answers: ['n', '', '', '', '', '', 'backgroundagent-dev'],
    });
    await setup({}, d);
    expect(log.some(line => line.includes('off  Slack  ← REMOVE'))).toBe(true);
    expect(log).toContain('   DELETE   AWS::DynamoDB::Table  SlackIntegration/InstallationTable');
    expect(profileOnDisk()).toEqual(MINIMAL_DEPLOYMENT_FEATURES);
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff', '//cdk:deploy']);
  });

  test('cancels data loss on a wrong confirmation without touching the repository', async () => {
    const d = deps({ describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'slack' }) }), diff: DELETES_SLACK_TABLE, answers: ['yes'] });
    const error = await setup({ features: 'none' }, d).catch((err: unknown) => err);
    expect(error).toMatchObject({ message: expect.stringMatching(/Setup cancelled/), exitCode: SETUP_CANCELLED_EXIT_CODE });
    expect(profileOnDisk()).toBeUndefined();
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff']);
  });

  test('refuses to remove a deployed feature the catalog calls unavailable', async () => {
    const d = deps({ describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'agentRegistry' }) }) });
    await expect(runSetup({ region: 'eu-central-1', yes: true }, d)).rejects.toThrow(/may be stale/);
  });

  test('requires the compute context the stack was deployed with', async () => {
    const existing = stack({ DeploymentFeatures: 'none', ComputeTypes: 'agentcore,ecs' });
    await expect(setup({ yes: true }, deps({ describeStack: stacks({ 'backgroundagent-dev': existing }) })))
      .rejects.toThrow(/--context compute_types=agentcore,ecs/);
    await setup({ yes: true, context: ['compute_types=agentcore,ecs'] }, deps({ describeStack: stacks({ 'backgroundagent-dev': existing }) }));
    expect(runs[0].args).toEqual(expect.arrayContaining(['-c', 'compute_types=agentcore,ecs']));
    expect(runs[1].args).toEqual(expect.arrayContaining(['-c', 'compute_types=agentcore,ecs']));
  });

  test('requires networkTopology=split when a network stack exists', async () => {
    const d = deps({ describeStack: stacks({ 'backgroundagent-dev': stack({ DeploymentFeatures: 'none' }), 'backgroundagent-dev-network': stack({}) }) });
    await expect(setup({ yes: true }, d)).rejects.toThrow(/--context networkTopology=split/);
    fs.writeFileSync(path.join(root, 'cdk', 'cdk.json'), JSON.stringify({ context: { networkTopology: 'split' } }));
    await setup({ yes: true }, d);
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff', '//cdk:deploy']);
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
    await expect(runSetup({ region: 'eu-central-1', features: 'agentRegistry', yes: true }, deps({ interactive: false })))
      .rejects.toThrow(/AWS Agent Registry \('agentRegistry'\) is unavailable in eu-central-1/);
    expect(profileOnDisk()).toBeUndefined();
    expect(runs).toEqual([]);
  });

  test('validates a repository profile against the Region before diffing', async () => {
    fs.writeFileSync(path.join(root, DEPLOYMENT_PROFILE_FILE), serializeDeploymentProfile({ ...MINIMAL_DEPLOYMENT_FEATURES, agentRegistry: true }));
    await expect(runSetup({ region: 'eu-central-1', yes: true }, deps({ interactive: false }))).rejects.toThrow(/unavailable in eu-central-1/);
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
    await expect(setup({ features: 'slack' }, deps({ answers: ['n'] }))).rejects.toThrow(/Setup cancelled/);
    expect(profileOnDisk()).toBeUndefined();
    expect(runs.map(r => r.args[0])).toEqual(['//cdk:diff']);
  });

  test('closing the terminal at a prompt cancels with a non-zero exit', async () => {
    const error = await setup({}, deps({ answers: [] })).catch((err: unknown) => err);
    expect(error).toMatchObject({ exitCode: SETUP_CANCELLED_EXIT_CODE });
    expect(profileOnDisk()).toBeUndefined();
    expect(runs).toEqual([]);
  });

  test('a failing diff writes and deploys nothing', async () => {
    await expect(setup({ features: 'slack', yes: true }, deps({ diffCode: 1, diff: 'synth error' })))
      .rejects.toThrow(/cdk diff failed \(exit 1\); nothing was written or deployed/);
    expect(profileOnDisk()).toBeUndefined();
  });

  test('a failing deploy keeps the profile and explains how to recover', async () => {
    await expect(setup({ features: 'slack', yes: true }, deps({ deployCode: 2 })))
      .rejects.toThrow(/Deploy failed \(exit 2\)\. abca\.deployment\.json keeps your selection/);
    expect(profileOnDisk()?.slack).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(false);
  });

  test('blocks CDK context that would override the confirmed selection', async () => {
    fs.writeFileSync(path.join(root, 'cdk', 'cdk.context.json'), JSON.stringify({ enableSlack: true }));
    await expect(setup({ features: 'none', yes: true }, deps())).rejects.toThrow(/cdk\/cdk.context.json sets enableSlack=true/);
  });

  test('drops a stale registry URL from the CLI config after removing the Registry', async () => {
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ ...BUNDLE, registry_api_url: 'https://old/' }));
    await setup({ features: 'none', yes: true }, deps());
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'))).toEqual(BUNDLE);
  });

  test('rejects an invalid stack name before any AWS call', async () => {
    const describeStack = jest.fn();
    await expect(setup({ stackName: 'bad name', yes: true }, deps({ describeStack }))).rejects.toThrow(/Invalid stack name/);
    expect(describeStack).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
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
