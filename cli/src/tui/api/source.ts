/**
 * Abstract data source for the TUI.
 *
 * The TUI has historically used synchronous `get*` functions
 * (mock-backed). To support a real backend without rewriting every
 * panel to `useEffect + async`, the `DataProvider` hydrates a
 * source asynchronously and the panels read cached snapshots off a
 * React context. Real mode re-hydrates on a polling interval;
 * mock mode resolves immediately from fixtures.
 */

import type {
  ApprovalScope,
  Attachment,
  PendingApprovalSummary,
  TaskEvent,
} from '../../types.js';
import type {
  PendingApprovalView,
  PolicyRuleView,
  RegisteredRepoView,
  TaskRowView,
} from '../data.js';

/** Initial approvals passed through to the submit path. */
export interface SubmitTaskInput {
  readonly repo: string;
  readonly task_description: string;
  readonly issue_number?: number;
  readonly pr_number?: number;
  readonly task_type?: 'new_task' | 'pr_iteration' | 'pr_review';
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  readonly approval_timeout_s?: number;
  readonly initial_approvals?: readonly ApprovalScope[];
  /** Optional attachments forwarded to the create-task endpoint.
   *  Mirrors `CreateTaskRequest.attachments`; the TUI populates this
   *  from clipboard image paste. */
  readonly attachments?: readonly Attachment[];
}

/** A source of TUI data — either mock or real. Query methods return
 *  the viewmodel shapes panels bind to; mutations return the updated
 *  resource (or a stub in mock mode). */
export interface DataSource {
  /** Human-readable label — used by the TUI to show mock-mode banner. */
  readonly label: 'mock' | 'live';

  listTasks(): Promise<TaskRowView[]>;
  /**
   * Fetch task events, optionally starting after a known cursor.
   *
   * When `after` is omitted, returns all events for the task (the
   * real source drains pagination via `next_token`; mock returns
   * the full fixture). When `after` is passed, returns only events
   * strictly greater than that `event_id` — mirrors
   * `ApiClient.catchUpEvents` so the TUI can incrementally catch
   * up long streams without re-fetching history it has already
   * rendered.
   */
  getTaskEvents(taskId: string, opts?: { after?: string }): Promise<TaskEvent[]>;
  listPending(): Promise<PendingApprovalView[]>;
  /** Returns empty `{hard:[], soft:[]}` when the caller has not picked
   *  a specific repo; the Policies panel surfaces a picker. */
  listPolicies(repoId: string): Promise<{
    hard: PolicyRuleView[];
    soft: PolicyRuleView[];
  }>;
  listRegisteredRepos(): Promise<RegisteredRepoView[]>;

  submitTask(input: SubmitTaskInput): Promise<TaskRowView>;
  approve(taskId: string, requestId: string, scope?: ApprovalScope): Promise<void>;
  deny(taskId: string, requestId: string, reason?: string): Promise<void>;
}

/** Enrich a `PendingApprovalSummary` (wire shape) with `repo` +
 *  `task_description` drawn from the parent TaskDetail index. Used by
 *  the real data source where those fields aren't on the pending list
 *  response (the API intentionally keeps `/v1/pending` small). */
export function enrichPendingApproval(
  p: PendingApprovalSummary,
  repoByTaskId: Map<string, string>,
  descByTaskId: Map<string, string | null>,
): PendingApprovalView {
  const upper = p.severity.toUpperCase();
  const severity: 'HIGH' | 'MEDIUM' | 'LOW' =
    upper === 'HIGH' || upper === 'MEDIUM' || upper === 'LOW' ? upper : 'MEDIUM';
  return {
    task_id: p.task_id,
    request_id: p.request_id,
    tool_name: p.tool_name,
    tool_input_preview: p.tool_input_preview,
    severity,
    reason: p.reason,
    created_at: p.created_at,
    timeout_s: p.timeout_s,
    expires_at: p.expires_at,
    matching_rule_ids: p.matching_rule_ids,
    repo: repoByTaskId.get(p.task_id) ?? '(unknown)',
    task_description: descByTaskId.get(p.task_id) ?? '',
  };
}
