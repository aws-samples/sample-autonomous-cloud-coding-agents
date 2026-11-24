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

// mise stops a task at the first command that exits non-zero, so the exit code of `preflight-bootstrap.ts` alone decides
// whether `cdk deploy` starts (#126, #127). `test/bootstrap/preflight.test.ts` covers how a verdict is reached.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CDK = path.resolve(__dirname, '../..');
const SCRIPT = path.join(CDK, 'scripts/preflight-bootstrap.ts');
/** The task runs the script with `npx tsx`: its imports need more than type stripping. */
const TSX = require.resolve('tsx/cli');

const VERSION = fs.readFileSync(path.join(CDK, 'bootstrap/BOOTSTRAP_VERSION'), 'utf-8').trim();
const HASH = fs.readFileSync(path.join(CDK, 'bootstrap/BOOTSTRAP_HASH'), 'utf-8').trim();

type Toolkit = { outputs: object[] } | { error: string };

const bundle = (version: string, hash: string): Toolkit => ({
  outputs: [
    { OutputKey: 'BootstrapVersion', OutputValue: '33' },
    { OutputKey: 'BootstrapPolicyVersion', OutputValue: version },
    { OutputKey: 'BootstrapPolicyHash', OutputValue: hash },
    { OutputKey: 'BootstrapPolicySet', OutputValue: 'Infrastructure,Application,Observability,Compute-Agentcore' },
  ],
});

const CURRENT = bundle(VERSION, HASH);
const OLDER = bundle('1.0.0', HASH);
/** CloudFormation's answer for a stack that does not exist, as AWS CLI v1 writes it. v2 puts `aws: [ERROR]: ` in front of the line. */
const missing = (stack: string): string =>
  `\nAn error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stack} does not exist\n`;
const NOT_BOOTSTRAPPED: Toolkit = { error: missing('CDKToolkit').replace('An error', 'aws: [ERROR]: An error') };
const DENIED: Toolkit = { error: 'An error occurred (AccessDenied): not authorized' };

interface Invocation {
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly cdkJson?: object;
}

