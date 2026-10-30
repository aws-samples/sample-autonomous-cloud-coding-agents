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
import { formatCost, formatDuration, formatRelativeTime, formatTimestamp, repoHref, SOURCE_LABEL, taskTitle } from '../../core/util/format';
import { outcomeOf, stepStates, type Outcome } from '../../core/util/progress';
import { isTerminal } from '../../core/util/task-health';
import { buildTurns } from '../../core/util/turns';
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
  return {
    repo: task.repo,
    issue: task.issue_number,
    description: task.task_description,
    maxTurns: task.max_turns,
    maxBudgetUsd: task.max_budget_usd,
    trace: task.trace,
  };
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

const REPO_DEFAULT = 'Repository default';

/** What the task was started with, as chosen; unset limits fall back to the repository's. */
function TaskRequest({ task }: { task: TaskDetail }) {
  const issueUrl = task.issue_number && task.repo ? `https://github.com/${task.repo}/issues/${task.issue_number}` : null;
  return (
    <Container header={<Header variant="h2">Request</Header>}>
      <SpaceBetween size="l">
        <KeyValuePairs
          columns={3}
          items={[
            { label: 'Repository', value: task.repo ? <RouterLink href={repoHref(task.repo)}>{task.repo}</RouterLink> : '-' },
            {
              label: 'Issue',
              value: issueUrl
                ? <ExternalLink href={issueUrl}>{`#${task.issue_number}${task.issue_title ? ` ${task.issue_title}` : ''}`}</ExternalLink>
                : '-',
            },
            { label: 'Started from', value: SOURCE_LABEL[task.channel_source] ?? task.channel_source },
            { label: 'Turn limit', value: task.max_turns ? String(task.max_turns) : REPO_DEFAULT },
            { label: 'Spending limit', value: task.max_budget_usd ? formatCost(task.max_budget_usd) : REPO_DEFAULT },
            { label: 'Full details', value: task.trace ? 'On: keeps up to 4 KB of each command and output' : 'Off: keeps 200 characters' },
            { label: 'Workflow', value: task.resolved_workflow ? <Box variant="code">{`${task.resolved_workflow.id}@${task.resolved_workflow.version}`}</Box> : '-' },
          ]}
        />
        {task.task_description && (
          <KeyValuePairs
            items={[{
              label: task.issue_number ? 'Extra guidance' : 'Instructions',
              value: <span style={{ whiteSpace: 'pre-wrap' }}>{task.task_description}</span>,
            }]}
          />
        )}
      </SpaceBetween>
    </Container>
  );
}

function TaskDetails({ task }: { task: TaskDetail }) {
  return (
    <ExpandableSection headerText="Details" variant="container">
      <KeyValuePairs
        columns={3}
        items={[
          { label: 'Pull request', value: task.pr_url ? <ExternalLink href={task.pr_url}>#{task.pr_number ?? 'PR'}</ExternalLink> : '-' },
          { label: 'Branch', value: task.branch_name || '-' },
          { label: 'Cost', value: formatCost(task.cost_usd) },
          { label: 'Time taken', value: formatDuration(task.duration_s) },
          { label: 'Turns used', value: task.turns_completed === null ? '-' : String(task.turns_completed) },
          { label: 'Started', value: formatTimestamp(task.started_at ?? task.created_at) },
          { label: 'Finished', value: formatTimestamp(task.completed_at) },
          { label: 'Task ID', value: <Box variant="code">{task.task_id}</Box> },
        ]}
      />
    </ExpandableSection>
  );
}

/** "Turn 67 of 500" while it runs; the platform's own count once it has finished. */
function turnLabel(task: TaskDetail, turnsSoFar: number): string | null {
  const turns = isTerminal(task.status) && task.turns_completed !== null ? task.turns_completed : turnsSoFar;
  if (turns === 0) return null;
  return task.max_turns ? `Turn ${turns} of ${task.max_turns}` : `Turn ${turns}`;
}

function TaskBody({ task, events, eventsLoading }: {
  task: TaskDetail;
  events: readonly TaskEvent[];
  eventsLoading: boolean;
}) {
  const live = !isTerminal(task.status);
  const messageBox = useRef<TextareaProps.Ref>(null);
  const lines = useMemo(() => activityFeed(events, task.repo), [events, task.repo]);
  const turnCount = useMemo(() => buildTurns(events).length, [events]);
  const turns = turnLabel(task, turnCount);
  const states = useMemo(() => stepStates(task, events), [task, events]);
  const outcome = outcomeOf(task, events);
  const latest = lines.at(-1);

  return (
    <SpaceBetween size="l">
      {outcome && <OutcomeBanner task={task} outcome={outcome} onMessage={() => messageBox.current?.focus()} />}
      <Container>
        <SpaceBetween size="s">
          <ProgressSteps states={states} />
          {(turns || (live && latest)) && (
            <Box color="text-body-secondary">
              {turns && <Box variant="span" fontWeight="bold">{turns}</Box>}
              {turns && live && latest && ' · '}
              {live && latest && <>Right now: {latest.text} <Box variant="span" color="text-status-inactive">· {formatRelativeTime(latest.at)}</Box></>}
            </Box>
          )}
        </SpaceBetween>
      </Container>
      <Grid gridDefinition={[{ colspan: { default: 12, m: 8 } }, { colspan: { default: 12, m: 4 } }]}>
        <Container
          header={
            <Header variant="h2" description="Click a step to see what ran and what came back.">
              {live ? "What it's doing" : 'What it did'}
            </Header>
          }
        >
          <ActivityFeed lines={lines} loading={eventsLoading} live={live} trace={task.trace} />
        </Container>
        <MessagePanel ref={messageBox} taskId={task.task_id} events={events} open={live} />
      </Grid>
      <TaskRequest task={task} />
      <TaskDetails task={task} />
      <ExpandableSection headerText="Full log" variant="container" headerDescription="Every turn with its commands and output, or every raw event.">
        <EventTimeline taskId={task.task_id} live={live} repo={task.repo} trace={task.trace} />
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
  const events = eventsQuery.data?.events ?? [];

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
    body = <TaskBody task={task} events={events} eventsLoading={eventsQuery.isPending} />;
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
