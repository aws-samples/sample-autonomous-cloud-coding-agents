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
 * REST API wire types used by the console.
 *
 * Mirrors the subset of `cli/src/types.ts` (itself mirrored from
 * `cdk/src/handlers/shared/types.ts`) that the console reads. Keep field
 * names and shapes identical; see docs/design/API_CONTRACT.md.
 */

export type TaskStatusType =
  | 'PENDING_UPLOADS'
  | 'QUEUED'
  | 'SUBMITTED'
  | 'HYDRATING'
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT';

export const TERMINAL_STATUSES: readonly TaskStatusType[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
export const PRE_ACTIVE_STATUSES: readonly TaskStatusType[] = ['PENDING_UPLOADS', 'QUEUED'];
export const ACTIVE_STATUSES: readonly TaskStatusType[] = ['SUBMITTED', 'HYDRATING', 'RUNNING', 'AWAITING_APPROVAL', 'FINALIZING'];

export type ChannelSource = 'api' | 'webhook' | 'slack' | 'linear' | 'jira';

type ErrorCategoryType = 'auth' | 'network' | 'concurrency' | 'compute' | 'agent' | 'guardrail' | 'config' | 'timeout' | 'blocked' | 'unknown';

interface ErrorClassification {
  readonly category: ErrorCategoryType;
  readonly title: string;
  readonly description: string;
  readonly remedy: string;
  readonly retryable: boolean;
  readonly errorClass?: 'transient' | 'service' | 'user';
}

type ResolvedWorkflow = {
  readonly id: string;
  readonly version: string;
};

type ResolvedAssetTriple = {
  readonly kind: string;
  readonly id: string;
  readonly version: string;
};

type AttachmentType = 'image' | 'file' | 'url';

interface AttachmentSummary {
  readonly attachment_id: string;
  readonly type: AttachmentType;
  readonly filename: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly screening_status: 'passed' | 'blocked' | 'pending';
}

/** Task summary returned by GET /v1/tasks. */
export interface TaskSummary {
  readonly task_id: string;
  readonly status: TaskStatusType;
  readonly repo: string | null;
  readonly issue_number: number | null;
  readonly resolved_workflow: ResolvedWorkflow | null;
  readonly resolved_assets: ResolvedAssetTriple[] | null;
  readonly pr_number: number | null;
  readonly task_description: string | null;
  readonly branch_name: string;
  readonly pr_url: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly agent_heartbeat_at: string | null;
  /** Estimated spend in USD; null until the agent reports one. */
  readonly cost_usd: number | null;
  readonly completed_at: string | null;
  readonly channel_source: ChannelSource;
}

/** Caller's own monthly budget, from GET /v1/tasks?view=budget. */
export interface PersonalBudgetStatus {
  /** UTC month, `YYYY-MM`. */
  readonly period: string;
  readonly resets_at: string;
  /** Whether an administrator set a monthly limit for this user. */
  readonly configured: boolean;
  readonly spend_usd: number;
  readonly monthly_limit_usd: number | null;
  readonly remaining_usd: number | null;
  readonly utilization_percent: number | null;
  readonly hard_stop: boolean;
  readonly hard_stop_active: boolean;
}

/** Task detail returned by GET /v1/tasks/{task_id}. */
export interface TaskDetail {
  readonly task_id: string;
  readonly status: TaskStatusType;
  readonly repo: string | null;
  readonly issue_number: number | null;
  readonly resolved_workflow: ResolvedWorkflow | null;
  readonly resolved_assets: ResolvedAssetTriple[] | null;
  readonly pr_number: number | null;
  readonly task_description: string | null;
  readonly branch_name: string;
  readonly session_id: string | null;
  readonly pr_url: string | null;
  readonly error_message: string | null;
  readonly error_classification: ErrorClassification | null;
  readonly prompt_version: string | null;
  readonly channel_source: ChannelSource;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly agent_heartbeat_at: string | null;
  readonly duration_s: number | null;
  readonly cost_usd: number | null;
  readonly build_passed: boolean | null;
  readonly lint_passed: boolean | null;
  readonly otel_trace_id: string | null;
  readonly max_turns: number | null;
  readonly max_budget_usd: number | null;
  readonly turns_attempted: number | null;
  readonly turns_completed: number | null;
  readonly trace: boolean;
  readonly trace_s3_uri: string | null;
  readonly artifact_uri: string | null;
  readonly attachments: AttachmentSummary[] | null;
  readonly approval_gate_count: number | null;
  readonly approval_gate_cap: number | null;
  readonly awaiting_approval_request_id: string | null;
  readonly queued_at: string | null;
  readonly queue_position: number | null;
  readonly estimated_wait_s: number | null;
}

/** Task event returned by GET /v1/tasks/{task_id}/events. */
export interface TaskEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly timestamp: string;
  readonly metadata: Record<string, unknown>;
  readonly user_id?: string;
  readonly repo?: string;
  readonly trace_id?: string;
}

export type Severity = 'low' | 'medium' | 'high';

/** Pending approval summary returned by GET /v1/pending. */
export interface PendingApprovalSummary {
  readonly task_id: string;
  readonly request_id: string;
  readonly tool_name: string;
  readonly tool_input_preview: string;
  readonly severity: Severity;
  readonly reason: string;
  readonly created_at: string;
  readonly timeout_s: number;
  readonly expires_at: string;
  readonly matching_rule_ids: readonly string[];
}

export interface GetPendingResponse {
  readonly pending: readonly PendingApprovalSummary[];
}

/** One open issue from the console API's GET /repos/{repo_id}/issues. */
export interface RepoIssueSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly updated_at: string;
  readonly labels: readonly string[];
}

export interface ListRepoIssuesResponse {
  readonly repo: string;
  readonly issues: readonly RepoIssueSummary[];
}

/** POST /v1/tasks body: the subset the console sends. */
export interface CreateTaskRequest {
  readonly repo: string;
  /** Always sent: an absent ref makes the server pick the repo-less `default/agent-v1` workflow. */
  readonly workflow_ref: string;
  readonly issue_number?: number;
  readonly task_description?: string;
}

/**
 * Clone → build → open a pull request. Mirrors `DEFAULT_CODING_WORKFLOW_ID` in the CLI,
 * which pins it for the same reason (see cli/src/commands/submit.ts).
 */
export const CODING_WORKFLOW_ID = 'coding/new-task-v1';

/** Mirrors `NUDGE_MAX_MESSAGE_LENGTH` in cli/src/types.ts. */
export const NUDGE_MAX_MESSAGE_LENGTH = 2000;

/** POST /v1/tasks/{task_id}/nudge response (HTTP 202). */
export interface NudgeResponse {
  readonly task_id: string;
  readonly nudge_id: string;
  readonly submitted_at: string;
}

/** DELETE /v1/tasks/{task_id} response. */
export interface CancelTaskResponse {
  readonly task_id: string;
  readonly status: TaskStatusType;
  readonly cancelled_at: string;
}

/** POST /v1/tasks/{task_id}/approve and /deny responses (HTTP 202). */
export interface DecisionResponse {
  readonly task_id: string;
  readonly request_id: string;
  readonly status: string;
  readonly decided_at: string;
}

interface Pagination {
  readonly next_token: string | null;
  readonly has_more: boolean;
}

export interface SuccessResponse<T> {
  readonly data: T;
}

export interface PaginatedResponse<T> {
  readonly data: T[];
  readonly pagination: Pagination;
}

export interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly request_id: string;
  };
}
