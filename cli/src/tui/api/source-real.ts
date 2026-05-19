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
 * Real `DataSource` — wraps `ApiClient` from the rest of the CLI.
 *
 * Hydration strategy:
 *
 *  - `listTasks()` hits `GET /v1/tasks`, then enriches each row with
 *    the fields the TUI needs from `TaskDetail` (cost, turn counters,
 *    approval-gate counters). This requires one `getTask` per row —
 *    acceptable at TUI list sizes (typically < 50 tasks) and keeps
 *    us using the public contract without plumbing a specialized
 *    list endpoint.
 *
 *  - `listPending()` hits `GET /v1/pending`, then joins against the
 *    already-cached task list to add `repo` + `task_description` so
 *    the Approvals panel can render without an extra round-trip per
 *    approval.
 *
 *  - `listPolicies(repoId)` hits `GET /v1/repos/{id}/policies`.
 *    Severity is server-lowercase and PolicyRuleView keeps it that
 *    way; rendering uppercases on display.
 *
 *  - `listRegisteredRepos()` — there is no public list-repos endpoint
 *    yet. We derive the set of "known repos" from the user's own task
 *    list (dedup by repo string). This is adequate for the Submit
 *    panel's picker; if we later ship a `/v1/repos` endpoint, plug
 *    it here.
 */

import { ApiClient } from '../../api-client.js';
import type {
  ApprovalScope,
  TaskDetail,
  TaskEvent,
  TaskSummary,
} from '../../types.js';
import type {
  PendingApprovalView,
  PolicyRuleView,
  RegisteredRepoView,
  TaskRowView,
} from '../data.js';
import type { DataSource, SubmitTaskInput } from './source.js';
import { enrichPendingApproval } from './source.js';

