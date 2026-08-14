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
 * Usage:
 *   node scripts/hooks/check-branch-name.mjs [branch-name]
 * When no argument is given, the current branch is read via git plumbing
 * (`git rev-parse --abbrev-ref HEAD`).
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BRANCH_PATTERN = /^(?:feat|fix|chore|docs)\/\d+-.+/;
const EXEMPT_EXACT = new Set(['main', 'HEAD', '']);

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

function main(argv) {
  let branch;
  if (argv[2]) {
    branch = argv[2];
  } else {
    try {
      branch = currentBranch();
    } catch (err) {
      console.error(`check-branch-name: could not determine current branch: ${err.message}`);
      return 2;
    }
  }

  const result = validateBranchName(branch);
  if (result.ok) {
    return 0;
  }

  console.error(`❌ ${result.reason}`);
  console.error('   ADR-003: docs/decisions/ADR-003-contribution-governance.md');
  return 1;
}

// Run only when invoked directly, not when imported by the test suite.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
