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
 * Test for the stack names of the integ smoke app, `test/integ/integ.task-api-smoke.ts`.
 *
 * integ-runner deploys two stacks per run: the stack under test and the stack
 * that holds the assertions. CI runs share one AWS account, and runs of
 * different pull requests can be in it at the same time, so both names have to
 * come from INTEG_STACK_NAME (`int-<sha>-<run>`, set by integ.yml): a stack
 * with one fixed name is deployed and destroyed by every run. The job sits
 * behind the `deploy` approval gate, so a shared name goes unseen until two
 * approved runs meet. This test synthesizes the app without AWS access, in a
 * child process as integ-runner does, and reads the names from the cloud
 * assembly.
 *
 * Next to `integ-workflow.test.ts`, the other check of what an approved run does.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CloudAssembly } from 'aws-cdk-lib/cx-api';

const CDK_ROOT = path.resolve(__dirname, '../..');
const INTEG_APP = path.join(CDK_ROOT, 'test/integ/integ.task-api-smoke.ts');
const SYNTH_TIMEOUT_MS = 120_000;

/** CloudFormation names of the stacks the app synthesizes, sorted. Without a name it is the local path. */
function stackNames(integStackName?: string): string[] {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-integ-names-'));
  try {
    const { INTEG_STACK_NAME: _inherited, ...env } = process.env;
    // `new App()` synthesizes into CDK_OUTDIR when the process exits. The child inherits
    // CDK_CONTEXT_JSON from the jest setup file, so it bundles no Lambda code.
    execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', INTEG_APP], {
      cwd: CDK_ROOT,
      env: { ...env, CDK_OUTDIR: outdir, ...(integStackName ? { INTEG_STACK_NAME: integStackName } : {}) },
      stdio: 'pipe',
      timeout: SYNTH_TIMEOUT_MS,
    });
    return new CloudAssembly(outdir).stacksRecursively.map((stack) => stack.stackName).sort();
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
}

describe('integ smoke app', () => {
  test('names every stack of a CI run from INTEG_STACK_NAME', () => {
    expect(stackNames('int-0a1b2c3d4e5f-42')).toEqual(['int-0a1b2c3d4e5f-42', 'int-0a1b2c3d4e5f-42-assert']);
  }, SYNTH_TIMEOUT_MS);

  test('keeps one stable name per stack on the local path', () => {
    expect(stackNames()).toEqual(['backgroundagent-integ-local', 'backgroundagent-integ-local-assert']);
  }, SYNTH_TIMEOUT_MS);
});
