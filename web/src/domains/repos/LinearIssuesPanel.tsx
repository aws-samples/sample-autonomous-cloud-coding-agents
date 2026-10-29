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
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import { useState } from 'react';
import type { LinearIssueSummary, LinearProjectIssues } from '../../core/api/types';
import { ExternalLink, RouterLink } from '../../core/components/RouterLink';
import { StatusBadge } from '../../core/components/StatusBadge';
import { taskHref } from '../../core/util/format';
import { useLinearIssues, useStartLinearIssue } from '../tasks/hooks';

function AgentCell({ issue, starting, onStart }: { issue: LinearIssueSummary; starting: boolean; onStart: () => void }) {
  const agent = issue.agent;
  if (agent.kind === 'available') {
    return <Button iconName="caret-right-filled" loading={starting} onClick={onStart} ariaLabel={`Start ${issue.identifier}`}>Start</Button>;
  }
  if (agent.kind === 'starting') return <StatusIndicator type="loading">Starting…</StatusIndicator>;
  if (!agent.mine) return <StatusIndicator type="info">Someone else's task</StatusIndicator>;
  return (
    <SpaceBetween direction="horizontal" size="xs" alignItems="center">
      {agent.status ? <StatusBadge status={agent.status} /> : null}
      {agent.task_id && <RouterLink href={taskHref(agent.task_id)}>View task</RouterLink>}
      {agent.pr_url && <ExternalLink href={agent.pr_url}>PR</ExternalLink>}
    </SpaceBetween>
  );
}

function matches(issue: LinearIssueSummary, text: string): boolean {
  const needle = text.trim().toLowerCase();
  return !needle || `${issue.identifier} ${issue.title} ${issue.state} ${issue.labels.join(' ')}`.toLowerCase().includes(needle);
}

function ProjectIssues({ repo, project }: { repo: string; project: LinearProjectIssues }) {
  const start = useStartLinearIssue(repo);
  const [filter, setFilter] = useState('');
  const [started, setStarted] = useState<string | null>(null);
  const pendingId = start.isPending ? start.variables?.issueId : undefined;
  const items = project.issues.filter((i) => matches(i, filter));
  const available = project.issues.filter((i) => i.agent.kind === 'available').length;

  return (
    <SpaceBetween size="s">
      {started && (
        <Alert type="success" dismissible onDismiss={() => setStarted(null)} header={`${started} is with the agent`}>
          It will comment on the issue in Linear within a minute, and open a pull request when it's done. Its progress shows here.
        </Alert>
      )}
      {start.isError && (
        <Alert type="error" dismissible onDismiss={() => start.reset()} header="Could not start the issue">
          {start.error instanceof Error ? start.error.message : String(start.error)}
        </Alert>
      )}
      {project.problem && <Alert type="warning" header="Linear issues are unavailable">{project.problem}</Alert>}
      <Table<LinearIssueSummary>
        variant="container"
        items={items}
        trackBy="id"
        header={
          <Header
            variant="h2"
            counter={`(${project.issues.length})`}
            description={`Open issues in the connected Linear project. Start adds the "${project.trigger_label}" label, so the agent picks the issue up and keeps you posted in Linear.`}
          >
            From Linear
          </Header>
        }
        filter={project.issues.length > 8 ? (
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
          {
            id: 'state',
            header: 'In Linear',
            // Status and priority together keep the table one screen wide.
            cell: (i) => [i.state, i.priority_label].filter(Boolean).join(' · ') || '-',
          },
          {
            id: 'agent',
            header: 'Agent',
            cell: (i) => (
              <AgentCell
                issue={i}
                starting={pendingId === i.id}
                onStart={() => start.mutate({ issueId: i.id, projectId: project.project_id }, { onSuccess: (res) => setStarted(res.identifier) })}
              />
            ),
          },
        ]}
        empty={
          <Box textAlign="center" color="inherit">
            {project.problem ? 'Nothing to show.' : 'No open issues in this Linear project.'}
          </Box>
        }
        footer={available > 0 && !filter ? <Box variant="small" color="text-status-inactive">{available} ready to start</Box> : undefined}
      />
    </SpaceBetween>
  );
}

/**
 * The open Linear issues of the projects mapped to this repository, each ready to hand
 * to the agent. Renders nothing when the repo has no Linear project (or no console API).
 */
export function LinearIssuesPanel({ repo }: { repo: string }) {
  const query = useLinearIssues(repo);
  if (query.isError) {
    // Show the failure: hiding it made a broken connection look like "no Linear project".
    return (
      <Alert type="warning" header="Could not load Linear issues">
        {query.error instanceof Error ? query.error.message : String(query.error)}
      </Alert>
    );
  }
  if (query.isPending || !query.data || query.data.projects.length === 0) return null;
  return (
    <SpaceBetween size="l">
      {query.data.projects.map((project) => <ProjectIssues key={project.project_id} repo={repo} project={project} />)}
    </SpaceBetween>
  );
}
