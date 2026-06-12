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
  parseCommentTrigger,
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
