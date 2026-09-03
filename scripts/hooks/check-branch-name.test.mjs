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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  branchFromRef,
  main,
  parsePrePushStdin,
  readRefListFromStdin,
  resolveBranchesToCheck,
  validateBranchName,
} from './check-branch-name.mjs';

const SHA = 'a'.repeat(40);
const ZERO = '0'.repeat(40);

/** Run `main` with console.error captured so test output stays readable. */
function runMain(argv, io) {
  const original = console.error;
  const lines = [];
  console.error = (msg) => lines.push(String(msg));
  try {
    return { code: main(argv, io), stderr: lines.join('\n') };
  } finally {
    console.error = original;
  }
}

// ADR-003: a feature branch must match `(feat|fix|chore|docs)/<issue-number>-*`.

test('accepts feat/<issue>-<desc>', () => {
  assert.equal(validateBranchName('feat/186-adr003-hooks').ok, true);
});

test('accepts fix/<issue>-<desc>', () => {
  assert.equal(validateBranchName('fix/456-bug-name').ok, true);
});

test('accepts chore/ and docs/ prefixes', () => {
  assert.equal(validateBranchName('chore/12-tidy').ok, true);
  assert.equal(validateBranchName('docs/191-agents-md-split').ok, true);
});

test('rejects a prefix outside the allowed set', () => {
  const r = validateBranchName('feature/186-thing');
  assert.equal(r.ok, false);
  assert.match(r.reason, /feat\|fix\|chore\|docs/);
});

test('rejects a branch with no issue number', () => {
  const r = validateBranchName('feat/adr003-hooks');
  assert.equal(r.ok, false);
});

test('rejects a branch missing the description', () => {
  // `<issue-number>-<desc>` requires a hyphen + at least one desc char.
  assert.equal(validateBranchName('feat/186').ok, false);
  assert.equal(validateBranchName('feat/186-').ok, false);
});

test('rejects a bare branch name with no prefix', () => {
  assert.equal(validateBranchName('my-random-branch').ok, false);
});

// Exemptions — branches that are not contributor feature work.
test('exempts main', () => {
  assert.equal(validateBranchName('main').ok, true);
});

test('exempts dependabot/* branches', () => {
  assert.equal(validateBranchName('dependabot/npm_and_yarn/foo-1.2.3').ok, true);
});

test('exempts the HEAD detached / empty sentinel', () => {
  // git rev-parse --abbrev-ref HEAD returns "HEAD" when detached; do not block.
  assert.equal(validateBranchName('HEAD').ok, true);
});

test('does not exempt a lookalike prefix (maindev)', () => {
  assert.equal(validateBranchName('maindev').ok, false);
});

// ---------------------------------------------------------------------------
// Ref resolution (#679 review). A push does not necessarily publish HEAD, so
// the refs actually being pushed drive validation.
// ---------------------------------------------------------------------------

test('branchFromRef strips refs/heads/ and rejects non-branch namespaces', () => {
  assert.equal(branchFromRef('refs/heads/feat/186-x'), 'feat/186-x');
  assert.equal(branchFromRef('refs/tags/v1.2.3'), null, 'a tag is not a branch');
  assert.equal(branchFromRef('refs/notes/commits'), null, 'notes are not a branch');
  assert.equal(branchFromRef('feat/186-x'), 'feat/186-x', 'unqualified short name');
  assert.equal(branchFromRef('HEAD'), 'HEAD', 'HEAD refspec side stays the sentinel');
  assert.equal(branchFromRef(''), null);
  assert.equal(branchFromRef(undefined), null);
});

test('parsePrePushStdin reads git’s ref-line contract', () => {
  const r = parsePrePushStdin(`refs/heads/feat/186-x ${SHA} refs/heads/feat/186-x ${SHA}\n`);
  assert.equal(r.refLines, 1);
  assert.deepEqual(r.branches, ['feat/186-x']);
});

