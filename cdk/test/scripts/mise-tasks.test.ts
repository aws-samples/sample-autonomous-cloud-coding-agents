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
 * Tests for tasks of the root `mise.toml` whose commands are written in the file
 * itself, so that no script with a suite of its own stands behind them.
 *
 * Same placement rationale as `check-constants-sync.test.ts`: `cdk/test/` is the
 * Jest tree that can reach the repository root.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LINES = fs.readFileSync(path.resolve(__dirname, '../../../mise.toml'), 'utf-8').split('\n');

/** The lines of one task table, without its comments. */
function task(name: string): string[] {
  const start = LINES.findIndex((line) => line === `[tasks.${name}]` || line === `[tasks."${name}"]`);
  if (start < 0) {
    throw new Error(`mise.toml has no task ${name}`);
  }
  const body = LINES.slice(start + 1);
  const end = body.findIndex((line) => line.startsWith('['));
  return body.slice(0, end < 0 ? undefined : end).filter((line) => line !== '' && !line.startsWith('#'));
}

describe('the SAST scans with the rule packs of the semgrep registry', () => {
  const TASKS = ['security:sast', 'security:sast:range'];

  const scan = (name: string): string => task(name).find((line) => line.includes('semgrep scan ')) ?? '';

  test('ask for the same rule packs', () => {
    const [whole, range] = TASKS.map((name) => [...scan(name).matchAll(/--config (\S+)/g)].map((match) => match[1]));

    expect(whole).toContain('auto');
    expect(range).toEqual(whole);
  });

  // semgrep downloads the packs from semgrep.dev on every run. When the registry answers with
  // empty packs, semgrep checks nothing and exits 0: the command after the scan reads the
  // report semgrep wrote and has to fail unless it lists a loaded rule. --quiet would keep
  // what semgrep says about the registry out of the log.
  test.each(TASKS)('%s fails when semgrep loaded no rule, and does not silence semgrep', (name) => {
    const commands = task(name);
    const [, report] = /--sarif-output=(\S+)/.exec(scan(name)) ?? [];
    const [, guard] = /^\s*'''(node -e '.*') ''',$/.exec(commands[commands.indexOf(scan(name)) + 1]) ?? [];
    if (report === undefined || guard === undefined) {
      throw new Error(`${name}: no report, or no command after the scan that reads it`);
    }

    const run = (rules: unknown[]) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-sast-rules-'));
      try {
        fs.mkdirSync(path.join(cwd, path.dirname(report)), { recursive: true });
        fs.writeFileSync(path.join(cwd, report), JSON.stringify({ runs: [{ tool: { driver: { rules } } }] }));
        // The command names `node`: the one that runs this suite.
        const PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`;
        return spawnSync('sh', ['-c', guard], { cwd, encoding: 'utf-8', env: { ...process.env, PATH } });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    };

    const nothingLoaded = run([]);
    expect(nothingLoaded.stderr).toContain(`${name}: semgrep loaded 0 rules`);
    expect(nothingLoaded.status).toBe(1);
    expect(run([{ id: 'a-rule' }]).status).toBe(0);
    expect(scan(name)).not.toContain('--quiet');
  });
});

describe('the default task, which `mise run` without a task name runs', () => {
  // mise starts the entries of `depends` together, and `build` does not depend on `install`:
  // as dependencies, the build began on a checkout whose packages were still being installed.
  // The entries of a `run` list run one after the other.
  test('installs, then builds', () => {
    expect(task('default').filter((line) => /^(depends|run) /.test(line))).toEqual([
      'run = [{ task = "install" }, { task = "build" }]',
    ]);
  });
});

describe('the git hooks step of the install task', () => {
  const [, hooks] = task('install').map((line) => /^\s*'''(bash -c '.*') ''',$/.exec(line)).find(Boolean) ?? [];
  if (hooks === undefined) {
    throw new Error('install: no git hooks step');
  }

  type Git = (...args: string[]) => void;
  type Setup = (git: Git, repo: string, outside: string) => NodeJS.ProcessEnv | void;

  const run = (setup: Setup, prekStatus = 0, from = 'repo') => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abca-install-hooks-')));
    try {
      const [repo, outside, bin] = ['repo', 'outside', 'bin'].map((name) => path.join(root, name));
      [repo, outside, bin].forEach((dir) => fs.mkdirSync(dir));
      fs.symlinkSync(repo, path.join(root, 'link'));
      fs.writeFileSync(path.join(bin, 'prek'), `#!/bin/sh\ntouch "${root}/called"\nexit ${prekStatus}\n`, { mode: 0o755 });

      const env: NodeJS.ProcessEnv = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        GIT_CONFIG_GLOBAL: path.join(root, 'global'),
        GIT_CONFIG_SYSTEM: path.join(root, 'system'),
      };
      const git: Git = (...args) => expect(spawnSync('git', args, { cwd: repo, env }).status).toBe(0);
      git('init', '-q');
      Object.assign(env, setup(git, repo, outside));

      const result = spawnSync('sh', ['-c', hooks], { cwd: path.join(root, from), env, encoding: 'utf-8' });
      return { status: result.status, stderr: result.stderr, called: fs.existsSync(path.join(root, 'called')) };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  test.each<[string, Setup]>([
    ['unset', () => undefined],
    ['local, relative', (git) => git('config', '--local', 'core.hooksPath', '.githooks')],
    ['local, absolute inside the repository', (git, repo) => git('config', '--local', 'core.hooksPath', path.join(repo, '.githooks'))],
    ['local, absolute outside the repository', (git, _, outside) => git('config', '--local', 'core.hooksPath', outside)],
    ['global, overridden by local', (git, _, outside) => {
      git('config', '--global', 'core.hooksPath', outside);
      git('config', '--local', 'core.hooksPath', '.githooks');
    }],
  ])('installs the hooks when core.hooksPath is %s', (_, setup) => {
    const result = run(setup);

    expect(result).toMatchObject({ status: 0, called: true });
    expect(result.stderr).not.toContain('git hooks not installed');
  });

  test.each<[string, Setup]>([
    ['global, absolute outside the repository', (git, _, outside) => git('config', '--global', 'core.hooksPath', outside)],
    ['global, relative', (git) => git('config', '--global', 'core.hooksPath', '.githooks')],
    ['global, absolute inside the repository', (git, repo) => git('config', '--global', 'core.hooksPath', path.join(repo, '.githooks'))],
    ['global, empty', (git) => git('config', '--global', 'core.hooksPath', '')],
    ['system', (git, _, outside) => git('config', '--system', 'core.hooksPath', outside)],
    ['on the command line', (_, __, outside) => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: outside })],
  ])('skips the hooks with a warning and succeeds when core.hooksPath is %s', (_, setup) => {
    const result = run(setup);

    expect(result).toMatchObject({ status: 0, called: false });
    expect(result.stderr).toContain('git hooks not installed');
  });

  test('decides by config scope, not by path, when the repository is reached through a symlink', () => {
    expect(run((git, _, outside) => git('config', '--global', 'core.hooksPath', outside), 0, 'link')).toMatchObject({ called: false });
    expect(run((git, _, outside) => git('config', '--local', 'core.hooksPath', outside), 0, 'link')).toMatchObject({ called: true });
  });

  test('fails when prek fails for any other reason', () => {
    expect(run(() => undefined, 3)).toMatchObject({ status: 3, called: true });
  });

  test('does nothing outside a git checkout', () => {
    expect(run((_, repo) => fs.rmSync(path.join(repo, '.git'), { recursive: true }))).toMatchObject({ status: 0, called: false, stderr: '' });
  });
});
