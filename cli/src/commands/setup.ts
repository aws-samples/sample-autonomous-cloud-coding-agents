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
  paginateListStackResources,
} from '@aws-sdk/client-cloudformation';
import { Command } from 'commander';
import { saveConfig, tryLoadConfig } from '../config';
import { CAPABILITY_CATALOG, isAvailableIn } from '../deployment-capabilities';
import {
  DEPLOYMENT_FEATURES,
  DEPLOYMENT_PROFILE_FILE,
  DeploymentFeature,
  DeploymentFeatures,
  detectDeployedFeatures,
  enabledFeatures,
  findRepoRoot,
  MINIMAL_DEPLOYMENT_FEATURES,
  parseFeatureList,
  readDeploymentProfile,
  serializeDeploymentProfile,
  writeDeploymentProfile,
} from '../deployment-profile';
import { CliError } from '../errors';
import { DEFAULT_STACK_NAME } from '../operator-context';
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
const RESERVED_CONTEXT_KEYS = new Set(['stackName', 'deploymentProfile', ...Object.values(FEATURE_CONTEXT_KEYS)]);

/** Resource types whose deletion, replacement or orphaning loses data, installations or ownership. */
const STATE_BEARING_TYPES = new Set([
  'AWS::DynamoDB::Table',
  'AWS::DynamoDB::GlobalTable',
  'AWS::SecretsManager::Secret',
  'AWS::S3::Bucket',
  'AWS::Cognito::UserPool',
  'AWS::KMS::Key',
  'AWS::Logs::LogGroup',
  'AWS::CloudFormation::Stack',
  'AWS::BedrockAgentCore::Memory',
  'AWS::EC2::VPC',
]);

const STACK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const CONTEXT_PATTERN = /^([A-Za-z][\w:.-]*)=(.*)$/s;
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
/** Width of the longest change label (`REPLACE`), so the diff summary aligns. */
const CHANGE_LABEL_WIDTH = 'replace'.length;
/** Exit code for a cancelled setup, like a shell interrupt. */
export const SETUP_CANCELLED_EXIT_CODE = 130;

export interface ExistingStack {
  readonly outputs: ReadonlyMap<string, string>;
  readonly status: string;
  readonly account: string;
}

export interface RunResult {
  readonly code: number;
  readonly output: string;
}

/** Injectable side effects so the wizard is testable without AWS, a TTY or a deploy. */
export interface SetupDeps {
  readonly cwd: string;
  readonly interactive: boolean;
  /** `null` when the stack does not exist; other failures throw. */
  readonly describeStack: (region: string, stackName: string) => Promise<ExistingStack | null>;
  readonly hasToolGateway: (region: string, stackName: string) => Promise<boolean>;
  /** Best effort: the account the credentials resolve to, for new installations. */
  readonly resolveAccount: (region: string) => Promise<string | undefined>;
  /** Rejects with a cancellation CliError when input closes (EOF, Ctrl-C). */
  readonly ask: (question: string) => Promise<string>;
  /** Streams output to the terminal; `capture` also returns it for parsing. */
  readonly run: (args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; capture: boolean }) => Promise<RunResult>;
  readonly configureFromStack: (region: string, stackName: string) => Promise<CliConfig>;
  readonly log: (message: string) => void;
}

