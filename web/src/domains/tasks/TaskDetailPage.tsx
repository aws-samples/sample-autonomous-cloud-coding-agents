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
import { InfoTip } from '../../core/components/InfoTip';
import { QueryError } from '../../core/components/QueryError';
import { StatusBadge } from '../../core/components/StatusBadge';
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

/** "5 of 60" while it runs; the platform's own count once it has finished. */
function turnsValue(task: TaskDetail, turnsSoFar: number): string {
  const turns = isTerminal(task.status) && task.turns_completed !== null ? task.turns_completed : turnsSoFar;
  if (turns === 0) return '-';
  return task.max_turns ? `${turns} of ${task.max_turns}` : String(turns);
}

function costValue(task: TaskDetail, live: boolean): string {
  const limit = task.max_budget_usd ? ` (limit ${formatCost(task.max_budget_usd)})` : '';
  if (task.cost_usd !== null) return `${formatCost(task.cost_usd)}${limit}`;
  return live ? `Shown when it finishes${limit}` : '-';
}

function timeValue(task: TaskDetail, now: Date): string {
  if (task.duration_s !== null) return formatDuration(task.duration_s);
  const started = task.started_at ? Date.parse(task.started_at) : NaN;
  return Number.isNaN(started) || isTerminal(task.status) ? '-' : formatDuration(Math.max(0, Math.round((now.getTime() - started) / 1000)));
}

/** Where it is and the numbers people check first. */
function TaskProgress({ task, events, live }: { task: TaskDetail; events: readonly TaskEvent[]; live: boolean }) {
  const states = useMemo(() => stepStates(task, events), [task, events]);
  const turnCount = useMemo(() => buildTurns(events).length, [events]);
  const latest = useMemo(() => activityFeed(events, task.repo).at(-1), [events, task.repo]);
  return (
    <Container
      header={(
        <Header
          variant="h2"
          info={(
            <InfoTip about="Progress">
              Every task goes through the same five stages: waiting in line, setting up a copy of the repository, working on
              the change, checking that it builds and its tests pass, and opening a pull request. The line shows how far it
              has got.
            </InfoTip>
          )}
        >
          Progress
        </Header>
      )}
    >
      <SpaceBetween size="l">
        <SpaceBetween size="s">
          <ProgressSteps states={states} />
          {live && latest && (
            <Box color="text-body-secondary">
              Right now: {latest.text} <Box variant="span" color="text-status-inactive">· {formatRelativeTime(latest.at)}</Box>
            </Box>
          )}
        </SpaceBetween>
        <KeyValuePairs
          columns={4}
          items={[
            {
              label: 'Turns',
              value: turnsValue(task, turnCount),
              info: (
                <InfoTip about="Turns">
                  A turn is one round of work: the AI looks at what happened so far, decides what to do, and runs a tool
                  such as a command or a file edit. The task stops when it reaches its turn limit.
                </InfoTip>
              ),
            },
            {
              label: 'Cost',
              value: costValue(task, live),
              info: (
                <InfoTip about="Cost">
                  An estimate of what the AI model has cost for this task, reported by the agent when it finishes. With a
                  spending limit, the agent stops once it goes over, after finishing the step it is on.
                </InfoTip>
              ),
            },
            { label: isTerminal(task.status) ? 'Time taken' : 'Running for', value: timeValue(task, new Date()) },
            {
              label: 'Pull request',
              value: task.pr_url ? <ExternalLink href={task.pr_url}>#{task.pr_number ?? 'PR'}</ExternalLink> : live ? 'Not yet' : 'None',
              info: (
                <InfoTip about="Pull request">
                  When the agent is done it opens a pull request in the repository. Review it and merge it there; nothing
                  changes in the repository until you do.
                </InfoTip>
              ),
            },
          ]}
        />
      </SpaceBetween>
    </Container>
  );
}

