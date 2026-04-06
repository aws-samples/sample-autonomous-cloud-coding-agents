# @backgroundagent/cli

Command-line interface for the ABCA platform. Submit coding tasks, monitor their status, and manage results — all through the deployed REST API with Cognito authentication.

## Installation

```bash
npm install -g @backgroundagent/cli
```

Or run directly from the monorepo:

```bash
node cli/lib/bin/bgagent.js
```

## Quick start

After deploying the stack (`cd cdk && npx cdk deploy`), extract the outputs and configure the CLI:

```bash
# 1. Extract stack outputs into environment variables
STACK_NAME="backgroundagent-dev"
API_URL=$(aws cloudformation describe-stacks --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)
APP_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`AppClientId`].OutputValue' --output text)

# 2. Configure the CLI
bgagent configure \
  --api-url "$API_URL" \
  --region us-east-1 \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$APP_CLIENT_ID"

# 3. Log in with your Cognito credentials
bgagent login --username you@example.com

# 4. Submit a task
bgagent submit --repo owner/repo --issue 42

# 5. Check status
bgagent list
bgagent status <task-id>
```

## Commands

### `bgagent configure`

Save API endpoint and Cognito settings to `~/.bgagent/config.json`.

```
bgagent configure \
  --api-url <url>         API Gateway base URL (required)
  --region <region>       AWS region (required)
  --user-pool-id <id>     Cognito User Pool ID (required)
  --client-id <id>        Cognito App Client ID (required)
```

### `bgagent login`

Authenticate with Cognito and cache tokens locally.

```
bgagent login \
  --username <email>      Cognito username (required)
  --password <password>   Password (prompts interactively if omitted)
```

Tokens are saved to `~/.bgagent/credentials.json` (mode 0600). The CLI automatically refreshes expired tokens using the cached refresh token.

### `bgagent submit`

Submit a new coding task.

```
bgagent submit \
  --repo <owner/repo>          GitHub repository (required)
  --issue <number>             GitHub issue number
  --task <description>         Task description
  --max-turns <number>         Maximum agent turns (1-500)
  --max-budget <dollars>       Maximum cost budget in USD (0.01-100)
  --idempotency-key <key>      Deduplication key
  --wait                       Wait for task to complete
  --output <text|json>         Output format (default: text)
```

At least one of `--issue` or `--task` is required.

The repository must be onboarded to the platform via a `Blueprint` CDK construct. If the repo is not onboarded, the API returns a `REPO_NOT_ONBOARDED` error.

When `--wait` is used, the CLI polls until the task reaches a terminal status (COMPLETED, FAILED, CANCELLED, TIMED_OUT) and exits with code 0 for COMPLETED or 1 otherwise.

### `bgagent list`

List tasks for the authenticated user.

```
bgagent list \
  --status <s1,s2,...>         Filter by status (comma-separated)
  --repo <owner/repo>         Filter by repository
  --limit <n>                 Maximum results to return
  --output <text|json>        Output format (default: text)
```

### `bgagent status <task-id>`

Get detailed status for a specific task.

```
bgagent status <task-id> \
  --wait                       Wait for terminal status
  --output <text|json>         Output format (default: text)
```

### `bgagent cancel <task-id>`

Cancel a running task.

```
bgagent cancel <task-id> \
  --output <text|json>         Output format (default: text)
```

### `bgagent events <task-id>`

View the event timeline for a task.

```
bgagent events <task-id> \
  --limit <n>                  Maximum events to return
  --output <text|json>         Output format (default: text)
```

### `bgagent webhook create`

Create a new webhook integration. The HMAC secret is displayed once at creation time — store it securely.

```
bgagent webhook create \
  --name <name>                Webhook name (required)
  --output <text|json>         Output format (default: text)
```

### `bgagent webhook list`

List webhook integrations for the authenticated user.

```
bgagent webhook list \
  --include-revoked            Include revoked webhooks
  --limit <n>                  Maximum results to return
  --output <text|json>         Output format (default: text)
```

### `bgagent webhook revoke <webhook-id>`

Revoke a webhook. Revoked webhooks can no longer create tasks.

```
bgagent webhook revoke <webhook-id> \
  --output <text|json>         Output format (default: text)
```

## Output formats

**Text mode** (default) prints human-readable output:
- `status` and `submit` show a key-value detail view
- `list` shows an aligned table (TASK ID, STATUS, REPO, CREATED, DESCRIPTION)
- `events` shows a timeline (TIMESTAMP, EVENT TYPE, METADATA)
- `webhook create` shows webhook details and the one-time HMAC secret
- `webhook list` shows an aligned table (WEBHOOK ID, NAME, STATUS, CREATED)
- `webhook revoke` shows the revoked webhook details

**JSON mode** (`--output json`) prints the raw API response as pretty-printed JSON, suitable for piping to `jq` or other tools.

## Configuration

Configuration is stored in `~/.bgagent/`:

| File | Contents | Permissions |
|------|----------|-------------|
| `config.json` | `api_url`, `region`, `user_pool_id`, `client_id` | 0644 |
| `credentials.json` | `id_token`, `refresh_token`, `token_expiry` | 0600 |

Override the config directory by setting the `BGAGENT_CONFIG_DIR` environment variable.

## Authentication

The CLI uses Cognito `USER_PASSWORD_AUTH` for initial login and `REFRESH_TOKEN_AUTH` for automatic token refresh. Tokens are refreshed automatically when they are within 5 minutes of expiry. If the refresh token itself has expired, the CLI will prompt you to run `bgagent login` again.

## License

Apache-2.0