function toTaskRowView(t: TaskDetail): TaskRowView {
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
    channel_source: t.channel_source,
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

/** Build a light row view from a TaskSummary alone, before the
 *  full TaskDetail has been hydrated. Fields `TaskSummary` does not
 *  carry default to null so the UI can flag "loading". */
function toTaskRowFromSummary(s: TaskSummary): TaskRowView {
  return {
    task_id: s.task_id,
    status: s.status,
    repo: s.repo,
    issue_number: s.issue_number,
    task_type: s.task_type,
    pr_number: s.pr_number,
    task_description: s.task_description ?? '',
    branch_name: s.branch_name,
    pr_url: s.pr_url,
    // TaskSummary does not carry channel_source. Leave undefined so
    // the row renders a "—" until the detail hydration populates it.
    channel_source: undefined,
    created_at: s.created_at,
    updated_at: s.updated_at,
    cost_usd: null,
    duration_s: null,
    max_turns: null,
    turns_attempted: null,
    turns_completed: null,
    turn: null,
    approval_gate_count: null,
    approval_gate_cap: null,
    awaiting_approval_request_id: null,
  };
}

export class RealDataSource implements DataSource {
  readonly label = 'live' as const;
  private readonly client: ApiClient;
  /** Cached task rows from the most recent `listTasks`, used to hydrate
   *  `listPending` joins without a second round-trip per approval. */
  private lastTasks: TaskRowView[] = [];

  constructor(client?: ApiClient) {
    this.client = client ?? new ApiClient();
  }

  async listTasks(): Promise<TaskRowView[]> {
    // Drain the first page (keeps this interactive — infinite
    // pagination is a Phase 4 follow-up). The `ApiClient.listTasks`
    // takes `limit` but the server default + 50 is a reasonable
    // upper bound for interactive review.
    const page = await this.client.listTasks({ limit: 50 });
    // Hydrate each summary into a full detail so the TUI has the
    // approval-gate counters and turn counters. In practice the user
    // is watching a handful of active tasks; this keeps the contract
    // simple without a specialized endpoint.
    const detailed = await Promise.all(
      page.data.map(async (s) => {
        try {
          const detail = await this.client.getTask(s.task_id);
          return toTaskRowView(detail);
        } catch {
          // Partial failure — fall back to the summary-only view
          // rather than blanking out the whole list on a single
          // getTask error.
          return toTaskRowFromSummary(s);
        }
      }),
    );
    this.lastTasks = detailed;
    return detailed;
  }

  async getTaskEvents(taskId: string, opts?: { after?: string }): Promise<TaskEvent[]> {
    // Cursor provided → incremental catch-up (mirrors bgagent watch).
    // Drains all pages past the cursor so the TUI sees everything the
    // agent emitted since the last poll — critical for long-running
    // tasks where the tail (pr_created / task_completed) can be far
    // past the first 100 events.
    if (opts?.after) {
      return this.client.catchUpEvents(taskId, opts.after, 100);
    }
    // No cursor → initial load. Page through the whole stream so the
    // user opening Watch on an existing task sees the full history,
    // not just the first 100 events.
    const collected: TaskEvent[] = [];
    let page = await this.client.getTaskEvents(taskId, { limit: 100 });
    collected.push(...page.data);
    while (page.pagination.has_more && page.pagination.next_token) {
      page = await this.client.getTaskEvents(taskId, {
        nextToken: page.pagination.next_token,
        limit: 100,
      });
      collected.push(...page.data);
    }
    return collected;
  }

  async listPending(): Promise<PendingApprovalView[]> {
    const { pending } = await this.client.listPending();
    // Build the repo+description maps from the cached task list.
    // If a pending approval references a task we haven't loaded yet
    // (rare — requires a race), `enrichPendingApproval` falls back to
    // "(unknown)" so the list still renders.
    const repoByTaskId = new Map<string, string>();
    const descByTaskId = new Map<string, string | null>();
    for (const t of this.lastTasks) {
      repoByTaskId.set(t.task_id, t.repo);
      descByTaskId.set(t.task_id, t.task_description);
    }
    return pending.map((p) => enrichPendingApproval(p, repoByTaskId, descByTaskId));
  }

  async listPolicies(repoId: string): Promise<{
    hard: PolicyRuleView[];
    soft: PolicyRuleView[];
  }> {
    if (!repoId) {
      return { hard: [], soft: [] };
    }
    const resp = await this.client.listPolicies(repoId);
    const toView = (r: typeof resp.policies.hard[number], tier: 'hard' | 'soft'): PolicyRuleView => ({
      rule_id: r.rule_id,
      tier,
      summary: r.summary,
      severity: r.severity,
      category: r.category,
      approval_timeout_s: r.approval_timeout_s,
      // action / condition_summary / cedar_source are mock-only.
    });
    return {
      hard: resp.policies.hard.map((r) => toView(r, 'hard')),
      soft: resp.policies.soft.map((r) => toView(r, 'soft')),
    };
  }

  async listRegisteredRepos(): Promise<RegisteredRepoView[]> {
    // No dedicated list-repos endpoint. Derive from the cached task
    // list, deduping by repo string. Empty list until `listTasks`
    // has run at least once — the DataProvider always runs both.
    const seen = new Set<string>();
    const repos: RegisteredRepoView[] = [];
    for (const t of this.lastTasks) {
      if (!seen.has(t.repo)) {
        seen.add(t.repo);
        // `default_branch` is not on TaskDetail; we don't have it,
        // so show an honest placeholder. The Submit panel's picker
        // just needs the owner/repo string.
        repos.push({ repo: t.repo, default_branch: '(unknown)' });
      }
    }
    return repos;
  }

  async submitTask(input: SubmitTaskInput): Promise<TaskRowView> {
    const detail = await this.client.createTask({
      repo: input.repo,
      ...(input.task_description && { task_description: input.task_description }),
      ...(input.issue_number !== undefined && { issue_number: input.issue_number }),
      ...(input.pr_number !== undefined && { pr_number: input.pr_number }),
      ...(input.task_type && { task_type: input.task_type }),
      ...(input.max_turns !== undefined && { max_turns: input.max_turns }),
      ...(input.max_budget_usd !== undefined && { max_budget_usd: input.max_budget_usd }),
      ...(input.approval_timeout_s !== undefined && { approval_timeout_s: input.approval_timeout_s }),
      ...(input.initial_approvals && input.initial_approvals.length > 0 && {
        initial_approvals: input.initial_approvals,
      }),
      ...(input.attachments && input.attachments.length > 0 && {
        attachments: input.attachments,
      }),
    });
    return toTaskRowView(detail);
  }

  async approve(taskId: string, requestId: string, scope?: ApprovalScope): Promise<void> {
    await this.client.approveTask(taskId, requestId, scope);
  }

  async deny(taskId: string, requestId: string, reason?: string): Promise<void> {
    await this.client.denyTask(taskId, requestId, reason);
  }
}
