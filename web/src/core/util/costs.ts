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

import type { ChannelSource, TaskSummary } from '../api/types';
import type { Explanation } from '../components/Explain';

export type CostRange = 'this-month' | '7d' | '30d';
export type CostGrouping = 'repo' | 'outcome' | 'source' | 'total';

export const COST_RANGES: Readonly<Record<CostRange, string>> = {
  'this-month': 'This month',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

export const COST_GROUPINGS: Readonly<Record<CostGrouping, string>> = {
  repo: 'Repository',
  outcome: 'Outcome',
  source: 'Source',
  total: 'Total',
};

/** At most this many named series; the rest fold into "Other". */
export const MAX_SERIES = 5;
export const OTHER = 'Other';

const DAY_MS = 86_400_000;

const SOURCE_LABELS: Readonly<Record<ChannelSource, string>> = {
  api: 'Console or CLI',
  webhook: 'Webhook',
  slack: 'Slack',
  linear: 'Linear',
  jira: 'Jira',
};

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function spendAt(task: Pick<TaskSummary, 'completed_at' | 'updated_at'>): string {
  return task.completed_at ?? task.updated_at;
}

export function rangeStart(range: CostRange, now: Date = new Date()): Date {
  if (range === 'this-month') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const days = range === '7d' ? 7 : 30;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * DAY_MS);
}

/** Every UTC day in the range, oldest first, as `YYYY-MM-DD`. */
export function daysInRange(range: CostRange, now: Date = new Date()): string[] {
  const days: string[] = [];
  for (let t = rangeStart(range, now).getTime(); t <= now.getTime(); t += DAY_MS) days.push(utcDay(new Date(t)));
  return days;
}

export function inRange(task: TaskSummary, range: CostRange, now: Date = new Date()): boolean {
  const at = Date.parse(spendAt(task));
  return !Number.isNaN(at) && at >= rangeStart(range, now).getTime() && at <= now.getTime();
}

export function outcomeLabel(task: Pick<TaskSummary, 'status'>): string {
  switch (task.status) {
    case 'COMPLETED':
      return 'Done';
    case 'FAILED':
      return 'Failed';
    case 'TIMED_OUT':
    case 'CANCELLED':
      return 'Stopped';
    default:
      return 'Still running';
  }
}

function groupOf(task: TaskSummary, grouping: CostGrouping): string {
  switch (grouping) {
    case 'repo':
      return task.repo ?? 'No repository';
    case 'outcome':
      return outcomeLabel(task);
    case 'source':
      return SOURCE_LABELS[task.channel_source] ?? task.channel_source;
    default:
      return 'Spend';
  }
}

const cost = (task: TaskSummary) => task.cost_usd ?? 0;

function isUnproductive(task: TaskSummary): boolean {
  return task.status === 'FAILED' || task.status === 'TIMED_OUT' || task.status === 'CANCELLED';
}

export interface CostSummary {
  readonly spend: number;
  readonly tasks: number;
  /** Mean over tasks that reported a cost; null when none did. */
  readonly averagePerTask: number | null;
  readonly unproductiveSpend: number;
}

/** What each number of the Costs page says about itself; `perDay` is the chart as a whole. */
export const COST_EXPLANATIONS: Readonly<Record<keyof CostSummary | 'perDay', Explanation>> = {
  spend: {
    what: 'What your tasks cost in model usage over the selected time range.',
    why: 'The total says how much, not what it bought: for that, read "Spend per verified pull request" on the Scoreboard. If'
      + ' it climbs faster than you expect, "Spend per day" shows when, and "Spent on failed or stopped tasks" shows how much'
      + ' bought nothing.',
    how: 'The recorded cost of your tasks that finished in the selected range, added up. A task that has not finished adds'
      + ' nothing yet. Days are UTC days. Costs are estimates of model usage: the machines the agents run on are not in them,'
      + ' and tasks that were cancelled or ran out of time record no cost, so the true figure is higher. It reads your 500'
      + ' most recent tasks.',
  },
  tasks: {
    what: 'How many of your tasks fall in the selected time range.',
    why: 'It is the volume behind the spend. Read it with "Average per task": spend can rise because you submitted more tasks,'
      + ' or because each one cost more.',
    how: 'Tasks that finished in the selected range, whatever the result, and tasks not yet finished whose last change falls in'
      + ' it. Tasks that recorded no cost are counted too. It reads your 500 most recent tasks.',
  },
  averagePerTask: {
    what: 'What one task costs on average, among the tasks that recorded a cost.',
    why: 'It separates two reasons for a rising spend: more tasks, or costlier ones. When it climbs, "Most expensive tasks"'
      + ' shows which tasks pulled it up: those are the ones to split or describe more precisely.',
    how: 'The spend of the range divided by the number of its tasks that recorded a cost. Tasks with no recorded cost, cancelled'
      + ' ones for example, are left out, so this is not the spend divided by the number under "Tasks".',
  },
  unproductiveSpend: {
    what: 'The part of the spend that went to tasks that failed, ran out of time or were cancelled.',
    why: 'It is money that bought no result you can use. When it is a large part of what you spent, tasks are often too big,'
      + ' too vague or cut off by their turn or spending limit: "Most expensive tasks" shows where to start.',
    how: "The recorded cost of the range's tasks that failed, ran out of time or were cancelled. In practice it is the cost of"
      + ' the failed ones: tasks that were cancelled or ran out of time record no cost, so the true figure is higher. A task'
      + ' that ended normally is not in it, even if it opened no pull request.',
  },
  perDay: {
    what: 'What your tasks cost on each day of the selected range, one bar per day.',
    why: 'It shows when the money went. Group the bars by "Repository", "Outcome" or "Source" to see what made a day expensive:'
      + ' which repository, how the task ended, or where it was submitted from.',
    how: "A task's recorded cost is placed on the UTC day the task finished; a task that has not finished shows nothing yet."
      + ' When you group, the five groups that cost most across your 500 most recent tasks are shown on their own, in every'
      + ' range; the rest are added up as "Other".',
  },
};

