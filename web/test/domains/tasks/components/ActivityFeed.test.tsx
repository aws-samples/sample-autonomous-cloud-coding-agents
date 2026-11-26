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

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ActivityLine } from '../../../../src/core/util/activity';
import { ActivityFeed } from '../../../../src/domains/tasks/components/ActivityFeed';

const line = (id: string, at: string, text: string): ActivityLine => ({ id, at, kind: 'step', text });

describe('ActivityFeed', () => {
  it('names the day of a line that falls on another day than the line before it', () => {
    const merged = '2026-11-12T10:30:00Z';
    render(<ActivityFeed
      loading={false}
      live={false}
      lines={[
        line('a', '2026-11-10T10:30:00Z', 'Opened the pull request'),
        line('b', '2026-11-10T10:31:00Z', 'Finished'),
        line('c', merged, 'Pull request merged on GitHub'),
      ]}
    />);
    const day = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }).format(new Date(merged));
    const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `${time('2026-11-10T10:30:00Z')}Opened the pull request`,
      `${time('2026-11-10T10:31:00Z')}Finished`,
      `${day}${time(merged)}Pull request merged on GitHub`,
    ]);
  });

  it('goes by the reader\'s clock for the day, as it does for the time', () => {
    const before = new Date(2026, 10, 11, 23, 30).toISOString();
    const after = new Date(2026, 10, 12, 0, 30).toISOString();
    render(<ActivityFeed loading={false} live={false} lines={[line('a', before, 'Finished'), line('b', after, 'Pull request merged on GitHub')]} />);
    const day = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }).format(new Date(after));
    expect(screen.getAllByRole('listitem')[1].textContent?.startsWith(day)).toBe(true);
  });
});
