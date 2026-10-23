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
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { TaskSummary } from '../../core/api/types';
import { QueryError } from '../../core/components/QueryError';
import { RouterLink } from '../../core/components/RouterLink';
import { StatusBadge } from '../../core/components/StatusBadge';
import { formatRelativeTime, shortId } from '../../core/util/format';
import {
  ATTENTION_LABELS,
  RECENT_FAILURE_WINDOW_SEC,
  attentionReason,
  hasStaleHeartbeat,
  isActive,
  isQueued,
} from '../../core/util/task-health';
import { usePendingApprovals } from '../approvals/hooks';
import { useTaskList } from '../tasks/hooks';

interface Counter {
  readonly label: string;
  readonly value: number;
  readonly href: string;
}

function recent(task: TaskSummary, now: Date): boolean {
  return now.getTime() - Date.parse(task.updated_at) <= RECENT_FAILURE_WINDOW_SEC * 1000;
}

function summarize(tasks: readonly TaskSummary[], pendingApprovals: number, now: Date = new Date()): Counter[] {
  return [
    { label: 'Active', value: tasks.filter((t) => isActive(t.status)).length, href: '/tasks?view=active' },
    { label: 'Queued', value: tasks.filter((t) => isQueued(t.status)).length, href: '/tasks?view=queued' },
    { label: 'Waiting for approval', value: pendingApprovals, href: '/approvals' },
    { label: 'No agent heartbeat', value: tasks.filter((t) => hasStaleHeartbeat(t, now)).length, href: '/tasks?view=attention' },
    {
      label: 'Failed or timed out (24h)',
      value: tasks.filter((t) => (t.status === 'FAILED' || t.status === 'TIMED_OUT') && recent(t, now)).length,
      href: '/tasks?view=unsuccessful',
    },
    { label: 'Completed (24h)', value: tasks.filter((t) => t.status === 'COMPLETED' && recent(t, now)).length, href: '/tasks?view=completed' },
  ];
}

export function OverviewPage() {
  const navigate = useNavigate();
  const tasksQuery = useTaskList();
  const pendingQuery = usePendingApprovals();

  const tasks = useMemo(() => tasksQuery.data?.pages[0]?.data ?? [], [tasksQuery.data]);
  const counters = useMemo(() => summarize(tasks, pendingQuery.data?.pending.length ?? 0), [tasks, pendingQuery.data]);
  const attention = useMemo(() => tasks.filter((t) => attentionReason(t) !== null), [tasks]);
  const truncated = tasksQuery.data?.pages[0]?.pagination.has_more ?? false;

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="What your agents are doing and what needs a human.">
          Overview
        </Header>
      }
    >
      <SpaceBetween size="l">
        {tasksQuery.isError && <QueryError error={tasksQuery.error} what="tasks" />}
        {pendingQuery.isError && <QueryError error={pendingQuery.error} what="pending approvals" />}

        <Container
          header={
            <Header
              variant="h2"
              description={truncated ? 'Based on your 100 most recent tasks.' : 'Based on all tasks visible to your account.'}
            >
              At a glance
            </Header>
          }
        >
          <ColumnLayout columns={3} variant="text-grid">
            {counters.map((counter) => (
              <div key={counter.label}>
                <Box variant="awsui-key-label">{counter.label}</Box>
                <Link
                  variant="awsui-value-large"
                  href={counter.href}
                  ariaLabel={`${counter.label}: ${tasksQuery.isPending ? 'loading' : counter.value}`}
                  onFollow={(event) => {
                    event.preventDefault();
                    navigate(counter.href);
                  }}
                >
                  {tasksQuery.isPending ? '-' : counter.value}
                </Link>
              </div>
            ))}
          </ColumnLayout>
        </Container>

        <Table<TaskSummary>
          variant="container"
          loading={tasksQuery.isPending}
          loadingText="Loading tasks"
          items={attention}
          trackBy="task_id"
          header={<Header variant="h2" counter={tasksQuery.data ? `(${attention.length})` : undefined}>Needs attention</Header>}
          columnDefinitions={[
            {
              id: 'task',
              header: 'Task',
              cell: (t) => <RouterLink href={`/tasks/${encodeURIComponent(t.task_id)}`}>{shortId(t.task_id)}</RouterLink>,
              isRowHeader: true,
            },
            {
              id: 'reason',
              header: 'Why',
              cell: (t) => {
                const reason = attentionReason(t);
                return reason ? ATTENTION_LABELS[reason] : '-';
              },
            },
            { id: 'status', header: 'Status', cell: (t) => <StatusBadge status={t.status} /> },
            { id: 'repo', header: 'Repository', cell: (t) => t.repo ?? '-' },
            { id: 'updated', header: 'Updated', cell: (t) => formatRelativeTime(t.updated_at) },
          ]}
          empty={<Box textAlign="center" color="inherit">Nothing needs attention right now.</Box>}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
