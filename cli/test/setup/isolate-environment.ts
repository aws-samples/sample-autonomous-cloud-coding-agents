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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Jest globalSetup: give the whole test run an empty home directory and no
 * AWS or bgagent environment.
 *
 * Command tests drive the real commands, and whatever a test does not mock
 * runs for real. Such code reads ``~/.bgagent`` (stack name, region, API URL,
 * the cached Cognito tokens) and ``~/.cdk.json``, and lets the AWS SDK resolve
 * whatever credentials the shell offers. On a configured machine the suite
 * therefore sent signed CloudFormation requests to the developer's account and
 * failed or passed depending on what that stack had deployed; on a CI runner,
 * which has neither, it did not.
 *
 * This runs once in the jest parent process, before any worker starts, so the
 * change reaches the real environment that ``os.homedir()`` and the AWS SDK
 * read. A ``setupFiles`` module cannot do that: inside a test file
 * ``process.env`` is jest's copy, and ``os.homedir()`` does not look at it.
 *
 * A test that needs configuration creates its own directory and points
 * ``BGAGENT_CONFIG_DIR`` at it (see ``test/config.test.ts``).
 */
export default function isolateEnvironment(): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-cli-test-home-'));
  process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));

  for (const name of Object.keys(process.env)) {
    if (/^(AWS|BGAGENT)_/.test(name)) delete process.env[name];
  }
  process.env.HOME = home; // os.homedir() and the SDK's ~/.aws lookup
  process.env.USERPROFILE = home; // the same on Windows
  process.env.AWS_EC2_METADATA_DISABLED = 'true'; // no credentials from an instance role either
}
