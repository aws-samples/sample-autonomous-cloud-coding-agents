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
  preservePreviewSuffix,
  renderIterationSuccessReply,
  renderMaturingReply,
  renderPreviewBlock,
} from '../../../src/handlers/shared/iteration-reply';

describe('renderMaturingReply — the edit-in-place states', () => {
  test('on_it → instant ack (no metadata)', () => {
    expect(renderMaturingReply({ state: 'on_it' })).toBe('👀 On it — reading the PR…');
  });

  test('working → names the PR being updated', () => {
    expect(renderMaturingReply({ state: 'working', prNumber: 293 })).toBe('🔄 Working — updating PR #293…');
    expect(renderMaturingReply({ state: 'working' })).toBe('🔄 Working…');
  });

  test('a PR url makes the reference a clickable markdown link', () => {
    const w = renderMaturingReply({ state: 'working', prNumber: 293, prUrl: 'https://gh/pull/293' });
    expect(w).toBe('🔄 Working — updating [PR #293](https://gh/pull/293)…');
    const u = renderMaturingReply({ state: 'updated', prNumber: 293, prUrl: 'https://gh/pull/293' });
    expect(u).toContain('✅ Updated — [PR #293](https://gh/pull/293).');
  });

  test('updated → ✅ + cost · duration · running total + clickable preview thumbnail', () => {
    const r = renderMaturingReply({
      state: 'updated',
      prNumber: 293,
      costUsd: 0.79,
      durationS: 309,
      runningTotalUsd: 2.04,
      screenshotUrl: 'https://cdn/x.png',
      deployUrl: 'https://app.vercel.app',
    });
    expect(r).toContain('✅ Updated — PR #293.');
    expect(r).toContain('$0.79');
    expect(r).toContain('5m 9s');
    expect(r).toContain('total this PR: $2.04');
    // Clickable image thumbnail: screenshot PNG embedded, linking to the deploy.
    expect(r).toContain('[![preview](https://cdn/x.png)](https://app.vercel.app)');
  });

  test('updated with screenshot but NO deploy url → plain embedded image (no link target)', () => {
    const r = renderMaturingReply({ state: 'updated', prNumber: 7, screenshotUrl: 'https://cdn/y.png' });
    expect(r).toContain('![preview](https://cdn/y.png)');
    expect(r).not.toContain('[![preview]'); // not a link when no deploy url
  });

  test('updated with NO screenshot → no preview block at all', () => {
    const r = renderMaturingReply({ state: 'updated', prNumber: 7, costUsd: 0.1 });
    expect(r).not.toContain('preview');
    expect(r).toContain('✅ Updated — PR #7.');
  });

  test('answered → 💬 + the answer + cost (a question, no commit)', () => {
    const r = renderMaturingReply({ state: 'answered', answerText: 'The login page is at /login.html', costUsd: 0.24 });
    expect(r).toContain('💬 The login page is at /login.html');
    expect(r).toContain('$0.24');
    expect(r).not.toContain('Updated');
  });

  test('answered with no answer → honest no-change line', () => {
    expect(renderMaturingReply({ state: 'answered' })).toContain('No code change was needed');
  });

  test('failed → ❌ + sanitized reason', () => {
    expect(renderMaturingReply({ state: 'failed', failureReason: 'build failed: tsc error' }))
      .toContain('❌ build failed: tsc error');
  });

  test('terminal metadata line omits unknown parts gracefully', () => {
    // Only cost known → no duration, no total, no empty separators.
    const r = renderMaturingReply({ state: 'updated', prNumber: 1, costUsd: 0.5 });
    expect(r).toContain('$0.50');
    expect(r).not.toContain('total this PR');
    expect(r).not.toMatch(/·\s*·/); // no doubled separators
  });

  test('on_it / working never carry a metadata line', () => {
    expect(renderMaturingReply({ state: 'on_it', costUsd: 1 })).not.toContain('$');
    expect(renderMaturingReply({ state: 'working', costUsd: 1, prNumber: 2 })).not.toContain('$');
  });
});

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
    // Cap is MAX_ANSWER_CHARS=2000 (aligned with the agent's persist cap so the
    // renderer never drops chars the agent already bounded); '💬 ' prefix + ellipsis.
    expect(r.length).toBeLessThanOrEqual(2003);
    expect(r.length).toBeGreaterThan(1700);
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

describe('preservePreviewSuffix — converge the two async writers (ABCA-434 race)', () => {
  const PNG = 'https://cdn.example/screenshots/x.png';
  const DEPLOY = 'https://app.vercel.app';
  const BLOCK = `[![preview](${PNG})](${DEPLOY})`;

  test('carries an already-landed clickable thumbnail from current onto the new body', () => {
    // The screenshot webhook appended the block; this terminal re-render would
    // otherwise drop it. Convergence re-attaches the EXACT block on its own line.
    const current = `✅ Updated — [PR #5](u). _$0.1_\n\n${BLOCK}`;
    const newBody = '✅ Updated — [PR #5](u). _$0.2 · 35s · total this PR: $0.5_';
    expect(preservePreviewSuffix(newBody, current)).toBe(`${newBody}\n\n${BLOCK}`);
  });

  test('preserves a plain embed too (screenshot, no deploy link)', () => {
    const current = `✅ Updated.\n\n![preview](${PNG})`;
    const newBody = '✅ Updated — [PR #5](u). _$0.2_';
    expect(preservePreviewSuffix(newBody, current)).toBe(`${newBody}\n\n![preview](${PNG})`);
  });

  test('no-op when the new body already carries its own preview (settle-after-append)', () => {
    const current = `✅ Updated.\n\n${BLOCK}`;
    const newBody = `✅ Updated — [PR #5](u).\n\n${BLOCK}`;
    expect(preservePreviewSuffix(newBody, current)).toBe(newBody); // not doubled
  });

  test('no-op when current has no preview (the common no-deploy case)', () => {
    const current = '👀 On it — reading the PR…';
    const newBody = '✅ Updated — [PR #5](u). _$0.2_';
    expect(preservePreviewSuffix(newBody, current)).toBe(newBody);
  });

  test('null/undefined current → returns new body unchanged', () => {
    expect(preservePreviewSuffix('✅ Updated.', null)).toBe('✅ Updated.');
    expect(preservePreviewSuffix('✅ Updated.', undefined)).toBe('✅ Updated.');
  });

  test('idempotent across repeated settles', () => {
    const newBody = '✅ Updated — [PR #5](u). _$0.2_';
    const once = preservePreviewSuffix(newBody, `x\n\n${BLOCK}`);
    const twice = preservePreviewSuffix(once, once); // current now already has it
    expect(twice).toBe(once);
  });
});

describe('renderPreviewBlock — clickable thumbnail vs plain embed', () => {
  test('both urls → clickable image thumbnail', () => {
    expect(renderPreviewBlock('https://cdn/s.png', 'https://deploy')).toBe('[![preview](https://cdn/s.png)](https://deploy)');
  });
  test('screenshot only → plain embed', () => {
    expect(renderPreviewBlock('https://cdn/s.png')).toBe('![preview](https://cdn/s.png)');
    expect(renderPreviewBlock('https://cdn/s.png', null)).toBe('![preview](https://cdn/s.png)');
  });
  test('no screenshot → empty', () => {
    expect(renderPreviewBlock(null, 'https://deploy')).toBe('');
    expect(renderPreviewBlock(undefined)).toBe('');
  });
});
