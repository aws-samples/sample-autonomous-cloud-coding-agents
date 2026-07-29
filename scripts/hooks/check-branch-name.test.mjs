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
import { validateBranchName } from './check-branch-name.mjs';

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
