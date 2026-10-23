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

/**
 * Synthetic data for mock mode and tests. One task per situation the console
 * must handle (healthy, stale heartbeat, awaiting approval, queued, failed, ...).
 * All timestamps are relative to `now` so the data always looks current.
 */

import type { PendingApprovalSummary, TaskDetail, TaskEvent } from '../core/api/types';

export interface MockData {
  readonly tasks: TaskDetail[];
  readonly events: Record<string, TaskEvent[]>;
  readonly pending: PendingApprovalSummary[];
}

/** 26-character ULID-shaped id ending in a readable suffix. */
function mockId(suffix: string): string {
  return `01JF3KQZ8X${suffix.padStart(16, '0')}`.slice(0, 26);
}

export const MOCK_IDS = {
  running: mockId('RUNNING1'),
  stale: mockId('STALEHB1'),
  awaiting: mockId('APPROVE1'),
  queued: mockId('QUEUED01'),
  hydrating: mockId('HYDRATE1'),
  completed: mockId('DONEPR01'),
  failed: mockId('FAILED01'),
  timedOut: mockId('TIMEOUT1'),
  cancelled: mockId('CANCEL01'),
  completedOld: mockId('DONEOLD1'),
} as const;

function ago(now: Date, seconds: number): string {
  return new Date(now.getTime() - seconds * 1000).toISOString();
}

const MIN = 60;
const HOUR = 3600;

function task(now: Date, overrides: Partial<TaskDetail> & Pick<TaskDetail, 'task_id' | 'status'>): TaskDetail {
  return {
    repo: 'acme/payments-api',
    issue_number: null,
    resolved_workflow: { id: 'coding/new-task-v1', version: '1' },
    resolved_assets: null,
    pr_number: null,
    task_description: null,
    branch_name: `bgagent/${overrides.task_id.slice(-8).toLowerCase()}`,
    session_id: null,
    pr_url: null,
    error_message: null,
    error_classification: null,
    prompt_version: 'v3',
    channel_source: 'api',
    created_at: ago(now, 10 * MIN),
    updated_at: ago(now, 1 * MIN),
    started_at: null,
    completed_at: null,
    agent_heartbeat_at: null,
    duration_s: null,
    cost_usd: null,
    build_passed: null,
    lint_passed: null,
    otel_trace_id: null,
    max_turns: 60,
    max_budget_usd: 5,
    turns_attempted: null,
    turns_completed: null,
    trace: false,
    trace_s3_uri: null,
    artifact_uri: null,
    attachments: null,
    approval_gate_count: 0,
    approval_gate_cap: 50,
    awaiting_approval_request_id: null,
    queued_at: null,
    queue_position: null,
    estimated_wait_s: null,
    ...overrides,
  };
}

function event(taskId: string, index: number, at: string, eventType: string, metadata: Record<string, unknown> = {}): TaskEvent {
  return { event_id: `${taskId}-${String(index).padStart(4, '0')}`, event_type: eventType, timestamp: at, metadata };
}

/** Oldest-first event history; the handlers sort as the API would. */
function lifecycle(now: Date, taskId: string, startedAgoS: number, steps: Array<[number, string, Record<string, unknown>?]>): TaskEvent[] {
  const base: Array<[number, string, Record<string, unknown>?]> = [
    [startedAgoS + 30, 'task_created'],
    [startedAgoS + 20, 'hydration_started'],
    [startedAgoS + 5, 'hydration_complete'],
    [startedAgoS, 'session_started'],
  ];
  return [...base, ...steps].map(([agoS, type, meta], i) => event(taskId, i, ago(now, agoS), type, meta));
}

