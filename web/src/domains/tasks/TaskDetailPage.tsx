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

import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import type { TextareaProps } from '@cloudscape-design/components/textarea';
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError } from '../../core/api/client';
import type { TaskDetail, TaskEvent } from '../../core/api/types';
import { QueryError } from '../../core/components/QueryError';
import { ExternalLink, RouterLink } from '../../core/components/RouterLink';
import { activityFeed } from '../../core/util/activity';
import { formatCost, formatDuration, formatRelativeTime, formatTimestamp, repoHref, taskTitle } from '../../core/util/format';
import { outcomeOf, stepStates, type Outcome } from '../../core/util/progress';
import { isTerminal } from '../../core/util/task-health';
import { ApprovalCard } from '../approvals/ApprovalCard';
import { usePendingApprovals } from '../approvals/hooks';
import { ActivityFeed } from './components/ActivityFeed';
import { EventTimeline } from './components/EventTimeline';
import { MessagePanel } from './components/MessagePanel';
import { NewTaskButton } from './components/NewTaskButton';
import { ProgressSteps } from './components/ProgressSteps';
import { useCancelTask, useTask, useTaskEvents } from './hooks';

function CancelTask({ task }: { task: TaskDetail }) {
  const cancel = useCancelTask(task.task_id);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Cancel task</Button>
      <Modal
        visible={open}
        onDismiss={() => setOpen(false)}
        header="Cancel this task?"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setOpen(false)}>Keep it running</Button>
              <Button variant="primary" loading={cancel.isPending} onClick={() => cancel.mutate(undefined, { onSuccess: () => setOpen(false) })}>
                Cancel task
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <span>The agent stops now. Work it has not pushed yet is lost. You can start it again later.</span>
          {cancel.isError && <Alert type="error">{cancel.error instanceof Error ? cancel.error.message : 'The task was not cancelled.'}</Alert>}
        </SpaceBetween>
      </Modal>
    </>
  );
}

function retryPrefill(task: TaskDetail) {
  return { repo: task.repo, issue: task.issue_number, description: task.task_description };
}

function OutcomeBanner({ task, outcome, onMessage }: { task: TaskDetail; outcome: Outcome; onMessage: () => void }) {
  const pending = usePendingApprovals();
  const requests = (pending.data?.pending ?? []).filter((p) => p.task_id === task.task_id);
  const action = outcome.offer === 'stuck'
    ? <Button onClick={onMessage}>Send a message</Button>
    : outcome.offer === 'retry'
      ? <NewTaskButton prefill={retryPrefill(task)} variant="normal" label="Try again" />
      : undefined;
  return (
    <SpaceBetween size="s">
      <Alert type={outcome.type} header={outcome.title} action={action}>{outcome.text}</Alert>
      {outcome.offer === 'approval' && requests.map((r) => <ApprovalCard key={r.request_id} request={r} />)}
    </SpaceBetween>
  );
}

