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
 * Deploy preflight: refuse to deploy against a stale bootstrap policy bundle.
 * Decision logic and rationale: `src/bootstrap/preflight.ts`.
 *
 * Usage (from `mise //cdk:deploy`, which forwards the same args to `cdk deploy`):
 *   tsx scripts/preflight-bootstrap.ts [--profile P] [--region R] [--toolkit-stack-name N] [...]
 *
 * Escape hatch: ABCA_SKIP_BOOTSTRAP_PREFLIGHT=1 skips entirely.
 */

import { execFileSync } from 'node:child_process';
import { evaluateBootstrap, type CfnOutput } from '../src/bootstrap/preflight';
import { BOOTSTRAP_VERSION, computeBootstrapHash } from '../src/bootstrap/version';

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

function main(argv: readonly string[]): number {
  if (process.env.ABCA_SKIP_BOOTSTRAP_PREFLIGHT === '1') {
    console.log('bootstrap preflight: skipped (ABCA_SKIP_BOOTSTRAP_PREFLIGHT=1).');
    return 0;
  }
  const verdict = evaluateBootstrap(readToolkitOutputs(argv), { version: BOOTSTRAP_VERSION, hash: computeBootstrapHash() });
  if (verdict.ok) {
    console.log(`bootstrap preflight: ${verdict.message}`);
    return 0;
  }
  console.error(`bootstrap preflight: ${verdict.message}`);
  console.error('To bypass at your own risk: ABCA_SKIP_BOOTSTRAP_PREFLIGHT=1.');
  return 1;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  console.error(`bootstrap preflight: ${err instanceof Error ? err.message : String(err)}`);
  console.error('Aborting before deploy: the bootstrap state could not be determined (commonly: no AWS CLI on PATH, '
    + 'or expired credentials). Fix the error above and re-run, or bypass with ABCA_SKIP_BOOTSTRAP_PREFLIGHT=1.');
  process.exit(1);
}
