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

import { classifyError, type ErrorClassification } from './error-classifier';
import { logger } from './logger';
import { coerceNumericOrNull } from './numeric';
import type { ComputeType } from './repo-config';
// Cross-language constants — see ``contracts/constants.md``. Imported at
// TypeScript compile time (resolveJsonModule); esbuild inlines the values
// into the bundled Lambda artifact, so no runtime FS read is needed.
import sharedConstants from '../../../../contracts/constants.json';
import type { TaskStatusType } from '../../constructs/task-status';

/**
 * Re-export of {@link TaskStatusType} so the CDK↔CLI type-sync drift
 * check sees a single declaration site for the API status union. The
 * canonical source remains ``cdk/src/constructs/task-status.ts``.
 */
export type { TaskStatusType };

/** Valid task types for task creation. */
export type TaskType = 'new_task' | 'pr_iteration' | 'pr_review';

/** Shared across all attachment interfaces. Add new types here (e.g., 'audio'). */
export type AttachmentType = 'image' | 'file' | 'url';

/** Delivery mechanism — discriminant for the three upload paths. */
export type AttachmentDelivery = 'inline' | 'presigned' | 'url_fetch';

/**
 * Provenance of a task's submission. Shared across inbound adapters:
 * - ``api``: CLI / Cognito-authenticated submissions
 * - ``webhook``: HMAC-signed inbound webhook submissions (generic webhook endpoint)
 * - ``slack``: Slack @mention / slash-command submissions (see SlackIntegration)
 * - ``linear``: Linear label-triggered submissions (see LinearIntegration)
 *
 * Narrowed from ``string`` so switches and predicates that read
 * ``channel_source`` get exhaustiveness checking at compile time; matches the
 * internal ``CreateTaskContext.channelSource`` literal in ``create-task-core.ts``.
 * Keep in sync with ``cli/src/types.ts::ChannelSource``.
 */
export type ChannelSource = 'api' | 'webhook' | 'slack' | 'linear';

/** Task types that operate on an existing pull request. */
export function isPrTaskType(taskType: TaskType): boolean {
  return taskType === 'pr_iteration' || taskType === 'pr_review';
}

/**
 * Full task record as stored in DynamoDB.
 */
