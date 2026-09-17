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
// js-yaml 4's `load` uses the core schema — no custom types are constructed — so it is
// the safe reader here, unlike the v3 API of the same name.
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/check-git-config-clean.mjs');

/**
 * The gate's exit contract, read out of the gate rather than re-typed here.
 *
 * Parsed instead of `import`ed on purpose: the script is ESM and this suite is compiled
 * to CJS, and — more importantly — importing it would EXECUTE it against whatever
 * repository jest happens to be running in. Parsing keeps one definition without that.
 *
 * A missing or renamed export throws here, so the coupling is real: the contract cannot
 * be changed on one side only. The numeric values are pinned once, immediately below,
 * so a silently *edited* value is caught too — a test that only mirrored the source
 * would follow it anywhere.
 */
function exitCode(name: string): number {
  const source = fs.readFileSync(SCRIPT, 'utf-8');
  const match = new RegExp(String.raw`export const ${name} = (\d+);`).exec(source);
  if (!match) {
    throw new Error(
      `scripts/check-git-config-clean.mjs no longer exports \`${name}\`. `
        + 'The exit contract is asserted against these symbols — update both sides.',
    );
  }
  return Number(match[1]);
}

const EXIT_CLEAN = exitCode('EXIT_CLEAN');
const EXIT_PROBLEMS_FOUND = exitCode('EXIT_PROBLEMS_FOUND');
const EXIT_COULD_NOT_CHECK = exitCode('EXIT_COULD_NOT_CHECK');

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

/**
 * Repo-location vars — mirrors `GIT_LOCATION_VARS` in `agent/tests/git_env.py`, and
 * `agent/tests/test_git_fixture_isolation.py` asserts the two lists (plus the copy in
 * the script itself) stay identical.
 *
 * Every entry REDIRECTS git to a repository of the environment's choosing, so removal
 * is the right treatment for all of them. `GIT_CEILING_DIRECTORIES` is deliberately NOT
 * here: it does the opposite, LIMITING the discovery walk, so deleting it widens what
 * git can reach. It is pinned below instead.
 */
