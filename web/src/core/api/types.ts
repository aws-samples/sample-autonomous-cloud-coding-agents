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
  readonly issue_title: string | null;
  readonly resolved_workflow: ResolvedWorkflow | null;
  readonly resolved_assets: ResolvedAssetTriple[] | null;
  readonly pr_number: number | null;
  readonly task_description: string | null;
  readonly branch_name: string;
  readonly pr_url: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly agent_heartbeat_at: string | null;
  /** The compute backend the task's session was started on; null before a session starts and on records that predate the field. */
  readonly compute_type: 'agentcore' | 'ecs' | 'lambda-microvm' | null;
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

/** What a finished task counts as on the scoreboard. `failed`, `cancelled` and `timed_out` are the statuses of those names; `verified_pr`, `unverified_pr` and `no_new_pr` split the completed tasks. */
export type TaskOutcome = 'verified_pr' | 'unverified_pr' | 'no_new_pr' | 'failed' | 'cancelled' | 'timed_out';

/** A place the work waited for, or was redirected by, a person. `approve` counts approval requests, whatever the answer. */
export type TouchpointKind = 'approve' | 'clarify' | 'follow_up' | 'cancel';

/** The state on GitHub of a new pull request that ABCA follows, as its reads recorded it. `unread`: no read has recorded one yet, or a read found no pull request of the task under the recorded number and does not ask again. In `pull_requests` it is the state at the period's end: a merge or a close after that end counts as `open`. */
export type PullRequestState = 'merged' | 'closed' | 'open' | 'unread';

/** How far back a scoreboard looks: that many days up to now. */
export type ScoreboardRange = '7d' | '30d';

/** `count` of `total`. A rate is count / total; with a total of 0 there is none. */
export interface Fraction {
  readonly count: number;
  readonly total: number;
}

/** A count, with the ids of up to 10 of the tasks behind it. */
export interface Flagged {
  readonly count: number;
  readonly task_ids: readonly string[];
}

/** The median and the 90th percentile of durations in whole seconds, and how many durations there are. */
export interface DurationSummary {
  readonly p50: number;
  readonly p90: number;
  readonly count: number;
}

/** The scoreboard's numbers over the tasks that finished in one period. */
export interface ScoreboardPeriod {
  /** ISO bounds: tasks that finished at or after `from` and before `to`. The current period has no upper test: a finish time ahead of the clock belongs to it. */
  readonly from: string;
  readonly to: string;
  /** Tasks that reached a terminal state, and their split. */
  readonly finished: number;
  readonly outcomes: Readonly<Record<TaskOutcome, number>>;
  /** Seconds from task creation to a verified pull request; null when there is none. With fewer than 10 values, `p90` is the largest or close to it. */
  readonly time_to_verified_pr_s: DurationSummary | null;
  /** Median seconds from creation to the start of the session, time in the admission queue included, over the verified pull requests above whose start is known; null when there is none. */
  readonly wait_p50_s: number | null;
  /** Tasks that waited in the admission queue, of the tasks that waited or ran. */
  readonly queued: Fraction;
  /** Verified pull requests, of the tasks that asked for a new pull request. */
  readonly verified: Fraction;
  /** New pull requests with no follow-up task before the period's end (a follow-up known to have changed no code is not one), of the new pull requests whose number is known. */
  readonly not_reworked: Fraction;
  /** Verified pull requests whose task never stopped for a person, of the tasks that asked for a new pull request. */
  readonly untouched: Fraction;
  /** Touchpoints on coding tasks. Shown per verified pull request: divide the sum by `outcomes.verified_pr`. */
  readonly touchpoints: Readonly<Record<TouchpointKind, number>>;
  /** Recorded spend of coding tasks, all outcomes, to the micro-dollar. Shown per verified pull request: divide by `outcomes.verified_pr`. */
  readonly spend_usd: number;
  /** Coding tasks that ran and recorded no cost: `spend_usd` under-counts by them. */
  readonly uncosted: number;
  /** Finished tasks of any kind, not only coding tasks, that a guardrail stopped; newest first. Each is also one of `outcomes.failed`. */
  readonly guardrail_stops: Flagged;
  /** Finished tasks of any kind that were submitted with every approval granted in advance; newest first. */
  readonly blanket_approvals: Flagged;
  /** Coding tasks that stopped for at least one approval request, of the coding tasks that ran. */
  readonly gated: Fraction;
  /** The new pull requests of the period that ABCA follows, by their state at the period's end: the four add up to those pull requests. A pull request opened by a task of an orchestration is not followed, and is in none of them. Shown as the merged share: `merged` of `merged` + `closed` + `open`, with `unread` outside it. */
  readonly pull_requests: Readonly<Record<PullRequestState, number>>;
  /** Merged pull requests nobody sent back first (no change request by a reviewer with write access, no reworking follow-up before the merge), of the merged ones. */
  readonly merged_clean: Fraction;
  /** Seconds from task creation to the merge, over the pull requests merged before the period's end; null when none was merged. */
  readonly time_to_merge_s: DurationSummary | null;
  /** Seconds from the end of the task to the first review of its pull request by a person with write access to the repository, other than the pull request's author, over the merged ones that had one; null when none had. A review before that end counts as 0. */
  readonly first_review_s: DurationSummary | null;
}