export interface TaskRecord {
  readonly task_id: string;
  readonly user_id: string;
  readonly status: TaskStatusType;
  readonly repo: string;
  readonly issue_number?: number;
  readonly task_type: TaskType;
  readonly pr_number?: number;
  readonly task_description?: string;
  readonly branch_name: string;
  readonly session_id?: string;
  /** AgentCore runtime ARN used for this session (StopRuntimeSession on cancel). */
  readonly agent_runtime_arn?: string;
  /** ISO timestamp of last agent heartbeat (DynamoDB); optional, written by the runtime. */
  readonly agent_heartbeat_at?: string;
  readonly execution_id?: string;
  readonly pr_url?: string;
  readonly error_message?: string;
  readonly idempotency_key?: string;
  readonly channel_source: ChannelSource;
  readonly channel_metadata?: Record<string, string>;
  readonly status_created_at: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at?: string;
  readonly completed_at?: string;
  readonly cost_usd?: number;
  readonly duration_s?: number;
  readonly build_passed?: boolean;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  /**
   * Whether the task was submitted with ``--trace`` (design §10.1).
   * When true the orchestrator threads a ``trace: true`` flag into the
   * agent payload; the agent's ``_ProgressWriter`` raises its preview
   * cap from 200 chars to 4 KB so debug captures aren't silently
   * clipped. Opt-in per task — not routine observability.
   */
  readonly trace?: boolean;
  /**
   * S3 URI of the gzipped JSONL trajectory dump written by the agent on
   * terminal state when ``trace`` is true (design §10.1). Shape:
   * ``s3://<trace-bucket>/traces/<user_id>/<task_id>.jsonl.gz``. Absent
   * until the agent finishes the upload; also absent for tasks that ran
   * without ``--trace`` or whose upload failed. The
   * ``get-trace-url`` handler reads this to issue presigned download URLs.
   */
  readonly trace_s3_uri?: string;
  /** Rev-5 DATA-1: authoritative SDK counter including the attempt that
   *  tripped any cap. Equals the legacy `turns` value. */
  readonly turns_attempted?: number;
  /** Rev-5 DATA-1: turns that actually completed (clamped to
   *  `max_turns` when `agent_status='error_max_turns'`). */
  readonly turns_completed?: number;
  readonly prompt_version?: string;
  readonly memory_written?: boolean;
  readonly compute_type?: ComputeType;
  readonly compute_metadata?: Record<string, string>;
  readonly ttl?: number;
  /**
   * Optional per-task override for the FanOutConsumer's channel filters
   * (design §6.5). When present, the router uses these settings instead
   * of the per-channel defaults. Chunk I introduced the type and the
   * resolution path; Chunk K adds a submit-time API parameter and the
   * DDB read that populates this field — until then it is always
   * ``undefined`` at runtime and every task inherits the defaults.
   */
  readonly notifications?: TaskNotificationsConfig;
  /**
   * ID of the single GitHub issue comment the fan-out plane maintains
   * for this task (design §6.4 — edit-in-place). Written by the
   * GitHub dispatcher on the first delivery; read on subsequent
   * deliveries to PATCH instead of POST. Absent until the first
   * dispatch fires successfully.
   */
  readonly github_comment_id?: number;
  readonly attachments?: AttachmentRecord[];
  /**
   * Cedar HITL: per-task default approval timeout (design §10.2).
   * Default 300s when absent. The engine clamps to
   * ``[APPROVAL_TIMEOUT_S_MIN, APPROVAL_TIMEOUT_S_MAX]`` at task
   * start; min-wins against per-rule ``@approval_timeout_s`` at
   * gate-firing time.
   */
  readonly approval_timeout_s?: number;
  /**
   * Cedar HITL: pre-approval allowlist scopes from submit time
   * (design §10.2, §7.3 step 4). The engine seeds
   * ``ApprovalAllowlist`` from this list at container start so
   * gates matching any scope here never fire.
   */
  readonly initial_approvals?: readonly string[];
  /**
   * Cedar HITL: running counter of approval gates fired on this
   * task (design §10.2, §13.6). Enforced against
   * ``approvalGateCap`` (decision #13); survives container restart
   * so cumulative damage is bounded across restarts.
   */
  readonly approval_gate_count?: number;
  /**
   * Cedar HITL: per-task cap on total approval gates (design §4 step 5,
   * §13.6, decision #13). Resolved at submit-time from
   * ``Blueprint.security.approvalGateCap ?? 50`` and persisted here so
   * the cap is captured at submit and NOT re-read from the blueprint
   * during a container restart (mid-task blueprint edits must not
   * shift the cap beneath a running task). Bounded to ``[1, 500]``
   * by create-task validation to match the agent-side
   * ``APPROVAL_GATE_CAP_MIN / MAX`` constants in ``agent/src/policy.py``.
   */
  readonly approval_gate_cap?: number;
  /**
   * Cedar HITL: when ``status = AWAITING_APPROVAL``, the
   * ``request_id`` of the pending approval row. Cleared
   * atomically on resume (§10.2, §9).
   */
  readonly awaiting_approval_request_id?: string;
}

/** Per-channel override for one notification channel. See
 *  ``handlers/fanout-task-events.ts::resolveChannelFilter`` for the
 *  resolution semantics — explicit ``events`` REPLACE the channel
 *  default; a ``"default"`` token inside ``events`` expands to the
 *  default set. */
export interface ChannelConfig {
  /** If false, the channel is opted-out and no events dispatch. */
  readonly enabled?: boolean;
  /** Override the subscribed event types. ``["default"]`` resolves to
   *  the channel default; an explicit list replaces defaults entirely. */
  readonly events?: readonly string[];
}

/** Per-task notification overrides (design §6.5). Single source of truth;
 *  imported by both ``TaskRecord`` (producer side) and
 *  ``fanout-task-events.ts`` (consumer side) so a Chunk K schema change
 *  lands in one place and both sides pick it up at compile time. */
export interface TaskNotificationsConfig {
  readonly slack?: ChannelConfig;
  readonly email?: ChannelConfig;
  readonly github?: ChannelConfig;
}