function TaskDetails({ task }: { task: TaskDetail }) {
  return (
    <ExpandableSection headerText="Details" variant="container">
      <KeyValuePairs
        columns={3}
        items={[
          { label: 'Repository', value: task.repo ? <RouterLink href={repoHref(task.repo)}>{task.repo}</RouterLink> : '-' },
          { label: 'Issue', value: task.issue_number && task.repo ? <ExternalLink href={`https://github.com/${task.repo}/issues/${task.issue_number}`}>#{task.issue_number}</ExternalLink> : '-' },
          { label: 'Pull request', value: task.pr_url ? <ExternalLink href={task.pr_url}>#{task.pr_number ?? 'PR'}</ExternalLink> : '-' },
          { label: 'Branch', value: task.branch_name || '-' },
          { label: 'Cost', value: formatCost(task.cost_usd) },
          { label: 'Time taken', value: formatDuration(task.duration_s) },
          { label: 'Started', value: formatTimestamp(task.started_at ?? task.created_at) },
          { label: 'Finished', value: formatTimestamp(task.completed_at) },
          { label: 'Task ID', value: <Box variant="code">{task.task_id}</Box> },
        ]}
      />
    </ExpandableSection>
  );
}

function TaskBody({ task, events, eventsLoading, moreEvents }: {
  task: TaskDetail;
  events: readonly TaskEvent[];
  eventsLoading: boolean;
  moreEvents: boolean;
}) {
  const live = !isTerminal(task.status);
  const messageBox = useRef<TextareaProps.Ref>(null);
  const lines = useMemo(() => activityFeed(events, task.repo), [events, task.repo]);
  const states = useMemo(() => stepStates(task, events), [task, events]);
  const outcome = outcomeOf(task, events);
  const latest = lines.at(-1);

  return (
    <SpaceBetween size="l">
      {outcome && <OutcomeBanner task={task} outcome={outcome} onMessage={() => messageBox.current?.focus()} />}
      <Container>
        <SpaceBetween size="s">
          <ProgressSteps states={states} />
          {live && latest && (
            <Box color="text-body-secondary">
              Right now: {latest.text} <Box variant="span" color="text-status-inactive">· {formatRelativeTime(latest.at)}</Box>
            </Box>
          )}
        </SpaceBetween>
      </Container>
      <Grid gridDefinition={[{ colspan: { default: 12, m: 8 } }, { colspan: { default: 12, m: 4 } }]}>
        <Container
          header={
            <Header variant="h2" description={moreEvents ? 'Showing the latest 100 updates.' : undefined}>
              {live ? "What it's doing" : 'What it did'}
            </Header>
          }
        >
          <ActivityFeed lines={lines} loading={eventsLoading} live={live} />
        </Container>
        <MessagePanel ref={messageBox} taskId={task.task_id} events={events} open={live} />
      </Grid>
      <TaskDetails task={task} />
      <ExpandableSection headerText="Full log" variant="container" headerDescription="Every raw event, for troubleshooting.">
        <EventTimeline taskId={task.task_id} live={live} />
      </ExpandableSection>
    </SpaceBetween>
  );
}

export function TaskDetailPage() {
  const { taskId = '' } = useParams();
  const navigate = useNavigate();
  const query = useTask(taskId);
  const task = query.data;
  const eventsQuery = useTaskEvents(taskId, !task || !isTerminal(task.status));
  const events = eventsQuery.data?.data ?? [];

  const breadcrumbs = (
    <BreadcrumbGroup
      items={[
        ...(task?.repo ? [{ text: 'Repositories', href: '/repos' }, { text: task.repo, href: repoHref(task.repo) }] : [{ text: 'Tasks', href: '/tasks' }]),
        { text: task ? taskTitle(task) : 'Task', href: `/tasks/${encodeURIComponent(taskId)}` },
      ]}
      onFollow={(event) => {
        event.preventDefault();
        navigate(event.detail.href);
      }}
    />
  );

  let body;
  if (query.isPending) {
    body = <Spinner size="large" />;
  } else if (query.isError) {
    body = query.error instanceof ApiError && query.error.status === 404
      ? <Alert type="info" header="Task not found">It may belong to someone else, or no longer exist.</Alert>
      : <QueryError error={query.error} what="the task" />;
  } else if (task) {
    body = <TaskBody task={task} events={events} eventsLoading={eventsQuery.isPending} moreEvents={eventsQuery.data?.pagination.has_more ?? false} />;
  }

  const actions = task && (
    <SpaceBetween direction="horizontal" size="xs">
      {task.pr_url && <Button href={task.pr_url} target="_blank" rel="noopener noreferrer" iconName="external" iconAlign="right">View pull request</Button>}
      {!isTerminal(task.status) && <CancelTask task={task} />}
    </SpaceBetween>
  );

  const description = task && (
    <SpaceBetween direction="horizontal" size="xs">
      {task.repo && <RouterLink href={repoHref(task.repo)}>{task.repo}</RouterLink>}
      <span>Started {formatRelativeTime(task.started_at ?? task.created_at)}</span>
      {task.cost_usd !== null && <span>{isTerminal(task.status) ? 'Cost' : 'Cost so far'} {formatCost(task.cost_usd)}</span>}
    </SpaceBetween>
  );

  return (
    <ContentLayout breadcrumbs={breadcrumbs} header={<Header variant="h1" description={description} actions={actions}>{task ? taskTitle(task) : 'Task'}</Header>}>
      {body}
    </ContentLayout>
  );
}
