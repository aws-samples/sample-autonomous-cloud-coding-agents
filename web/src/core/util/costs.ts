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

/**
 * Cost rollups for the Costs page, computed from task summaries.
 *
 * A task's spend is counted on the UTC day it finished (or, while it runs, the day
 * of its latest update), so a day's bar shows money spent that day.
 */

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

/** At most this many named series; the rest fold into "Other" (never a generated 9th hue). */
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

/** The instant a task's spend is attributed to. */
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

/** Spend that bought nothing: tasks that failed, timed out or were cancelled. */
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
