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

// On macOS a login shell (`bash -lc`) puts /usr/local/bin and /opt/homebrew/bin back in front of the directories mise
// added to PATH, and mise leaves them there unless `MISE_ACTIVATE_AGGRESSIVE=1` is set.

import * as fs from 'node:fs';
import * as path from 'node:path';

const CONFIG = fs.readFileSync(path.resolve(__dirname, '../../../.pre-commit-config.yaml'), 'utf-8');

const COMMANDS = [...CONFIG.matchAll(/^ +entry: bash -lc '(.*)'/gm)].map((match) => match[1]);

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

const HOOKS = new Map(
  CONFIG.split(/^ {6}- id: /m).slice(1).map((hook) => [hook.slice(0, hook.indexOf('\n')), hook] as const),
);

describe('type-check hooks', () => {
  const packages = [...HOOKS.keys()].filter((id) => id.endsWith('-eslint')).map((id) => id.slice(0, -'-eslint'.length));
  const hook = (pkg: string): string => HOOKS.get(`${pkg}-typecheck`) ?? '';

  test('exist for every package that has an ESLint hook, and run its typecheck task', () => {
    const command = (pkg: string): string => /^ +entry: bash -lc '(.*)'$/m.exec(hook(pkg))?.[1] ?? '';

    expect(packages).not.toHaveLength(0);
    expect(packages.filter((pkg) => !command(pkg).endsWith(` && mise //${pkg}:typecheck`))).toEqual([]);
  });

  test('start at commit for a staged TypeScript file of their package and for no other file', () => {
    for (const pkg of packages) {
      const files = /^ +files: (.*)$/m.exec(hook(pkg))?.[1];
      const exclude = /^ +exclude: (.*)$/m.exec(hook(pkg))?.[1];
      const starts = (file: string): boolean =>
        files !== undefined && new RegExp(files).test(file) && (exclude === undefined || !new RegExp(exclude).test(file));

      expect([`${pkg}/src/a.ts`, `${pkg}/test/a.test.tsx`, `${pkg}/a.mts`, `${pkg}/a.cts`].filter((file) => !starts(file))).toEqual([]);
      expect([`${pkg}/src/a.js`, `${pkg}/eslint.config.mjs`, `${pkg}/package.json`, `docs/${pkg}/a.ts`].filter(starts)).toEqual([]);
      expect(hook(pkg)).toMatch(/^ +pass_filenames: false$/m);
      expect(hook(pkg)).toMatch(/^ +stages: \[pre-commit\]$/m);
    }
  });
});
