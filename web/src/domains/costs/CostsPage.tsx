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

import BarChart, { type BarChartProps } from '@cloudscape-design/components/bar-chart';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import type { TaskSummary } from '../../core/api/types';
import { otherColor, seriesColor, useDarkMode } from '../../core/components/chart-palette';
import { QueryError } from '../../core/components/QueryError';
import { RouterLink } from '../../core/components/RouterLink';
import {
  breakdown,
  COST_GROUPINGS,
  COST_RANGES,
  dailySpend,
  dayLabel,
  daysInRange,
  mostExpensive,
  OTHER,
  outcomeLabel,
  seriesOrder,
  summarizeCosts,
  type BreakdownRow,
  type CostGrouping,
  type CostRange,
} from '../../core/util/costs';
import { formatCost, repoHref, taskHref, taskTitle } from '../../core/util/format';
import { useCostTasks, useMyBudget } from './hooks';

function parse<T extends string>(value: string | null, options: Readonly<Record<T, string>>, fallback: T): T {
  return value && value in options ? (value as T) : fallback;
}

function options<T extends string>(labels: Readonly<Record<T, string>>) {
  return (Object.keys(labels) as T[]).map((id) => ({ id, text: labels[id] }));
}

/** Color swatch beside a label: the label carries identity, the swatch links it to the chart. */
function Swatch({ color }: { color: string }) {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color, marginRight: 8 }} />;
}

function Tile({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box variant="awsui-value-large">{value}</Box>
      {children}
    </div>
  );
}

function BudgetMeter() {
  const budget = useMyBudget();
  if (budget.isPending || budget.isError) return null;
  const b = budget.data;
  if (!b.configured || b.monthly_limit_usd === null) {
    return <Box variant="small" color="text-status-inactive">No monthly limit set</Box>;
  }
  return (
    <ProgressBar
      value={Math.min(100, b.utilization_percent ?? 0)}
      status={b.hard_stop_active ? 'error' : 'in-progress'}
      additionalInfo={`${formatCost(b.spend_usd)} of your ${formatCost(b.monthly_limit_usd)} monthly limit, counting finished tasks${b.hard_stop ? '. New tasks stop at 100%' : ''}`}
      resultText={b.hard_stop_active ? 'Limit reached: new tasks are blocked' : undefined}
      ariaLabel="Monthly limit used"
    />
  );
}

