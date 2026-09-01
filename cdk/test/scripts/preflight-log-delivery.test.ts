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
 * Tests for `cdk/scripts/preflight-log-delivery.ts` — the one-time
 * log-delivery migration guard in the deploy path (#703).
 *
 * The script is a GATE with a delete side effect, so both failure directions
 * matter: a false "nothing to do" sends an unmigrated stack into the
 * mid-deploy AlreadyExists rollback the preflight exists to prevent, and an
 * over-broad match deletes delivery resources that are not the stack's. It
 * is exercised the way it really runs — spawned as a subprocess — with a fake
 * `aws` executable on PATH that replays canned CloudFormation/CloudWatch Logs
 * responses and records every invocation, so the assertions cover the real
 * argument construction, deletion ordering, and exit codes rather than a
 * re-implementation. (Same placement rationale as
 * `check-constants-sync.test.ts`: `cdk/test/` is the Jest tree that can reach
 * the script.)
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../scripts/preflight-log-delivery.ts');

/** Live-state fixtures, shaped like `aws cloudformation list-stack-resources`. */
const LIBRARY_IDS = {
  StackResourceSummaries: [
    {
      LogicalResourceId: 'RuntimeApplicationLogsDeliverySource818497BD',
      PhysicalResourceId: 'backgroundagent-dev-Runtime-APPLICATION_LOGS',
      ResourceType: 'AWS::Logs::DeliverySource',
      ResourceStatus: 'UPDATE_COMPLETE',
    },
    {
      LogicalResourceId: 'SomeUnrelatedFn',
      PhysicalResourceId: 'fn-phys',
      ResourceType: 'AWS::Lambda::Function',
      ResourceStatus: 'CREATE_COMPLETE',
    },
  ],
};

const PINNED_IDS = {
  StackResourceSummaries: [
    {
      LogicalResourceId:
        'RuntimeCDKSourceAPPLICATIONLOGSbackgroundagentdevRuntimeBC0AE9ED96A02E02',
      PhysicalResourceId: 'cdk-applicationlogs-source-backgroundagentdevRuntimeBC0AE9ED',
      ResourceType: 'AWS::Logs::DeliverySource',
      ResourceStatus: 'UPDATE_COMPLETE',
    },
    {
      LogicalResourceId:
        'RuntimeCdkLogGroupApplicationLogsDeliverybackgroundagentdevRuntimeBC0AE9EDbackgroundagentdevRuntimeApplicationLogGroup454A95E8DestapplicationlogsE09F77DC',
      PhysicalResourceId: 'cdk-cwl-Destapplication-logs-dest-backgrounp454A95E829BF8A27',
      ResourceType: 'AWS::Logs::DeliveryDestination',
      ResourceStatus: 'UPDATE_COMPLETE',
    },
    {
      LogicalResourceId:
        'RuntimeCdkLogGroupApplicationLogsDeliverybackgroundagentdevRuntimeBC0AE9EDbackgroundagentdevRuntimeApplicationLogGroup454A95E8Delivery92FE492C',
      PhysicalResourceId: 'AhrN8hFRPWjPQU2Sh',
      ResourceType: 'AWS::Logs::Delivery',
      ResourceStatus: 'UPDATE_COMPLETE',
    },
    // A delivery resource already on the library's naming must NOT be deleted
    // even while pinned siblings are being migrated.
    {
      LogicalResourceId: 'RuntimeUsageLogsDeliverySourceF66198FF',
      PhysicalResourceId: 'backgroundagent-dev-Runtime-USAGE_LOGS',
      ResourceType: 'AWS::Logs::DeliverySource',
      ResourceStatus: 'UPDATE_COMPLETE',
    },
  ],
};

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  /** Every `aws <args...>` invocation the script made, one line per call. */
  calls: string[];
}

