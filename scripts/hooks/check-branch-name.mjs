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
 * ADR-003 enforcement: branch-name validation (pre-push).
 *
 * ADR-003 (docs/decisions/ADR-003-contribution-governance.md, "No branches
 * without an Issue" + enforcement table) requires a feature branch to match
 * `(feat|fix|chore|docs)/<issue-number>-<desc>` — a branch without an issue
 * reference is unauthorized work.
 *
 * Exemptions (branches that are not contributor feature work):
 *   - `main`               — the trunk itself is not a feature branch.
 *   - `dependabot/*`       — bot-authored dependency-upgrade branches.
 *   - `HEAD`               — the sentinel `git rev-parse --abbrev-ref HEAD`
 *                            returns in a detached-HEAD state; do not block.
 * ADR-003 does not enumerate exemptions in prose; these are the minimal set
 * needed so the trunk and machine-generated branches are not falsely rejected.
 * See the PR body for this note.
 *
 * Wiring: a `pre-push`-type local hook in `.pre-commit-config.yaml`.
 *
 * Which refs get validated
 * ------------------------
 * A push does not necessarily publish the branch you have checked out —
 * `git push origin feat/123-x:refs/heads/random-name` from a `main` checkout
 * publishes a non-conforming remote ref while HEAD reads as the exempt `main`.
 * So the ref list is resolved from the push itself, in this precedence order
 * (see `resolveBranchesToCheck`):
 *
 *   1. an explicit `argv[2]` — manual/CI use and the test harness.
 *   2. git's native `pre-push` stdin contract, one line per pushed ref:
 *        `<local-ref> SP <local-sha> SP <remote-ref> SP <remote-sha>`
 *      Populated only when this script is wired as a bare `.git/hooks/pre-push`.
 *      Under prek it is always empty (see below), but parsing it keeps the
 *      script correct in a native-hook install and covers every pushed ref.
 *   3. prek / pre-commit `pre-push` environment variables
 *      (`PRE_COMMIT_LOCAL_BRANCH`, `PRE_COMMIT_REMOTE_BRANCH`) — the wiring
 *      this repo actually uses.
 *   4. `git rev-parse --abbrev-ref HEAD` — no push is in flight, e.g.
 *      `prek run --all-files --stage pre-push` via `mise run hooks:run`.
 *
 * Both the local and the remote ref of a push are validated: the local name is
 * the branch being worked on, and the remote name is what lands on the remote
 * and what a PR is opened from — ADR-003 auditability depends on both.
 *
 * Known limitation (prek): prek's git shim is
 * `exec prek hook-impl --hook-type=pre-push -- "$@"`, so prek — not this
 * script — is git's stdin reader. It consumes the ref lines to compute its own
 * file list, forwards neither stdin nor git's `<remote-name> <remote-url>`
 * arguments to the hook entry, and re-publishes only the FIRST pushed ref pair
 * as `PRE_COMMIT_*`. A multi-ref push is therefore validated on that first pair
 * alone. Reaching every ref would require bypassing prek with a native
 * `.git/hooks/pre-push`, which conflicts with prek owning `core.hooksPath`.
 *
 * Usage:
 *   node scripts/hooks/check-branch-name.mjs [branch-name]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BRANCH_PATTERN = /^(?:feat|fix|chore|docs)\/\d+-.+/;
const EXEMPT_EXACT = new Set(['main', 'HEAD', '']);
const HEADS_PREFIX = 'refs/heads/';
// git writes an all-zero sha for the absent side of a create/delete.
const NULL_SHA = /^0+$/;

/**
 * @param {string} branch
 * @returns {boolean}
 */
function isExempt(branch) {
  if (EXEMPT_EXACT.has(branch)) return true;
  if (branch.startsWith('dependabot/')) return true;
  return false;
}

/**
 * @param {string} branch current branch name
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateBranchName(branch) {
  const name = branch ?? '';
  if (isExempt(name)) {
    return { ok: true };
  }
  if (BRANCH_PATTERN.test(name)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `Branch "${name}" does not match the ADR-003 convention ` +
      '`(feat|fix|chore|docs)/<issue-number>-<description>` ' +
      '(e.g. `feat/123-short-description`). A branch without an issue reference ' +
      'is unauthorized work — rename it: `git branch -m <new-name>`.',
  };
}

/**
 * Reduce a ref to a bare branch name.
 * @param {string | undefined} ref
 * @returns {string | null} the branch name, or null when the ref is not a
 *   branch (`refs/tags/*`, `refs/notes/*`, …) and so carries no ADR-003
 *   naming obligation.
 */
export function branchFromRef(ref) {
  const value = (ref ?? '').trim();
  if (value === '') return null;
  if (value.startsWith(HEADS_PREFIX)) return value.slice(HEADS_PREFIX.length) || null;
  if (value.startsWith('refs/')) return null;
  // Unqualified — git accepts a short name or `HEAD` on the left of a refspec.
  return value;
}

/**
 * Parse git's native `pre-push` stdin contract. One line per pushed ref:
 *   `<local-ref> SP <local-sha> SP <remote-ref> SP <remote-sha>`
 *
 * A deletion (`git push origin :branch`) carries an all-zero local sha and an
 * empty local ref — nothing is being published, so there is nothing to name.
 *
 * @param {string} stdin
 * @returns {{ refLines: number, branches: string[] }} `branches` is the
 *   deduped set of branch names the push touches — both sides of each
 *   refspec, which are usually the same name. `refLines` counts well-formed
 *   lines seen, which distinguishes "no ref list was supplied" from "a ref
 *   list was supplied and yielded no branches to check".
 */
export function parsePrePushStdin(stdin) {
  const branches = new Set();
  let refLines = 0;
  for (const line of String(stdin ?? '').split('\n')) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 4) continue;
    refLines += 1;
    const [localRef, localSha, remoteRef] = parts;
    if (NULL_SHA.test(localSha)) continue; // ref deletion
    for (const ref of [localRef, remoteRef]) {
      const branch = branchFromRef(ref);
      if (branch) branches.add(branch);
    }
  }
  return { refLines, branches: [...branches] };
}

