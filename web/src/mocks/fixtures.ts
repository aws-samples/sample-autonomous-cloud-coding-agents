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

import type { LinearIssueSummary, PendingApprovalSummary, PersonalBudgetStatus, RepoIssueSummary, TaskDetail, TaskEvent } from '../core/api/types';

/** A change the mock backend applies once its time comes: how mock tasks "progress". */
export interface ScheduledChange {
  readonly taskId: string;
  readonly dueMs: number;
  readonly eventType?: string;
  readonly metadata?: Record<string, unknown>;
  readonly patch?: Partial<TaskDetail>;
}

export interface MockData {
  tasks: TaskDetail[];
  events: Record<string, TaskEvent[]>;
  pending: PendingApprovalSummary[];
  scheduled: ScheduledChange[];
  /** Idempotency-Key → task id, so a repeated submit returns the first task. */
  idempotency: Record<string, string>;
  /** Open GitHub issues per repository, for the issue picker. */
  issues: Record<string, RepoIssueSummary[]>;
  /** The signed-in user's monthly budget (GET /tasks?view=budget). */
  budget: PersonalBudgetStatus;
  /** Linear projects mapped to each repository, with their open issues. */
  linear: Record<string, MockLinearProject[]>;
}

/** A Linear issue in mock mode; the agent state is derived from its labels and task. */
export type MockLinearIssue = Omit<LinearIssueSummary, 'agent' | 'labels'> & {
  labels: string[];
  /** Set when Start was clicked; the mock "webhook" creates the task a few seconds later. */
  started_at_ms?: number;
  task_id?: string;
};

export interface MockLinearProject {
  readonly project_id: string;
  readonly repo: string;
  readonly trigger_label: string;
  readonly issues: MockLinearIssue[];
}

export interface FixtureOptions {
  /**
   * Add a month of finished tasks with costs, so the Costs page has something to show
   * in mock mode. Off for tests, which count the core fixture set.
   */
  readonly history?: boolean;
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
  noChanges: mockId('NOCHANGE'),
} as const;

function ago(now: Date, seconds: number): string {
  return new Date(now.getTime() - seconds * 1000).toISOString();
}

const MIN = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;

