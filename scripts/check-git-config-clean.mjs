#!/usr/bin/env node
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
 * Shared `.git/config` corruption gate (issue #855; recurrences #622, #695, #720, #665).
 *
 * Layer 3 of three. Layer 1 (`agent/tests/git_env.py` + the `_isolate_git_location`
 * autouse fixture in `agent/tests/conftest.py`) PREVENTS the leak; Layer 2
 * (`pytest_sessionstart`/`pytest_sessionfinish` in the same conftest) DETECTS a
 * mutation during a test run. This layer REFUSES: it runs at pre-commit and
 * pre-push and blocks the operation while the repository's shared config carries
 * the leak's signature, no matter which tool wrote it.
 *
 * Three layers rather than one because the same bug has now been "fixed" four
 * times. Each earlier fix hardened the one test file where the leak was observed,
 * and each was defeated by the next file to shell out to git. A gate outside the
 * test suite entirely cannot be outrun that way.
 *
 * WHAT IT LOOKS FOR — the signature, not merely unusual settings:
 *
 *   1. `core.worktree` — never legitimate in a normal checkout. Set, it pins EVERY
 *      linked worktree to one directory, so the root reads as dirty, the root's own
 *      untracked files disappear from `git status`, and `git revert` silently
 *      no-ops. Written when a fixture runs `git init` with both GIT_DIR and
 *      GIT_WORK_TREE inherited from the environment.
 *   2. `core.bare = true` on a repo that has a working tree — the other stamp the
 *      same `git init` leaves behind.
 *   3. `user.name`/`user.email` holding a value no human would have: a reserved
 *      documentation domain (RFC 2606), a domain with no dot, or one of the literal
 *      fixture identities used in this repo. A real per-repo identity is COMMON and
 *      deliberately NOT flagged — a gate that fired on legitimate configuration
 *      would be switched off rather than fixed.
 *
 * WHY THE CONFIG PATH IS RESOLVED WITHOUT GIT AT ALL: no `git rev-parse` form
 * survives the state being detected. `--show-toplevel` is redirected by
 * `core.worktree` outright — the corruption disabling its own alarm — and
 * `--git-common-dir` merely fails differently: when `core.worktree` names a path
 * that no longer exists (a deleted pytest `tmp_path`, i.e. the shape this leak
 * actually leaves behind), rev-parse aborts with `fatal: Invalid path`, so a check
 * built on it can only report "could not check" and never name the cause. Walking
 * the filesystem for `.git` is deterministic and reads no config, so it answers
 * correctly on a repository too broken for git to describe. The
 * `.pre-commit-config.yaml` entry for this hook is likewise the only one in the file
 * that does NOT `cd "$(git rev-parse --show-toplevel)"`.
 *
 * Reads are delegated to `git config --file <path>` so the parse is git's own, and
 * because `--file` involves no repository discovery — the one git operation this
 * corruption cannot reach.
 *
 * Exit codes: 0 clean · 1 corruption found (with remedy) · 2 could not check.
 * Case 2 is a failure, not a pass: an unreadable config or a git that cannot answer
 * is exactly the state in which a leak would go unnoticed.
 *
 * Known limitation: submodules. Git legitimately sets `core.worktree` in a
 * submodule's own config, and `--git-common-dir` resolves to whichever repository
 * cwd belongs to — so committing from inside a submodule would flag rule 1. This
 * repo has no submodules; if that changes, exempt them explicitly rather than
 * dropping the rule.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Literal identities used by fixtures in this tree. `t <t@t>` is the #720 sighting. */
const FIXTURE_NAMES = new Set(['t', 'test', 'abca test', 'test user', 'your name']);

/**
 * Reserved / documentation domains (RFC 2606 + RFC 6761). An address here can never
 * be a real deliverable identity, so finding one in a repo config means a fixture
 * put it there.
 */
const RESERVED_EMAIL_SUFFIXES = [
  '.invalid',
  '.test',
  '.example',
  '.localhost',
  '@example.com',
  '@example.net',
  '@example.org',
];

/**
 * Repo-location vars, mirroring `GIT_LOCATION_VARS` in `agent/tests/git_env.py`.
 * Stripped before reading, for the same reason the fixtures strip them: while any is
 * set, git resolves a repository from the environment instead of from what we asked.
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

/**
 * Run git against an explicit config file from OUTSIDE any repository.
 *
 * The cwd and the env pins are both load-bearing, and the reason is unobvious:
 * `git config --file <path>` reads only that file, but git still performs
 * REPOSITORY SETUP for its working directory first — so run inside a repo whose
 * `core.worktree` names a missing directory, it aborts with `fatal: Invalid path`
 * before reading anything. That is the exact state this gate has to report on, so
 * the read cannot happen from inside the repository. cwd `/` plus
 * `GIT_CEILING_DIRECTORIES` leaves discovery nothing to find, and the location vars
 * are dropped so an inherited `GIT_DIR` (git sets one for hooks in a linked
 * worktree) cannot put the broken repository back.
 *
 * Never throws, never uses a shell.
 */
function gitConfigRead(args) {
  const env = { ...process.env };
  for (const key of GIT_LOCATION_VARS) delete env[key];
  env.GIT_CEILING_DIRECTORIES = '/';
  env.GIT_CONFIG_NOSYSTEM = '1';

  const result = spawnSync('git', args, { encoding: 'utf8', cwd: '/', env });
  if (result.error) {
    return { status: null, stdout: '', stderr: String(result.error.message) };
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function bail(message) {
  console.error(`check-git-config-clean: ${message}`);
  process.exit(2);
}

/**
 * The gitdir for the tree we are operating on, found without consulting any config.
 *
 * `GIT_DIR` is honoured when present because git sets it for hooks and it names the
 * exact tree being committed to. Note the asymmetry with the leak itself: an
 * inherited `GIT_DIR` is dangerous for a WRITE aimed at somewhere else, and
 * authoritative for a READ that wants this repository.
 */
function findGitDir() {
  if (process.env.GIT_DIR) return resolve(process.env.GIT_DIR);

  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, '.git');
    if (existsSync(candidate)) {
      const stat = statSync(candidate);
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) {
        // Linked worktree (or a submodule): `gitdir: <path>`, possibly relative to
        // the directory holding the `.git` file.
        const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, 'utf8'));
        if (!match) {
          bail(`${candidate} is a file but has no \`gitdir:\` line — cannot locate the repository.`);
        }
        const pointed = match[1].trim();
        return isAbsolute(pointed) ? pointed : resolve(dir, pointed);
      }
      bail(`${candidate} is neither a file nor a directory.`);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      bail(
        'no `.git` found in this directory or any parent, so there is no shared '
          + 'config to check. This is a git-hook gate — run it from a checkout.',
      );
    }
    dir = parent;
  }
}

