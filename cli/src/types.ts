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

/** Valid task types for task creation. */
export type TaskType = 'new_task' | 'pr_iteration' | 'pr_review';

/**
 * Task status literal union. Mirrors ``cdk/src/constructs/task-status.ts``
 * — the values returned by the API are exactly these. Defined inline
 * here (rather than imported from the CDK construct) so the CLI type
 * surface stays portable.
 */
export type TaskStatusType =
  | 'SUBMITTED'
  | 'HYDRATING'
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT';

/**
 * Provenance of a task's submission. Shared across inbound adapters:
 * - ``api``: CLI / Cognito-authenticated submissions
 * - ``webhook``: HMAC-signed inbound webhook submissions (generic webhook endpoint)
 * - ``slack``: Slack @mention / slash-command submissions
 * - ``linear``: Linear label-triggered submissions
 *
 * Mirrors ``cdk/src/handlers/shared/types.ts::ChannelSource`` per the CLI
 * types-sync contract so downstream switches/predicates get exhaustiveness
 * checking on both sides of the wire.
 */
export type ChannelSource = 'api' | 'webhook' | 'slack' | 'linear';

/** Error categories produced by the runtime error classifier. */
export type ErrorCategoryType = 'auth' | 'network' | 'concurrency' | 'compute' | 'agent' | 'guardrail' | 'config' | 'timeout' | 'unknown';

/** Structured classification of a task error (computed by the API from error_message). */
export interface ErrorClassification {
  readonly category: ErrorCategoryType;
  readonly title: string;
  readonly description: string;
  readonly remedy: string;
  readonly retryable: boolean;
}

/** Task detail returned by GET /v1/tasks/{task_id}. */
export interface TaskDetail {
  readonly task_id: string;
  readonly status: TaskStatusType;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly task_type: TaskType;
  readonly pr_number: number | null;
  readonly task_description: string | null;
  readonly branch_name: string;
  readonly session_id: string | null;
  readonly pr_url: string | null;
  readonly error_message: string | null;
  readonly error_classification: ErrorClassification | null;
  /** Prompt-template version applied during context hydration. Null on
   *  pre-versioned records. Mirrors
   *  ``cdk/src/handlers/shared/types.ts::TaskDetail``. */
  readonly prompt_version: string | null;
  /** Provenance of the task's submission — ``api`` for CLI / Cognito
   *  submissions, ``webhook`` for HMAC-signed inbound webhooks.
   *  Mirrors ``cdk/src/handlers/shared/types.ts::TaskDetail``; kept
   *  in sync per the CLI types-sync contract. */
  readonly channel_source: ChannelSource;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly duration_s: number | null;
  readonly cost_usd: number | null;
  readonly build_passed: boolean | null;
  readonly max_turns: number | null;
  readonly max_budget_usd: number | null;
  /** Rev-5 DATA-1: attempts counter from the SDK (may be `max_turns + 1`
   *  when `agent_status='error_max_turns'` — the aborted attempt is
   *  counted). Required to match ``cdk/src/handlers/shared/types.ts``
   *  (server always emits the field, defaulted to ``null`` in
   *  ``toTaskDetail`` when absent on the record). */
  readonly turns_attempted: number | null;
  /** Rev-5 DATA-1: turns that actually completed (clamped to
   *  `max_turns` when the cap tripped). Required; see
   *  ``turns_attempted`` above. */
  readonly turns_completed: number | null;
  /** Whether the task was submitted with ``--trace``. Surfaces in
   *  ``bgagent status --output json`` so scripts can confirm trace
   *  capture is active. Non-optional because the server always
   *  emits the field (defaulted to ``false`` in ``toTaskDetail`` on
   *  the CDK side) — mirrors the CDK guarantee. */
  readonly trace: boolean;
  /** S3 URI of the ``--trace`` trajectory dump, or ``null`` when the
   *  task did not run with ``--trace`` or the agent has not yet
   *  uploaded. ``bgagent trace download`` reads the presigned URL from
   *  ``GET /v1/tasks/{id}/trace`` rather than this field, but surfacing
   *  the URI in ``status --output json`` lets users / scripts detect
   *  completion without an extra round trip. */
  readonly trace_s3_uri: string | null;
  /** Cedar HITL: running counter of approval gates fired on this
   *  task. Null only on pre-Cedar-HITL records. */
  readonly approval_gate_count: number | null;
  /** Cedar HITL: per-task cap on total approval gates, captured at
   *  submit time from the blueprint (default 50). Null only on
   *  pre-Cedar-HITL records. */
  readonly approval_gate_cap: number | null;
  /** Cedar HITL: when ``status = AWAITING_APPROVAL``, the
   *  ``request_id`` of the pending approval row. Null otherwise. */
  readonly awaiting_approval_request_id: string | null;
}

