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

// Yarn 1 ignores an option it does not know without saying so. With `--immutable`, the flag of Yarn Berry, it rewrites
// `yarn.lock` as a plain install does. `--frozen-lockfile` is the flag it reads.

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const WORKFLOWS = '.github/workflows';
const BUILD = `${WORKFLOWS}/build.yml`;

interface Install {
  readonly file: string;
  readonly command: string;
}

const installs = (file: string): Install[] => fs.readFileSync(path.join(ROOT, file), 'utf-8').split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .flatMap((line) => {
    const at = line.search(/\byarn\s+install\b/);
    return at < 0 ? [] : [{ file, command: line.slice(at) }];
  });

const WORKFLOW_FILES = fs.readdirSync(path.join(ROOT, WORKFLOWS))
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => `${WORKFLOWS}/${name}`);

const WORKFLOW_INSTALLS = WORKFLOW_FILES.flatMap(installs);

const MISE_INSTALLS = ['mise.toml', 'cdk/mise.toml', 'cli/mise.toml', 'docs/mise.toml', 'web/mise.toml'].flatMap(installs);

describe('workflow steps that run `yarn install` themselves', () => {
  test('pass --frozen-lockfile, the flag Yarn 1 reads, and nothing else', () => {
    expect(WORKFLOW_FILES).toContain(BUILD);
    expect(WORKFLOW_INSTALLS.filter(({ command }) => command !== 'yarn install --frozen-lockfile')).toEqual([]);
  });
});

describe('the installs of the mise tasks, which the build checks for lockfile drift', () => {
  // With each of these three flags Yarn 1 leaves yarn.lock as it is.
  // `--frozen-lockfile` lets a changed `resolutions` entry or workspace manifest pass.
  test('may rewrite yarn.lock', () => {
    expect(MISE_INSTALLS).not.toHaveLength(0);
    expect(MISE_INSTALLS.filter(({ command }) => /--(frozen|pure|no)-lockfile\b/.test(command))).toEqual([]);
  });
});

describe('the build, whose step "Fail on lockfile drift" looks for a yarn.lock that the install rewrote', () => {
  test('installs once, with the mise task and before that step, not with a yarn call of its own', () => {
    const order = ['mise run install', '- name: Fail on lockfile drift'];
    const lines = fs.readFileSync(path.join(ROOT, BUILD), 'utf-8').split('\n').map((line) => line.trim());

    expect(lines.filter((line) => order.includes(line))).toEqual(order);
    expect(WORKFLOW_INSTALLS.filter(({ file }) => file === BUILD)).toEqual([]);
  });
});
