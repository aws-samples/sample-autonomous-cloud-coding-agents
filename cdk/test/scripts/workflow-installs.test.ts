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
 * Test for the lockfile flags of the `yarn install` commands in workflows and mise tasks.
 *
 * Yarn 1 installs this repository, and it ignores an option it does not know: with
 * `--immutable`, the flag of Yarn Berry, it rewrites `yarn.lock` as a plain install
 * does. `--frozen-lockfile` is the flag it reads. `deploy.yml` and `integ.yml` call
 * yarn themselves. They start on `workflow_run`, which takes the workflow from the
 * default branch, so a pull request that changes such a step does not run it: a flag
 * that does nothing goes unseen.
 *
 * `--frozen-lockfile` fails on a dependency of the root `package.json` that `yarn.lock`
 * does not have. A changed `resolutions` entry or workspace manifest passes it: yarn
 * installs what the lockfile does not name and leaves the lockfile as it is. The step
 * "Fail on lockfile drift" of `build.yml` catches those two, because the install of
 * `mise run install` before it rewrites the lockfile. With the flag on that install
 * the step would find nothing: the mise installs do not carry it, and the build
 * installs with the mise task, not with a yarn call of its own.
 *
 * The suite reads text. An install is the words `yarn install` with the flags on their
 * line, in a workflow file or one of the five mise files, and in `build.yml` also the
 * line `mise run install`. Nothing else is read: not an install that is written
 * another way, and nothing in another file.
 *
 * Same placement rationale as `check-constants-sync.test.ts`: `cdk/test/` is the
 * Jest tree that can reach the repository root.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const WORKFLOWS = '.github/workflows';
const BUILD = `${WORKFLOWS}/build.yml`;

/** A `yarn install` in a file: the command from those words to the end of its line. */
interface Install {
  readonly file: string;
  readonly command: string;
}

/**
 * The installs of a file. A line that is a comment is not read; a comment on the line
 * of a command is part of the command.
 */
const installs = (file: string): Install[] => fs.readFileSync(path.join(ROOT, file), 'utf-8').split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .flatMap((line) => {
    const at = line.search(/\byarn\s+install\b/);
    return at < 0 ? [] : [{ file, command: line.slice(at) }];
  });

const WORKFLOW_INSTALLS = fs.readdirSync(path.join(ROOT, WORKFLOWS))
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .flatMap((name) => installs(`${WORKFLOWS}/${name}`));

const MISE_INSTALLS = ['mise.toml', 'cdk/mise.toml', 'cli/mise.toml', 'docs/mise.toml', 'web/mise.toml'].flatMap(installs);

describe('workflow steps that run `yarn install` themselves', () => {
  // Nothing else: Yarn 1 does not say that it ignores an option, so one that is meant
  // to be passed has to be allowed here first.
  test('pass --frozen-lockfile, the flag Yarn 1 reads, and nothing else', () => {
    expect(WORKFLOW_INSTALLS).not.toHaveLength(0);
    expect(WORKFLOW_INSTALLS.filter(({ command }) => command !== 'yarn install --frozen-lockfile')).toEqual([]);
  });
});

describe('the installs of the mise tasks, which the build checks for lockfile drift', () => {
  // With each of these three flags Yarn 1 leaves yarn.lock as it is.
  test('may rewrite yarn.lock', () => {
    expect(MISE_INSTALLS).not.toHaveLength(0);
    expect(MISE_INSTALLS.filter(({ command }) => /--(frozen|pure|no)-lockfile\b/.test(command))).toEqual([]);
  });
});

describe('the build, whose step "Fail on lockfile drift" looks for a yarn.lock that the install rewrote', () => {
  // A yarn call of its own would have to be frozen to pass the first test, and the step
  // after it would then find nothing. Only the root task with nothing after it will do:
  // mise appends what follows `--` to the last command of a task, and for the install
  // task of a package that command is its `yarn install`. Once, because a line does not
  // say which job a second install is in.
  test('installs once, with the mise task and before that step, not with a yarn call of its own', () => {
    const order = ['mise run install', '- name: Fail on lockfile drift'];
    const lines = fs.readFileSync(path.join(ROOT, BUILD), 'utf-8').split('\n').map((line) => line.trim());

    expect(lines.filter((line) => order.includes(line))).toEqual(order);
    expect(WORKFLOW_INSTALLS.filter(({ file }) => file === BUILD)).toEqual([]);
  });
});
