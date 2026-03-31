# User guide

This guide covers how to use ABCA to submit coding tasks and monitor their progress.

## Overview

ABCA is a platform for running autonomous background coding agents on AWS. You submit a task (a GitHub repository + a task description or issue number), an agent works autonomously in an isolated environment, and delivers a pull request when done.

There are three ways to interact with the platform:

1. **CLI** (recommended) — The `bgagent` CLI authenticates via Cognito and calls the Task API. Handles login, token caching, and output formatting.
2. **REST API** (direct) — Call the Task API endpoints directly with a JWT token. Full validation, audit logging, and idempotency support.
3. **Webhook** — External systems (CI pipelines, GitHub Actions) can create tasks via HMAC-authenticated HTTP requests. No Cognito credentials needed; uses a shared secret per integration.

## Prerequisites

- The CDK stack deployed (see [Developer guide](./DEVELOPER_GUIDE.md))
- A Cognito user account (see [Authentication](#authentication) below)
- **Repositories must be onboarded** before tasks can target them (see [Repository onboarding](#repository-onboarding) below)
- For the **CLI**: Node.js installed; build the CLI with `cd cli && npx projen build`

## Authentication

The Task API uses Amazon Cognito for authentication. Self-signup is disabled; an administrator must create your account.

### Get stack outputs

After deployment, retrieve the API URL and Cognito identifiers:

```bash
API_URL=$(aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)
APP_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`AppClientId`].OutputValue' --output text)
```

### Create a user (admin)

```bash
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username user@example.com \
  --temporary-password 'TempPass123!@'

aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username user@example.com \
  --password 'YourPerm@nent1Pass!' \
  --permanent
```

Password requirements: minimum 12 characters, uppercase, lowercase, digits, and symbols.

### Obtain a JWT token

```bash
TOKEN=$(aws cognito-idp initiate-auth \
  --client-id $APP_CLIENT_ID \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=user@example.com,PASSWORD='YourPerm@nent1Pass!' \
  --query 'AuthenticationResult.IdToken' --output text)
```

Use this token in the `Authorization` header for all API requests.

## Repository onboarding

Before submitting tasks against a repository, the repository must be **onboarded** to the platform. Onboarding is managed by the platform administrator through CDK — each repository is registered as a `Blueprint` construct in the CDK stack, which writes a configuration record to the `RepoTable` DynamoDB table.

If you submit a task against a repository that has not been onboarded, the API returns a `422` error with code `REPO_NOT_ONBOARDED`:

```json
{
  "error": {
    "code": "REPO_NOT_ONBOARDED",
    "message": "Repository 'owner/repo' is not onboarded. Register it with a Blueprint before submitting tasks."
  }
}
```

Contact your platform administrator to onboard a new repository. For details on how administrators register repositories, see the [Developer guide](./DEVELOPER_GUIDE.md#repository-onboarding).

### Per-repo configuration

Blueprints can configure per-repository settings that override platform defaults:

| Setting | Description | Default |
|---|---|---|
| `compute_type` | Compute strategy (`agentcore` or `ecs`) | `agentcore` |
| `runtime_arn` | AgentCore runtime ARN override | Platform default |
| `model_id` | Foundation model ID | Platform default |
| `max_turns` | Default turn limit for tasks | 100 |
| `max_budget_usd` | Default cost budget in USD per task | None (unlimited) |
| `system_prompt_overrides` | Additional system prompt instructions | None |
| `github_token_secret_arn` | Per-repo GitHub token (Secrets Manager ARN) | Platform default |
| `poll_interval_ms` | Poll interval for awaiting completion (5000–300000) | 30000 |

When you specify `--max-turns` (CLI) or `max_turns` (API) on a task, your value takes precedence over the Blueprint default. If neither is specified, the platform default (100) is used. The same override pattern applies to `--max-budget` / `max_budget_usd`, except there is no platform default — if neither the task nor the Blueprint specifies a budget, no cost limit is applied.

## Using the REST API

The Task API exposes 5 endpoints under the base URL from the `ApiUrl` stack output.

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

To create a task from a GitHub issue:

```bash
curl -X POST "$API_URL/tasks" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "owner/repo", "issue_number": 42}'
```

**Request body fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `repo` | string | Yes | GitHub repository in `owner/repo` format |
| `issue_number` | number | One of these | GitHub issue number |
| `task_description` | string | is required | Free-text task description |
| `max_turns` | number | No | Maximum agent turns (1–500). Overrides the per-repo Blueprint default. Platform default: 100. |
| `max_budget_usd` | number | No | Maximum cost budget in USD (0.01–100). When reached, the agent stops regardless of remaining turns. Overrides the per-repo Blueprint default. If omitted, no budget limit is applied. |

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

### Cancel a task

```bash
curl -X DELETE "$API_URL/tasks/<TASK_ID>" -H "Authorization: $TOKEN"
```

Transitions the task to `CANCELLED` and records a cancellation event. Only tasks in non-terminal states can be cancelled.

### Get task events (audit log)

```bash
curl "$API_URL/tasks/<TASK_ID>/events" -H "Authorization: $TOKEN"
```

Returns the chronological event log for a task (e.g., `task_created`, `session_started`, `task_completed`). Supports `limit` and `next_token` pagination parameters.

## Using the CLI

The `bgagent` CLI is the recommended way to interact with the platform. It authenticates via Cognito, manages token caching, and provides formatted output.

### Setup

```bash
# Build the CLI
cd cli && npx projen build && cd ..

# Configure with your stack outputs
bgagent configure \
  --api-url $API_URL \
  --region us-east-1 \
  --user-pool-id $USER_POOL_ID \
  --client-id $APP_CLIENT_ID

# Log in
bgagent login --username user@example.com
```

### Submitting a task

```bash
# From a GitHub issue
bgagent submit --repo owner/repo --issue 42

# From a text description
bgagent submit --repo owner/repo --task "Add input validation to the /users POST endpoint"

# Submit and wait for completion
bgagent submit --repo owner/repo --issue 42 --wait
```

**Options:**

| Flag | Description |
|---|---|
| `--repo` | GitHub repository (`owner/repo`). Required. |
| `--issue` | GitHub issue number. |
| `--task` | Task description text. |
| `--max-turns` | Maximum agent turns (1–500). Overrides per-repo Blueprint default. Platform default: 100. |
| `--max-budget` | Maximum cost budget in USD (0.01–100). Overrides per-repo Blueprint default. No default limit. |
| `--idempotency-key` | Idempotency key for deduplication. |
| `--wait` | Poll until the task reaches a terminal status. |
| `--output` | Output format: `text` (default) or `json`. |

At least one of `--issue` or `--task` is required.

### Checking task status

#### Single task

```bash
bgagent status <TASK_ID>

# Poll until completion
bgagent status <TASK_ID> --wait
```

#### All tasks

```bash
bgagent list
bgagent list --status RUNNING,SUBMITTED
bgagent list --repo owner/repo --limit 10
```

### Viewing task events

```bash
bgagent events <TASK_ID>
bgagent events <TASK_ID> --limit 20
```

### Cancelling a task

```bash
bgagent cancel <TASK_ID>
```

## Webhook integration

Webhooks allow external systems (CI pipelines, GitHub Actions, custom automation) to create tasks without Cognito credentials. Each webhook integration has its own HMAC-SHA256 shared secret.

### Managing webhooks

Webhook management requires Cognito authentication (same as the REST API).

#### Create a webhook

```bash
curl -X POST "$API_URL/webhooks" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "My CI Pipeline"}'
```

The response includes a `secret` field — **store it securely, it is only shown once**:

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

Webhook names must be 1-64 characters: alphanumeric, spaces, hyphens, or underscores, starting and ending with an alphanumeric character.

#### List webhooks

```bash
curl "$API_URL/webhooks" -H "Authorization: $TOKEN"
```

By default, revoked webhooks are excluded. To include them:

```bash
curl "$API_URL/webhooks?include_revoked=true" -H "Authorization: $TOKEN"
```

Supports `limit` and `next_token` pagination parameters.

#### Revoke a webhook

```bash
curl -X DELETE "$API_URL/webhooks/<WEBHOOK_ID>" -H "Authorization: $TOKEN"
```

Revocation is a soft delete: the webhook record is marked `revoked` and the secret is scheduled for deletion (7-day recovery window). Revoked webhooks can no longer authenticate requests. Revoked webhook records are automatically deleted from DynamoDB after 30 days (configurable via `webhookRetentionDays`).

### Submitting tasks via webhook

Use the webhook endpoint with HMAC-SHA256 authentication instead of a JWT:

```bash
WEBHOOK_ID="01HYX..."
WEBHOOK_SECRET="a1b2c3d4..."
BODY='{"repo": "owner/repo", "task_description": "Fix the login bug"}'

# Compute HMAC-SHA256 signature
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | cut -d' ' -f2)

curl -X POST "$API_URL/webhooks/tasks" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Id: $WEBHOOK_ID" \
  -H "X-Webhook-Signature: sha256=$SIGNATURE" \
  -d "$BODY"
```

The request body is identical to `POST /v1/tasks` (same `repo`, `issue_number`, `task_description`, `max_turns`, `max_budget_usd` fields). The `Idempotency-Key` header is also supported.

**Required headers:**

| Header | Description |
|---|---|
| `X-Webhook-Id` | The webhook integration ID |
| `X-Webhook-Signature` | `sha256=` followed by the hex-encoded HMAC-SHA256 of the raw request body using the webhook secret |

Tasks created via webhook are owned by the Cognito user who created the webhook integration. They appear in that user's task list and can be managed (status, cancel, events) through the normal REST API or CLI.

### Webhook authentication flow

1. The caller sends `POST /v1/webhooks/tasks` with `X-Webhook-Id` and `X-Webhook-Signature` headers.
2. A Lambda REQUEST authorizer extracts the `X-Webhook-Id` header, looks up the webhook record in DynamoDB, and verifies `status: active`. On success it returns an Allow policy with `context: { userId, webhookId }`.
3. The webhook handler fetches the shared secret from Secrets Manager (cached in-memory with a 5-minute TTL).
4. The handler computes `HMAC-SHA256(secret, request_body)` and performs a constant-time comparison with the provided signature.
5. On success, the task is created under the webhook owner's identity. On failure, a `401 Unauthorized` response is returned.

**Note:** HMAC verification is performed by the handler (not the authorizer) because API Gateway REST API v1 does not pass the request body to Lambda REQUEST authorizers. Authorizer result caching is disabled (`resultsCacheTtl: 0`) because each request has a unique signature.

## Task lifecycle

When you create a task via the REST API, the platform automatically orchestrates it through these states:

```
SUBMITTED ──> HYDRATING ──> RUNNING ──> COMPLETED
    │              │           │
    │              │           └──> FAILED / CANCELLED / TIMED_OUT
    │              └──> FAILED / CANCELLED
    └──> FAILED / CANCELLED
```

The orchestrator uses Lambda Durable Functions to manage the lifecycle durably — long-running tasks (up to 9 hours) survive transient failures and Lambda timeouts. The agent commits work regularly, so partial progress is never lost.

| Status | Meaning |
|---|---|
| `SUBMITTED` | Task accepted; orchestrator invoked asynchronously |
| `HYDRATING` | Orchestrator passed admission control; assembling the agent payload |
| `RUNNING` | Agent session started and actively working on the task |
| `COMPLETED` | Agent finished and created a PR (or determined no changes were needed) |
| `FAILED` | Agent encountered an error, or user concurrency limit was reached |
| `CANCELLED` | Task was cancelled by the user |
| `TIMED_OUT` | Task exceeded the maximum allowed duration (~9 hours) |

Terminal states: `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`.

**Data retention:** Task records in terminal states are automatically deleted from DynamoDB after 90 days (configurable via `taskRetentionDays`). Querying a task after this period returns a `404`. Active tasks are not affected.

### Concurrency limits

Each user can have up to **3 tasks running concurrently** by default (configurable via the `maxConcurrentTasksPerUser` prop on the `TaskOrchestrator` CDK construct). If you exceed the limit, the task transitions to `FAILED` with a concurrency limit message. Wait for an active task to complete, or cancel one, then retry.

There is currently no system-wide concurrency cap — the theoretical maximum across all users is `number_of_users * per_user_limit`. The hard ceiling is the AgentCore concurrent sessions quota for your AWS account, which is an account-level service limit. Check the [AWS Service Quotas console](https://console.aws.amazon.com/servicequotas/) for Bedrock AgentCore in your region to see the current value. The `InvokeAgentRuntime` API is also rate-limited to 25 TPS per agent per account (adjustable via Service Quotas).

### Task events

Each lifecycle transition is recorded as an audit event. Use the events endpoint to see the full history:

```bash
curl "$API_URL/tasks/<TASK_ID>/events" -H "Authorization: $TOKEN"
```

Events include: `task_created`, `hydration_started`, `hydration_complete`, `session_started`, `task_completed`, `task_failed`, `task_cancelled`, `task_timed_out`, `admission_rejected`. Event records are subject to the same 90-day retention as task records and are automatically deleted after that period.

## What the agent does

When a task is submitted, the agent:

1. Clones the repository into an isolated workspace
2. Creates a branch named `bgagent/<task-id>/<short-description>`
3. Installs dependencies via `mise install` and runs an initial build
4. Loads repo-level project configuration (`CLAUDE.md`, `.claude/` settings, agents, rules, `.mcp.json`) if present
5. Reads the codebase to understand the project structure
6. Makes the requested changes
7. Runs the build and tests (`mise run build`)
8. Commits and pushes incrementally throughout
9. Creates a pull request with a summary of changes, build/test results, and decisions made

The PR title follows conventional commit format (e.g., `feat(auth): add OAuth2 login flow`).

## Viewing logs

Each task record includes a `logs_url` field with a direct link to filtered CloudWatch logs. You can get this URL from the task status output or from the `GET /tasks/{task_id}` API response.

Alternatively, the application logs are in the CloudWatch log group:

```
/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/jean_cloude
```

Filter by task ID to find logs for a specific task.

## Tips

- **Onboard your repo first**: Repositories must be registered via a `Blueprint` construct before tasks can target them. If you get a `REPO_NOT_ONBOARDED` error, contact your platform administrator.
- **Prepare your repo**: The agent works best with repositories that are agent friendly. See the [Developer guide](./DEVELOPER_GUIDE.md) for repository preparation advice.
- **Add a CLAUDE.md**: The agent automatically loads project-level configuration from your repository — `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, `.claude/settings.json`, `.claude/agents/`, and `.mcp.json`. Use these to provide project-specific build commands, conventions, constraints, custom subagents, and architecture notes. See the [Prompt guide](./PROMPT_GUIDE.md#repo-level-customization) for details and examples.
- **Issue vs text**: When using `--issue` (CLI) or `issue_number` (API), the agent fetches the full issue body from GitHub, including any labels, comments, and linked context. This is usually better than a short text description.
- **Cost**: Cost depends on the model and number of turns. Use `--max-turns` (CLI) or `max_turns` (API) to cap the number of agent iterations per task (range: 1–500). If not specified, the per-repo Blueprint default applies, falling back to the platform default (100). Use `--max-budget` (CLI) or `max_budget_usd` (API) to set a hard cost limit in USD ($0.01–$100) — when the budget is reached, the agent stops regardless of remaining turns. If no budget is specified, the per-repo Blueprint default applies; if that is also absent, no cost limit is enforced. Check the task status after completion to see the reported cost.
- **Idempotency**: Use the `Idempotency-Key` header when creating tasks via the API to safely retry requests without creating duplicate tasks.
