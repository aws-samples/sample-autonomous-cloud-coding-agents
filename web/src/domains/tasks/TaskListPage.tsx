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
import TextFilter from '@cloudscape-design/components/text-filter';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ACTIVE_STATUSES, PRE_ACTIVE_STATUSES } from '../../core/api/types';
import type { ChannelSource, TaskStatusType, TaskSummary } from '../../core/api/types';
import { QueryError } from '../../core/components/QueryError';
import { SOURCE_LABEL } from '../../core/util/format';
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

/**
 * Sorting and filtering happen in the browser (the API returns newest first and
 * filters only by status and repository), so the page loads this many tasks.
 */
const MAX_LOADED_TASKS = 500;

const ANY = 'any';
const SOURCE_OPTIONS: SelectProps.Option[] = [
  { value: ANY, label: 'Any source' },
  ...(Object.keys(SOURCE_LABEL) as ChannelSource[]).map((value) => ({ value, label: SOURCE_LABEL[value] })),
];

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
  const repo = params.get('repo') ?? '';
  const source = params.get('source') ?? ANY;
  const [filterText, setFilterText] = useState('');
  const query = useTaskList(VIEWS[view].status, repo || undefined);
  const all = useMemo(() => query.data?.pages.flatMap((page) => page.data) ?? [], [query.data]);

  // Keep loading pages so sorting and filtering see every task, up to the cap.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && all.length < MAX_LOADED_TASKS) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, all.length]);

  /** Repositories seen so far, plus the chosen one even when no loaded task uses it. */
  const repoOptions = useMemo<SelectProps.Option[]>(() => {
    const repos = new Set(all.map((t) => t.repo).filter((r): r is string => !!r));
    if (repo) repos.add(repo);
    return [{ value: '', label: 'All repositories' }, ...[...repos].sort().map((value) => ({ value, label: value }))];
  }, [all, repo]);

  const setParam = (key: string, value: string, empty: string) => {
    const next = new URLSearchParams(params);
    if (value === empty) next.delete(key);
    else next.set(key, value);
    setParams(next);
  };

  const items = useMemo(() => all
    .filter((task) => view !== 'attention' || attentionReason(task) !== null)
    .filter((task) => source === ANY || task.channel_source === source)
    .filter((task) => matchesText(task, filterText)), [all, view, source, filterText]);
  const filtered = view !== 'all' || !!repo || source !== ANY || !!filterText;

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Everything your agents are working on, newest first. Click a column to sort." actions={<NewTaskButton />}>
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
                onChange={({ detail }) => setParam('view', detail.selectedOption.value ?? 'all', 'all')}
                ariaLabel="Task view"
              />
              <Select
                selectedOption={repoOptions.find((o) => o.value === repo) ?? null}
                options={repoOptions}
                onChange={({ detail }) => setParam('repo', detail.selectedOption.value ?? '', '')}
                filteringType="auto"
                ariaLabel="Repository"
              />
              <Select
                selectedOption={SOURCE_OPTIONS.find((o) => o.value === source) ?? null}
                options={SOURCE_OPTIONS}
                onChange={({ detail }) => setParam('source', detail.selectedOption.value ?? ANY, ANY)}
                ariaLabel="Started from"
              />
              {filtered && (
                <Button variant="link" onClick={() => { setFilterText(''); setParams({}); }}>Clear filters</Button>
              )}
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