/**
 * Task detail for GET /v1/tasks/{task_id} responses.
 * Strips internal fields not exposed in the API.
 */
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
  /** Provenance of the task's submission — ``api`` for CLI/Cognito
   *  submissions, ``webhook`` for HMAC-signed inbound webhooks. Present
   *  on every task record at creation time (``create-task-core.ts``)
   *  and surfaced here so CLI / dashboard / audit consumers do not have
   *  to spelunk CloudWatch to learn which channel created a task. */
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
  /** Rev-5 DATA-1: SDK-attempted turn count (may exceed `max_turns` by 1
   *  under `agent_status='error_max_turns'`). */
  readonly turns_attempted: number | null;
  /** Rev-5 DATA-1: actually-completed turns, clamped to `max_turns`
   *  when the cap tripped. */
  readonly turns_completed: number | null;
  readonly prompt_version: string | null;
  /** True when the task was submitted with ``--trace`` — surfaces the
   *  opt-in state to scripts / CLI consumers without making them
   *  guess from secondary signals. */
  readonly trace: boolean;
  /** S3 URI of the uploaded ``--trace`` trajectory dump, or ``null``
   *  until the agent finishes the terminal upload (or for tasks that
   *  ran without ``--trace``). Non-optional so scripts can rely on
   *  the field being present; CLI download resolves this via the
   *  ``get-trace-url`` handler rather than hitting S3 directly. */
  readonly trace_s3_uri: string | null;
  readonly attachments: AttachmentSummary[] | null;
  /** Cedar HITL: running counter of approval gates fired on this
   *  task (TaskRecord §10.2, §13.6). Surfaced so CLI / dashboard
   *  consumers can report how many gates a task used without re-
   *  reading the internal TaskRecord. Null when the task predates
   *  the counter or the agent never wrote one. */
  readonly approval_gate_count: number | null;
  /** Cedar HITL: per-task cap on total approval gates (TaskRecord
   *  §4 step 5, §13.6). Captured at submit time from
   *  ``Blueprint.security.approvalGateCap ?? 50``. Null only on
   *  pre-Chunk-7b records. */
  readonly approval_gate_cap: number | null;
  /** Cedar HITL: when ``status = AWAITING_APPROVAL``, the
   *  ``request_id`` of the pending approval row. Null otherwise. */
  readonly awaiting_approval_request_id: string | null;
}

/**
 * Task summary for GET /v1/tasks list responses (subset of fields).
 */
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

/**
 * Task event record as stored in DynamoDB.
 */
export interface EventRecord {
  readonly task_id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly timestamp: string;
  readonly metadata?: Record<string, unknown>;
  readonly ttl?: number;
}

/**
 * Query parameters accepted by ``GET /v1/tasks/{task_id}/events``.
 *
 * Pagination is mutually exclusive: prefer ``after`` (a ULID event_id cursor
 * used by CLI polling and webhook replay to resume from a known event id)
 * over ``next_token`` (an opaque DynamoDB pagination token). If both are
 * provided, the handler uses ``after`` and logs a WARN. Neither is required
 * — callers may start from the beginning of the task's event stream.
 *
 * When a page is truncated at ``limit``, the response includes a
 * ``next_token`` so the caller can continue paginating forward regardless
 * of which mode they started with.
 *
 * Keep in sync with ``cli/src/types.ts``.
 */
export interface GetTaskEventsQuery {
  readonly limit?: number;
  readonly next_token?: string;
  /** ULID event_id cursor. Returns events with ``event_id > after``. */
  readonly after?: string;
  /**
   * When truthy (``"1"`` or ``"true"``), return events in descending
   * ``event_id`` order (newest first). Used by ``bgagent status`` to
   * render a recency-biased snapshot without walking the full event
   * stream. Mutually exclusive with ``after`` — the handler rejects
   * the combination with 400.
   */
  readonly desc?: string;
}

/**
 * Create task request body.
 *
 * Keep in sync with ``cli/src/types.ts``.
 */
export interface CreateTaskRequest {
  readonly repo: string;
  readonly issue_number?: number;
  readonly task_description?: string;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  readonly task_type?: TaskType;
  readonly pr_number?: number;
  readonly attachments?: readonly Attachment[];
  /** Enable 4 KB debug previews (design §10.1, opt-in per task). */
  readonly trace?: boolean;
  /** Cedar HITL: per-task approval timeout (§7.3). Bounded by
   *  ``[APPROVAL_TIMEOUT_S_MIN, APPROVAL_TIMEOUT_S_MAX]``. */
  readonly approval_timeout_s?: number;
  /** Cedar HITL: pre-approved scopes that skip the gate (§7.3 step 4).
   *  Typed as ``ApprovalScope[]`` (the strict union accepted by the
   *  agent's ``parse_approval_scope``); CDK validates the parse result
   *  before forwarding. */
  readonly initial_approvals?: readonly ApprovalScope[];
}

/**
 * Wire format — parsed from untrusted JSON. Validate before use.
 */
export interface Attachment {
  readonly type: AttachmentType;
  readonly content_type?: string;
  readonly data?: string;
  readonly url?: string;
  readonly filename?: string;
  readonly expected_size_bytes?: number;
}

// ---------------------------------------------------------------------------
// Validated attachment types (post-validation discriminated union)
// ---------------------------------------------------------------------------

interface BaseValidatedAttachment {
  readonly filename: string;
  readonly content_type: string;
}

