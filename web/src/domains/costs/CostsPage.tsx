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
import { Explain } from '../../core/components/Explain';
import { QueryError } from '../../core/components/QueryError';
import { RouterLink } from '../../core/components/RouterLink';
import { Swatch } from '../../core/components/Swatch';
import { Tile } from '../../core/components/Tile';
import { choiceOptions, parseChoice } from '../../core/util/choices';
import {
  breakdown,
  COST_EXPLANATIONS,
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
import { formatCost, formatCount, repoHref, taskHref, taskTitle } from '../../core/util/format';
import { useCostTasks, useMyBudget } from './hooks';

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
  const range = parseChoice<CostRange>(params.get('range'), COST_RANGES, 'this-month');
  const grouping = parseChoice<CostGrouping>(params.get('group'), COST_GROUPINGS, 'repo');
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
              options={choiceOptions(COST_RANGES)}
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
              <Tile
                label={`Spent ${rangeLabel}`}
                loading={query.isPending}
                value={formatCost(view.summary.spend)}
                explanation={COST_EXPLANATIONS.spend}
              >
                {range === 'this-month' && <BudgetMeter />}
              </Tile>
              <Tile label="Tasks" loading={query.isPending} value={formatCount(view.summary.tasks)} explanation={COST_EXPLANATIONS.tasks} />
              <Tile
                label="Average per task"
                loading={query.isPending}
                value={view.summary.averagePerTask === null ? null : formatCost(view.summary.averagePerTask)}
                explanation={COST_EXPLANATIONS.averagePerTask}
              />
              <Tile
                label="Spent on failed or stopped tasks"
                loading={query.isPending}
                value={formatCost(view.summary.unproductiveSpend)}
                explanation={COST_EXPLANATIONS.unproductiveSpend}
              />
            </ColumnLayout>
          </Container>

          <Container
            header={
              <Header
                variant="h2"
                description={grouping === 'total' ? undefined : `Stacked by ${COST_GROUPINGS[grouping].toLowerCase()}. Hover a bar for the numbers.`}
                // The bars show their numbers on hover, so the chart's explanation opens from the "i" alone.
                info={<Explain as="span" title="Spend per day" explanation={COST_EXPLANATIONS.perDay}>{(icon) => icon}</Explain>}
                actions={
                  <SegmentedControl
                    label="Group by"
                    selectedId={grouping}
                    options={choiceOptions(COST_GROUPINGS)}
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
              yTickFormatter={(v) => `$${Number.isInteger(v) ? formatCount(v) : v.toFixed(1)}`}
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
                { id: 'tasks', header: 'Tasks', cell: (r) => formatCount(r.tasks) },
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
