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

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table, { type TableProps } from '@cloudscape-design/components/table';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { TaskStatusType, TaskSummary } from '../../../core/api/types';
import { ExternalLink, RouterLink } from '../../../core/components/RouterLink';
import { StatusBadge } from '../../../core/components/StatusBadge';
import { formatCost, formatRelativeTime, repoHref, taskHref, taskTitle } from '../../../core/util/format';
import { hasStaleHeartbeat } from '../../../core/util/task-health';

function StatusCell({ task }: { task: TaskSummary }) {
  if (hasStaleHeartbeat(task)) return <StatusIndicator type="warning">No updates lately</StatusIndicator>;
  return <StatusBadge status={task.status} />;
}

/** Sorting by status groups tasks the way people scan them: what needs you, what is running, then the rest. */
const STATUS_ORDER: readonly TaskStatusType[] = [
  'AWAITING_APPROVAL', 'RUNNING', 'FINALIZING', 'HYDRATING', 'SUBMITTED', 'QUEUED', 'PENDING_UPLOADS',
  'FAILED', 'TIMED_OUT', 'CANCELLED', 'COMPLETED',
];

const lastUpdate = (t: TaskSummary) => t.agent_heartbeat_at ?? t.updated_at;

/** Compares numbers; tasks without one sort after those with one. */
function byNumber(get: (t: TaskSummary) => number | null): (a: TaskSummary, b: TaskSummary) => number {
  return (a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return x - y;
  };
}

function columns(showRepo: boolean): TableProps.ColumnDefinition<TaskSummary>[] {
  return [
    {
      id: 'task',
      header: 'Task',
      cell: (t) => <RouterLink href={taskHref(t.task_id)}>{taskTitle(t)}</RouterLink>,
      sortingComparator: (a, b) => taskTitle(a).localeCompare(taskTitle(b)),
      isRowHeader: true,
      maxWidth: 420,
    },
    ...(showRepo
      ? [{
        id: 'repo',
        header: 'Repository',
        cell: (t: TaskSummary) => (t.repo ? <RouterLink href={repoHref(t.repo)}>{t.repo}</RouterLink> : '-'),
        sortingComparator: (a: TaskSummary, b: TaskSummary) => (a.repo ?? '').localeCompare(b.repo ?? ''),
      }]
      : []),
    {
      id: 'status',
      header: 'Status',
      cell: (t) => <StatusCell task={t} />,
      sortingComparator: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
    },
    {
      id: 'pr',
      header: 'Pull request',
      cell: (t) => (t.pr_url ? <ExternalLink href={t.pr_url}>#{t.pr_number ?? 'PR'}</ExternalLink> : '-'),
      sortingComparator: byNumber((t) => t.pr_number),
    },
    { id: 'cost', header: 'Cost', cell: (t) => formatCost(t.cost_usd), sortingComparator: byNumber((t) => t.cost_usd) },
    {
      id: 'updated',
      header: 'Last update',
      cell: (t) => formatRelativeTime(lastUpdate(t)),
      sortingComparator: (a, b) => lastUpdate(a).localeCompare(lastUpdate(b)),
    },
  ];
}

export interface TaskTableProps {
  readonly items: TaskSummary[];
  readonly loading: boolean;
  readonly header: ReactNode;
  readonly filter?: ReactNode;
  readonly showRepo?: boolean;
  readonly empty?: ReactNode;
  readonly variant?: TableProps.Variant;
  readonly hasMore?: boolean;
  readonly loadingMore?: boolean;
  readonly onLoadMore?: () => void;
}

/**
 * The task list used on every page that lists tasks. Clicking a row opens the task;
 * clicking a column header sorts by it (newest first until then).
 */
export function TaskTable(props: TaskTableProps) {
  const navigate = useNavigate();
  const columnDefinitions = useMemo(() => columns(props.showRepo ?? true), [props.showRepo]);
  const [sortingColumn, setSortingColumn] = useState<TableProps.SortingColumn<TaskSummary> | undefined>();
  const [sortingDescending, setSortingDescending] = useState(false);

  const items = useMemo(() => {
    const compare = sortingColumn?.sortingComparator;
    if (!compare) return props.items;
    const sorted = [...props.items].sort(compare);
    return sortingDescending ? sorted.reverse() : sorted;
  }, [props.items, sortingColumn, sortingDescending]);

  return (
    <Table<TaskSummary>
      variant={props.variant ?? 'full-page'}
      loading={props.loading}
      loadingText="Loading tasks"
      items={items}
      columnDefinitions={columnDefinitions}
      sortingColumn={sortingColumn}
      sortingDescending={sortingDescending}
      onSortingChange={({ detail }) => {
        setSortingColumn(detail.sortingColumn);
        setSortingDescending(detail.isDescending ?? false);
      }}
      trackBy="task_id"
      header={props.header}
      filter={props.filter}
      onRowClick={({ detail }) => navigate(taskHref(detail.item.task_id))}
      empty={props.empty ?? <Box textAlign="center" color="inherit">No tasks yet.</Box>}
      footer={
        props.hasMore ? (
          <Box textAlign="center">
            <Button onClick={props.onLoadMore} loading={props.loadingMore}>Load more</Button>
          </Box>
        ) : undefined
      }
    />
  );
}