/** Inline image/file: data present, validated, decoded, magic-bytes checked. */
export interface InlineAttachment extends BaseValidatedAttachment {
  readonly delivery: 'inline';
  readonly type: 'image' | 'file';
  readonly data: string;
  readonly url?: never;
  readonly decoded_size_bytes: number;
}

/** Presigned upload: metadata only, no data, no url. */
export interface PresignedAttachment extends BaseValidatedAttachment {
  readonly delivery: 'presigned';
  readonly type: 'image' | 'file';
  readonly data?: never;
  readonly url?: never;
  readonly expected_size_bytes: number;
}

/** URL to fetch during hydration. */
export interface UrlAttachment extends BaseValidatedAttachment {
  readonly delivery: 'url_fetch';
  readonly type: 'url';
  readonly url: string;
  readonly data?: never;
}

/** Output of validateAttachments() — illegal combinations are unrepresentable. */
export type ValidatedAttachment = InlineAttachment | PresignedAttachment | UrlAttachment;

// ---------------------------------------------------------------------------
// Screening result (persisted in DynamoDB as part of AttachmentRecord)
// ---------------------------------------------------------------------------

/** Screening outcome — discriminated union prevents invalid combinations. */
export type ScreeningResult =
  | { readonly status: 'pending' }
  | { readonly status: 'passed'; readonly screened_at: string }
  | { readonly status: 'blocked'; readonly screened_at: string; readonly categories: [string, ...string[]] };

// ---------------------------------------------------------------------------
// Attachment record (persisted metadata in TaskRecord) — discriminated union
// keyed on screening.status ensures that passed records always have storage fields.
// ---------------------------------------------------------------------------

interface BaseAttachmentRecord {
  readonly attachment_id: string;
  readonly type: AttachmentType;
  readonly content_type: string;
  readonly filename: string;
  readonly source_url?: string;
  readonly token_estimate?: number;
}

export interface PendingAttachmentRecord extends BaseAttachmentRecord {
  readonly screening: { readonly status: 'pending' };
  readonly s3_key?: string;
  readonly s3_version_id?: string;
  readonly size_bytes?: number;
  readonly checksum_sha256?: string;
}

export interface PassedAttachmentRecord extends BaseAttachmentRecord {
  readonly screening: { readonly status: 'passed'; readonly screened_at: string };
  readonly s3_key: string;
  readonly s3_version_id: string;
  readonly size_bytes: number;
  readonly checksum_sha256: string;
}

export interface BlockedAttachmentRecord extends BaseAttachmentRecord {
  readonly screening: { readonly status: 'blocked'; readonly screened_at: string; readonly categories: [string, ...string[]] };
  readonly s3_key?: string;
  readonly s3_version_id?: string;
  readonly size_bytes?: number;
  readonly checksum_sha256?: string;
}

export type AttachmentRecord = PendingAttachmentRecord | PassedAttachmentRecord | BlockedAttachmentRecord;

/** Parameters for creating an AttachmentRecord — accepts the union of all fields. */
export type CreateAttachmentRecordParams = {
  readonly attachment_id: string;
  readonly type: AttachmentType;
  readonly content_type: string;
  readonly filename: string;
  readonly s3_key?: string;
  readonly s3_version_id?: string;
  readonly size_bytes?: number;
  readonly screening: ScreeningResult;
  readonly source_url?: string;
  readonly checksum_sha256?: string;
  readonly token_estimate?: number;
};

/**
 * Factory function enforcing cross-field invariants on AttachmentRecord construction.
 * Returns the appropriate discriminated union variant based on screening status.
 */
export function createAttachmentRecord(params: CreateAttachmentRecordParams): AttachmentRecord {
  if (params.screening.status === 'passed') {
    if (!params.s3_key || !params.s3_version_id || !params.checksum_sha256 || !params.size_bytes) {
      throw new Error('Passed screening requires s3_key, s3_version_id, checksum_sha256, and size_bytes');
    }
    return params as PassedAttachmentRecord;
  }
  if (params.screening.status === 'blocked') {
    return params as BlockedAttachmentRecord;
  }
  return params as PendingAttachmentRecord;
}

// ---------------------------------------------------------------------------
// Attachment summary (API response — metadata only, no binary content)
// ---------------------------------------------------------------------------

export interface AttachmentSummary {
  readonly attachment_id: string;
  readonly type: AttachmentType;
  readonly filename: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly screening_status: 'passed' | 'blocked' | 'pending';
}

// ---------------------------------------------------------------------------
// Presigned upload response (returned on PENDING_UPLOADS creation)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Agent attachment payload (orchestrator → agent runtime)
// ---------------------------------------------------------------------------