// The working directory is a new one, not `cdk/`. The script reads `cdk.json` there for the compute backends of the app,
// and the file of the checkout is the developer's to edit.
function preflight(toolkit: Toolkit, { args = [], env = {}, cdkJson }: Invocation = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-bootstrap-'));
  try {
    const calls = path.join(cwd, 'calls.log');
    fs.writeFileSync(calls, '');
    if (cdkJson) {
      fs.writeFileSync(path.join(cwd, 'cdk.json'), JSON.stringify(cdkJson));
    }
    fs.writeFileSync(path.join(cwd, 'aws'), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
const toolkit = ${JSON.stringify(toolkit)};
if (toolkit.error) {
  process.stderr.write(toolkit.error);
  process.exit(254);
}
process.stdout.write(JSON.stringify(toolkit.outputs));
`, { mode: 0o755 });
    const { error, status, stdout, stderr } = spawnSync(process.execPath, [TSX, SCRIPT, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      // The script runs without the bypass, as in a deploy: an undefined value takes the one
      // that this process inherited out of the environment.
      env: { ...process.env, PATH: `${cwd}${path.delimiter}${process.env.PATH}`, ABCA_SKIP_BOOTSTRAP_PREFLIGHT: undefined, ...env },
    });
    if (error) throw error;
    return { status, stdout, stderr, calls: fs.readFileSync(calls, 'utf-8').split('\n').filter(Boolean) };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe('preflight-bootstrap', () => {
  // Each test starts tsx, which loads the policy modules and aws-cdk-lib with them.
  jest.setTimeout(60_000);

  test('lets the deploy start on the bundle this checkout needs, after one read of CDKToolkit', () => {
    const run = preflight(CURRENT, { args: ['--profile', 'ops', '--region=eu-west-1'] });

    expect(run).toMatchObject({ status: 0, stdout: expect.stringContaining('PASS') });
    expect(run.calls).toEqual([
      '--profile ops --region eu-west-1 cloudformation describe-stacks --stack-name CDKToolkit --query Stacks[0].Outputs --output json',
    ]);
  });

  test('warns, and lets the deploy start, when only the hash of the policies differs', () => {
    expect(preflight(bundle(VERSION, 'f'.repeat(64)))).toMatchObject({ status: 0, stdout: expect.stringContaining('WARN') });
  });

  test.each<[string, Toolkit, RegExp]>([
    ['an older bundle', OLDER, /1\.0\.0.*mise \/\/cdk:bootstrap/],
    ['an account that is not bootstrapped', NOT_BOOTSTRAPPED, /not bootstrapped/],
    ['a state it cannot read', DENIED, /could not be determined/],
  ])('stops the deploy on %s, and names the bypass', (_case, toolkit, message) => {
    const run = preflight(toolkit);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(message);
    expect(run.stderr).toContain('ABCA_SKIP_BOOTSTRAP_PREFLIGHT=1');
  });

  // The AWS CLI raises these before it sends a request. They contain "does not exist", as
  // CloudFormation's answer for a missing stack does.
  test.each<[string, string]>([
    ['a profile with no cached SSO token', 'Error loading SSO Token: Token for my-sso does not exist'],
    ['a profile that names a missing sso-session', 'The specified sso-session does not exist: "my-sso"'],
    ['a profile that names a missing source_profile', 'The source_profile "base" referenced in the profile "dev" does not exist.'],
  ])('reports %s as a state it cannot read, not as an account that is not bootstrapped', (_case, error) => {
    const run = preflight({ error });

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/could not be determined/);
    expect(run.stderr).toContain(error);
    expect(run.stderr).not.toMatch(/not bootstrapped|cdk:bootstrap/);
  });

  test('reports an account as not bootstrapped when the stack named with --toolkit-stack-name is missing', () => {
    const run = preflight({ error: missing('AbcaToolkit') }, { args: ['--toolkit-stack-name', 'AbcaToolkit'] });

    expect(run).toMatchObject({ status: 1, stderr: expect.stringContaining('not bootstrapped') });
    expect(run.calls).toEqual([expect.stringContaining('--stack-name AbcaToolkit')]);
  });

  // AWS CLI v2 with `cli_error_format = yaml` breaks the message line at column 80. Where it breaks depends on the
  // length of the stack id: 49 characters are enough for the first break.
  test.each<[string, number, string]>([
    ['in front of "exist"', 50, ' does not\n  exist\n'],
    ['in front of "not"', 54, ' does\n  not exist\n'],
    ['behind the stack id', 60, '\n  does not exist\n'],
  ])('reports an account as not bootstrapped when the AWS CLI prints the answer as YAML, broken %s', (_where, length, rest) => {
    const stack = `Abca${'x'.repeat(length - 4)}`;
    const run = preflight(
      { error: `Code: ValidationError\nMessage: Stack with id ${stack}${rest}` },
      { args: ['--toolkit-stack-name', stack] },
    );

    expect(run).toMatchObject({ status: 1, stderr: expect.stringContaining('not bootstrapped') });
  });

  test.each<[string, Invocation]>([
    ['-c', { args: ['-c', 'compute_types=agentcore,ecs'] }],
    ['--context', { args: ['--context', 'compute_types=agentcore,ecs'] }],
    ['--context=', { args: ['--context=compute_types=agentcore,ecs'] }],
    ['cdk.json', { cdkJson: { context: { compute_types: ['agentcore', 'ecs'] } } }],
    ['the legacy compute_type', { args: ['-c', 'compute_type=ecs'] }],
  ])('stops the deploy on a bootstrap without the policy of a compute backend selected with %s', (_form, invocation) => {
    const run = preflight(CURRENT, invocation);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Compute-ECS/);
  });

  // As in CDK, an argument wins over `cdk.json`, and of two arguments the later one. In
  // another order the verdict is for backends that the deploy does not use.
  test('takes the compute backends from the last context argument, over an earlier one and over cdk.json', () => {
    const run = preflight(CURRENT, {
      args: ['-c', 'compute_types=agentcore,ecs', '-c', 'compute_types=agentcore'],
      cdkJson: { context: { compute_types: ['agentcore', 'ecs'] } },
    });

    expect(run).toMatchObject({ status: 0, stdout: expect.stringContaining('PASS') });
  });

  test.each<[string, Toolkit, string]>([
    ['a verdict', OLDER, '1.0.0'],
    ['a state it cannot read', DENIED, 'could not be determined'],
  ])('--json prints %s as JSON and keeps the exit code', (_case, toolkit, message) => {
    const run = preflight(toolkit, { args: ['--json'] });

    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({ status: 'FAIL', message: expect.stringContaining(message) });
  });

  test('ABCA_SKIP_BOOTSTRAP_PREFLIGHT=1 lets the deploy start without a call to AWS', () => {
    expect(preflight(OLDER, { env: { ABCA_SKIP_BOOTSTRAP_PREFLIGHT: '1' } })).toMatchObject({ status: 0, calls: [] });
  });

  test('ABCA_SKIP_BOOTSTRAP_PREFLIGHT=0 leaves the check on', () => {
    const run = preflight(OLDER, { env: { ABCA_SKIP_BOOTSTRAP_PREFLIGHT: '0' } });

    expect(run).toMatchObject({ status: 1, calls: [expect.stringContaining('describe-stacks')] });
  });
});
