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
  readonly prompt_version?: string;
  readonly memory_written?: boolean;
  readonly compute_type?: ComputeType;
  readonly compute_metadata?: Record<string, string>;
  readonly ttl?: number;
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
  readonly prompt_version: string | null;
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
 * used by the SSE client to catch up after a disconnect) over ``next_token``
 * (an opaque DynamoDB pagination token). If both are provided, the handler
 * uses ``after`` and logs a WARN. Neither is required — callers may start
 * from the beginning of the task's event stream.
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
}

/**
 * How a task's pipeline should be executed (rev 5, §9.13).
 *
 * - `'orchestrator'` (default, Phase 1a behaviour): the CreateTask Lambda
 *   async-invokes the orchestrator, which calls Runtime-IAM. The pipeline
 *   runs on Runtime-IAM independent of any live watcher. This is the only
 *   correct choice for non-interactive channels (webhook, Slack, cron).
 * - `'interactive'` (rev 5 Branch A Path 1): the CreateTask Lambda SKIPS
 *   the orchestrator invoke. The caller is expected to immediately open an
 *   SSE connection to Runtime-JWT's /invocations with the returned task_id,
 *   so the pipeline runs same-process with the stream (real-time). If no
 *   SSE connection is established, the task stays in PENDING and is
 *   eventually cleaned up by the concurrency reconciler.
 *
 * Only the Cognito-authed API path accepts `'interactive'`. The webhook
 * path (no live watcher by definition) rejects it with 400.
 */
export type ExecutionMode = 'orchestrator' | 'interactive';

/**
 * Create task request body.
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
  readonly execution_mode?: ExecutionMode;
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
    prompt_version: record.prompt_version ?? null,
  };
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
