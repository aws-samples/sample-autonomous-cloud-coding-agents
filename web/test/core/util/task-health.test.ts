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

import { describe, expect, it } from 'vitest';
import type { TaskSummary } from '../../../src/core/api/types';
import {
  AGENT_HEARTBEAT_GRACE_SEC,
  AGENT_HEARTBEAT_STALE_SEC,
  attentionReason,
  hasStaleHeartbeat,
} from '../../../src/core/util/task-health';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

function summary(overrides: Partial<TaskSummary>): TaskSummary {
  return {
    task_id: 't1',
    status: 'RUNNING',
    repo: 'acme/app',
    issue_number: null,
    issue_title: null,
    resolved_workflow: null,
    resolved_assets: null,
    pr_number: null,
    cost_usd: null,
    completed_at: null,
    channel_source: 'api',
    task_description: null,
    branch_name: 'b',
    pr_url: null,
    created_at: ago(600),
    updated_at: ago(600),
    agent_heartbeat_at: ago(10),
    ...overrides,
  };
}

describe('hasStaleHeartbeat', () => {
  it('is false for a running task with a recent heartbeat', () => {
    expect(hasStaleHeartbeat(summary({}), NOW)).toBe(false);
  });

  it('is true once the heartbeat is older than the orchestrator stale threshold', () => {
    expect(hasStaleHeartbeat(summary({ agent_heartbeat_at: ago(AGENT_HEARTBEAT_STALE_SEC + 1) }), NOW)).toBe(true);
    expect(hasStaleHeartbeat(summary({ agent_heartbeat_at: ago(AGENT_HEARTBEAT_STALE_SEC - 1) }), NOW)).toBe(false);
  });

  it('allows the grace period before the first heartbeat', () => {
    const limit = AGENT_HEARTBEAT_GRACE_SEC + AGENT_HEARTBEAT_STALE_SEC;
    expect(hasStaleHeartbeat(summary({ agent_heartbeat_at: null, updated_at: ago(limit - 1) }), NOW)).toBe(false);
    expect(hasStaleHeartbeat(summary({ agent_heartbeat_at: null, updated_at: ago(limit + 1) }), NOW)).toBe(true);
  });

  it('only applies to RUNNING tasks', () => {
    expect(hasStaleHeartbeat(summary({ status: 'COMPLETED', agent_heartbeat_at: ago(9999) }), NOW)).toBe(false);
    expect(hasStaleHeartbeat(summary({ status: 'QUEUED', agent_heartbeat_at: null, updated_at: ago(9999) }), NOW)).toBe(false);
  });
});

describe('attentionReason', () => {
  it('flags approvals, stale heartbeats and recent failures', () => {
    expect(attentionReason(summary({ status: 'AWAITING_APPROVAL' }), NOW)).toBe('awaiting_approval');
    expect(attentionReason(summary({ agent_heartbeat_at: ago(3600) }), NOW)).toBe('stale_heartbeat');
    expect(attentionReason(summary({ status: 'FAILED', updated_at: ago(3600) }), NOW)).toBe('failed');
    expect(attentionReason(summary({ status: 'TIMED_OUT', updated_at: ago(3600) }), NOW)).toBe('timed_out');
  });

  it('ignores healthy work, successes, cancellations and old failures', () => {
    expect(attentionReason(summary({}), NOW)).toBeNull();
    expect(attentionReason(summary({ status: 'COMPLETED' }), NOW)).toBeNull();
    expect(attentionReason(summary({ status: 'CANCELLED' }), NOW)).toBeNull();
    expect(attentionReason(summary({ status: 'FAILED', updated_at: ago(25 * 3600) }), NOW)).toBeNull();
  });
});
