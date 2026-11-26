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

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DELIVERY_TYPES = [
  'AWS::Logs::Delivery',
  'AWS::Logs::DeliverySource',
  'AWS::Logs::DeliveryDestination',
] as const;

type DeliveryType = (typeof DELIVERY_TYPES)[number];

const LEGACY_ID = /CDKSource|CdkLogGroup/;

interface StackResource {
  LogicalResourceId: string;
  PhysicalResourceId?: string;
  ResourceType: string;
  ResourceStatus?: string;
}

let awsGlobalArgs: readonly string[] = [];

function aws(args: string[]): string {
  return execFileSync('aws', [...awsGlobalArgs, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function errText(err: unknown): string {
  const e = err as { stderr?: unknown; status?: unknown; signal?: unknown };
  const base = String(e.stderr || err).trim();
  const how = e.signal ? `signal ${String(e.signal)}` : e.status !== undefined && e.status !== null
    ? `exit ${String(e.status)}` : '';
  return base && how ? `${base} (${how})` : base || how || 'no output';
}

function resolveAwsGlobalArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    for (const opt of ['--profile', '--region'] as const) {
      if (a === opt && argv[i + 1]) out.push(opt, argv[i + 1]!);
      else if (a.startsWith(`${opt}=`)) out.push(opt, a.slice(opt.length + 1));
    }
  }
  return out;
}

function describeAwsTarget(): string | null {
  try {
    const account = aws([
      'sts', 'get-caller-identity', '--query', 'Account', '--output', 'text',
    ]).trim();
    let region = '';
    try {
      region = aws(['configure', 'get', 'region']).trim();
    } catch {
      region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? '';
    }
    return `account ${account}${region ? `, ${region}` : ''}`;
  } catch {
    // nosemgrep: ts-silent-success-masking -- reporting only; an undeterminable target must not fail a deploy, and the caller prints "target unknown" instead of a guess
    return null;
  }
}

const DEFAULT_STACK_NAME = 'backgroundagent-dev';

function resolveStackName(argv: readonly string[]): { stackName: string; source: string } {
  const flag = argv.indexOf('--stack-name');
  if (flag >= 0 && argv[flag + 1]) return { stackName: argv[flag + 1]!, source: '--stack-name' };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if ((a === '-c' || a === '--context') && argv[i + 1]?.startsWith('stackName=')) {
      return { stackName: argv[i + 1]!.slice('stackName='.length), source: `${a} stackName=` };
    }
    if (a.startsWith('--context=stackName=')) {
      return { stackName: a.slice('--context=stackName='.length), source: '--context=stackName=' };
    }
  }

  if (process.env.STACK_NAME) return { stackName: process.env.STACK_NAME, source: 'STACK_NAME' };

  try {
    const CONTEXT_FILES = ['cdk.context.json', 'cdk.json'] as const;
    const contextDir = process.env.ABCA_PREFLIGHT_CONTEXT_DIR
      ? pathToFileURL(`${process.env.ABCA_PREFLIGHT_CONTEXT_DIR}/`)
      : new URL('../', import.meta.url);
    for (const name of CONTEXT_FILES) {
      let cfg: { context?: Record<string, unknown>; stackName?: unknown };
      try {
        cfg = JSON.parse(readFileSync(new URL(name, contextDir), 'utf8'));
      } catch {
        continue;
      }
      // `cdk.context.json` is a flat map; `cdk.json` nests under `context`.
      const fromContext = cfg.context?.stackName ?? cfg.stackName;
      if (typeof fromContext === 'string' && fromContext) {
        return { stackName: fromContext, source: name };
      }
    }
  } catch {
    // Fall through to the default.
  }

  return { stackName: DEFAULT_STACK_NAME, source: 'default' };
}

function listStackResources(stackName: string): StackResource[] | null {
  try {
    const out = aws([
      'cloudformation',
      'list-stack-resources',
      '--stack-name',
      stackName,
      '--output',
      'json',
    ]);
    return (JSON.parse(out) as { StackResourceSummaries: StackResource[] })
      .StackResourceSummaries;
  } catch (err) {
    const stderr = errText(err);
    if (stderr.includes('does not exist')) return null;
    throw new Error(`could not list resources of stack '${stackName}': ${stderr.trim()}`, { cause: err });
  }
}

function deleteResource(type: DeliveryType, physicalId: string): void {
  const args: Record<DeliveryType, string[]> = {
    'AWS::Logs::Delivery': ['logs', 'delete-delivery', '--id', physicalId],
    'AWS::Logs::DeliverySource': ['logs', 'delete-delivery-source', '--name', physicalId],
    'AWS::Logs::DeliveryDestination': [
      'logs',
      'delete-delivery-destination',
      '--name',
      physicalId,
    ],
  };
  try {
    aws(args[type]);
  } catch (err) {
    const stderr = errText(err);
    if (stderr.includes('ResourceNotFoundException')) {
      console.log(`  already gone:   ${type} ${physicalId}`);
      return;
    }
    throw new Error(`failed to delete ${type} '${physicalId}': ${stderr.trim()}`, { cause: err });
  }
  console.log(`  deleted:        ${type} ${physicalId}`);
}