export interface SetupOptions {
  readonly region?: string;
  readonly stackName?: string;
  readonly features?: string;
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
  for (const raw of diffOutput.replace(ANSI_PATTERN, '').split('\n')) {
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
export function conflictingContextOverrides(repoRoot: string, selection: DeploymentFeatures): string[] {
  const conflicts: string[] = [];
  for (const { source, context } of persistentContext(repoRoot)) {
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
 * dropped `networkTopology` or `compute_types` would rebuild the VPC or remove
 * backends, which is not a feature change and must not ride along with one.
 */
async function missingDeploymentContext(
  deps: SetupDeps,
  region: string,
  stackName: string,
  existing: ExistingStack,
  context: ReadonlyMap<string, string>,
  repoRoot: string,
): Promise<string[]> {
  const persistent = new Map(persistentContext(repoRoot).flatMap(({ context: values }) => Object.entries(values)));
  const has = (key: string) => context.has(key) || persistent.has(key);
  const missing: string[] = [];
  const computeTypes = existing.outputs.get('ComputeTypes');
  if (computeTypes && computeTypes !== 'agentcore' && !has('compute_types') && !has('compute_type')) {
    missing.push(`--context compute_types=${computeTypes}`);
  }
  if (!has('networkTopology') && (await deps.describeStack(region, `${stackName}-network`))) {
    missing.push('--context networkTopology=split');
  }
  return missing;
}

function onOff(enabled: boolean): string {
  return enabled ? 'on ' : 'off';
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

async function chooseInteractively(
  deps: SetupDeps,
  region: string,
  defaults: DeploymentFeatures,
): Promise<DeploymentFeatures> {
  const result: Record<DeploymentFeature, boolean> = { ...MINIMAL_DEPLOYMENT_FEATURES };
  deps.log('\nOptional features (core governance, GitHub workflow and the Task API are always deployed):\n');
  for (const feature of DEPLOYMENT_FEATURES) {
    const capability = CAPABILITY_CATALOG.features[feature];
    if (!isAvailableIn(capability, region)) {
      deps.log(`  ✗ ${capability.label}: unavailable in ${region} (supported: ${capability.regions?.join(', ')})`);
      continue;
    }
    const notes = [
      `~${capability.approximateResources} resources when enabled alone`,
      ...(capability.maturity === 'experimental' ? ['experimental'] : []),
      ...(capability.requiredServices.length ? [`needs ${capability.requiredServices.join(', ')}`] : []),
    ];
    deps.log(`  • ${capability.label}: ${capability.description} (${notes.join('; ')})`);
    result[feature] = await confirm(deps, `    Enable ${capability.label}?`, defaults[feature]);
  }
  return result;
}

/** Stronger gate for data loss: type the stack name, or `--yes --accept-data-loss`. */
async function confirmDataLoss(deps: SetupDeps, opts: SetupOptions, stackName: string, interactive: boolean): Promise<boolean> {
  if (opts.yes || !interactive) {
    if (!opts.acceptDataLoss) {
      throw new CliError('Refusing to remove state-bearing resources non-interactively. Add --accept-data-loss to proceed.');
    }
    return true;
  }
  return (await deps.ask(`Type the stack name (${stackName}) to confirm data loss: `)).trim() === stackName;
}

/** Interactive or scripted `bgagent setup` (ADR-024). */
export async function runSetup(opts: SetupOptions, deps: SetupDeps): Promise<void> {
  const repoRoot = findRepoRoot(opts.repoRoot ?? deps.cwd);
  const stackName = opts.stackName ?? DEFAULT_STACK_NAME;
  if (!STACK_NAME_PATTERN.test(stackName)) throw new CliError(`Invalid stack name '${stackName}'.`);
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
    region = (await deps.ask('AWS Region to deploy ABCA into: ')).trim();
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

  // 2. Existing deployment: preselect what is there so a rerun never proposes deletion.
  const existing = await deps.describeStack(region, stackName);
  if (existing && existing.status.endsWith('_IN_PROGRESS')) {
    throw new CliError(`Stack '${stackName}' is ${existing.status}; wait for it to finish before running setup.`);
  }
  const deployed = existing ? detectDeployedFeatures(existing.outputs, () => false) : undefined;
  const deployedFeatures = deployed?.source === 'inferred'
    ? { ...deployed.features, toolGateway: await deps.hasToolGateway(region, stackName) }
    : deployed?.features;
  const profile = readDeploymentProfile(repoRoot);
  const defaults = deployedFeatures ?? profile ?? MINIMAL_DEPLOYMENT_FEATURES;

  deps.log(`Repository: ${repoRoot}`);
  deps.log(`Region:     ${region}`);
  deps.log(`Account:    ${existing?.account ?? (await deps.resolveAccount(region)) ?? 'resolved by CDK from your AWS credentials'}`);
  deps.log(`Stack:      ${stackName} (${existing ? `existing, ${existing.status}` : 'new installation'})`);
  if (extraContext.size > 0) deps.log(`Context:    ${[...extraContext].map(([key, value]) => `${key}=${value}`).join(' ')}`);
  if (deployedFeatures) {
    deps.log(`Deployed:   ${enabledFeatures(deployedFeatures).join(', ') || 'none'}${deployed?.source === 'inferred' ? ' (inferred from stack outputs)' : ''}`);
  } else if (!profile) {
    deps.log('Recommended: the governed minimal profile (all optional features off).');
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
    const missing = await missingDeploymentContext(deps, region, stackName, existing, extraContext, repoRoot);
    if (missing.length > 0) {
      throw new CliError(
        `Stack '${stackName}' was deployed with context this run would drop. Rerun with ${missing.join(' ')} `
        + '(or set it in cdk/cdk.json) so only feature changes are applied.',
      );
    }
  }

  // 3. Selection, validated against the Region whatever its source.
  let selection: DeploymentFeatures;
  if (opts.features !== undefined) {
    selection = parseFeatureList(opts.features);
  } else if (deps.interactive && !opts.yes) {
    selection = await chooseInteractively(deps, region, defaults);
  } else {
    selection = defaults;
  }
  const unavailable = unavailableIn(region, selection);
  if (unavailable.length > 0) throw new CliError(unavailable.join('\n'));

  const removed = enabledFeatures(deployedFeatures ?? MINIMAL_DEPLOYMENT_FEATURES).filter(f => !selection[f]);
  deps.log('\nSelected deployment:');
  for (const feature of DEPLOYMENT_FEATURES) {
    const removal = removed.includes(feature) ? '  ← REMOVE (deletes its resources)' : '';
    deps.log(`  ${onOff(selection[feature])}  ${CAPABILITY_CATALOG.features[feature].label}${removal}`);
  }

  const conflicts = conflictingContextOverrides(repoRoot, selection);
  if (conflicts.length > 0) {
    throw new CliError(`CDK context overrides the selected profile:\n- ${conflicts.join('\n- ')}\nRemove them, then rerun setup.`);
  }

  if (!deploying) {
    // The next deploy (local or CI) applies the removal without this wizard's diff.
    const stateful = removed.filter(feature => CAPABILITY_CATALOG.features[feature].stateful);
    if (stateful.length > 0) {
      deps.log(`\n⚠️  The next deploy of this profile deletes the data of: ${stateful.map(f => CAPABILITY_CATALOG.features[f].label).join(', ')}.`);
      if (!(await confirmDataLoss(deps, opts, stackName, deps.interactive))) {
        throw setupCancelled();
      }
    }
    const file = writeDeploymentProfile(repoRoot, selection);
    deps.log(`\nWrote ${file}. Commit it so local and CI synthesis deploy the same features.`);
    deps.log(`Deploy later with \`bgagent setup --stack-name ${stackName} --region ${region}\`.`);
    return;
  }

  // 4. Diff against a temporary copy so cancelling leaves the repository unchanged.
  const env: NodeJS.ProcessEnv = {
    ...process.env, MISE_EXPERIMENTAL: '1', AWS_REGION: region, AWS_DEFAULT_REGION: region, CDK_DEFAULT_REGION: region,
  };
  const contextArgs = ['-c', `stackName=${stackName}`, ...[...extraContext].flatMap(([key, value]) => ['-c', `${key}=${value}`])];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-setup-'));
  let diff: RunResult;
  try {
    const candidate = path.join(tempDir, DEPLOYMENT_PROFILE_FILE);
    fs.writeFileSync(candidate, serializeDeploymentProfile(selection), 'utf-8');
    deps.log('\nComputing `cdk diff` for the selected deployment...\n');
    diff = await deps.run(['//cdk:diff', '--', ...contextArgs, '-c', `deploymentProfile=${candidate}`], { cwd: repoRoot, env, capture: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (diff.code !== 0) {
    throw new CliError(`cdk diff failed (exit ${diff.code}); nothing was written or deployed. Fix the error above and rerun setup.`);
  }

  // 5. Confirmation, with a stronger gate for data loss.
  const stateBearing = parseStateBearingChanges(diff.output);
  if (stateBearing.length > 0) {
    deps.log('\n⚠️  This deployment deletes, replaces or orphans state-bearing resources:');
    for (const change of stateBearing) deps.log(`   ${change.change.toUpperCase().padEnd(CHANGE_LABEL_WIDTH)}  ${change.type}  ${change.id}`);
    deps.log('   Deleted and replaced resources lose their data (installations, mappings, webhook secrets, registry records).');
    deps.log('   Orphaned resources keep their data but leave CloudFormation management.');
    deps.log('   Per-workspace OAuth secrets created by the CLI are not removed; revoke or delete them separately.');
    deps.log('   Re-enabling a feature later creates empty resources; rerun its setup command to reconnect it.');
    if (!(await confirmDataLoss(deps, opts, stackName, deps.interactive))) throw setupCancelled();
  } else if (!opts.yes && !(await confirm(deps, '\nDeploy this configuration?', false))) {
    throw setupCancelled();
  }

  // 6. Persist, deploy the same profile through the existing mise/CDK path, configure the CLI.
  const file = writeDeploymentProfile(repoRoot, selection);
  deps.log(`\nWrote ${file}. Commit it so CI synthesizes the same deployment.\n`);
  const deployResult = await deps.run(
    ['//cdk:deploy', '--', ...contextArgs, '-c', `deploymentProfile=${file}`, '--all',
      ...(opts.yes ? ['--require-approval', 'never'] : [])],
    { cwd: repoRoot, env, capture: false },
  );
  if (deployResult.code !== 0) {
    throw new CliError(
      `Deploy failed (exit ${deployResult.code}). ${DEPLOYMENT_PROFILE_FILE} keeps your selection; `
      + `check the CloudFormation events for '${stackName}', fix the cause, and rerun setup.`,
    );
  }
  const bundle = await deps.configureFromStack(region, stackName);
  const { registry_api_url: _stale, ...previous } = tryLoadConfig() ?? ({} as Partial<CliConfig>);
  // A removed Registry must not leave its URL behind.
  saveConfig({ ...previous, ...bundle } as CliConfig);
  deps.log(`Deployed. CLI configured for ${stackName} in ${region}; run \`bgagent login\` next.`);
}

/* istanbul ignore next -- thin AWS/terminal adapters; runSetup is tested through SetupDeps */
function defaultDeps(): SetupDeps {
  const describeError = (stackName: string, region: string, err: unknown) => new CliError(
    `Could not read stack '${stackName}' in ${region}: ${err instanceof Error ? err.message : String(err)}`,
  );
  return {
    cwd: process.cwd(),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    describeStack: async (region, stackName) => {
      const cf = makeClient(CloudFormationClient, { region });
      try {
        const stack = (await cf.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
        if (!stack) return null;
        return {
          outputs: new Map((stack.Outputs ?? []).filter(o => o.OutputKey && o.OutputValue).map(o => [o.OutputKey!, o.OutputValue!])),
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
    resolveAccount: async (region) => {
      try {
        const identity = await makeClient(CloudFormationClient, { region }).config.credentials();
        return (identity as { accountId?: string }).accountId;
      } catch {
        // nosemgrep: ts-silent-success-masking -- display-only best effort: the caller prints a "resolved by CDK" placeholder, and the deploy itself still fails loudly on bad credentials
        return undefined;
      }
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
      // Argument vector, no shell: the stack name and paths never reach a shell parser.
      const child = spawn('mise', [...args], {
        cwd: options.cwd, env: options.env, stdio: options.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      });
      let output = '';
      // Stream while capturing so a long diff is never silent.
      child.stdout?.on('data', chunk => { output += String(chunk); process.stdout.write(chunk); });
      child.stderr?.on('data', chunk => { output += String(chunk); process.stderr.write(chunk); });
      child.on('error', err => reject(new CliError(`Could not run mise (${err.message}). Install mise and run from the ABCA checkout.`)));
      child.on('close', code => resolve({ code: code ?? 1, output }));
    }),
    configureFromStack: fetchConfigureBundleFromStack,
    log: message => console.log(message),
  };
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

export function makeSetupCommand(deps: () => SetupDeps = defaultDeps): Command {
  return new Command('setup')
    .description('Choose optional features, validate Region support, and deploy ABCA (writes abca.deployment.json)')
    .option('--region <region>', 'AWS Region (defaults to configured region / AWS_REGION)')
    .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME)
    .option('--features <list>', `Comma-separated features to enable (${DEPLOYMENT_FEATURES.join(', ')}) or none`)
    .option('-c, --context <key=value>', 'Extra CDK context for diff and deploy, e.g. networkTopology=split (repeatable)', collect)
    .option('--yes', 'Skip confirmation prompts (non-interactive)')
    .option('--accept-data-loss', 'With --yes or without a terminal, allow removing state-bearing resources')
    .option('--no-deploy', 'Only write abca.deployment.json')
    .option('--repo-root <dir>', 'ABCA checkout to deploy from (default: nearest ancestor of the current directory)')
    .action(async (opts: SetupOptions) => {
      await runSetup(opts, deps());
    });
}