/** Attachment descriptor sent to the agent runtime. Exported for test assertions. */
export interface AgentAttachmentPayload {
  readonly attachment_id: string;
  readonly type: AttachmentType;
  readonly content_type: string;
  readonly filename: string;
  readonly s3_uri: string;
  readonly s3_version_id: string;
  readonly size_bytes: number;
  readonly source_url?: string;
  readonly token_estimate?: number;
  readonly checksum_sha256: string;
}

/**
 * Map a DynamoDB task record to the API detail response shape.
 *
 * All numeric fields sourced from the DDB record are routed through
 * ``coerceNumericOrNull`` — the Document-client deserializes DynamoDB
 * ``Number`` attributes as JavaScript ``string``s in some code paths
 * (see ``shared/numeric.ts`` for rationale), and any downstream caller
 * doing arithmetic (``.toFixed``, comparison, math) on a string-typed
 * "number" crashes at runtime. Coercing uniformly here means no caller
 * has to guess which TaskDetail numeric fields are safe — do not bypass
 * the helper when adding new numeric fields.
 *
 * @param record - the DynamoDB task record.
 * @returns the API-facing task detail.
 */
export function toTaskDetail(record: TaskRecord): TaskDetail {
  const ctx = { task_id: record.task_id };
  return {
    task_id: record.task_id,
    status: record.status,
    repo: record.repo,
    issue_number: record.issue_number ?? null,
    task_type: record.task_type ?? 'new_task',
    pr_number: record.pr_number ?? null,
    task_description: record.task_description ?? null,
    branch_name: record.branch_name,
    session_id: record.session_id ?? null,
    pr_url: record.pr_url ?? null,
    error_message: record.error_message ?? null,
    error_classification: classifyError(record.error_message),
    channel_source: record.channel_source,
    created_at: record.created_at,
    updated_at: record.updated_at,
    started_at: record.started_at ?? null,
    completed_at: record.completed_at ?? null,
    duration_s: coerceNumericOrNull(record.duration_s, { ...ctx, field: 'duration_s' }, logger),
    cost_usd: coerceNumericOrNull(record.cost_usd, { ...ctx, field: 'cost_usd' }, logger),
    build_passed: record.build_passed ?? null,
    max_turns: coerceNumericOrNull(record.max_turns, { ...ctx, field: 'max_turns' }, logger),
    max_budget_usd: coerceNumericOrNull(record.max_budget_usd, { ...ctx, field: 'max_budget_usd' }, logger),
    turns_attempted: coerceNumericOrNull(record.turns_attempted, { ...ctx, field: 'turns_attempted' }, logger),
    turns_completed: coerceNumericOrNull(record.turns_completed, { ...ctx, field: 'turns_completed' }, logger),
    prompt_version: record.prompt_version ?? null,
    trace: record.trace === true,
    trace_s3_uri: record.trace_s3_uri ?? null,
    attachments: record.attachments
      ? record.attachments.map(a => ({
        attachment_id: a.attachment_id,
        type: a.type,
        filename: a.filename,
        content_type: a.content_type,
        size_bytes: a.size_bytes ?? 0, // 0 for pending attachments (size unknown until resolved)
        screening_status: a.screening.status,
      }))
      : null,
    approval_gate_count: coerceNumericOrNull(
      record.approval_gate_count,
      { ...ctx, field: 'approval_gate_count' },
      logger,
    ),
    approval_gate_cap: coerceNumericOrNull(
      record.approval_gate_cap,
      { ...ctx, field: 'approval_gate_cap' },
      logger,
    ),
    awaiting_approval_request_id: record.awaiting_approval_request_id ?? null,
  };
}

/**
 * Maximum length (in characters, after trim) of a nudge ``message``.
 *
 * Mirrored in ``cli/src/types.ts`` as ``NUDGE_MAX_MESSAGE_LENGTH`` and
 * consumed both client-side (for fail-fast rejection without a round-trip)
 * and server-side (in ``cdk/src/handlers/nudge-task.ts``).
 */
export const NUDGE_MAX_MESSAGE_LENGTH = 2000;

/**
 * Nudge request body for POST /v1/tasks/{task_id}/nudge (Phase 2).
 *
 * A nudge is a short, between-turns steering message from the user to a
 * running agent. It is written to `TaskNudgesTable` after guardrail
 * screening + rate limiting, then picked up by the agent's nudge_reader
 * at the next between-turns seam and injected as an authoritative
 * `<user_nudge>` XML block.
 *
 * Keep in sync with `cli/src/types.ts`.
 */
export interface NudgeRequest {
  /** Free-text steering message. Max 2000 chars after trim; guardrail-screened. */
  readonly message: string;
}

