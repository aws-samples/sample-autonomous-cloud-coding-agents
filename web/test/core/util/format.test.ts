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
import { formatCost, formatDuration, formatRelativeTime, shortId, taskTitle } from '../../../src/core/util/format';

const NOW = new Date('2026-10-23T12:00:00.000Z');

describe('formatRelativeTime', () => {
  it.each([
    ['2026-10-23T11:59:55.000Z', '5s ago'],
    ['2026-10-23T11:57:00.000Z', '3m ago'],
    ['2026-10-23T10:00:00.000Z', '2h ago'],
    ['2026-10-19T12:00:00.000Z', '4d ago'],
    ['2026-10-23T12:03:00.000Z', 'in 3m'],
  ])('%s -> %s', (iso, expected) => {
    expect(formatRelativeTime(iso, NOW)).toBe(expected);
  });

  it('renders missing or invalid input as a dash', () => {
    expect(formatRelativeTime(null, NOW)).toBe('-');
    expect(formatRelativeTime('not a date', NOW)).toBe('-');
  });
});

describe('formatDuration', () => {
  it.each([
    [45, '45s'],
    [723, '12m 3s'],
    [7500, '2h 5m'],
  ])('%d -> %s', (s, expected) => {
    expect(formatDuration(s)).toBe(expected);
  });

  it('renders missing or negative input as a dash', () => {
    expect(formatDuration(null)).toBe('-');
    expect(formatDuration(-1)).toBe('-');
  });
});

describe('formatCost and shortId', () => {
  it('formats dollars with two decimals', () => {
    expect(formatCost(2.305)).toBe('$2.31');
    expect(formatCost(null)).toBe('-');
  });

  it('keeps the last eight characters of long ids', () => {
    expect(shortId('01JF3KQZ8X00000000RUNNING1')).toBe('RUNNING1');
    expect(shortId('abc')).toBe('abc');
  });
});

describe('taskTitle', () => {
  const base = { task_description: null, issue_number: null, issue_title: null };

  it('names an issue task after the issue, even when it has extra guidance', () => {
    expect(taskTitle({ ...base, issue_number: 3, issue_title: 'Encounter and catch monsters' })).toBe('Encounter and catch monsters');
    expect(taskTitle({ ...base, issue_number: 3, issue_title: 'Encounter and catch monsters', task_description: 'Keep it small' }))
      .toBe('Encounter and catch monsters');
  });

  it('falls back to the description, then the issue number', () => {
    expect(taskTitle({ ...base, issue_number: 3, issue_title: '  ', task_description: 'Keep it small' })).toBe('Keep it small');
    expect(taskTitle({ ...base, issue_number: 3 })).toBe('Fix issue #3');
    expect(taskTitle({ ...base, task_description: 'Add a README' })).toBe('Add a README');
    expect(taskTitle(base)).toBe('Untitled task');
  });

  it('ignores an issue title without an issue number', () => {
    expect(taskTitle({ ...base, issue_title: 'Stale', task_description: 'Add a README' })).toBe('Add a README');
  });
});
