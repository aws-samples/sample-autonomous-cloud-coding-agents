# API Contract

This document defines the **external API contract** for the background agents platform. It specifies the endpoints, request/response schemas, error format, authentication, pagination, and rate limiting. Current channels (CLI and webhook integrations) interact with the platform through this API, mediated by the [input gateway](./INPUT_GATEWAY.md).

This is a **design-level** specification, not an OpenAPI file. Implementation may generate an OpenAPI spec from the CDK API Gateway definition; this document is the source of truth for the contract.

## At a glance

- **Use this doc for:** endpoint paths, payload shapes, auth requirements, and error codes.
- **Current channels:** CLI and webhook integrations.
- **Not in scope here:** internal orchestration internals (see [ORCHESTRATOR.md](./ORCHESTRATOR.md)).

**Relationship to other docs:**
- [INPUT_GATEWAY.md](./INPUT_GATEWAY.md) — describes the gateway's role (normalize, validate, dispatch) and the conceptual internal message/notification schemas.
- [ORCHESTRATOR.md](./ORCHESTRATOR.md) — defines the task state machine, data model, and lifecycle that this API exposes.
- [SECURITY.md](./SECURITY.md) — authentication and authorization model.

---

## Base URL and versioning

| Environment | Base URL |
|---|---|
| Production | `https://{api-id}.execute-api.{region}.amazonaws.com/v1` |
| Custom domain | `https://api.{customer-domain}/v1` |

API versioning uses a **path prefix** (`/v1`). Breaking changes increment the version (`/v2`). Non-breaking additions (new optional fields, new endpoints) do not require a version bump.

---

## Authentication

All endpoints require authentication. The API supports multiple authentication methods depending on the channel:

| Channel | Auth method | Header | Endpoint scope |
|---|---|---|---|
| CLI / REST API | Cognito JWT (ID token) | `Authorization: Bearer <token>` | All `/tasks` and `/webhooks` management endpoints |
| Webhook | HMAC-SHA256 signature | `X-Webhook-Id` + `X-Webhook-Signature: sha256=<hex>` | `POST /v1/webhooks/tasks` only |

The gateway extracts the **platform user ID** (`user_id`) from the authenticated identity (Cognito `sub` for JWT, or webhook record lookup for HMAC) and attaches it to all internal messages. Downstream services never see raw tokens or secrets.

---

## Common conventions

### Request format

- Content type: `application/json`
- Character encoding: UTF-8
- Maximum request body size: 1 MB (configurable)

### Response format

All successful responses return:

```json
{
  "data": { ... }
}
```

List endpoints return:

```json
{
  "data": [ ... ],
  "pagination": {
    "next_token": "...",
    "has_more": true
  }
}
```

### Error format

All errors return a consistent structure:

```json
{
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "Task abc-123 not found.",
    "request_id": "req-uuid-here"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `code` | String | Machine-readable error code (see Error codes section). |
| `message` | String | Human-readable description. |
| `request_id` | String | Unique request ID for tracing and support. Also returned in the `X-Request-Id` response header. |

### Standard response headers

| Header | Description |
|---|---|
| `X-Request-Id` | Unique request ID (ULID). Present on all responses. |
| `X-RateLimit-Limit` | Requests allowed per window (see Rate limiting). |
| `X-RateLimit-Remaining` | Requests remaining in current window. |
| `X-RateLimit-Reset` | Unix timestamp when the window resets. |

### Idempotency

Clients may include an `Idempotency-Key` header on `POST` requests. If a request with the same key was already processed (within a 24-hour TTL), the API returns the original response without creating a duplicate resource. See [ORCHESTRATOR.md](./ORCHESTRATOR.md) — Admission control for the implementation.

---

## Endpoints

### Create task

Creates a new task. The orchestrator runs admission control, context hydration, and starts the agent session.

```
POST /v1/tasks
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `repo` | String | Yes | GitHub repository in `owner/repo` format. |
| `issue_number` | Number | No | GitHub issue number. If provided, the issue title, body, and comments are fetched during context hydration. |
| `task_description` | String | No | Free-text task description. At least one of `issue_number`, `task_description`, or `pr_number` must be provided. |
| `task_type` | String | No | Task type: `new_task` (default), `pr_iteration`, or `pr_review`. When `pr_iteration`, the agent iterates on an existing PR. When `pr_review`, the agent performs a read-only review and posts structured comments. |
| `pr_number` | Number | No | Pull request number to iterate on or review. Required when `task_type` is `pr_iteration` or `pr_review`; rejected otherwise. For `pr_iteration`, the agent checks out the PR's branch, reads review feedback, addresses it, and pushes back. For `pr_review`, the agent checks out the PR's branch, analyzes changes read-only, and posts a structured review. |
| `max_turns` | Number | No | Maximum agent turns (1–500). Controls how many reasoning/tool-call iterations the agent can perform. Defaults to 100 if omitted. |
| `max_budget_usd` | Number | No | Maximum cost budget in USD (0.01–100). When reached, the agent stops regardless of remaining turns. If omitted, no budget limit is applied (turn limit and session timeout still apply). |
| `attachments` | Array | No | Multi-modal attachments (images, files). See Attachments schema below. |

