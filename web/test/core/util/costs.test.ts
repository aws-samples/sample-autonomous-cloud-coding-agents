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
import type { TaskSummary } from '../../../src/core/api/types';
import {
  breakdown,
  dailySpend,
  dayLabel,
  daysInRange,
  inRange,
  MAX_SERIES,
  mostExpensive,
  OTHER,
  rangeStart,
  seriesOrder,
  summarizeCosts,
} from '../../../src/core/util/costs';

const NOW = new Date('2026-10-28T15:00:00Z');

function t(id: string, cost: number | null, finished: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    task_id: id, status: 'COMPLETED', repo: 'acme/app', issue_number: null, resolved_workflow: null, resolved_assets: null,
    pr_number: null, task_description: id, branch_name: 'b', pr_url: null, created_at: finished, updated_at: finished,
    agent_heartbeat_at: null, cost_usd: cost, completed_at: finished, channel_source: 'api', ...overrides,
  };
}

describe('ranges', () => {
  it('starts this month on the 1st (UTC) and the rolling ranges N-1 days back', () => {
    expect(rangeStart('this-month', NOW).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(rangeStart('7d', NOW).toISOString()).toBe('2026-10-22T00:00:00.000Z');
    expect(daysInRange('7d', NOW)).toHaveLength(7);
    expect(daysInRange('this-month', NOW)).toHaveLength(28);
    expect(daysInRange('7d', NOW).at(-1)).toBe('2026-10-28');
  });

  it('counts a running task on the day of its latest update', () => {
    const running = t('r', 0.5, '2026-10-28T10:00:00Z', { status: 'RUNNING', completed_at: null });
    expect(inRange(running, '7d', NOW)).toBe(true);
    expect(inRange(t('old', 1, '2026-09-30T23:59:59Z'), 'this-month', NOW)).toBe(false);
  });

  it('labels days in UTC', () => {
    expect(dayLabel('2026-10-01')).toBe('Oct 1');
  });
});

describe('summarizeCosts', () => {
  const tasks = [
    t('a', 2, '2026-10-27T10:00:00Z'),
    t('b', 1, '2026-10-26T10:00:00Z', { status: 'FAILED' }),
    t('c', null, '2026-10-25T10:00:00Z'),
    t('d', 5, '2026-09-15T10:00:00Z'),
  ];

  it('totals spend in range, averages over tasks that reported a cost, and isolates unproductive spend', () => {
    expect(summarizeCosts(tasks, 'this-month', NOW)).toEqual({ spend: 3, tasks: 3, averagePerTask: 1.5, unproductiveSpend: 1 });
  });

  it('has no average when no task reported a cost', () => {
    expect(summarizeCosts([t('c', null, '2026-10-25T10:00:00Z')], '7d', NOW).averagePerTask).toBeNull();
  });
});

describe('series and breakdown', () => {
  const repos = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
  const tasks = repos.map((r, i) => t(r, 10 - i, '2026-10-27T10:00:00Z', { repo: `acme/${r}` }));

  it('names at most MAX_SERIES groups, by spend, and folds the rest into Other', () => {
    const order = seriesOrder(tasks, 'repo');
    expect(order).toEqual(['acme/r1', 'acme/r2', 'acme/r3', 'acme/r4', 'acme/r5']);
    expect(order).toHaveLength(MAX_SERIES);
    const series = dailySpend(tasks, 'repo', '7d', order, NOW);
    expect(series.map((s) => s.name)).toEqual([...order, OTHER]);
    expect(series.find((s) => s.name === OTHER)!.values.at(-2)).toBe(5 + 4); // r6 and r7
  });

  it('keeps series order (and so colors) independent of the selected range', () => {
    const older = t('big-old', 50, '2026-09-10T10:00:00Z', { repo: 'acme/legacy' });
    expect(seriesOrder([...tasks, older], 'repo')[0]).toBe('acme/legacy');
    const series = dailySpend([...tasks, older], 'repo', '7d', seriesOrder([...tasks, older], 'repo'), NOW);
    expect(series.map((s) => s.name)).not.toContain('acme/legacy'); // no spend in range: dropped, not recolored
  });

  it('groups by outcome and source in plain words', () => {
    const mixed = [
      t('a', 1, '2026-10-27T10:00:00Z'),
      t('b', 2, '2026-10-27T10:00:00Z', { status: 'FAILED', channel_source: 'linear' }),
      t('c', 3, '2026-10-27T10:00:00Z', { status: 'CANCELLED', channel_source: 'jira' }),
    ];
    expect(breakdown(mixed, 'outcome', '7d', NOW).map((r) => r.name)).toEqual(['Stopped', 'Failed', 'Done']);
    expect(breakdown(mixed, 'source', '7d', NOW).map((r) => r.name)).toEqual(['Jira', 'Linear', 'Console or CLI']);
  });

  it('breakdown lists every group with its share of spend', () => {
    const rows = breakdown(tasks, 'repo', '7d', NOW);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toMatchObject({ name: 'acme/r1', spend: 10, tasks: 1 });
    expect(rows.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1);
  });

  it('lists the most expensive tasks with a cost, in range', () => {
    expect(mostExpensive([...tasks, t('none', null, '2026-10-27T10:00:00Z')], '7d', 3, NOW).map((x) => x.task_id)).toEqual(['r1', 'r2', 'r3']);
  });
});
