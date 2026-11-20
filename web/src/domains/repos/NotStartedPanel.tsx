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
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import TextFilter from '@cloudscape-design/components/text-filter';
import { useMemo, useState, type ReactNode } from 'react';
import type { LinearIssueSummary, LinearProjectIssues, RepoIssueSummary, TaskSummary } from '../../core/api/types';
import { InfoTip } from '../../core/components/InfoTip';
import { ExternalLink, RouterLink } from '../../core/components/RouterLink';
import { formatRelativeTime, taskHref } from '../../core/util/format';
import { MAX_REPO_TASKS, useLinearIssues, useRepoIssues, useStartGitHubIssue, useStartLinearIssue } from '../tasks/hooks';

/** A search box appears once a list is long enough to need one. */
const FILTER_FROM = 8;

function includes(haystack: string, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  return !n || haystack.toLowerCase().includes(n);
}

function Labels({ labels }: { labels: readonly string[] }) {
  return labels.length > 0 ? <Box variant="small" color="text-body-secondary">{labels.join(', ')}</Box> : <>-</>;
}

/** Open GitHub issues with no agent task yet. */
/**
 * Open GitHub issues with no agent task yet. Start waits until every task of the
 * repository is loaded (`ready`): otherwise an issue whose task is on a later page
 * would look unstarted and get a second task.
 */
function GitHubIssues({ repo, issues, ready, capped }: { repo: string; issues: readonly RepoIssueSummary[]; ready: boolean; capped: boolean }) {
  const start = useStartGitHubIssue(repo);
  const [filter, setFilter] = useState('');
  const [started, setStarted] = useState<{ number: number; taskId: string } | null>(null);
  const items = issues.filter((i) => includes(`#${i.number} ${i.title} ${i.labels.join(' ')}`, filter));
  return (
    <SpaceBetween size="s">
      {started && (
        <Alert
          type="success"
          dismissible
          onDismiss={() => setStarted(null)}
          header={`Issue #${started.number} is with the agent`}
          action={<RouterLink href={taskHref(started.taskId)}>Follow its progress</RouterLink>}
        >
          It opens a pull request when it is done. The issue now shows under Tasks.
        </Alert>
      )}
      {start.isError && (
        <Alert type="error" dismissible onDismiss={() => start.reset()} header="Could not start the issue">
          {start.error instanceof Error ? start.error.message : String(start.error)}
        </Alert>
      )}
      {!ready && (
        <Box variant="small" color="text-status-inactive">
          {capped
            ? `This repository has more than ${MAX_REPO_TASKS.toLocaleString()} tasks, too many to check which issues already have one. Start an issue from New task instead.`
            : 'Checking which issues already have a task…'}
        </Box>
      )}
      <Table<RepoIssueSummary>
        variant="embedded"
        items={items}
        trackBy="number"
        ariaLabels={{ tableLabel: 'GitHub issues not started' }}
        filter={issues.length > FILTER_FROM ? (
          <TextFilter filteringText={filter} filteringPlaceholder="Search GitHub issues" onChange={({ detail }) => setFilter(detail.filteringText)} />
        ) : undefined}
        columnDefinitions={[
          {
            id: 'issue',
            header: 'Issue',
            isRowHeader: true,
            cell: (i) => (
              <span>
                <Box variant="span" color="text-body-secondary" fontWeight="bold">#{i.number}</Box>{' '}
                <ExternalLink href={i.url}>{i.title}</ExternalLink>
              </span>
            ),
          },
          { id: 'labels', header: 'Labels', cell: (i) => <Labels labels={i.labels} /> },
          { id: 'updated', header: 'Updated', cell: (i) => formatRelativeTime(i.updated_at) },
          {
            id: 'start',
            header: '',
            cell: (i) => (
              <Button
                iconName="caret-right-filled"
                loading={start.isPending && start.variables === i.number}
                disabled={!ready || (start.isPending && start.variables !== i.number)}
                ariaLabel={`Start issue #${i.number}`}
                onClick={() => start.mutate(i.number, { onSuccess: (task) => setStarted({ number: i.number, taskId: task.task_id }) })}
              >
                Start
              </Button>
            ),
          },
        ]}
        empty={<Box textAlign="center" color="inherit">{filter ? 'No issues match.' : 'Every open GitHub issue already has a task.'}</Box>}
      />
    </SpaceBetween>
  );
}

