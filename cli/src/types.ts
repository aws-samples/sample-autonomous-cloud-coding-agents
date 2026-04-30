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
  readonly status: string;
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
  /** Rev-5 DATA-1: attempts counter from the SDK (may be `max_turns + 1`
   *  when `agent_status='error_max_turns'` — the aborted attempt is
   *  counted). */
  readonly turns_attempted?: number | null;
  /** Rev-5 DATA-1: turns that actually completed (clamped to
   *  `max_turns` when the cap tripped). */
  readonly turns_completed?: number | null;
}

/** Task summary returned by GET /v1/tasks list responses. */
export interface TaskSummary {
  readonly task_id: string;
  readonly status: string;
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

/** Create task request body for POST /v1/tasks. */
export interface CreateTaskRequest {
  readonly repo: string;
  readonly issue_number?: number;
  readonly task_description?: string;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  readonly task_type?: TaskType;
  readonly pr_number?: number;
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
  readonly status: string;
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