export function buildFixtures(now: Date = new Date()): MockData {
  const tasks: TaskDetail[] = [
    task(now, {
      task_id: MOCK_IDS.running,
      status: 'RUNNING',
      task_description: 'Fix the flaky retry test in PaymentClient',
      created_at: ago(now, 7 * MIN),
      started_at: ago(now, 6 * MIN),
      updated_at: ago(now, 6 * MIN),
      agent_heartbeat_at: ago(now, 20),
      cost_usd: 0.84,
      turns_completed: 12,
    }),
    task(now, {
      task_id: MOCK_IDS.stale,
      status: 'RUNNING',
      repo: 'acme/web-frontend',
      task_description: 'Upgrade React Router to v7',
      created_at: ago(now, 25 * MIN),
      started_at: ago(now, 24 * MIN),
      updated_at: ago(now, 24 * MIN),
      agent_heartbeat_at: ago(now, 9 * MIN),
      cost_usd: 1.92,
      turns_completed: 31,
    }),
    task(now, {
      task_id: MOCK_IDS.awaiting,
      status: 'AWAITING_APPROVAL',
      repo: 'acme/infra',
      task_description: 'Apply the staging database module after the provider upgrade',
      created_at: ago(now, 15 * MIN),
      started_at: ago(now, 14 * MIN),
      updated_at: ago(now, 2 * MIN),
      agent_heartbeat_at: ago(now, 30),
      cost_usd: 0.57,
      turns_completed: 8,
      approval_gate_count: 1,
      awaiting_approval_request_id: 'req-01JF3KR0APPROVE00000001',
    }),
    task(now, {
      task_id: MOCK_IDS.queued,
      status: 'QUEUED',
      task_description: 'Add pagination to GET /invoices',
      issue_number: 214,
      created_at: ago(now, 2 * MIN),
      updated_at: ago(now, 2 * MIN),
      queued_at: ago(now, 2 * MIN),
      queue_position: 1,
      estimated_wait_s: 240,
    }),
    task(now, {
      task_id: MOCK_IDS.hydrating,
      status: 'HYDRATING',
      repo: 'acme/docs',
      task_description: 'Document webhook retry behaviour',
      channel_source: 'slack',
      created_at: ago(now, 1 * MIN),
      updated_at: ago(now, 30),
    }),
    task(now, {
      task_id: MOCK_IDS.completed,
      status: 'COMPLETED',
      repo: 'acme/web-frontend',
      task_description: 'Fix dark-mode contrast on the settings page',
      channel_source: 'linear',
      pr_number: 482,
      pr_url: 'https://github.com/acme/web-frontend/pull/482',
      created_at: ago(now, 2 * HOUR + 25 * MIN),
      started_at: ago(now, 2 * HOUR + 24 * MIN),
      completed_at: ago(now, 2 * HOUR + 3 * MIN),
      updated_at: ago(now, 2 * HOUR + 3 * MIN),
      agent_heartbeat_at: ago(now, 2 * HOUR + 4 * MIN),
      duration_s: 1260,
      cost_usd: 2.31,
      build_passed: true,
      lint_passed: true,
      turns_completed: 27,
    }),
    task(now, {
      task_id: MOCK_IDS.failed,
      status: 'FAILED',
      task_description: 'Migrate the ledger service to Java 21',
      created_at: ago(now, 4 * HOUR),
      started_at: ago(now, 4 * HOUR - 60),
      completed_at: ago(now, 3 * HOUR),
      updated_at: ago(now, 3 * HOUR),
      agent_heartbeat_at: ago(now, 3 * HOUR + 30),
      duration_s: 3540,
      cost_usd: 5,
      build_passed: false,
      lint_passed: true,
      turns_completed: 58,
      error_message: 'Task exceeded max_budget_usd (5.00)',
      error_classification: {
        category: 'guardrail',
        title: 'Budget exceeded',
        description: 'The task reached its maximum budget of $5.00 before finishing.',
        remedy: 'Raise the per-repository or per-task budget, or split the work into smaller tasks.',
        retryable: true,
        errorClass: 'user',
      },
    }),
    task(now, {
      task_id: MOCK_IDS.timedOut,
      status: 'TIMED_OUT',
      repo: 'acme/infra',
      task_description: 'Refactor the Terraform network modules',
      created_at: ago(now, 30 * HOUR),
      updated_at: ago(now, 26 * HOUR),
      completed_at: ago(now, 26 * HOUR),
      duration_s: 14400,
      cost_usd: 3.4,
    }),
    task(now, {
      task_id: MOCK_IDS.cancelled,
      status: 'CANCELLED',
      repo: 'acme/docs',
      task_description: 'Rewrite the onboarding guide',
      created_at: ago(now, 28 * HOUR),
      updated_at: ago(now, 27 * HOUR),
      completed_at: ago(now, 27 * HOUR),
    }),
    task(now, {
      task_id: MOCK_IDS.completedOld,
      status: 'COMPLETED',
      task_description: 'Bump the AWS SDK to the latest minor version',
      pr_number: 1093,
      pr_url: 'https://github.com/acme/payments-api/pull/1093',
      created_at: ago(now, 72 * HOUR),
      started_at: ago(now, 72 * HOUR - 60),
      completed_at: ago(now, 71 * HOUR),
      updated_at: ago(now, 71 * HOUR),
      duration_s: 2400,
      cost_usd: 1.12,
      build_passed: true,
      lint_passed: true,
    }),
  ];

  const events: Record<string, TaskEvent[]> = {
    [MOCK_IDS.running]: lifecycle(now, MOCK_IDS.running, 6 * MIN, [
      [5 * MIN, 'agent_milestone', { milestone: 'repo_cloned' }],
      [4 * MIN, 'agent_turn', { turn: 4 }],
      [3 * MIN, 'agent_tool_call', { tool_name: 'Bash' }],
      [2 * MIN, 'agent_milestone', { milestone: 'reproduced_failure' }],
      [90, 'agent_tool_call', { tool_name: 'Edit' }],
      [60, 'agent_cost_update', { cost_usd: 0.84 }],
      [20, 'agent_turn', { turn: 12 }],
    ]),
    [MOCK_IDS.stale]: lifecycle(now, MOCK_IDS.stale, 24 * MIN, [
      [20 * MIN, 'agent_milestone', { milestone: 'repo_cloned' }],
      [12 * MIN, 'agent_tool_call', { tool_name: 'Bash' }],
      [9 * MIN, 'agent_turn', { turn: 31 }],
    ]),
    [MOCK_IDS.awaiting]: lifecycle(now, MOCK_IDS.awaiting, 14 * MIN, [
      [10 * MIN, 'agent_milestone', { milestone: 'plan_ready' }],
      [2 * MIN, 'approval_requested', { request_id: 'req-01JF3KR0APPROVE00000001', reason: 'Infrastructure changes require approval' }],
    ]),
    [MOCK_IDS.completed]: lifecycle(now, MOCK_IDS.completed, 2 * HOUR + 24 * MIN, [
      [2 * HOUR + 20 * MIN, 'agent_milestone', { milestone: 'repo_cloned' }],
      [2 * HOUR + 10 * MIN, 'agent_milestone', { milestone: 'tests_passing' }],
      [2 * HOUR + 5 * MIN, 'pr_url', { pr_url: 'https://github.com/acme/web-frontend/pull/482' }],
      [2 * HOUR + 3 * MIN, 'task_completed'],
    ]),
    [MOCK_IDS.failed]: lifecycle(now, MOCK_IDS.failed, 4 * HOUR - 60, [
      [3 * HOUR + 50 * MIN, 'agent_milestone', { milestone: 'repo_cloned' }],
      [3 * HOUR + 10 * MIN, 'agent_blocked', { kind: 'build_failure', resource: 'ledger-core', remediation_hint: 'Lombok 1.18.20 does not support Java 21' }],
      [3 * HOUR, 'task_failed', { reason: 'Task exceeded max_budget_usd (5.00)' }],
    ]),
  };

  const pending: PendingApprovalSummary[] = [
    {
      task_id: MOCK_IDS.awaiting,
      request_id: 'req-01JF3KR0APPROVE00000001',
      tool_name: 'Bash',
      tool_input_preview: 'terraform apply -target=module.staging_database',
      severity: 'high',
      reason: 'Infrastructure changes require approval',
      created_at: ago(now, 2 * MIN),
      timeout_s: 300,
      expires_at: ago(now, -3 * MIN),
      matching_rule_ids: ['soft:terraform-apply'],
    },
  ];

  return { tasks, events, pending };
}
