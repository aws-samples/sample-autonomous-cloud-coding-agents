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

import { formatDuration, truncate } from '../../../src/handlers/shared/slack-format';

describe('truncate', () => {
  test('returns string unchanged when under limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  test('truncates and appends ellipsis when over limit', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  test('returns string unchanged when exactly at limit', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });
});

describe('formatDuration', () => {
  test('sub-minute rounds to whole seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45.4)).toBe('45s');
    expect(formatDuration(59)).toBe('59s');
  });

  test('minute range uses m or m s format', () => {
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(65)).toBe('1m 5s');
    expect(formatDuration(3599)).toBe('59m 59s');
  });

  test('hour range uses h or h m format', () => {
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(3660)).toBe('1h 1m');
    expect(formatDuration(7320)).toBe('2h 2m');
  });

  test('coerces DynamoDB numeric strings via Number()', () => {
    // DynamoDB may round-trip numeric attributes as strings; Number() coerces them.
    expect(formatDuration('90' as unknown as number)).toBe('1m 30s');
    expect(formatDuration('3600' as unknown as number)).toBe('1h');
  });
});
