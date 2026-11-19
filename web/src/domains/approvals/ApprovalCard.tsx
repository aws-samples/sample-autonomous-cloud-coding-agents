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
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import { useState } from 'react';
import type { PendingApprovalSummary, Severity } from '../../core/api/types';
import { RouterLink } from '../../core/components/RouterLink';
import { SeverityBadge } from '../../core/components/StatusBadge';
import { formatRelativeTime, taskHref } from '../../core/util/format';
import { useDecide, type Decision } from './hooks';

const RISK_LABEL: Readonly<Record<Severity, string>> = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' };

/** One request for a person's OK: what the agent wants to do, why it asked, and the two buttons. */
export function ApprovalCard({ request, taskTitle, onDecided }: {
  request: PendingApprovalSummary;
  taskTitle?: string;
  /** Called once the API accepted the answer; the request then leaves the pending list. */
  onDecided?: (decision: Decision) => void;
}) {
  const decide = useDecide(request.task_id, request.request_id, onDecided);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const answer = (decision: Decision) => decide.mutate(decision);

  return (
    <Container
      header={
        <Header
          variant="h3"
          actions={<SeverityBadge severity={request.severity} />}
          description={taskTitle ? <RouterLink href={taskHref(request.task_id)}>{taskTitle}</RouterLink> : undefined}
        >
          {request.reason || 'The agent wants to do something that needs approval'}
        </Header>
      }
    >
      <SpaceBetween size="m">
        <div>
          <Box variant="awsui-key-label">What it wants to do</Box>
          <Box variant="code" display="block">{request.tool_input_preview || request.tool_name}</Box>
        </div>
        <KeyValuePairs
          columns={3}
          items={[
            { label: 'Risk', value: RISK_LABEL[request.severity] },
            { label: 'Asked', value: formatRelativeTime(request.created_at) },
            { label: 'Expires', value: formatRelativeTime(request.expires_at) },
          ]}
        />
        {decide.isError && (
          <Alert type="error">{decide.error instanceof Error ? decide.error.message : 'Your answer was not saved.'}</Alert>
        )}
        {denying ? (
          <SpaceBetween size="s">
            <FormField label="Why not? (optional)" description="The agent sees this and tries another way.">
              <Textarea value={reason} rows={2} onChange={({ detail }) => setReason(detail.value)} />
            </FormField>
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setDenying(false)}>Back</Button>
              <Button onClick={() => answer({ kind: 'deny', reason: reason.trim() || undefined })} loading={decide.isPending}>
                Say no
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        ) : (
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="primary" onClick={() => answer({ kind: 'approve' })} loading={decide.isPending}>Approve</Button>
            <Button onClick={() => setDenying(true)} disabled={decide.isPending}>Say no</Button>
          </SpaceBetween>
        )}
      </SpaceBetween>
    </Container>
  );
}

/** What a person sees right after answering, once the request has left the pending list. */
export function decisionMessage(decision: Decision): string {
  return decision.kind === 'approve' ? 'Approved. The agent carries on.' : 'Declined. The agent skips this action and tries another way.';
}