export function summarizeCosts(tasks: readonly TaskSummary[], range: CostRange, now: Date = new Date()): CostSummary {
  const scoped = tasks.filter((t) => inRange(t, range, now));
  const costed = scoped.filter((t) => t.cost_usd !== null);
  const spend = scoped.reduce((sum, t) => sum + cost(t), 0);
  return {
    spend,
    tasks: scoped.length,
    averagePerTask: costed.length ? spend / costed.length : null,
    unproductiveSpend: scoped.filter(isUnproductive).reduce((sum, t) => sum + cost(t), 0),
  };
}

/**
 * The named groups, in a fixed order: by spend across ALL loaded tasks, not just the
 * selected range, so switching the range never repaints a series in another color.
 * Groups past {@link MAX_SERIES} fold into "Other".
 */
export function seriesOrder(tasks: readonly TaskSummary[], grouping: CostGrouping): string[] {
  const totals = new Map<string, number>();
  for (const t of tasks) totals.set(groupOf(t, grouping), (totals.get(groupOf(t, grouping)) ?? 0) + cost(t));
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SERIES)
    .map(([name]) => name);
}

export interface DailySeries {
  readonly name: string;
  /** One value per day in {@link daysInRange}, in USD. */
  readonly values: readonly number[];
}

/** Spend per day per group; groups outside `order` are summed into "Other". Empty series are dropped. */
export function dailySpend(
  tasks: readonly TaskSummary[],
  grouping: CostGrouping,
  range: CostRange,
  order: readonly string[],
  now: Date = new Date(),
): DailySeries[] {
  const days = daysInRange(range, now);
  const index = new Map(days.map((d, i) => [d, i]));
  const names = [...order, OTHER];
  const values = new Map(names.map((n) => [n, days.map(() => 0)]));
  for (const t of tasks) {
    if (!inRange(t, range, now)) continue;
    const day = index.get(utcDay(new Date(spendAt(t))));
    if (day === undefined) continue;
    const name = order.includes(groupOf(t, grouping)) ? groupOf(t, grouping) : OTHER;
    values.get(name)![day] += cost(t);
  }
  return names
    .map((name) => ({ name, values: values.get(name)! }))
    .filter((s) => s.values.some((v) => v > 0));
}

export interface BreakdownRow {
  readonly name: string;
  readonly spend: number;
  readonly tasks: number;
  /** Fraction of the range's total spend, 0-1. */
  readonly share: number;
}

/** Every group in the range (not folded), most expensive first. */
export function breakdown(tasks: readonly TaskSummary[], grouping: CostGrouping, range: CostRange, now: Date = new Date()): BreakdownRow[] {
  const rows = new Map<string, { spend: number; tasks: number }>();
  let total = 0;
  for (const t of tasks) {
    if (!inRange(t, range, now)) continue;
    const row = rows.get(groupOf(t, grouping)) ?? { spend: 0, tasks: 0 };
    row.spend += cost(t);
    row.tasks += 1;
    rows.set(groupOf(t, grouping), row);
    total += cost(t);
  }
  return [...rows.entries()]
    .map(([name, r]) => ({ name, spend: r.spend, tasks: r.tasks, share: total > 0 ? r.spend / total : 0 }))
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
}

export function mostExpensive(tasks: readonly TaskSummary[], range: CostRange, limit = 5, now: Date = new Date()): TaskSummary[] {
  return tasks
    .filter((t) => inRange(t, range, now) && t.cost_usd !== null)
    .sort((a, b) => cost(b) - cost(a))
    .slice(0, limit);
}

/** "Oct 27" for a `YYYY-MM-DD` day, in UTC like the buckets themselves. */
export function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