test('parsePrePushStdin covers every ref in a multi-ref push', () => {
  const r = parsePrePushStdin(
    `refs/heads/feat/186-x ${SHA} refs/heads/feat/186-x ${SHA}\n` +
      `refs/heads/chore/7-y ${SHA} refs/heads/chore/7-y ${SHA}\n`,
  );
  assert.equal(r.refLines, 2);
  assert.deepEqual(r.branches, ['feat/186-x', 'chore/7-y']);
});

test('parsePrePushStdin skips a deletion (all-zero local sha)', () => {
  // `git push origin :old-branch` publishes nothing, so nothing to name.
  const r = parsePrePushStdin(`(delete) ${ZERO} refs/heads/old-branch ${SHA}\n`);
  assert.equal(r.refLines, 1, 'the line was seen');
  assert.deepEqual(r.branches, [], 'but yields no branch to validate');
});

test('parsePrePushStdin ignores blank and malformed lines', () => {
  const r = parsePrePushStdin('\n\ngarbage\ntwo fields\n');
  assert.equal(r.refLines, 0);
  assert.deepEqual(r.branches, []);
});

test('resolveBranchesToCheck honours precedence: argv > stdin > env > HEAD', () => {
  const stdin = `refs/heads/feat/1-s ${SHA} refs/heads/feat/1-s ${SHA}\n`;
  const env = { PRE_COMMIT_LOCAL_BRANCH: 'refs/heads/feat/2-e' };
  const readCurrentBranch = () => 'feat/3-h';

  assert.deepEqual(
    resolveBranchesToCheck({ argv: ['node', 's', 'feat/0-a'], stdin, env, readCurrentBranch }),
    { source: 'argv', branches: ['feat/0-a'] },
  );
  assert.deepEqual(resolveBranchesToCheck({ argv: [], stdin, env, readCurrentBranch }), {
    source: 'stdin',
    branches: ['feat/1-s'],
  });
  assert.deepEqual(resolveBranchesToCheck({ argv: [], stdin: '', env, readCurrentBranch }), {
    source: 'env',
    branches: ['feat/2-e'],
  });
  assert.deepEqual(
    resolveBranchesToCheck({ argv: [], stdin: '', env: {}, readCurrentBranch }),
    { source: 'head', branches: ['feat/3-h'] },
  );
});

test('resolveBranchesToCheck reads BOTH sides of a renaming refspec', () => {
  // prek re-publishes the first pushed ref pair as PRE_COMMIT_*.
  const r = resolveBranchesToCheck({
    env: {
      PRE_COMMIT_LOCAL_BRANCH: 'refs/heads/feat/123-x',
      PRE_COMMIT_REMOTE_BRANCH: 'refs/heads/random-name',
    },
  });
  assert.equal(r.source, 'env');
  assert.deepEqual(r.branches, ['feat/123-x', 'random-name']);
});

test('resolveBranchesToCheck dedupes when local and remote names agree', () => {
  const r = resolveBranchesToCheck({
    env: {
      PRE_COMMIT_LOCAL_BRANCH: 'refs/heads/feat/186-x',
      PRE_COMMIT_REMOTE_BRANCH: 'refs/heads/feat/186-x',
    },
  });
  assert.deepEqual(r.branches, ['feat/186-x']);
});

test('a tag-only push does not fall through to HEAD', () => {
  // Falling through would validate a branch this push never touches.
  let headRead = false;
  const r = resolveBranchesToCheck({
    env: { PRE_COMMIT_LOCAL_BRANCH: 'refs/tags/v1.2.3' },
    readCurrentBranch: () => {
      headRead = true;
      return 'some-non-conforming-name';
    },
  });
  assert.equal(r.source, 'env');
  assert.deepEqual(r.branches, [], 'a tag carries no naming obligation');
  assert.equal(headRead, false, 'HEAD must not be consulted');
});

