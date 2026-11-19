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
import { cliVersion } from '../src/version';

/** A throwaway cli/ with lib/ and package.json; returns the lib directory. */
function cliDir(files: { packageJson?: string; buildInfo?: string }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-version-'));
  fs.mkdirSync(path.join(root, 'lib'));
  if (files.packageJson !== undefined) fs.writeFileSync(path.join(root, 'package.json'), files.packageJson);
  if (files.buildInfo !== undefined) fs.writeFileSync(path.join(root, 'lib', 'build-info.json'), files.buildInfo);
  return path.join(root, 'lib');
}

describe('cliVersion (#913)', () => {
  test('prints the version and the commit the compile recorded', () => {
    const lib = cliDir({ buildInfo: '{"version":"1.2.3","commit":"abc123def456-dirty"}' });
    expect(cliVersion(lib)).toBe('1.2.3 (abc123def456-dirty)');
  });

  test('prints the version alone when the build was not in a git checkout', () => {
    expect(cliVersion(cliDir({ buildInfo: '{"version":"1.2.3"}' }))).toBe('1.2.3');
  });

  test('reads package.json when the compile recorded nothing, instead of a hard-coded copy', () => {
    expect(cliVersion(cliDir({ packageJson: '{"version":"4.5.6"}' }))).toBe('4.5.6');
  });

  test('reports an unreadable build-info.json instead of hiding it, without throwing', () => {
    // It runs at start-up: a throw would stop every command.
    expect(cliVersion(cliDir({ packageJson: '{"version":"4.5.6"}', buildInfo: 'not json' })))
      .toBe('4.5.6 (build info unreadable)');
  });

  test('says unknown rather than inventing a version', () => {
    expect(cliVersion(cliDir({}))).toBe('unknown');
  });

  test('matches the CLI package.json version', () => {
    // From src/, like the compiled lib/: package.json is the sibling of the directory.
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    expect(cliVersion(path.join(__dirname, '..', 'src')).startsWith(version)).toBe(true);
  });
});
