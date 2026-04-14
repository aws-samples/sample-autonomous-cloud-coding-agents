---
title: Installation
---

Commands below assume your shell is at the repo root after you clone.

### Pre-requisites

**Install and configure yourself (not provided by this repository’s mise files):**

- An AWS account (we recommend a dedicated account for this solution).
- [AWS CLI](https://aws.amazon.com/cli/) with credentials configured, for example:

```
aws configure --profile [your-profile]
AWS Access Key ID [None]: xxxxxx
AWS Secret Access Key [None]:yyyyyyyyyy
Default region name [None]: us-east-1
Default output format [None]: json
```

- [Docker](https://docs.docker.com/engine/install/) — for local agent runs and CDK asset builds.
- [mise](https://mise.jdx.dev/getting-started.html) — task runner and version manager for Node, security tools, and (under `agent/`) Python. Install from the official guide; it is **not** installed via npm.
- **AWS CDK CLI** ≥ 2.233.0 — install globally with npm **after** mise is active so it uses the same Node as this repo (see [Set up your toolchain](#set-up-your-toolchain)): `npm install -g aws-cdk`.
- A **GitHub personal access token** (PAT) with permission to access every repository you onboard—see **[Repository preparation](#repository-preparation)** (steps 2–3) for required fine-grained permissions and how to store the value in Secrets Manager after deploy. For local agent runs, export `GITHUB_TOKEN` (see **Local testing**). Extra runtime notes live in `agent/README.md`.

**Versions this repo pins via mise (no separate Node/Yarn/Python install needed for the standard path):**

| Tool | Where it is defined | When it is installed |
|------|---------------------|----------------------|
| **Node.js** 22.x | Root `mise.toml` | `mise install` from the repo root |
| **Yarn Classic** (1.22.x) | Not in mise — use Corepack with Node (see below) | After `corepack enable` and `corepack prepare yarn@…` |
| **Python** + **uv** | `agent/mise.toml` | `mise run install` (runs `mise run install` inside `agent/`) |
| gitleaks, semgrep, osv-scanner, grype, zizmor, prek, … | Root `mise.toml` | `mise install` from the repo root |

You do **not** need standalone installs of Node or Yarn from nodejs.org or the Yarn website if you follow [Set up your toolchain](#set-up-your-toolchain).

#### One-time AWS account setup

The stack routes AgentCore Runtime traces to X-Ray, which requires CloudWatch Logs as a trace segment destination. Run this **once per account** before your first deployment:

```bash
aws xray update-trace-segment-destination --destination CloudWatchLogs
```

Without this, `cdk deploy` will fail with: *"X-Ray Delivery Destination is supported with CloudWatch Logs as a Trace Segment Destination."*

### Set up your toolchain

1. **Install mise** — follow [Getting started](https://mise.jdx.dev/getting-started.html).

2. **Activate mise in your shell** so `node`, task tools, and project tasks resolve correctly. Add one line to `~/.zshrc` or `~/.bashrc`:

   ```bash
   eval "$(mise activate zsh)"   # or: eval "$(mise activate bash)"
   ```

   Reload the file (`source ~/.zshrc`) or open a new terminal. Without this step, your shell may keep using a system Node (or no `yarn`), and `mise run install` can fail with **`yarn: command not found`**.

3. **Clone the repository** and change into it:

   ```bash
   git clone https://github.com/aws-samples/sample-autonomous-cloud-coding-agents.git
   cd sample-autonomous-cloud-coding-agents
   ```

4. **Trust this repository’s mise config.** Mise refuses to apply project-local settings until you trust them (security feature):

   ```bash
   mise trust
   ```

5. **Install tools from the root `mise.toml`** (Node 22, security scanners, prek, etc.):

   ```bash
   mise install
   ```

6. **Enable Yarn via Corepack.** Node ships with Corepack, but Yarn is not on your PATH until Corepack is enabled. This monorepo uses **Yarn Classic** (1.x) workspaces:

   ```bash
   corepack enable
   corepack prepare yarn@1.22.22 --activate
   ```

   The `prepare` line installs a 1.22.x release compatible with the workspace (`yarn.lock` / engines expectations). If `yarn` is still missing, confirm step 2 (shell activation) and that `which node` points into your mise shims.

7. **Sanity check** (optional):

   ```bash
   node --version   # expect v22.x
   yarn --version   # expect 1.22.x
   ```

8. **Install the AWS CDK CLI** using the same Node as mise:

   ```bash
   npm install -g aws-cdk
   ```

9. **Install workspace dependencies and build.** Namespaced mise tasks require experimental mode:

   ```bash
   export MISE_EXPERIMENTAL=1
   mise run install
   mise run build
   ```

`mise run install` runs `yarn install` for the Yarn workspaces (`cdk`, `cli`, `docs`), then `mise run install` in `agent/` for Python dependencies, and installs [prek](https://github.com/j178/prek) git hooks when you are inside a Git checkout.

### First time with mise? Troubleshooting

Use this section if **`mise run install`** fails or versions look wrong.

| Symptom | What to check |
|---------|----------------|
| **`yarn: command not found`** | Mise shell activation (step 2), then `corepack enable` and `corepack prepare yarn@1.22.22 --activate` (step 6). |
| **`node` is not v22** | Shell activation (step 2); run `mise install` in the repo root (step 5). |
| Mise errors about **untrusted** config | From the repo root: `mise trust`, then `mise install` again. |
| **`MISE_EXPERIMENTAL` required** | Export `MISE_EXPERIMENTAL=1` for tasks like `mise //cdk:build` (see [CONTRIBUTING.md](/developer-guide/contributing)). |

Minimal recovery sequence:

```bash
eval "$(mise activate zsh)"   # or bash; add permanently to your shell rc file
cd /path/to/sample-autonomous-cloud-coding-agents
mise trust
mise install
corepack enable
corepack prepare yarn@1.22.22 --activate
export MISE_EXPERIMENTAL=1
mise run install
```

### Suggested development flow

Use this order to iterate quickly and catch issues early:

1. **Test Python agent code locally first** (fast feedback loop):

```bash
cd agent
# Re-run install only when Python dependencies change
# (mise run install at repo root already runs agent install once)
# mise run install
mise run quality
cd ..
```

2. **Test through the local Docker runtime** using `./agent/run.sh` (see **Local testing** below).
3. **Deploy with CDK** once local checks pass (see **Deployment** below).

### Local testing

Before deploying to AWS, you can build and run the agent Docker container locally. The `agent/run.sh` script handles building the image, resolving AWS credentials, and applying AgentCore-matching resource constraints (2 vCPU, 8 GB RAM) so the local environment closely mirrors production.

:::tip
The script validates AWS credentials **before** starting the Docker build, so problems like an expired SSO session surface immediately — not after a lengthy image build.
:::

#### Prerequisites

The `owner/repo` you pass to `run.sh` must match an onboarded Blueprint and be a repository your `GITHUB_TOKEN` can **push to and open PRs on** (same rules as **Repository preparation** at the start of this guide). If you have not changed the Blueprint, fork `awslabs/agent-plugins`, set **`repo`** to your fork, and use a PAT scoped to that fork—then pass the same **`owner/repo`** here.

Set the following environment variables:

```bash
export GITHUB_TOKEN="ghp_..."     # Fine-grained PAT (see agent/README.md for required permissions)
export AWS_REGION="us-east-1"     # Region where Bedrock models are enabled
```

#### AWS credential resolution

The script resolves AWS credentials in priority order:

1. **Explicit environment variables** — If `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set, they are passed directly to the container. Include `AWS_SESSION_TOKEN` when using temporary credentials (e.g. from `aws sts assume-role`).

   ```bash
   export AWS_ACCESS_KEY_ID="AKIA..."
   export AWS_SECRET_ACCESS_KEY="..."
   export AWS_SESSION_TOKEN="..."   # required for temporary credentials
   ```

2. **AWS CLI resolution** — If the CLI is installed, the script runs `aws configure export-credentials` to resolve credentials from your active profile or SSO session. Set `AWS_PROFILE` to target a specific profile.

   ```bash
   export AWS_PROFILE="my-dev-profile"   # optional — defaults to the CLI default profile
   ```

3. **`~/.aws` directory mount** — If neither of the above is available but `~/.aws` exists, the directory is bind-mounted read-only into the container. This works for static credential files but **not for SSO tokens**, which don't resolve well inside the container.

:::caution
If none of these methods succeeds, the script prints a warning and continues without AWS credentials. The container will start but any AWS API call (Bedrock, DynamoDB, etc.) will fail at runtime. Make sure at least one credential source is configured before running a real task.
:::

#### Running a task locally

```bash
# Run against a GitHub issue
./agent/run.sh "owner/repo" 42

# Run with a text description
./agent/run.sh "owner/repo" "Add input validation to the /users POST endpoint"

# Issue + additional instructions
./agent/run.sh "owner/repo" 42 "Focus on the backend validation only"

# Dry run — validate config, fetch issue, print assembled prompt, then exit (no agent invocation)
DRY_RUN=1 ./agent/run.sh "owner/repo" 42
```

The second argument is auto-detected: numeric values are treated as issue numbers, anything else as a task description.

#### Testing the server locally

In production, the container runs as a FastAPI server. You can test this mode locally:

```bash
# Start the server (builds image, resolves credentials, exposes port 8080)
./agent/run.sh --server "owner/repo"

# In another terminal:
curl http://localhost:8080/ping

curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"input":{"prompt":"Fix the login bug","repo_url":"owner/repo"}}'
```

In server mode, `repo_url`, `prompt`, and other task parameters can be sent via the `/invocations` JSON payload instead of environment variables.

#### Monitoring a running container

The container runs with a fixed name (`bgagent-run`). In a second terminal:

```bash
docker logs -f bgagent-run                        # live agent output
docker stats bgagent-run                          # CPU, memory usage
docker exec bgagent-run du -sh /workspace         # disk usage
docker exec -it bgagent-run bash                  # shell into the container
```

#### Optional environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_MODEL` | `us.anthropic.claude-sonnet-4-6` | Bedrock model ID |
| `MAX_TURNS` | `100` | Max agent turns before stopping |
| `MAX_BUDGET_USD` | | Cost ceiling for local batch runs (USD). Not used in production — see below |
| `DRY_RUN` | | Set to `1` to validate config and print prompt without running the agent |

**Cost budget** is not configured here for production tasks: set **`max_budget_usd`** when creating a task (REST API, CLI `--max-budget`, or per-repo Blueprint). The orchestrator passes it in the runtime invocation payload. The optional env var `MAX_BUDGET_USD` applies only to **local batch** runs; see `agent/README.md`.

For the full list of environment variables and GitHub PAT permissions, see `agent/README.md`.

#### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERROR: Failed to resolve AWS credentials via AWS CLI` | SSO session expired or profile misconfigured | Run `aws sso login --profile <your-profile>` if using SSO, or `aws configure` to set up a profile, or export `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` directly |
| `ERROR: GITHUB_TOKEN is not set` | Missing PAT | Export `GITHUB_TOKEN` (see `agent/README.md` for required scopes) |
| `WARNING: No AWS credentials detected` | No env vars, no AWS CLI, no `~/.aws` directory | Configure one of the three credential methods above |
| `WARNING: Image exceeds AgentCore 2 GB limit!` | Agent image too large for production | Reduce dependencies or use multi-stage Docker build |

### Deployment

Once your agent works locally, you can deploy it on AWS. A **full** `mise run //cdk:deploy` of this stack has been observed at **~572 seconds (~9.5 minutes)** total (CDK-reported *Total time*); expect variation by Region, account state, and whether container layers are already cached.

1. Install dependencies (from the repository root).

```bash
mise run install
```

2. Run a full build

```bash
mise run build
```

3. Bootstrap your account if needed

```bash
mise run //cdk:bootstrap
```

4. Deploy the stack with the runtime resources. Approve the changes when asked.

```bash
mise run //cdk:deploy
```

### Post-deployment setup

After `mise run //cdk:deploy` completes, the stack emits the following outputs:

| Output | Description |
|---|---|
| `RuntimeArn` | ARN of the AgentCore runtime |
| `ApiUrl` | Base URL of the Task REST API |
| `UserPoolId` | Cognito User Pool ID |
| `AppClientId` | Cognito App Client ID |
| `TaskTableName` | DynamoDB table for task state |
| `TaskEventsTableName` | DynamoDB table for task audit events |
| `UserConcurrencyTableName` | DynamoDB table for per-user concurrency tracking |
| `WebhookTableName` | DynamoDB table for webhook integrations |
| `RepoTableName` | DynamoDB table for per-repo Blueprint configuration |
| `GitHubTokenSecretArn` | Secrets Manager secret ARN for the GitHub PAT |

Retrieve them with:

```bash
aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --query 'Stacks[0].Outputs' --output table
```

Use the **same AWS Region** (and profile) as `mise run //cdk:deploy`. If you omit `--region`, the CLI uses your default from `aws configure`; when the stack lives in another Region, `describe-stacks` fails, **stderr** shows the error, and capturing stdout into a shell variable (for example `SECRET_ARN=$(...)`) yields **empty** with no obvious hint—run the `aws` command without `$(...)` to see the message. Add `--region your-region` to every command below if needed.

If `put-secret-value` returns **`Invalid endpoint: https://secretsmanager..amazonaws.com`** (note the **double dot**), the effective Region string is **empty**—for example `REGION=` was never set, `export REGION` is blank, or `--region "$REGION"` expands to nothing. Set `REGION` to a real value (e.g. `us-east-1`) or run `aws configure set region your-region` so the default is non-empty.

#### Set the GitHub token

The agent reads the GitHub personal access token from Secrets Manager at runtime. The canonical flow (permissions table + `put-secret-value` commands) is **[Repository preparation](#repository-preparation), step 3**—follow that first.

If you only need the commands here, use the same snippet as in that section (adjust **`--stack-name`** if you renamed the stack). If `SECRET_ARN` is empty after setting `REGION`, list outputs in that Region (`describe-stacks` … `--query 'Stacks[0].Outputs' --output table`) and confirm the row `GitHubTokenSecretArn` exists—wrong stack name or an incomplete deployment are the other common causes.

```bash
REGION=us-east-1

SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name backgroundagent-dev \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`GitHubTokenSecretArn`].OutputValue | [0]' \
  --output text)

aws secretsmanager put-secret-value \
  --region "$REGION" \
  --secret-id "$SECRET_ARN" \
  --secret-string "ghp_your_fine_grained_pat_here"
```

#### Onboard repositories

Repositories must be onboarded before tasks can target them. Each repository is registered as a `Blueprint` construct in the CDK stack (`cdk/src/stacks/agent.ts`). A `Blueprint` writes a `RepoConfig` record to the shared `RepoTable` DynamoDB table via a CloudFormation custom resource.

To onboard a repository, add a `Blueprint` instance to the CDK stack:

```typescript
import { Blueprint } from '../constructs/blueprint';

new Blueprint(this, 'MyRepoBlueprint', {
  repo: 'owner/repo',
  repoTable: repoTable.table,
});
```

With per-repo configuration overrides:

```typescript
new Blueprint(this, 'CustomRepoBlueprint', {
  repo: 'owner/custom-repo',
  repoTable: repoTable.table,
  compute: { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom' },
  agent: {
    modelId: 'anthropic.claude-sonnet-4-6',
    maxTurns: 50,
    systemPromptOverrides: 'Always use TypeScript. Follow the project coding standards.',
  },
  credentials: { githubTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:per-repo-token' },
  pipeline: { pollIntervalMs: 15000 },
});
```

Then redeploy: `cd cdk && npx cdk deploy`.

When a Blueprint is destroyed (removed from CDK code and redeployed), the record is soft-deleted (`status: 'removed'` with a 30-day TTL). Tasks for removed repos are rejected with `REPO_NOT_ONBOARDED`.

If a Blueprint specifies `runtimeArn` or `githubTokenSecretArn`, the corresponding ARNs must also be passed to the `TaskOrchestrator` construct via `additionalRuntimeArns` and `additionalSecretArns` so the orchestrator Lambda has IAM permissions to access them.

For the full design, see [docs/design/REPO_ONBOARDING.md](/design/repo-onboarding).

#### Create a Cognito user

Self-signup is disabled. Create a user via the AWS CLI:

```bash
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)

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

#### Smoke test

Authenticate and verify the API is working:

```bash
APP_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`AppClientId`].OutputValue' --output text)
API_URL=$(aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)

TOKEN=$(aws cognito-idp initiate-auth \
  --client-id $APP_CLIENT_ID \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=user@example.com,PASSWORD='YourPerm@nent1Pass!' \
  --query 'AuthenticationResult.IdToken' --output text)

# List tasks (should return empty list)
curl -s "$API_URL/tasks" -H "Authorization: $TOKEN" | jq .

# Create a task
curl -s -X POST "$API_URL/tasks" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "owner/repo", "task_description": "Test task"}' | jq .
```

For the full API reference, see the [User guide](/user-guide/introduction).