/**
 * Nudge response body. Returned with HTTP 202 Accepted — the nudge has
 * been persisted but has not yet reached the agent; it will be injected
 * at the next between-turns seam. Callers wanting confirmation that the
 * agent saw the nudge should watch task events for `nudge_consumed`.
 */
export interface NudgeResponse {
  readonly task_id: string;
  readonly nudge_id: string;
  readonly submitted_at: string;
}

/**
 * Full nudge record as stored in `TaskNudgesTable`.
 *
 * - PK = `task_id` (groups all nudges for a task together)
 * - SK = `nudge_id` (ULID — lexicographic sort == chronological sort)
 *
 * The agent-side reader queries by `task_id` with `consumed = false`
 * filter, orders by `nudge_id` (implicit sort-key order), and marks
 * each consumed nudge with an atomic conditional UpdateItem
 * (ConditionExpression: `consumed = :false`) for idempotency across
 * restarts mid-consume.
 */
export interface NudgeRecord {
  readonly task_id: string;
  readonly nudge_id: string;
  readonly user_id: string;
  readonly message: string;
  readonly created_at: string;
  readonly consumed: boolean;
  readonly consumed_at?: string;
  readonly ttl?: number;
}

/**
 * Full webhook record as stored in DynamoDB.
 */
export interface WebhookRecord {
  readonly webhook_id: string;
  readonly user_id: string;
  readonly name: string;
  readonly status: 'active' | 'revoked';
  readonly created_at: string;
  readonly updated_at: string;
  readonly revoked_at?: string;
  readonly ttl?: number;
}

/**
 * Webhook detail for API responses.
 */
export interface WebhookDetail {
  readonly webhook_id: string;
  readonly name: string;
  readonly status: 'active' | 'revoked';
  readonly created_at: string;
  readonly updated_at: string;
  readonly revoked_at: string | null;
}

/**
 * Create webhook request body.
 */
export interface CreateWebhookRequest {
  readonly name: string;
}

/**
 * Create webhook response — includes the secret (shown only once).
 */
export interface CreateWebhookResponse {
  readonly webhook_id: string;
  readonly name: string;
  readonly secret: string;
  readonly created_at: string;
}

/**
 * Map a DynamoDB webhook record to the API detail response shape.
 * @param record - the DynamoDB webhook record.
 * @returns the API-facing webhook detail.
 */
export function toWebhookDetail(record: WebhookRecord): WebhookDetail {
  return {
    webhook_id: record.webhook_id,
    name: record.name,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    revoked_at: record.revoked_at ?? null,
  };
}

/**
 * Map a DynamoDB task record to the API summary response shape.
 * @param record - the DynamoDB task record.
 * @returns the API-facing task summary.
 */