/**
 * Run the preflight with a fake `aws` on PATH.
 *
 * The fake logs each invocation to CALLS_FILE, answers
 * `cloudformation list-stack-resources` with the given fixture (or a
 * "does not exist" error for the fresh-install case), succeeds on
 * `logs delete-*` — except names listed in `failDeletes`, which fail with
 * the given stderr once.
 */
function runPreflight(opts: {
  listResponse?: object;
  stackMissing?: boolean;
  listFails?: boolean;
  failDeletes?: Record<string, string>;
  args?: string[];
  env?: Record<string, string>;
}): RunResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-'));
  try {
    const callsFile = path.join(root, 'calls.log');
    fs.writeFileSync(callsFile, '');
    fs.writeFileSync(path.join(root, 'list-response.json'), JSON.stringify(opts.listResponse ?? {}));
    fs.writeFileSync(path.join(root, 'fail-deletes.json'), JSON.stringify(opts.failDeletes ?? {}));

    const fakeAws = path.join(root, 'aws');
    fs.writeFileSync(
      fakeAws,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.log'), args.join(' ') + '\\n');
if (args[0] === 'cloudformation' && args[1] === 'list-stack-resources') {
  if (${JSON.stringify(opts.stackMissing ?? false)}) {
    process.stderr.write('An error occurred (ValidationError): Stack with id x does not exist');
    process.exit(254);
  }
  if (${JSON.stringify(opts.listFails ?? false)}) {
    process.stderr.write('An error occurred (AccessDenied): not authorized');
    process.exit(254);
  }
  process.stdout.write(fs.readFileSync(path.join(root, 'list-response.json'), 'utf8'));
  process.exit(0);
}
if (args[0] === 'logs' && args[1].startsWith('delete-')) {
  const target = args[args.length - 1];
  const failures = JSON.parse(fs.readFileSync(path.join(root, 'fail-deletes.json'), 'utf8'));
  if (failures[target]) {
    process.stderr.write(failures[target]);
    process.exit(254);
  }
  process.exit(0);
}
process.stderr.write('fake aws: unexpected command: ' + args.join(' '));
process.exit(99);
`,
      { mode: 0o755 },
    );

    const env = {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH}`,
      ABCA_SKIP_LOG_DELIVERY_PREFLIGHT: '',
      ABCA_LOG_DELIVERY_PREFLIGHT: '',
      STACK_NAME: '',
      ...opts.env,
    };

    let status = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync(
        process.execPath,
        ['--experimental-strip-types', SCRIPT, ...(opts.args ?? [])],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? -1;
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
    }
    const calls = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean);
    return { status, stdout, stderr, calls };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const deleteCalls = (r: RunResult) => r.calls.filter((c) => c.startsWith('logs delete-'));

