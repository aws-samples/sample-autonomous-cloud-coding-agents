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
 * A resolved workflow pin: the ``{id, version}`` produced at the create-task
 * boundary from a ``workflow_ref`` (or the resolution fallback).
 */
export type ResolvedWorkflow = {
  readonly id: string;
  readonly version: string;
};

/** A resolved registry-asset pin stamped on the TaskRecord for audit. */
export type ResolvedAssetTriple = {
  readonly kind: string;
  readonly id: string;
  readonly version: string;
};

/** `POST /registry/records` request body. */
export type RegistryPublishRequest = {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  /** semver string, immutable once written. */
  readonly asset_version: string;
  /** discovery descriptor body (server.json / SKILL.md / arbitrary JSON). */
  readonly discovery: Record<string, unknown>;
  /** ABCA runtime payload (connection config / cedar text / prompt fragment). */
  readonly runtime: Record<string, unknown>;
  /** force CUSTOM (verbatim) storage instead of a native descriptor. */
  readonly custom?: boolean;
  /** dev convenience: drive create→submit→approve so the record resolves. */
  readonly auto_approve?: boolean;
};

/** One version row in a `show` response. */
export type RegistryVersionSummary = {
  readonly version: string;
  readonly status: string;
  readonly created_at: string | null;
  readonly publisher: string | null;
  /** True when the record's descriptor payload failed to parse. `publisher` and
   *  `created_at` read `null` on such a row. */
  readonly malformed?: boolean;
};

/** `GET /registry/records/{kind}/{namespace}/{name}` response — one asset's
 *  versions. */
export type RegistryShowResponse = {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly versions: readonly RegistryVersionSummary[];
};

/** A record envelope returned by publish / show. */
export type RegistryRecordResponse = {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly status: string;
  readonly storage_mode: string;
};

/** `GET /registry/resolve?ref=…` response. */
export type RegistryResolveResponse = {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly runtime: Record<string, unknown>;
  readonly warnings: readonly string[];
};

/** One asset row in a `list` response. */
export type RegistryListEntry = {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly latest_version: string | null;
  readonly status: string;
};

export type AttachmentType = 'image' | 'file' | 'url';

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

/**
 * Provenance of a task's submission:
 * - ``api``: CLI / Cognito-authenticated submissions
 * - ``webhook``: HMAC-signed inbound webhook submissions (generic webhook endpoint)
 * - ``slack``: Slack @mention / slash-command submissions
 * - ``linear``: Linear label-triggered submissions
 * - ``jira``: Jira Cloud label-triggered submissions
 */
export type ChannelSource = 'api' | 'webhook' | 'slack' | 'linear' | 'jira';

/** Error categories produced by the runtime error classifier. */
export type ErrorCategoryType = 'auth' | 'network' | 'concurrency' | 'compute' | 'agent' | 'guardrail' | 'config' | 'timeout' | 'blocked' | 'unknown';

/** Structured classification of a task error (computed by the API from error_message). */
export interface ErrorClassification {
  readonly category: ErrorCategoryType;
  readonly title: string;
  readonly description: string;
  readonly remedy: string;
  readonly retryable: boolean;
  /** Retry-semantics axis: transient (self-heals on retry) vs service (admin
   *  must fix) vs user (change the request/code). Optional (older classifications
   *  omit it; absent ⇒ user). */
  readonly errorClass?: 'transient' | 'service' | 'user';
}

