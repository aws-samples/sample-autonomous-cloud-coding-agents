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
 * `mise //cdk:preflight` (and the first step of `mise //cdk:deploy`): refuse to deploy
 * against a bootstrap that cannot deploy this checkout (#126). Decision logic and
 * rationale: `src/bootstrap/preflight.ts`. Needs only `cloudformation:DescribeStacks`.
 *
 * Usage: tsx scripts/preflight-bootstrap.ts [--json] [--profile P] [--region R]
 *          [--toolkit-stack-name N] [-c compute_types=...] [...other cdk args, ignored]
 *
 * Exit 0 on PASS or WARN, 1 on FAIL. Escape hatch: ABCA_SKIP_BOOTSTRAP_PREFLIGHT=1.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { evaluateBootstrap, requiredPolicySet, type BootstrapVerdict, type CfnOutput } from '../src/bootstrap/preflight';
import { BOOTSTRAP_VERSION, computeBootstrapHash } from '../src/bootstrap/version';
import { resolveComputeBackends } from '../src/handlers/shared/compute-backend';

/** `--profile` / `--region` (space and `=` forms) as they appear in the CDK arg list. */
function awsGlobalArgs(argv: readonly string[]): string[] {
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

function toolkitStackName(argv: readonly string[]): string {
  const i = argv.indexOf('--toolkit-stack-name');
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : 'CDKToolkit';
}

/** The app's `compute_types`/`compute_type` context: `-c key=value` args win over cdk.json, as in CDK. */
function contextValue(argv: readonly string[], key: string): unknown {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const a = argv[i]!;
    const value = (a === '-c' || a === '--context') ? argv[i + 1] : a.startsWith('--context=') ? a.slice('--context='.length) : undefined;
    if (value?.startsWith(`${key}=`)) return value.slice(key.length + 1);
  }
  try {
    return (JSON.parse(readFileSync('cdk.json', 'utf8')) as { context?: Record<string, unknown> }).context?.[key];
  } catch {
    // nosemgrep: ts-silent-success-masking -- no cdk.json in cwd means no overrides; resolveComputeBackends applies the app's own default
    return undefined;
  }
}

/** CDKToolkit outputs, or null when the stack does not exist. Any other failure throws. */
function readToolkitOutputs(argv: readonly string[]): CfnOutput[] | null {
  try {
    const raw = execFileSync('aws', [
      ...awsGlobalArgs(argv),
      'cloudformation', 'describe-stacks',
      '--stack-name', toolkitStackName(argv),
      '--query', 'Stacks[0].Outputs', '--output', 'json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return (JSON.parse(raw) as CfnOutput[] | null) ?? [];
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr || err);
    if (/does not exist/.test(stderr)) return null;
    throw new Error(`could not read the ${toolkitStackName(argv)} stack: ${stderr.trim()}`);
  }
}

function report(verdict: BootstrapVerdict, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(verdict));
    return;
  }
  const line = `bootstrap preflight: ${verdict.status}: ${verdict.message}`;
  if (verdict.status === 'FAIL') {
    console.error(line);
    console.error('To bypass at your own risk: ABCA_SKIP_BOOTSTRAP_PREFLIGHT=1.');
  } else {
    console.log(line);
  }
}

function main(argv: readonly string[]): number {
  const json = argv.includes('--json');
  if (process.env.ABCA_SKIP_BOOTSTRAP_PREFLIGHT === '1') {
    report({ status: 'PASS', message: 'skipped (ABCA_SKIP_BOOTSTRAP_PREFLIGHT=1).' }, json);
    return 0;
  }
  const backends = resolveComputeBackends(contextValue(argv, 'compute_types'), contextValue(argv, 'compute_type'));
  const verdict = evaluateBootstrap(readToolkitOutputs(argv), {
    version: BOOTSTRAP_VERSION,
    hash: computeBootstrapHash(),
    policySet: requiredPolicySet(backends),
  });
  report(verdict, json);
  return verdict.status === 'FAIL' ? 1 : 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  const message = `${err instanceof Error ? err.message : String(err)} The bootstrap state could not be determined `
    + '(commonly: no AWS CLI on PATH, or expired credentials). Fix it and re-run, or bypass with ABCA_SKIP_BOOTSTRAP_PREFLIGHT=1.';
  if (process.argv.includes('--json')) console.log(JSON.stringify({ status: 'FAIL', message }));
  else console.error(`bootstrap preflight: FAIL: ${message}`);
  process.exit(1);
}