const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
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
    // The route stripping does NOT close: a git command aimed at a directory that turns
    // out not to be a repository walks UP, and TMPDIR sits inside a checkout on some dev
    // machines. The PARENT, not `repo` itself, so `repo` stays discoverable.
    GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(repo)),
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

  test('the exit contract is 0 clean / 1 problems / 2 could-not-check', () => {
    // Pinned once, here, and referenced by name everywhere else. Without this line the
    // suite would only assert that it agrees with whatever the script currently says —
    // `exitCode()` reads the values out of the source, so an edit to `EXIT_CLEAN = 3`
    // would move both sides together and every other assertion would stay green.
    //
    // The numbers themselves are the interface: 1 vs 2 is what lets a caller tell "your
    // config is corrupt" from "I could not look", and prek treats every non-zero the
    // same, so nothing downstream would notice them being swapped.
    expect([EXIT_CLEAN, EXIT_PROBLEMS_FOUND, EXIT_COULD_NOT_CHECK]).toEqual([0, 1, 2]);
  });

  describe('the clean cases', () => {
    test('a fresh repository passes, and says what it checked', () => {
      const result = runGate(freshRepo('clean'));

      expect(result.status).toBe(EXIT_CLEAN);
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
      expect(result.status).toBe(EXIT_CLEAN);
    });

    test('a real per-repo identity is NOT flagged', () => {
      // The false-positive side, and the reason the rules match the leak's
      // SIGNATURE rather than the mere presence of a [user] section. Per-repo
      // identities are common; a gate that failed on them would be switched off
      // instead of fixed.
      const repo = freshRepo('real-identity');
      git(repo, ['config', '--local', 'user.name', 'Ada Lovelace']);
      git(repo, ['config', '--local', 'user.email', 'ada@example-corp.dev']);

      expect(runGate(repo).status).toBe(EXIT_CLEAN);
    });

    test('a GitHub noreply address is NOT flagged', () => {
      const repo = freshRepo('noreply');
      git(repo, ['config', '--local', 'user.email', '1234+ada@users.noreply.github.com']);

      expect(runGate(repo).status).toBe(EXIT_CLEAN);
    });

    test('core.bare = false is NOT flagged', () => {
      // `git init` writes this itself, so flagging it would fail every repository.
      const repo = freshRepo('bare-false');
      git(repo, ['config', '--local', 'core.bare', 'false']);

      expect(runGate(repo).status).toBe(EXIT_CLEAN);
    });
  });

  describe('core.worktree — the #622/#720 signature', () => {
    test('is rejected, with a copy-pasteable remedy', () => {
      const repo = freshRepo('worktree');
      const elsewhere = path.join(scratch, 'elsewhere');
      fs.mkdirSync(elsewhere, { recursive: true });
      git(repo, ['config', '--local', 'core.worktree', elsewhere]);

      const result = runGate(repo);

      expect(result.status).toBe(EXIT_PROBLEMS_FOUND);
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
      //
      // TWO missing components (`gone/deleted-tmp-path`), and that is the whole test.
      // Measured on git 2.50.1, a single missing LEAF under an existing directory is an
      // rc-0 shape: rev-parse answers fine, so a version of this test using one would
      // assert the outcome without ever constructing the state, and would pass just as
      // happily against the git-based resolution this design rejected.
      const repo = freshRepo('worktree-missing');
      const missing = path.join(scratch, 'gone', 'deleted-tmp-path');
      appendConfig(repo, 'core', [`worktree = ${missing}`]);
      expect(fs.existsSync(path.dirname(missing))).toBe(false); // the shape, asserted

      // The premise, measured rather than assumed: the rejected resolution really is
      // unusable here. If a future git makes this succeed, this line fails and whoever
      // sees it can re-evaluate the filesystem walk instead of inheriting a comment.
      for (const form of [['--show-toplevel'], ['--path-format=absolute', '--git-common-dir']]) {
        const probe = spawnSync('git', ['-C', repo, 'rev-parse', ...form], {
          encoding: 'utf8',
          env: isolatedGitEnv(repo),
        });
        expect(probe.status).not.toBe(0);
      }

      const result = runGate(repo);

      expect(result.status).toBe(EXIT_PROBLEMS_FOUND);
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

      expect(result.status).toBe(EXIT_PROBLEMS_FOUND);
      expect(result.stderr).toContain(path.join(repo, '.git', 'config'));
      expect(result.stderr).toContain('user.name');
    });
  });

  describe('core.bare on a checkout', () => {
    test('is rejected', () => {
      const repo = freshRepo('bare-true');
      git(repo, ['config', '--local', 'core.bare', 'true']);

      const result = runGate(repo);

      expect(result.status).toBe(EXIT_PROBLEMS_FOUND);
      expect(result.stderr).toContain('core.bare');
      expect(result.stderr).toContain('--unset-all core.bare');
    });

    test('a GENUINE bare repository is not flagged, and the skip is declared', () => {
      // The other half of the rule, and the reason it is gated: `core.bare = true` is
      // corruption in a checkout and the correct, documented state of a bare repository.
      // An ungated rule would report the *normal* config of a bare repo as the #855 leak
      // and print a remedy — `--unset-all core.bare` — that BREAKS it.
      //
      // Reached the way it is reachable in practice: via an inherited `GIT_DIR`. The
      // filesystem walk cannot arrive at a bare repo on its own (there is no `.git` to
      // find), so an env-provided gitdir is the whole exposure.
      //
      // The second assertion is what stops the fix from being a silent skip. `OK — 4
      // rule(s)` is the anti-vacuity signal, so a rule that did not run has to say so in
      // the count rather than quietly leaving it looking like a full pass.
      const bare = path.join(scratch, 'genuine.git');
      git(scratch, ['init', '--bare', '-q', bare]);
      expect(
        fs.readFileSync(path.join(bare, 'config'), 'utf-8'),
      ).toMatch(/bare\s*=\s*true/); // the premise: git itself wrote this
      const unrelated = path.join(scratch, 'bare-cwd');
      fs.mkdirSync(unrelated, { recursive: true });

      const result = runGate(unrelated, { GIT_DIR: bare });

      expect(result.status).toBe(EXIT_CLEAN);
      expect(result.stdout).toContain('core.bare (n/a: no working tree found)');
    });
  });

  describe('fixture identities — the #720 sighting', () => {
    // Every branch of `isFixtureIdentity` and every entry of `RESERVED_EMAIL_SUFFIXES`,
    // rather than a sample. The earlier table hit 2 of the 7 suffixes and one of the 5
    // fixture names, so five suffixes and four names were assertion-free: deleting any of
    // them left the suite green while the gate stopped recognising a shape it names in its
    // own header. Rule 3 is the only rule matching against a LIST, so it is the only one
    // where per-entry coverage is a distinct question from per-rule coverage.
    test.each([
      // --- FIXTURE_NAMES (all five) ---
      ['user.name = t', 'user', ['name = t']],
      ['user.name = test', 'user', ['name = test']],
      // The identity this repo's own fixtures set. Matched case-insensitively — the
      // script lowercases before the lookup, and `agent/tests/git_env.py` spells it
      // `ABCA Test`, so a case-sensitive comparison would miss the very value the
      // fixtures write. `TestCrossCopyParity` holds the two spellings together.
      ['user.name = ABCA Test (this repo\'s own fixture identity)', 'user', ['name = ABCA Test']],
      ['user.name = Test User', 'user', ['name = Test User']],
      ['user.name = Your Name (a copy-pasted placeholder)', 'user', ['name = Your Name']],
      // --- RESERVED_EMAIL_SUFFIXES (all seven) ---
      ['a reserved .invalid domain', 'user', ['email = abca-test@example.invalid']],
      ['a reserved .test domain', 'user', ['email = ada@corp.test']],
      ['a reserved .example domain', 'user', ['email = ada@corp.example']],
      ['a reserved .localhost domain', 'user', ['email = ada@build.localhost']],
      ['example.com', 'user', ['email = someone@example.com']],
      ['example.net', 'user', ['email = someone@example.net']],
      ['example.org', 'user', ['email = someone@example.org']],
      // --- the two structural branches ---
      ['user.email = t@t (no dot in the domain)', 'user', ['email = t@t']],
      ['an empty value', 'user', ['name = ']],
    ])('%s is rejected', (_label, section, lines) => {
      const repo = freshRepo(`identity-${_label.replace(/[^a-z0-9]+/gi, '-')}`);
      appendConfig(repo, section, lines);

      const result = runGate(repo);

      expect(result.status).toBe(EXIT_PROBLEMS_FOUND);
      expect(result.stderr).toContain('--remove-section user');
    });

    test('names the offending value so the human can see what replaced theirs', () => {
      const repo = freshRepo('identity-named');
      appendConfig(repo, 'user', ['email = t@t']);

      expect(runGate(repo).stderr).toContain('user.email = t@t');
    });
  });

  describe('several problems at once — the real shape of the leak', () => {
    test('every problem is reported, including a repeated key', () => {
      // Until this test, every failing case produced exactly ONE problem, which left two
      // code paths unexecuted by the suite: the inner `for (const value of ...)` loop
      // (only ever one value, so an implementation that read just the first would have
      // passed) and the `Found N problem(s)` summary (only ever `1`, so an off-by-one or a
      // hardcoded count would have passed).
      //
      // The repeated `email` line is not contrived. `[user]` sections appended by
      // successive fixture runs stack up rather than replace — which is exactly how #720
      // was found, and why the gate reads `--get-all` instead of `--get`. Written with
      // appendFileSync because `git config --local` would overwrite the first value.
      const repo = freshRepo('multi-problem');
      const elsewhere = path.join(scratch, 'multi-elsewhere');
      fs.mkdirSync(elsewhere, { recursive: true });
      git(repo, ['config', '--local', 'core.worktree', elsewhere]);
      appendConfig(repo, 'user', ['name = t', 'email = t@t']);
      appendConfig(repo, 'user', ['email = someone@example.com']);

      const result = runGate(repo);

      expect(result.status).toBe(EXIT_PROBLEMS_FOUND);
      // Exact, not `toBeGreaterThan`: the count is the assertion. core.worktree + user.name
      // + BOTH user.email values.
      expect(result.stderr).toContain('Found 4 problem(s)');
      for (const expected of [
        `core.worktree = ${elsewhere}`,
        'user.name = t',
        'user.email = t@t',
        'user.email = someone@example.com',
      ]) {
        expect(result.stderr).toContain(expected);
      }
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

      expect(result.status).toBe(EXIT_COULD_NOT_CHECK);
      expect(result.stderr).toContain('no `.git` found');
    });

    test('a missing .git/config exits 2 rather than reporting clean', () => {
      const repo = freshRepo('no-config');
      fs.rmSync(path.join(repo, '.git', 'config'));

      const result = runGate(repo);

      expect(result.status).toBe(EXIT_COULD_NOT_CHECK);
      expect(result.stderr).toContain('does not exist');
    });

    // Root bypasses file permissions, so `chmod 000` is still readable there and the
    // scenario cannot be constructed. Skipped rather than faked: a test that asserted
    // this via a mock would pass whether or not the real gate handles it.
    const testUnlessRoot = process.getuid?.() === 0 ? test.skip : test;

    testUnlessRoot('an UNREADABLE .git/config exits 2 rather than reporting clean', () => {
      // The false pass this file exists to prevent, and one the gate really had:
      // `git config --file <unreadable> --get-all <key>` exits **1** with only a stderr
      // *warning* — byte-identical to git's "key not present" — so every rule came back
      // empty, no rule fired, and the gate printed `OK — 4 rule(s) ... clean` and exited
      // 0 about a file it had never opened. Worse than a missed detection: it is an
      // affirmative all-clear on an unexamined config.
      //
      // Asserts the CONTRACT (exit 2, no all-clear), not which internal check fired, and
      // that wording is deliberate: mutation-tested, the gate turns out to have two
      // independent stops for this input — the up-front `readFileSync` proof and
      // `configValues` refusing to read rc 1 as "absent" while stderr is non-empty.
      // Deleting either one alone still leaves this test green; deleting both returns
      // exit 0 with `OK — 4 rule(s)`, which is what it was measured against.
      const repo = freshRepo('unreadable-config');
      const configPath = path.join(repo, '.git', 'config');
      appendConfig(repo, 'user', ['email = t@t']); // corruption that MUST NOT be missed
      fs.chmodSync(configPath, 0o000);

      try {
        const result = runGate(repo);

        expect(result.status).toBe(EXIT_COULD_NOT_CHECK);
        expect(result.stderr).toContain('cannot read');
        expect(result.stderr).toContain(configPath);
        // The specific regression: no all-clear may be printed about an unread file.
        expect(result.stdout).not.toContain('OK —');
      } finally {
        // Restored so the scratch teardown is not fighting permissions.
        fs.chmodSync(configPath, 0o600);
      }
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

      expect(result.status).toBe(EXIT_PROBLEMS_FOUND);
      expect(result.stderr).toContain(path.join(repo, '.git', 'config'));
    });
  });

  describe('Layer 3 is actually wired up', () => {
    // The same defect class as an ungated rule: every test above proves the SCRIPT
    // behaves, and none of them proves anything ever RUNS it. Delete the
    // `.pre-commit-config.yaml` stanza and Layer 3 is gone with the whole suite still
    // green — the gate becomes a file nobody invokes. These two tests are the only place
    // the wiring is asserted, so they are load-bearing rather than tidy.

    test('the hook is registered at BOTH stages and calls the mise task', () => {
      // Parsed, not grepped: `stages: [pre-commit, pre-push]` appearing anywhere in a
      // 150-line file with fourteen hooks says nothing about which hook carries it —
      // every other local hook here declares stages too.
      const config = yaml.load(
        fs.readFileSync(path.join(REPO_ROOT, '.pre-commit-config.yaml'), 'utf-8'),
      ) as {
        repos: { repo: string; hooks: { id: string; entry?: string; stages?: string[] }[] }[];
      };
      const hook = config.repos
        .flatMap((r) => r.hooks)
        .find((h) => h.id === 'git-config-clean');

      expect(hook).toBeDefined();
      expect(hook!.entry).toContain('mise run check:git-config-clean');
      // Both, and the pre-push half is the one that matters most: while the config is
      // corrupted `git status` and `git revert` describe a different directory, so a
      // developer can push a branch they believe they reverted.
      expect(hook!.stages).toEqual(['pre-commit', 'pre-push']);
      // `bash -c`, never `-lc`. A login shell sources the profile before the command, and
      // this is the one hook with no `cd "$(git rev-parse --show-toplevel)"` prologue to
      // undo a profile `cd` — so a relocated cwd would break both the `mise.toml` lookup
      // and the script's own `.git` walk. See the comment above the stanza.
      expect(hook!.entry).not.toContain('-lc');
    });

    test('the mise task the hook names exists and points at this script', () => {
      // The indirection the hook relies on: `mise run check:git-config-clean` is a name,
      // and nothing else checks that the name resolves. Scoped to the stanza rather than
      // matched against the whole file, so a task of some other name running the same
      // script would not satisfy it.
      const miseToml = fs.readFileSync(path.join(REPO_ROOT, 'mise.toml'), 'utf-8');
      const stanza = /^\[tasks\."check:git-config-clean"\]$([\s\S]*?)(?=^\[|\Z)/m.exec(miseToml);

      expect(stanza).not.toBeNull();
      const scriptRelative = path.relative(REPO_ROOT, SCRIPT);
      expect(stanza![1]).toContain(`run = "node ${scriptRelative}"`);
      expect(fs.existsSync(SCRIPT)).toBe(true);
    });
  });

  describe("this suite's own git isolation", () => {
    test('isolatedGitEnv strips every location var and pins config resolution', () => {
      // Asserted because the isolation is what stops these tests from re-creating
      // the bug while setting up: with a GIT_DIR inherited from the pre-push hook,
      // `git init <tmp>` re-inits the real repository.
      const env = isolatedGitEnv('/somewhere/repo');

      for (const key of GIT_LOCATION_VARS) {
        expect(env[key]).toBeUndefined();
      }
      expect(env.HOME).toBe('/somewhere/repo');
      expect(env.GIT_CONFIG_GLOBAL).toBe('/somewhere/repo/.gitconfig-test');
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
      // SET, not stripped — and one level OUT, so `repo` itself stays discoverable while
      // the walk can never climb above it.
      expect(env.GIT_CEILING_DIRECTORIES).toBe('/somewhere');
    });

    test('the discovery ceiling stops a write from escaping into a repo above', () => {
      // The route stripping does not close, and the one this suite is itself exposed to:
      // `scratch` is under TMPDIR, which is inside a checkout on some machines. Measured
      // on git 2.50.1 without the pin, this write lands in the parent repo's config, rc 0.
      const outer = freshRepo('ceiling-outer');
      const sub = path.join(outer, 'not-a-repo');
      fs.mkdirSync(sub, { recursive: true });
      const outerConfig = path.join(outer, '.git', 'config');
      const before = fs.readFileSync(outerConfig);

      const result = spawnSync('git', ['-C', sub, 'config', 'user.email', 't@t'], {
        encoding: 'utf-8',
        env: isolatedGitEnv(sub),
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('not in a git directory');
      expect(fs.readFileSync(outerConfig)).toEqual(before);
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