/** Task detail returned by GET /v1/tasks/{task_id}. */
export interface TaskDetail {
  /** Configured MicroVM approval-wait delay; 0 disables sleep. Absent on legacy records. */
  readonly microvm_sleep_after_s?: number;
  readonly task_id: string;
  readonly status: TaskStatusType;
  /** ``null`` for a repo-less workflow. */
  readonly repo: string | null;
  readonly issue_number: number | null;
  readonly issue_title: string | null;
  readonly resolved_workflow: ResolvedWorkflow | null;
  /** Registry assets resolved for this task; null when none pinned. */
  readonly resolved_assets: ResolvedAssetTriple[] | null;
  readonly pr_number: number | null;
  readonly task_description: string | null;
  readonly branch_name: string;
  readonly session_id: string | null;
  readonly pr_url: string | null;
  readonly error_message: string | null;
  readonly error_classification: ErrorClassification | null;
  /** Prompt-template version applied during context hydration. Null on
   *  pre-versioned records. */
  readonly prompt_version: string | null;
  readonly channel_source: ChannelSource;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  /** ISO timestamp of the agent's last heartbeat (45 s cadence on agentcore and
   *  lambda-microvm, once at start on ecs); ``null`` before the first beat or on
   *  tasks that never ran. */
  readonly agent_heartbeat_at: string | null;
  /** The compute backend the task's session was started on; ``null`` before a
   *  session starts and on records that predate the field. */
  readonly compute_type: 'agentcore' | 'ecs' | 'lambda-microvm' | null;
  readonly duration_s: number | null;
  readonly cost_usd: number | null;
  readonly build_passed: boolean | null;
  /** Post-run lint gate result; null on tasks that predate the field. */
  readonly lint_passed: boolean | null;
  /** OTEL trace id (32-char hex) for cross-plane correlation; null when
   *  unavailable or on tasks that predate the field. */
  readonly otel_trace_id: string | null;
  readonly max_turns: number | null;
  readonly max_budget_usd: number | null;
  /** The Claude Code CLI's own turn count, kept for debugging. Not the count
   *  `max_turns` limits, and it can exceed the limit on a task that never
   *  reached it. ``null`` when absent on the record. */
  readonly turns_attempted: number | null;
  /** Turns that actually completed: the model's answers, which is what
   *  `max_turns` limits (clamped to it). */
  readonly turns_completed: number | null;
  /** Whether the task was submitted with ``--trace``. */
  readonly trace: boolean;
  /** S3 URI of the ``--trace`` trajectory dump, or ``null`` when the
   *  task did not run with ``--trace`` or the agent has not yet
   *  uploaded. */
  readonly trace_s3_uri: string | null;
  /** S3 URI of a repo-less delivered artifact; ``null`` otherwise. */
  readonly artifact_uri: string | null;
  readonly attachments: AttachmentSummary[] | null;
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
  /** ISO timestamp the task first entered QUEUED; null for tasks that were
   *  admitted directly. */
  readonly queued_at: string | null;
  /** 1-based FIFO position among the caller's
   *  QUEUED tasks when ``status = QUEUED``; null otherwise. Computed
   *  at read time by the server — it changes as the queue drains. */
  readonly queue_position: number | null;
  /** Rough ETA (seconds) until pickup, derived
   *  from queue position and recent task durations. Null when
   *  ``queue_position`` is null. */
  readonly estimated_wait_s: number | null;
}

/** Response body of ``GET /v1/tasks/{task_id}/trace``. */
export interface TraceUrlResponse {
  /** Short-lived presigned S3 URL for the gzipped JSONL trajectory. */
  readonly url: string;
  /** ISO-8601 timestamp when ``url`` expires (15 min from issuance). */
  readonly expires_at: string;
}

/**
 * Verification verdict in a {@link ReplayBundle}. Either field is
 * ``null`` when the corresponding gate did not run / predates persistence.
 */
export interface VerificationReport {
  readonly build_passed: boolean | null;
  readonly lint_passed: boolean | null;
}

/**
 * A single event embedded in a {@link ReplayBundle}. Normalized to the same
 * shape as the events feed ({@link TaskEvent}): ``task_id``/``ttl`` stripped and
 * ``metadata`` defaulted to ``{}``, so ``event.metadata.x`` is always safe.
 */
export interface ReplayEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly timestamp: string;
  readonly metadata: Record<string, unknown>;
  readonly user_id?: string;
  readonly repo?: string;
  readonly trace_id?: string;
}

/**
 * Truncation marker on a {@link ReplayBundle}. Non-null when the
 * event list was clipped by a cap; ``null`` when the full list fit.
 */
export interface ReplayTruncation {
  readonly reason: 'max_events' | 'max_bytes';
  readonly returned_events: number;
}

/**
 * Response body of ``GET /v1/tasks/{task_id}/replay``. Aggregates existing
 * telemetry; absent sources are ``null``/empty rather than omitted.
 */
export interface ReplayBundle {
  readonly task_id: string;
  readonly workflow_ref: string | null;
  readonly resolved_workflow: ResolvedWorkflow | null;
  readonly prompt_version: string | null;
  readonly events: ReplayEvent[];
  readonly events_truncation: ReplayTruncation | null;
  readonly verification: VerificationReport | null;
  readonly trace_uri: string | null;
  readonly otel_trace_id: string | null;
  readonly session_id: string | null;
  readonly cost_usd: number | null;
  readonly collected_at: string;
}

/** Task summary returned by GET /v1/tasks list responses. */
export interface TaskSummary {
  readonly task_id: string;
  readonly status: TaskStatusType;
  /** ``null`` for a repo-less workflow. */
  readonly repo: string | null;
  readonly issue_number: number | null;
  readonly issue_title: string | null;
  readonly resolved_workflow: ResolvedWorkflow | null;
  /** Registry assets resolved for this task; null when none pinned. */
  readonly resolved_assets: ResolvedAssetTriple[] | null;
  readonly pr_number: number | null;
  readonly task_description: string | null;
  readonly branch_name: string;
  readonly pr_url: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  /**
   * Last in-guest liveness beat (ISO-8601), or ``null`` when the agent has not
   * beaten yet, on a substrate whose agent never beats, or on records predating
   * the field.
   */
  readonly agent_heartbeat_at: string | null;
  /** The compute backend the task's session was started on; ``null`` before a
   *  session starts and on records that predate the field. */
  readonly compute_type: 'agentcore' | 'ecs' | 'lambda-microvm' | null;
  /** Estimated spend in USD (null until the agent reports one). */
  readonly cost_usd: number | null;
  /** When the task reached a terminal state (null while it runs). */
  readonly completed_at: string | null;
  /** Where the task was submitted from (console/CLI API, webhook, Slack, Linear, Jira). */
  readonly channel_source: ChannelSource;
}

