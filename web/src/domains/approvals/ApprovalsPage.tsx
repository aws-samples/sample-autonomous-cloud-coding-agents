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
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import { useMemo, useState } from 'react';
import { QueryError } from '../../core/components/QueryError';
import { taskTitle } from '../../core/util/format';
import { useTaskList } from '../tasks/hooks';
import { ApprovalCard, decisionMessage } from './ApprovalCard';
import { usePendingApprovals, type Decision } from './hooks';

export function ApprovalsPage() {
  const query = usePendingApprovals();
  const tasks = useTaskList(['AWAITING_APPROVAL']);
  const titles = useMemo(
    () => new Map((tasks.data?.pages.flatMap((p) => p.data) ?? []).map((t) => [t.task_id, taskTitle(t)])),
    [tasks.data],
  );
  const items = query.data?.pending ?? [];
  const [answered, setAnswered] = useState<Array<{ id: string; title: string; decision: Decision }>>([]);
  const onDecided = (requestId: string, title: string) => (decision: Decision) =>
    setAnswered((list) => [{ id: requestId, title, decision }, ...list]);

  let body;
  if (query.isError) body = <QueryError error={query.error} what="approval requests" />;
  else if (query.isPending) body = <Spinner size="large" />;
  else if (items.length === 0) body = <Box textAlign="center" color="inherit" padding="xxl">No approval requests right now.</Box>;
  else {
    body = items.map((request) => {
      const title = titles.get(request.task_id);
      return <ApprovalCard key={request.request_id} request={request} taskTitle={title} onDecided={onDecided(request.request_id, title ?? request.reason)} />;
    });
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          counter={query.data ? `(${items.length})` : undefined}
          description="Agents pause and ask before risky actions. Approve to let them carry on, or say no and they try another way."
        >
          Approval requests
        </Header>
      }
    >
      <SpaceBetween size="l">
        {answered.map((a) => (
          <Alert key={a.id} type="success" dismissible onDismiss={() => setAnswered((list) => list.filter((x) => x.id !== a.id))} header={a.title}>
            {decisionMessage(a.decision)}
          </Alert>
        ))}
        {body}
      </SpaceBetween>
    </ContentLayout>
  );
}
