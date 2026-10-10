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
import { validateCommitMessage } from './check-commit-msg.mjs';

// ADR-003 Tier 0: a commit message must carry an issue reference —
// `Refs #N`, `Fixes #N`, or `Closes #N` (case-insensitive, GitHub's own
// closing-keyword family). These accept anywhere in the message body.

test('accepts a message with Closes #N', () => {
  const r = validateCommitMessage('feat(x): thing\n\nBody\n\nCloses #186\n');
  assert.equal(r.ok, true);
});

test('accepts a message with Fixes #N', () => {
  const r = validateCommitMessage('fix: bug\n\nFixes #42');
  assert.equal(r.ok, true);
});

test('accepts a message with Refs #N', () => {
  const r = validateCommitMessage('chore: tidy\n\nRefs #7');
  assert.equal(r.ok, true);
});

test('rejects a bare (#N) with no keyword even on the subject line', () => {
  const r = validateCommitMessage('docs: update guide (#191)');
  // Bare (#N) alone is NOT a governance keyword — must be Refs/Fixes/Closes.
  assert.equal(r.ok, false);
});

test('accepts the keyword+reference on the subject line', () => {
  const r = validateCommitMessage('docs: update guide, Closes #191');
  assert.equal(r.ok, true);
});

test('accepts GitHub closing synonyms (Resolves, Close, Fix, Ref)', () => {
  for (const kw of ['Resolves', 'Resolve', 'Close', 'Closed', 'Fix', 'Fixed', 'Ref']) {
    const r = validateCommitMessage(`feat: x\n\n${kw} #99`);
    assert.equal(r.ok, true, `expected "${kw} #99" to pass`);
  }
});

test('is case-insensitive on the keyword', () => {
  const r = validateCommitMessage('feat: x\n\ncloses #12');
  assert.equal(r.ok, true);
});

test('rejects a message with no issue reference', () => {
  const r = validateCommitMessage('feat: add a thing without any reference');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Refs #N|Fixes #N|Closes #N/);
});

test('rejects a bare "#186" without a keyword', () => {
  const r = validateCommitMessage('feat: mentions #186 in prose but no keyword');
  assert.equal(r.ok, false);
});

test('rejects an empty message', () => {
  const r = validateCommitMessage('');
  assert.equal(r.ok, false);
});

test('ignores comment lines (git # comments) when scanning', () => {
  // Lines beginning with '#' are git scissors/comments and are stripped by
  // git before the commit is stored; a keyword hidden only in a comment must
  // NOT satisfy the gate.
  const r = validateCommitMessage('feat: x\n\n# Closes #5 (this is a comment)\n');
  assert.equal(r.ok, false);
});

test('accepts owner/repo#N cross-repo references', () => {
  const r = validateCommitMessage('fix: x\n\nFixes aws-samples/sample#3');
  assert.equal(r.ok, true);
});

test('accepts the GH-N reference form', () => {
  // Documented accepted form (source comment): `#N`, `GH-N`, or `owner/repo#N`.
  const r = validateCommitMessage('fix: x\n\nFixes GH-42');
  assert.equal(r.ok, true);
});

test('rejects keyword with no separator (Closes#5)', () => {
  // The `\s+` between keyword and reference is deliberate — no space, no match.
  assert.equal(validateCommitMessage('feat: x\n\nCloses#5').ok, false);
});

test('rejects a keyword embedded in a longer word (refixes)', () => {
  // Word boundary (\b) prevents matching a keyword inside another token.
  assert.equal(validateCommitMessage('feat: x\n\nrefixes #5').ok, false);
});

test('exempts a merge commit (auto-generated subject, no issue ref)', () => {
  // `git merge origin/main` — which CONTRIBUTING tells contributors to run —
  // produces this subject with no issue link and must not be blocked.
  const r = validateCommitMessage(
    "Merge remote-tracking branch 'origin/main' into feat/186-adr003-hooks\n",
  );
  assert.equal(r.ok, true);
});

test('exempts a revert commit', () => {
  const r = validateCommitMessage('Revert "feat: something"\n\nThis reverts commit abc123.');
  assert.equal(r.ok, true);
});

test('exempts fixup!/squash!/amend! commits', () => {
  for (const prefix of ['fixup! feat: x', 'squash! fix: y', 'amend! chore: z']) {
    assert.equal(validateCommitMessage(prefix).ok, true, `expected "${prefix}" to be exempt`);
  }
});

test('does NOT exempt a normal commit whose body merely mentions "merge"', () => {
  // Exemption keys off the SUBJECT line only, not incidental "merge" in prose.
  const r = validateCommitMessage('feat: teach the merge helper a trick\n\nno reference here');
  assert.equal(r.ok, false);
});

// The exemption is scoped to the subjects git itself emits. An authored subject
// that merely STARTS with "Merge"/"Revert"/"squash" is contribution work and
// must still carry an issue reference (#679 review).
test('exempts every auto-generated merge subject form git emits', () => {
  const generated = [
    "Merge branch 'main'",
    "Merge branch 'main' into feat/186-adr003-hooks",
    "Merge branch 'main' of github.com:aws-samples/sample-autonomous-cloud-coding-agents",
    "Merge branches 'a' and 'b'", // octopus merge — plural
    "Merge remote-tracking branch 'origin/main'",
    "Merge tag 'v1.2.3'",
    "Merge commit 'abc1234'",
    'Merge pull request #12 from owner/feat/9-x', // GitHub — has #N but no keyword
  ];
  for (const subject of generated) {
    assert.equal(
      validateCommitMessage(`${subject}\n`).ok,
      true,
      `expected "${subject}" to be exempt`,
    );
  }
});

test('does NOT exempt an authored subject that merely starts with Merge/Revert', () => {
  const authored = [
    'Merge behavior for schema handling',
    'Revert reviewer nudge copy', // git revert always quotes: `Revert "..."`
    'Merged the two resolvers',
    'Reverting the earlier approach',
  ];
  for (const subject of authored) {
    assert.equal(
      validateCommitMessage(`${subject}\n\nno reference here`).ok,
      false,
      `expected "${subject}" to be gated`,
    );
  }
});

test('does NOT exempt an authored subject resembling an autosquash prefix', () => {
  // The required space after fixup!/squash!/amend! keeps these gated.
  for (const subject of ['squashed the bug', 'fixup the layout', 'amendment to the guide']) {
    assert.equal(
      validateCommitMessage(`${subject}\n\nno reference here`).ok,
      false,
      `expected "${subject}" to be gated`,
    );
  }
});

test('an exempt merge subject still passes when it does carry a reference', () => {
  // Exemption short-circuits; a referenced merge must not regress to a failure.
  assert.equal(validateCommitMessage("Merge branch 'main'\n\nRefs #186").ok, true);
});

test('handles CRLF line endings (comment stripped, body ref survives)', () => {
  // Real COMMIT_EDITMSG files may carry \r\n (Windows / core.autocrlf).
  assert.equal(validateCommitMessage('feat: x\r\n\r\nCloses #7\r\n').ok, true);
  // A ref that appears ONLY in a CRLF comment line must not count.
  assert.equal(validateCommitMessage('feat: x\r\n\r\n# Closes #7\r\n').ok, false);
});
