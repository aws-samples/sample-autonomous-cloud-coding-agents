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
import type { ComputeType } from './repo-config';
import type { TaskStatusType } from '../../constructs/task-status';

/** Valid task types for task creation. */
export type TaskType = 'new_task' | 'pr_iteration' | 'pr_review';

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
  readonly channel_source: string;
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
  readonly attachments?: Attachment[];
  /** Enable 4 KB debug previews (design §10.1, opt-in per task). */
  readonly trace?: boolean;
}

/**
 * Attachment in create task request.
 */
export interface Attachment {
  readonly type: 'image' | 'file' | 'url';
  readonly content_type?: string;
  readonly data?: string;
  readonly url?: string;
  readonly filename?: string;
}

/**
 * Map a DynamoDB task record to the API detail response shape.
 * @param record - the DynamoDB task record.
 * @returns the API-facing task detail.
 */
export function toTaskDetail(record: TaskRecord): TaskDetail {
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
    created_at: record.created_at,
    updated_at: record.updated_at,
    started_at: record.started_at ?? null,
    completed_at: record.completed_at ?? null,
    duration_s: record.duration_s ?? null,
    cost_usd: record.cost_usd ?? null,
    build_passed: record.build_passed ?? null,
    max_turns: record.max_turns ?? null,
    max_budget_usd: record.max_budget_usd ?? null,
    turns_attempted: record.turns_attempted ?? null,
    turns_completed: record.turns_completed ?? null,
    prompt_version: record.prompt_version ?? null,
    trace: record.trace === true,
    trace_s3_uri: record.trace_s3_uri ?? null,
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
