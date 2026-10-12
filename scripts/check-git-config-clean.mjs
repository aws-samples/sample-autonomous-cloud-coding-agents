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
 *   1. `core.worktree` — never legitimate in a normal checkout. Two corrections to
 *      the obvious reading of it, both measured on git 2.50.1 because the first draft
 *      of this comment got both wrong:
 *
 *      Set in the SHARED config it redirects the MAIN worktree only. `git -C <root>
 *      rev-parse --show-toplevel` answers with the hijacked directory, the root reads
 *      as dirty, and the root's own untracked files disappear from `git status`. A
 *      LINKED worktree ignores it — it reports its own path and a clean status. So
 *      the blast radius is smaller than "every worktree", and less uniform, which is
 *      worse for diagnosis: whether a developer sees the corruption depends on which
 *      worktree they happen to be standing in.
 *
 *      And `git revert` does not no-op, which understates it. It SUCCEEDS, creates a
 *      revert commit, and writes the reverted content into the hijacked directory
 *      while the root's copy of the file is left untouched. The log says the revert
 *      happened, the tree says it did not, and the content is in a third place
 *      neither of them names.
 *
 *      Written when a fixture runs `git init` with both GIT_DIR and GIT_WORK_TREE
 *      inherited from the environment.
 *   2. `core.bare = true` on a repo that has a working tree. NOT the other stamp of
 *      the same `git init`: measured, the two are mutually exclusive outcomes.
 *      `GIT_DIR` alone writes `core.bare=true` and no `core.worktree`; `GIT_DIR` plus
 *      `GIT_WORK_TREE` writes `core.worktree` and `core.bare=false`. Both rules are
 *      needed because both inherited shapes occur in this repo's fixtures — but
 *      neither key implies the other, so do not go hunting for a partner that cannot
 *      be there.
 *   3. `user.name`/`user.email` holding a value no human would have: a reserved
 *      documentation domain (RFC 2606), a domain with no dot, or one of the literal
 *      fixture identities used in this repo. A real per-repo identity is COMMON and
 *      deliberately NOT flagged — a gate that fired on legitimate configuration
 *      would be switched off rather than fixed.
 *
 * WHY THE CONFIG PATH IS RESOLVED WITHOUT GIT AT ALL: no `git rev-parse` form
 * survives the state being detected. `--show-toplevel` is redirected by
 * `core.worktree` outright — the corruption disabling its own alarm — though note the
 * qualifier that matters here, since linked worktrees are this gate's stated habitat:
 * it is redirected from the MAIN worktree and answers correctly from a linked one.
 * A gate built on it would therefore be right or wrong depending on where it was
 * invoked, which is harder to reason about than a uniform failure. Meanwhile
 * `--git-common-dir` merely fails differently: when `core.worktree` names a path
 * that no longer exists (a deleted pytest `tmp_path`, i.e. the shape this leak
 * actually leaves behind), rev-parse aborts with `fatal: Invalid path`, so a check
 * built on it can only report "could not check" and never name the cause. Walking
 * the filesystem for `.git` is deterministic and reads no config, so it answers
 * correctly on a repository too broken for git to describe.
 *
 * WHAT THE HOOK RUNNER DOES, MEASURED (prek 0.4.8, git 2.50.1) — because the reach of
 * this gate depends on it and the first version of this comment guessed wrong:
 *
 *   - prek chdirs a hook to the repository root ITSELF, derived from its own
 *     `git rev-parse --show-toplevel`. So omitting the `cd "$(git rev-parse
 *     --show-toplevel)"` prologue that every other hook in `.pre-commit-config.yaml`
 *     carries buys this hook nothing — it is already standing where that prologue
 *     would have put it. The prologue is omitted anyway (one less dependency on a git
 *     command that can lie), but it is NOT what protects the check. What protects the
 *     check is resolution-by-filesystem plus reading through `--file` from cwd `/`.
 *   - When `core.worktree` names a path with two or more missing components, prek
 *     ABORTS at startup on that same rc-128 rev-parse, before invoking any hook. The
 *     gate therefore cannot be what catches that shape — but nothing slips through
 *     either, because plain `git commit` fails identically. That shape is
 *     self-announcing; every git command in the tree refuses.
 *   - When `core.worktree` names a path that EXISTS — the shape actually seen in
 *     #622/#720/#855, pointing at a sibling worktree — git answers normally, prek runs,
 *     and this gate fires with the right config and the right diagnosis. That is the
 *     silent-and-dangerous case, and it is the one covered.
 *
 * Reads are delegated to `git config --file <path>` so the parse is git's own, and
 * because `--file` involves no repository discovery — the one git operation this
 * corruption cannot reach. Readability is proved with a direct `readFileSync` first,
 * because `--get-all` reports an unreadable file and an absent key with the same
 * exit status (see `configValues`).
 *
 * Exit codes: 0 clean · 1 corruption found (with remedy) · 2 could not check — named
 * as `EXIT_CLEAN` / `EXIT_PROBLEMS_FOUND` / `EXIT_COULD_NOT_CHECK` and exported, so the
 * suite asserts the same symbols this script exits with rather than its own literals.
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
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * The exit contract, named rather than spelled as bare literals at each `process.exit`.
 * Exported so `cdk/test/scripts/check-git-config-clean.test.ts` asserts against these
 * symbols instead of re-encoding 0/1/2 on its own side — the contract then has one
 * definition and a change to it cannot pass silently.
 *
 * Importing this file for the constants does NOT run the gate: the rules execute only
 * under the `isMain` guard at the bottom.
 */