**Attachments schema:**

```json
{
  "attachments": [
    {
      "type": "image",
      "content_type": "image/png",
      "data": "<base64-encoded>",
      "filename": "screenshot.png"
    },
    {
      "type": "url",
      "url": "https://example.com/spec.pdf"
    }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | String | Yes | `image`, `file`, or `url`. |
| `content_type` | String | No | MIME type (for inline data). |
| `data` | String | No | Base64-encoded content (for inline uploads). Max 10 MB per attachment after decoding. |
| `url` | String | No | URL to fetch (for URL-based attachments). |
| `filename` | String | No | Original filename (for display and logging). |

**Request headers:**

| Header | Required | Description |
|---|---|---|
| `Authorization` | Yes | Bearer token. |
| `Idempotency-Key` | No | Client-supplied idempotency key (string, max 128 chars). |

**Response: `201 Created`**

```json
{
  "data": {
    "task_id": "01HYX...",
    "status": "SUBMITTED",
    "repo": "org/myapp",
    "task_type": "new_task",
    "issue_number": 42,
    "pr_number": null,
    "branch_name": "bgagent/01HYX.../fix-auth-bug",
    "created_at": "2025-03-15T10:30:00Z"
  }
}
```

For `pr_iteration` and `pr_review` tasks, `branch_name` is initially set to `pending:pr_resolution` and resolved to the PR's `head_ref` during context hydration.

**Error responses:**

| Status | Code | Condition |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Missing required fields, invalid repo format, no task description or issue or PR number, invalid `task_type`, `pr_number` provided without `task_type: 'pr_iteration'` or `'pr_review'`, `pr_number` missing when `task_type` is `pr_iteration` or `pr_review`, invalid `max_turns` (not an integer or outside 1–500 range), invalid `max_budget_usd` (not a number or outside 0.01–100 range). |
| `401` | `UNAUTHORIZED` | Missing or invalid auth token. |
| `409` | `DUPLICATE_TASK` | Idempotency key matches an existing task (returns the existing task in `data`). |
| `422` | `REPO_NOT_ONBOARDED` | Repository is not registered with the platform. Repos are onboarded via CDK deployment (`Blueprint` construct), not via a runtime API. See [REPO_ONBOARDING.md](./REPO_ONBOARDING.md). |
| `429` | `RATE_LIMIT_EXCEEDED` | User exceeded the per-user rate limit. |

---

### Get task

Returns the full details of a single task. Users can only access their own tasks.

```
GET /v1/tasks/{task_id}
```

**Path parameters:**

| Parameter | Type | Description |
|---|---|---|
| `task_id` | String | Task identifier (ULID). |

**Response: `200 OK`**

```json
{
  "data": {
    "task_id": "01HYX...",
    "status": "RUNNING",
    "repo": "org/myapp",
    "task_type": "new_task",
    "issue_number": 42,
    "pr_number": null,
    "task_description": "Fix the authentication bug in the login flow",
    "branch_name": "bgagent/01HYX.../fix-auth-bug",
    "session_id": "sess-uuid",
    "pr_url": null,
    "error_message": null,
    "created_at": "2025-03-15T10:30:00Z",
    "updated_at": "2025-03-15T10:31:15Z",
    "started_at": "2025-03-15T10:31:10Z",
    "completed_at": null,
    "duration_s": null,
    "cost_usd": null,
    "build_passed": null,
    "max_turns": 100,
    "max_budget_usd": null
  }
}
```

| Field | Type | Description |
|---|---|---|
| `task_type` | String | Task type: `new_task`, `pr_iteration`, or `pr_review`. |
| `pr_number` | Number or null | Pull request number being iterated on or reviewed. Only set for `pr_iteration` and `pr_review` tasks. |
| `max_turns` | Number or null | Maximum agent turns for this task. Always present in the response — reflects the effective value (user-specified or platform default of 100). |
| `max_budget_usd` | Number or null | Maximum cost budget in USD for this task. Null if no budget limit was specified. |

**Error responses:**

| Status | Code | Condition |
|---|---|---|
| `401` | `UNAUTHORIZED` | Missing or invalid auth token. |
| `403` | `FORBIDDEN` | Task belongs to a different user. |
| `404` | `TASK_NOT_FOUND` | Task does not exist. |

---

### List tasks

Returns tasks for the authenticated user, with optional filters. Paginated.

```
GET /v1/tasks
```

**Query parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `status` | String | No | (all) | Filter by status: `SUBMITTED`, `HYDRATING`, `RUNNING`, `FINALIZING`, `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`. Comma-separated for multiple (e.g. `RUNNING,HYDRATING`). |
| `repo` | String | No | (all) | Filter by repository (`owner/repo`). |
| `limit` | Number | No | 20 | Page size (1–100). |
| `next_token` | String | No | (none) | Pagination token from a previous response. |

**Response: `200 OK`**

```json
{
  "data": [
    {
      "task_id": "01HYX...",
      "status": "RUNNING",
      "repo": "org/myapp",
      "task_type": "new_task",
      "issue_number": 42,
      "pr_number": null,
      "task_description": "Fix the authentication bug...",
      "branch_name": "bgagent/01HYX.../fix-auth-bug",
      "pr_url": null,
      "created_at": "2025-03-15T10:30:00Z",
      "updated_at": "2025-03-15T10:31:15Z"
    }
  ],
  "pagination": {
    "next_token": "eyJsYXN0...",
    "has_more": true
  }
}
```

The list response returns a **summary** (subset of fields). Use `GET /v1/tasks/{task_id}` for full details.

**Error responses:**

| Status | Code | Condition |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Invalid status value, invalid limit, invalid next_token. |
| `401` | `UNAUTHORIZED` | Missing or invalid auth token. |

---

### Cancel task

Cancels a running task. See [ORCHESTRATOR.md](./ORCHESTRATOR.md) — Cancellation behavior by state for what happens in each state.

```
DELETE /v1/tasks/{task_id}
```

**Path parameters:**

| Parameter | Type | Description |
|---|---|---|
| `task_id` | String | Task identifier (ULID). |

**Response: `200 OK`**

```json
{
  "data": {
    "task_id": "01HYX...",
    "status": "CANCELLED",
    "cancelled_at": "2025-03-15T11:00:00Z"
  }
}
```

**Error responses:**

| Status | Code | Condition |
|---|---|---|
| `401` | `UNAUTHORIZED` | Missing or invalid auth token. |
| `403` | `FORBIDDEN` | Task belongs to a different user. |
| `404` | `TASK_NOT_FOUND` | Task does not exist. |
| `409` | `TASK_ALREADY_TERMINAL` | Task is already in a terminal state (`COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`). |

---

### Get task events

Returns the audit trail for a task (state transitions, key events). Useful for debugging.

```
GET /v1/tasks/{task_id}/events
```

**Path parameters:**

| Parameter | Type | Description |
|---|---|---|
| `task_id` | String | Task identifier (ULID). |

**Query parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `limit` | Number | No | 50 | Page size (1–100). |
| `next_token` | String | No | (none) | Pagination token. |

**Response: `200 OK`**

```json
{
  "data": [
    {
      "event_id": "01HYX...",
      "event_type": "task_created",
      "timestamp": "2025-03-15T10:30:00Z",
      "metadata": {}
    },
    {
      "event_id": "01HYX...",
      "event_type": "admission_passed",
      "timestamp": "2025-03-15T10:30:01Z",
      "metadata": { "queue_position": 0 }
    },
    {
      "event_id": "01HYX...",
      "event_type": "session_started",
      "timestamp": "2025-03-15T10:31:10Z",
      "metadata": { "session_id": "sess-uuid" }
    }
  ],
  "pagination": {
    "next_token": null,
    "has_more": false
  }
}
```

**Event types** (see [OBSERVABILITY.md](./OBSERVABILITY.md) for the full list):

**Fixed event types:** `task_created`, `admission_passed`, `admission_rejected`, `preflight_failed`, `hydration_started`, `hydration_complete`, `session_started`, `session_ended`, `pr_created`, `pr_updated`, `task_completed`, `task_failed`, `task_cancelled`, `task_timed_out`

**Step-level event types** (from the blueprint framework): The orchestrator emits events for each pipeline step following the pattern `{step_name}_{started|completed|failed}`. For built-in steps these overlap with the fixed types above (e.g. `hydration_started`). For custom Lambda steps (see [REPO_ONBOARDING.md](./REPO_ONBOARDING.md)), the step name is user-defined (e.g. `sast-scan_started`, `sast-scan_completed`, `prepare-environment_failed`). Step event `metadata` includes `StepOutput.metadata` from the step execution.

**Error responses:**

| Status | Code | Condition |
|---|---|---|
| `401` | `UNAUTHORIZED` | Missing or invalid auth token. |
| `403` | `FORBIDDEN` | Task belongs to a different user. |
| `404` | `TASK_NOT_FOUND` | Task does not exist. |

---

## Webhook integration

External systems (CI pipelines, GitHub Actions, custom automation) can create tasks via HMAC-authenticated webhook requests. Webhook integrations are managed through Cognito-authenticated endpoints; task submission uses a separate endpoint with HMAC-SHA256 authentication.

### Webhook management endpoints

These endpoints are protected by Cognito JWT (same as the task endpoints).

#### Create webhook

Creates a new webhook integration and returns the shared secret (shown only once).

```
POST /v1/webhooks
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | String | Yes | Human-readable name for the integration (1-64 chars, alphanumeric, spaces, hyphens, underscores). Must start and end with an alphanumeric character. |

