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

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  paginateDescribeStacks,
  paginateListStackResources,
  UpdateStackCommand,
  waitUntilStackUpdateComplete,
} from '@aws-sdk/client-cloudformation';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { Command } from 'commander';
import { saveConfig, tryLoadConfig } from '../config';
import { CAPABILITY_CATALOG, isAvailableIn } from '../deployment-capabilities';
import {
  ComputeBackend,
  DEPLOYMENT_FEATURES,
  DEPLOYMENT_PROFILE_FILE,
  DeploymentFeature,
  DeploymentFeatures,
  DeploymentProfile,
  detectDeployedFeatures,
  enabledFeatures,
  findRepoRoot,
  MINIMAL_DEPLOYMENT_FEATURES,
  parseComputeList,
  parseFeatureList,
  readDeploymentProfile,
  serializeDeploymentProfile,
  writeDeploymentProfile,
} from '../deployment-profile';
import { CliError } from '../errors';
import { DEFAULT_STACK_NAME } from '../operator-context';
import {
  componentForPath,
  DeployProgress,
  formatDuration,
  Screen,
  Step,
  stripAnsi,
  Style,
  summarizeDiff,
} from '../setup-ui';
import { fetchConfigureBundleFromStack } from '../stack-outputs';
import { CliConfig } from '../types';
import { makeClient } from '../ua';

/** Context switches that override the profile; a stale one in cdk.json would silently contradict the wizard. */
const FEATURE_CONTEXT_KEYS: Readonly<Record<DeploymentFeature, string>> = {
  slack: 'enableSlack',
  linear: 'enableLinear',
  jira: 'enableJira',
  deployPreviewScreenshots: 'enableDeployPreviewScreenshots',
  agentRegistry: 'enableAgentRegistry',
  toolGateway: 'enableToolGateway',
};

/** Context the wizard owns; `--context` must not set it. */
const RESERVED_CONTEXT_KEYS = new Set([
  'stackName', 'deploymentProfile', 'compute_types', 'compute_type', ...Object.values(FEATURE_CONTEXT_KEYS),
]);

/** CDK's bootstrap stack; ABCA's least-privilege variant publishes `BootstrapPolicyVersion`. */
const BOOTSTRAP_STACK = 'CDKToolkit';
/**
 * Minimum ABCA bootstrap bundle this CLI deploys against. Mirrors
 * `BOOTSTRAP_VERSION` in `cdk/src/bootstrap/version.ts` (parity-tested).
 */
export const REQUIRED_BOOTSTRAP_VERSION = '1.6.0';

const COMPUTE_LABELS: Readonly<Record<ComputeBackend, string>> = {
  'agentcore': 'AgentCore Runtime',
  'ecs': 'ECS Fargate',
  'lambda-microvm': 'Lambda MicroVMs',
};

/** One-time account changes a deploy needs, in execution order. */
export type AccountPreparation = 'bootstrap' | 'rebootstrap' | 'computeTypes';

/** Resource types whose deletion, replacement or orphaning loses data, installations or ownership. */
const STATE_BEARING_TYPES: ReadonlyMap<string, string> = new Map([
  ['AWS::DynamoDB::Table', 'table'],
  ['AWS::DynamoDB::GlobalTable', 'table'],
  ['AWS::SecretsManager::Secret', 'secret'],
  ['AWS::S3::Bucket', 'bucket'],
  ['AWS::Cognito::UserPool', 'user pool'],
  ['AWS::KMS::Key', 'encryption key'],
  ['AWS::Logs::LogGroup', 'log group'],
  ['AWS::CloudFormation::Stack', 'nested stack'],
  ['AWS::BedrockAgentCore::Memory', 'agent memory'],
  ['AWS::EC2::VPC', 'VPC'],
]);

const STACK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const CONTEXT_PATTERN = /^([A-Za-z][\w:.-]*)=(.*)$/s;
/** Upper bound for the bootstrap parameter update (IAM policy changes only). */
const BOOTSTRAP_UPDATE_TIMEOUT_S = 900;
/** Exit code for a cancelled setup, like a shell interrupt. */
export const SETUP_CANCELLED_EXIT_CODE = 130;
/** Failures listed on the result screen; the log has the rest. */
const MAX_FAILURES_SHOWN = 3;
/** Width of the header's label column (`Account` plus a gap). */
const FIELD_LABEL_WIDTH = 9;
/** Width of the deployment picker's name column. */
const DEPLOYMENT_NAME_WIDTH = 28;
/** Width of the compute menu's label column. */
const COMPUTE_LABEL_WIDTH = 20;
/** Width of the review screen's label column. */
const REVIEW_LABEL_WIDTH = 30;

export interface ExistingStack {
  readonly outputs: ReadonlyMap<string, string>;
  readonly parameters: ReadonlyMap<string, string>;
  readonly status: string;
  readonly account: string;
}

export interface CallerIdentity {
  readonly account: string;
  readonly arn: string;
}

export interface DeploymentSummary {
  readonly name: string;
  readonly status: string;
  /** `DeploymentFeatures` output; absent on stacks that predate profiles. */
  readonly features?: string;
}

export interface RunResult {
  readonly code: number;
  readonly output: string;
}

/** Injectable side effects so the wizard is testable without AWS, a TTY or a deploy. */
export interface SetupDeps {
  readonly cwd: string;
  readonly interactive: boolean;
  /** Where text and live progress are drawn; `tty` enables in-place redraws and colour. */
  readonly screen: Screen;
  /** `null` when the stack does not exist; other failures throw. */
  readonly describeStack: (region: string, stackName: string) => Promise<ExistingStack | null>;
  readonly hasToolGateway: (region: string, stackName: string) => Promise<boolean>;
  /** The identity the AWS credentials resolve to (STS GetCallerIdentity); throws when they are invalid. */
  readonly callerIdentity: (region: string) => Promise<CallerIdentity>;
  /** ABCA application stacks in the Region (root stacks with the Task API outputs). */
  readonly listDeployments: (region: string) => Promise<DeploymentSummary[]>;
  /** Rejects with a cancellation CliError when input closes (EOF, Ctrl-C). */
  readonly ask: (question: string) => Promise<string>;
  /** Runs `mise <args>` without a terminal: output goes to `logFile` and, line by line, to `onLine`. */
  readonly run: (args: readonly string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; logFile: string; onLine?: (line: string) => void;
  }) => Promise<RunResult>;
  readonly configureFromStack: (region: string, stackName: string) => Promise<CliConfig>;
  /**
   * The container engine CDK should build the agent image with: `CDK_DOCKER`
   * when set, else Docker, else Finch; `undefined` when none is running.
   */
  readonly containerEngine: () => Promise<string | undefined>;
  /** Set the bootstrap stack's `ComputeTypes` parameter, keeping every other value; waits for completion. */
  readonly setBootstrapComputeTypes: (region: string, computeTypes: readonly ComputeBackend[]) => Promise<void>;
  /** Monotonic clock for durations. */
  readonly now: () => number;
}

