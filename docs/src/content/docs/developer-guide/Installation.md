---
title: "Installation"
---

Follow the [Quick Start](/sample-autonomous-cloud-coding-agents/getting-started/quick-start) to clone, install, deploy, and submit your first task. It covers prerequisites, toolchain setup, deployment, PAT configuration, Cognito user creation, and a smoke test.

### Open the contributor dev container

- **Local VS Code.** Start Docker and install the **Dev Containers** extension. Open a fresh clone of ABCA in VS Code, then choose **Dev Containers: Reopen in Container** from the Command Palette.
- **GitHub Codespaces.** On the repository page, select your branch, open **Code → Codespaces**, and create a codespace on that branch. GitHub opens the editor in your browser.

If you already have a **linked issue worktree** on your machine, its `.git` file points outside the folder that VS Code mounts. From that worktree, create a standalone copy of the issue branch for the container. Choose an unused sibling directory and open it in VS Code. The clone includes committed work only.

```bash
branch=$(git branch --show-current)
git clone --no-local --branch "$branch" . ../abca-dev
git -C ../abca-dev remote set-url origin "$(git remote get-url origin)"
```

The post-create hook installs the tools declared in the repo's mise configs, enables Yarn Classic, and runs `mise run install` for the workspace dependencies, the agent's Python environment, and Git hooks. Once setup finishes, run `mise run build` in the container terminal from the repository root. The build can run without AWS credentials.

After changing `.devcontainer/`, choose **Dev Containers: Rebuild Container** in local VS Code or **Codespaces: Rebuild Container** in a codespace.

#### Push commits from the dev container

The default container has no Docker engine connection. The pre-push hook needs Docker to build and scan the worker image during `mise run security`. The optional `mise run test:integration` suite also needs Docker. Commit your changes in the container, then push from a **separate host worktree** with Docker running and the [Quick Start toolchain](/sample-autonomous-cloud-coding-agents/getting-started/quick-start) installed. That arrangement keeps the Linux `node_modules` and `agent/.venv` in the container checkout. See the [emulator guide](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/scripts/aws-emulator/README.md) for integration tests.

- **Local VS Code.** From your host checkout, run `git fetch ../abca-dev <issue-branch>`, substituting your branch name and the path to the container checkout.
- **Codespaces.** On the issue branch in the codespace, run `git bundle create abca-issue.bundle HEAD`. Right-click `abca-issue.bundle` in the browser editor's Explorer, select **Download**, then delete the untracked bundle from the codespace. From your host checkout, run `git fetch ~/Downloads/abca-issue.bundle HEAD`, adjusting the path to the downloaded file.

If you fetched from a host worktree already on the issue branch, run `git merge --ff-only FETCH_HEAD` there. If the issue branch exists only in the container, run `git worktree add -b <issue-branch> ../abca-host FETCH_HEAD` and `cd ../abca-host` to create its host worktree. Run `mise run install` in the host worktree to install native dependencies and Git hooks, then `git push -u origin HEAD` to run the pre-push checks and publish the commits.

### Troubleshooting mise

If `mise run install` fails or versions look wrong:

| Symptom | Fix |
|---------|-----|
| `yarn: command not found` | Activate mise in your shell (`eval "$(mise activate zsh)"`), then `corepack enable && corepack prepare yarn@1.22.22 --activate`. |
| `node` is not v22 | Activate mise in your shell, then `mise install` from the repo root. |
| Mise errors about untrusted config | `mise trust` from the repo root, then `mise install` again. |

Minimal recovery sequence:

```bash
eval "$(mise activate zsh)"   # or bash; add permanently to your shell rc file
cd /path/to/sample-autonomous-cloud-coding-agents
mise trust && mise install
corepack enable && corepack prepare yarn@1.22.22 --activate
mise run install
```

