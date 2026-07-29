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
 * ADR-003 Tier 0 enforcement: commit-msg hook.
 *
 * Rejects a commit whose message carries no issue reference. ADR-003
 * (docs/decisions/ADR-003-contribution-governance.md, enforcement table)
 * specifies the rule as "Rejects commits without `Refs #N` or `Fixes #N`".
 * We accept the full GitHub closing-keyword family (Closes/Fixes/Resolves and
 * their inflections) plus `Refs`/`Ref`, since those are what actually link a
 * commit to an issue on GitHub. A bare `#N` mention with no keyword does NOT
 * satisfy the gate — the reference must be intentional, not incidental prose.
 *
 * Wiring: a `commit-msg`-type local hook in `.pre-commit-config.yaml`. prek /
 * pre-commit invoke commit-msg hooks with the path to the commit message file
 * (`.git/COMMIT_EDITMSG`) as the sole positional argument.
 *
 * Usage:
 *   node scripts/hooks/check-commit-msg.mjs <path-to-commit-msg-file>
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Keyword family that links a commit to an issue on GitHub, plus `Refs`/`Ref`.
// Reference forms accepted after the keyword: `#N`, `GH-N`, or `owner/repo#N`.
const ISSUE_REF =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\b\s+(?:[\w.-]+\/[\w.-]+)?(?:#|gh-)\d+/i;

/**
 * Strip git comment lines (those beginning with `#`), which git removes before
 * storing the commit. A keyword that only appears in a comment must not count.
 * Note: `#N` issue references never start a line with the keyword, so removing
 * whole `#`-leading lines cannot hide a legitimate reference.
 */
function stripComments(message) {
  return message
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n');
}

/**
 * @param {string} message raw commit message
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateCommitMessage(message) {
  const body = stripComments(message ?? '');
  if (ISSUE_REF.test(body)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      'Commit message is missing an issue reference. ADR-003 (Tier 0) requires ' +
      'a keyword + issue link, e.g. `Refs #N`, `Fixes #N`, or `Closes #N`. ' +
      'Add one referencing the approved issue this commit implements.',
  };
}

function main(argv) {
  const msgPath = argv[2];
  if (!msgPath) {
    console.error(
      'check-commit-msg: no commit message file path given. This hook must be ' +
        'wired as a `commit-msg`-type hook so the message file path is passed.',
    );
    return 2;
  }

  let message;
  try {
    message = readFileSync(msgPath, 'utf8');
  } catch (err) {
    console.error(`check-commit-msg: could not read ${msgPath}: ${err.message}`);
    return 2;
  }

  const result = validateCommitMessage(message);
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
