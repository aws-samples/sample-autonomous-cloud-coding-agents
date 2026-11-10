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

import * as os from 'os';
import * as path from 'path';
import { getConfigDir, loadCredentials, tryLoadConfig } from '../../src/config';

/**
 * What ``test/setup/isolate-environment.ts`` guarantees to every test file.
 *
 * If this fails, the ``jest.globalSetup`` entry in package.json no longer runs
 * that module (or the module stopped doing its job): tests read the
 * developer's ``~/.bgagent`` and AWS credentials again. Restore it; do not
 * adjust these expectations.
 */
describe('test environment isolation', () => {
  test('home is a scratch directory without bgagent configuration or a cached login', () => {
    expect(path.basename(os.homedir())).toMatch(/^bgagent-cli-test-home-/);
    expect(process.env.HOME).toBe(os.homedir());
    expect(getConfigDir()).toBe(path.join(os.homedir(), '.bgagent'));
    expect(tryLoadConfig()).toBeNull();
    expect(loadCredentials()).toBeNull();
  });

  test('no AWS or bgagent variable is inherited from the shell that started jest', () => {
    const inherited = Object.keys(process.env).filter(name => /^(AWS|BGAGENT)_/.test(name));
    expect(inherited).toEqual(['AWS_EC2_METADATA_DISABLED']);
  });
});
