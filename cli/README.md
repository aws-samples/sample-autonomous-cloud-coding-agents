# bgagent CLI

Command-line interface for the ABCA platform. Submit coding tasks, monitor their status, and manage results, all through the deployed REST API with Cognito authentication.

## Installation

The CLI is not published to npm, because its package (`@abca/cli`) is private. Build it in the monorepo (`mise run install`, then `mise //cli:build`) and run it from there:

```bash
node cli/lib/bin/bgagent.js
```

The examples below write `bgagent` for that command.

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

Operator commands (`platform`, `repo`, `github set-token`) use **operator AWS credentials** directly. They do not require a Cognito login.

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

The first run of `bgagent configure` needs all four core fields. The easiest ways to supply them are `--stack-name backgroundagent-dev --region …` (the same outputs as `bgagent platform outputs`) or `--from-bundle` after `admin invite-user`. Individual flags override stack-derived values.

Pointing the CLI at another user pool removes the cached login (`~/.bgagent/credentials.json`), because its tokens belong to the previous deployment. Run `bgagent login` again.

### `bgagent login`

Authenticate with Cognito and cache tokens locally.

```
bgagent login \
  --username <email>      Cognito username (required)
  --password <password>   Password (prompts interactively if omitted)
```

The CLI saves tokens to `~/.bgagent/credentials.json` (mode 0600). It refreshes expired tokens automatically with the cached refresh token.

**First login (invited users).** `admin invite-user` issues a *temporary* password, so your first login is a rotation. Cognito returns a `NEW_PASSWORD_REQUIRED` challenge, and the CLI prompts you to set and confirm a permanent password. That password replaces the temporary one that the admin shared. Run the login interactively and **omit `--password`** so that the CLI can prompt. If you pass `--password`, or pipe input on a non-TTY, the CLI skips the rotation prompt and fails with a "log in interactively" error instead of hanging. Temporary passwords also expire after a few days. If yours has lapsed, the login reports that and asks the admin to run `invite-user` again.

### `bgagent change-password`

Rotate the signed-in user's Cognito password. The command requires an active `bgagent login` session.

```
bgagent change-password
```

The command prompts for your current password, then for the new password twice (masked). Cognito enforces the pool's password policy on the new value. By default the policy is a minimum of 12 characters with an upper-case letter, a lower-case letter, a digit, and a symbol. The command takes no flags. The current-password prompt is also the verification, and the CLI reads the username from your cached session, so you never retype your email.

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

The repository must be onboarded to the platform through a `Blueprint` CDK construct. If the repository is not onboarded, the API returns a `REPO_NOT_ONBOARDED` error.

With `--wait`, the CLI polls until the task reaches a terminal status (COMPLETED, FAILED, CANCELLED, TIMED_OUT). It then exits with code 0 for COMPLETED and with code 1 otherwise. If the CLI stops waiting before that, because the API keeps failing or the maximum wait is reached, it exits with code 2. The task may still be running.

### `bgagent list`

List tasks for the authenticated user.

```
bgagent list \
  --status <s1,s2,...>         Filter by status (comma-separated)
  --repo <owner/repo>         Filter by repository
  --limit <n>                 Maximum results to return
  --output <text|json>        Output format (default: text)
```

The `HEARTBEAT` column is the age of the agent's last in-guest liveness beat. It answers `is anything still alive?` across tasks, without one `bgagent status` per task. The agent beats every 45 s on the `agentcore` and `lambda-microvm` backends, so an age much past that on a `RUNNING` task means the agent is hung. The column shows `—` for terminal tasks, where the last beat is noise next to a final status. It also shows `—` on `ecs`, where the agent runs the pipeline directly instead of serving HTTP and so beats only once, at start.

### `bgagent budget status --me`

Show the logged-in user's personal monthly estimated spend and administrator-configured limit:

```
bgagent budget status --me [--output text|json]
```

This path uses Cognito authentication and requires no operator AWS credentials. It is read-only, does not expose team budgets, and reports personal spend even when no personal limit is configured.

### `bgagent stats`

Show the scoreboard of your own finished tasks: how the work you handed to agents turned into verified and merged pull requests, what it took of your attention and money, and whether it stayed inside the rules.

```
bgagent stats \
  --range <7d|30d>             Period the scoreboard covers (default: 30d)
  --repo <owner/repo>          Count the tasks of one repository only
  --output <text|json>         Output format (default: text)
```

The numbers are those of the console's Scoreboard page, under its four headings. Each number comes with the counts it rests on and, where the page compares, with the number of the period before. A number with nothing to compute it from shows `-` and the reason. `--output json` prints the response of `GET /v1/tasks?view=scoreboard`. [Factory scoreboard](../docs/design/OBSERVABILITY.md#factory-scoreboard) says what each number counts and leaves out. [Reading your scoreboard (stats)](../docs/guides/USER_GUIDE.md#reading-your-scoreboard-stats) gives the command's limits.

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

