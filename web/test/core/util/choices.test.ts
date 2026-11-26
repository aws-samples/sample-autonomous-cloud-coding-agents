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

import { describe, expect, it } from 'vitest';
import { choiceOptions, parseChoice } from '../../../src/core/util/choices';

const RANGES = { week: 'Last 7 days', month: 'Last 30 days' } as const;

describe('parseChoice', () => {
  it('takes the choice the URL names', () => {
    expect(parseChoice('week', RANGES, 'month')).toBe('week');
  });

  it.each([null, '', 'year', 'WEEK', 'constructor', 'toString'])('falls back when the URL has %s', (value) => {
    expect(parseChoice(value, RANGES, 'month')).toBe('month');
  });
});

describe('choiceOptions', () => {
  it('lists the choices in the order they are declared', () => {
    expect(choiceOptions(RANGES)).toEqual([{ id: 'week', text: 'Last 7 days' }, { id: 'month', text: 'Last 30 days' }]);
  });
});
