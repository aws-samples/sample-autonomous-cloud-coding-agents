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
 * Mock `DataSource` — reads synchronously from `./mock/data.ts`
 * fixtures and resolves Promises immediately. Used by default so
 * `npm run tui` keeps working without a deployed backend.
 */

import type { ApprovalScope, TaskEvent } from '../../types.js';
import type {
  PendingApprovalView,
  PolicyRuleView,
  RegisteredRepoView,
  TaskRowView,
} from '../data.js';
import type { DataSource, SubmitTaskInput } from './source.js';
import {
  MOCK_EVENTS,
  MOCK_PENDING_APPROVALS,
  MOCK_POLICIES_HARD,
  MOCK_POLICIES_SOFT,
  MOCK_REPOS,
  MOCK_TASKS,
  submitMockTask,
  type CedarPolicyFixture,
  type PendingApprovalFixture,
  type RegisteredRepoFixture,
  type TaskFixture,
} from '../mock/data.js';

function normalizeSeverity(s: string | undefined): 'HIGH' | 'MEDIUM' | 'LOW' {
  const upper = String(s ?? 'MEDIUM').toUpperCase();
  if (upper === 'HIGH' || upper === 'MEDIUM' || upper === 'LOW') return upper;
  return 'MEDIUM';
}

function toTaskRowView(t: TaskFixture): TaskRowView {
  return {
    task_id: t.task_id,
    status: t.status,
    repo: t.repo,
    issue_number: t.issue_number,
    task_type: t.task_type,
    pr_number: t.pr_number,
    task_description: t.task_description ?? '',
    branch_name: t.branch_name,
    pr_url: t.pr_url,
    // Pass through the fixture's channel_source (varied across mock
    // tasks so the SOURCE column demo shows all four values).
    // Default to 'api' for pre-ChannelSource fixtures.
    channel_source: t.channel_source ?? 'api',
    created_at: t.created_at,
    updated_at: t.updated_at,
    cost_usd: t.cost_usd,
    duration_s: t.duration_s,
    max_turns: t.max_turns,
    turns_attempted: t.turns_attempted,
    turns_completed: t.turns_completed,
    turn: t.turns_completed ?? t.turns_attempted ?? null,
    approval_gate_count: t.approval_gate_count,
    approval_gate_cap: t.approval_gate_cap,
    awaiting_approval_request_id: t.awaiting_approval_request_id,
  };
}

function toPendingApprovalView(p: PendingApprovalFixture): PendingApprovalView {
  return {
    task_id: p.task_id,
    request_id: p.request_id,
    tool_name: p.tool_name,
    tool_input_preview: p.tool_input_preview,
    severity: normalizeSeverity(p.severity),
    reason: p.reason,
    created_at: p.created_at,
    timeout_s: p.timeout_s,
    expires_at: p.expires_at,
    matching_rule_ids: p.matching_rule_ids,
    repo: p.repo,
    task_description: p.task_description,
  };
}

function toPolicyRuleView(r: CedarPolicyFixture): PolicyRuleView {
  return {
    rule_id: r.rule_id,
    tier: r.tier,
    summary: r.summary,
    severity: r.severity,
    category: r.category,
    approval_timeout_s: r.approval_timeout_s,
    action: r.action,
    condition_summary: r.condition_summary,
    cedar_source: r.cedar_source,
  };
}

function toRegisteredRepoView(r: RegisteredRepoFixture): RegisteredRepoView {
  return { repo: r.repo, default_branch: r.default_branch };
}

export class MockDataSource implements DataSource {
  readonly label = 'mock' as const;

  async listTasks(): Promise<TaskRowView[]> {
    return MOCK_TASKS.map(toTaskRowView);
  }

  async getTaskEvents(taskId: string, opts?: { after?: string }): Promise<TaskEvent[]> {
    const all = MOCK_EVENTS.filter(e => e.metadata.task_id === taskId);
    if (opts?.after) {
      // event_ids in the mock fixture are lexicographic ULIDs; simple
      // string compare matches the real server's ordering.
      return all.filter(e => e.event_id > opts.after!);
    }
    return all;
  }

  async listPending(): Promise<PendingApprovalView[]> {
    return MOCK_PENDING_APPROVALS.map(toPendingApprovalView);
  }

  async listPolicies(_repoId: string): Promise<{
    hard: PolicyRuleView[];
    soft: PolicyRuleView[];
  }> {
    // Mock returns the same policy set regardless of repo — real API
    // returns repo-specific bundles.
    void _repoId;
    return {
      hard: MOCK_POLICIES_HARD.map(toPolicyRuleView),
      soft: MOCK_POLICIES_SOFT.map(toPolicyRuleView),
    };
  }

  async listRegisteredRepos(): Promise<RegisteredRepoView[]> {
    return MOCK_REPOS.filter(r => r.status === 'active').map(toRegisteredRepoView);
  }

  async submitTask(input: SubmitTaskInput): Promise<TaskRowView> {
    return toTaskRowView(
      submitMockTask(input.repo, input.task_description, {
        approval_timeout_s: input.approval_timeout_s,
        initial_approvals: input.initial_approvals,
      }),
    );
  }

  async approve(_taskId: string, _requestId: string, _scope?: ApprovalScope): Promise<void> {
    void _taskId; void _requestId; void _scope;
    // Mock: the TuiProvider clears the approval from in-memory state
    // in its `approve`/`deny` callbacks. This method exists to satisfy
    // the interface contract for the real source.
  }

  async deny(_taskId: string, _requestId: string, _reason?: string): Promise<void> {
    void _taskId; void _requestId; void _reason;
  }
}
