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
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table, { type TableProps } from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ACTIVE_STATUSES, PRE_ACTIVE_STATUSES } from '../../core/api/types';
import type { TaskStatusType, TaskSummary } from '../../core/api/types';
import { QueryError } from '../../core/components/QueryError';
import { ExternalLink, RouterLink } from '../../core/components/RouterLink';
import { StatusBadge } from '../../core/components/StatusBadge';
import { formatRelativeTime, shortId } from '../../core/util/format';
import { ATTENTION_LABELS, attentionReason, hasStaleHeartbeat } from '../../core/util/task-health';
import { useTaskList } from './hooks';

export type TaskView = 'all' | 'attention' | 'active' | 'queued' | 'completed' | 'unsuccessful';

const VIEWS: Readonly<Record<TaskView, { label: string; status?: readonly TaskStatusType[] }>> = {
  all: { label: 'All tasks' },
  attention: { label: 'Needs attention' },
  active: { label: 'Active', status: ACTIVE_STATUSES },
  queued: { label: 'Queued', status: PRE_ACTIVE_STATUSES },
  completed: { label: 'Completed', status: ['COMPLETED'] },
  unsuccessful: { label: 'Failed, timed out or cancelled', status: ['FAILED', 'TIMED_OUT', 'CANCELLED'] },
};

const VIEW_OPTIONS: SelectProps.Option[] = (Object.keys(VIEWS) as TaskView[]).map((value) => ({ value, label: VIEWS[value].label }));

function parseView(value: string | null): TaskView {
  return value && value in VIEWS ? (value as TaskView) : 'all';
}

function matchesText(task: TaskSummary, text: string): boolean {
  if (!text) return true;
  const needle = text.toLowerCase();
  return [task.task_id, task.repo, task.task_description, task.branch_name]
    .some((field) => field?.toLowerCase().includes(needle));
}

function HeartbeatCell({ task }: { task: TaskSummary }) {
  if (hasStaleHeartbeat(task)) {
    return <StatusIndicator type="warning">{task.agent_heartbeat_at ? formatRelativeTime(task.agent_heartbeat_at) : 'never'}</StatusIndicator>;
  }
  return <>{formatRelativeTime(task.agent_heartbeat_at)}</>;
}

const COLUMNS: TableProps.ColumnDefinition<TaskSummary>[] = [
  {
    id: 'task',
    header: 'Task',
    cell: (t) => <RouterLink href={`/tasks/${encodeURIComponent(t.task_id)}`}>{shortId(t.task_id)}</RouterLink>,
    isRowHeader: true,
  },
  { id: 'status', header: 'Status', cell: (t) => <StatusBadge status={t.status} /> },
  {
    id: 'attention',
    header: 'Attention',
    cell: (t) => {
      const reason = attentionReason(t);
      return reason ? ATTENTION_LABELS[reason] : '-';
    },
  },
  { id: 'repo', header: 'Repository', cell: (t) => t.repo ?? '-' },
  {
    id: 'description',
    header: 'Description',
    cell: (t) => t.task_description ?? (t.issue_number ? `Issue #${t.issue_number}` : '-'),
    maxWidth: 360,
  },
  { id: 'pr', header: 'Pull request', cell: (t) => (t.pr_url ? <ExternalLink href={t.pr_url}>#{t.pr_number ?? 'PR'}</ExternalLink> : '-') },
  { id: 'heartbeat', header: 'Last heartbeat', cell: (t) => <HeartbeatCell task={t} /> },
  { id: 'updated', header: 'Updated', cell: (t) => formatRelativeTime(t.updated_at) },
];

export function TaskListPage() {
  const [params, setParams] = useSearchParams();
  const view = parseView(params.get('view'));
  const [filterText, setFilterText] = useState('');
  const query = useTaskList(VIEWS[view].status);

  const items = useMemo(() => {
    const all = query.data?.pages.flatMap((page) => page.data) ?? [];
    return all
      .filter((task) => view !== 'attention' || attentionReason(task) !== null)
      .filter((task) => matchesText(task, filterText));
  }, [query.data, view, filterText]);

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Tasks visible to your account, newest first. Refreshes every 15 seconds.">
          Tasks
        </Header>
      }
    >
      {query.isError ? (
        <QueryError error={query.error} what="tasks" />
      ) : (
        <Table
          variant="full-page"
          loading={query.isPending}
          loadingText="Loading tasks"
          items={items}
          columnDefinitions={COLUMNS}
          trackBy="task_id"
          header={
            <Header counter={query.data ? `(${items.length}${query.hasNextPage ? '+' : ''})` : undefined}>
              {VIEWS[view].label}
            </Header>
          }
          filter={
            <SpaceBetween direction="horizontal" size="xs">
              <TextFilter
                filteringText={filterText}
                filteringPlaceholder="Search by id, repository, branch or description"
                onChange={({ detail }) => setFilterText(detail.filteringText)}
              />
              <Select
                selectedOption={VIEW_OPTIONS.find((o) => o.value === view) ?? null}
                options={VIEW_OPTIONS}
                onChange={({ detail }) => setParams(detail.selectedOption.value === 'all' ? {} : { view: detail.selectedOption.value ?? 'all' })}
                ariaLabel="Task view"
              />
            </SpaceBetween>
          }
          empty={<Box textAlign="center" color="inherit">No tasks match this view.</Box>}
          footer={
            query.hasNextPage ? (
              <Box textAlign="center">
                <Button onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>Load more</Button>
              </Box>
            ) : undefined
          }
        />
      )}
    </ContentLayout>
  );
}