/** Authenticated caller's personal monthly budget status. */
export interface PersonalBudgetStatus {
  /** UTC calendar month in ``YYYY-MM`` form. */
  readonly period: string;
  /** First instant of the next UTC calendar month. */
  readonly resets_at: string;
  /** Whether an administrator configured a recurring personal limit. */
  readonly configured: boolean;
  /** Estimated terminal-task spend attributed to the caller this month. */
  readonly spend_usd: number;
  /** Configured recurring limit, or null when no personal limit exists. */
  readonly monthly_limit_usd: number | null;
  /** Non-negative estimated amount remaining, or null without a limit. */
  readonly remaining_usd: number | null;
  /** Percentage of the configured limit used, or null without a limit. */
  readonly utilization_percent: number | null;
  /** Whether the administrator enabled admission hard-stop enforcement. */
  readonly hard_stop: boolean;
  /** Whether the configured hard stop is currently blocking new tasks. */
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

export interface Attachment {
  readonly type: AttachmentType;
  readonly content_type?: string;
  readonly data?: string;
  readonly url?: string;
  readonly filename?: string;
  readonly expected_size_bytes?: number;
}

/** Attachment metadata in task detail responses. */
export interface AttachmentSummary {
  readonly attachment_id: string;
  readonly type: AttachmentType;
  readonly filename: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly screening_status: 'passed' | 'blocked' | 'pending';
}

/** Presigned upload instruction returned on PENDING_UPLOADS creation. */
export interface AttachmentUploadInstruction {
  readonly attachment_id: string;
  readonly filename: string;
  readonly upload_url: string;
  readonly upload_fields: Record<string, string>;
  readonly upload_expires_at: string;
}

/** Response from POST /v1/tasks when presigned uploads are required. */
export interface CreateTaskResponse extends TaskDetail {
  readonly upload_instructions?: readonly AttachmentUploadInstruction[];
  readonly task_expires_at?: string;
}

/** Create task request body for POST /v1/tasks. */
export interface CreateTaskRequest {
  /** MicroVM approval-wait seconds before sleep (0 = off, omitted = the platform default). Does not extend approval deadlines. */
  readonly microvm_sleep_after_s?: number;
  /** Repo-less workflows submit without it. */
  readonly repo?: string;
  readonly issue_number?: number;
  readonly task_description?: string;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  /** Workflow selector ``<id>[@<constraint>]``.
   *  Omitted ⇒ the create-task boundary resolves via the fallback ladder. */
  readonly workflow_ref?: string;
  readonly pr_number?: number;
  readonly attachments?: readonly Attachment[];
  /**
   * Enable the ``--trace`` debug path. When true, the
   * agent's ProgressWriter raises its preview-truncation cap from 200
   * chars to 4 KB.
   */
  readonly trace?: boolean;
  /** Cedar HITL per-task default approval timeout.
   *  Valid range ``[APPROVAL_TIMEOUT_S_MIN, APPROVAL_TIMEOUT_S_MAX]``. */
  readonly approval_timeout_s?: number;
  /** Cedar HITL pre-approval allowlist seeded at task start.
   *  Each entry must be a valid ``ApprovalScope``. */
  readonly initial_approvals?: readonly ApprovalScope[];
}

/** Maximum length (after trim) of a nudge message. */
export const NUDGE_MAX_MESSAGE_LENGTH = 2000;

/**
 * Nudge request body for POST /v1/tasks/{task_id}/nudge.
 *
 * A short steering message sent mid-task. The server guardrail-screens,
 * rate-limits (configurable, default 10/min/task), and stores the nudge;
 * the agent picks it up at the next between-turns seam.
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

export interface Pagination {
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
  /** URL that external systems post tasks to; the same for every webhook of a deployment. */
  readonly webhook_url: string;
  readonly created_at: string;
}

export type ApiKeyScope = 'webhooks:manage' | 'webhooks:invoke' | 'tasks:read' | 'tasks:cancel';

/** Scopes recognized by the platform. Order is not significant. */
export const API_KEY_SCOPES: readonly ApiKeyScope[] = [
  'webhooks:manage',
  'webhooks:invoke',
  'tasks:read',
  'tasks:cancel',
];

