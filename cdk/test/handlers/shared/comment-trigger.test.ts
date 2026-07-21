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
  isKnownAbcaComment,
  parseCommentTrigger,
} from '../../../src/handlers/shared/comment-trigger';

describe('parseCommentTrigger', () => {
  test('extracts instruction text after a token-bounded mention', () => {
    expect(parseCommentTrigger('Please @bgagent update the README too')).toEqual({
      triggered: true,
      instruction: 'Please update the README too',
    });
  });

  test('matches case-insensitively and removes every occurrence', () => {
    expect(parseCommentTrigger('@BgAgent do X and @bgagent also Y')).toEqual({
      triggered: true,
      instruction: 'do X and also Y',
    });
  });

  test('preserves multiline reviewer instructions', () => {
    expect(parseCommentTrigger('@bgagent please:\n- update docs\n- add a test')).toEqual({
      triggered: true,
      instruction: 'please:\n- update docs\n- add a test',
    });
  });

  test('accepts a bare mention with an empty instruction', () => {
    expect(parseCommentTrigger('@bgagent')).toEqual({
      triggered: true,
      instruction: '',
    });
  });

  test.each([
    'ping @bgagentbot',
    'email foo@bgagent.io',
    'handle-like prefix foo@bgagent fix it',
    'ordinary human discussion',
    '',
  ])('does not trigger on %p', (body) => {
    expect(parseCommentTrigger(body).triggered).toBe(false);
  });

  test.each([
    '🤖 ABCA started. Example: @bgagent fix it',
    '✅ Task completed. @bgagent',
    '❌ ABCA could not create the task. @bgagent retry',
    '👀 ABCA accepted this follow-up. @bgagent',
  ])('does not trigger on known ABCA-rendered comment %p', (body) => {
    expect(parseCommentTrigger(body).triggered).toBe(false);
    expect(isKnownAbcaComment(body)).toBe(true);
  });

  test('does not treat a human status emoji as proof that ABCA authored the comment', () => {
    expect(parseCommentTrigger('✅ @bgagent ship the documentation update')).toEqual({
      triggered: true,
      instruction: '✅ ship the documentation update',
    });
  });
});

describe('buildIterationInstruction', () => {
  test('uses explicit reviewer instructions', () => {
    expect(buildIterationInstruction({ triggered: true, instruction: 'Rename the flag' }))
      .toBe('Rename the flag');
  });

  test('uses review-feedback fallback for a bare mention', () => {
    expect(buildIterationInstruction({ triggered: true, instruction: '' }))
      .toBe('Address the latest review feedback on this pull request.');
  });
});
