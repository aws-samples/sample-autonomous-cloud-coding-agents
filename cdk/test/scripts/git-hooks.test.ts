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
 * Test for the commands of the local git hooks in `.pre-commit-config.yaml`.
 *
 * The hooks start through a login shell (`bash -lc`). On macOS that shell puts
 * /usr/local/bin and /opt/homebrew/bin back in front of the directories mise had
 * added to PATH, and mise leaves them there: a hook then runs the node, gitleaks
 * or semgrep of the machine and not the version `mise.toml` pins. Which tool a
 * hook finds depends on the machine, so no test can show it everywhere. This one
 * holds the two things that prevent it: `MISE_ACTIVATE_AGGRESSIVE=1` in front of
 * every mise task, which makes mise put its tools first, and no `node` called
 * without mise.
 *
 * Same placement rationale as `check-constants-sync.test.ts`: `cdk/test/` is the
 * Jest tree that can reach the repository root.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const CONFIG = fs.readFileSync(path.resolve(__dirname, '../../../.pre-commit-config.yaml'), 'utf-8');

/** The command of every hook that starts through a login shell: what stands between the quotes. */
const COMMANDS = [...CONFIG.matchAll(/^ +entry: bash -lc '(.*)'/gm)].map((match) => match[1]);

/** Where a command starts its first mise task (`mise run <task>` or `mise //<package>:<task>`), or -1. */
const firstTask = (command: string): number => command.search(/\bmise (run |\/\/)/);

describe('git hooks that start through a login shell', () => {
  test('export MISE_ACTIVATE_AGGRESSIVE=1 before the mise task they run', () => {
    const withTask = COMMANDS.filter((command) => firstTask(command) >= 0);
    const exported = (command: string): number => command.indexOf('export MISE_ACTIVATE_AGGRESSIVE=1 && ');

    expect(withTask).not.toHaveLength(0);
    expect(withTask.filter((command) => exported(command) < 0 || exported(command) > firstTask(command))).toEqual([]);
  });

  test('call no `node` of their own, which would be the one of the machine', () => {
    expect(COMMANDS.filter((command) => /(^|&&|\|\||[;|]) *node /.test(command))).toEqual([]);
  });
});