function task(now: Date, overrides: Partial<TaskDetail> & Pick<TaskDetail, 'task_id' | 'status'>): TaskDetail {
  return {
    repo: 'acme/payments-api',
    issue_number: null,
    issue_title: null,
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

/** Metadata for an `agent_tool_call`, with the preview in the agent's truncated dict-repr format. */
function tool(name: string, preview: string): Record<string, unknown> {
  return { tool_name: name, tool_input_preview: preview, turn: 1 };
}

/** Metadata for an `agent_tool_result`: the first part of what the tool printed. */
function result(name: string, output: string, isError = false): Record<string, unknown> {
  return { tool_name: name, content_preview: output, is_error: isError, turn: 1 };
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

export function buildFixtures(now: Date = new Date(), { history = false }: FixtureOptions = {}): MockData {
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
      task_description: 'Use cursor pagination, 50 per page',
      issue_number: 214,
      issue_title: 'Add pagination to GET /invoices',
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
      task_id: MOCK_IDS.noChanges,
      status: 'FAILED',
      repo: 'acme/web-frontend',
      task_description: 'Add a CODEOWNERS file to the repository root',
      created_at: ago(now, 50 * MIN),
      started_at: ago(now, 50 * MIN - 8),
      completed_at: ago(now, 49 * MIN),
      updated_at: ago(now, 49 * MIN),
      duration_s: 69,
      cost_usd: 0.11,
      error_message: 'The agent finished, but none of its changes were committed to the branch and no pull request was opened.',
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
    [MOCK_IDS.noChanges]: lifecycle(now, MOCK_IDS.noChanges, 50 * MIN - 8, [
      [50 * MIN - 20, 'agent_milestone', { milestone: 'repo_setup_complete', details: 'branch=bgagent/nochange/add-a-codeowners-file build_before=True' }],
      [50 * MIN - 21, 'agent_milestone', { milestone: 'step:implement:start' }],
      [50 * MIN - 28, 'agent_tool_call', tool('Bash', "{'command': 'ls -a && find . -name CODEOWNERS', 'description': 'Check whether a CODEOWNERS file already exists'}")],
      [50 * MIN - 30, 'agent_turn', { turn: 2, text_preview: 'A CODEOWNERS file already exists at the root.' }],
      [50 * MIN - 38, 'agent_turn', { turn: 5, text_preview: "I didn't change anything or open a PR, because the repository root already has a CODEOWNERS file. It was added in PR #5." }],
      [50 * MIN - 39, 'agent_milestone', { milestone: 'agent_execution_complete', details: 'status=success turns=5' }],
      [49 * MIN, 'task_failed', { final_status: 'FAILED' }],
    ]),
    [MOCK_IDS.running]: lifecycle(now, MOCK_IDS.running, 6 * MIN, [
      [5 * MIN + 50, 'agent_milestone', { milestone: 'repo_setup_complete', details: 'branch=bgagent/running1/fix-flaky-retry-test build_before=True' }],
      [5 * MIN + 45, 'agent_milestone', { milestone: 'step:implement:start' }],
      [5 * MIN + 2, 'agent_turn', { turn: 1, text_preview: '', tool_calls_count: 0 }],
      [5 * MIN + 1, 'agent_turn', { turn: 2, text_preview: '', tool_calls_count: 1 }],
      [5 * MIN, 'agent_tool_call', tool('Bash', "{'command': 'npm test -- PaymentClient --runInBand', 'description': 'Run the PaymentClient tests to see the failure'}")],
      [4 * MIN + 50, 'agent_tool_result', result('Bash', 'FAIL src/client/payment-client.test.ts\n  ● retries a failed charge\n    Timeout - Async callback was not invoked within 5000 ms\n\nTests: 1 failed, 11 passed, 12 total', true)],
      [4 * MIN, 'agent_turn', { turn: 3, text_preview: 'The retry test waits on a real timer, so it fails when the machine is slow. I will switch it to fake timers.', tool_calls_count: 0 }],
      [3 * MIN + 1, 'agent_turn', { turn: 4, text_preview: '', tool_calls_count: 1 }],
      [3 * MIN, 'agent_tool_call', tool('Read', "{'file_path': '/workspace/acme/payments-api/src/client/payment-client.test.ts'}")],
      [3 * MIN - 1, 'agent_tool_result', result('Read', "import { PaymentClient } from './payment-client';\n\ndescribe('PaymentClient', () => {\n  it('retries a failed charge', async () => {\n    await sleep(100);")],
      [91, 'agent_turn', { turn: 5, text_preview: '', tool_calls_count: 1 }],
      [90, 'agent_tool_call', tool('Edit', "{'file_path': '/workspace/acme/payments-api/src/client/payment-client.test.ts', 'old_string': 'await sleep(100)', 'new_string': 'await jest.advanceTimersByTimeAsync(100)'}")],
      [89, 'agent_tool_result', result('Edit', 'The file /workspace/acme/payments-api/src/client/payment-client.test.ts has been updated.')],
      [60, 'agent_cost_update', { cost_usd: 0.84 }],
      [41, 'agent_turn', { turn: 6, text_preview: '', tool_calls_count: 1 }],
      [40, 'agent_tool_call', tool('Bash', "{'command': 'cat > scripts/stress-test.sh <<\\'EOF\\'\\n#!/usr/bin/env bash\\nset -euo pipefail\\nfor i in $(seq 1 20); do\\n  npm test -- PaymentClient --runInBand --silent || { echo \"failed on run $i\"; exit 1; }\\ndone\\nEOF\\nchmod +x scripts/stress...")],
      [39, 'agent_tool_result', result('Bash', '')],
      [21, 'agent_turn', { turn: 7, text_preview: '', tool_calls_count: 1 }],
      [20, 'agent_tool_call', tool('Bash', "{'command': 'for i in 1 2 3 4 5; do npm test -- PaymentClient || exit 1; done', 'description': 'Run the test five times to make sure it is stable'}")],
    ]),
    [MOCK_IDS.stale]: lifecycle(now, MOCK_IDS.stale, 24 * MIN, [
      [20 * MIN, 'agent_milestone', { milestone: 'repo_cloned' }],
      [12 * MIN, 'agent_tool_call', { tool_name: 'Bash' }],
      [9 * MIN, 'agent_turn', { turn: 31 }],
    ]),
    [MOCK_IDS.awaiting]: lifecycle(now, MOCK_IDS.awaiting, 14 * MIN, [
      [13 * MIN, 'agent_milestone', { milestone: 'step:implement:start' }],
      [10 * MIN, 'agent_tool_call', tool('Bash', "{'command': 'terraform plan -target=module.staging_database', 'description': 'Preview the staging database change'}")],
      [9 * MIN, 'agent_turn', { turn: 6, text_preview: 'The plan only changes the staging database. Next I need to apply it.' }],
      [2 * MIN, 'approval_requested', { request_id: 'req-01JF3KR0APPROVE00000001', reason: 'Infrastructure changes require approval' }],
    ]),
    [MOCK_IDS.completed]: lifecycle(now, MOCK_IDS.completed, 2 * HOUR + 24 * MIN, [
      [2 * HOUR + 20 * MIN, 'agent_milestone', { milestone: 'repo_setup_complete', details: 'branch=bgagent/donepr01/fix-dark-mode-contrast' }],
      [2 * HOUR + 19 * MIN, 'agent_milestone', { milestone: 'step:implement:start' }],
      [2 * HOUR + 15 * MIN, 'agent_tool_call', tool('Edit', "{'file_path': '/workspace/acme/web-frontend/src/settings/theme.css'}")],
      [2 * HOUR + 10 * MIN, 'agent_milestone', { milestone: 'step:build:start' }],
      [2 * HOUR + 8 * MIN, 'agent_milestone', { milestone: 'step:build:succeeded' }],
      [2 * HOUR + 6 * MIN, 'agent_milestone', { milestone: 'step:open_pr:start' }],
      [2 * HOUR + 5 * MIN, 'agent_milestone', { milestone: 'pr_created' }],
      [2 * HOUR + 5 * MIN, 'pr_url', { pr_url: 'https://github.com/acme/web-frontend/pull/482' }],
      [2 * HOUR + 3 * MIN, 'task_completed'],
    ]),
    [MOCK_IDS.failed]: lifecycle(now, MOCK_IDS.failed, 4 * HOUR - 60, [
      [3 * HOUR + 50 * MIN, 'agent_milestone', { milestone: 'repo_setup_complete', details: 'branch=bgagent/failed01/java-21' }],
      [3 * HOUR + 49 * MIN, 'agent_milestone', { milestone: 'step:implement:start' }],
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

  const issue = (repo: string, number: number, title: string, labels: string[], updatedAgoS: number): RepoIssueSummary =>
    ({ number, title, labels, url: `https://github.com/${repo}/issues/${number}`, updated_at: ago(now, updatedAgoS) });
  const issues: Record<string, RepoIssueSummary[]> = {
    'acme/web-frontend': [
      issue('acme/web-frontend', 31, 'Settings page loses unsaved changes on back navigation', ['bug'], 2 * HOUR),
      issue('acme/web-frontend', 27, 'Add keyboard shortcuts to the task list', ['enhancement'], 26 * HOUR),
    ],
    'acme/payments-api': [
      issue('acme/payments-api', 214, 'Add pagination to GET /invoices', ['enhancement'], 3 * HOUR),
      issue('acme/payments-api', 198, 'Refund webhook retries forever on 410', ['bug', 'p1'], 30 * HOUR),
    ],
  };

  if (history) tasks.push(...costHistory(now));

  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const spend = tasks
    .filter((t) => t.completed_at && Date.parse(t.completed_at) >= monthStart)
    .reduce((sum, t) => sum + (t.cost_usd ?? 0), 0);
  const budget: PersonalBudgetStatus = {
    period: new Date(monthStart).toISOString().slice(0, 7),
    resets_at: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    configured: true,
    spend_usd: Number(spend.toFixed(2)),
    monthly_limit_usd: 100,
    remaining_usd: Number(Math.max(0, 100 - spend).toFixed(2)),
    utilization_percent: Number(Math.min(100, spend).toFixed(1)),
    hard_stop: false,
    hard_stop_active: false,
  };

  const linearIssue = (n: number, title: string, state: string, priority: string, updatedAgoS: number, labels: string[] = []): MockLinearIssue => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    identifier: `WEB-${n}`,
    title,
    url: `https://linear.app/acme/issue/WEB-${n}`,
    state,
    state_type: state === 'In Progress' ? 'started' : 'unstarted',
    priority_label: priority,
    labels,
    assignee: null,
    updated_at: ago(now, updatedAgoS),
  });
  const linear: Record<string, MockLinearProject[]> = {
    'acme/web-frontend': [{
      project_id: '11111111-2222-4333-8444-5555aaaa5555',
      repo: 'acme/web-frontend',
      trigger_label: 'bgagent',
      issues: [
        linearIssue(12, 'Add a loading skeleton to the dashboard', 'Todo', 'High', 3 * HOUR, ['enhancement']),
        linearIssue(11, 'Date picker ignores the user\'s locale', 'Todo', 'Medium', 6 * HOUR, ['bug']),
        linearIssue(9, 'Keyboard shortcut for search', 'Backlog', 'Low', 2 * DAY),
        { ...linearIssue(8, 'Fix dark-mode contrast on the settings page', 'In Progress', 'High', 2 * HOUR, ['bgagent']), task_id: MOCK_IDS.completed },
      ],
    }],
  };

  return { tasks, events, pending, scheduled: [], idempotency: {}, issues, budget, linear };
}

/** Deterministic pseudo-random tasks spread over the last 30 days. */
function costHistory(now: Date): TaskDetail[] {
  const repos = ['acme/payments-api', 'acme/web-frontend', 'acme/infra', 'acme/docs', 'acme/mobile-app', 'acme/data-pipeline'];
  const sources = ['api', 'api', 'api', 'linear', 'jira', 'slack'] as const;
  const titles = ['Fix flaky test', 'Bump dependencies', 'Add input validation', 'Improve error messages', 'Refactor config loading', 'Add pagination'];
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const out: TaskDetail[] = [];
  for (let i = 0; i < 48; i += 1) {
    const daysAgo = Math.floor(rand() * 30);
    const finishedAgo = daysAgo * DAY + Math.floor(rand() * 20) * HOUR + HOUR;
    const status = rand() < 0.8 ? 'COMPLETED' : rand() < 0.6 ? 'FAILED' : 'CANCELLED';
    const repo = repos[Math.floor(rand() * rand() * repos.length)];
    out.push(task(now, {
      task_id: mockId(`HIST${String(i).padStart(4, '0')}`),
      status,
      repo,
      task_description: `${titles[i % titles.length]} (${repo.split('/')[1]})`,
      channel_source: sources[Math.floor(rand() * sources.length)],
      created_at: ago(now, finishedAgo + 20 * MIN),
      started_at: ago(now, finishedAgo + 19 * MIN),
      completed_at: ago(now, finishedAgo),
      updated_at: ago(now, finishedAgo),
      duration_s: 1140,
      cost_usd: Number((0.2 + rand() * rand() * 4).toFixed(2)),
      ...(status === 'COMPLETED' ? { pr_number: 500 + i, pr_url: `https://github.com/${repo}/pull/${500 + i}` } : {}),
    }));
  }
  return out;
}
