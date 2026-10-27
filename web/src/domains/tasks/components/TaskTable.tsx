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
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { TaskSummary } from '../../../core/api/types';
import { ExternalLink, RouterLink } from '../../../core/components/RouterLink';
import { StatusBadge } from '../../../core/components/StatusBadge';
import { formatRelativeTime, repoHref, taskHref, taskTitle } from '../../../core/util/format';
import { hasStaleHeartbeat } from '../../../core/util/task-health';

function StatusCell({ task }: { task: TaskSummary }) {
  if (hasStaleHeartbeat(task)) return <StatusIndicator type="warning">No updates lately</StatusIndicator>;
  return <StatusBadge status={task.status} />;
}

function columns(showRepo: boolean): TableProps.ColumnDefinition<TaskSummary>[] {
  return [
    {
      id: 'task',
      header: 'Task',
      cell: (t) => <RouterLink href={taskHref(t.task_id)}>{taskTitle(t)}</RouterLink>,
      isRowHeader: true,
      maxWidth: 420,
    },
    ...(showRepo
      ? [{ id: 'repo', header: 'Repository', cell: (t: TaskSummary) => (t.repo ? <RouterLink href={repoHref(t.repo)}>{t.repo}</RouterLink> : '-') }]
      : []),
    { id: 'status', header: 'Status', cell: (t) => <StatusCell task={t} /> },
    { id: 'pr', header: 'Pull request', cell: (t) => (t.pr_url ? <ExternalLink href={t.pr_url}>#{t.pr_number ?? 'PR'}</ExternalLink> : '-') },
    { id: 'updated', header: 'Last update', cell: (t) => formatRelativeTime(t.agent_heartbeat_at ?? t.updated_at) },
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

/** The task list used on every page that lists tasks. Clicking a row opens the task. */
export function TaskTable(props: TaskTableProps) {
  const navigate = useNavigate();
  return (
    <Table<TaskSummary>
      variant={props.variant ?? 'full-page'}
      loading={props.loading}
      loadingText="Loading tasks"
      items={props.items}
      columnDefinitions={columns(props.showRepo ?? true)}
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
