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
import { Explain, type Explanation } from '../../core/components/Explain';
import { QueryError } from '../../core/components/QueryError';
import { RouterLink } from '../../core/components/RouterLink';
import { StatusBadge } from '../../core/components/StatusBadge';
import { TileLabel } from '../../core/components/Tile';
import { formatRelativeTime, repoHref, taskHref, taskTitle } from '../../core/util/format';
import {
  ATTENTION_LABELS,
  RECENT_FAILURE_WINDOW_SEC,
  attentionReason,
  hasStaleHeartbeat,
  isActive,
  isQueued,
} from '../../core/util/task-health';
import { usePendingApprovals } from '../approvals/hooks';
import { NewTaskButton } from '../tasks/components/NewTaskButton';
import { useTaskList } from '../tasks/hooks';

interface Counter {
  readonly label: string;
  readonly href: string;
  readonly explanation: Explanation;
  readonly count: (tasks: readonly TaskSummary[], pendingApprovals: number, now: Date) => number;
}

function recent(task: TaskSummary, now: Date): boolean {
  return now.getTime() - Date.parse(task.updated_at) <= RECENT_FAILURE_WINDOW_SEC * 1000;
}

/** The counters of "At a glance": what each counts, where it leads, and what it says about itself. */
export const COUNTERS: readonly Counter[] = [
  {
    label: 'Working now',
    href: '/tasks?view=active',
    explanation: {
      what: 'Tasks under way, from starting up to wrapping up, including any paused for your approval.',
      why: 'Each one uses one of the places your limit on tasks running at once allows. If it stays high while "Done (24h)"'
        + ' does not move, look at "No updates lately" and "Approval requests": something is stuck, or waiting for you.',
      how: 'Your tasks whose status is "Starting", "Setting up", "Working", "Waiting for approval" or "Wrapping up", among your'
        + ' 100 most recent tasks. The page refreshes every 15 seconds.',
    },
    count: (tasks) => tasks.filter((t) => isActive(t.status)).length,
  },
  {
    // Not "in line": a task that waits for its files is counted too, and no limit holds that one back.
    label: 'Waiting to start',
    href: '/tasks?view=queued',
    explanation: {
      what: 'Tasks that have not started: waiting in line behind the ones you have running, or waiting for their files.',
      why: 'A line that does not clear means you submit work faster than your limit on tasks running at once lets it start:'
        + ' submit fewer at once, or have the limit raised. "Waited in line", on the Scoreboard, shows how often it happens.',
      how: 'Your tasks whose status is "Queued" or "Waiting for files", among your 100 most recent tasks. Only the queued ones'
        + ' are held by your limit, and only they count under "Waited in line" on the Scoreboard; a task waiting for files is'
        + ' waiting for its uploads.',
    },
    count: (tasks) => tasks.filter((t) => isQueued(t.status)).length,
  },
  {
    label: 'Approval requests',
    href: '/approvals',
    explanation: {
      what: 'Actions an agent has paused on until you approve them or say no.',
      why: 'Each one holds a task still until you answer. Left unanswered, a request is refused when its time runs out, and the'
        + ' agent has to find another way. Answer these first: the number opens them.',
      how: 'Requests waiting for your answer right now, across all your tasks. Answered and expired requests are not counted.'
        + ' It refreshes every 10 seconds.',
    },
    count: (_tasks, pendingApprovals) => pendingApprovals,
  },
  {
    label: 'No updates lately',
    href: '/tasks?view=attention',
    explanation: {
      what: 'Tasks with the status "Working" whose agent has gone quiet.',
      why: 'A quiet agent may have hung or crashed, and the task then goes nowhere. Open it from "Needs you" to see how far it'
        + ' got: send it a message, or cancel it and submit the work again.',
      how: 'Tasks with the status "Working" whose agent last reported more than 4 minutes ago, or not once in its first 6'
        + ' minutes, among your 100 most recent tasks. On AgentCore and Lambda MicroVMs ABCA fails such a task itself. Tasks'
        + ' on ECS are not counted.',
    },
    count: (tasks, _pendingApprovals, now) => tasks.filter((t) => hasStaleHeartbeat(t, now)).length,
  },
  {
    // Both statuses in the name: "Failed" alone is one of them everywhere else in the console.
    label: 'Failed or ran out of time (24h)',
    href: '/tasks?view=unsuccessful',
    explanation: {
      what: 'Tasks that failed or ran out of time in the last 24 hours.',
      why: 'Each one left its work undone: read why it ended on its page, then try again, split it up or do it by hand. They'
        + ' stay listed under "Needs you" until a day has passed.',
      how: 'Your tasks that failed or ran out of time, and whose last change is less than 24 hours old, among your 100 most'
        + ' recent tasks. Cancelled tasks are not counted, though the list the number opens shows them, and older tasks too.',
    },
    count: (tasks, _pendingApprovals, now) => tasks.filter((t) => (t.status === 'FAILED' || t.status === 'TIMED_OUT') && recent(t, now)).length,
  },
  {
    label: 'Done (24h)',
    href: '/tasks?view=completed',
    explanation: {
      what: 'Tasks that ended normally in the last 24 hours.',
      why: 'It is what your agents got through in a day. That is volume, not results: for those, read "Ended in a verified pull'
        + ' request" on the Scoreboard.',
      how: 'Your tasks whose status is "Done" and whose last change is less than 24 hours old, among your 100 most recent tasks.'
        + ' Done means the task ended normally: it did not fail, run out of time or get cancelled. It may have ended with a'
        + ' question for you, or with a pull request without a passed build.',
    },
    count: (tasks, _pendingApprovals, now) => tasks.filter((t) => t.status === 'COMPLETED' && recent(t, now)).length,
  },
];