**Response: `201 Created`**

```json
{
  "data": {
    "webhook_id": "01HYX...",
    "name": "My CI Pipeline",
    "secret": "<webhook-secret-64-hex-characters>",
    "created_at": "2025-03-15T10:30:00Z"
  }
}
```

The `secret` is a 32-byte random value (64 hex characters). **Store it securely — it cannot be retrieved after this response.** The secret is stored in AWS Secrets Manager under the name `bgagent/webhook/{webhook_id}`.

**Error responses:**

| Status | Code | Condition |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Missing or invalid webhook name. |
| `401` | `UNAUTHORIZED` | Missing or invalid auth token. |

---

#### List webhooks

Returns the authenticated user's webhook integrations. Paginated.

```
GET /v1/webhooks
```

**Query parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `include_revoked` | String | No | `false` | Set to `true` to include revoked webhooks. |
| `limit` | Number | No | 20 | Page size (1-100). |
| `next_token` | String | No | (none) | Pagination token from a previous response. |

**Response: `200 OK`**

```json
{
  "data": [
    {
      "webhook_id": "01HYX...",
      "name": "My CI Pipeline",
      "status": "active",
      "created_at": "2025-03-15T10:30:00Z",
      "updated_at": "2025-03-15T10:30:00Z",
      "revoked_at": null
    }
  ],
  "pagination": {
    "next_token": null,
    "has_more": false
  }
}
```