Create a new webhook integration. The CLI displays the HMAC secret once, at creation time. Store it securely.

The output also shows the webhook URL (`webhook_url` in JSON output), which is the endpoint to enter in the external system. The URL belongs to the API deployment, not to the webhook, so it is the same for every webhook and you do not need to fetch it again.

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

These commands support day-2 operations with **operator AWS credentials** (an IAM profile or the environment). They read CloudFormation outputs, DynamoDB, and Secrets Manager directly and require no Cognito login. The read-only and introspection commands (`platform`, `repo`, `runtime`, `ops`, `webhook test`, `admin list-users`) support `--output json` for scripting. The credential-writing commands (`github set-token`/`set-webhook-secret`, `admin invite-user`/`delete-user`/`reset-password`) do not.

Shared flags:

| Flag | Description |
|------|-------------|
| `--region <region>` | AWS region (defaults to `bgagent configure` region or `AWS_REGION`) |
| `--stack-name <name>` | CloudFormation stack name (default: `backgroundagent-dev`) |

### `bgagent setup`

Choose optional features, validate them against the target Region, and deploy from your ABCA checkout ([deployment profiles](../docs/guides/DEPLOYMENT_GUIDE.md#deployment-profiles)):

```
bgagent setup [--region <region>] [--stack-name <name>] [--repo-root <dir>]
bgagent setup --features slack,jira --yes          # non-interactive
bgagent setup --compute agentcore,ecs --features none --yes   # new install on both backends
bgagent setup --features none --no-deploy          # write abca.deployment.json only
bgagent setup -c networkTopology=split             # extra CDK context for diff and deploy (repeatable)
```

The wizard first confirms the AWS account that your credentials resolve to. It then lets you update an existing deployment or create a new one, which you name. For a new installation it then asks where agents run (AgentCore, ECS, or both), and prepares the account (CDK bootstrap) if needed. It then asks yes or no for each feature, shows a review screen, summarizes the changes, and asks to deploy. During the deployment it shows live progress for each component, and then the result: complete, or the failed component and its cause. The wizard writes raw CDK output to `~/.bgagent/logs/<stack>/setup-changes.log` and `setup-deploy.log`. New stacks default to the governed minimal profile. Existing stacks preselect their deployed features. Before it writes `abca.deployment.json`, the wizard shows `cdk diff` and asks for confirmation. A change that deletes, replaces or orphans state-bearing resources needs the stack name typed back, or `--yes --accept-data-loss` when non-interactive. The same applies when `--no-deploy` removes a stateful feature. Cancelling exits with code 130 and leaves the repository unchanged. After it deploys, the wizard configures the CLI from the stack outputs. The features are `slack`, `linear`, `jira`, `deployPreviewScreenshots`, `agentRegistry`, and `toolGateway`. A feature or compute backend that the Region does not support fails with the list of supported Regions, before the diff.

Commands for a feature the stack omits (for example `bgagent slack setup`) fail and point back to `bgagent setup`.

### `bgagent budget status|set`

Inspect or configure the recurring monthly USD limit of a user or a team with operator AWS credentials:

```
bgagent budget status [--user <email-or-id> | --team <cognito-group>] [--output text|json]
bgagent budget set (--user <email-or-id> | --team <cognito-group>) \
  --monthly-usd <amount> [--hard-stop]
```

`set` replaces the scope's recurring limit. Without `--hard-stop`, admission stays open after 100% and the 80% and 100% alerts remain. Team scopes are existing Cognito groups. The command does not create groups or manage membership.

### `bgagent platform outputs`

Print CloudFormation stack outputs, such as `ApiUrl`, `UserPoolId`, `AppClientId`, and `GitHubTokenSecretArn`.

```
bgagent platform outputs \
  --output <text|json>         Output format (default: text)
```

### `bgagent platform doctor`

Smoke-check the readiness of the deployed platform: Task API reachable, Cognito pool and client valid, platform GitHub token populated, at least one active onboarded repository, Bedrock model visible.

```
bgagent platform doctor \
  --output <text|json>         Output format (default: text)
```

The command exits with code 1 when any check fails. Warnings are acceptable.

### `bgagent repo list`

List the repositories onboarded through Blueprint constructs. The command reads `RepoTable`.

```
bgagent repo list \
  --status <active|removed>    Filter by status
  --output <text|json>        Output format (default: text)
```

### `bgagent repo show <owner/repo>`

Show the full `RepoConfig` for a repository. The command redacts secret ARNs. When no per-blueprint token is configured, the output shows that the repository uses the **platform default** GitHub PAT (`GitHubTokenSecretArn`), not an empty or missing token. When no per-blueprint model is configured, the output shows the **platform default** model as this deployment invokes it, with the geography of the stack's `BedrockGeoRegion` output (`us.anthropic.…` on a stack deployed with `-c bedrockGeoRegion=us`). A stack that predates that output shows the shipped `global.` profile.

```
bgagent repo show owner/repo \
  --output <text|json>        Output format (default: text)
```

### `bgagent repo onboard <owner/repo>`

Register or re-activate a repository in `RepoTable` without a CDK redeploy. With no overrides, tasks use the platform `RuntimeArn` and `GitHubTokenSecretArn`. IAM for both is already granted at deploy. Custom `--runtime-arn` or `--token-secret-arn` values require matching `TaskOrchestrator` IAM through CDK. The command prints notes that explain this. Prefer CDK `Blueprint` constructs for durable lifecycle, Cedar policies, and egress validation.

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

Soft-delete a repository (`status=removed` plus a TTL), as a Blueprint delete does. An existing Blueprint re-activates the repository on the next CDK deploy.

```
bgagent repo offboard owner/repo \
  --output <text|json>
```

### `bgagent runtime status`

Show the effective compute substrate and runtime ARN of each blueprint (merged with the platform `RuntimeArn`), then probe the unique AgentCore runtimes through the control-plane API. The command lists ECS blueprints separately, because they use the platform ECS cluster and task definition, not a per-repository `runtime_arn`.

```
bgagent runtime status \
  --repo <owner/repo>         Limit to one repository \
  --output <text|json>
```

### `bgagent ops stuck-tasks`

List tasks that have been in `SUBMITTED`, `HYDRATING`, or `AWAITING_APPROVAL` longer than the thresholds of the stranded-task reconciler (defaults: 1200s and 7200s). Text output includes the Cognito email and the username UUID. `AGE(s)` or `age_seconds` is the time in the current status. The command lists rows oldest-created first.

```
bgagent ops stuck-tasks \
  --stranded-timeout <seconds> \
  --approval-timeout <seconds> \
  --output <text|json>
```

### `bgagent ops concurrency`

Compare the `UserConcurrencyTable` counters with the live count of active tasks for each user. The command resolves Cognito usernames to emails, as `bgagent admin list-users` does.

```
bgagent ops concurrency \
  --limit <n>                 Per-user limit (default: 10) \
  --output <text|json>
```

### `bgagent webhook test <webhook-id>`

Send a signed sample payload to `POST /v1/webhooks/tasks`. The request creates a real task. If you only wanted a connectivity check, cancel the task afterward.

```
bgagent webhook test <webhook-id> \
  --secret <secret>           From `webhook create` output \
  --fetch-secret              Read secret from Secrets Manager (operator IAM) \
  --repo <owner/repo>         Target repo (defaults to first active repo) \
  --api-url <url>             Defaults to configure api_url or stack ApiUrl \
  --output <text|json>
```

### `bgagent github set-token`

Store a GitHub personal access token in Secrets Manager. The command reads the token from an interactive masked prompt.

```
bgagent github set-token \
  --repo <owner/repo>         Target a blueprint's per-repo token secret (when configured)
  --secret-arn <arn>          Write to an explicit Secrets Manager ARN
  --region <region>           AWS region (defaults to configured region)
  --stack-name <name>         CloudFormation stack name (default: backgroundagent-dev)
```

With no flags, the command writes to the platform default `GitHubTokenSecretArn` stack output. With `--repo`, the CLI reads `github_token_secret_arn` from `RepoTable` if the Blueprint configured `credentials.githubTokenSecretArn`. Otherwise it falls back to the platform default and prints a notice.

### `bgagent github webhook-info` / `set-webhook-secret`

Configure the webhook of the preview-deploy screenshot pipeline. See the [Deploy preview screenshots guide](../docs/guides/DEPLOY_PREVIEW_SCREENSHOTS_GUIDE.md).

### `bgagent jira app-template` / `setup` / `update-webhook-secret` / `app-setup` / `map` / `invite-user` / `link`

Manage the Jira Cloud integration. `setup` authorizes a tenant through OAuth (3LO) for inbound reads and human lookup. `update-webhook-secret` rotates the admin-console webhook secret in both required Secrets Manager locations without repeating OAuth. `app-setup` verifies and stores the signed Forge proxy used for outbound comments and transitions as the dedicated `bgagent` app actor. `map` routes a Jira project to a GitHub repository. The two-step handshake, `invite-user` then `link`, links a teammate's Jira identity to their platform user. See the [Jira setup guide](../docs/guides/JIRA_SETUP_GUIDE.md) for Forge deployment, secret handling, permissions, and the full walkthrough.

```
bgagent jira app-template

bgagent jira setup \
  --region <region> \
  --stack-name <stack-name>

bgagent jira update-webhook-secret <cloud-id> \
  --region <region> \
  --stack-name <stack-name>

bgagent jira app-setup <cloud-id> \
  --proxy-url https://<installation>.webtrigger.atlassian.app/public/<id> \
  --region <region> \
  --stack-name <stack-name>

bgagent jira map <cloud-id> <PROJECT-KEY> \
  --repo owner/repo \
  --region <region> \
  --stack-name <stack-name>

bgagent jira invite-user <cloud-id> <account-id-or-email> \
  --region <region>            AWS region (defaults to configured region) \
  --stack-name <name>          CloudFormation stack name (default: backgroundagent-dev)

bgagent jira link <code>
```

All Jira admin commands default to `backgroundagent-dev`. Pass `--stack-name` for every custom stack. `app-setup` prompts for `BGAGENT_PROXY_SECRET` so that the value stays out of shell history. It refuses to save unless the Forge identity probe returns `accountType=app` from the expected Jira site.

`invite-user` resolves the teammate's Jira identity through the tenant OAuth token, then writes a `pending#<code>` row (24h TTL) and prints the `bgagent jira link <code>` command that the teammate runs from their own machine. The teammate previews the Jira identity before confirming, so the teammate can abort a wrong pick instead of misattributing it. If the identity is already linked, the command warns but still issues the code.

### `bgagent admin invite-user` / `list-users` / `delete-user` / `reset-password`

Manage Cognito users with operator AWS credentials (`cognito-idp:Admin*` on the deployment user pool). The commands work **before** `bgagent configure` when you pass `--stack-name`, because they then read `UserPoolId` from CloudFormation.

```
bgagent admin invite-user <email> \
  --stack-name backgroundagent-dev \
  --password <pwd>              # optional temporary password; auto-generated if omitted

bgagent admin list-users \
  --output <text|json>

bgagent admin delete-user <email>

bgagent admin reset-password <email> \
  --password <pwd>              # optional; auto-generated if omitted
```

`invite-user` creates the user with a *temporary* password, which the teammate rotates on their first `bgagent login`. It writes the credentials and an optional configure bundle to `~/.bgagent/invites/<email>.txt` (mode 0600). The temporary password stops being valid once the teammate sets their own, so the string that the admin shared never becomes a standing credential. `reset-password` instead sets a *permanent* password for an existing user, with no first-login rotation. These commands replace the raw `aws cognito-idp` commands of Quick Start Step 5.

## Output formats

**Text mode** (default) prints human-readable output:
- `status` and `submit` show a key-value detail view
- `list` shows an aligned table (TASK ID, STATUS, REPO, CREATED, HEARTBEAT, DESCRIPTION)
- `events` shows a timeline (TIMESTAMP, EVENT TYPE, METADATA)
- `webhook create` shows webhook details, the URL to post tasks to, and the one-time HMAC secret
- `webhook list` shows an aligned table (WEBHOOK ID, NAME, STATUS, CREATED)
- `webhook revoke` shows the revoked webhook details

For failed tasks, the error display is structured when a classification is available:

```
Error:       [AUTH] Repository not found or inaccessible
             The GitHub token cannot access the target repository. It may not exist or the token lacks visibility.
  Remedy:    Check that the repository name is correct and the configured PAT has access to it.
  Retryable: no
  Detail:    Pre-flight check failed: REPO_NOT_FOUND_OR_NO_ACCESS — GitHub API returned HTTP 404 for acme/widgets
```

The classifier covers 10 error categories: `auth`, `network`, `concurrency`, `compute`, `agent`, `guardrail`, `config`, `timeout`, `blocked`, and `unknown`. When no classification is available, the CLI shows the raw error message.

**JSON mode** (`--output json`) prints the raw API response as pretty-printed JSON, suitable for piping to `jq` or other tools.

## Configuration

The CLI stores its configuration in `~/.bgagent/`:

| File | Contents | Permissions |
|------|----------|-------------|
| `config.json` | `api_url`, `region`, `user_pool_id`, `client_id` | 0644 |
| `credentials.json` | `id_token`, `refresh_token`, `token_expiry` | 0600 |

To override the config directory, set the `BGAGENT_CONFIG_DIR` environment variable.

## Authentication

The CLI uses Cognito `USER_PASSWORD_AUTH` for the initial login and `REFRESH_TOKEN_AUTH` for automatic token refresh. It refreshes tokens when they are within 5 minutes of expiry. If the refresh token itself has expired, the CLI prompts you to run `bgagent login` again.

## License

Apache-2.0
