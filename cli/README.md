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
# 1. Print stack outputs (replaces manual aws cloudformation describe-stacks)
bgagent platform outputs --stack-name backgroundagent-dev

# 2. Store the GitHub PAT (replaces aws secretsmanager put-secret-value)
bgagent github set-token --stack-name backgroundagent-dev

# 3. Configure the CLI (reads ApiUrl, UserPoolId, AppClientId from the stack)
bgagent configure --region us-east-1 --stack-name backgroundagent-dev

# Or pass fields explicitly / use --from-bundle from `admin invite-user`

# 4. Log in with your Cognito credentials
bgagent login --username you@example.com

# 5. Submit a task
bgagent submit --repo owner/repo --issue 42

# 6. Check status
bgagent list
bgagent status <task-id>
```

Operator commands (`platform`, `repo`, `github set-token`) use **operator AWS credentials** directly — Cognito login is not required.

## Commands

### `bgagent configure`

Save API endpoint and Cognito settings to `~/.bgagent/config.json`.

```
bgagent configure \
  --stack-name <name>     Read ApiUrl, UserPoolId, AppClientId from CloudFormation
  --from-bundle <base64>  All four fields from `bgagent admin invite-user`
  --api-url <url>         API Gateway base URL (override or manual configure)
  --region <region>       AWS region (required with --stack-name if unset in env)
  --user-pool-id <id>     Cognito User Pool ID
  --client-id <id>        Cognito App Client ID
```

First-time configure needs all four core fields. The easiest paths are `--stack-name backgroundagent-dev --region …` (same outputs as `bgagent platform outputs`) or `--from-bundle` after `admin invite-user`. Individual flags override stack-derived values.

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

## Operator commands

These commands support day-2 operations using **operator AWS credentials** (IAM profile or environment). They read CloudFormation outputs, DynamoDB, and Secrets Manager directly — no Cognito login required. The read-only and introspection commands (`platform`, `repo`, `runtime`, `ops`, `webhook test`, `admin list-users`) support `--output json` for scripting; the credential-writing commands (`github set-token`/`set-webhook-secret`, `admin invite-user`/`delete-user`/`reset-password`) do not.

Shared flags:

| Flag | Description |
|------|-------------|
| `--region <region>` | AWS region (defaults to `bgagent configure` region or `AWS_REGION`) |
| `--stack-name <name>` | CloudFormation stack name (default: `backgroundagent-dev`) |

### `bgagent platform outputs`

Print CloudFormation stack outputs (`ApiUrl`, `UserPoolId`, `AppClientId`, `GitHubTokenSecretArn`, etc.).

```
bgagent platform outputs \
  --output <text|json>         Output format (default: text)
```

### `bgagent platform doctor`

Smoke-check deployed platform readiness: Task API reachable, Cognito pool/client valid, platform GitHub token populated, at least one active onboarded repo, Bedrock model visible.

```
bgagent platform doctor \
  --output <text|json>         Output format (default: text)
```

Exits with code 1 when any check fails (warnings are acceptable).

### `bgagent repo list`

List repositories onboarded via Blueprint constructs (reads `RepoTable`).

```
bgagent repo list \
  --status <active|removed>    Filter by status
  --output <text|json>        Output format (default: text)
```

### `bgagent repo show <owner/repo>`

Show full `RepoConfig` for a repository. Secret ARNs are redacted. When no per-blueprint token is configured, the output shows that the repo uses the **platform default** GitHub PAT (`GitHubTokenSecretArn`), not an empty/missing token.

```
bgagent repo show owner/repo \
  --output <text|json>        Output format (default: text)
```

### `bgagent repo onboard <owner/repo>`

Register or re-activate a repository in `RepoTable` without a CDK redeploy. With no overrides, tasks use the platform `RuntimeArn` and `GitHubTokenSecretArn` (IAM already granted at deploy). Custom `--runtime-arn` / `--token-secret-arn` values require matching `TaskOrchestrator` IAM via CDK — the command prints notes explaining this. Prefer CDK `Blueprint` constructs for durable lifecycle, Cedar policies, and egress validation.

```
bgagent repo onboard owner/repo \
  --compute-type <agentcore|ecs> \
  --runtime-arn <arn>         AgentCore runtime override (agentcore only) \
  --model <model-id> \
  --token-secret-arn <arn> \
  --max-turns <n> \
  --poll-interval <ms>        Default agent poll interval in milliseconds \
  --output <text|json>
```

### `bgagent repo offboard <owner/repo>`

Soft-delete a repository (`status=removed` + TTL), matching Blueprint delete semantics. An existing Blueprint will re-activate the repo on the next CDK deploy.

```
bgagent repo offboard owner/repo \
  --output <text|json>
```

### `bgagent runtime status`

Show **per-blueprint** effective compute substrate and runtime ARN (merged with platform `RuntimeArn`), then probe unique AgentCore runtimes via the control-plane API. ECS blueprints are listed separately — they use the platform ECS cluster/task definition, not per-repo `runtime_arn`.

```
bgagent runtime status \
  --repo <owner/repo>         Limit to one repository \
  --output <text|json>