/** Absolute path of the repository-shared config, or exit 2 explaining why not. */
function sharedConfigPath() {
  const gitDir = findGitDir();

  // A linked worktree's gitdir holds a `commondir` pointer to the SHARED `.git`,
  // which is the file at risk — a per-worktree config would not be.
  let commonDir = gitDir;
  const commonDirFile = join(gitDir, 'commondir');
  if (existsSync(commonDirFile)) {
    const pointed = readFileSync(commonDirFile, 'utf8').trim();
    if (pointed) commonDir = isAbsolute(pointed) ? pointed : resolve(gitDir, pointed);
  }

  const config = join(commonDir, 'config');
  if (!existsSync(config) || !statSync(config).isFile()) {
    bail(
      `${config} does not exist or is not a file. Every git repository has one, so `
        + 'this repository is in an unexpected state — check it by hand.',
    );
  }
  return config;
}

/** All values of `key` in `configPath` (empty array when unset). */
function configValues(configPath, key) {
  const result = gitConfigRead(['config', '--file', configPath, '--get-all', key]);
  // rc 1 is git's "key not present" — the normal, clean case.
  if (result.status === 1) return [];
  if (result.status !== 0) {
    bail(
      `cannot read ${key} from ${configPath} `
        + `(${result.stderr.trim() || `git exited ${result.status}`}).`,
    );
  }
  // Strip only the ONE trailing newline git ends its output with, rather than
  // filtering empty lines out: `name =` with no value is a real state (a fixture
  // interpolating an unset variable writes it) and prints as an empty line, so a
  // blanket filter would drop the very value that has to be reported. rc 0 means
  // at least one value was found, so the result is never an empty list here.
  const stdout = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
  return stdout.split('\n');
}