describe('preflight-log-delivery', () => {
  test('no-ops when the stack does not exist (fresh install)', () => {
    const r = runPreflight({ stackMissing: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not deployed yet');
    expect(deleteCalls(r)).toHaveLength(0);
  });

  test('no-ops when delivery resources already use library-managed ids', () => {
    const r = runPreflight({ listResponse: LIBRARY_IDS });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('already on library-managed ids');
    expect(deleteCalls(r)).toHaveLength(0);
  });

  test('deletes exactly the pinned resources, deliveries before sources/destinations', () => {
    const r = runPreflight({ listResponse: PINNED_IDS });
    expect(r.status).toBe(0);
    const deletes = deleteCalls(r);
    expect(deletes).toEqual([
      'logs delete-delivery --id AhrN8hFRPWjPQU2Sh',
      'logs delete-delivery-source --name cdk-applicationlogs-source-backgroundagentdevRuntimeBC0AE9ED',
      'logs delete-delivery-destination --name cdk-cwl-Destapplication-logs-dest-backgrounp454A95E829BF8A27',
    ]);
    // The sibling already on library naming was in the same stack and same
    // resource types — it must survive the migration.
    expect(deletes.join('\n')).not.toContain('backgroundagent-dev-Runtime-USAGE_LOGS');
    expect(r.stdout).toContain('migration applied');
  });

  test('--check-only reports the pinned resources, deletes nothing, exits 2', () => {
    const r = runPreflight({ listResponse: PINNED_IDS, args: ['--check-only'] });
    expect(r.status).toBe(2);
    expect(deleteCalls(r)).toHaveLength(0);
    expect(r.stdout).toContain('Check-only mode');
  });

  test('treats an already-deleted resource as success (idempotent re-run)', () => {
    const r = runPreflight({
      listResponse: PINNED_IDS,
      failDeletes: {
        AhrN8hFRPWjPQU2Sh:
          'An error occurred (ResourceNotFoundException): Delivery does not exist',
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('already gone');
    expect(r.stdout).toContain('migration applied');
  });

  test('aborts (exit 1) when a delete fails for any other reason', () => {
    const r = runPreflight({
      listResponse: PINNED_IDS,
      failDeletes: {
        AhrN8hFRPWjPQU2Sh: 'An error occurred (AccessDeniedException): not authorized',
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('AccessDeniedException');
    expect(r.stderr).toContain('Aborting before deploy');
  });

  test('aborts (exit 1) when the stack state cannot be determined', () => {
    const r = runPreflight({ listFails: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not list resources');
    expect(deleteCalls(r)).toHaveLength(0);
  });

  test('honors --stack-name and STACK_NAME for non-default stacks', () => {
    const viaFlag = runPreflight({
      listResponse: LIBRARY_IDS,
      args: ['--stack-name', 'my-custom-stack'],
    });
    expect(viaFlag.calls[0]).toContain('--stack-name my-custom-stack');

    const viaEnv = runPreflight({ listResponse: LIBRARY_IDS, env: { STACK_NAME: 'env-stack' } });
    expect(viaEnv.calls[0]).toContain('--stack-name env-stack');
  });

  test('accepts CDK context form, so a direct invocation cannot target a different stack', () => {
    // `cdk deploy` selects its stack from `stackName` CONTEXT, not from --stack-name.
    // Reading only the flag/env let this script inspect one stack while the deploy it
    // gates built another — and this script deletes, so the two must not diverge.
    for (const args of [
      ['-c', 'stackName=ctx-stack'],
      ['--context', 'stackName=ctx-stack'],
      ['--context=stackName=ctx-stack'],
    ]) {
      const r = runPreflight({ listResponse: LIBRARY_IDS, args });
      expect(r.calls[0]).toContain('--stack-name ctx-stack');
    }
  });

  test('the flag wins over the env var, and both over context', () => {
    // Precedence pinned because the three can disagree on a real command line.
    const r = runPreflight({
      listResponse: LIBRARY_IDS,
      args: ['--stack-name', 'flag-stack', '-c', 'stackName=ctx-stack'],
      env: { STACK_NAME: 'env-stack' },
    });
    expect(r.calls[0]).toContain('--stack-name flag-stack');
  });

  test('names the stack AND where the name came from, so a mismatch is visible', () => {
    // The one gap that cannot be closed in-script: context passed to `cdk deploy` after
    // `--` never reaches a mise `depends` task. Printing the resolved target is what
    // turns that from an invisible divergence into something an operator can see in the
    // deploy log before anything is deleted.
    const r = runPreflight({ listResponse: LIBRARY_IDS, env: { STACK_NAME: 'env-stack' } });
    expect(r.stdout).toContain("inspecting stack 'env-stack' (from STACK_NAME)");

    const dflt = runPreflight({ listResponse: LIBRARY_IDS });
    expect(dflt.stdout).toContain("inspecting stack 'backgroundagent-dev' (from default)");
  });

  test('ABCA_SKIP_LOG_DELIVERY_PREFLIGHT=1 skips without touching AWS', () => {
    const r = runPreflight({
      listResponse: PINNED_IDS,
      env: { ABCA_SKIP_LOG_DELIVERY_PREFLIGHT: '1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('skipped');
    expect(r.calls).toHaveLength(0);
  });
});