/** Response body of ``GET /v1/tasks/{task_id}/trace`` (design §10.1). */
export interface TraceUrlResponse {
  /** Short-lived presigned S3 URL for the gzipped JSONL trajectory. */
  readonly url: string;
  /** ISO-8601 timestamp when ``url`` expires (15 min from issuance). */
  readonly expires_at: string;
}

/** Task summary returned by GET /v1/tasks list responses. */
export interface TaskSummary {
  readonly task_id: string;
  readonly status: TaskStatusType;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly task_type: TaskType;
  readonly pr_number: number | null;
  readonly task_description: string | null;
  readonly branch_name: string;
  readonly pr_url: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Task event returned by GET /v1/tasks/{task_id}/events. */
export interface TaskEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly timestamp: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Query parameters accepted by GET /v1/tasks/{task_id}/events.
 *
 * ``after`` and ``next_token`` are mutually exclusive — if both are sent the
 * server prefers ``after`` (and logs a warning). ``after`` is a ULID event_id
 * cursor used by the CLI to catch up on the next polling iteration. Keep in
 * sync with ``cdk/src/handlers/shared/types.ts``.
 */
export interface GetTaskEventsQuery {
  readonly limit?: number;
  readonly next_token?: string;
  readonly after?: string;
  /**
   * When ``"1"``, requests events in descending ``event_id`` order
   * (newest first). Mutually exclusive with ``after`` on the server.
   */
  readonly desc?: string;
}

/**
 * Attachment in a create-task request. Mirrors
 * ``cdk/src/handlers/shared/types.ts::Attachment``.
 */
export interface Attachment {
  readonly type: 'image' | 'file' | 'url';
  readonly content_type?: string;
  readonly data?: string;
  readonly url?: string;
  readonly filename?: string;
}

/** Create task request body for POST /v1/tasks. */
export interface CreateTaskRequest {
  readonly repo: string;
  readonly issue_number?: number;
  readonly task_description?: string;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  readonly task_type?: TaskType;
  readonly pr_number?: number;
  readonly attachments?: readonly Attachment[];
  /**
   * Enable the ``--trace`` debug path (design §10.1). When true, the
   * agent's ProgressWriter raises its preview-truncation cap from 200
   * chars to 4 KB so debug captures aren't silently clipped mid-field.
   * Trace is opt-in per task — routine observability goes through
   * ``bgagent watch`` / notifications.
   */
  readonly trace?: boolean;
  /** Cedar HITL per-task default approval timeout (design §7.3 step 5).
   *  Valid range ``[APPROVAL_TIMEOUT_S_MIN, APPROVAL_TIMEOUT_S_MAX]``. */
  readonly approval_timeout_s?: number;
  /** Cedar HITL pre-approval allowlist seeded at task start (§7.3 step 4).
   *  Each entry must be a valid ``ApprovalScope``. */
  readonly initial_approvals?: readonly ApprovalScope[];
}

/**
 * Maximum length (after trim) of a nudge message. Mirrors
 * `cdk/src/handlers/shared/types.ts` so the CLI can reject oversized
 * input client-side without an API round-trip.
 */
export const NUDGE_MAX_MESSAGE_LENGTH = 2000;

/**
 * Nudge request body for POST /v1/tasks/{task_id}/nudge (Phase 2).
 *
 * A short steering message sent mid-task. The server guardrail-screens,
 * rate-limits (configurable, default 10/min/task), and stores the nudge;
 * the agent picks it up at the next between-turns seam. Keep in sync
 * with `cdk/src/handlers/shared/types.ts`.
 */
export interface NudgeRequest {
  readonly message: string;
}

/** Nudge response from POST /v1/tasks/{task_id}/nudge (HTTP 202). */
export interface NudgeResponse {
  readonly task_id: string;
  readonly nudge_id: string;
  readonly submitted_at: string;
}

/** Cancel task response from DELETE /v1/tasks/{task_id}. */
export interface CancelTaskResponse {
  readonly task_id: string;
  readonly status: TaskStatusType;
  readonly cancelled_at: string;
}

/** Pagination info in list responses. */
export interface Pagination {
  readonly next_token: string | null;
  readonly has_more: boolean;
}

/** Success response envelope. */
export interface SuccessResponse<T> {
  readonly data: T;
}

/** Paginated response envelope. */
export interface PaginatedResponse<T> {
  readonly data: T[];
  readonly pagination: Pagination;
}

/** Error response envelope. */
export interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly request_id: string;
  };
}

/** Webhook detail returned by API responses. */
export interface WebhookDetail {
  readonly webhook_id: string;
  readonly name: string;
  readonly status: 'active' | 'revoked';
  readonly created_at: string;
  readonly updated_at: string;
  readonly revoked_at: string | null;
}

/** Create webhook request body for POST /v1/webhooks. */
export interface CreateWebhookRequest {
  readonly name: string;
}

