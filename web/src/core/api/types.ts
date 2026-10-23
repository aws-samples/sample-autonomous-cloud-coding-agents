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

type ChannelSource = 'api' | 'webhook' | 'slack' | 'linear' | 'jira';

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
