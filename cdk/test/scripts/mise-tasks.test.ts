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

describe('the secret scans with gitleaks', () => {
  /** The arguments a task gives gitleaks, with GITLEAKS_RANGE set to `range` or, without one, unset. */
  const gitleaksArguments = (name: string, range?: string): string[] => {
    const [, command] = /^run = ['"](gitleaks [^\\;&|<>]*)['"]$/.exec(task(name).find((line) => line.startsWith('run = ')) ?? '') ?? [];
    if (command === undefined) {
      throw new Error(`${name}: its command is not one gitleaks call`);
    }
    // The command runs as it is written. A shell function stands in for gitleaks and prints
    // its arguments, one per line. An undefined value takes a GITLEAKS_RANGE that this
    // process inherited out of the environment.
    const env = { ...process.env, GITLEAKS_RANGE: range };
    return spawnSync('sh', ['-c', `gitleaks() { printf '%s\\n' "$@"; }\n${command}`], { encoding: 'utf-8', env }).stdout.trimEnd().split('\n');
  };

  // An empty --log-opts is not "no range": gitleaks then walks every ref of the clone and fails
  // on what other branches hold. A workflow step whose range expression has no value passes
  // an empty variable, not an unset one.
  test.each([undefined, ''])('security:secrets:range scans the history of HEAD when GITLEAKS_RANGE is %p', (range) => {
    expect(gitleaksArguments('security:secrets:range', range)).toContain('--log-opts=HEAD');
  });

  test('security:secrets:range scans the range it is given', () => {
    expect(gitleaksArguments('security:secrets:range', 'origin/main..HEAD')).toContain('--log-opts=origin/main..HEAD');
  });

  // Rule file, redaction and output are the same in the three scans, so that the hook, the
  // pull request check and the sweep cannot disagree about a finding: only what they scan
  // differs. Without a range, the range scan is the sweep.
  test('give gitleaks the same arguments, apart from what to scan', () => {
    const sweep = gitleaksArguments('security:secrets');

    expect(gitleaksArguments('security:secrets:range')).toEqual(sweep);
    expect(gitleaksArguments('security:secrets:staged').filter((argument) => argument !== '--staged'))
      .toEqual(sweep.filter((argument) => !argument.startsWith('--log-opts=')));
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

describe('the shell script lint', () => {
  /**
   * The script of the task: the lines between `run = '''` and the closing `'''`. `task` ends a
   * table at a line that starts with `[`, so no line of the script may start with a `[ ... ]` test.
   */
  const script = (): string => {
    const lines = task('check:shell');
    const start = lines.indexOf("run = '''");
    const end = lines.indexOf("'''", start + 1);
    if (start < 0 || end < 0) {
      throw new Error('check:shell: its command is not one multi-line script');
    }
    return lines.slice(start + 1, end).join('\n');
  };

  type Files = Record<string, string>;

  /**
   * Runs the script the way mise runs an inline task, in a repository whose index holds `tracked`
   * and whose working tree also holds `untracked` and has lost `deleted`. A stand-in for
   * shellcheck records how it was called and exits with `shellcheckStatus`.
   */
  const run = (
    tracked: Files,
    { untracked = {}, deleted = [], shellcheckStatus = 0 }: { untracked?: Files; deleted?: string[]; shellcheckStatus?: number } = {},
  ) => {
    const source = script();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-shell-lint-'));
    try {
      const [repo, bin] = ['repo', 'bin'].map((name) => path.join(root, name));
      [repo, bin].forEach((dir) => fs.mkdirSync(dir));
      const write = (files: Files) => Object.entries(files).forEach(([file, text]) => {
        fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
        fs.writeFileSync(path.join(repo, file), text);
      });
      const record = path.join(bin, 'call.json');
      // Started by the node that runs this suite, not by whichever `node` PATH holds.
      fs.writeFileSync(path.join(bin, 'shellcheck'), `#!${process.execPath}
const call = { args: process.argv.slice(2), opts: process.env.SHELLCHECK_OPTS ?? null };
require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(call));
process.exit(${shellcheckStatus});
`, { mode: 0o755 });

      // No inherited GIT_* variable: under a git hook they point at the real repository.
      // SHELLCHECK_OPTS holds an option that the script must keep from shellcheck.
      const env: NodeJS.ProcessEnv = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        SHELLCHECK_OPTS: '--exclude=SC2164',
      };
      const git = (...args: string[]) => expect(spawnSync('git', args, { cwd: repo, env }).status).toBe(0);
      write(tracked);
      git('init', '-q');
      git('add', '--all');
      write(untracked);
      deleted.forEach((file) => fs.rmSync(path.join(repo, file)));

      const result = spawnSync('sh', ['-o', 'errexit', '-c', source], { cwd: repo, env, encoding: 'utf-8' });
      const call: { args: string[]; opts: string | null } | undefined = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf-8')) : undefined;
      return { status: result.status, stderr: result.stderr, call };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  test('gives shellcheck the scripts git tracks and the new ones, not an ignored or a deleted one', () => {
    const result = run(
      { 'scripts/a.sh': '', 'gone.sh': '', 'notes.txt': '', '.gitignore': 'node_modules/\n' },
      { untracked: { 'new script.sh': '', 'node_modules/pkg/vendored.sh': '' }, deleted: ['gone.sh'] },
    );

    expect(result.status).toBe(0);
    // Sorted: git lists the new files before the tracked ones.
    expect(result.call?.args.filter((argument) => !argument.startsWith('-')).sort()).toEqual(['new script.sh', 'scripts/a.sh']);
  });

  // A `.shellcheckrc` in the checkout, in a directory above it or in the home directory, and the
  // options in SHELLCHECK_OPTS, switch checks off or on: the answer would depend on the machine,
  // and a committed dotfile would change what the build enforces.
  test('asks for errors and warnings, and lets neither an rc file nor SHELLCHECK_OPTS change that', () => {
    expect(run({ 'a.sh': '' }).call).toEqual({ args: ['--norc', '--severity=warning', '--', 'a.sh'], opts: null });
  });

  test('fails when shellcheck reports a finding', () => {
    const result = run({ 'a.sh': '' }, { shellcheckStatus: 1 });

    expect(result.call?.args).toContain('a.sh');
    expect(result.status).not.toBe(0);
  });

  // `xargs` on macOS runs nothing for an empty list and exits 0: a pathspec that matches no file
  // would pass with nothing checked.
  test('fails when git lists no shell script, and does not call shellcheck', () => {
    const result = run({ 'notes.txt': '' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('check:shell: git listed no shell script, so nothing was checked.');
    expect(result.call).toBeUndefined();
  });

  // The places that start the task. Without them the lint exists and runs nowhere.
  test('runs in the build, in the security suite and in the commit hook', () => {
    const hooks = fs.readFileSync(path.resolve(__dirname, '../../../.pre-commit-config.yaml'), 'utf-8').split(/^ {6}- id: /m);
    const hook = hooks.find((text) => text.startsWith('shellcheck\n')) ?? '';

    for (const name of ['drift-prevention', 'security']) {
      expect(task(name).map((line) => line.trim())).toContain('{ task = "check:shell" },');
    }
    expect(hook).toMatch(/^ +entry: bash -lc '.* && mise run check:shell'$/m);
    expect(hook).toMatch(/^ +files: \\\.sh\$$/m);
    expect(hook).toMatch(/^ +stages: \[pre-commit\]$/m);
    expect(hook).not.toMatch(/^ +exclude: /m);
    // An exact version: a missing or floating pin would let a runner's own shellcheck answer.
    expect(fs.readFileSync(path.resolve(__dirname, '../../../mise.toml'), 'utf-8')).toMatch(/^shellcheck = "\d+\.\d+\.\d+"$/m);
  });
});
