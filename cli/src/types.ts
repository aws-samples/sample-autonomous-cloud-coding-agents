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
  /**
   * Execution mode recorded at task creation (rev 5, §9.13.4). Watch uses
   * this to pick the correct transport: `'orchestrator'` (or `null` for
   * legacy tasks) → polling; `'interactive'` → SSE.
   *
   * The server-side `toTaskDetail` always sets this field (including
   * `null` for legacy rows), so the shape is `ExecutionMode | null`, not
   * optional. Matches CDK's `TaskDetail` definition exactly.
   */
  readonly execution_mode: ExecutionMode | null;
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
 * cursor used by the SSE client to catch up after a disconnect. Keep in sync
 * with ``cdk/src/handlers/shared/types.ts``.
 */
export interface GetTaskEventsQuery {
  readonly limit?: number;
  readonly next_token?: string;
  readonly after?: string;
}

/**
 * Execution mode for a submitted task (rev 5, §9.13).
 *
 * - `'orchestrator'` (default): Lambda fires the orchestrator, pipeline
 *   runs on Runtime-IAM. Non-interactive channels use this.
 * - `'interactive'`: Lambda SKIPS the orchestrator. Caller MUST open SSE
 *   to Runtime-JWT to run the pipeline same-process with the stream.
 */
export type ExecutionMode = 'orchestrator' | 'interactive';

/** Create task request body for POST /v1/tasks. */
export interface CreateTaskRequest {
  readonly repo: string;
  readonly issue_number?: number;
  readonly task_description?: string;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  readonly task_type?: TaskType;
  readonly pr_number?: number;
  readonly execution_mode?: ExecutionMode;
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

/**
 * Closed union of well-known API error codes (rev-5 TDA-3).
 *
 * Used by the SSE data-plane's direct responses (not the REST envelope
 * above) where server.py on Runtime-JWT emits ad-hoc JSON on non-2xx.
 * KEEP IN SYNC with the matching union in
 * `cdk/src/handlers/shared/types.ts` and the string constants in
 * `agent/src/server.py`.
 */
export type ApiErrorCode =
  | 'RUN_ELSEWHERE'
  | 'TASK_STATE_UNAVAILABLE'
  | 'SSE_ATTACH_RACE'
  | 'TASK_RECORD_INCOMPLETE';

/**
 * Typed envelope for SSE data-plane error bodies. `details` holds
 * code-specific extras (e.g. RUN_ELSEWHERE's `execution_mode`, or
 * TASK_RECORD_INCOMPLETE's `missing` array).
 */
export interface ApiErrorBody<C extends ApiErrorCode = ApiErrorCode> {
  readonly code: C;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  // Flattened convenience fields for backwards-compat — legacy bodies
  // emit these at the top level rather than under `details`.
  readonly execution_mode?: ExecutionMode;
  readonly missing?: readonly string[];
}

/**
 * Type guard for an `ApiErrorBody` with a specific code. Use in
 * `sse-client.ts`'s 409/503/500 branches to narrow the parsed body.
 */
export function isApiError<C extends ApiErrorCode>(
  body: unknown,
  code: C,
): body is ApiErrorBody<C> {
  return (
    body !== null
    && typeof body === 'object'
    && (body as { code?: unknown }).code === code
  );
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

/** CLI config stored in ~/.bgagent/config.json.
 *
 *  ``runtime_jwt_arn`` is optional (introduced by Phase 1b Step 6 for the SSE
 *  ``bgagent watch`` transport). Old config.json files without this field are
 *  backward-compatible — `--transport auto` degrades to polling when missing,
 *  `--transport sse` errors out with a pointer to ``bgagent configure``.
 */
export interface CliConfig {
  readonly api_url: string;
  readonly region: string;
  readonly user_pool_id: string;
  readonly client_id: string;
  readonly runtime_jwt_arn?: string;
}

/** Cached credentials stored in ~/.bgagent/credentials.json.
 *
 * Both Cognito-issued tokens are cached. The **access token** is what we send
 * on the Authorization header because AgentCore Runtime's Cognito JWT
 * authorizer validates `client_id` (present on access tokens, not ID tokens).
 * API Gateway's Cognito authorizer accepts either by default, so the REST
 * path is unaffected. The ID token is retained for introspection / debugging
 * and for potential future features that need user identity claims. Older
 * credentials files without `access_token` are tolerated — `getAuthToken`
 * falls back to `id_token` and logs a WARN so the user knows to re-login.
 */
export interface Credentials {
  readonly id_token: string;
  readonly access_token?: string;
  readonly refresh_token: string;
  readonly token_expiry: string;
}

/** Terminal task statuses. */
export const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const;
