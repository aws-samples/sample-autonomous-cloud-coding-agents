---
title: Using the REST API
---

The Task API exposes 5 endpoints under the base URL from the `ApiUrl` stack output. All endpoints require Cognito JWT authentication (`Authorization: Bearer <token>`).

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/tasks` | Create a new task (new_task, pr_iteration, or pr_review) |
| `GET` | `/tasks` | List your tasks with optional filters (status, repo, pagination) |
| `GET` | `/tasks/{task_id}` | Get full detail for a specific task |
| `DELETE` | `/tasks/{task_id}` | Cancel a running or queued task |
| `GET` | `/tasks/{task_id}/events` | Get the chronological audit log for a task |

### Create a task

```bash
curl -X POST "$API_URL/tasks" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "owner/repo",
    "task_description": "Add input validation to the /users POST endpoint"
  }'
```

**Example response** right after submit (`status` is `SUBMITTED`; `branch_name` is reserved up front; `session_id`, `pr_url`, cost, and timing stay `null` until the orchestrator and agent progress):

```bash
curl -X POST "$API_URL/tasks" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "krokoko/agent-plugins", "task_description": "add codeowners field to RFC issue template"}'
```

```json
{"data":{"task_id":"01KN36YGQV6BEPDD7CVMKP1PF3","status":"SUBMITTED","repo":"krokoko/agent-plugins","issue_number":null,"task_description":"add codeowners field to RFC issue template","branch_name":"bgagent/01KN36YGQV6BEPDD7CVMKP1PF3/add-codeowners-field-to-rfc-issue-template","session_id":null,"pr_url":null,"error_message":null,"created_at":"2026-04-01T00:26:30.011Z","updated_at":"2026-04-01T00:26:30.011Z","started_at":null,"completed_at":null,"duration_s":null,"cost_usd":null,"build_passed":null,"max_turns":null,"max_budget_usd":null,"prompt_version":null}}
```

To create a task from a GitHub issue:

```bash
curl -X POST "$API_URL/tasks" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "owner/repo", "issue_number": 42}'
```

To iterate on an existing pull request (address review feedback):

```bash
curl -X POST "$API_URL/tasks" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "owner/repo", "task_type": "pr_iteration", "pr_number": 42}'
```

You can optionally include `task_description` with `pr_iteration` to provide additional instructions alongside the review feedback:

```bash
curl -X POST "$API_URL/tasks" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "owner/repo", "task_type": "pr_iteration", "pr_number": 42, "task_description": "Focus on the null check Alice flagged in the auth module"}'
```

To request a read-only review of an existing pull request:

```bash
curl -X POST "$API_URL/tasks" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "owner/repo", "task_type": "pr_review", "pr_number": 55}'
```

You can optionally include `task_description` with `pr_review` to focus the review on specific areas:

```bash
curl -X POST "$API_URL/tasks" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "owner/repo", "task_type": "pr_review", "pr_number": 55, "task_description": "Focus on security implications and error handling"}'
```

**Request body fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `repo` | string | Yes | GitHub repository in `owner/repo` format |
| `issue_number` | number | One of these | GitHub issue number |
| `task_description` | string | is required | Free-text task description |
| `pr_number` | number | | PR number to iterate on or review (required for `pr_iteration` and `pr_review`) |
| `task_type` | string | No | `new_task` (default), `pr_iteration`, or `pr_review`. |
| `max_turns` | number | No | Maximum agent turns (1–500). Overrides the per-repo Blueprint default. Platform default: 100. |
| `max_budget_usd` | number | No | Maximum cost budget in USD (0.01–100). When reached, the agent stops regardless of remaining turns. Overrides the per-repo Blueprint default. If omitted, no budget limit is applied. |

**Content screening:** Task descriptions are automatically screened by Amazon Bedrock Guardrails for prompt injection before the task is created. If content is blocked, you receive a `400 GUARDRAIL_BLOCKED` error  - revise the description and retry. If the screening service is temporarily unavailable, you receive a `503` error  - retry after a short delay. For PR tasks (`pr_iteration`, `pr_review`), the assembled prompt (including PR body and review comments) is also screened during context hydration; if blocked, the task transitions to `FAILED`.

**Idempotency:** Include an `Idempotency-Key` header (alphanumeric, dashes, underscores, max 128 chars) to prevent duplicate task creation on retries:

```bash
curl -X POST "$API_URL/tasks" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-unique-key-123" \
  -d '{"repo": "owner/repo", "task_description": "Fix bug"}'
```

### List tasks

```bash
curl "$API_URL/tasks" -H "Authorization: $TOKEN"
```

**Query parameters:**

| Parameter | Description |
|---|---|
| `status` | Filter by status (e.g., `RUNNING` or `RUNNING,SUBMITTED`) |
| `repo` | Filter by repository |
| `limit` | Max results per page (default: 20, max: 100) |
| `next_token` | Pagination token from a previous response |

Example with filters:

```bash
curl "$API_URL/tasks?status=RUNNING,SUBMITTED&limit=10" -H "Authorization: $TOKEN"
```

### Get task detail

```bash
curl "$API_URL/tasks/<TASK_ID>" -H "Authorization: $TOKEN"
curl "$API_URL/tasks/01KJDSS94G3VA55CW1M534EC7Q" -H "Authorization: $TOKEN"
```

Returns the full task record including status, timestamps, PR URL, cost, and error details.

**Example** (after a successful run  - `status` is `COMPLETED`, `pr_url` populated):

```bash
curl "$API_URL/tasks/01KN36YGQV6BEPDD7CVMKP1PF3" -H "Authorization: $TOKEN"
```

```json
{"data":{"task_id":"01KN36YGQV6BEPDD7CVMKP1PF3","status":"COMPLETED","repo":"krokoko/agent-plugins","issue_number":null,"task_description":"add codeowners field to RFC issue template","branch_name":"bgagent/01KN36YGQV6BEPDD7CVMKP1PF3/add-codeowners-field-to-rfc-issue-template","session_id":"3eb8f3fb-808d-47d6-8557-309fb9369ea7","pr_url":"https://github.com/krokoko/agent-plugins/pull/59","error_message":null,"created_at":"2026-04-01T00:26:30.011Z","updated_at":"2026-04-01T00:26:35.350Z","started_at":"2026-04-01T00:26:35.350Z","completed_at":"2026-04-01T00:30:32Z","duration_s":"125.9","cost_usd":"0.15938219999999997","build_passed":null,"max_turns":null,"max_budget_usd":null,"prompt_version":"1c9c10e027a2"}}
```

### Cancel a task

```bash
curl -X DELETE "$API_URL/tasks/<TASK_ID>" -H "Authorization: $TOKEN"
```

Transitions the task to `CANCELLED` and records a cancellation event. Only tasks in non-terminal states can be cancelled.

### Get task events (audit log)

```bash
curl "$API_URL/tasks/<TASK_ID>/events" -H "Authorization: $TOKEN"
```

Returns the chronological event log for a task (e.g., `task_created`, `preflight_failed`, `session_started`, `task_completed`). Supports `limit` and `next_token` pagination parameters. If the task failed before the agent ran, inspect `preflight_failed` entries for `reason` and `detail` (see **Task events** under **Task lifecycle**).