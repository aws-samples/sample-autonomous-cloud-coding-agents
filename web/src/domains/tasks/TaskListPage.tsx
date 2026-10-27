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
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import TextFilter from '@cloudscape-design/components/text-filter';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ACTIVE_STATUSES, PRE_ACTIVE_STATUSES } from '../../core/api/types';
import type { TaskStatusType, TaskSummary } from '../../core/api/types';
import { QueryError } from '../../core/components/QueryError';
import { attentionReason } from '../../core/util/task-health';
import { NewTaskButton } from './components/NewTaskButton';
import { TaskTable } from './components/TaskTable';
import { useTaskList } from './hooks';

export type TaskView = 'all' | 'attention' | 'active' | 'queued' | 'completed' | 'unsuccessful';

const VIEWS: Readonly<Record<TaskView, { label: string; status?: readonly TaskStatusType[] }>> = {
  all: { label: 'All tasks' },
  attention: { label: 'Needs you' },
  active: { label: 'Working now', status: ACTIVE_STATUSES },
  queued: { label: 'Waiting in line', status: PRE_ACTIVE_STATUSES },
  completed: { label: 'Done', status: ['COMPLETED'] },
  unsuccessful: { label: 'Failed or cancelled', status: ['FAILED', 'TIMED_OUT', 'CANCELLED'] },
};

const VIEW_OPTIONS: SelectProps.Option[] = (Object.keys(VIEWS) as TaskView[]).map((value) => ({ value, label: VIEWS[value].label }));

function parseView(value: string | null): TaskView {
  return value && value in VIEWS ? (value as TaskView) : 'all';
}

function matchesText(task: TaskSummary, text: string): boolean {
  if (!text) return true;
  const needle = text.toLowerCase();
  return [task.task_id, task.repo, task.task_description, task.branch_name, task.issue_number ? `#${task.issue_number}` : null]
    .some((field) => field?.toLowerCase().includes(needle));
}

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
        <Header variant="h1" description="Everything your agents are working on, newest first." actions={<NewTaskButton />}>
          Tasks
        </Header>
      }
    >
      {query.isError ? (
        <QueryError error={query.error} what="tasks" />
      ) : (
        <TaskTable
          loading={query.isPending}
          items={items}
          header={
            <Header counter={query.data ? `(${items.length}${query.hasNextPage ? '+' : ''})` : undefined}>
              {VIEWS[view].label}
            </Header>
          }
          filter={
            <SpaceBetween direction="horizontal" size="xs">
              <TextFilter
                filteringText={filterText}
                filteringPlaceholder="Search tasks or repositories"
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
          hasMore={query.hasNextPage}
          loadingMore={query.isFetchingNextPage}
          onLoadMore={() => query.fetchNextPage()}
        />
      )}
    </ContentLayout>
  );
}
