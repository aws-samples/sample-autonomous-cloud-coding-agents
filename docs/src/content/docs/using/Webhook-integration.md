---
title: Webhook integration
---

Webhooks allow external systems (CI pipelines, GitHub Actions, custom automation) to create tasks without Cognito credentials. Each webhook integration has its own HMAC-SHA256 shared secret.

### Managing webhooks (CLI)

The `bgagent webhook` commands manage webhook integrations directly from the terminal:

```bash
# Create a webhook — returns the secret (shown once)
node lib/bin/bgagent.js webhook create --name "My CI Pipeline"

# List active webhooks
node lib/bin/bgagent.js webhook list

# Revoke a webhook (soft delete — 7-day secret recovery window)
node lib/bin/bgagent.js webhook revoke <WEBHOOK_ID>
```

### Managing webhooks (REST API)

Webhook management requires Cognito authentication (same as the REST API).

#### Create a webhook

```bash
curl -X POST "$API_URL/webhooks" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "My CI Pipeline"}'
```

The response includes a `secret` field  - **store it securely, it is only shown once**:

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

The request body is identical to `POST /v1/tasks` (same `repo`, `issue_number`, `task_description`, `task_type`, `pr_number`, `max_turns`, `max_budget_usd` fields). The `Idempotency-Key` header is also supported. You can submit `pr_iteration` tasks via webhook to automate PR feedback loops, or `pr_review` tasks to trigger automated code reviews.

**Example response** (same shape as a successful `POST /tasks`  - `status` is `SUBMITTED`; session, PR, and cost fields are `null` until the run progresses):

```json
{"data":{"task_id":"01KN38AB1SE79QA4MBNAHFBQAN","status":"SUBMITTED","repo":"krokoko/agent-plugins","issue_number":null,"task_description":"add codeowners field to RFC issue template","branch_name":"bgagent/01KN38AB1SE79QA4MBNAHFBQAN/add-codeowners-field-to-rfc-issue-template","session_id":null,"pr_url":null,"error_message":null,"error_classification":null,"created_at":"2026-04-01T00:50:25.977Z","updated_at":"2026-04-01T00:50:25.977Z","started_at":null,"completed_at":null,"duration_s":null,"cost_usd":null,"build_passed":null,"max_turns":null,"max_budget_usd":null,"prompt_version":null}}
```

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