export interface ApiKeyDetail {
  readonly key_id: string;
  readonly name: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly status: 'active' | 'revoked';
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

/** Create API key request body for POST /v1/api-keys. */
export interface CreateApiKeyRequest {
  readonly name: string;
  readonly scopes?: readonly ApiKeyScope[];
  readonly expires_at?: string;
}

/** Create API key response — includes the key material (shown only once). */
export interface CreateApiKeyResponse {
  readonly key_id: string;
  readonly name: string;
  readonly key: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly expires_at: string | null;
  readonly created_at: string;
}

/** Slack link response from POST /v1/slack/link. */
export interface SlackLinkResponse {
  readonly slack_team_id: string;
  readonly slack_user_id: string;
  readonly linked_at: string;
}

/** Linear link response from POST /v1/linear/link.
 *
 * `dry_run: true` returns the identity attached to the code without
 * writing the mapping.
 * `linked_at` is omitted from the dry-run response. */
export interface LinearLinkResponse {
  readonly dry_run?: boolean;
  readonly linear_workspace_id: string;
  readonly linear_workspace_slug?: string;
  readonly linear_user_id: string;
  readonly linear_user_name?: string;
  readonly linear_user_email?: string;
  readonly linked_at?: string;
}

/** Linear remove-workspace response from DELETE /v1/linear/workspaces/{slug}.
 *
 * `status` is `revoked` for the default soft-removal (registry row kept with
 * `status=revoked` and `revoked_reason=admin_removed`) or `purged`
 * when the row was deleted outright (`--purge`). A revoked row no longer
 * resolves tokens, and the removal is terminal. Project→repo mappings are
 * not touched.
 *
 * `provider_name` is present only for vault-managed workspaces, and its
 * presence means **teardown is not finished**: an AgentCore OAuth2 credential
 * provider survives outside CloudFormation, still holding the Linear client
 * secret and a live, self-refreshing grant. */
export interface LinearRemoveWorkspaceResponse {
  readonly workspace_slug: string;
  readonly linear_workspace_id: string;
  readonly status: 'revoked' | 'purged';
  /**
   * What happened to the per-workspace `bgagent-linear-oauth-<slug>` secret:
   * - `deleted` — a live secret was destroyed by this call.
   * - `absent` — there was supposed to be one and it is already gone (a re-run,
   *   or a prior partial teardown). Idempotent success.
   * - `not_applicable` — the workspace is vault-managed and never had a Secrets
   *   Manager secret of its own; its credential lives in the AgentCore provider
   *   named by `provider_name`, which this endpoint does **not** delete.
   */
  readonly secret: 'deleted' | 'absent' | 'not_applicable';
  readonly provider_name?: string;
}

/** Jira link response from POST /v1/jira/link.
 *
 * `dry_run: true` returns the identity attached to the code without
 * writing. `linked_at` is omitted from the dry-run response. */
export interface JiraLinkResponse {
  readonly dry_run?: boolean;
  readonly jira_cloud_id: string;
  readonly jira_site_url?: string;
  readonly jira_account_id: string;
  readonly jira_user_name?: string;
  readonly jira_user_email?: string;
  readonly linked_at?: string;
}

/** CLI config stored in ~/.bgagent/config.json. */
export interface CliConfig {
  readonly api_url: string;
  /** URL of the agent asset registry API, which is a separate API
   *  Gateway from `api_url` (see RegistryApiUrl stack output). Absent in
   *  configs written before the registry shipped;
   *  `bgagent registry` commands require it. */
  readonly registry_api_url?: string;
  readonly region: string;
  readonly user_pool_id: string;
  readonly client_id: string;
  /** Stack the config was read from (`bgagent setup`, `configure --stack-name`). */
  readonly stack_name?: string;
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

export const TERMINAL_STATUSES: readonly TaskStatusType[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

/**
 * Default coding workflow id. A bare ``bgagent submit --repo X --task Y``
 * (no ``--workflow``/``--pr``/``--review-pr``) maps to this workflow.
 */
export const DEFAULT_CODING_WORKFLOW_ID = 'coding/new-task-v1';

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

/** Cedar HITL severity literal. */
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
  /** Cedar rule ids that matched this request. */
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

/** Per-task MicroVM sleep delay bounds; zero disables automatic sleep. */
export const MICROVM_SLEEP_AFTER_S_MIN = 0;
export const MICROVM_SLEEP_AFTER_S_MAX = 3600;
export const MICROVM_SLEEP_AFTER_S_DEFAULT = 60;

/** Minimum allowed max_budget_usd (1 cent). */
export const MAX_BUDGET_USD_MIN = 0.01;

/** Maximum allowed max_budget_usd ($100). */
export const MAX_BUDGET_USD_MAX = 100;
