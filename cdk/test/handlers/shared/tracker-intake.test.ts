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

import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { logger } from '../../../src/handlers/shared/logger';
import {
  appendAdvisorySection,
  buildCreateTaskFailureMessage,
  COMMENT_TRUNCATION_NOTICE,
  screenAdvisoryOrDrop,
} from '../../../src/handlers/shared/tracker-intake';

describe('screenAdvisoryOrDrop', () => {
  const send = jest.fn();
  const guardrail = { bedrockClient: { send } as unknown as BedrockRuntimeClient, guardrailId: 'gr-1', guardrailVersion: '7' };
  const render = jest.fn((items: readonly string[]) => `block:${items.join(',')}`);
  const opts = { guardrail, what: 'Test comments', metricSource: 'jira-comments' as const, logFields: { issue_key: 'ENG-1' } };
  const items = ['a', 'b'];
  let warn: jest.SpyInstance;
  let stdout: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('an empty list comes back as it is, without a call', async () => {
    const none: string[] = [];

    expect(await screenAdvisoryOrDrop(none, render, opts)).toBe(none);
    expect(render).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test('without a guardrail the items are dropped, never passed on unscreened', async () => {
    expect(await screenAdvisoryOrDrop(items, render, { ...opts, guardrail: undefined })).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Dropping Test comments: guardrail not configured to screen them', { issue_key: 'ENG-1' });
  });

  test('the rendered block is screened as one input text, and the items come back when it passes', async () => {
    send.mockResolvedValueOnce({ action: 'NONE' });

    expect(await screenAdvisoryOrDrop(items, render, opts)).toBe(items);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual({
      guardrailIdentifier: 'gr-1',
      guardrailVersion: '7',
      source: 'INPUT',
      content: [{ text: { text: 'block:a,b' } }],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test('a blocked block drops the items and counts nothing', async () => {
    send.mockResolvedValueOnce({ action: 'GUARDRAIL_INTERVENED' });

    expect(await screenAdvisoryOrDrop(items, render, opts)).toEqual([]);
    expect(warn).toHaveBeenCalledWith('Dropping Test comments: blocked by content policy (task still proceeds)', { issue_key: 'ENG-1' });
    expect(stdout).not.toHaveBeenCalled();
  });

  test('a failed screening call drops the items and counts one WebhookScreeningFailed', async () => {
    send.mockRejectedValueOnce(new Error('throttled'));

    expect(await screenAdvisoryOrDrop(items, render, opts)).toEqual([]);
    expect(warn).toHaveBeenCalledWith('Dropping Test comments: screening unavailable (task still proceeds)', {
      issue_key: 'ENG-1',
      error: 'throttled',
    });
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({ WebhookScreeningFailed: 1, source: 'jira-comments' });
  });
});

describe('appendAdvisorySection', () => {
  const LIMIT = 10_000;
  const NOTICE = COMMENT_TRUNCATION_NOTICE;

  test('a section that fits is appended on a new line', () => {
    expect(appendAdvisorySection('base', 'section', NOTICE)).toBe('base\nsection');
  });

  test('a section of exactly the remaining length is taken whole', () => {
    const section = 's'.repeat(9);

    const out = appendAdvisorySection('b'.repeat(LIMIT - 10), section, NOTICE);

    expect(out).toHaveLength(LIMIT);
    expect(out.endsWith(`\n${section}`)).toBe(true);
  });

  test('a longer section is cut to what is left and closed with the notice', () => {
    const out = appendAdvisorySection('b'.repeat(LIMIT - 100), `start${'s'.repeat(500)}`, NOTICE);

    expect(out).toHaveLength(LIMIT);
    expect(out).toContain('\nstart');
    expect(out.endsWith(`s${NOTICE}`)).toBe(true);
  });

  test.each([
    ['only the notice would fit', LIMIT - 1 - NOTICE.length],
    ['the base fills the limit', LIMIT],
    ['the base is past the limit', LIMIT + 5],
  ])('the section is left out when %s', (_case, baseLength) => {
    const base = 'b'.repeat(baseLength);

    expect(appendAdvisorySection(base, 's'.repeat(500), NOTICE)).toBe(base);
  });
});

describe('buildCreateTaskFailureMessage', () => {
  const body = (message: string) => JSON.stringify({ error: { code: 'X', message } });

  test.each([
    ['a refusal with a reason', 400, body('  Task description was blocked by content policy  '), undefined,
      "❌ ABCA couldn't accept this task: Task description was blocked by content policy"],
    ['an outage, with the default hint', 503, body('ignored'), undefined,
      '❌ ABCA is temporarily unavailable (status 503). Please re-apply the trigger label in a few minutes.'],
    ['an outage, with the caller\'s hint', 503, '', 'Please re-comment in a few minutes.',
      '❌ ABCA is temporarily unavailable (status 503). Please re-comment in a few minutes.'],
    ['another status with a reason', 409, body('Duplicate'), undefined, "❌ ABCA couldn't create this task (status 409): Duplicate"],
    ['a refusal without a reason', 400, body('   '), undefined,
      "❌ ABCA couldn't create this task (status 400). Check the ABCA admin logs for details."],
    ['a body that is not JSON', 500, '<html>', undefined,
      "❌ ABCA couldn't create this task (status 500). Check the ABCA admin logs for details."],
  ])('%s', (_case, status, raw, hint, expected) => {
    expect(buildCreateTaskFailureMessage(status, raw, hint)).toBe(expected);
  });
});
