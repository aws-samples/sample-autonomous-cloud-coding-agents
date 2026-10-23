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
import Table from '@cloudscape-design/components/table';
import type { PendingApprovalSummary } from '../../core/api/types';
import { QueryError } from '../../core/components/QueryError';
import { RouterLink } from '../../core/components/RouterLink';
import { SeverityBadge } from '../../core/components/StatusBadge';
import { formatRelativeTime, shortId } from '../../core/util/format';
import { usePendingApprovals } from './hooks';

export function ApprovalsPage() {
  const query = usePendingApprovals();
  const items = query.data?.pending ?? [];

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Tool calls your agents paused on because a policy rule requires a human decision. Approving and denying from the console comes next; until then use `bgagent approve` or `bgagent deny`."
        >
          Approvals
        </Header>
      }
    >
      {query.isError ? (
        <QueryError error={query.error} what="pending approvals" />
      ) : (
        <Table<PendingApprovalSummary>
          variant="full-page"
          loading={query.isPending}
          loadingText="Loading pending approvals"
          items={[...items]}
          trackBy="request_id"
          header={<Header counter={query.data ? `(${items.length})` : undefined}>Waiting for a decision</Header>}
          columnDefinitions={[
            {
              id: 'task',
              header: 'Task',
              cell: (p) => <RouterLink href={`/tasks/${encodeURIComponent(p.task_id)}`}>{shortId(p.task_id)}</RouterLink>,
              isRowHeader: true,
            },
            { id: 'severity', header: 'Severity', cell: (p) => <SeverityBadge severity={p.severity} /> },
            { id: 'tool', header: 'Tool', cell: (p) => p.tool_name },
            { id: 'input', header: 'Input', cell: (p) => <code>{p.tool_input_preview}</code>, maxWidth: 360 },
            { id: 'reason', header: 'Reason', cell: (p) => p.reason },
            { id: 'rules', header: 'Matched rules', cell: (p) => p.matching_rule_ids.join(', ') || '-' },
            { id: 'requested', header: 'Requested', cell: (p) => formatRelativeTime(p.created_at) },
            { id: 'expires', header: 'Expires', cell: (p) => formatRelativeTime(p.expires_at) },
          ]}
          empty={<Box textAlign="center" color="inherit">Nothing is waiting for approval.</Box>}
        />
      )}
    </ContentLayout>
  );
}
