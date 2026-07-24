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
  buildIterationInstruction,
  detectNearMissMention,
  isBotAuthoredComment,
  KNOWN_EPIC_COMMANDS,
  parseCommentTrigger,
  parseRetryIntent,
} from '../../../src/handlers/shared/orchestration-comment-trigger';

describe('parseCommentTrigger', () => {
  test('mention with instruction → triggered, instruction stripped + trimmed', () => {
    const t = parseCommentTrigger('@bgagent the session timeout should be 30 min, not 60');
    expect(t.triggered).toBe(true);
    expect(t.instruction).toBe('the session timeout should be 30 min, not 60');
  });

  test('mention mid-sentence still triggers', () => {
    const t = parseCommentTrigger('Hey @bgagent please add a dark-mode toggle');
    expect(t.triggered).toBe(true);
    expect(t.instruction).toBe('Hey please add a dark-mode toggle');
  });

  test('case-insensitive', () => {
    expect(parseCommentTrigger('@BgAgent fix it').triggered).toBe(true);
  });

  test('bare mention with no text → triggered with empty instruction', () => {
    const t = parseCommentTrigger('@bgagent');
    expect(t.triggered).toBe(true);
    expect(t.instruction).toBe('');
  });

  test('no mention → not triggered (ordinary human discussion)', () => {
    expect(parseCommentTrigger('I think this looks good, merging soon').triggered).toBe(false);
  });

  test('empty / null / undefined body → not triggered', () => {
    expect(parseCommentTrigger('').triggered).toBe(false);
    expect(parseCommentTrigger(null).triggered).toBe(false);
    expect(parseCommentTrigger(undefined).triggered).toBe(false);
  });

  test('the agent\'s own progress comment (no mention) never triggers', () => {
    expect(parseCommentTrigger('🤖 Starting on the task — cloning repo now.').triggered).toBe(false);
    expect(parseCommentTrigger('✅ PR opened: https://github.com/o/r/pull/5').triggered).toBe(false);
  });

  test('token boundary: @bgagentbot and email-like do NOT trigger', () => {
    expect(parseCommentTrigger('ping @bgagentbot for help').triggered).toBe(false);
    expect(parseCommentTrigger('email me at foo@bgagent.io').triggered).toBe(false);
  });

  test('multiple mentions are all stripped', () => {
    const t = parseCommentTrigger('@bgagent do X and @bgagent also Y');
    expect(t.triggered).toBe(true);
    expect(t.instruction).toBe('do X and also Y');
  });

  // #247 UX.20 — the self-trigger infinite loop. The bot's OWN comments must
  // never re-trigger it, even when (esp. when) they contain a literal @bgagent.
  describe('self-comment guard (#247 UX.20 loop prevention)', () => {
    test('the disambiguation reply does NOT trigger, even though it embeds "@bgagent ABCA-123:"', () => {
      // This EXACT body spammed ~50 replies live: it starts with 👋 and contains
      // a literal @bgagent example, which the old regex re-matched → loop.
      const body = '👋 I couldn\'t tell which sub-issue that\'s about.\n\nOtherwise, comment on the '
        + 'specific sub-issue, or name it here — e.g. `@bgagent ABCA-123: <what to change>`. The sub-issues are:';
      expect(parseCommentTrigger(body).triggered).toBe(false);
      expect(isBotAuthoredComment(body)).toBe(true);
    });

    test('all bot template prefixes are recognized as bot-authored (never trigger)', () => {
      for (const body of [
        '👋 That could apply to more than one sub-issue…',
        '✅ Updated — PR #193.',
        '✅ **ABCA orchestration complete**',
        '❌ I made the change, but the build/tests didn\'t pass.',
        '⚠️ **ABCA orchestration finished with failures**',
        '🔄 **ABCA orchestration** · 1/3 complete',
        '🤖 Starting on this issue…',
        '🖼️ **Preview screenshot**',
        '🔗 PR opened: https://github.com/o/r/pull/9',
      ]) {
        expect(isBotAuthoredComment(body)).toBe(true);
        expect(parseCommentTrigger(body).triggered).toBe(false);
      }
    });

    test('a genuine human @bgagent comment is NOT misclassified as bot-authored', () => {
      expect(isBotAuthoredComment('@bgagent for the footer change the tagline')).toBe(false);
      expect(parseCommentTrigger('@bgagent for the footer change the tagline').triggered).toBe(true);
    });

    test('leading whitespace before a bot marker is still caught', () => {
      expect(isBotAuthoredComment('  \n✅ Updated — PR #193.')).toBe(true);
    });
  });
});