/** What it was asked to do, the limits it ran under, and the identifiers to look it up by. */
function TaskSettings({ task }: { task: TaskDetail }) {
  const issueUrl = task.issue_number && task.repo ? `https://github.com/${task.repo}/issues/${task.issue_number}` : null;
  return (
    <ExpandableSection
      variant="container"
      headerText="Settings and details"
      headerDescription="What it was asked to do, its limits, and where it worked."
      headerInfo={(
        <InfoTip about="Settings and details">
          Everything the task was started with. Limits left empty when starting show as "Repository default": the
          repository's own settings apply.
        </InfoTip>
      )}
    >
      <SpaceBetween size="l">
        {task.task_description && (
          <KeyValuePairs
            items={[{
              label: task.issue_number ? 'Extra guidance' : 'Instructions',
              value: <span style={{ whiteSpace: 'pre-wrap' }}>{task.task_description}</span>,
            }]}
          />
        )}
        <KeyValuePairs
          columns={3}
          items={[
            {
              label: 'Issue',
              value: issueUrl
                ? <ExternalLink href={issueUrl}>{`#${task.issue_number}${task.issue_title ? ` ${task.issue_title}` : ''}`}</ExternalLink>
                : '-',
            },
            { label: 'Repository', value: task.repo ? <RouterLink href={repoHref(task.repo)}>{task.repo}</RouterLink> : '-' },
            { label: 'Started from', value: SOURCE_LABEL[task.channel_source] ?? task.channel_source },
            { label: 'Turn limit', value: task.max_turns ? String(task.max_turns) : REPO_DEFAULT },
            { label: 'Spending limit', value: task.max_budget_usd ? formatCost(task.max_budget_usd) : REPO_DEFAULT },
            {
              label: 'Full details',
              value: task.trace ? 'On: keeps up to 4 KB of each command and output' : 'Off: keeps 200 characters',
              info: (
                <InfoTip about="Full details">
                  How much of each command and its output the platform keeps for the activity list. Turn on "Keep full
                  details" when starting a task to keep up to 4 KB instead of the first 200 characters.
                </InfoTip>
              ),
            },
            { label: 'Branch', value: task.branch_name ? <Box variant="code">{task.branch_name}</Box> : '-' },
            {
              label: 'Workflow',
              value: task.resolved_workflow ? <Box variant="code">{`${task.resolved_workflow.id}@${task.resolved_workflow.version}`}</Box> : '-',
              info: (
                <InfoTip about="Workflow">
                  The recipe the platform followed for this task, for example: copy the repository, make the change, check
                  the build and tests, open a pull request.
                </InfoTip>
              ),
            },
            {
              label: 'Task ID',
              value: <Box variant="code">{task.task_id}</Box>,
              info: <InfoTip about="Task ID">Use this to find the task with the bgagent command line, or when asking for help.</InfoTip>,
            },
            { label: 'Started', value: formatTimestamp(task.started_at ?? task.created_at) },
            { label: 'Finished', value: formatTimestamp(task.completed_at) },
          ]}
        />
      </SpaceBetween>
    </ExpandableSection>
  );
}

function TaskBody({ task, events, eventsLoading }: {
  task: TaskDetail;
  events: readonly TaskEvent[];
  eventsLoading: boolean;
}) {
  const live = !isTerminal(task.status);
  const messageBox = useRef<TextareaProps.Ref>(null);
  const lines = useMemo(() => activityFeed(events, task.repo), [events, task.repo]);
  const outcome = outcomeOf(task);

  return (
    <SpaceBetween size="l">
      {outcome && <OutcomeBanner task={task} outcome={outcome} onMessage={() => messageBox.current?.focus()} />}
      <TaskProgress task={task} events={events} live={live} />
      <Container
        header={(
          <Header
            variant="h2"
            description="Click a step to see what ran and what came back."
            info={(
              <InfoTip about="Activity">
                What the agent did, in plain words and oldest first. Steps with an arrow open to show the exact command or
                file and what came back. Quoted lines are what the agent said along the way.
              </InfoTip>
            )}
          >
            {live ? "What it's doing" : 'What it did'}
          </Header>
        )}
        footer={live ? <MessagePanel ref={messageBox} taskId={task.task_id} events={events} open={live} /> : undefined}
      >
        <ActivityFeed lines={lines} loading={eventsLoading} live={live} trace={task.trace} />
      </Container>
      <TaskSettings task={task} />
      <ExpandableSection
        variant="container"
        headerText="Full log"
        headerDescription="For troubleshooting."
        headerInfo={(
          <InfoTip about="Full log">
            The complete record. "By turn" lists every turn with each command and its full output. "Every event" is the
            raw list the platform stored, newest first.
          </InfoTip>
        )}
      >
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
    <SpaceBetween direction="horizontal" size="s" alignItems="center">
      <StatusBadge status={task.status} />
      {task.repo && <RouterLink href={repoHref(task.repo)}>{task.repo}</RouterLink>}
      <span>Started {formatRelativeTime(task.started_at ?? task.created_at)}</span>
    </SpaceBetween>
  );

  return (
    <ContentLayout breadcrumbs={breadcrumbs} header={<Header variant="h1" description={description} actions={actions}>{task ? taskTitle(task) : 'Task'}</Header>}>
      {body}
    </ContentLayout>
  );
}
