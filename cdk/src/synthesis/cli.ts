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

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import bedrockPackage from '@aws-cdk/aws-bedrock-alpha/package.json';
import cdkPackage from 'aws-cdk-lib/package.json';
import { blueprintProvisioningMode } from '../blueprints/configuration';
import { buildApp } from '../main';
import { inspectAssembly } from './assembly';
import { auditProfile, DEFAULT_BUDGETS, ProfileAudit, WorkerResult } from './audit';
import { FIXTURE, STRUCTURAL_CONTEXT, synthesisEnvironment, synthesisProfiles, SynthesisProfile } from './profiles';
import { createOutputDirectory, projectContext, sourceProvenance } from './workspace';

const PROCESS_OUTPUT_LIMIT = 8_388_608;
const MAX_TEMPLATE_BYTES = 1_000_000;
const CHECKOUT = path.resolve(__dirname, '../../..');

const HELP = `Usage: mise //cdk:census -- [options]

  --list                         List named structural profiles
  --profile NAME                 Select a profile (repeatable; default: all)
  --output DIRECTORY             New output directory (default: a temporary directory)
  --check-stability              Synthesize twice in independent processes; fail on differences
  --blueprint-provisioning MODE  Select legacy, prepare, adopt, or managed for every profile
  --max-resources NUMBER          Per-template ceiling (default: 490; maximum: 500)
  --max-template-bytes NUMBER     Per-template ceiling (default: 800000)
  --help                         Show this help

Uses the production buildApp with fixed account/AZ/context inputs, metadata enabled,
and bundling/staging disabled. No AWS credentials or network lookups are required.
This is structural evidence, not a deploy or bundled-release validation.
Reports, source fingerprints, templates, and per-profile logs stay in the output
directory. The stability check preserves timestamps, logical IDs, metadata, and
stack dependencies. Missing CDK context fails the audit instead of triggering lookups.
`;

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function synthesize(profile: SynthesisProfile, directory: string): Promise<void> {
  let result: WorkerResult;
  try {
    // Only workers construct the app; the parent never synthesizes with its environment.
    const app = await buildApp({
      account: FIXTURE.account,
      region: FIXTURE.region,
      describeAzs: async () => [...FIXTURE.zones],
      resolveCallerAccount: async () => FIXTURE.account,
      appProps: {
        outdir: directory,
        autoSynth: false,
        context: { ...projectContext(CHECKOUT), ...profile.context },
        postCliContext: STRUCTURAL_CONTEXT,
      },
    });
    app.synth();
    result = { kind: 'synthesized', census: inspectAssembly(directory) };
  } catch (error) {
    result = { kind: 'rejected', error: errorMessage(error) };
  }
  writeJson(path.join(directory, 'result.json'), result);
}

function runWorker(profile: SynthesisProfile, directory: string): WorkerResult {
  mkdirSync(directory);
  const child = spawnSync(process.execPath, [
    '-r', require.resolve('ts-node/register/transpile-only'), __filename,
    '--worker', '--profile', profile.name, '--output', directory,
    ...(typeof profile.context.blueprintProvisioning === 'string'
      ? ['--blueprint-provisioning', profile.context.blueprintProvisioning] : []),
  ], {
    cwd: path.resolve(__dirname, '../..'),
    env: synthesisEnvironment(process.env),
    encoding: 'utf8',
    maxBuffer: PROCESS_OUTPUT_LIMIT,
    timeout: 120_000,
  });
  writeFileSync(path.join(directory, 'synth.log'), `${child.stdout ?? ''}${child.stderr ?? ''}`);
  if (child.error || child.status !== 0) {
    throw new Error(`Synthesis process failed (${child.signal ?? child.status}): ${child.error?.message ?? `see ${path.join(directory, 'synth.log')}`}`);
  }
  return JSON.parse(readFileSync(path.join(directory, 'result.json'), 'utf8')) as WorkerResult;
}

function ceiling(value: string | undefined, fallback: number, maximum: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return parsed;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'help': { type: 'boolean' },
      'list': { type: 'boolean' },
      'profile': { type: 'string', multiple: true },
      'output': { type: 'string' },
      'check-stability': { type: 'boolean' },
      'blueprint-provisioning': { type: 'string' },
      'max-resources': { type: 'string' },
      'max-template-bytes': { type: 'string' },
      'worker': { type: 'boolean' },
    },
  });
  if (values.help) { process.stdout.write(HELP); return; }
  const all = synthesisProfiles(values['blueprint-provisioning'] === undefined
    ? undefined : blueprintProvisioningMode(values['blueprint-provisioning']));
  if (values.list) {
    for (const profile of all) process.stdout.write(`${profile.name}${profile.expectedError ? ' [expected rejection]' : ''}\n`);
    return;
  }
  const names = values.profile ?? all.map(p => p.name);
  const selected = [...new Set(names)].map(name => {
    const found = all.find(profile => profile.name === name);
    if (!found) throw new Error(`Unknown profile '${name}'; use --list`);
    return found;
  });
  if (values.worker) {
    if (selected.length !== 1 || !values.output) throw new Error('Worker requires one profile and an output directory');
    await synthesize(selected[0], path.resolve(values.output));
    return;
  }
  const resourceLimit = ceiling(values['max-resources'], DEFAULT_BUDGETS.resources, 500, 'max-resources');
  const byteLimit = ceiling(values['max-template-bytes'], DEFAULT_BUDGETS.bytes, MAX_TEMPLATE_BYTES, 'max-template-bytes');
  const directory = createOutputDirectory(CHECKOUT, values.output);
  const before = sourceProvenance(CHECKOUT);
  const baseContext = projectContext(CHECKOUT);
  const budgets = { ...DEFAULT_BUDGETS, resources: resourceLimit, bytes: byteLimit };
  const results: ProfileAudit[] = [];
  let failed = false;
  for (const profile of selected) {
    const firstDir = path.join(directory, profile.name);
    const result = auditProfile(profile, firstDir, budgets, !!values['check-stability'], runWorker);
    const { first, failures } = result;
    failed ||= failures.length > 0;
    results.push(result);
    const status = failures.length ? 'FAIL' : first?.kind === 'rejected' ? 'EXPECTED REJECTION' : 'PASS';
    process.stdout.write(`${status} ${profile.name}${first?.kind === 'synthesized' ? `: ${first.census.totalResources} template resources across ${first.census.templates.length} templates` : ''}\n`);
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
  }
  const after = sourceProvenance(CHECKOUT);
  const sourceChanged = before.sourceSha256 !== after.sourceSha256;
  failed ||= sourceChanged;
  writeJson(path.join(directory, 'report.json'), {
    schemaVersion: 2,
    mode: 'structural-unbundled',
    provenance: before,
    sourceChangedDuringRun: sourceChanged,
    versions: {
      node: process.version,
      cdk: cdkPackage.version,
      bedrockAlpha: bedrockPackage.version,
    },
    fixture: FIXTURE,
    workerEnvironment: synthesisEnvironment(process.env),
    projectContext: baseContext,
    contextOverrides: STRUCTURAL_CONTEXT,
    budgets,
    stabilityChecked: !!values['check-stability'],
    results,
  });
  if (sourceChanged) process.stderr.write('Source inputs changed during the census; rerun against a stable checkout.\n');
  process.stdout.write(`Report: ${path.join(directory, 'report.json')}\n`);
  process.exitCode = failed ? 1 : 0;
}

/* istanbul ignore next -- exercised through the command-line smoke checks */
if (require.main === module) {
  void main().catch(error => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