export interface SetupOptions {
  readonly region?: string;
  readonly stackName?: string;
  readonly features?: string;
  readonly compute?: string;
  readonly context?: readonly string[];
  readonly yes?: boolean;
  readonly deploy?: boolean;
  readonly acceptDataLoss?: boolean;
  readonly repoRoot?: string;
}

export interface StateBearingChange {
  readonly change: 'delete' | 'replace' | 'orphan';
  readonly type: string;
  /** Construct path when CDK prints one, else the logical ID. */
  readonly id: string;
}

export function setupCancelled(): CliError {
  return new CliError('Setup cancelled; nothing was written or deployed.', SETUP_CANCELLED_EXIT_CODE);
}

/**
 * State-bearing deletions, replacements and orphanings in `cdk diff` output.
 * CDK ends each resource line with its impact (`destroy`, `orphan`, `replace`,
 * `may be replaced`); `(requires replacement)` appears only on property lines.
 */
export function parseStateBearingChanges(diffOutput: string): StateBearingChange[] {
  const changes: StateBearingChange[] = [];
  for (const raw of stripAnsi(diffOutput).split('\n')) {
    const match = /^\s*\[([-~])\]\s+(\S+)\s+(\S+)(.*)$/.exec(raw);
    if (!match || !STATE_BEARING_TYPES.has(match[2])) continue;
    const [, marker, type, id, impact] = match;
    if (marker === '-') changes.push({ change: /\borphan\b/.test(impact) ? 'orphan' : 'delete', type, id });
    else if (/\b(replace|may be replaced)\s*$/.test(impact)) changes.push({ change: 'replace', type, id });
  }
  return changes;
}

function repoCdkDir(repoRoot: string): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- repoRoot is the operator's own checkout (cwd or --repo-root), validated by findRepoRoot; the joined segment is a literal
  return path.join(repoRoot, 'cdk');
}

/** Persistent CDK context sources, in the order CDK reads them. */
function persistentContext(repoRoot: string): Array<{ source: string; context: Record<string, unknown> }> {
  const cdkDir = repoCdkDir(repoRoot);
  const sources = [
    { source: '~/.cdk.json', file: `${os.homedir()}${path.sep}.cdk.json`, nested: true },
    { source: 'cdk/cdk.json', file: `${cdkDir}${path.sep}cdk.json`, nested: true },
    { source: 'cdk/cdk.context.json', file: `${cdkDir}${path.sep}cdk.context.json`, nested: false },
  ];
  const result: Array<{ source: string; context: Record<string, unknown> }> = [];
  for (const { source, file, nested } of sources) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      result.push({ source, context: (nested ? parsed.context as Record<string, unknown> | undefined : parsed) ?? {} });
    } catch (err) {
      throw new CliError(`Cannot parse ${file}: ${(err as Error).message}`);
    }
  }
  return result;
}

/** Reject feature switches in persistent CDK context that would override the confirmed selection. */
export function conflictingContextOverrides(
  repoRoot: string,
  selection: DeploymentFeatures,
  compute?: readonly ComputeBackend[],
): string[] {
  const conflicts: string[] = [];
  for (const { source, context } of persistentContext(repoRoot)) {
    // Context beats the profile at synth, so a stale compute selection would win silently.
    const configured = context.compute_types ?? context.compute_type;
    if (compute && configured !== undefined
      && (Array.isArray(configured) ? configured.join(',') : String(configured)) !== compute.join(',')) {
      conflicts.push(`${source} sets compute_types=${String(configured)}`);
    }
    if (context.deploymentProfile !== undefined) {
      conflicts.push(`${source} sets deploymentProfile=${String(context.deploymentProfile)}`);
    }
    for (const feature of DEPLOYMENT_FEATURES) {
      const value = context[FEATURE_CONTEXT_KEYS[feature]];
      if (value !== undefined && String(value) !== String(selection[feature])) {
        conflicts.push(`${source} sets ${FEATURE_CONTEXT_KEYS[feature]}=${String(value)}`);
      }
    }
  }
  return conflicts;
}

/** Validate `--context key=value` pass-through (topology, compute, etc.). */
export function parseContextArgs(values: readonly string[]): Map<string, string> {
  const context = new Map<string, string>();
  for (const value of values) {
    const match = CONTEXT_PATTERN.exec(value);
    if (!match) throw new CliError(`--context must be key=value, got '${value}'.`);
    if (RESERVED_CONTEXT_KEYS.has(match[1])) {
      throw new CliError(`--context ${match[1]} is managed by setup; use --stack-name or --features instead.`);
    }
    context.set(match[1], match[2]);
  }
  return context;
}

/**
 * Operator context the stack was deployed with but this run would drop. A
 * dropped `networkTopology` would rebuild the VPC, which is not a feature
 * change and must not ride along with one. (Compute is read from the stack.)
 */
async function missingDeploymentContext(
  deps: SetupDeps,
  region: string,
  stackName: string,
  context: ReadonlyMap<string, string>,
  repoRoot: string,
): Promise<string[]> {
  const persistent = new Map(persistentContext(repoRoot).flatMap(({ context: values }) => Object.entries(values)));
  const has = (key: string) => context.has(key) || persistent.has(key);
  const missing: string[] = [];
  if (!has('networkTopology') && (await deps.describeStack(region, `${stackName}-network`))) {
    missing.push('--context networkTopology=split');
  }
  return missing;
}

