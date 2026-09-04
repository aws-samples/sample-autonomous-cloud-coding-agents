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
 * Tests for `scripts/check-git-config-clean.mjs` — Layer 3 of the #855 git-config
 * guard, the pre-commit/pre-push gate.
 *
 * WHY THESE EXIST: it is a GATE, and a gate's worst failure is a false pass. This
 * one has two independent ways to reach one: a detection rule that stops matching,
 * and a config-path resolution that quietly points somewhere harmless. The second is
 * not hypothetical — the first draft resolved the path with
 * `git rev-parse --git-common-dir`, which ABORTS when `core.worktree` names a
 * missing directory, so on the most common real shape of this corruption it could
 * only say "could not check". So every rule is asserted by making it fire, and the
 * hostile-resolution cases have tests of their own.
 *
 * WHY THIS LIVES UNDER `cdk/test/` for a ROOT-level script: same reason as
 * `check-constants-sync.test.ts` — there is no test tree at the repo root, and
 * `cdk/` is the only workspace with a Jest runner that can reach `../../scripts`.
 * Deliberate placement, not misrouting. The suite exercises a subprocess, so it
 * contributes nothing to `cdk/src` coverage.
 *
 * NOTE ON THIS FILE'S OWN GIT CALLS: they go through `isolatedGitEnv`, a TypeScript
 * mirror of `agent/tests/git_env.py`. That is not ceremony. Jest here may itself be
 * running under the pre-push hook, where git has exported `GIT_DIR` — and an
 * inherited `GIT_DIR` would make `git init <tmp>` re-init the REAL repository. A
 * test suite for this gate that caused the leak while setting up would be a poor
 * joke, so the isolation is applied and then asserted on (see the last describe).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/check-git-config-clean.mjs');

/**
 * The shared config of the checkout this suite is running in.
 *
 * NOT `join(REPO_ROOT, '.git', 'config')`: in a linked worktree — which is how this
 * repo's own contribution flow works — `.git` is a FILE pointing elsewhere, so that
 * path does not exist. Asked of git rather than hand-resolved because the script under
 * test resolves it without git, and a hand-rolled copy here would agree with the
 * script's bugs instead of catching them.
 */
function realSharedConfigPath(): string {
  const commonDir = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf-8' },
  ).trim();
  return path.join(commonDir, 'config');
}

/** Repo-location vars — mirrors `GIT_LOCATION_VARS` in `agent/tests/git_env.py`. */
const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
];

