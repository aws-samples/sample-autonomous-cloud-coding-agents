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

import Badge from '@cloudscape-design/components/badge';
import StatusIndicator, { type StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import type { Severity, TaskStatusType } from '../api/types';

const STATUS_DISPLAY: Readonly<Record<TaskStatusType, { type: StatusIndicatorProps.Type; label: string }>> = {
  PENDING_UPLOADS: { type: 'pending', label: 'Waiting for files' },
  QUEUED: { type: 'pending', label: 'Queued' },
  SUBMITTED: { type: 'in-progress', label: 'Starting' },
  HYDRATING: { type: 'in-progress', label: 'Setting up' },
  RUNNING: { type: 'in-progress', label: 'Working' },
  AWAITING_APPROVAL: { type: 'warning', label: 'Needs your OK' },
  FINALIZING: { type: 'in-progress', label: 'Wrapping up' },
  COMPLETED: { type: 'success', label: 'Done' },
  FAILED: { type: 'error', label: 'Failed' },
  CANCELLED: { type: 'stopped', label: 'Cancelled' },
  TIMED_OUT: { type: 'error', label: 'Ran out of time' },
};

export function StatusBadge({ status }: { status: TaskStatusType }) {
  const { type, label } = STATUS_DISPLAY[status];
  return <StatusIndicator type={type}>{label}</StatusIndicator>;
}

const SEVERITY_COLOR: Readonly<Record<Severity, 'severity-low' | 'severity-medium' | 'severity-high'>> = {
  low: 'severity-low',
  medium: 'severity-medium',
  high: 'severity-high',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge color={SEVERITY_COLOR[severity]}>{severity}</Badge>;
}