// --- main() end-to-end -----------------------------------------------------

test('main rejects a push whose REMOTE ref is non-conforming', () => {
  // The reviewer's bypass: HEAD is the exempt `main`, but the ref being
  // published is not compliant. Pre-fix this exited 0.
  const { code, stderr } = runMain([], {
    stdin: `refs/heads/feat/123-x ${SHA} refs/heads/random-name ${SHA}\n`,
    env: {},
    readCurrentBranch: () => 'main',
  });
  assert.equal(code, 1);
  assert.match(stderr, /random-name/);
});

test('main accepts a fully compliant push', () => {
  const { code } = runMain([], {
    stdin: `refs/heads/feat/186-x ${SHA} refs/heads/feat/186-x ${SHA}\n`,
    env: {},
    readCurrentBranch: () => 'main',
  });
  assert.equal(code, 0);
});

test('main reports every offending ref in a multi-ref push', () => {
  const { code, stderr } = runMain([], {
    stdin:
      `refs/heads/feat/186-ok ${SHA} refs/heads/feat/186-ok ${SHA}\n` +
      `refs/heads/bad-one ${SHA} refs/heads/bad-two ${SHA}\n`,
    env: {},
    readCurrentBranch: () => 'main',
  });
  assert.equal(code, 1);
  assert.match(stderr, /bad-one/);
  assert.match(stderr, /bad-two/, 'both offenders reported, not just the first');
});

test('main falls back to HEAD when no push is in flight', () => {
  // `prek run --all-files --stage pre-push` via `mise run hooks:run`.
  assert.equal(runMain([], { stdin: '', env: {}, readCurrentBranch: () => 'feat/186-x' }).code, 0);
  assert.equal(runMain([], { stdin: '', env: {}, readCurrentBranch: () => 'nope' }).code, 1);
});

test('main honours an explicit branch argument', () => {
  assert.equal(runMain(['node', 's', 'feat/186-x'], { stdin: '', env: {} }).code, 0);
  assert.equal(runMain(['node', 's', 'bogus'], { stdin: '', env: {} }).code, 1);
});

test('main exits 2 when the branch cannot be determined', () => {
  // Fail loud: a broken git invocation must not silently disable the gate.
  const { code, stderr } = runMain([], {
    stdin: '',
    env: {},
    readCurrentBranch: () => {
      throw new Error('not a git repository');
    },
  });
  assert.equal(code, 2);
  assert.match(stderr, /not a git repository/);
});

// --- reading the ref list from fd 0 ---------------------------------------

test('readRefListFromStdin returns "" without reading on a TTY', () => {
  // A blocking read on a TTY would hang the hook.
  assert.equal(
    readRefListFromStdin({
      isTTY: true,
      read: () => assert.fail('must not read fd 0 on a TTY'),
    }),
    '',
  );
});

test('readRefListFromStdin degrades to "" only for empty/closed fd 0', () => {
  for (const code of ['EAGAIN', 'EBADF']) {
    const read = () => {
      throw Object.assign(new Error(code), { code });
    };
    assert.equal(readRefListFromStdin({ isTTY: false, read }), '');
  }
});

test('readRefListFromStdin re-throws an unexpected read failure', () => {
  // Masking it would fall through to HEAD, which is exempt on `main` — i.e. it
  // would pass the gate on the strength of a failed read.
  const read = () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  };
  assert.throws(() => readRefListFromStdin({ isTTY: false, read }), /permission denied/);
});

test('main exits 2 when the ref list cannot be read', () => {
  const { code, stderr } = runMain([], {
    // No `stdin` key, so main reads fd 0 through the (stubbed) reader.
    readRefList: () => {
      throw Object.assign(new Error('input/output error'), { code: 'EIO' });
    },
    env: {},
    readCurrentBranch: () => 'main',
  });
  assert.equal(code, 2);
  assert.match(stderr, /input\/output error/);
});