/** GET /v1/tasks?view=scoreboard: the caller's scoreboard for a range. */
export interface Scoreboard {
  readonly range: ScoreboardRange;
  /** The read hit its cap inside the current period: `current` starts later than the range asked for, and `previous` is null. */
  readonly truncated: boolean;
  readonly current: ScoreboardPeriod;
  /** The period of equal length before `current`; null when the read did not cover it. */
  readonly previous: ScoreboardPeriod | null;
  /**
   * New pull requests that ABCA follows and that were open at its last read more than 7 days
   * after their task finished, oldest first, over the tasks of both periods. Null when the
   * count is not known: the read did not cover the earlier period, so the pull requests of
   * the tasks it left out would be missing; or some pull requests are that old and ABCA has
   * read none of them on GitHub.
   */
  readonly open_over_7d: Flagged | null;
}

/** Task detail returned by GET /v1/tasks/{task_id}. */
export interface TaskDetail {
  readonly task_id: string;
  readonly status: TaskStatusType;
  readonly repo: string | null;
  readonly issue_number: number | null;
  readonly issue_title: string | null;
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
  /** The compute backend the task's session was started on; null before a session starts and on records that predate the field. */
  readonly compute_type: 'agentcore' | 'ecs' | 'lambda-microvm' | null;
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

/** What the agent is doing with a Linear issue (console API). */
export type LinearAgentState =
  | { readonly kind: 'available' }
  /** Labeled for the agent, task not created yet (the Linear webhook is on its way). */
  | { readonly kind: 'starting' }
  /**
   * `task_id` is null when the task belongs to someone else. `task_id`, `status` and `pr_url`
   * are all null for a labeled issue that is no longer starting and has no task of its own:
   * an epic, whose sub-issues get the tasks, or an issue whose start was refused.
   */
  | { readonly kind: 'task'; readonly task_id: string | null; readonly status: TaskStatusType | null; readonly pr_url: string | null; readonly mine: boolean };

export interface LinearIssueSummary {
  readonly id: string;
  /** Linear's key, e.g. `MON-4`. */
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly state_type: string;
  readonly priority_label: string;
  readonly labels: readonly string[];
  readonly assignee: string | null;
  readonly updated_at: string;
  readonly agent: LinearAgentState;
}

export interface LinearProjectIssues {
  readonly project_id: string;
  readonly trigger_label: string;
  /** Set when the project's issues could not be loaded; explains what to do. */
  readonly problem?: string;
  readonly issues: readonly LinearIssueSummary[];
}

/** GET /repos/{repo_id}/linear-issues (console API). */
export interface ListLinearIssuesResponse {
  readonly repo: string;
  readonly projects: readonly LinearProjectIssues[];
}

/** POST /linear-issues/{issue_id}/start (console API, HTTP 202). */
export interface StartLinearIssueResponse {
  readonly issue_id: string;
  readonly identifier: string;
  readonly repo: string;
}

/** POST /v1/tasks body: the subset the console sends. */
export interface CreateTaskRequest {
  readonly repo: string;
  /** Always sent: an absent ref makes the server pick the repo-less `default/agent-v1` workflow. */
  readonly workflow_ref: string;
  readonly issue_number?: number;
  readonly task_description?: string;
  /** Omitted: the repository's setting, else {@link TURN_LIMIT}`.default`. */
  readonly max_turns?: number;
  /** Omitted: the repository's setting, else no spending limit. */
  readonly max_budget_usd?: number;
  /** Keep up to 4 KB of each command and its output instead of 200 characters. */
  readonly trace?: boolean;
}

/** Mirrors `MIN_MAX_TURNS` / `MAX_MAX_TURNS` / `DEFAULT_MAX_TURNS` in cdk/src/handlers/shared/validation.ts. */
export const TURN_LIMIT = { min: 1, max: 500, default: 100 } as const;

/** Mirrors `max_budget_usd` in contracts/constants.json. */
export const BUDGET_LIMIT_USD = { min: 0.01, max: 100 } as const;

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
