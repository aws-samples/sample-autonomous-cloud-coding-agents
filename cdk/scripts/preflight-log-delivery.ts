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
 * Deploy preflight: one-time log-delivery migration for stacks that predate
 * the removal of the log-delivery pin table (#703).
 *
 * WHY THIS RUNS ON EVERY DEPLOY: a stack whose live `AWS::Logs::Delivery*`
 * resources still carry the pinned logical ids (`RuntimeCDKSource…` /
 * `RuntimeCdkLogGroup…`) hits a guaranteed mid-deploy rollback on the first
 * deploy after the pins were removed — CloudFormation renames the resources,
 * creates-before-deletes, and the new DeliverySource collides with the live
 * one (account-unique per runtime ARN + log type → `AlreadyExists`). That
 * rollback message says nothing about the migration, and there is no channel
 * to warn every existing deployment. So the deploy path detects the state and
 * converges it, instead of letting CloudFormation discover it half an hour in.
 * Design rationale: docs/design/OBSERVABILITY.md, "AgentCore log delivery".
 *
 * WHAT IT DOES: reads the stack's own resource list, and if (and only if)
 * legacy-pinned delivery resources are present, deletes exactly those — by the
 * physical ids CloudFormation reports, never by listing the account — then
 * lets the deploy proceed. The deploy recreates the trio under the library's
 * naming; CloudFormation treats the delete of the already-gone old resources
 * as a no-op. Agent log delivery is down from the deletion until the deploy
 * finishes; no delivered log data is touched. Stacks already on the library's
 * ids, and fresh installs (no stack), pass straight through.
 *
 * Scoped-by-construction: the only delete targets are physical ids read off
 * `list-stack-resources` for THIS stack, so delivery configurations belonging
 * to anything else in the account are unreachable, even on a shared account.
 *
 * Uses the AWS CLI rather than SDK clients so the cdk package needs no new
 * dependency for a one-time migration path. Note this DOES add the AWS CLI to
 * the deploy path's prerequisites — `QUICK_START.mdx` otherwise offers an
 * ABCA-CLI route for the post-deploy steps — so a missing `aws` is reported as
 * "state could not be determined" rather than as a stack problem (see the
 * abort handler at the bottom of this file).
 *
 * Exit codes: 0 = nothing to do or migration applied; 2 = legacy resources
 * found in --check-only mode; 1 = could not determine state or a delete
 * failed (deploy must not proceed into a known rollback).
 *
 * Escape hatch: ABCA_SKIP_LOG_DELIVERY_PREFLIGHT=1 skips entirely.
 * Cautious mode: --check-only (or ABCA_LOG_DELIVERY_PREFLIGHT=check) reports
 * and aborts instead of deleting.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DELIVERY_TYPES = [
  'AWS::Logs::Delivery',
  'AWS::Logs::DeliverySource',
  'AWS::Logs::DeliveryDestination',
] as const;

type DeliveryType = (typeof DELIVERY_TYPES)[number];

/**
 * The two logical-id shapes the retired pin table produced
 * (`PINNED_LOG_DELIVERY_BY_STACK`): `RuntimeCDKSource…` for sources and
 * `RuntimeCdkLogGroup…` for destinations and delivery links. The library's
 * own ids (`RuntimeApplicationLogsDeliverySource<hash>` …) match neither.
 */
const LEGACY_ID = /CDKSource|CdkLogGroup/;

interface StackResource {
  LogicalResourceId: string;
  PhysicalResourceId?: string;
  ResourceType: string;
  ResourceStatus?: string;
}

/**
 * Global `aws` options forwarded from the CDK argument list, so this script reads and
 * deletes in the SAME account and region as the deploy it gates.
 *
 * Without this, `mise //cdk:deploy -- --profile prod` deployed to one account while the
 * preflight inspected — and then deleted from — whatever the ambient profile pointed at.
 * A delete in the wrong account is the worst outcome this script has, so the two
 * resolutions must not be able to disagree.
 */
let awsGlobalArgs: readonly string[] = [];

function aws(args: string[]): string {
  return execFileSync('aws', [...awsGlobalArgs, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The most informative text available for a failed `execFileSync`.
 *
 * `stderr ?? err` was wrong: an empty-string stderr is not nullish, so a CLI killed by a
 * signal (or one that writes nothing) produced a message ending in a bare colon with no
 * cause at all. `||` falls through on empty, and the status/signal is appended because
 * that is the only signal left in exactly that case.
 */
function errText(err: unknown): string {
  const e = err as { stderr?: unknown; status?: unknown; signal?: unknown };
  const base = String(e.stderr || err).trim();
  const how = e.signal ? `signal ${String(e.signal)}` : e.status !== undefined && e.status !== null
    ? `exit ${String(e.status)}` : '';
  return base && how ? `${base} (${how})` : base || how || 'no output';
}

/** `--profile` / `--region` (space and `=` forms) as they appear in the CDK arg list. */
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

/**
 * The account (and region) the deletes would land in, for the resolution log line.
 *
 * Best-effort by design: this is reporting, not a precondition, so a failure here must
 * not fail a deploy. Returns `null` when it cannot be determined and the caller prints
 * "target unknown" rather than a guess.
 */
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

/** Default stack name, mirroring `buildApp` in src/main.ts. */
const DEFAULT_STACK_NAME = 'backgroundagent-dev';

/**
 * Resolve which stack to inspect, from the same places the CDK app looks plus this
 * script's own flag.
 *
 * The app takes its stack from `stackName` CDK **context** (`src/main.ts`), so a
 * resolution that only read `--stack-name`/`STACK_NAME` could disagree with the deploy
 * it gates — and this script deletes resources, so disagreeing is not merely untidy.
 * `cdk.json` context is therefore read here too, exactly as `cdk deploy` would.
 *
 * One gap remains and cannot be closed from inside this script: context passed on the
 * CDK command line (`mise //cdk:deploy -- -c stackName=x`) is appended to `cdk deploy`
 * and never reaches a mise `depends` task, so this script cannot observe it. Verified,
 * not assumed. For a non-default stack the operator must therefore set BOTH — the env
 * var for this preflight and the context for the deploy:
 *
 *   STACK_NAME=x mise //cdk:deploy -- -c stackName=x
 *
 * The resolved target is printed on every run so a mismatch is visible in the deploy
 * log rather than inferred from what got deleted. `-c stackName=`/`--context stackName=`
 * are also accepted here, for a direct `mise //cdk:preflight:log-delivery` invocation.
 */
function resolveStackName(argv: readonly string[]): { stackName: string; source: string } {
  const flag = argv.indexOf('--stack-name');
  if (flag >= 0 && argv[flag + 1]) return { stackName: argv[flag + 1]!, source: '--stack-name' };

  // CDK's own context forms, when handed straight to this script.
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

  // Persisted context — what `cdk deploy` would read when no flag is given.
  try {
    // BOTH context files. `cdk.context.json` matters more than it looks: this repo's
    // `cdk.json` carries no `context` block at all, so reading only that file made this
    // branch dead code — while `.github/workflows/build.yml` writes `stackName` into
    // `cdk.context.json` for every pipeline stack (`pr<N>-<compute>`). The CI path
    // therefore resolved to the default and would have inspected, and deleted from, a
    // different stack than the one being deployed.
    for (const file of ['../cdk.context.json', '../cdk.json'] as const) {
      let cfg: { context?: Record<string, unknown>; stackName?: unknown };
      try {
        cfg = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
      } catch {
        // nosemgrep: ts-silent-success-masking -- an absent context file is the normal case (cdk.context.json is generated, and cdk.json has no context block here), not a failure; the next source is tried and 'default' is the documented floor
        continue;
      }
      // `cdk.context.json` is a flat map; `cdk.json` nests under `context`.
      const fromContext = cfg.context?.stackName ?? cfg.stackName;
      if (typeof fromContext === 'string' && fromContext) {
        return { stackName: fromContext, source: file.replace('../', '') };
      }
    }
  } catch {
    // No readable context file — fall through to the default, which is what the app
    // itself does. Not an error worth failing a deploy over.
  }

  return { stackName: DEFAULT_STACK_NAME, source: 'default' };
}

/** `null` means the stack does not exist (fresh install — nothing to migrate). */
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
    if (stderr.includes('does not exist')) return null; // nosemgrep: ts-silent-success-masking -- null is not an empty success: it is the documented fresh-install signal, and main() branches on it explicitly
    throw new Error(`could not list resources of stack '${stackName}': ${stderr.trim()}`);
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
    // Already gone (e.g. a re-run after an interrupted migration): the goal
    // state — old resource absent — is reached, so this is success, not
    // failure. Anything else aborts the deploy; see main().
    if (stderr.includes('ResourceNotFoundException')) {
      console.log(`  already gone:   ${type} ${physicalId}`);
      return; // nosemgrep: ts-silent-success-masking -- delete target already absent IS the goal state; treating it as success is what makes an interrupted migration safely re-runnable
    }
    throw new Error(`failed to delete ${type} '${physicalId}': ${stderr.trim()}`);
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

  // Printed unconditionally, and it names the ACCOUNT as well as the stack: this script
  // deletes, so the log has to be enough to tell after the fact exactly what was in
  // scope. A stack name alone is ambiguous across accounts.
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

  // FAIL CLOSED on an ambiguous target. Deletions are pending, arguments were supplied,
  // and yet the stack name fell all the way through to the built-in default — so the
  // operator is customizing this deploy in some way this script did not recognize, and
  // the stack it is about to delete from is a guess rather than a derivation. The
  // dangerous case is real: an account holding a legacy `backgroundagent-dev` plus a
  // second stack, deployed with an argument that names the second, would have had the
  // FIRST one's log delivery deleted — and CloudFormation would not recreate it, because
  // that stack is not the one being deployed. Its agent logging would simply go dark.
  //
  // Refuse rather than guess. `--check-only` is unaffected (it deletes nothing), and an
  // argument-free deploy is unaffected (default is then the correct derivation, exactly
  // as in the CDK app).
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
  //
  // Iterating BY TYPE also re-applies the resource-type restriction, independently of the
  // filter above. That redundancy is deliberate and load-bearing: `LEGACY_ID` matches the
  // library's stack-scoped `AWS::Logs::ResourcePolicy`
  // (`CdkLogGroupLogsDeliveryPolicy…`) too, and deleting that would break log delivery for
  // every log type at once — with no rename to make CloudFormation put it back. Flattening
  // this to `for (const r of legacy)` would do exactly that; the fixture in
  // `test/scripts/preflight-log-delivery.test.ts` includes such a row so the flattening
  // fails the suite instead of a deployment.
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
  // The reason for aborting is NOT the same in every case, and asserting the wrong one
  // sends the reader after the wrong problem. With no `aws` on PATH this printed
  // "proceeding would fail mid-update with AlreadyExists" — a claim about a resource
  // collision, when the actual fault was a missing CLI and the collision may not exist at
  // all. Distinguish "could not determine the state" from "the state is known-bad".
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
