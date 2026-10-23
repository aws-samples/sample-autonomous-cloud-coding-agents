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
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useNavigate, useParams } from 'react-router';
import { ApiError } from '../../core/api/client';
import type { TaskDetail } from '../../core/api/types';
import { QueryError } from '../../core/components/QueryError';
import { ExternalLink, RouterLink } from '../../core/components/RouterLink';
import { StatusBadge } from '../../core/components/StatusBadge';
import { formatCost, formatDuration, formatRelativeTime, formatTimestamp, shortId } from '../../core/util/format';
import { hasStaleHeartbeat, isTerminal } from '../../core/util/task-health';
import { EventTimeline } from './components/EventTimeline';
import { useTask } from './hooks';

function check(value: boolean | null) {
  if (value === null) return '-';
  return <StatusIndicator type={value ? 'success' : 'error'}>{value ? 'Passed' : 'Failed'}</StatusIndicator>;
}

function budget(task: TaskDetail): string {
  const spent = formatCost(task.cost_usd);
  return task.max_budget_usd === null ? spent : `${spent} of ${formatCost(task.max_budget_usd)}`;
}

function turns(task: TaskDetail): string {
  if (task.turns_completed === null && task.max_turns === null) return '-';
  return `${task.turns_completed ?? '-'} of ${task.max_turns ?? '-'}`;
}

function TaskAlerts({ task }: { task: TaskDetail }) {
  return (
    <>
      {task.status === 'AWAITING_APPROVAL' && (
        <Alert type="warning" header="This task is paused for approval">
          The agent is waiting for a human decision. See <RouterLink href="/approvals">Approvals</RouterLink>.
        </Alert>
      )}
      {hasStaleHeartbeat(task) && (
        <Alert type="warning" header="No recent heartbeat from the agent">
          The agent last reported {task.agent_heartbeat_at ? formatRelativeTime(task.agent_heartbeat_at) : 'never'}.
          The platform marks a task stranded and fails it when liveness stays lost.
        </Alert>
      )}
      {task.error_classification ? (
        <Alert type="error" header={task.error_classification.title}>
          <SpaceBetween size="xxs">
            <span>{task.error_classification.description}</span>
            <span><strong>What to do:</strong> {task.error_classification.remedy}</span>
          </SpaceBetween>
        </Alert>
      ) : (
        task.error_message && <Alert type="error" header="Task error">{task.error_message}</Alert>
      )}
    </>
  );
}

function TaskSummaryPanel({ task }: { task: TaskDetail }) {
  return (
    <Container header={<Header variant="h2">Summary</Header>}>
      <KeyValuePairs
        columns={3}
        items={[
          { label: 'Status', value: <StatusBadge status={task.status} /> },
          { label: 'Repository', value: task.repo ?? '-' },
          { label: 'Branch', value: task.branch_name || '-' },
          { label: 'Pull request', value: task.pr_url ? <ExternalLink href={task.pr_url}>#{task.pr_number ?? 'PR'}</ExternalLink> : '-' },
          { label: 'Issue', value: task.issue_number ? `#${task.issue_number}` : '-' },
          { label: 'Submitted via', value: task.channel_source },
          { label: 'Created', value: formatTimestamp(task.created_at) },
          { label: 'Started', value: formatTimestamp(task.started_at) },
          { label: 'Completed', value: formatTimestamp(task.completed_at) },
          { label: 'Duration', value: formatDuration(task.duration_s) },
          { label: 'Last heartbeat', value: formatRelativeTime(task.agent_heartbeat_at) },
          { label: 'Cost', value: budget(task) },
          { label: 'Turns', value: turns(task) },
          { label: 'Build', value: check(task.build_passed) },
          { label: 'Lint', value: check(task.lint_passed) },
          { label: 'Workflow', value: task.resolved_workflow ? `${task.resolved_workflow.id}@${task.resolved_workflow.version}` : '-' },
          { label: 'Approval gates', value: task.approval_gate_count === null ? '-' : `${task.approval_gate_count} of ${task.approval_gate_cap ?? '-'}` },
          { label: 'Queue position', value: task.queue_position ?? '-' },
        ]}
      />
    </Container>
  );
}

export function TaskDetailPage() {
  const { taskId = '' } = useParams();
  const navigate = useNavigate();
  const query = useTask(taskId);
  const task = query.data;

  const breadcrumbs = (
    <BreadcrumbGroup
      items={[{ text: 'Tasks', href: '/tasks' }, { text: shortId(taskId), href: `/tasks/${encodeURIComponent(taskId)}` }]}
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
      ? <Alert type="info" header="Task not found">It may belong to another user or no longer exist.</Alert>
      : <QueryError error={query.error} what="the task" />;
  } else if (task) {
    body = (
      <SpaceBetween size="l">
        <TaskAlerts task={task} />
        <TaskSummaryPanel task={task} />
        <EventTimeline taskId={task.task_id} live={!isTerminal(task.status)} />
      </SpaceBetween>
    );
  }

  return (
    <ContentLayout
      breadcrumbs={breadcrumbs}
      header={<Header variant="h1" description={task?.task_description ?? undefined}>Task {shortId(taskId)}</Header>}
    >
      {body}
    </ContentLayout>
  );
}
