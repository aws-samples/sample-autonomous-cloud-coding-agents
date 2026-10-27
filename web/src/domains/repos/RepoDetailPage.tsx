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

import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import { useNavigate, useParams } from 'react-router';
import { QueryError } from '../../core/components/QueryError';
import { ExternalLink } from '../../core/components/RouterLink';
import { repoHref } from '../../core/util/format';
import { NewTaskButton } from '../tasks/components/NewTaskButton';
import { TaskTable } from '../tasks/components/TaskTable';
import { useTaskList } from '../tasks/hooks';

export function RepoDetailPage() {
  const { owner = '', name = '' } = useParams();
  const repo = `${owner}/${name}`;
  const navigate = useNavigate();
  const query = useTaskList(undefined, repo);
  const items = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <ContentLayout
      breadcrumbs={
        <BreadcrumbGroup
          items={[{ text: 'Repositories', href: '/repos' }, { text: repo, href: repoHref(repo) }]}
          onFollow={(event) => {
            event.preventDefault();
            navigate(event.detail.href);
          }}
        />
      }
      header={
        <Header
          variant="h1"
          description={<ExternalLink href={`https://github.com/${repo}`}>Open on GitHub</ExternalLink>}
          actions={<NewTaskButton prefill={{ repo }} />}
        >
          {repo}
        </Header>
      }
    >
      {query.isError ? (
        <QueryError error={query.error} what="tasks" />
      ) : (
        <TaskTable
          loading={query.isPending}
          items={items}
          showRepo={false}
          header={<Header counter={query.data ? `(${items.length}${query.hasNextPage ? '+' : ''})` : undefined}>Tasks</Header>}
          hasMore={query.hasNextPage}
          loadingMore={query.isFetchingNextPage}
          onLoadMore={() => query.fetchNextPage()}
        />
      )}
    </ContentLayout>
  );
}
