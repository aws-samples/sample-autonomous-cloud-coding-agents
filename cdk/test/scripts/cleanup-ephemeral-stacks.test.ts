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

// The forced detach of network interfaces and the exit code after a refused deletion are left untested on purpose.
// #72 records that the detach cannot release the interfaces AgentCore holds. Its replacement has yet to settle the exit code.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/cleanup-ephemeral-stacks.sh');

const ABCA = 'ABCA Development Stack (uksb-wt64nei4u6)';

interface FakeStack {
  readonly name: string;
  readonly created?: number | string;
  readonly description?: string | null;
  readonly status?: string;
  readonly listedAs?: string;
  readonly protected?: boolean;
  readonly deleteFails?: boolean;
}

const AWS = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.log'), args.join(' ') + '\\n');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
const command = args.slice(0, 2).join(' ');
const stack = fixture.stacks.find((candidate) => candidate.name === args[args.indexOf('--stack-name') + 1]);
const refuse = () => {
  process.stderr.write('An error occurred (AccessDenied) when calling ' + command + '\\n');
  process.exit(254);
};
if (command === fixture.failing) refuse();
switch (command) {
  case 'sts get-caller-identity':
    console.log('123456789012\\tarn:aws:iam::123456789012:user/operator');
    break;
  case 'cloudformation list-stacks':
    for (const listed of fixture.stacks) {
      if (args.includes(listed.listedAs)) console.log(listed.name + '\\t' + listed.created);
    }
    break;
  case 'cloudformation describe-stacks':
    console.log([stack.description ?? 'None', stack.protected ? 'True' : 'False', stack.status].join('\\t'));
    break;
  case 'cloudformation list-stack-resources':
    break;
  case 'cloudformation delete-stack':
    if (stack.deleteFails) refuse();
    break;
  default:
    process.stderr.write('fake aws: unexpected command: ' + args.join(' ') + '\\n');
    process.exit(99);
}
`;

interface Sweep {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: string[];
  readonly deleted: string[];
}

function sweep(stacks: FakeStack[], args: string[] = [], failing?: string): Sweep {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-cleanup-stacks-test-'));
  try {
    fs.writeFileSync(path.join(root, 'aws'), AWS, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'calls.log'), '');
    fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({
      failing,
      stacks: stacks.map(({ created = 49, description = ABCA, status = 'CREATE_COMPLETE', ...stack }) => ({
        description,
        status,
        listedAs: status,
        ...stack,
        created: typeof created === 'number' ? new Date(Date.now() - created * 3_600_000).toISOString() : created,
      })),
    }));
    const env = {
      ...process.env,
      PATH: [root, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
      MAX_AGE_HOURS: '',
      AWS_DEFAULT_REGION: '',
    };
    // First place on PATH does not settle what bash takes for `aws` under a noexec mount or a BASH_ENV file, and
    // `bash -c` can read other start-up files than `bash <file>`.
    const bash = (script: string, ...scriptArgs: string[]) =>
      spawnSync('bash', [script, ...scriptArgs], { encoding: 'utf-8', timeout: 20_000, env });
    fs.writeFileSync(path.join(root, 'which-aws.sh'), 'command -v aws\n');
    const aws = bash(path.join(root, 'which-aws.sh')).stdout.trim();
    if (aws !== path.join(root, 'aws')) {
      throw new Error(`aws resolves to '${aws}', not to the fake: the cleanup script was not started`);
    }
    const result = bash(SCRIPT, ...args);
    const calls = fs.readFileSync(path.join(root, 'calls.log'), 'utf-8').split('\n').filter(Boolean);
    const deleted = calls.flatMap((call) => /^cloudformation delete-stack .*--stack-name (\S+)/.exec(call)?.[1] ?? []);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, deleted };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('cleanup-ephemeral-stacks.sh', () => {
  jest.setTimeout(30_000);

  test('is tested with the description the CDK app gives the application stack', () => {
    expect(fs.readFileSync(path.resolve(__dirname, '../../src/main.ts'), 'utf-8')).toContain(`description: '${ABCA}'`);
  });

  test('is not started when bash resolves `aws` to anything but the fake', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-cleanup-stacks-test-'));
    try {
      // Without SHLVL, a `bash -c` started by node passes over the BASH_ENV file, which `bash <file>` reads.
      const called = path.join(dir, 'called');
      fs.writeFileSync(path.join(dir, 'env.sh'), `aws() { : > '${called}'; }\n`);
      jest.replaceProperty(process, 'env', { ...process.env, BASH_ENV: path.join(dir, 'env.sh'), SHLVL: undefined });

      expect(() => sweep([{ name: 'old' }])).toThrow("aws resolves to 'aws', not to the fake");
      expect(fs.existsSync(called)).toBe(false);
    } finally {
      jest.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deletes the ABCA stacks older than the default max age, with or without the solution id in the description', () => {
    const result = sweep([{ name: 'old' }, { name: 'old-plain', description: 'ABCA Development Stack' }]);

    expect(result.status).toBe(0);
    expect(result.deleted).toEqual(['old', 'old-plain']);
    expect(result.stdout).toMatch(/Account:\s+123456789012/);
    expect(result.stdout).toMatch(/Deleted:\s+2\b/);
  });

  test('considers only the stacks that are complete, rolled back or failed to delete', () => {
    const listing = sweep([]).calls.find((call) => call.startsWith('cloudformation list-stacks'));

    expect(listing).toMatch(
      / --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE UPDATE_ROLLBACK_COMPLETE DELETE_FAILED( --|$)/);
  });

  test.each<[string, FakeStack, string]>([
    ['with termination protection', { name: 'kept', protected: true }, 'SKIP (protected): kept'],
    ['an hour younger than the default max age', { name: 'kept', created: 47 }, 'SKIP (too young: 47h): kept'],
    ['whose creation time cannot be read', { name: 'kept', created: 'not-a-date' }, "SKIP (unparseable creation time 'not-a-date'): kept"],
    ['that started an update after it was listed', { name: 'kept', listedAs: 'UPDATE_COMPLETE', status: 'UPDATE_IN_PROGRESS' },
      'SKIP (in progress): kept (UPDATE_IN_PROGRESS)'],
    ['that is being deleted again already', { name: 'kept', listedAs: 'DELETE_FAILED', status: 'DELETE_IN_PROGRESS' },
      'SKIP (in progress): kept (DELETE_IN_PROGRESS)'],
  ])('leaves a stack %s alone and says why', (_case, kept, reason) => {
    const result = sweep([kept, { name: 'old' }]);

    expect(result.status).toBe(0);
    expect(result.deleted).toEqual(['old']);
    expect(result.stdout).toContain(reason);
    expect(result.stdout).toMatch(/Skipped:\s+1\b/);
    expect(result.calls.filter((call) => call.split(' ').includes('kept'))).toHaveLength(1);
  });

  test.each<[string, FakeStack]>([
    ['of another application', { name: 'foreign', description: 'Another product' }],
    ['that holds the network of the same application', { name: 'foreign', description: 'ABCA network infrastructure (uksb-wt64nei4u6)' }],
    ['without a description', { name: 'foreign', description: null }],
  ])('leaves a stack %s alone', (_case, foreign) => {
    const result = sweep([foreign, { name: 'old' }]);

    expect(result.status).toBe(0);
    expect(result.deleted).toEqual(['old']);
    expect(result.calls.filter((call) => call.split(' ').includes('foreign'))).toHaveLength(1);
  });

  test('deletes again a stack whose earlier deletion failed', () => {
    expect(sweep([{ name: 'stuck', status: 'DELETE_FAILED' }]).deleted).toEqual(['stuck']);
  });

  test('--dry-run names the stack it would delete and changes nothing', () => {
    const result = sweep([{ name: 'old' }], ['--dry-run']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[dry-run] Would delete old');
    expect(result.calls.map((call) => call.split(' ', 2).join(' '))).toEqual(
      ['sts get-caller-identity', 'cloudformation list-stacks', 'cloudformation describe-stacks']);
  });

  test('--prefix limits the sweep to the stack names that start with it', () => {
    expect(sweep([{ name: 'not-pr-1' }, { name: 'pr-1' }], ['--prefix', 'pr-']).deleted).toEqual(['pr-1']);
  });

  test('--max-age-hours replaces the default max age', () => {
    const result = sweep([{ name: 'kept', created: 1 }, { name: 'old', created: 3 }], ['--max-age-hours', '2']);

    expect(result.status).toBe(0);
    expect(result.deleted).toEqual(['old']);
    expect(result.stdout).toContain('SKIP (too young: 1h): kept');
  });

  test('--region names the region of every call, the deletion included', () => {
    const result = sweep([{ name: 'old' }], ['--region', 'eu-west-1']);

    expect(result.deleted).toEqual(['old']);
    expect(result.calls.filter((call) => !/ --region eu-west-1( |$)/.test(call))).toEqual([]);
  });

  test('goes on after a deletion that CloudFormation refuses, and shows the error', () => {
    const result = sweep([{ name: 'refused', deleteFails: true }, { name: 'old' }]);

    expect(result.deleted).toEqual(['refused', 'old']);
    expect(result.stderr).toContain('AccessDenied');
    expect(result.stdout).toMatch(/Deleted:\s+1\b/);
    expect(result.stdout).toMatch(/Failed:\s+1\b/);
  });

  test('fails when the stacks cannot be listed, and does not report that there are none', () => {
    const result = sweep([{ name: 'old' }], [], 'cloudformation list-stacks');

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('No stacks found');
    expect(result.deleted).toEqual([]);
  });

  test('stops before it reads any stack when the caller identity cannot be resolved', () => {
    const result = sweep([{ name: 'old' }], [], 'sts get-caller-identity');

    expect(result.status).toBe(1);
    expect(result.calls).toHaveLength(1);
  });

  test('rejects an option it does not know before it calls AWS', () => {
    const result = sweep([{ name: 'old' }], ['--dryrun']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown option: --dryrun');
    expect(result.calls).toEqual([]);
  });

  test.each(['abc', '-1'])('rejects --max-age-hours %s before it calls AWS', (hours) => {
    const result = sweep([{ name: 'old' }], ['--max-age-hours', hours]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--max-age-hours must be a non-negative integer');
    expect(result.calls).toEqual([]);
  });
});