/** An environment in which git cannot reach outside `repo`. */
function isolatedGitEnv(repo: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Removed FIRST: while any is set, every pin below is bypassed.
  for (const key of GIT_LOCATION_VARS) delete env[key];
  return {
    ...env,
    HOME: repo,
    XDG_CONFIG_HOME: repo,
    GIT_CONFIG_GLOBAL: path.join(repo, '.gitconfig-test'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'ABCA Test',
    GIT_AUTHOR_EMAIL: 'abca-test@example.invalid',
    GIT_COMMITTER_NAME: 'ABCA Test',
    GIT_COMMITTER_EMAIL: 'abca-test@example.invalid',
  };
}

function git(repo: string, args: readonly string[]): void {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    env: isolatedGitEnv(repo),
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
}

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the gate with `cwd` (and optionally extra env), capturing the outcome. */
function runGate(cwd: string, extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...isolatedGitEnv(cwd), ...extraEnv },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let scratch: string;

/** A fresh, clean repository under the scratch dir. */
function freshRepo(name: string): string {
  const repo = path.join(scratch, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  return repo;
}

/** Set a local config key, bypassing git (which may refuse on a broken repo). */
function appendConfig(repo: string, section: string, lines: readonly string[]): void {
  const configPath = path.join(repo, '.git', 'config');
  fs.appendFileSync(configPath, `[${section}]\n${lines.map((l) => `\t${l}\n`).join('')}`);
}

describe('check-git-config-clean', () => {
  // A handful of subprocess spawns plus git inits.
  jest.setTimeout(60_000);

  /** Digest of the real shared config, captured before any test body runs. */
  let sharedConfigDigestAtStart: string;

  beforeAll(() => {
    // os.tmpdir() honours TMPDIR, which the pre-push hook points at
    // ~/.cache/cdk-tmp — so this does not land in a RAM-backed /tmp there.
    //
    // realpathSync because assertions below compare against paths the SCRIPT
    // printed, and the script derives them from `process.cwd()`, which Node reports
    // physically. On a machine where $HOME is a symlink (e.g. /home/x →
    // /local/home/x) the logical and physical spellings differ, and the remedy
    // strings would never match.
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abca-git-config-clean-')));
    sharedConfigDigestAtStart = execFileSync('git', ['hash-object', realSharedConfigPath()], {
      encoding: 'utf-8',
    }).trim();
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  describe('the clean cases', () => {
    test('a fresh repository passes, and says what it checked', () => {
      const result = runGate(freshRepo('clean'));

      expect(result.status).toBe(0);
      // The rule list is the anti-vacuity assertion: a gate that inspected NOTHING
      // would also exit 0. Naming them means a dropped rule shows up here.
      expect(result.stdout).toContain('core.worktree');
      expect(result.stdout).toContain('core.bare');
      expect(result.stdout).toContain('user.name');
      expect(result.stdout).toContain('user.email');
      expect(result.stdout).toMatch(/OK — 4 rule\(s\)/);
    });

    test('THIS repository passes', () => {
      // Not a self-test for its own sake: this is a third detection surface, after
      // the conftest fixture (prevent) and the session hook (detect). If a
      // contributor's shared config is polluted, the cdk suite says so here.
      const result = runGate(REPO_ROOT);

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    test('a real per-repo identity is NOT flagged', () => {
      // The false-positive side, and the reason the rules match the leak's
      // SIGNATURE rather than the mere presence of a [user] section. Per-repo
      // identities are common; a gate that failed on them would be switched off
      // instead of fixed.
      const repo = freshRepo('real-identity');
      git(repo, ['config', '--local', 'user.name', 'Ada Lovelace']);
      git(repo, ['config', '--local', 'user.email', 'ada@example-corp.dev']);

      expect(runGate(repo).status).toBe(0);
    });

    test('a GitHub noreply address is NOT flagged', () => {
      const repo = freshRepo('noreply');
      git(repo, ['config', '--local', 'user.email', '1234+ada@users.noreply.github.com']);

      expect(runGate(repo).status).toBe(0);
    });

    test('core.bare = false is NOT flagged', () => {
      // `git init` writes this itself, so flagging it would fail every repository.
      const repo = freshRepo('bare-false');
      git(repo, ['config', '--local', 'core.bare', 'false']);

      expect(runGate(repo).status).toBe(0);
    });
  });

  describe('core.worktree — the #622/#720 signature', () => {
    test('is rejected, with a copy-pasteable remedy', () => {
      const repo = freshRepo('worktree');
      const elsewhere = path.join(scratch, 'elsewhere');
      fs.mkdirSync(elsewhere, { recursive: true });
      git(repo, ['config', '--local', 'core.worktree', elsewhere]);

      const result = runGate(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('core.worktree');
      // The remedy must be runnable as printed, not a description of one.
      expect(result.stderr).toContain(
        `git config --file ${path.join(repo, '.git', 'config')} --unset-all core.worktree`,
      );
    });

    test('is rejected even when it points at a path that no longer EXISTS', () => {
      // The case that drove the design. `core.worktree` left behind by a fixture
      // names a pytest tmp_path, which is deleted at the end of the session — and
      // `git rev-parse` (any form) then aborts with `fatal: Invalid path`, as does
      // `git config` run from inside the repo. A gate that resolved its own target
      // through git could only report "could not check" on the most common real
      // shape of this corruption. Written with fs.appendFileSync because git itself
      // refuses to set the second key once the first has broken the repo.
      const repo = freshRepo('worktree-missing');
      appendConfig(repo, 'core', [`worktree = ${path.join(scratch, 'deleted-tmp-path')}`]);

      const result = runGate(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('core.worktree');
      expect(result.stderr).toContain('deleted-tmp-path');
    });

    test('is found in the SHARED config when run from a linked worktree', () => {
      // Linked worktrees are where this leak happens, so resolution has to follow
      // the `commondir` pointer rather than stopping at the per-worktree gitdir.
      const repo = freshRepo('shared');
      fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'base']);
      const linked = path.join(scratch, 'linked-wt');
      git(repo, ['worktree', 'add', '-q', linked, '-b', 'probe']);

      appendConfig(repo, 'user', ['name = t', 'email = t@t']);

      const result = runGate(linked);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(path.join(repo, '.git', 'config'));
      expect(result.stderr).toContain('user.name');
    });
  });

  describe('core.bare on a checkout', () => {
    test('is rejected', () => {
      const repo = freshRepo('bare-true');
      git(repo, ['config', '--local', 'core.bare', 'true']);

      const result = runGate(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('core.bare');
      expect(result.stderr).toContain('--unset-all core.bare');
    });
  });

  describe('fixture identities — the #720 sighting', () => {
    test.each([
      ['user.name = t', 'user', ['name = t']],
      ['user.email = t@t (no dot in the domain)', 'user', ['email = t@t']],
      ['a reserved .invalid domain', 'user', ['email = abca-test@example.invalid']],
      ['example.com', 'user', ['email = someone@example.com']],
      ['an empty value', 'user', ['name = ']],
    ])('%s is rejected', (_label, section, lines) => {
      const repo = freshRepo(`identity-${_label.replace(/[^a-z0-9]+/gi, '-')}`);
      appendConfig(repo, section, lines);

      const result = runGate(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--remove-section user');
    });

    test('names the offending value so the human can see what replaced theirs', () => {
      const repo = freshRepo('identity-named');
      appendConfig(repo, 'user', ['email = t@t']);

      expect(runGate(repo).stderr).toContain('user.email = t@t');
    });
  });

  describe('cannot-check is a FAILURE, not a pass', () => {
    test('outside any repository, exits 2 and says why', () => {
      // Fail-closed. Silently exiting 0 here would make a mis-wired hook look like a
      // clean repo forever.
      //
      // Run from `/` rather than a scratch dir: resolution walks UP for `.git`, so a
      // scratch dir's verdict would depend on where TMPDIR points (inside a checkout
      // on some machines, outside on others). `/` has no parent, so the walk
      // terminates immediately and the outcome is the same everywhere.
      expect(fs.existsSync('/.git')).toBe(false); // the one assumption `/` makes

      const result = runGate('/');

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('no `.git` found');
    });

    test('a missing .git/config exits 2 rather than reporting clean', () => {
      const repo = freshRepo('no-config');
      fs.rmSync(path.join(repo, '.git', 'config'));

      const result = runGate(repo);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('does not exist');
    });
  });

  describe('an inherited GIT_DIR — the hook environment', () => {
    test('is honoured for locating the repo, and does not blind the check', () => {
      // Git exports GIT_DIR to hooks in a linked worktree. For a WRITE that is the
      // hazard this whole issue is about; for the gate's READ it is the accurate
      // answer, so it is used — and must still find the corruption.
      const repo = freshRepo('git-dir-env');
      appendConfig(repo, 'user', ['email = t@t']);
      const unrelated = path.join(scratch, 'unrelated-cwd');
      fs.mkdirSync(unrelated, { recursive: true });

      const result = runGate(unrelated, { GIT_DIR: path.join(repo, '.git') });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(path.join(repo, '.git', 'config'));
    });
  });

  describe("this suite's own git isolation", () => {
    test('isolatedGitEnv strips every location var and pins config resolution', () => {
      // Asserted because the isolation is what stops these tests from re-creating
      // the bug while setting up: with a GIT_DIR inherited from the pre-push hook,
      // `git init <tmp>` re-inits the real repository.
      const env = isolatedGitEnv('/somewhere');

      for (const key of GIT_LOCATION_VARS) {
        expect(env[key]).toBeUndefined();
      }
      expect(env.HOME).toBe('/somewhere');
      expect(env.GIT_CONFIG_GLOBAL).toBe('/somewhere/.gitconfig-test');
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    });

    test('the real repository config is byte-identical after this suite has run', () => {
      // The blunt instrument, and the one that would actually have caught #622,
      // #695, #720 and #665. Declared last so it runs last in file order.
      const digest = execFileSync('git', ['hash-object', realSharedConfigPath()], {
        encoding: 'utf-8',
      }).trim();

      expect(digest).toBe(sharedConfigDigestAtStart);
    });
  });
});
