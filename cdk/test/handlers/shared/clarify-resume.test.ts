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
    expect(isClarifyHold(hold({
      resolved_workflow: { id: 'coding/pr-iteration-v1' },
      pr_url: 'https://github.com/o/r/pull/7',
      pr_number: 7,
    }))).toBe(false);
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

  test('cuts an original that fills the description limit, never the exchange', () => {
    const md = buildClarifyResumeDescription('x'.repeat(10_000), 'Which environment?', 'staging');
    expect(md.length).toBeLessThanOrEqual(10_000);
    expect(md.startsWith('xxx')).toBe(true);
    expect(md).toContain('You asked: Which environment?');
    expect(md).toContain('The reviewer answered: staging');
    expect(md).toMatch(/Proceed with the original request using this answer\.$/);
  });

  test('keeps the answer of an earlier round when a second question is answered', () => {
    const first = buildClarifyResumeDescription('x'.repeat(10_000), 'Which environment?', 'staging');
    const md = buildClarifyResumeDescription(first, 'Which region?', 'eu-west-1');
    expect(md.length).toBeLessThanOrEqual(10_000);
    expect(md.startsWith('xxx')).toBe(true);
    expect(md).toContain('The reviewer answered: staging');
    expect(md.indexOf('The reviewer answered: staging')).toBeLessThan(md.indexOf('You asked: Which region?'));
    expect(md).toContain('The reviewer answered: eu-west-1');
  });

  const FOLLOW_UP = [
    '---',
    'An earlier run on this issue ended without a pull request.',
    'The reviewer now asks: retry, but only the SAML part: skip OIDC',
  ].join('\n');
  const EXCHANGE = [
    '---',
    'This continues an earlier run that paused to ask a clarifying question.',
    'You asked: Which IdP?',
    'The reviewer answered: Okta',
    'Proceed with the original request using this answer.',
  ].join('\n');

  test.each([10_000, 9_831])(
    'keeps the request of a follow-up comment whole (a description of %d characters)',
    (length) => {
      const description = `${'x'.repeat(length - FOLLOW_UP.length - 2)}\n\n${FOLLOW_UP}`;
      const md = buildClarifyResumeDescription(description, 'Which IdP?', 'Okta');
      expect(md.slice(md.indexOf('\n\n---\n'))).toBe(`\n\n${FOLLOW_UP}\n\n${EXCHANGE}`);
      expect(md.startsWith('xxx')).toBe(true);
      expect(md.length).toBe(10_000);
    },
  );

  test('keeps a follow-up request and every answer through further rounds', () => {
    const followUp = `${'x'.repeat(10_000 - FOLLOW_UP.length - 2)}\n\n${FOLLOW_UP}`;
    const first = buildClarifyResumeDescription(followUp, 'Which IdP?', 'Okta');
    const md = buildClarifyResumeDescription(first, 'Which tenant?', 'the EU one');
    expect(md.slice(md.indexOf('\n\n---\n'))).toBe([
      '',
      '',
      FOLLOW_UP,
      '',
      EXCHANGE,
      '',
      '---',
      'This continues an earlier run that paused to ask a clarifying question.',
      'You asked: Which tenant?',
      'The reviewer answered: the EU one',
      'Proceed with the original request using this answer.',
    ].join('\n'));
    expect(md.length).toBe(10_000);
  });

  test('changes nothing in a description that fits, also in front of a follow-up request', () => {
    const description = `ABC-42: Fix the login bug \n\n${FOLLOW_UP}`;
    expect(buildClarifyResumeDescription(description, 'Which IdP?', 'Okta'))
      .toBe(`${description}\n\n${EXCHANGE}`);
  });

  test('leaves exchanges that exceed the limit on their own whole, for createTaskCore to refuse', () => {
    const first = buildClarifyResumeDescription(undefined, 'q'.repeat(2_000), 'a'.repeat(3_000));
    const md = buildClarifyResumeDescription(first, 'r'.repeat(2_000), 'b'.repeat(3_000));
    expect(md.startsWith(`${first}\n\n---\n`)).toBe(true);
    expect(md.length).toBeGreaterThan(10_000);
  });

  test.each([
    ['in the middle of an emoji', '', 9_999],
    ['between two emoji', 'x', 10_000],
  ])('never keeps half of a character when the cut falls %s', (_where, pad, length) => {
    // Half of a UTF-16 surrogate pair is encoded to UTF-8 as U+FFFD.
    const md = buildClarifyResumeDescription(`${pad}${'😀'.repeat(5_000)}`, 'Which environment?', 'staging');
    expect(Buffer.from(md, 'utf8').toString('utf8') === md).toBe(true);
    expect(md.length).toBe(length);
  });
});
