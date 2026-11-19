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

/** A throwaway cli/ with lib/build-info.json and package.json; returns the two paths. */
function cliDir(contents: { packageJson?: string; buildInfo?: string }): { buildInfo: string; packageJson: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-version-'));
  fs.mkdirSync(path.join(root, 'lib'));
  const files = { buildInfo: path.join(root, 'lib', 'build-info.json'), packageJson: path.join(root, 'package.json') };
  if (contents.packageJson !== undefined) fs.writeFileSync(files.packageJson, contents.packageJson);
  if (contents.buildInfo !== undefined) fs.writeFileSync(files.buildInfo, contents.buildInfo);
  return files;
}

describe('cliVersion (#913)', () => {
  test('prints the version and the commit the compile recorded', () => {
    const files = cliDir({ buildInfo: '{"version":"1.2.3","commit":"abc123def456-dirty"}' });
    expect(cliVersion(files)).toBe('1.2.3 (abc123def456-dirty)');
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

  test('by default reads the CLI package.json beside the compiled directory', () => {
    // Under ts-jest the module runs from src/, whose sibling is the same package.json as lib/'s.
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    expect(cliVersion().startsWith(version)).toBe(true);
  });
});