async function confirm(deps: SetupDeps, question: string, defaultYes: boolean): Promise<boolean> {
  const answer = (await deps.ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

function unavailableIn(region: string, selection: DeploymentFeatures): string[] {
  return enabledFeatures(selection)
    .filter(feature => !isAvailableIn(CAPABILITY_CATALOG.features[feature], region))
    .map(feature => {
      const capability = CAPABILITY_CATALOG.features[feature];
      return `${capability.label} ('${feature}') is unavailable in ${region} (supported: ${capability.regions?.join(', ')}). ${capability.remediation}`;
    });
}

/** Writes text lines and styles them consistently. */
class Ui {
  readonly style: Style;
  constructor(private readonly deps: SetupDeps) {
    this.style = new Style(deps.screen.tty && !process.env.NO_COLOR);
  }
  line(text = ''): void {
    this.deps.screen.write(`${text}\n`);
  }
  title(text: string): void {
    this.line();
    this.line(`  ${this.style.bold(text)}`);
    this.line(`  ${this.style.dim('─'.repeat(text.length))}`);
  }
  field(label: string, value: string): void {
    this.line(`  ${this.style.dim(label.padEnd(FIELD_LABEL_WIDTH))}${value}`);
  }
}

function versionAtLeast(actual: string, required: string): boolean {
  const parse = (value: string) => value.split('.').map(part => Number.parseInt(part, 10) || 0);
  const [a, r] = [parse(actual), parse(required)];
  for (let index = 0; index < Math.max(a.length, r.length); index += 1) {
    if ((a[index] ?? 0) !== (r[index] ?? 0)) return (a[index] ?? 0) > (r[index] ?? 0);
  }
  return true;
}

/**
 * What the account needs before ABCA can deploy. A standard CDK bootstrap (no
 * ABCA policy outputs) is shared with other apps and is never modified.
 */
export function planAccountPreparation(
  bootstrap: ExistingStack | null,
  compute: readonly ComputeBackend[],
): { steps: AccountPreparation[]; computeTypes: ComputeBackend[]; standardBootstrap: boolean } {
  if (!bootstrap) {
    // AgentCore stays in the list: Memory and the Gateway are AgentCore resources on every backend.
    const computeTypes = [...new Set<ComputeBackend>(['agentcore', ...compute])];
    return { steps: computeTypes.length > 1 ? ['bootstrap', 'computeTypes'] : ['bootstrap'], computeTypes, standardBootstrap: false };
  }
  const policyVersion = bootstrap.outputs.get('BootstrapPolicyVersion');
  if (policyVersion === undefined) return { steps: [], computeTypes: [], standardBootstrap: true };
  const steps: AccountPreparation[] = versionAtLeast(policyVersion, REQUIRED_BOOTSTRAP_VERSION) ? [] : ['rebootstrap'];
  const configured = (bootstrap.parameters.get('ComputeTypes') ?? 'agentcore').split(',').map(value => value.trim()).filter(Boolean);
  const computeTypes = [...new Set([...configured, ...compute])] as ComputeBackend[];
  if (computeTypes.length !== configured.length) steps.push('computeTypes');
  return { steps, computeTypes, standardBootstrap: false };
}

async function chooseCompute(deps: SetupDeps, ui: Ui, defaults: readonly ComputeBackend[]): Promise<ComputeBackend[]> {
  const options: Array<{ label: string; detail: string; compute: ComputeBackend[] }> = [
    { label: 'AgentCore Runtime', detail: 'recommended — managed, starts in seconds', compute: ['agentcore'] },
    { label: 'ECS Fargate', detail: 'containers — larger builds, slower start', compute: ['ecs'] },
    { label: 'Both', detail: 'AgentCore by default; repositories can opt into ECS', compute: ['agentcore', 'ecs'] },
  ];
  const preselected = Math.max(0, options.findIndex(option => option.compute.join(',') === defaults.join(',')));
  ui.title('Where should agents run?');
  options.forEach((option, index) => {
    ui.line(`  ${index + 1}) ${option.label.padEnd(COMPUTE_LABEL_WIDTH)}${ui.style.dim(option.detail)}`);
  });
  for (;;) {
    const answer = (await deps.ask(`  Choose [${preselected + 1}]: `)).trim();
    if (!answer) return options[preselected].compute;
    const choice = Number.parseInt(answer, 10);
    if (choice >= 1 && choice <= options.length) return options[choice - 1].compute;
    ui.line(`  ${ui.style.yellow(`Enter a number from 1 to ${options.length}.`)}`);
  }
}

/** `arn:aws:sts::123:assumed-role/Admin/me` → `Admin (assumed role)`. */
export function identityLabel(arn: string): string {
  const assumed = /:assumed-role\/([^/]+)\//.exec(arn);
  if (assumed) return `${assumed[1]} (assumed role)`;
  const user = /:user\/(.+)$/.exec(arn);
  if (user) return `${user[1]} (IAM user)`;
  return arn.endsWith(':root') ? 'account root' : arn;
}

function suggestStackName(taken: ReadonlySet<string>): string {
  if (!taken.has(DEFAULT_STACK_NAME)) return DEFAULT_STACK_NAME;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${DEFAULT_STACK_NAME}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function askNewStackName(deps: SetupDeps, ui: Ui, region: string, taken: ReadonlySet<string>): Promise<string> {
  const suggestion = suggestStackName(taken);
  for (;;) {
    const answer = (await deps.ask(`  Name for the new deployment [${suggestion}]: `)).trim() || suggestion;
    if (!STACK_NAME_PATTERN.test(answer)) {
      ui.line(`  ${ui.style.yellow('Use letters, numbers and hyphens, starting with a letter.')}`);
    } else if (taken.has(answer) || (await deps.describeStack(region, answer))) {
      ui.line(`  ${ui.style.yellow(`'${answer}' already exists; pick it from the list to update it, or choose another name.`)}`);
    } else {
      return answer;
    }
  }
}

/** Update an existing deployment, or name a new one in the same account. */
async function chooseDeployment(
  deps: SetupDeps,
  ui: Ui,
  region: string,
  deployments: readonly DeploymentSummary[],
): Promise<{ stackName: string; additional: boolean }> {
  const taken = new Set(deployments.map(deployment => deployment.name));
  if (deployments.length === 0) {
    return { stackName: await askNewStackName(deps, ui, region, taken), additional: false };
  }
  ui.title('Existing deployments in this account');
  deployments.forEach((deployment, index) => {
    const features = deployment.features === undefined ? 'features not recorded'
      : deployment.features === 'none' ? 'core only'
        : deployment.features.split(',').map(f => CAPABILITY_CATALOG.features[f as DeploymentFeature]?.label ?? f).join(', ');
    ui.line(`  ${index + 1}) ${deployment.name.padEnd(DEPLOYMENT_NAME_WIDTH)}${ui.style.dim(`${deployment.status} · ${features}`)}`);
  });
  const createIndex = deployments.length + 1;
  ui.line(`  ${createIndex}) ${ui.style.bold('Create a new deployment')}`);
  for (;;) {
    const answer = (await deps.ask('  Update an existing deployment or create a new one? [1]: ')).trim() || '1';
    const choice = Number.parseInt(answer, 10);
    if (choice >= 1 && choice <= deployments.length) return { stackName: deployments[choice - 1].name, additional: false };
    if (choice === createIndex) return { stackName: await askNewStackName(deps, ui, region, taken), additional: true };
    ui.line(`  ${ui.style.yellow(`Enter a number from 1 to ${createIndex}.`)}`);
  }
}

function computeLabel(compute: readonly ComputeBackend[]): string {
  return compute.map(backend => COMPUTE_LABELS[backend]).join(' + ');
}

async function chooseInteractively(
  deps: SetupDeps,
  ui: Ui,
  region: string,
  defaults: DeploymentFeatures,
): Promise<DeploymentFeatures> {
  const result: Record<DeploymentFeature, boolean> = { ...MINIMAL_DEPLOYMENT_FEATURES };
  ui.title('Choose optional features');
  ui.line(`  ${ui.style.dim('The core platform (Task API, agent runtime, Cedar approvals, GitHub PRs) is always deployed.')}`);
  for (const feature of DEPLOYMENT_FEATURES) {
    const capability = CAPABILITY_CATALOG.features[feature];
    ui.line();
    if (!isAvailableIn(capability, region)) {
      ui.line(`  ${ui.style.dim(`✗ ${capability.label} — not available in ${region}`)}`);
      continue;
    }
    const tag = capability.maturity === 'experimental' ? ` ${ui.style.yellow('(experimental)')}` : '';
    ui.line(`  ${ui.style.bold(capability.label)}${tag}`);
    // Design-record references mean nothing to an operator choosing features.
    ui.line(`  ${ui.style.dim(capability.description.replace(/\s*\(ADR-[^)]*\)/g, ''))}`);
    result[feature] = await confirm(deps, `  Enable ${capability.label}?`, defaults[feature]);
  }
  return result;
}

const PREPARATION_LABELS: Readonly<Record<AccountPreparation, string>> = {
  bootstrap: 'Install the CDK bootstrap (one-time, least-privilege deploy roles)',
  rebootstrap: `Update the CDK bootstrap to version ${REQUIRED_BOOTSTRAP_VERSION}`,
  computeTypes: 'Allow the selected compute in the CDK bootstrap',
};

function printReview(
  ui: Ui,
  selection: DeploymentFeatures,
  removed: readonly DeploymentFeature[],
  compute: { readonly backends: readonly ComputeBackend[]; readonly deployed: boolean },
  preparation: readonly AccountPreparation[],
): void {
  const { style } = ui;
  ui.title('Review');
  ui.line(`  ${style.dim('Compute'.padEnd(REVIEW_LABEL_WIDTH + 2))}${computeLabel(compute.backends)}${compute.deployed ? style.dim(' (deployed)') : ''}`);
  ui.line();
  ui.line(`  ${style.green('✓')} ${'Core platform'.padEnd(REVIEW_LABEL_WIDTH)}${style.dim('always included')}`);
  ui.line(`    ${style.dim('Task API & sign-in · agent runtime & network controls · Cedar approvals')}`);
  ui.line(`    ${style.dim('task history & budgets · GitHub task/PR workflow · monitoring')}`);
  for (const feature of DEPLOYMENT_FEATURES) {
    const { label } = CAPABILITY_CATALOG.features[feature];
    if (removed.includes(feature)) {
      ui.line(`  ${style.red('✗')} ${label.padEnd(REVIEW_LABEL_WIDTH)}${style.red('will be removed')}`);
    } else if (selection[feature]) {
      ui.line(`  ${style.green('✓')} ${label}`);
    } else {
      ui.line(`  ${style.dim(`✗ ${label.padEnd(REVIEW_LABEL_WIDTH)}not included`)}`);
    }
  }
  if (preparation.length > 0) {
    ui.line();
    ui.line(`  ${style.bold('Account preparation')}`);
    for (const step of preparation) ui.line(`  ${style.cyan('•')} ${PREPARATION_LABELS[step]}`);
  }
}

function printNextSteps(ui: Ui, region: string, stackName: string): void {
  const { style } = ui;
  const flags = `--region ${region}${stackName === DEFAULT_STACK_NAME ? '' : ` --stack-name ${stackName}`}`;
  const steps: Array<readonly [string, string]> = [
    ['Store a GitHub token for the agent', `bgagent github set-token ${flags}`],
    ['Create your user', `bgagent admin invite-user you@example.com ${flags}`],
    ['Sign in', 'bgagent login --username you@example.com'],
    ['Onboard a repository', `bgagent repo onboard owner/repo ${flags}`],
  ];
  ui.title('Next steps');
  steps.forEach(([label, command], index) => {
    ui.line(`  ${index + 1}. ${label}`);
    ui.line(`     ${style.cyan(command)}`);
  });
}

/** "Slack: 3 tables and 1 secret" from state-bearing changes, grouped by component. */
function describeDataLoss(changes: readonly StateBearingChange[], stackNames: readonly string[]): string[] {
  const byComponent = new Map<string, Map<string, number>>();
  for (const change of changes) {
    const component = componentForPath(change.id, stackNames);
    const nouns = byComponent.get(component) ?? new Map<string, number>();
    const noun = STATE_BEARING_TYPES.get(change.type)!;
    nouns.set(noun, (nouns.get(noun) ?? 0) + 1);
    byComponent.set(component, nouns);
  }
  return [...byComponent].map(([component, nouns]) => `${component}: ${[...nouns]
    .map(([noun, count]) => `${count} ${noun}${count === 1 ? '' : 's'}`).join(', ')}`);
}

/** The most useful lines of raw output when CloudFormation reported no reason. */
function errorLines(output: string | readonly string[]): string[] {
  const lines = (typeof output === 'string' ? stripAnsi(output).split('\n') : [...output]).map(line => line.trim()).filter(Boolean);
  const errors = lines.filter(line => /error|failed|❌|denied|not authorized|exception/i.test(line));
  return (errors.length > 0 ? errors : lines).slice(-MAX_FAILURES_SHOWN);
}

/** Stronger gate for data loss: type the stack name, or `--yes --accept-data-loss`. */
async function confirmDataLoss(deps: SetupDeps, opts: SetupOptions, stackName: string, interactive: boolean): Promise<boolean> {
  if (opts.yes || !interactive) {
    if (!opts.acceptDataLoss) {
      throw new CliError('Refusing to remove state-bearing resources non-interactively. Add --accept-data-loss to proceed.');
    }
    return true;
  }
  return (await deps.ask(`  Type the stack name (${stackName}) to confirm: `)).trim() === stackName;
}

/** Interactive or scripted `bgagent setup` (ADR-024). */
export async function runSetup(opts: SetupOptions, deps: SetupDeps): Promise<void> {
  const ui = new Ui(deps);
  const { style } = ui;
  const repoRoot = findRepoRoot(opts.repoRoot ?? deps.cwd);
  if (opts.stackName !== undefined && !STACK_NAME_PATTERN.test(opts.stackName)) {
    throw new CliError(`Invalid stack name '${opts.stackName}'.`);
  }
  const prompting = deps.interactive && !opts.yes;
  const deploying = opts.deploy !== false;
  if (!deps.interactive && opts.features === undefined && !opts.yes) {
    throw new CliError('No terminal detected. Pass --features <list|none> (and --yes to deploy) for non-interactive setup.');
  }
  // Fail before a long diff rather than block on a prompt nobody can answer.
  if (!deps.interactive && deploying && !opts.yes) {
    throw new CliError('Non-interactive deploys require --yes (or pass --no-deploy to only write the profile).');
  }
  const extraContext = parseContextArgs(opts.context ?? []);

  // 1. Region first: availability decides what may be offered.
  let region = opts.region ?? tryLoadConfig()?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region && deps.interactive && !opts.yes && opts.features === undefined) {
    region = (await deps.ask('  AWS Region to deploy ABCA into: ')).trim();
  }
  if (!region) throw new CliError('AWS region is required. Pass --region or set AWS_REGION.');
  if (!REGION_PATTERN.test(region)) throw new CliError(`Invalid AWS Region '${region}'.`);
  const { core } = CAPABILITY_CATALOG;
  if (!isAvailableIn(core, region)) {
    throw new CliError(
      `ABCA cannot be deployed to ${region}: ${core.requiredServices.join(' and ')} are required `
      + `(supported: ${core.regions?.join(', ')}). ${core.remediation}`,
    );
  }

  // 2. Confirm the account before anything reads or writes it.
  let identity: CallerIdentity;
  try {
    identity = await deps.callerIdentity(region);
  } catch (err) {
    throw new CliError(
      `Your AWS credentials could not be verified (${err instanceof Error ? err.message : String(err)}). `
      + 'Sign in (for example `aws sso login` or set AWS_PROFILE) and run bgagent setup again.',
    );
  }
  const account = identity.account;
  ui.title('ABCA setup');
  ui.field('Account', `${account}  ${style.dim(identityLabel(identity.arn))}`);
  ui.field('Region', region);
  if (prompting && !(await confirm(deps, `  Deploy into AWS account ${account}?`, true))) {
    ui.line(`  ${style.dim('Switch credentials (for example AWS_PROFILE=<profile>) and run bgagent setup again.')}`);
    throw setupCancelled();
  }

  // 3. Which deployment: an explicit --stack-name, the picker, or the default.
  let stackName = opts.stackName ?? DEFAULT_STACK_NAME;
  let additional = false;
  if (opts.stackName === undefined && prompting) {
    const deployments = await deps.listDeployments(region);
    ({ stackName, additional } = await chooseDeployment(deps, ui, region, deployments));
  }

  // 4. Existing deployment: preselect what is there so a rerun never proposes deletion.
  const existing = await deps.describeStack(region, stackName);
  if (existing && existing.status.endsWith('_IN_PROGRESS')) {
    throw new CliError(`Stack '${stackName}' is ${existing.status}; wait for it to finish before running setup.`);
  }
  const deployed = existing ? detectDeployedFeatures(existing.outputs, () => false) : undefined;
  const deployedFeatures = deployed?.source === 'inferred'
    ? { ...deployed.features, toolGateway: await deps.hasToolGateway(region, stackName) }
    : deployed?.features;
  const profile = readDeploymentProfile(repoRoot, stackName);
  const defaults = deployedFeatures ?? profile?.features ?? MINIMAL_DEPLOYMENT_FEATURES;
  // Every stack since #912 publishes its backends; older ones only ever had AgentCore by default.
  const deployedCompute = existing ? parseComputeList(existing.outputs.get('ComputeTypes') ?? 'agentcore') : undefined;

  ui.line();
  ui.field('Stack', `${stackName} ${style.dim(existing ? `(existing · ${existing.status})` : '(new installation)')}`);
  if (additional) {
    ui.line(`  ${style.dim('This adds a separate deployment alongside the existing one(s); they share only the CDK bootstrap.')}`);
    ui.line(`  ${style.dim('Bedrock model-invocation logging is account-wide: the most recent deployment configures it.')}`);
  }
  if (extraContext.size > 0) ui.field('Context', [...extraContext].map(([key, value]) => `${key}=${value}`).join(' '));
  if (deployedFeatures) {
    const names = enabledFeatures(deployedFeatures).map(f => CAPABILITY_CATALOG.features[f].label);
    ui.field('Deployed', `${names.join(', ') || 'core only'}${deployed?.source === 'inferred' ? style.dim(' (detected)') : ''}`);
  } else if (!profile) {
    ui.line(`  ${style.dim('New installation: every optional feature defaults to off (the governed minimal profile).')}`);
  }

  for (const feature of enabledFeatures(deployedFeatures ?? MINIMAL_DEPLOYMENT_FEATURES)) {
    if (!isAvailableIn(CAPABILITY_CATALOG.features[feature], region)) {
      throw new CliError(
        `Stack '${stackName}' already deploys ${CAPABILITY_CATALOG.features[feature].label}, which the capability catalog `
        + `lists as unavailable in ${region}. The catalog (verified ${CAPABILITY_CATALOG.lastVerified}) may be stale; `
        + 'update contracts/deployment-capabilities.json rather than letting setup remove it.',
      );
    }
  }
  if (existing) {
    const missing = await missingDeploymentContext(deps, region, stackName, extraContext, repoRoot);
    if (missing.length > 0) {
      throw new CliError(
        `Stack '${stackName}' was deployed with context this run would drop. Rerun with ${missing.join(' ')} `
        + '(or set it in cdk/cdk.json) so only feature changes are applied.',
      );
    }
  }

  // 3. Compute: chosen once, at installation. An existing stack keeps its backends;
  // adding one is allowed, removing one is a migration (docs/design/COMPUTE.md).
  let compute: ComputeBackend[];
  if (opts.compute !== undefined) {
    compute = parseComputeList(opts.compute);
    const dropped = (deployedCompute ?? []).filter(backend => !compute.includes(backend));
    if (dropped.length > 0) {
      throw new CliError(
        `Stack '${stackName}' runs on ${computeLabel(deployedCompute!)}; setup will not remove ${computeLabel(dropped)}. `
        + 'Follow the backend transition procedure in docs/design/COMPUTE.md instead.',
      );
    }
  } else if (deployedCompute) {
    compute = deployedCompute;
  } else if (prompting) {
    compute = await chooseCompute(deps, ui, profile?.compute ?? ['agentcore']);
  } else {
    compute = [...(profile?.compute ?? ['agentcore'])];
  }

  // 4. Features, validated against the Region whatever their source.
  let selection: DeploymentFeatures;
  if (opts.features !== undefined) {
    selection = parseFeatureList(opts.features);
  } else if (deps.interactive && !opts.yes) {
    selection = await chooseInteractively(deps, ui, region, defaults);
  } else {
    selection = defaults;
  }
  const unavailable = unavailableIn(region, selection);
  if (unavailable.length > 0) throw new CliError(unavailable.join('\n'));

  const removed = enabledFeatures(deployedFeatures ?? MINIMAL_DEPLOYMENT_FEATURES).filter(f => !selection[f]);
  const chosen: DeploymentProfile = { features: selection, compute };
  const bootstrap = deploying ? await deps.describeStack(region, BOOTSTRAP_STACK) : null;
  const preparation = deploying ? planAccountPreparation(bootstrap, compute) : { steps: [], computeTypes: [], standardBootstrap: false };
  printReview(ui, selection, removed, { backends: compute, deployed: deployedCompute !== undefined }, preparation.steps);
  if (preparation.standardBootstrap) {
    ui.line();
    ui.line(`  ${style.dim('This account uses the standard CDK bootstrap; setup deploys with it and leaves it unchanged.')}`);
  }

  const conflicts = conflictingContextOverrides(repoRoot, selection, compute);
  if (conflicts.length > 0) {
    throw new CliError(`CDK context overrides the selected profile:\n- ${conflicts.join('\n- ')}\nRemove them, then rerun setup.`);
  }

  if (!deploying) {
    // The next deploy (local or CI) applies the removal without this wizard's diff.
    const stateful = removed.filter(feature => CAPABILITY_CATALOG.features[feature].stateful);
    if (stateful.length > 0) {
      ui.line();
      ui.line(`  ${style.yellow('⚠')} The next deploy deletes the data of: ${stateful.map(f => CAPABILITY_CATALOG.features[f].label).join(', ')}.`);
      if (!(await confirmDataLoss(deps, opts, stackName, deps.interactive))) throw setupCancelled();
    }
    const file = writeDeploymentProfile(repoRoot, chosen, stackName);
    ui.line();
    ui.line(`  ${style.green('✓')} Saved ${path.relative(deps.cwd, file) || file}`);
    ui.line(`  ${style.dim('Commit it so local and CI deploys use the same features. Deploy later with `bgagent setup`.')}`);
    return;
  }

  // 5. Work out the changes against a temporary profile so cancelling leaves the repository unchanged.
  const engine = await deps.containerEngine();
  if (!engine) {
    throw new CliError(
      'No container engine is running. The deploy builds the agent image locally: start Docker, '
      + 'or Finch (`finch vm start`), and run bgagent setup again.',
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MISE_EXPERIMENTAL: '1',
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    CDK_DEFAULT_REGION: region,
    FORCE_COLOR: '0',
    // CDK shells out to `docker` unless told otherwise; Finch is a drop-in CLI.
    ...(engine !== 'docker' ? { CDK_DOCKER: engine } : {}),
  };
  const contextArgs = ['-c', `stackName=${stackName}`, ...[...extraContext].flatMap(([key, value]) => ['-c', `${key}=${value}`])];
  const persistentTopology = persistentContext(repoRoot).map(({ context }) => context.networkTopology).filter(Boolean).pop();
  const topology = extraContext.get('networkTopology') ?? persistentTopology;
  const stackNames = topology === 'split' ? [stackName, `${stackName}-network`] : [stackName];
  // Raw CDK output lives in the git-ignored cdk.out, next to the assembly it describes.
  const logDir = `${repoCdkDir(repoRoot)}${path.sep}cdk.out`;
  fs.mkdirSync(logDir, { recursive: true });
  const diffLog = `${logDir}${path.sep}setup-changes.log`;
  const deployLog = `${logDir}${path.sep}setup-deploy.log`;
  ui.line();
  ui.line(`  ${style.green('✓')} Container engine ${style.dim(engine === 'docker' ? 'Docker' : engine === 'finch' ? 'Finch' : engine)}`);
  const checking = new Step(deps.screen, style, 'Checking what will change');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-setup-'));
  let diff: RunResult;
  try {
    const candidate = path.join(tempDir, DEPLOYMENT_PROFILE_FILE);
    fs.writeFileSync(candidate, serializeDeploymentProfile(chosen), 'utf-8');
    diff = await deps.run(['//cdk:diff', '--', ...contextArgs, '-c', `deploymentProfile=${candidate}`], { cwd: repoRoot, env, logFile: diffLog });
  } catch (err) {
    checking.fail();
    throw err;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (diff.code !== 0) {
    checking.fail('could not compute the changes');
    for (const line of errorLines(diff.output)) ui.line(`    ${style.red(line)}`);
    ui.line(`    ${style.dim(`Full output: ${path.relative(deps.cwd, diffLog)}`)}`);
    throw new CliError('Nothing was written or deployed. Fix the error above and rerun setup.');
  }
  const summary = summarizeDiff(diff.output, stackNames);
  const counts = [`${summary.create} to create`, `${summary.update} to update`, `${summary.remove} to remove`].join(' · ');
  checking.succeed(summary.create + summary.update + summary.remove === 0 ? 'no changes' : counts);
  if (summary.iamResources > 0) {
    ui.line(`    ${style.dim(`Includes ${summary.iamResources} IAM ${summary.iamResources === 1 ? 'role or policy' : 'roles and policies'}.`)}`);
  }
  ui.line(`    ${style.dim(`Full change list: ${path.relative(deps.cwd, diffLog)}`)}`);

  // 6. Confirmation, with a stronger gate for data loss.
  const stateBearing = parseStateBearingChanges(diff.output);
  ui.line();
  if (stateBearing.length > 0) {
    ui.line(`  ${style.yellow('⚠  This removes or replaces resources that hold data:')}`);
    for (const line of describeDataLoss(stateBearing, stackNames)) ui.line(`     • ${line}`);
    ui.line(`  ${style.dim('   Their contents (installations, mappings, secrets, records) are lost. OAuth secrets created by')}`);
    ui.line(`  ${style.dim('   the CLI are kept; re-enabling a feature later starts empty.')}`);
    if (!(await confirmDataLoss(deps, opts, stackName, deps.interactive))) throw setupCancelled();
  } else if (!opts.yes && !(await confirm(deps, `  Deploy ${stackName} now?`, false))) {
    throw setupCancelled();
  }

  // 7. Persist, prepare the account, deploy the same profile through mise/CDK, configure the CLI.
  const file = writeDeploymentProfile(repoRoot, chosen, stackName);
  ui.line();
  ui.line(`  ${style.green('✓')} Saved your selection to ${path.relative(deps.cwd, file) || file}`);
  for (const step of preparation.steps) {
    const label = step === 'computeTypes' ? `Allowing ${computeLabel(compute)} in the CDK bootstrap` : 'Preparing your AWS account (CDK bootstrap)';
    const running = new Step(deps.screen, style, label);
    if (step === 'computeTypes') {
      try {
        await deps.setBootstrapComputeTypes(region, preparation.computeTypes);
      } catch (err) {
        running.fail();
        throw new CliError(`Could not update the CDK bootstrap: ${err instanceof Error ? err.message : String(err)}`);
      }
      running.succeed();
      continue;
    }
    const bootstrapLog = `${logDir}${path.sep}setup-bootstrap.log`;
    const result = await deps.run(['//cdk:bootstrap', '--', ...(account ? [`aws://${account}/${region}`] : [])], { cwd: repoRoot, env, logFile: bootstrapLog });
    if (result.code !== 0) {
      running.fail();
      for (const line of errorLines(result.output)) ui.line(`    ${style.red(line)}`);
      ui.line(`    ${style.dim(`Full log: ${path.relative(deps.cwd, bootstrapLog)}`)}`);
      throw new CliError('The account could not be prepared, so nothing was deployed. Fix the error above and run bgagent setup again.');
    }
    running.succeed();
  }
  const started = deps.now();
  const progress = new DeployProgress(deps.screen, style, stackNames, summary.perComponent);
  let deployResult: RunResult;
  try {
    deployResult = await deps.run(
      // The wizard's confirmation replaces CDK's approval prompt, which cannot be answered without a terminal.
      ['//cdk:deploy', '--', ...contextArgs, '-c', `deploymentProfile=${file}`, '--all', '--require-approval', 'never', '--progress', 'events'],
      { cwd: repoRoot, env, logFile: deployLog, onLine: line => progress.handleLine(line) },
    );
  } catch (err) {
    progress.finish(false);
    throw err;
  }
  const elapsed = formatDuration(deps.now() - started);
  const { failures, tail } = progress.finish(deployResult.code === 0);
  ui.line();
  if (deployResult.code !== 0) {
    ui.line(`  ${style.red('✗')} ${style.bold(`Deployment failed after ${elapsed}`)}`);
    ui.line();
    if (failures.length > 0) {
      ui.line('  Cause:');
      for (const failure of failures.slice(0, MAX_FAILURES_SHOWN)) {
        ui.line(`    ${style.bold(failure.component)} — ${failure.resource}`);
        ui.line(`    ${style.red(failure.reason || failure.status)}`);
      }
    } else {
      ui.line('  Cause:');
      for (const line of errorLines(tail)) ui.line(`    ${style.red(line)}`);
    }
    ui.line();
    ui.line(`  ${style.dim(`Full log: ${path.relative(deps.cwd, deployLog)}`)}`);
    ui.line(`  ${style.dim(`Your selection is saved in ${path.basename(file)}; fix the cause and run bgagent setup again.`)}`);
    process.exitCode = 1;
    return;
  }
  ui.line(`  ${style.green('✓')} ${style.bold(`Deployment complete in ${elapsed}`)}`);
  const bundle = await deps.configureFromStack(region, stackName);
  const { registry_api_url: _stale, ...previous } = tryLoadConfig() ?? ({} as Partial<CliConfig>);
  // A removed Registry must not leave its URL behind.
  saveConfig({ ...previous, ...bundle } as CliConfig);
  ui.line();
  ui.field('API', bundle.api_url);
  ui.field('CLI', `now points at ${stackName}`);
  printNextSteps(ui, region, stackName);
}

/* istanbul ignore next -- thin AWS/terminal adapters; runSetup is tested through SetupDeps */
function defaultDeps(): SetupDeps {
  const describeError = (stackName: string, region: string, err: unknown) => new CliError(
    `Could not read stack '${stackName}' in ${region}: ${err instanceof Error ? err.message : String(err)}`,
  );
  return {
    cwd: process.cwd(),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    screen: { tty: Boolean(process.stdout.isTTY), write: text => { process.stdout.write(text); } },
    describeStack: async (region, stackName) => {
      const cf = makeClient(CloudFormationClient, { region });
      try {
        const stack = (await cf.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
        if (!stack) return null;
        return {
          outputs: new Map((stack.Outputs ?? []).filter(o => o.OutputKey && o.OutputValue).map(o => [o.OutputKey!, o.OutputValue!])),
          parameters: new Map((stack.Parameters ?? []).filter(p => p.ParameterKey).map(p => [p.ParameterKey!, p.ParameterValue ?? ''])),
          status: stack.StackStatus ?? 'UNKNOWN',
          account: stack.StackId?.split(':')[4] ?? 'unknown',
        };
      } catch (err) {
        if (err instanceof Error && err.name === 'ValidationError' && /does not exist/.test(err.message)) return null;
        throw describeError(stackName, region, err);
      }
    },
    hasToolGateway: async (region, stackName) => {
      const cf = makeClient(CloudFormationClient, { region });
      try {
        for await (const page of paginateListStackResources({ client: cf }, { StackName: stackName })) {
          if (page.StackResourceSummaries?.some(r => r.ResourceType === 'AWS::BedrockAgentCore::Gateway')) return true;
        }
        return false;
      } catch (err) {
        throw describeError(stackName, region, err);
      }
    },
    callerIdentity: async (region) => {
      const identity = await makeClient(STSClient, { region }).send(new GetCallerIdentityCommand({}));
      if (!identity.Account || !identity.Arn) throw new Error('STS returned no account');
      return { account: identity.Account, arn: identity.Arn };
    },
    listDeployments: async (region) => {
      const cf = makeClient(CloudFormationClient, { region });
      const found: DeploymentSummary[] = [];
      try {
        for await (const page of paginateDescribeStacks({ client: cf }, {})) {
          for (const stack of page.Stacks ?? []) {
            const outputs = new Set((stack.Outputs ?? []).map(output => output.OutputKey));
            // Root application stacks only: nested and network stacks have no Task API outputs.
            if (stack.ParentId || !stack.StackName || !['ApiUrl', 'UserPoolId', 'AppClientId'].every(key => outputs.has(key))) continue;
            const features = stack.Outputs?.find(output => output.OutputKey === 'DeploymentFeatures')?.OutputValue;
            found.push({ name: stack.StackName, status: stack.StackStatus ?? 'UNKNOWN', ...(features !== undefined ? { features } : {}) });
          }
        }
      } catch (err) {
        throw new CliError(`Could not list stacks in ${region}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return found.sort((a, b) => a.name.localeCompare(b.name));
    },
    ask: question => new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      let answered = false;
      rl.on('close', () => { if (!answered) reject(setupCancelled()); });
      rl.question(question, answer => {
        answered = true;
        rl.close();
        resolve(answer);
      });
    }),
    run: (args, options) => new Promise((resolve, reject) => {
      const log = fs.createWriteStream(options.logFile, { flags: 'w' });
      // Argument vector, no shell: the stack name and paths never reach a shell parser.
      // No stdin: nothing downstream may prompt; the wizard already asked.
      const child = spawn('mise', [...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let pending = '';
      const onData = (chunk: Buffer) => {
        const text = String(chunk);
        output += text;
        log.write(text);
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) options.onLine?.(line);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', err => {
        log.end();
        reject(new CliError(`Could not run mise (${err.message}). Install mise and run from the ABCA checkout.`));
      });
      child.on('close', code => {
        if (pending) options.onLine?.(pending);
        log.end(() => resolve({ code: code ?? 1, output }));
      });
    }),
    configureFromStack: fetchConfigureBundleFromStack,
    containerEngine: async () => {
      const answers = (command: string) => new Promise<boolean>(resolve => {
        const child = spawn(command, ['info'], { stdio: 'ignore' });
        child.on('error', () => resolve(false));
        child.on('close', code => resolve(code === 0));
      });
      // An explicit CDK_DOCKER is the operator's choice: honour it or report it, never second-guess it.
      const configured = process.env.CDK_DOCKER;
      if (configured) return (await answers(configured)) ? configured : undefined;
      for (const candidate of ['docker', 'finch']) {
        if (await answers(candidate)) return candidate;
      }
      return undefined;
    },
    setBootstrapComputeTypes: async (region, computeTypes) => {
      const cf = makeClient(CloudFormationClient, { region });
      const stack = (await cf.send(new DescribeStacksCommand({ StackName: BOOTSTRAP_STACK }))).Stacks?.[0];
      // Same template, every other parameter unchanged: only the backend list moves.
      const parameters = (stack?.Parameters ?? [])
        .filter(p => p.ParameterKey && p.ParameterKey !== 'ComputeTypes')
        .map(p => ({ ParameterKey: p.ParameterKey, UsePreviousValue: true }));
      await cf.send(new UpdateStackCommand({
        StackName: BOOTSTRAP_STACK,
        UsePreviousTemplate: true,
        Capabilities: ['CAPABILITY_NAMED_IAM'],
        Parameters: [...parameters, { ParameterKey: 'ComputeTypes', ParameterValue: computeTypes.join(',') }],
      }));
      await waitUntilStackUpdateComplete({ client: cf, maxWaitTime: BOOTSTRAP_UPDATE_TIMEOUT_S }, { StackName: BOOTSTRAP_STACK });
    },
    now: () => Date.now(),
  };
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

export function makeSetupCommand(deps: () => SetupDeps = defaultDeps): Command {
  return new Command('setup')
    .description('Choose optional features, validate Region support, and deploy ABCA (writes abca.deployment.json)')
    .option('--region <region>', 'AWS Region (defaults to configured region / AWS_REGION)')
    .option('--stack-name <name>', `CloudFormation stack name (default: pick or create interactively; ${DEFAULT_STACK_NAME} otherwise)`)
    .option('--features <list>', `Comma-separated features to enable (${DEPLOYMENT_FEATURES.join(', ')}) or none`)
    .option('--compute <list>', 'Compute backends for a new installation: agentcore, ecs or agentcore,ecs (first is the default)')
    .option('-c, --context <key=value>', 'Extra CDK context for diff and deploy, e.g. networkTopology=split (repeatable)', collect)
    .option('--yes', 'Skip confirmation prompts (non-interactive)')
    .option('--accept-data-loss', 'With --yes or without a terminal, allow removing state-bearing resources')
    .option('--no-deploy', 'Only write abca.deployment.json')
    .option('--repo-root <dir>', 'ABCA checkout to deploy from (default: nearest ancestor of the current directory)')
    .action(async (opts: SetupOptions) => {
      await runSetup(opts, deps());
    });
}