**When the `build` job fails in CI.** Start from the job summary. It names the mise task that failed and shows the last lines of that task's output. The JUnit reports of the cdk, cli and agent test suites are attached to the run as the `test-reports-agentcore` artifact. A lockfile that no longer matches its manifest fails early. `yarn.lock` fails right after the install, in the step `Fail on lockfile drift`. To fix it, run `mise run install` locally and commit the rewritten file. `agent/uv.lock` fails in the install itself, which runs `uv sync --locked`. To fix it, run `uv lock` in `agent/` and commit the file.

### Development workflow

Use this order to get fast feedback and to catch problems early:

1. **Test Python agent code first** (fast feedback):

   ```bash
   cd agent && mise run quality && cd ..
   ```

2. **Test through the local Docker runtime** with `./agent/run.sh` (see Local testing below).
3. **Deploy with CDK** once local checks pass.

### Local testing

Before you deploy, you can run the agent Docker container locally. The `agent/run.sh` script builds the image, resolves AWS credentials, and applies the resource constraints of AgentCore (2 vCPU, 8 GB RAM), so that the local environment matches production.

The script validates AWS credentials before it starts the Docker build, so a problem such as an expired SSO session shows before the build.

#### Setup

The `owner/repo` you pass must match an onboarded Blueprint and must be a repository that your `GITHUB_TOKEN` can push to and open PRs on.

```bash
export GITHUB_TOKEN="ghp_..."     # Fine-grained PAT
export AWS_REGION="us-east-1"     # Region where Bedrock models are enabled
```

The script resolves AWS credentials in priority order:

1. **Environment variables.** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN` for temporary credentials.
2. **AWS CLI v2.** The script runs `aws configure export-credentials` from your active profile or SSO session. Set `AWS_PROFILE` to target a specific profile. AWS CLI v1 has no such command, so with v1 the script goes on to the mount.
3. **`~/.aws` mount.** The script bind-mounts the directory read-only. The mount works for static credentials but not for SSO tokens.

If none succeeds, the container starts without AWS credentials, and every AWS API call fails at runtime.

#### Running tasks

```bash
# Run against a GitHub issue
./agent/run.sh "owner/repo" 42

# Run with a text description
./agent/run.sh "owner/repo" "Add input validation to the /users POST endpoint"

# Issue + additional instructions
./agent/run.sh "owner/repo" 42 "Focus on the backend validation only"

# Dry run - validate config, fetch issue, print the length and hash of the prompts, then exit
DRY_RUN=1 ./agent/run.sh "owner/repo" 42
```

The script detects the type of the second argument. A numeric value is an issue number. Anything else is a task description.

#### Server mode

In production, the container runs as a FastAPI server. You can test that mode locally:

```bash
# Start the server
./agent/run.sh --server "owner/repo"

# In another terminal:
curl http://localhost:8080/ping

curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"input":{"prompt":"Fix the login bug","repo_url":"owner/repo"}}'
```

#### Monitoring

The container runs with a fixed name (`bgagent-run`):

```bash
docker logs -f bgagent-run                        # live agent output
docker stats bgagent-run                          # CPU, memory usage
docker exec -it bgagent-run bash                  # shell into the container
```

#### Testing with progress events (DynamoDB Local)

By default, local runs silently skip progress events and task state writes, because the `TASK_EVENTS_TABLE_NAME` and `TASK_TABLE_NAME` env vars are not set. To enable them locally with DynamoDB Local:

```bash
# 1. Start DynamoDB Local and create tables
mise //agent:local:up

# 2. Run the agent with --local-events
./agent/run.sh --local-events "owner/repo" 42

# 3. In another terminal — query progress events
mise //agent:local:events          # table format
mise //agent:local:events:json     # JSON format

# 4. When done — tear down DynamoDB Local
mise //agent:local:down
```

The `--local-events` flag connects the agent container to DynamoDB Local on the `agent-local` Docker network and sets the env vars that the writes need. The agent code writes to DynamoDB Local through the same code path as production, with no mocks or alternate implementations.

#### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_MODEL` | `global.anthropic.claude-opus-5-5` | Bedrock inference-profile ID for the main coding model |
| `MAX_TURNS` | `100` | Max agent turns before stopping |
| `MAX_BUDGET_USD` | | Cost ceiling for local batch runs only (production uses the API field) |
| `DRY_RUN` | | Set to `1` to validate and print the length and hash of the prompts without running the agent |