```

### `bgagent ops stuck-tasks`

List tasks in `SUBMITTED`, `HYDRATING`, or `AWAITING_APPROVAL` older than the stranded-task reconciler thresholds (defaults: 1200s / 7200s). Text output includes Cognito email plus username UUID.

```
bgagent ops stuck-tasks \
  --stranded-timeout <seconds> \
  --approval-timeout <seconds> \
  --output <text|json>
```

### `bgagent ops concurrency`

Compare `UserConcurrencyTable` counters with live active task counts per user. Resolves Cognito usernames to email (same as `bgagent admin list-users`).

```
bgagent ops concurrency \
  --limit <n>                 Per-user limit (default: 3) \
  --output <text|json>
```

### `bgagent webhook test <webhook-id>`

Send a signed sample payload to `POST /v1/webhooks/tasks` (creates a real task — cancel afterward if this was only a connectivity check).

```
bgagent webhook test <webhook-id> \
  --secret <secret>           From `webhook create` output \
  --fetch-secret              Read secret from Secrets Manager (operator IAM) \
  --repo <owner/repo>         Target repo (defaults to first active repo) \
  --api-url <url>             Defaults to configure api_url or stack ApiUrl \
  --output <text|json>
```

### `bgagent github set-token`

Store a GitHub personal access token in Secrets Manager (interactive masked prompt).

```
bgagent github set-token \
  --repo <owner/repo>         Target a blueprint's per-repo token secret (when configured)
  --secret-arn <arn>          Write to an explicit Secrets Manager ARN
  --region <region>           AWS region (defaults to configured region)
  --stack-name <name>         CloudFormation stack name (default: backgroundagent-dev)
```

With no flags, writes to the platform default `GitHubTokenSecretArn` stack output. When `--repo` is used, the CLI reads `github_token_secret_arn` from `RepoTable` if the Blueprint configured `credentials.githubTokenSecretArn`; otherwise it falls back to the platform default with a notice.

### `bgagent github webhook-info` / `set-webhook-secret`

Configure the preview-deploy screenshot pipeline webhook. See [Deploy preview screenshots guide](../docs/guides/DEPLOY_PREVIEW_SCREENSHOTS_GUIDE.md).

### `bgagent jira setup` / `map` / `invite-user` / `link`

Manage the Jira Cloud integration. `setup` authorizes a tenant via OAuth (3LO) and stores the token in Secrets Manager; `map` routes a Jira project to a GitHub repo; the two-step `invite-user` → `link` handshake links a teammate's Jira identity to their platform user. See the [Jira setup guide](../docs/guides/JIRA_SETUP_GUIDE.md) for the full walkthrough.

```
bgagent jira setup \
  --stack-name backgroundagent-dev

bgagent jira map <cloud-id> <PROJECT-KEY> --repo owner/repo

bgagent jira invite-user <cloud-id> <account-id-or-email> \
  --region <region>            AWS region (defaults to configured region) \
  --stack-name <name>          CloudFormation stack name (default: backgroundagent-dev)

bgagent jira link <code>
```

`invite-user` resolves the teammate's Jira identity through the tenant OAuth token, then writes a `pending#<code>` row (24h TTL) and prints the `bgagent jira link <code>` the teammate runs from their own machine. The teammate previews the Jira identity before confirming, so a wrong pick can be aborted rather than misattributed. If the identity is already linked, the command warns but still issues the code.

### `bgagent admin invite-user` / `list-users` / `delete-user` / `reset-password`

Manage Cognito users with operator AWS credentials (`cognito-idp:Admin*` on the deployment user pool). Works **before** `bgagent configure` when `--stack-name` is passed (reads `UserPoolId` from CloudFormation).

```
bgagent admin invite-user <email> \
  --stack-name backgroundagent-dev \
  --password <pwd>              # optional; auto-generated if omitted

bgagent admin list-users \
  --output <text|json>

bgagent admin delete-user <email>

bgagent admin reset-password <email> \
  --password <pwd>              # optional; auto-generated if omitted
```

`invite-user` creates the user, sets a permanent password, and writes credentials plus an optional configure bundle to `~/.bgagent/invites/<email>.txt` (mode 0600). Replaces Quick Start Step 5 raw `aws cognito-idp` commands.

## Output formats

**Text mode** (default) prints human-readable output:
- `status` and `submit` show a key-value detail view
- `list` shows an aligned table (TASK ID, STATUS, REPO, CREATED, DESCRIPTION)
- `events` shows a timeline (TIMESTAMP, EVENT TYPE, METADATA)
- `webhook create` shows webhook details and the one-time HMAC secret
- `webhook list` shows an aligned table (WEBHOOK ID, NAME, STATUS, CREATED)
- `webhook revoke` shows the revoked webhook details

For failed tasks, the error display is structured when a classification is available:

```
Error:       [CONCURRENCY] Concurrency limit reached
             The maximum number of concurrent tasks for this user has been reached.
  Remedy:    Wait for an active task to complete, cancel a running task, or ask an admin to increase the limit.
  Retryable: yes
  Detail:    User concurrency limit reached
```

The classifier covers 9 error categories: `auth`, `network`, `concurrency`, `compute`, `agent`, `guardrail`, `config`, `timeout`, and `unknown`. When no classification is available, the raw error message is shown.

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