/**
 * Resolve the branch names a given invocation should validate, and where they
 * came from. See the module header for the precedence rationale.
 *
 * @param {{
 *   argv?: string[],
 *   stdin?: string,
 *   env?: Record<string, string | undefined>,
 *   readCurrentBranch?: () => string,
 * }} [io]
 * @returns {{ source: 'argv'|'stdin'|'env'|'head', branches: string[] }}
 */
export function resolveBranchesToCheck(io = {}) {
  const { argv = [], stdin = '', env = {}, readCurrentBranch } = io;
  const dedupe = (names) => [...new Set(names)];

  if (argv[2]) {
    return { source: 'argv', branches: [argv[2]] };
  }

  // git's native contract. Authoritative once any ref line is present, even if
  // it yields no branches (a tag-only push has no naming obligation) — falling
  // through to HEAD there would validate a name this push never touches.
  const fromStdin = parsePrePushStdin(stdin);
  if (fromStdin.refLines > 0) {
    return { source: 'stdin', branches: dedupe(fromStdin.branches) };
  }

  // prek / pre-commit. Same reasoning: the vars being set means a push IS in
  // flight, so this wins even when it resolves to nothing checkable.
  const { PRE_COMMIT_LOCAL_BRANCH: local, PRE_COMMIT_REMOTE_BRANCH: remote } = env;
  if (local || remote) {
    return {
      source: 'env',
      branches: dedupe([branchFromRef(local), branchFromRef(remote)].filter(Boolean)),
    };
  }

  // No push in flight — validate the checked-out branch.
  return { source: 'head', branches: dedupe([readCurrentBranch().trim()]) };
}

/**
 * Resolve the current branch via git plumbing. Fail loud on error rather than
 * defaulting to a pass, so a broken git invocation cannot silently disable the
 * gate.
 * @returns {string}
 */
function currentBranch() {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

/**
 * The only two fd-0 errnos that mean "there is no ref list here" rather than
 * "the read failed": an empty non-blocking pipe, and fd 0 closed outright.
 * Everything else is a genuine failure and must not be degraded to ''.
 */
const NO_REF_LIST_ERRNOS = new Set(['EAGAIN', 'EBADF']);

/**
 * Read git's ref list from fd 0.
 *
 * Returns '' when no ref list is available — which is the normal case under
 * prek (it already consumed stdin) and on a TTY (no push in flight). This is a
 * fall-THROUGH, not a fall-back to a pass: `resolveBranchesToCheck` then
 * resolves the refs from the environment or from HEAD, so the gate still runs.
 * A blocking read on a TTY would hang the hook, hence the isTTY guard.
 *
 * An *unexpected* read failure is re-thrown so it reaches `main`, which fails
 * closed (exit 2). Reporting it as '' would be a security bug, not a nicety:
 * the fall-through ends at HEAD, and on a `main` checkout HEAD is exempt — so a
 * masked read failure would pass the very gate this hook exists to enforce.
 * @param {{isTTY?: boolean, read?: () => string}} [io] seams for tests
 * @returns {string}
 */
function readRefListFromStdin(io = {}) {
  const { isTTY = process.stdin.isTTY, read = () => readFileSync(0, 'utf8') } = io;
  if (isTTY) return '';
  try {
    return read();
  } catch (err) {
    if (!NO_REF_LIST_ERRNOS.has(err?.code)) throw err;
  }
  return '';
}

function main(argv, io = {}) {
  const {
    env = process.env,
    readCurrentBranch = currentBranch,
    readRefList = readRefListFromStdin,
  } = io;

  let resolved;
  try {
    // Read stdin inside the `try` so an unexpected fd-0 failure lands in the
    // catch below (exit 2) instead of escaping `main` as an uncaught throw.
    const stdin = io.stdin ?? readRefList();
    resolved = resolveBranchesToCheck({ argv, stdin, env, readCurrentBranch });
  } catch (err) {
    console.error(`check-branch-name: could not determine the branch(es) being pushed: ${err.message}`);
    return 2;
  }

  const failures = resolved.branches
    .map((branch) => validateBranchName(branch))
    .filter((result) => !result.ok);

  if (failures.length === 0) {
    return 0;
  }

  for (const failure of failures) {
    console.error(`❌ ${failure.reason}`);
  }
  console.error('   ADR-003: docs/decisions/ADR-003-contribution-governance.md');
  return 1;
}

export { main, readRefListFromStdin };

// Run only when invoked directly, not when imported by the test suite.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