For the full list, see `agent/README.md`. For how the model default is layered, overridden, and priced, see [Model configuration](/sample-autonomous-cloud-coding-agents/developer-guide/model-configuration).

#### Troubleshooting

| Symptom | Fix |
|---|---|
| `ERROR: Failed to resolve AWS credentials via AWS CLI` | If you use SSO, run `aws sso login`. Otherwise export `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` directly. |
| `ERROR: GITHUB_TOKEN is not set` | Export `GITHUB_TOKEN` with the required scopes. |
| `WARNING: No AWS credentials detected` | Configure one of the three credential methods above. |
| `WARNING: Image exceeds AgentCore 2 GB limit!` | Reduce dependencies or use a multi-stage Docker build. |
| Bedrock or model errors in agent logs (for example, model not available on your deployment, or zero tokens) | IAM `grantInvoke` is not enough. The account must meet [Bedrock model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) and use a supported [inference profile](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-use.html) ID in `ANTHROPIC_MODEL` or the task `model_id` where required. Complete the Anthropic FTU and Marketplace prerequisites that the Bedrock User Guide describes. Align the `cdk/src/stacks/agent.ts` grants with the chosen profile and Region. |

### Deployment

For a first deployment, follow steps 3-6 of the [Quick Start](/sample-autonomous-cloud-coding-agents/getting-started/quick-start). For later deploys after code changes:

```bash
mise run build
mise //cdk:deploy
```

A full deploy takes about 10 minutes. The time varies by region and by whether container layers are cached.

Deleting a stack (`mise //cdk:destroy`) can end in `DELETE_FAILED` on the runtime's security group and the VPC's private subnets. AgentCore releases the runtime's network interfaces some time after the runtime is deleted. The delay is not fixed and can be hours. [Teardown blocked by AgentCore network interfaces](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#teardown-blocked-by-agentcore-network-interfaces) in the deployment guide shows how to inspect the stack, when to retry, and how to finish the deletion by retaining the blocked resources.

### Stack outputs

After deployment, the stack emits the outputs below. Retrieve them with `aws cloudformation describe-stacks --stack-name backgroundagent-dev --query 'Stacks[0].Outputs' --output table`.

| Output | Description |
|---|---|
| `RuntimeArn` | AgentCore runtime ARN |
| `ApiUrl` | Task REST API base URL |
| `UserPoolId` / `AppClientId` | Cognito identifiers |
| `TaskTableName` | DynamoDB table for task state |
| `TaskEventsTableName` | DynamoDB table for audit events |
| `TaskNudgesTableName` | DynamoDB table for task nudges |
| `TaskApprovalsTableName` | DynamoDB table for Cedar HITL approval gates |
| `UserConcurrencyTableName` | DynamoDB table for per-user concurrency |
| `BudgetTableName` | DynamoDB table for recurring user/team limits and monthly estimated spend |
| `WebhookTableName` | DynamoDB table for webhook integrations |
| `RepoTableName` | DynamoDB table for per-repo Blueprint config |
| `CedarWasmLayerArn` | Lambda layer ARN for the Cedar WASM policy engine |
| `TraceArtifactsBucketName` | S3 bucket for agent trace artifacts (7-day lifecycle) |
| `GitHubTokenSecretArn` | Secrets Manager secret ARN for the GitHub PAT |
| `OperationalAlertsTopicArn` | ARN of the `OperationalAlerts` topic, the SNS topic that every CloudWatch alarm of the stack notifies (Lambda errors, DLQ depth, monthly budgets, webhook screening, XSS matches on the signed webhook routes) |

When the Slack or Linear integrations are enabled, the stack emits more outputs (for example, `Slack*` and `Linear*` secret ARNs and integration table names).

Use the same AWS Region as your deployment. If `--region` is omitted, the CLI uses your default from `aws configure`.