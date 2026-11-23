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

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cliVersion } from '../src/version';

/**
 * Tests for `cli/scripts/write-build-info.mjs`, which the compile script runs (#913):
 * the script is copied into a throwaway repository with a `cli/` like this one and run
 * there, so the commit it records is one the test made.
 */

const SCRIPT = path.join(__dirname, '..', 'scripts', 'write-build-info.mjs');
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

let root: string;
let cliDir: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-build-info-')));
  cliDir = path.join(root, 'cli');
  fs.mkdirSync(path.join(cliDir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(cliDir, 'scripts', 'write-build-info.mjs'));
  fs.writeFileSync(path.join(cliDir, 'package.json'), '{"version":"1.2.3"}\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'outside cli/\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf-8', env: GIT_ENV }).trim();

function commit(): string {
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return git('rev-parse', '--short=12', 'HEAD');
}

function writeBuildInfo(): { info: { version?: string; commit?: string }; out: string } {
  const r = spawnSync(process.execPath, [path.join(cliDir, 'scripts', 'write-build-info.mjs')], {
    encoding: 'utf-8',
    timeout: 20_000,
    env: GIT_ENV,
  });
  expect(r.status).toBe(0);
  const info = JSON.parse(fs.readFileSync(path.join(cliDir, 'lib', 'build-info.json'), 'utf-8'));
  return { info, out: `${r.stdout}${r.stderr}` };
}

describe('write-build-info.mjs (#913)', () => {
  test('records the version and the 12-character commit, and cliVersion reads it back', () => {
    const sha = commit();

    const { info } = writeBuildInfo();
    expect(info).toEqual({ version: '1.2.3', commit: sha });
    // The location version.ts reads, beside the compiled lib/.
    expect(
      cliVersion({ buildInfo: path.join(cliDir, 'lib', 'build-info.json'), packageJson: path.join(cliDir, 'package.json') }),
    ).toBe(`1.2.3 (${sha})`);
  });

  test('a tag never replaces the commit', () => {
    const sha = commit();
    git('tag', '-a', 'v2.0', '-m', 'release');

    expect(writeBuildInfo().info.commit).toBe(sha);
  });

  test('marks uncommitted changes under cli/ dirty, not changes elsewhere', () => {
    const sha = commit();
    fs.writeFileSync(path.join(root, 'README.md'), 'edited outside cli/\n');
    expect(writeBuildInfo().info.commit).toBe(sha);

    fs.writeFileSync(path.join(cliDir, 'package.json'), '{"version":"1.2.3","x":1}\n');
    expect(writeBuildInfo().info.commit).toBe(`${sha}-dirty`);
  });

  test('outside a git checkout, records the version alone and says why', () => {
    const { info, out } = writeBuildInfo();

    expect(info).toEqual({ version: '1.2.3' });
    expect(out).toContain('write-build-info: no commit recorded');
  });
});
