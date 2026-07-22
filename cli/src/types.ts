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
 * boundary from a ``workflow_ref`` (or the resolution fallback). Replaces the
 * former ``task_type`` enum end-to-end (#248).
 *
 * Mirrors ``cdk/src/handlers/shared/types.ts::ResolvedWorkflow`` per the CLI
 * types-sync contract.
 */
export type ResolvedWorkflow = {
  readonly id: string;
  readonly version: string;
};

// --- Agent asset registry (#246) --------------------------------------------
// Wire-facing types consumed by the ``bgagent registry`` commands. Mirror
// ``cdk/src/handlers/shared/types.ts`` per the CLI types-sync contract. The DDB
// record shape (``RegistryAssetRecord``) and audit-event shape are server-only
// and intentionally not mirrored here. See docs/design/REGISTRY.md / ADR-018.

/**
 * Registry asset kinds. Mirrors
 * ``cdk/src/handlers/shared/types.ts::RegistryAssetKind``.
 */
export type RegistryAssetKind =
  | 'mcp_server'
  | 'cedar_policy_module'
  | 'skill'
  | 'plugin'
  | 'subagent'
  | 'prompt_fragment'
  | 'capability';

/**
 * Lifecycle status of a registry asset version. ``approved`` is the single
 * canonical resolvable state ("active" is not a code value). Mirrors
 * ``cdk/src/handlers/shared/types.ts::RegistryAssetStatus``.
 */
export type RegistryAssetStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'deprecated'
  | 'removed';

/**
 * A parsed ``registry://kind/namespace/name@constraint`` reference; the
 * constraint pin is mandatory. Mirrors
 * ``cdk/src/handlers/shared/types.ts::RegistryRef``.
 */
export type RegistryRef = {
  readonly kind: RegistryAssetKind;
  readonly namespace: string;
  readonly name: string;
  readonly constraint: string;
};

/**
 * Typed per-kind descriptor (validated at publish). Mirrors
 * ``cdk/src/handlers/shared/types.ts::RegistryDescriptor``.
 */
export interface RegistryDescriptor {
  readonly summary: string;
  readonly permissions: readonly string[];
  readonly [key: string]: unknown;
}

/**
 * Result of resolving one ``registry://`` ref. Mirrors
 * ``cdk/src/handlers/shared/types.ts::ResolvedAsset``.
 */
export interface ResolvedAsset {
  readonly kind: RegistryAssetKind;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly descriptor: RegistryDescriptor;
  readonly artifact_url?: string;
  readonly warnings: readonly string[];
}

/**
 * All of a task's resolved assets grouped by kind. Mirrors
 * ``cdk/src/handlers/shared/types.ts::ResolvedAssetBundle``.
 */
export interface ResolvedAssetBundle {
  readonly mcp_servers: readonly ResolvedAsset[];
  readonly cedar_policy_modules: readonly ResolvedAsset[];
  readonly skills: readonly ResolvedAsset[];
}

/**
 * Compact ``{kind, id, version}`` audit triple stamped on a task. Mirrors
 * ``cdk/src/handlers/shared/types.ts::ResolvedAssetSummary``.
 */
export interface ResolvedAssetSummary {
  readonly kind: RegistryAssetKind;
  readonly id: string;
  readonly version: string;
}

// --- Registry command request/response envelopes (#246) ----------------------
// CLI-facing shapes for the `bgagent registry` commands. The server returns
// inline objects (not named types), so these are CLI-local (allowlisted in
// scripts/check-types-sync.ts). They describe the publish/list/show responses.

/** Request body for ``bgagent registry publish`` (POST /registry/assets). */
export interface RegistryPublishRequest {
  readonly kind: RegistryAssetKind;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly descriptor: RegistryDescriptor;
  /** Base64-encoded artifact bytes; required for kinds that carry an artifact. */
  readonly artifact_b64?: string;
}

/** Response from a successful publish (subset of the created record). */
export interface RegistryPublishResponse {
  readonly kind: RegistryAssetKind;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly status: RegistryAssetStatus;
  readonly artifact_ref?: string;
  readonly created_at: string;
}

/** One row in the list response — the highest version per asset. */
export interface RegistryAssetListItem {
  readonly kind: RegistryAssetKind;
  readonly namespace: string;
  readonly name: string;
  readonly latest_version: string;
  readonly status: RegistryAssetStatus;
}

/** Response from ``bgagent registry list`` (GET /registry/assets?kind=). */
export interface RegistryListResponse {
  readonly assets: readonly RegistryAssetListItem[];
}

/** One version row in the show response. */
export interface RegistryVersionItem {
  readonly version: string;
  readonly status: RegistryAssetStatus;
  readonly created_at: string;
  readonly publisher: string;
}

/** Response from ``bgagent registry show`` (GET /registry/assets/:kind/:ns/:name). */
export interface RegistryShowResponse {
  readonly kind: RegistryAssetKind;
  readonly namespace: string;
  readonly name: string;
  readonly versions: readonly RegistryVersionItem[];
}

/** Shared across all attachment interfaces. Add new types here (e.g., 'audio'). */
export type AttachmentType = 'image' | 'file' | 'url';

/**
 * Task status literal union. Mirrors ``cdk/src/constructs/task-status.ts``
 * — the values returned by the API are exactly these. Defined inline
 * here (rather than imported from the CDK construct) so the CLI type
 * surface stays portable.
 */
export type TaskStatusType =
  | 'PENDING_UPLOADS'
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
 * - ``jira``: Jira Cloud label-triggered submissions
 *
 * Mirrors ``cdk/src/handlers/shared/types.ts::ChannelSource`` per the CLI
 * types-sync contract so downstream switches/predicates get exhaustiveness
 * checking on both sides of the wire.
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
   *  omit it; absent ⇒ user). Inlined (not a named export) to mirror the cdk
   *  ErrorClassification field without introducing a CLI-only exported type. */
  readonly errorClass?: 'transient' | 'service' | 'user';
}