export function toTaskSummary(record: TaskRecord): TaskSummary {
  return {
    task_id: record.task_id,
    status: record.status,
    repo: record.repo,
    issue_number: record.issue_number ?? null,
    task_type: record.task_type ?? 'new_task',
    pr_number: record.pr_number ?? null,
    task_description: record.task_description ?? null,
    branch_name: record.branch_name,
    pr_url: record.pr_url ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Cedar HITL approval types (design §7, §10.1)
// ---------------------------------------------------------------------------

/**
 * Scope of an approval grant. Narrowed from `string` so the approve
 * handler + CLI can exhaustiveness-check the union on parse.
 *
 * - `this_call`          — one-shot. Does NOT grow the allowlist.
 * - `tool_type_session`  — allow any further invocation of the same tool name
 *                          for the rest of the session.
 * - `tool_group_session` — allow any tool in the matching tool group
 *                          (currently `file_write` → Write/Edit).
 * - `bash_pattern:...`   — allow Bash commands matching the pattern (fnmatch).
 * - `write_path:...`     — allow Write/Edit against paths matching the pattern.
 * - `rule:<rule_id>`     — allow soft-deny hits whose rule_id matches.
 * - `all_session`        — allow anything for the rest of the session. Gated
 *                          by blueprint `maxPreApprovalScope` (§7.5).
 *
 * Keep in sync with ``cli/src/types.ts``.
 */
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

/**
 * Approval row status values. PENDING is the only non-terminal state —
 * every other transition is final, which matches the
 * `ConditionExpression: status = :pending` guard on every mutator.
 */
export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'DENIED'
  | 'TIMED_OUT'
  | 'STRANDED';

/**
 * Cedar HITL severity, surfaced in the CLI approval prompt and used
 * for severity-gated channel routing (§11.2: high-severity rules
 * skip Slack-button auto-approval). Shared alias so the same literal
 * union is not redefined inline in `ApprovalRecord`,
 * `PendingApprovalSummary`, `PolicyRuleSummary`, etc.
 */
export type Severity = 'low' | 'medium' | 'high';

/**
 * Fields shared by every approval row regardless of status. Internal
 * type — callers should consume the discriminated {@link ApprovalRecord}
 * so `status` narrows the optional fields below.
 *
 * PK = `task_id`, SK = `request_id` (ULID minted by the agent). GSI
 * `user_id-status-index` powers `GET /v1/pending` without a Scan.
 *
 * `matching_rule_ids` is a List, not a StringSet — DDB string sets
 * cannot be empty and pathological no-match soft-deny hits would fail
 * to persist (§10.1).
 */
interface ApprovalRecordBase {
  readonly task_id: string;
  readonly request_id: string;
  readonly tool_name: string;
  readonly tool_input_preview: string;
  readonly tool_input_sha256: string;
  readonly reason: string;
  readonly severity: Severity;
  readonly matching_rule_ids: readonly string[];
  readonly created_at: string;
  readonly timeout_s: number;
  readonly ttl: number;
  readonly user_id: string;
  readonly repo: string;
}

/** PENDING approval row — no decision recorded yet. */
export interface PendingApprovalRecord extends ApprovalRecordBase {
  readonly status: 'PENDING';
}

/** APPROVED approval row — decided_at + scope are required. */
export interface ApprovedApprovalRecord extends ApprovalRecordBase {
  readonly status: 'APPROVED';
  readonly decided_at: string;
  readonly scope: ApprovalScope;
}

/** DENIED approval row — decided_at required, deny_reason optional. */
export interface DeniedApprovalRecord extends ApprovalRecordBase {
  readonly status: 'DENIED';
  readonly decided_at: string;
  readonly deny_reason?: string;
}

/** TIMED_OUT approval row — decided_at required (server-set). */
export interface TimedOutApprovalRecord extends ApprovalRecordBase {
  readonly status: 'TIMED_OUT';
  readonly decided_at: string;
}

/** STRANDED approval row — decided_at required (set by the
 *  stranded-task reconciler). No user decision was ever recorded. */
export interface StrandedApprovalRecord extends ApprovalRecordBase {
  readonly status: 'STRANDED';
  readonly decided_at: string;
}

/**
 * Full approval row as stored in `TaskApprovalsTable` (design §10.1).
 *
 * Discriminated union on ``status`` so callers can narrow on the
 * status field and get exhaustiveness checking on the optional
 * decision fields. Pre-S3 this was a single interface with every
 * decision-time field optional, which let illegal combinations
 * type-check (e.g. an APPROVED record without a `scope`).
 */
export type ApprovalRecord =
  | PendingApprovalRecord
  | ApprovedApprovalRecord
  | DeniedApprovalRecord
  | TimedOutApprovalRecord
  | StrandedApprovalRecord;

/**
 * Pending approval summary returned by `GET /v1/pending` (§7.7).
 * Derived from the GSI projection attributes only — keeps the list
 * response cheap and avoids leaking `deny_reason` / `tool_input_sha256`
 * on PENDING rows.
 */
export interface PendingApprovalSummary {
  readonly task_id: string;
  readonly request_id: string;
  readonly tool_name: string;
  readonly tool_input_preview: string;
  readonly severity: Severity;
  readonly reason: string;
  readonly created_at: string;
  readonly timeout_s: number;
  /** Derived: `created_at + timeout_s` in ISO 8601 UTC. */
  readonly expires_at: string;
  /** Cedar rule ids that matched this request (design §10.1). Surfaced
   *  so `bgagent pending` can show _why_ a gate fired without the user
   *  spelunking TaskEventsTable. Empty array on pre-Cedar-HITL rows. */
  readonly matching_rule_ids: readonly string[];
}

/**
 * `POST /v1/tasks/{task_id}/approve` request body (§7.1).
 *
 * `scope` is optional — defaults to `this_call` when omitted.
 *
 * Keep in sync with ``cli/src/types.ts``.
 */
export interface ApprovalRequest {
  readonly request_id: string;
  readonly decision: 'approve';
  readonly scope?: ApprovalScope;
}

/**
 * `POST /v1/tasks/{task_id}/approve` response body.
 */
export interface ApprovalResponse {
  readonly task_id: string;
  readonly request_id: string;
  readonly status: 'APPROVED';
  readonly scope: ApprovalScope;
  readonly decided_at: string;
}

/**
 * `POST /v1/tasks/{task_id}/deny` request body (§7.2).
 *
 * `reason` is passed through `output_scanner.scanDenyReason` before
 * persistence — user-facing secrets (AWS keys, GitHub PATs, API tokens)
 * are redacted with `[REDACTED-...]` markers. Truncated to
 * `DENY_REASON_MAX_LENGTH` chars AFTER scanning.
 *
 * Keep in sync with ``cli/src/types.ts``.
 */
export interface DenyRequest {
  readonly request_id: string;
  readonly decision: 'deny';
  readonly reason?: string;
}

/**
 * `POST /v1/tasks/{task_id}/deny` response body.
 */
export interface DenyResponse {
  readonly task_id: string;
  readonly request_id: string;
  readonly status: 'DENIED';
  readonly decided_at: string;
}

/**
 * Maximum length of a sanitized deny reason after `output_scanner`
 * redaction (§7.2 step 3). Matches the Phase 2 nudge limit for
 * consistency.
 */
export const DENY_REASON_MAX_LENGTH = 2000;

/**
 * Rule metadata returned by `GET /v1/repos/{repo}/policies` (§7.6).
 * `approval_timeout_s` and `severity` are absent for hard-deny rules.
 */
export interface PolicyRuleSummary {
  readonly rule_id: string;
  readonly category?: string;
  readonly severity?: Severity;
  readonly approval_timeout_s?: number;
  readonly summary: string;
}

/**
 * `GET /v1/repos/{repo_id}/policies` response body.
 */
export interface GetPoliciesResponse {
  readonly repo_id: string;
  readonly policies: {
    readonly hard: readonly PolicyRuleSummary[];
    readonly soft: readonly PolicyRuleSummary[];
  };
}

/**
 * `GET /v1/pending` response body (§7.7).
 */
export interface GetPendingResponse {
  readonly pending: readonly PendingApprovalSummary[];
}

/**
 * Lambda-written audit event type for an approve/deny decision
 * (IMPL-6). Emitted to TaskEventsTable so the 90-day audit trail does
 * not depend on the agent's best-effort milestone.
 */
export interface ApprovalDecisionRecordedEvent {
  readonly request_id: string;
  readonly status: 'APPROVED' | 'DENIED';
  readonly scope?: ApprovalScope;
  readonly reason?: string;
  readonly decided_at: string;
  readonly caller_user_id: string;
}

/**
 * `CreateTaskRequest` extensions for HITL pre-approvals (§7.3).
 *
 * Old callers continue to work — every field is optional. New callers
 * can pre-approve common scopes (`tool_type:Read`, `bash_pattern:git
 * status*`) to avoid hitting gates for trusted operations, and can
 * raise the per-task default approval timeout above the 300s default
 * within the `[30, min(3600, maxLifetime - 300)]` bound.
 *
 * Keep in sync with ``cli/src/types.ts``.
 */
export interface CreateTaskApprovalExtensions {
  readonly approval_timeout_s?: number;
  readonly initial_approvals?: readonly ApprovalScope[];
}

/** Maximum `initial_approvals` entries per §7.3. */
export const INITIAL_APPROVALS_MAX_ENTRIES = 20;

/** Maximum per-entry length for an `initial_approvals` scope string. */
export const INITIAL_APPROVALS_MAX_ENTRY_LENGTH = 128;

/** Floor for `approval_timeout_s` (§6 decision #6). */
export const APPROVAL_TIMEOUT_S_MIN = 30;

/** Absolute ceiling for `approval_timeout_s` before the
 *  `maxLifetime - 300` clip is applied (§7.3). */
export const APPROVAL_TIMEOUT_S_MAX = 3600;

/** Default `approval_timeout_s` when the submit payload omits it. */
export const APPROVAL_TIMEOUT_S_DEFAULT = 300;

/**
 * Cedar HITL: bounds + platform default for the per-task approval-gate cap
 * (design decision #13, §4 step 5). Blueprints may override via
 * ``security.approvalGateCap``; the submit path bounds-checks the
 * resolved value against these constants so an out-of-bounds blueprint
 * never persists a bad cap onto a TaskRecord.
 *
 * Sourced from ``contracts/constants.json`` (S9 — see
 * ``contracts/constants.md``). The same JSON is read by
 * ``agent/src/policy.py`` at import; the drift check
 * (``scripts/check-types-sync.ts``) verifies no other site declares
 * these constants as literals.
 */
export const APPROVAL_GATE_CAP_MIN = sharedConstants.approval_gate_cap.min;
export const APPROVAL_GATE_CAP_MAX = sharedConstants.approval_gate_cap.max;
export const APPROVAL_GATE_CAP_DEFAULT = sharedConstants.approval_gate_cap.default;