/** Create webhook response — includes the secret (shown only once). */
export interface CreateWebhookResponse {
  readonly webhook_id: string;
  readonly name: string;
  readonly secret: string;
  readonly created_at: string;
}

/** Slack link response from POST /v1/slack/link. */
export interface SlackLinkResponse {
  readonly slack_team_id: string;
  readonly slack_user_id: string;
  readonly linked_at: string;
}

/** Linear link response from POST /v1/linear/link. */
export interface LinearLinkResponse {
  readonly linear_workspace_id: string;
  readonly linear_user_id: string;
  readonly linked_at: string;
}

/** CLI config stored in ~/.bgagent/config.json. */
export interface CliConfig {
  readonly api_url: string;
  readonly region: string;
  readonly user_pool_id: string;
  readonly client_id: string;
}

/** Cached credentials stored in ~/.bgagent/credentials.json.
 *
 * The Cognito ID token is sent on the Authorization header for REST API
 * Gateway calls (API Gateway's Cognito authorizer validates the `aud`
 * claim against the app client ID).
 */
export interface Credentials {
  readonly id_token: string;
  readonly refresh_token: string;
  readonly token_expiry: string;
}

/** Terminal task statuses. */
export const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const;

// ---------------------------------------------------------------------------
// Cedar HITL approval types — mirrored from
// ``cdk/src/handlers/shared/types.ts`` per the CLI types-sync contract.
// ---------------------------------------------------------------------------

/** Approval scope — matches the `ApprovalScope` discriminated-union on
 *  the server side. Narrowed so `bgagent approve --scope ...` gets
 *  exhaustive type-checking on the CLI side. */
export type ApprovalScope =
  | 'this_call'
  | 'tool_type_session'
  | 'tool_group_session'
  | 'all_session'
  | `tool_type:${string}`
  | `tool_group:${string}`
  | `bash_pattern:${string}`
  | `write_path:${string}`
  | `rule:${string}`;

/** Approval row terminal / pending status. */
export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'DENIED'
  | 'TIMED_OUT'
  | 'STRANDED';

/** POST /v1/tasks/{task_id}/approve request body. */
export interface ApprovalRequest {
  readonly request_id: string;
  readonly decision: 'approve';
  readonly scope?: ApprovalScope;
}

/** POST /v1/tasks/{task_id}/approve response body. */
export interface ApprovalResponse {
  readonly task_id: string;
  readonly request_id: string;
  readonly status: 'APPROVED';
  readonly scope: ApprovalScope;
  readonly decided_at: string;
}

/** POST /v1/tasks/{task_id}/deny request body. */
export interface DenyRequest {
  readonly request_id: string;
  readonly decision: 'deny';
  readonly reason?: string;
}

/** POST /v1/tasks/{task_id}/deny response body. */
export interface DenyResponse {
  readonly task_id: string;
  readonly request_id: string;
  readonly status: 'DENIED';
  readonly decided_at: string;
}

/**
 * Cedar HITL severity literal. Mirrors
 * ``cdk/src/handlers/shared/types.ts::Severity``. Shared alias so
 * the same union is not redefined inline across types.
 */
export type Severity = 'low' | 'medium' | 'high';

/** Pending approval summary returned by `GET /v1/pending`. */
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
  /** Cedar rule ids that matched this request — shown by
   *  ``bgagent pending`` so users can see which rule fired without
   *  spelunking TaskEventsTable. */
  readonly matching_rule_ids: readonly string[];
}

/** GET /v1/pending response body. */
export interface GetPendingResponse {
  readonly pending: readonly PendingApprovalSummary[];
}

/** Rule metadata returned by `GET /v1/repos/{repo_id}/policies`. */
export interface PolicyRuleSummary {
  readonly rule_id: string;
  readonly category?: string;
  readonly severity?: Severity;
  readonly approval_timeout_s?: number;
  readonly summary: string;
}

/** GET /v1/repos/{repo_id}/policies response body. */
export interface GetPoliciesResponse {
  readonly repo_id: string;
  readonly policies: {
    readonly hard: readonly PolicyRuleSummary[];
    readonly soft: readonly PolicyRuleSummary[];
  };
}

/** Maximum deny reason length after server-side sanitization. */
export const DENY_REASON_MAX_LENGTH = 2000;

/** Maximum initial_approvals entries on POST /v1/tasks. */
export const INITIAL_APPROVALS_MAX_ENTRIES = 20;

/** Maximum per-entry length for an initial_approvals scope string. */
export const INITIAL_APPROVALS_MAX_ENTRY_LENGTH = 128;

/** Lower bound on approval_timeout_s submission. */
export const APPROVAL_TIMEOUT_S_MIN = 30;

/** Upper bound on approval_timeout_s submission (before maxLifetime clip). */
export const APPROVAL_TIMEOUT_S_MAX = 3600;

/** Default approval_timeout_s when the submit payload omits it. */
export const APPROVAL_TIMEOUT_S_DEFAULT = 300;
