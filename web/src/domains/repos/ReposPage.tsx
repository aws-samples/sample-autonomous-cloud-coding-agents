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
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { QueryError } from '../../core/components/QueryError';
import { RouterLink } from '../../core/components/RouterLink';
import { formatRelativeTime, repoHref } from '../../core/util/format';
import { NewTaskButton } from '../tasks/components/NewTaskButton';
import { useTaskList } from '../tasks/hooks';
import { summarizeRepos, type RepoSummary } from './repo-summary';

function count(value: number, type: 'in-progress' | 'warning' | 'success' | 'error') {
  return value === 0 ? <Box color="text-status-inactive">0</Box> : <StatusIndicator type={type}>{value}</StatusIndicator>;
}

export function ReposPage() {
  const navigate = useNavigate();
  const query = useTaskList();
  const repos = useMemo(() => summarizeRepos(query.data?.pages.flatMap((p) => p.data) ?? []), [query.data]);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Repositories your agents have worked on. Click one to see its tasks."
          actions={<NewTaskButton />}
        >
          Repositories
        </Header>
      }
    >
      {query.isError ? (
        <QueryError error={query.error} what="repositories" />
      ) : (
        <Table<RepoSummary>
          variant="full-page"
          loading={query.isPending}
          loadingText="Loading repositories"
          items={repos}
          trackBy="repo"
          onRowClick={({ detail }) => navigate(repoHref(detail.item.repo))}
          header={<Header counter={query.data ? `(${repos.length})` : undefined}>Repositories</Header>}
          columnDefinitions={[
            { id: 'repo', header: 'Repository', cell: (r) => <RouterLink href={repoHref(r.repo)}>{r.repo}</RouterLink>, isRowHeader: true },
            { id: 'working', header: 'Working', cell: (r) => count(r.working, 'in-progress') },
            { id: 'needs', header: 'Needs you', cell: (r) => count(r.needsYou, 'warning') },
            { id: 'done', header: 'Done', cell: (r) => count(r.done, 'success') },
            { id: 'failed', header: 'Failed', cell: (r) => count(r.failed, 'error') },
            { id: 'last', header: 'Last activity', cell: (r) => formatRelativeTime(r.lastActivity) },
          ]}
          empty={
            <Box textAlign="center" color="inherit">
              <Box variant="p" color="inherit">No tasks yet, so no repositories to show.</Box>
              <NewTaskButton label="Start your first task" />
            </Box>
          }
          footer={query.hasNextPage ? <Box textAlign="center" color="text-status-inactive">Based on your most recent tasks.</Box> : undefined}
        />
      )}
    </ContentLayout>
  );
}