/** True when this identity value could not belong to a real contributor. */
function isFixtureIdentity(key, value) {
  const v = value.trim().toLowerCase();
  if (v === '') return true;
  if (key === 'user.name') return FIXTURE_NAMES.has(v);
  if (RESERVED_EMAIL_SUFFIXES.some((suffix) => v.endsWith(suffix))) return true;
  // No dot in the domain means it is not a resolvable FQDN — `t@t`, `a@b`.
  const domain = v.split('@')[1];
  return domain !== undefined && !domain.includes('.');
}

const configPath = sharedConfigPath();
const problems = [];
const rulesChecked = [];

// --- Rule 1: core.worktree ---------------------------------------------------
rulesChecked.push('core.worktree');
for (const value of configValues(configPath, 'core.worktree')) {
  problems.push({
    what: `core.worktree = ${value}`,
    why:
      'pins every linked worktree to one directory: the root reads as dirty, its '
      + 'own untracked files vanish from `git status`, and `git revert` no-ops.',
    fix: `git config --file ${configPath} --unset-all core.worktree`,
  });
}

// --- Rule 2: core.bare on a repo that has a working tree ---------------------
rulesChecked.push('core.bare');
for (const value of configValues(configPath, 'core.bare')) {
  if (value.trim().toLowerCase() !== 'true') continue;
  problems.push({
    what: `core.bare = ${value}`,
    why:
      'this repository has a working tree, so it is not bare. The same stray '
      + '`git init` that writes core.worktree stamps this.',
    fix: `git config --file ${configPath} --unset-all core.bare`,
  });
}

// --- Rule 3: fixture identities ----------------------------------------------
for (const key of ['user.name', 'user.email']) {
  rulesChecked.push(key);
  for (const value of configValues(configPath, key)) {
    if (!isFixtureIdentity(key, value)) continue;
    problems.push({
      what: `${key} = ${value === '' ? '(empty)' : value}`,
      why:
        'not a value a contributor would set — a reserved domain, a domain with no '
        + 'dot, or a literal fixture identity. Commits made under it are '
        + 'unattributable, and it silently replaced whatever was configured before.',
      fix: `git config --file ${configPath} --remove-section user`,
    });
  }
}

if (problems.length > 0) {
  console.error(`check-git-config-clean: ${configPath} carries the #855 leak signature.\n`);
  for (const { what, why, fix } of problems) {
    console.error(`  ✖ ${what}`);
    console.error(`      ${why}`);
    console.error(`      fix: ${fix}\n`);
  }
  console.error(
    'A test or script shelled out to git with a GIT_DIR inherited from the '
      + 'environment (git exports one to hooks in a linked worktree), which overrides '
      + 'repository discovery and so defeats cwd, --local and the GIT_CONFIG_* pins '
      + 'alike. In agent/tests, build the environment with '
      + 'isolated_git_env() from tests/git_env.py.\n',
  );
  console.error(
    `Found ${problems.length} problem(s). Repair the config with the command(s) `
      + 'above, then re-run. Do not bypass this hook: the state it is reporting '
      + 'makes `git status` and `git revert` lie to you.',
  );
  process.exit(1);
}

// The counts are the anti-vacuity signal: a check that inspected nothing would
// also exit 0.
console.log(
  `check-git-config-clean: OK — ${rulesChecked.length} rule(s) `
    + `(${rulesChecked.join(', ')}) clean in ${configPath}.`,
);