export const EXIT_CLEAN = 0;
export const EXIT_PROBLEMS_FOUND = 1;
export const EXIT_COULD_NOT_CHECK = 2;

/**
 * Literal identities used by fixtures in this tree. `t <t@t>` is the #720 sighting.
 *
 * Lowercased for case-insensitive comparison, which means `abca test` here is a THIRD
 * encoding of `TEST_IDENTITY_NAME` from `agent/tests/git_env.py` (the second being
 * `cdk/test/scripts/check-git-config-clean.test.ts`). Rename the Python constant
 * without touching this line and the gate quietly stops recognising the identity this
 * repo's own fixtures write — a false pass in a gate whose worst outcome is a false
 * pass. `TestCrossCopyParity` in `agent/tests/test_git_fixture_isolation.py` asserts
 * the three agree; do not rely on this comment to keep them together.
 */
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
    // `spawnError` rather than folding this into `status: null`: git never ran at all
    // (not on PATH, ENOMEM, EACCES), which is a different fact from git running and
    // exiting non-zero. Folded together, the caller's diagnostic reads `git exited
    // null` — a message that describes neither case and sends the reader looking for
    // a git bug instead of a missing binary.
    return { status: null, spawnError: String(result.error.message), stdout: '', stderr: '' };
  }
  return {
    status: result.status,
    spawnError: null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function bail(message) {
  console.error(`check-git-config-clean: ${message}`);
  process.exit(EXIT_COULD_NOT_CHECK);
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

/**
 * The repository-shared config, or exit 2 explaining why not.
 *
 * Returns `{ path, hasWorkingTree }`. The second field exists because rule 2 must not
 * assert something it never checked: `core.bare = true` is CORRUPTION in a checkout and
 * the NORMAL state of a genuine bare repository, and this gate can be pointed at a bare
 * repository by an inherited `GIT_DIR`. Proven by the shape of the resolved common dir —
 * a `.git` whose parent exists — which holds for a plain checkout and for a linked
 * worktree (whose `commondir` points back at the root's `.git`) and fails for a bare
 * repo, where the gitdir is the repository itself.
 */
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

  // Prove the file is READABLE before any rule is allowed to report on it. Without
  // this the gate has a false pass: `git config --file <unreadable> --get-all <key>`
  // exits **1** with only a stderr *warning*, which is byte-identical to git's
  // "key not present", so every rule would come back empty and the summary would print
  // `OK — 4 rule(s) clean` about a file it never opened. Reproduced with `chmod 000`.
  // Exit 2 is the documented verdict for that state (see the header), not exit 0.
  try {
    readFileSync(config);
  } catch (err) {
    bail(`cannot read ${config} (${err.message}). Refusing to report on a config that `
      + 'could not be opened — an unreadable config is exactly the state in which a '
      + 'leak would go unnoticed.');
  }

  const hasWorkingTree = basename(commonDir) === '.git' && existsSync(dirname(commonDir));
  return { path: config, hasWorkingTree };
}

/** All values of `key` in `configPath` (empty array when unset). */
function configValues(configPath, key) {
  const result = gitConfigRead(['config', '--file', configPath, '--get-all', key]);
  // rc 1 is git's "key not present" — the normal, clean case — but ONLY when git had
  // nothing to complain about. git also exits 1 when it could not access the file at
  // all, emitting `warning: unable to access ...` and no fatal. `sharedConfigPath`
  // already proved readability, so this is the belt to that braces: a non-empty stderr
  // on an rc 1 means the read did not happen and "no values" is not a finding.
  if (result.spawnError) {
    bail(`could not run git to read ${key} from ${configPath} (${result.spawnError}).`);
  }
  if (result.status === 1 && result.stderr.trim() === '') return [];
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

function main() {
  const { path: configPath, hasWorkingTree } = sharedConfigPath();
  const problems = [];
  const rulesChecked = [];

  // --- Rule 1: core.worktree -------------------------------------------------
  rulesChecked.push('core.worktree');
  for (const value of configValues(configPath, 'core.worktree')) {
    problems.push({
      what: `core.worktree = ${value}`,
      why:
        'redirects the main worktree: `git status` describes that directory instead of '
        + 'this one, files untracked here vanish from it, and `git revert` succeeds '
        + 'while writing the reverted content there rather than into this checkout.',
      fix: `git config --file ${configPath} --unset-all core.worktree`,
    });
  }

  // --- Rule 2: core.bare on a repo that HAS a working tree -------------------
  // Gated, because the rule's name is a claim and an ungated rule does not check it:
  // `core.bare = true` is corruption in a checkout and the correct, normal state of a
  // genuine bare repository. Reached via an inherited `GIT_DIR` this gate can be
  // pointed at a bare repo, where flagging it would be a false positive — and a gate
  // that fires on legitimate configuration gets switched off rather than fixed, which
  // is the failure mode this whole file is written to avoid.
  if (hasWorkingTree) {
    rulesChecked.push('core.bare');
    for (const value of configValues(configPath, 'core.bare')) {
      if (value.trim().toLowerCase() !== 'true') continue;
      problems.push({
        what: `core.bare = ${value}`,
        why:
          'this repository has a working tree, so it is not bare. Written by a stray '
          + '`git init` that inherited a GIT_DIR without a GIT_WORK_TREE (which is why '
          + 'core.worktree is NOT expected alongside it — the two are exclusive).',
        fix: `git config --file ${configPath} --unset-all core.bare`,
      });
    }
  } else {
    // Recorded in the rule list rather than silently dropped: the printed count is the
    // anti-vacuity signal, so a rule that did not run has to say so.
    rulesChecked.push('core.bare (n/a: no working tree found)');
  }

  // --- Rule 3: fixture identities --------------------------------------------
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
    process.exit(EXIT_PROBLEMS_FOUND);
  }

  // The counts are the anti-vacuity signal: a check that inspected nothing would
  // also exit 0.
  console.log(
    `check-git-config-clean: OK — ${rulesChecked.length} rule(s) `
      + `(${rulesChecked.join(', ')}) clean in ${configPath}.`,
  );
}

// Run only when invoked as a script, so the exit-code constants above can be imported
// by the test without the gate executing against whatever repo jest happens to be in.
const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