**Error responses:**

| Status | Code | Condition |
|---|---|---|
| `401` | `UNAUTHORIZED` | Missing or invalid auth token. |

---

#### Revoke webhook

Soft-revokes a webhook integration. The webhook can no longer authenticate requests. The secret is scheduled for deletion with a 7-day recovery window. The revoked webhook record is automatically deleted from DynamoDB after 30 days (configurable via `webhookRetentionDays`). After deletion, `GET /v1/webhooks` will no longer return the record.

```
DELETE /v1/webhooks/{webhook_id}
```

**Path parameters:**

| Parameter | Type | Description |
|---|---|---|
| `webhook_id` | String | Webhook identifier (ULID). |

**Response: `200 OK`**

```json
{
  "data": {
    "webhook_id": "01HYX...",
    "name": "My CI Pipeline",
    "status": "revoked",
    "created_at": "2025-03-15T10:30:00Z",
    "updated_at": "2025-03-15T12:00:00Z",
    "revoked_at": "2025-03-15T12:00:00Z"
  }
}
```

**Error responses:**

| Status | Code | Condition |
|---|---|---|
| `401` | `UNAUTHORIZED` | Missing or invalid auth token. |
| `404` | `WEBHOOK_NOT_FOUND` | Webhook does not exist, or belongs to a different user. |
| `409` | `WEBHOOK_ALREADY_REVOKED` | Webhook is already revoked. |

