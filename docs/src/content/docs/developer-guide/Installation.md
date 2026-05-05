---
title: Installation
---

Follow the [Quick Start](/getting-started/quick-start) to clone, install, deploy, and submit your first task. It covers prerequisites, toolchain setup, deployment, PAT configuration, Cognito user creation, and a smoke test.

This section covers what the Quick Start does not: troubleshooting, local testing, and the development workflow.

### Troubleshooting mise

If `mise run install` fails or versions look wrong:

| Symptom | Fix |
|---------|-----|
| `yarn: command not found` | Activate mise in your shell (`eval "$(mise activate zsh)"`), then `corepack enable && corepack prepare yarn@1.22.22 --activate`. |
| `node` is not v22 | Activate mise in your shell, then `mise install` from the repo root. |
| Mise errors about untrusted config | `mise trust` from the repo root, then `mise install` again. |
| `MISE_EXPERIMENTAL` required | `export MISE_EXPERIMENTAL=1` for namespaced tasks like `mise //cdk:build`. |

Minimal recovery sequence:

```bash
eval "$(mise activate zsh)"   # or bash; add permanently to your shell rc file
cd /path/to/sample-autonomous-cloud-coding-agents
mise trust && mise install
corepack enable && corepack prepare yarn@1.22.22 --activate
export MISE_EXPERIMENTAL=1
mise run install
```

### Development workflow

Use this order to iterate quickly and catch issues early:

1. **Test Python agent code first** (fast feedback):

   ```bash
   cd agent && mise run quality && cd ..
   ```

2. **Test through the local Docker runtime** using `./agent/run.sh` (see Local testing below).
3. **Deploy with CDK** once local checks pass.

### Local testing

Before deploying, you can run the agent Docker container locally. The `agent/run.sh` script builds the image, resolves AWS credentials, and applies AgentCore-matching resource constraints (2 vCPU, 8 GB RAM) so the local environment mirrors production.

The script validates AWS credentials before starting the Docker build, so problems like an expired SSO session surface immediately.

#### Setup

The `owner/repo` you pass must match an onboarded Blueprint and be a repository your `GITHUB_TOKEN` can push to and open PRs on.

```bash
export GITHUB_TOKEN="ghp_..."     # Fine-grained PAT
export AWS_REGION="us-east-1"     # Region where Bedrock models are enabled
```

The script resolves AWS credentials in priority order:

1. **Environment variables** - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN` for temporary credentials.
2. **AWS CLI** - Runs `aws configure export-credentials` from your active profile or SSO session. Set `AWS_PROFILE` to target a specific profile.
3. **`~/.aws` mount** - Bind-mounts the directory read-only. Works for static credentials but not SSO tokens.

If none succeeds, the container starts without AWS credentials and any AWS API call will fail at runtime.

#### Running tasks

```bash
# Run against a GitHub issue
./agent/run.sh "owner/repo" 42

# Run with a text description
./agent/run.sh "owner/repo" "Add input validation to the /users POST endpoint"

# Issue + additional instructions
./agent/run.sh "owner/repo" 42 "Focus on the backend validation only"

# Dry run - validate config, fetch issue, print prompt, then exit
DRY_RUN=1 ./agent/run.sh "owner/repo" 42
```

The second argument is auto-detected: numeric values are issue numbers, anything else is a task description.

#### Server mode

In production, the container runs as a FastAPI server. You can test this locally:

```bash
# Start the server
./agent/run.sh --server "owner/repo"

# In another terminal:
curl http://localhost:8080/ping

curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d ‘{"input":{"prompt":"Fix the login bug","repo_url":"owner/repo"}}’
```

#### Monitoring

The container runs with a fixed name (`bgagent-run`):

```bash
docker logs -f bgagent-run                        # live agent output
docker stats bgagent-run                          # CPU, memory usage
docker exec -it bgagent-run bash                  # shell into the container
```

#### Testing with progress events (DynamoDB Local)

By default, progress events and task state writes are silently skipped during local runs (the `TASK_EVENTS_TABLE_NAME` and `TASK_TABLE_NAME` env vars are not set). To enable them locally using DynamoDB Local:

```bash
# 1. Start DynamoDB Local and create tables
cd agent && mise run local:up

# 2. Run the agent with --local-events
./agent/run.sh --local-events "owner/repo" 42

# 4. In another terminal — query progress events
mise run local:events          # table format
mise run local:events:json     # JSON format

# 5. When done — tear down DynamoDB Local
mise run local:down
```

The `--local-events` flag connects the agent container to DynamoDB Local on the `agent-local` Docker network and sets the appropriate env vars. The agent code writes to DDB Local using the same code path as production — no mocks or alternate implementations.

#### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_MODEL` | `us.anthropic.claude-sonnet-4-6` | Bedrock model ID |
| `MAX_TURNS` | `100` | Max agent turns before stopping |
| `MAX_BUDGET_USD` | | Cost ceiling for local batch runs only (production uses the API field) |
| `DRY_RUN` | | Set to `1` to validate and print prompt without running the agent |

For the full list, see `agent/README.md`.

#### Troubleshooting

| Symptom | Fix |
|---|---|
| `ERROR: Failed to resolve AWS credentials via AWS CLI` | Run `aws sso login` if using SSO, or export `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` directly. |
| `ERROR: GITHUB_TOKEN is not set` | Export `GITHUB_TOKEN` with the required scopes. |
| `WARNING: No AWS credentials detected` | Configure one of the three credential methods above. |
| `WARNING: Image exceeds AgentCore 2 GB limit!` | Reduce dependencies or use multi-stage Docker build. |

### Deployment

Follow the [Quick Start](/getting-started/quick-start) steps 3-6 for first-time deployment. For subsequent deploys after code changes:

```bash
mise run build
mise run //cdk:deploy
```

A full deploy takes approximately 10 minutes. Expect variation by region and whether container layers are cached.

### Stack outputs

After deployment, the stack emits these outputs (retrieve with `aws cloudformation describe-stacks --stack-name backgroundagent-dev --query ‘Stacks[0].Outputs’ --output table`):

| Output | Description |
|---|---|
| `RuntimeArn` | AgentCore runtime ARN |
| `ApiUrl` | Task REST API base URL |
| `UserPoolId` / `AppClientId` | Cognito identifiers |
| `TaskTableName` | DynamoDB table for task state |
| `TaskEventsTableName` | DynamoDB table for audit events |
| `UserConcurrencyTableName` | DynamoDB table for per-user concurrency |
| `WebhookTableName` | DynamoDB table for webhook integrations |
| `RepoTableName` | DynamoDB table for per-repo Blueprint config |
| `GitHubTokenSecretArn` | Secrets Manager secret ARN for the GitHub PAT |

Use the same AWS Region as your deployment. If `--region` is omitted, the CLI uses your default from `aws configure`.