describe('buildIterationInstruction', () => {
  test('uses the comment instruction when present', () => {
    expect(buildIterationInstruction({ triggered: true, instruction: 'make the header sticky' }))
      .toBe('make the header sticky');
  });

  test('falls back to a generic directive for a bare mention', () => {
    expect(buildIterationInstruction({ triggered: true, instruction: '' }))
      .toMatch(/latest review feedback/i);
  });
});

describe('detectNearMissMention (#299 BLOCKER-2 — @abca black hole)', () => {
  test('@abca (label-name confusion) is a near-miss → nudge', () => {
    expect(detectNearMissMention('@abca approve')).toBe(true);
    expect(detectNearMissMention('hey @abca can you make it 2 tasks')).toBe(true);
    // …even with a :suffix the reviewer copied from the label.
    expect(detectNearMissMention('@abca:decompose please')).toBe(true);
  });

  test('a boundary-miss @bgagent handle is a near-miss (parseCommentTrigger deliberately skips it)', () => {
    // parseCommentTrigger's `@bgagent(?![\w.])` does NOT trigger on these …
    expect(parseCommentTrigger('ping @bgagentbot for help').triggered).toBe(false);
    // … so detectNearMissMention catches them for the nudge instead of a silent drop.
    expect(detectNearMissMention('ping @bgagentbot for help')).toBe(true);
    expect(detectNearMissMention('@bgagentx approve')).toBe(true);
  });

  test('spelled-out / hyphenated variants are near-misses', () => {
    expect(detectNearMissMention('@bg-agent approve')).toBe(true);
    expect(detectNearMissMention('@bg_agent approve')).toBe(true);
    expect(detectNearMissMention('@background-agent approve')).toBe(true);
    expect(detectNearMissMention('@bgbot approve')).toBe(true);
  });

  test('the CORRECT @bgagent handle is NOT a near-miss (it triggers normally)', () => {
    // A real trigger never reaches the near-miss branch, but assert it here too:
    // the exact token must not be flagged as a wrong handle.
    expect(detectNearMissMention('@bgagent approve')).toBe(false);
    expect(detectNearMissMention('@bgagent make it 2 tasks')).toBe(false);
  });

  test('an email-like foo@bgagent.io is NOT a near-miss (not a mention at all)', () => {
    expect(detectNearMissMention('email me at foo@bgagent.io')).toBe(false);
  });

  test('ordinary human discussion with no bot handle → not a near-miss', () => {
    expect(detectNearMissMention('this looks good, merging soon')).toBe(false);
    expect(detectNearMissMention('cc @teammate can you review')).toBe(false);
    expect(detectNearMissMention('')).toBe(false);
    expect(detectNearMissMention(null)).toBe(false);
    expect(detectNearMissMention(undefined)).toBe(false);
  });

  test("the bot's own comments are never near-misses (no self-nudge loop)", () => {
    // The wrong-mention nudge is 👋-prefixed → bot-authored → must not re-detect.
    expect(detectNearMissMention('👋 I answer to `@bgagent` — I don\'t pick up other @-names')).toBe(false);
    // A plan comment embeds a literal "@bgagent approve" example — still not a near-miss.
    expect(detectNearMissMention('🗂️ Proposed breakdown … reply `@bgagent approve`')).toBe(false);
  });
});

describe('parseRetryIntent (PM-P0-1 — retry command)', () => {
  test('bare retry phrases → true', () => {
    for (const s of ['retry', 'Retry', 're-run', 'rerun', 'try again', 'run again', 'run it again', 'retry please']) {
      expect(parseRetryIntent(s)).toBe(true);
    }
  });

  test('a retry word leading a SUBSTANTIVE edit is NOT a bare retry (routes to iterate/revise)', () => {
    // "retry the footer but change the color and spacing too" is an edit request,
    // not a bare retry — must fall through so it isn't swallowed by the retry path.
    expect(parseRetryIntent('retry the footer but change the color and spacing and margins')).toBe(false);
  });

  test('empty / non-retry instructions → false', () => {
    expect(parseRetryIntent('')).toBe(false);
    expect(parseRetryIntent('looks good, ship it')).toBe(false);
    expect(parseRetryIntent('change the header color')).toBe(false);
    // A bare @bgagent (empty instruction) is "address latest review", never a retry.
    expect(parseRetryIntent('   ')).toBe(false);
  });

  test('markdown emphasis around the word is tolerated', () => {
    expect(parseRetryIntent('`retry`')).toBe(true);
    expect(parseRetryIntent('**retry**')).toBe(true);
  });

  test('KNOWN_EPIC_COMMANDS lists retry (kept in sync with the parser + panel copy)', () => {
    expect(KNOWN_EPIC_COMMANDS).toContain('retry');
  });
});