function main(): number {
  if (process.env.ABCA_SKIP_LOG_DELIVERY_PREFLIGHT === '1') {
    console.log('log-delivery preflight: skipped (ABCA_SKIP_LOG_DELIVERY_PREFLIGHT=1)');
    return 0;
  }

  const argv = process.argv.slice(2);
  awsGlobalArgs = resolveAwsGlobalArgs(argv);
  const { stackName, source } = resolveStackName(argv);
  const checkOnly =
    argv.includes('--check-only') || process.env.ABCA_LOG_DELIVERY_PREFLIGHT === 'check';

  const target = describeAwsTarget();
  console.log(
    `log-delivery preflight: inspecting stack '${stackName}' (from ${source}) in `
    + `${target ?? 'an undetermined account/region (sts get-caller-identity failed)'}`,
  );

  const resources = listStackResources(stackName);
  if (resources === null) {
    console.log(`log-delivery preflight: stack '${stackName}' not deployed yet — nothing to do`);
    return 0;
  }

  const legacy = resources.filter(
    (r) =>
      (DELIVERY_TYPES as readonly string[]).includes(r.ResourceType) &&
      LEGACY_ID.test(r.LogicalResourceId) &&
      r.ResourceStatus !== 'DELETE_COMPLETE',
  );
  if (legacy.length === 0) {
    console.log(
      `log-delivery preflight: stack '${stackName}' already on library-managed ids — nothing to do`,
    );
    return 0;
  }

  console.log(
    `log-delivery preflight: stack '${stackName}' still has ${legacy.length} log-delivery ` +
      'resource(s) under the retired pinned naming (#703). The next deploy renames them, ' +
      'which CloudFormation cannot do in place (DeliverySource is account-unique per runtime ' +
      'ARN + log type; create-before-delete collides and rolls the whole update back).',
  );
  console.log(
    'One-time migration: delete these exact resources now and let the deploy recreate them. ' +
      'Agent log delivery pauses until the deploy completes; delivered log data is not touched.',
  );
  for (const r of legacy) {
    console.log(`  ${r.ResourceType}  ${r.LogicalResourceId}  ->  ${r.PhysicalResourceId ?? '?'}`);
  }

  if (checkOnly) {
    console.log(
      'Check-only mode: not deleting. Re-run without --check-only (or unset ' +
        'ABCA_LOG_DELIVERY_PREFLIGHT) to migrate, or follow docs/design/OBSERVABILITY.md.',
    );
    return 2;
  }

  if (source === 'default' && argv.length > 0) {
    throw new Error(
      `refusing to delete from '${stackName}': arguments were supplied (${argv.join(' ')}) but the `
      + 'stack name still resolved from the built-in default, so the target is a guess rather '
      + 'than a derivation of this deploy. Name it explicitly — STACK_NAME=<stack>, '
      + '--stack-name <stack>, or -c stackName=<stack> — or re-run with --check-only to see '
      + 'what would be deleted.',
    );
  }

  // Deliveries reference their source and destination, so they go first.
  // When the deploy removes the old logical ids, CloudFormation treats the delete of an
  // already-gone resource as a no-op.
  const order: DeliveryType[] = [
    'AWS::Logs::Delivery',
    'AWS::Logs::DeliverySource',
    'AWS::Logs::DeliveryDestination',
  ];
  for (const type of order) {
    for (const r of legacy.filter((l) => l.ResourceType === type)) {
      if (!r.PhysicalResourceId) {
        throw new Error(
          `stack resource ${r.LogicalResourceId} has no physical id; cannot migrate safely`,
        );
      }
      deleteResource(type, r.PhysicalResourceId);
    }
  }
  console.log(
    'log-delivery preflight: migration applied — the deploy will recreate log delivery ' +
      'under library-managed ids. This was a one-time step; future deploys pass through.',
  );
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`log-delivery preflight: ${message}`);
  const couldNotDetermine =
    /ENOENT|not found|could not list resources|AccessDenied|not authorized|ExpiredToken|credential/i
      .test(message);
  console.error(
    couldNotDetermine
      ? 'Aborting before deploy: the migration state could not be determined, so whether this '
        + 'deploy would hit the AlreadyExists collision is UNKNOWN — this is not itself evidence '
        + 'of a problem with your stack. Fix the error above (commonly: no AWS CLI on PATH, or '
        + 'credentials lacking cloudformation:ListStackResources) and re-run.'
      : 'Aborting before deploy: the stack is on the retired pinned ids, so proceeding would fail '
        + 'mid-update with AlreadyExists and roll back.',
  );
  console.error(
    'Manual path: docs/design/OBSERVABILITY.md ("AgentCore log delivery"). To see what would '
    + 'be deleted without deleting: --check-only. To bypass at your own risk: '
    + 'ABCA_SKIP_LOG_DELIVERY_PREFLIGHT=1.',
  );
  process.exit(1);
}
