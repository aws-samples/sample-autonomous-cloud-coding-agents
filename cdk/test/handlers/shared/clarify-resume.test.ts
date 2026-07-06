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
  buildClarifyResumeDescription,
  isClarifyHold,
  type ClarifyHoldRow,
} from '../../../src/handlers/shared/clarify-resume';

/** A canonical clarify-HOLD row: new-task-v1 that paused with a question. */
function hold(overrides: Partial<ClarifyHoldRow> = {}): ClarifyHoldRow {
  return {
    resolved_workflow: { id: 'coding/new-task-v1' },
    code_changed: false,
    answer_text: 'Which environment should this deploy to — staging or prod?',
    task_description: 'Wire up the deploy button.',
    ...overrides,
  };
}

describe('isClarifyHold', () => {
  test('recognises the canonical clarify-hold (new-task-v1, no code, question, no PR)', () => {
    expect(isClarifyHold(hold())).toBe(true);
  });

  test('accepts a raw workflow_ref (versioned or bare) when the pin is absent', () => {
    expect(isClarifyHold(hold({ resolved_workflow: null, workflow_ref: 'coding/new-task-v1' }))).toBe(true);
    expect(isClarifyHold(hold({ resolved_workflow: null, workflow_ref: 'coding/new-task-v1@3' }))).toBe(true);
  });

  test('rejects a running task (code_changed unset until terminal)', () => {
    expect(isClarifyHold(hold({ code_changed: undefined }))).toBe(false);
  });

  test('rejects a task that actually shipped code (code_changed=true)', () => {
    expect(isClarifyHold(hold({ code_changed: true }))).toBe(false);
  });

  test('rejects a no-op PR ITERATION (has a PR — the reconciler/fanout owns that reply)', () => {
    // A pr-iteration-v1 that answered without changing code shares
    // code_changed=false + answer_text, but it has a PR and a different
    // workflow — must NOT be treated as a resumable clarify-hold.
    expect(isClarifyHold(hold({
      resolved_workflow: { id: 'coding/pr-iteration-v1' },
      pr_url: 'https://github.com/o/r/pull/7',
      pr_number: 7,
    }))).toBe(false);
    // Even a new-task-v1 row with a PR is not a hold (it shipped something).
    expect(isClarifyHold(hold({ pr_url: 'https://github.com/o/r/pull/9' }))).toBe(false);
    expect(isClarifyHold(hold({ pr_number: 9 }))).toBe(false);
  });

  test('rejects a plain failure / completion with no question text', () => {
    expect(isClarifyHold(hold({ answer_text: undefined }))).toBe(false);
    expect(isClarifyHold(hold({ answer_text: '   ' }))).toBe(false);
  });

  test('rejects null / undefined rows', () => {
    expect(isClarifyHold(null)).toBe(false);
    expect(isClarifyHold(undefined)).toBe(false);
  });
});

describe('buildClarifyResumeDescription', () => {
  test('carries the original ask, the question, and the answer in order', () => {
    const md = buildClarifyResumeDescription(
      'Wire up the deploy button.',
      'Which environment — staging or prod?',
      'staging',
    );
    // Original intent first so the agent reads "do the original thing, now resolved".
    expect(md.indexOf('Wire up the deploy button.')).toBeLessThan(md.indexOf('You asked:'));
    expect(md).toContain('You asked: Which environment — staging or prod?');
    expect(md).toContain('The reviewer answered: staging');
    expect(md).toMatch(/proceed with the original request/i);
  });

  test('degrades to just the exchange when the original description is blank', () => {
    const md = buildClarifyResumeDescription(undefined, 'Q?', 'A');
    expect(md).toContain('You asked: Q?');
    expect(md).toContain('The reviewer answered: A');
  });

  test('still includes the answer when the held question is missing', () => {
    const md = buildClarifyResumeDescription('Do the thing.', undefined, 'yes, all of it');
    expect(md).toContain('Do the thing.');
    expect(md).not.toContain('You asked:');
    expect(md).toContain('The reviewer answered: yes, all of it');
  });
});