export function OverviewPage() {
  const navigate = useNavigate();
  const tasksQuery = useTaskList();
  const pendingQuery = usePendingApprovals();

  const tasks = useMemo(() => tasksQuery.data?.pages[0]?.data ?? [], [tasksQuery.data]);
  const counts = useMemo(() => {
    const now = new Date();
    return COUNTERS.map((counter) => counter.count(tasks, pendingQuery.data?.pending.length ?? 0, now));
  }, [tasks, pendingQuery.data]);
  const attention = useMemo(() => tasks.filter((t) => attentionReason(t) !== null), [tasks]);
  const truncated = tasksQuery.data?.pages[0]?.pagination.has_more ?? false;

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="What your agents are doing, and what needs you." actions={<NewTaskButton />}>
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
            {COUNTERS.map((counter, i) => (
              <Explain key={counter.label} title={counter.label} explanation={counter.explanation}>
                {(icon) => (
                  <>
                    <TileLabel label={counter.label} icon={icon} />
                    <Link
                      variant="awsui-value-large"
                      href={counter.href}
                      ariaLabel={`${counter.label}: ${tasksQuery.isPending ? 'loading' : counts[i]}`}
                      onFollow={(event) => {
                        event.preventDefault();
                        void navigate(counter.href);
                      }}
                    >
                      {tasksQuery.isPending ? '-' : counts[i]}
                    </Link>
                  </>
                )}
              </Explain>
            ))}
          </ColumnLayout>
        </Container>

        <Table<TaskSummary>
          variant="container"
          loading={tasksQuery.isPending}
          loadingText="Loading tasks"
          items={attention}
          trackBy="task_id"
          header={<Header variant="h2" counter={tasksQuery.data ? `(${attention.length})` : undefined}>Needs you</Header>}
          columnDefinitions={[
            {
              id: 'task',
              header: 'Task',
              cell: (t) => <RouterLink href={taskHref(t.task_id)}>{taskTitle(t)}</RouterLink>,
              isRowHeader: true,
              maxWidth: 360,
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
            { id: 'repo', header: 'Repository', cell: (t) => (t.repo ? <RouterLink href={repoHref(t.repo)}>{t.repo}</RouterLink> : '-') },
            { id: 'updated', header: 'Updated', cell: (t) => formatRelativeTime(t.updated_at) },
          ]}
          empty={<Box textAlign="center" color="inherit">Nothing needs you right now.</Box>}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
