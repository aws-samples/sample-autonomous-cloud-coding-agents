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

import {
  isNoChangeIteration,
  renderIterationSuccessReply,
} from '../../../src/handlers/shared/iteration-reply';

describe('renderIterationSuccessReply — changed (a real edit)', () => {
  test('code changed + PR number → "✅ Updated — PR #N"', () => {
    expect(renderIterationSuccessReply({ codeChanged: true, prNumber: 290 }))
      .toBe('✅ Updated — PR #290.');
  });

  test('code changed + no PR number → "✅ Updated."', () => {
    expect(renderIterationSuccessReply({ codeChanged: true, prNumber: null }))
      .toBe('✅ Updated.');
  });

  test('codeChanged UNDEFINED (pre-fix / non-PR) → back-compat "✅ Updated — PR #N"', () => {
    // The whole point of the back-compat default: anything that doesn't opt in
    // behaves exactly as before.
    expect(renderIterationSuccessReply({ prNumber: 178 })).toBe('✅ Updated — PR #178.');
    expect(renderIterationSuccessReply({})).toBe('✅ Updated.');
  });

  test('an answer is IGNORED when code changed (the PR link is the signal)', () => {
    expect(renderIterationSuccessReply({ codeChanged: true, prNumber: 5, answerText: 'irrelevant' }))
      .toBe('✅ Updated — PR #5.');
  });
});

describe('renderIterationSuccessReply — no change (a question)', () => {
  test('no change + an answer → "💬 <answer>" (NOT a false ✅ Updated)', () => {
    const r = renderIterationSuccessReply({
      codeChanged: false,
      prNumber: 290,
      answerText: 'The login page is at /login.html, but it is not yet linked from the nav.',
    });
    expect(r).toBe('💬 The login page is at /login.html, but it is not yet linked from the nav.');
    expect(r).not.toContain('Updated');
    expect(r).not.toContain('290'); // a question reply must not imply a PR update
  });

  test('no change + NO answer → an honest "no change needed" (still not ✅ Updated)', () => {
    const r = renderIterationSuccessReply({ codeChanged: false, prNumber: 290 });
    expect(r).toContain('No code change');
    expect(r).not.toContain('✅');
  });

  test('a long answer is truncated with an ellipsis', () => {
    const long = 'x'.repeat(5000);
    const r = renderIterationSuccessReply({ codeChanged: false, answerText: long });
    expect(r.length).toBeLessThan(1700);
    expect(r.endsWith('…')).toBe(true);
  });

  test('whitespace-only answer falls back to the honest no-change line', () => {
    const r = renderIterationSuccessReply({ codeChanged: false, answerText: '   ' });
    expect(r).toContain('No code change');
  });
});

describe('isNoChangeIteration', () => {
  test('only false counts as no-change (undefined/true do not)', () => {
    expect(isNoChangeIteration(false)).toBe(true);
    expect(isNoChangeIteration(true)).toBe(false);
    expect(isNoChangeIteration(undefined)).toBe(false);
  });
});