---

### Webhook task creation

Creates a task via webhook. Uses HMAC-SHA256 authentication instead of Cognito JWT. The task is owned by the Cognito user who created the webhook integration.

```
POST /v1/webhooks/tasks
```

**Request body:** Same as `POST /v1/tasks` (see [Create task](#create-task)), including `task_type` and `pr_number` fields.

**Required headers:**

| Header | Required | Description |
|---|---|---|
| `X-Webhook-Id` | Yes | Webhook integration ID. |
| `X-Webhook-Signature` | Yes | `sha256=<hex-hmac>` — HMAC-SHA256 of the raw request body using the webhook secret. |
| `Idempotency-Key` | No | Client-supplied idempotency key (same semantics as `POST /v1/tasks`). |

**Authentication flow (two-phase):**

1. A Lambda REQUEST authorizer extracts the `X-Webhook-Id` header and verifies that both `X-Webhook-Id` and `X-Webhook-Signature` are present.
2. Looks up the webhook record in DynamoDB; verifies `status: active`.
3. On success, returns an Allow policy with `context: { userId, webhookId }`. On failure, returns Deny.
4. The webhook handler fetches the shared secret from Secrets Manager (cached in-memory with 5-minute TTL).
5. Computes `HMAC-SHA256(secret, raw_request_body)` and compares with the provided signature using constant-time comparison (`crypto.timingSafeEqual`).
6. On success, creates the task. On failure, returns `401 Unauthorized`.

HMAC verification is performed by the handler (not the authorizer) because API Gateway REST API v1 does not pass the request body to Lambda REQUEST authorizers. Authorizer result caching is disabled (`resultsCacheTtl: 0`) because each request has a unique signature.

**Response: `201 Created`** — Same as `POST /v1/tasks`.

**Error responses:**

| Status | Code | Condition |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Missing required fields, invalid repo format, no task description or issue or PR number, invalid `task_type`, invalid `pr_number`, invalid `max_turns`, invalid `max_budget_usd`. |
| `401` | `UNAUTHORIZED` | Missing webhook headers, webhook not found, revoked, or invalid signature. |
| `409` | `DUPLICATE_TASK` | Idempotency key matches an existing task. |

**Channel metadata:** Tasks created via webhook record `channel_source: 'webhook'` and `channel_metadata` including `webhook_id`, `source_ip`, `user_agent`, and `api_request_id` for audit purposes.

---

## Rate limiting

Rate limits are enforced per authenticated user.

| Limit | Value | Scope | Response |
|---|---|---|---|
| **Request rate** | 60 requests/minute | Per user, across all endpoints | `429 Too Many Requests` |
| **Task creation rate** | 10 tasks/hour | Per user, `POST /v1/tasks` only | `429` with code `RATE_LIMIT_EXCEEDED` |
| **Concurrent tasks** | Configurable (default: 3–5) | Per user, running tasks | New tasks above the limit are rejected with `409 CONCURRENCY_LIMIT_EXCEEDED`. See [ORCHESTRATOR.md](./ORCHESTRATOR.md) — Admission control. |

Rate limit status is communicated via response headers (see Standard response headers).

---

## Error codes

| Code | HTTP Status | Description |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request body or query parameters are invalid. |
| `UNAUTHORIZED` | 401 | Missing, expired, or invalid authentication. |
| `FORBIDDEN` | 403 | Authenticated but not authorized (e.g. accessing another user's task). |
| `TASK_NOT_FOUND` | 404 | Task ID does not exist. |
| `DUPLICATE_TASK` | 409 | Idempotency key matches an existing task. |
| `TASK_ALREADY_TERMINAL` | 409 | Cannot cancel a task that is already in a terminal state. |
| `WEBHOOK_NOT_FOUND` | 404 | Webhook does not exist or belongs to a different user. |
| `WEBHOOK_ALREADY_REVOKED` | 409 | Webhook is already revoked. |
| `REPO_NOT_ONBOARDED` | 422 | Repository is not registered with the platform. Repos are onboarded via CDK deployment, not via a runtime API. There are no `/v1/repos` endpoints. |
| `PR_NOT_FOUND_OR_CLOSED` | 422 | For `pr_iteration` and `pr_review` tasks: the specified PR does not exist, is not open, or is not accessible with the configured GitHub token. Checked during the orchestrator's pre-flight step. |
| `INVALID_STEP_SEQUENCE` | 500 | The blueprint's step sequence is invalid (missing required steps or incorrect ordering). This indicates a CDK configuration error that slipped past synth-time validation. Visible via `GET /v1/tasks/{id}` as `error_code`. See [REPO_ONBOARDING.md](./REPO_ONBOARDING.md#step-sequence-validation). |
| `RATE_LIMIT_EXCEEDED` | 429 | User exceeded rate limit. |
| `INTERNAL_ERROR` | 500 | Unexpected server error. Includes `request_id` for support. |
| `SERVICE_UNAVAILABLE` | 503 | Downstream dependency unavailable (e.g. DynamoDB, AgentCore). Retry with backoff. |

---

## Pagination

List endpoints use **token-based pagination** (not offset-based). This is consistent with DynamoDB's `ExclusiveStartKey` pattern.

- The response includes `pagination.next_token` (opaque string) and `pagination.has_more` (boolean).
- To fetch the next page, pass `next_token` as a query parameter.
- Tokens are short-lived (valid for the duration of a session, not persisted). Do not store or cache them.
- Results are ordered by `created_at` descending (newest first) unless otherwise specified.

---

## Implementation notes

### API Gateway configuration

The API is implemented as an **Amazon API Gateway REST API** (or HTTP API) with Lambda integrations:

| Endpoint | Lambda handler | Auth | Description |
|---|---|---|---|
| `POST /v1/tasks` | `createTaskHandler` | Cognito | Validates, creates task record, triggers orchestrator. |
| `GET /v1/tasks` | `listTasksHandler` | Cognito | Queries DynamoDB `UserStatusIndex` GSI. |
| `GET /v1/tasks/{task_id}` | `getTaskHandler` | Cognito | Reads task from DynamoDB, enforces ownership. |
| `DELETE /v1/tasks/{task_id}` | `cancelTaskHandler` | Cognito | Updates task status, signals orchestrator to cancel. |
| `GET /v1/tasks/{task_id}/events` | `getTaskEventsHandler` | Cognito | Queries DynamoDB `TaskEvents` table. |
| `POST /v1/webhooks` | `createWebhookHandler` | Cognito | Creates webhook integration, generates SM secret. |
| `GET /v1/webhooks` | `listWebhooksHandler` | Cognito | Queries user's webhooks from DynamoDB `UserIndex` GSI. |
| `DELETE /v1/webhooks/{webhook_id}` | `deleteWebhookHandler` | Cognito | Soft-revokes webhook, schedules SM secret deletion. |
| `POST /v1/webhooks/tasks` | `webhookCreateTaskHandler` | HMAC | Creates task via webhook (shared core with `createTaskHandler`). |
| — | `webhookAuthorizerFn` | — | REQUEST authorizer: verifies webhook exists and is active. |

### Authorization model

- All endpoints enforce **user ownership**: a user can only access tasks where `task.user_id` matches the authenticated user's platform ID. Webhooks enforce ownership at the management layer — only the webhook creator can list, view, or revoke it.
- For Cognito-authenticated endpoints, the `user_id` is extracted from the JWT claims (`sub`) and passed to handlers via the request context.
- For webhook-authenticated endpoints, the `user_id` is extracted from the webhook record by the Lambda REQUEST authorizer and injected into the authorizer context (`event.requestContext.authorizer.userId`).
- Handlers never trust client-supplied user IDs.

### Relationship to internal message schema

The API request/response schemas defined here are the **external** contract. The input gateway normalizes API requests into the **internal message schema** (see [INPUT_GATEWAY.md](./INPUT_GATEWAY.md)) before dispatching to the task pipeline. The internal schema may include additional fields (e.g. `channel_metadata`, `normalized_at`) that are not exposed in the API.