/** Task detail returned by GET /v1/tasks/{task_id}. */
export interface TaskDetail {
  readonly task_id: string;
  readonly status: TaskStatusType;
  /** ``null`` for a repo-less workflow (#248 Phase 3). */
  readonly repo: string | null;
  readonly issue_number: number | null;
  readonly resolved_workflow: ResolvedWorkflow | null;
  /** Registry assets (#246) resolved for this task, or ``null`` when none
   *  were pinned. Mirrors ``cdk/src/handlers/shared/types.ts``. */
  readonly resolved_assets: ResolvedAssetSummary[] | null;
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
  /** Post-run lint gate result (#515); null on tasks that predate the field. */
  readonly lint_passed: boolean | null;
  /** OTEL trace id (32-char hex) for cross-plane correlation (#515); null when
   *  unavailable or on tasks that predate the field. */
  readonly otel_trace_id: string | null;
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
  /** S3 URI of a repo-less delivered artifact (#248 Phase 3); ``null`` otherwise. */
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
}

/** Response body of ``GET /v1/tasks/{task_id}/trace`` (design §10.1). */
export interface TraceUrlResponse {
  /** Short-lived presigned S3 URL for the gzipped JSONL trajectory. */
  readonly url: string;
  /** ISO-8601 timestamp when ``url`` expires (15 min from issuance). */
  readonly expires_at: string;
}

/**
 * Verification verdict in a {@link ReplayBundle}. Mirrors
 * ``cdk/src/handlers/shared/types.ts::VerificationReport``. Either field is
 * ``null`` when the corresponding gate did not run / predates persistence.
 */
export interface VerificationReport {
  readonly build_passed: boolean | null;
  readonly lint_passed: boolean | null;
}

/**
 * A single event embedded in a {@link ReplayBundle}. Mirrors
 * ``cdk/src/handlers/shared/types.ts::ReplayEvent``. Normalized to the same
 * shape as the events feed ({@link TaskEvent}): ``task_id``/``ttl`` stripped and
 * ``metadata`` defaulted to ``{}``, so ``event.metadata.x`` is always safe.
 */
export interface ReplayEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly timestamp: string;
  readonly metadata: Record<string, unknown>;
  // Correlation envelope (#245): present per-event when the source stamped it.
  readonly user_id?: string;
  readonly repo?: string;
  readonly trace_id?: string;
}

/**
 * Truncation marker on a {@link ReplayBundle}. Mirrors
 * ``cdk/src/handlers/shared/types.ts::ReplayTruncation``. Non-null when the
 * event list was clipped by a cap; ``null`` when the full list fit.
 */
export interface ReplayTruncation {
  readonly reason: 'max_events' | 'max_bytes';
  readonly returned_events: number;
}

/**
 * Response body of ``GET /v1/tasks/{task_id}/replay`` (#515). Mirrors
 * ``cdk/src/handlers/shared/types.ts::ReplayBundle``. Aggregates existing
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
  /** ``null`` for a repo-less workflow (#248 Phase 3). */
  readonly repo: string | null;
  readonly issue_number: number | null;
  readonly resolved_workflow: ResolvedWorkflow | null;
  /** Registry assets (#246) resolved for this task, or ``null`` when none
   *  were pinned. Mirrors ``cdk/src/handlers/shared/types.ts``. */
  readonly resolved_assets: ResolvedAssetSummary[] | null;
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
  // Correlation envelope (#245): present per-event when the source stamped it;
  // absent on task_created and pre-envelope safety-net writers.
  readonly user_id?: string;
  readonly repo?: string;
  readonly trace_id?: string;
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

/** Wire format — parsed from untrusted JSON. Validate before use. */
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
  /** Optional since #248 Phase 3: repo-less workflows submit without it. */
  readonly repo?: string;
  readonly issue_number?: number;
  readonly task_description?: string;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  /** Workflow selector ``<id>[@<constraint>]``. Replaces ``task_type`` (#248).
   *  Omitted ⇒ the create-task boundary resolves via the fallback ladder. */
  readonly workflow_ref?: string;
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

/** Linear link response from POST /v1/linear/link.
 *
 * `dry_run: true` returns the identity attached to the code without
 * writing the mapping. CLI uses it to preview before the user confirms.
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

/** Jira link response from POST /v1/jira/link.
 *
 * Mirrors LinearLinkResponse semantics: `dry_run: true` returns the
 * identity attached to the code without writing. The CLI uses dry-run
 * to render a preview before the user confirms. `linked_at` is omitted
 * from the dry-run response. */
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

/**
 * Default coding workflow id. A bare ``bgagent submit --repo X --task Y``
 * (no ``--workflow``/``--pr``/``--review-pr``) maps to this workflow — the
 * old ``new_task`` default that clones, builds, and opens a PR. Also used by
 * the formatters to suppress a redundant "Workflow:" line when the resolved
 * workflow is just the default. Hoisted to a single constant so the literal
 * is not duplicated across ``submit.ts`` and ``format.ts``.
 */
export const DEFAULT_CODING_WORKFLOW_ID = 'coding/new-task-v1';

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

/** Minimum allowed max_budget_usd (1 cent).
 *  Sourced from ``contracts/constants.json`` via cdk types.ts (#258). */
export const MAX_BUDGET_USD_MIN = 0.01;

/** Maximum allowed max_budget_usd ($100).
 *  Sourced from ``contracts/constants.json`` via cdk types.ts (#258). */
export const MAX_BUDGET_USD_MAX = 100;