/** Open Linear issues the agent has not picked up, for one connected project. */
function LinearIssues({ repo, project, issues }: { repo: string; project: LinearProjectIssues; issues: readonly LinearIssueSummary[] }) {
  const start = useStartLinearIssue(repo);
  const [filter, setFilter] = useState('');
  const [started, setStarted] = useState<string | null>(null);
  const pendingId = start.isPending ? start.variables?.issueId : undefined;
  const items = issues.filter((i) => includes(`${i.identifier} ${i.title} ${i.state} ${i.labels.join(' ')}`, filter));
  return (
    <SpaceBetween size="s">
      {started && (
        <Alert type="success" dismissible onDismiss={() => setStarted(null)} header={`${started} is with the agent`}>
          It will comment on the issue in Linear within a minute, and open a pull request when it's done. The issue then
          shows under Tasks.
        </Alert>
      )}
      {start.isError && (
        <Alert type="error" dismissible onDismiss={() => start.reset()} header="Could not start the issue">
          {start.error instanceof Error ? start.error.message : String(start.error)}
        </Alert>
      )}
      {project.problem && <Alert type="warning" header="Linear issues are unavailable">{project.problem}</Alert>}
      <Table<LinearIssueSummary>
        variant="embedded"
        items={items}
        trackBy="id"
        ariaLabels={{ tableLabel: 'Linear issues not started' }}
        filter={issues.length > FILTER_FROM ? (
          <TextFilter filteringText={filter} filteringPlaceholder="Search Linear issues" onChange={({ detail }) => setFilter(detail.filteringText)} />
        ) : undefined}
        columnDefinitions={[
          {
            id: 'issue',
            header: 'Issue',
            isRowHeader: true,
            cell: (i) => (
              <span>
                <Box variant="span" color="text-body-secondary" fontWeight="bold">{i.identifier}</Box>{' '}
                <ExternalLink href={i.url}>{i.title}</ExternalLink>
              </span>
            ),
          },
          // Status and priority together keep the table one screen wide.
          { id: 'state', header: 'In Linear', cell: (i) => [i.state, i.priority_label].filter(Boolean).join(' · ') || '-' },
          { id: 'updated', header: 'Updated', cell: (i) => formatRelativeTime(i.updated_at) },
          {
            id: 'start',
            header: '',
            cell: (i) => (i.agent.kind === 'starting'
              ? <StatusIndicator type="loading">Starting…</StatusIndicator>
              : (
                <Button
                  iconName="caret-right-filled"
                  loading={pendingId === i.id}
                  disabled={start.isPending && pendingId !== i.id}
                  ariaLabel={`Start ${i.identifier}`}
                  onClick={() => start.mutate({ issueId: i.id, projectId: project.project_id }, { onSuccess: (res) => setStarted(res.identifier) })}
                >
                  Start
                </Button>
              )),
          },
        ]}
        empty={<Box textAlign="center" color="inherit">{project.problem ? 'Nothing to show.' : filter ? 'No issues match.' : 'Every open Linear issue is already with the agent.'}</Box>}
      />
    </SpaceBetween>
  );
}

/**
 * Work that could go to the agent but has not yet: open GitHub issues and open
 * issues in the connected Linear project that have no task. Start is one click;
 * the issue then leaves this list and appears under Tasks.
 */
export function NotStartedPanel({ repo, tasks, tasksComplete, tasksCapped = false }: {
  repo: string;
  tasks: readonly TaskSummary[];
  /** Every task of the repository is loaded, so "no task yet" can be trusted. */
  tasksComplete: boolean;
  tasksCapped?: boolean;
}) {
  const github = useRepoIssues(repo, true);
  const linear = useLinearIssues(repo);
  const [tab, setTab] = useState('github');

  const startedIssues = useMemo(() => new Set(tasks.map((t) => t.issue_number).filter((n): n is number => n !== null)), [tasks]);
  const githubIssues = (github.data?.issues ?? []).filter((i) => !startedIssues.has(i.number));
  const linearProjects = linear.data?.projects ?? [];
  const linearIssues = linearProjects.flatMap((p) => p.issues.filter((i) => i.agent.kind !== 'task').map((issue) => ({ project: p, issue })));

  // null: this deployment has no console API to list issues with.
  if (github.data === null && (linear.data === null || linear.data === undefined)) return null;

  const tabs: Array<{ id: string; label: string; content: ReactNode }> = [];
  if (github.data !== null) {
    tabs.push({
      id: 'github',
      label: `GitHub issues${github.data ? ` (${githubIssues.length})` : ''}`,
      content: github.isError
        ? <Alert type="warning" header="Could not load GitHub issues">{github.error instanceof Error ? github.error.message : String(github.error)}</Alert>
        : github.isPending ? <Box color="text-status-inactive">Loading…</Box> : <GitHubIssues repo={repo} issues={githubIssues} ready={tasksComplete} capped={tasksCapped} />,
    });
  }
  if (linear.isError) {
    // Show the failure: hiding it made a broken connection look like "no Linear project".
    tabs.push({
      id: 'linear',
      label: 'Linear',
      content: <Alert type="warning" header="Could not load Linear issues">{linear.error instanceof Error ? linear.error.message : String(linear.error)}</Alert>,
    });
  } else if (linearProjects.length > 0) {
    tabs.push({
      id: 'linear',
      label: `Linear (${linearIssues.length})`,
      content: (
        <SpaceBetween size="l">
          {linearProjects.map((project) => (
            <LinearIssues
              key={project.project_id}
              repo={repo}
              project={project}
              issues={linearIssues.filter((x) => x.project === project).map((x) => x.issue)}
            />
          ))}
        </SpaceBetween>
      ),
    });
  }
  if (tabs.length === 0) return null;

  return (
    <Container
      header={(
        <Header
          variant="h2"
          description="Open issues the agent has not picked up yet. Start hands one over in one click."
          info={(
            <InfoTip about="Not started yet">
              These are issues in GitHub and in the connected Linear project, not tasks yet. Start creates a task for the
              issue: the agent works on it and opens a pull request, and the issue moves to Tasks below. Starting a Linear
              issue adds the agent label in Linear, so the agent also comments there as it works.
            </InfoTip>
          )}
        >
          Not started yet
        </Header>
      )}
    >
      <Tabs activeTabId={tabs.some((t) => t.id === tab) ? tab : tabs[0].id} onChange={({ detail }) => setTab(detail.activeTabId)} tabs={tabs} />
    </Container>
  );
}