export function CostsPage() {
  const [params, setParams] = useSearchParams();
  const range = parse<CostRange>(params.get('range'), COST_RANGES, 'this-month');
  const grouping = parse<CostGrouping>(params.get('group'), COST_GROUPINGS, 'repo');
  const dark = useDarkMode();
  const { query, tasks, truncated } = useCostTasks();

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  const view = useMemo(() => {
    const now = new Date();
    const order = seriesOrder(tasks, grouping);
    const colorOf = (name: string) => (name === OTHER ? otherColor(dark) : seriesColor(Math.max(0, order.indexOf(name)), dark));
    const days = daysInRange(range, now);
    const series: BarChartProps<string>['series'] = dailySpend(tasks, grouping, range, order, now).map((s) => ({
      title: s.name,
      type: 'bar',
      color: colorOf(s.name),
      data: days.map((day, i) => ({ x: dayLabel(day), y: Number(s.values[i].toFixed(2)) })),
      valueFormatter: (v: number) => formatCost(v),
    }));
    return {
      summary: summarizeCosts(tasks, range, now),
      series,
      xDomain: days.map(dayLabel),
      rows: breakdown(tasks, grouping, range, now),
      top: mostExpensive(tasks, range, 5, now),
      colorOf: (name: string) => (order.includes(name) ? colorOf(name) : otherColor(dark)),
    };
  }, [tasks, grouping, range, dark]);

  const rangeLabel = COST_RANGES[range].toLowerCase();

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="What your tasks cost. Spend counts on the day a task finishes."
          actions={
            <SegmentedControl
              label="Time range"
              selectedId={range}
              options={options(COST_RANGES)}
              onChange={({ detail }) => set('range', detail.selectedId)}
            />
          }
        >
          Costs
        </Header>
      }
    >
      {query.isError ? (
        <QueryError error={query.error} what="costs" />
      ) : (
        <SpaceBetween size="l">
          <Container>
            <ColumnLayout columns={4} variant="text-grid" minColumnWidth={170}>
              <Tile label={`Spent ${rangeLabel}`} value={query.isPending ? '-' : formatCost(view.summary.spend)}>
                {range === 'this-month' && <BudgetMeter />}
              </Tile>
              <Tile label="Tasks" value={query.isPending ? '-' : String(view.summary.tasks)} />
              <Tile label="Average per task" value={query.isPending ? '-' : formatCost(view.summary.averagePerTask)} />
              <Tile label="Spent on failed or stopped tasks" value={query.isPending ? '-' : formatCost(view.summary.unproductiveSpend)} />
            </ColumnLayout>
          </Container>

          <Container
            header={
              <Header
                variant="h2"
                description={grouping === 'total' ? undefined : `Stacked by ${COST_GROUPINGS[grouping].toLowerCase()}. Hover a bar for the numbers.`}
                actions={
                  <SegmentedControl
                    label="Group by"
                    selectedId={grouping}
                    options={options(COST_GROUPINGS)}
                    onChange={({ detail }) => set('group', detail.selectedId)}
                  />
                }
              >
                Spend per day
              </Header>
            }
          >
            <BarChart
              series={view.series}
              xDomain={view.xDomain}
              xScaleType="categorical"
              stackedBars
              hideFilter
              hideLegend={view.series.length < 2}
              height={240}
              yTitle="USD"
              // Whole dollars on the axis ("$4"), cents in the hover tooltip.
              yTickFormatter={(v) => `$${Number.isInteger(v) ? v : v.toFixed(1)}`}
              statusType={query.isPending ? 'loading' : 'finished'}
              loadingText="Loading costs"
              ariaLabel="Spend per day"
              empty={<Box textAlign="center" color="inherit">No spend {rangeLabel}.</Box>}
              noMatch={<Box textAlign="center" color="inherit">No spend {rangeLabel}.</Box>}
            />
          </Container>

          <Grid gridDefinition={[{ colspan: { default: 12, m: 6 } }, { colspan: { default: 12, m: 6 } }]}>
            <Table<BreakdownRow>
              variant="container"
              header={<Header variant="h2" counter={`(${view.rows.length})`}>By {COST_GROUPINGS[grouping].toLowerCase()}</Header>}
              loading={query.isPending}
              loadingText="Loading costs"
              items={view.rows}
              trackBy="name"
              columnDefinitions={[
                {
                  id: 'name',
                  header: COST_GROUPINGS[grouping],
                  isRowHeader: true,
                  cell: (r) => (
                    <span>
                      <Swatch color={view.colorOf(r.name)} />
                      {grouping === 'repo' && r.name.includes('/') ? <RouterLink href={repoHref(r.name)}>{r.name}</RouterLink> : r.name}
                    </span>
                  ),
                },
                { id: 'spend', header: 'Spend', cell: (r) => formatCost(r.spend) },
                { id: 'share', header: 'Share', cell: (r) => `${Math.round(r.share * 100)}%` },
                { id: 'tasks', header: 'Tasks', cell: (r) => r.tasks },
              ]}
              empty={<Box textAlign="center" color="inherit">No spend {rangeLabel}.</Box>}
            />
            <Table<TaskSummary>
              variant="container"
              header={<Header variant="h2">Most expensive tasks</Header>}
              loading={query.isPending}
              loadingText="Loading costs"
              items={view.top}
              trackBy="task_id"
              columnDefinitions={[
                { id: 'task', header: 'Task', isRowHeader: true, cell: (t) => <RouterLink href={taskHref(t.task_id)}>{taskTitle(t)}</RouterLink>, maxWidth: 260 },
                { id: 'outcome', header: 'Outcome', cell: (t) => outcomeLabel(t) },
                { id: 'cost', header: 'Cost', cell: (t) => formatCost(t.cost_usd) },
              ]}
              empty={<Box textAlign="center" color="inherit">No tasks with a cost {rangeLabel}.</Box>}
            />
          </Grid>

          {truncated && (
            <Box variant="small" color="text-status-inactive">Based on your 500 most recent tasks.</Box>
          )}
          <Box variant="small" color="text-status-inactive">
            Costs are estimates reported by the agent (model usage). They cover your own tasks.
          </Box>
        </SpaceBetween>
      )}
    </ContentLayout>
  );
}
