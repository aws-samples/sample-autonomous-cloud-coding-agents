# Quick start

Go from zero to your first agent-created pull request in about 30 minutes. This guide covers only the minimum path - see the [Developer guide](./DEVELOPER_GUIDE.md) and [User guide](./USER_GUIDE.md) for the full details.

## Prerequisites

Install these before you begin:

- **AWS account** with credentials configured (`aws configure`). If you use named profiles, set `AWS_PROFILE` before running any commands in this guide.
- **Amazon Bedrock** — The agent invokes Claude through Bedrock. IAM `grantInvoke` in the CDK stack is required but **not sufficient**: your account must also satisfy [Amazon Bedrock model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) for the model you use (including Anthropic first-time use where applicable, Marketplace subscription flow on first serverless use, and a valid payment method for Marketplace-backed models). See **Amazon Bedrock before your first task** after Step 3.
- **Docker** - for building the agent container image
- **mise** - task runner ([install guide](https://mise.jdx.dev/getting-started.html))
- **AWS CDK CLI** - `npm install -g aws-cdk` (after mise is active)

## Step 1 - Clone and install

This project uses [mise](https://mise.jdx.dev/) to manage tool versions (Node.js, Python, security scanners) and run tasks across the monorepo. Yarn Classic handles JavaScript workspaces (`cdk/`, `cli/`, `docs/`).

```bash
git clone https://github.com/aws-samples/sample-autonomous-cloud-coding-agents.git
cd sample-autonomous-cloud-coding-agents

# Trust mise config and install tools
mise trust
mise install

# Enable Yarn via Corepack
corepack enable
corepack prepare yarn@1.22.22 --activate

# Install dependencies and build
export MISE_EXPERIMENTAL=1
mise run install
mise run build
```

`mise run install` installs all JavaScript and Python dependencies across the monorepo. `mise run build` compiles the CDK app, the CLI, the agent image, and the docs site. A successful build means you are ready to deploy.

> **Note:** `mise run build` includes CDK synthesis, which queries AWS for availability zones. Your active AWS credentials must have at least `ec2:DescribeAvailabilityZones` permission, or the build will fail. If you use named profiles, make sure `AWS_PROFILE` is set before running the build.

## Step 2 - Prepare a repository

The agent works by cloning a GitHub repository, creating a branch, making code changes, running the build and tests, and opening a pull request. This means it needs **write access** to a real repository.

The easiest way to start is to **fork** [`awslabs/agent-plugins`](https://github.com/awslabs/agent-plugins) - a lightweight sample repo designed for testing the platform.

### Create a GitHub personal access token

The agent authenticates to GitHub using a **fine-grained personal access token (PAT)**. Go to GitHub > **Settings** > **Developer settings** > **Fine-grained tokens**. Scope it to **only your fork** with these permissions:

| Permission | Access | Why |
|---|---|---|
| **Contents** | Read and write | Clone the repo and push branches |
| **Pull requests** | Read and write | Create and update pull requests |
| **Issues** | Read | Read issue context for tasks that reference an issue |
| **Metadata** | Read (default) | Required by GitHub for all fine-grained tokens |

Keep the token value - you will store it in AWS Secrets Manager after deploying.

> **Collaborator or cross-org repos?** Fine-grained tokens only work for repos you own (or orgs that have opted in). If you're a collaborator on someone else's repo, create a **classic PAT** with `repo` + `read:org` scopes instead. See [agent/README.md](../../agent/README.md#github-pat--minimal-permissions) for details.

### Register the repo in CDK

Every repository the agent can work on must be **onboarded** as a `Blueprint` construct in the CDK stack. The Blueprint writes a configuration record to DynamoDB; the orchestrator checks this before accepting tasks.

For the sample **AgentPlugins** blueprint, `cdk/src/stacks/agent.ts` resolves the GitHub `owner/repo` in this order: the **`BLUEPRINT_REPO`** environment variable, then CDK context **`blueprintRepo`**, then the default `awslabs/agent-plugins`:

```typescript
const blueprintRepo = process.env.BLUEPRINT_REPO ?? this.node.tryGetContext('blueprintRepo') ?? 'awslabs/agent-plugins';
const agentPluginsBlueprint = new Blueprint(this, 'AgentPluginsBlueprint', {
  repo: blueprintRepo,
  repoTable: repoTable.table,
});
```

You can point that blueprint at your fork **without editing the stack** by setting one of the following before `mise run build` or `mise run //cdk:deploy` (same shell session):

```bash
export BLUEPRINT_REPO=your-username/agent-plugins
```

Alternatively, set CDK context (for example in `cdk/cdk.json` under `"context"`, or for a single deploy: `cdk deploy -c blueprintRepo=your-username/agent-plugins`). Environment variable wins over context when both are set.

The resolved `repo` value must match **exactly** what you pass to the CLI later (`owner/repo` format). To onboard **additional** repositories, add more `Blueprint` constructs in `agent.ts` and redeploy (see [Onboard your own repositories](#onboard-your-own-repositories) below).

## Step 3 - Deploy

The CDK stack deploys the full platform: API Gateway, Lambda functions (orchestrator, task CRUD, webhooks), DynamoDB tables, AgentCore Runtime, VPC with network isolation, Cognito user pool, and CloudWatch dashboards.

```bash
# One-time account setup: allow X-Ray to write spans to CloudWatch Logs.
# On a fresh account, X-Ray needs a resource policy before the destination can be set.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws logs put-resource-policy \
  --policy-name xray-spans-policy \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"XRaySpansAccess\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"xray.amazonaws.com\"},\"Action\":[\"logs:PutLogEvents\",\"logs:CreateLogGroup\",\"logs:CreateLogStream\"],\"Resource\":[\"arn:aws:logs:*:${ACCOUNT_ID}:log-group:aws/spans\",\"arn:aws:logs:*:${ACCOUNT_ID}:log-group:aws/spans:*\"]}]}"
aws xray update-trace-segment-destination --destination CloudWatchLogs

# Bootstrap CDK (first time only)
mise run //cdk:bootstrap

# Deploy the stack (~10 minutes)
mise run //cdk:deploy
```

The X-Ray commands are a one-time per-account setup. On a fresh account the `put-resource-policy` call is required first — without it, the `update-trace-segment-destination` command fails with an `AccessDeniedException` because X-Ray cannot write to the `aws/spans` log group. CDK bootstrap provisions the staging resources CDK needs (S3 bucket, IAM roles). The deploy itself takes around 10 minutes - most of the time is spent building the Docker image and provisioning the AgentCore Runtime.

### Amazon Bedrock before your first task

The stack grants the AgentCore runtime `bedrock:InvokeModel*` on the foundation models and **cross-Region inference profiles** declared in `cdk/src/stacks/agent.ts` (`grantInvoke`). That covers **IAM only**.

You must also be able to **invoke the model in Bedrock** from your account (and Region):

1. **Access and subscription** — Bedrock serverless foundation models are used with the right IAM and, for third-party models, AWS Marketplace permissions; first-time subscription can take up to several minutes. Missing prerequisites often surface as `AccessDeniedException`. See [Request access to models](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) in the Bedrock User Guide.
2. **Anthropic first-time use** — For Anthropic models, submit use-case details once per account (console model catalog or `PutUseCaseForModelAccess`) before invocation, as described in the same guide (unless you use the documented `bedrock-mantle` exception).
3. **Inference profile as `modelId`** — For `InvokeModel` / streaming, pass the **inference profile** ID or ARN where Bedrock requires it (for example `us.anthropic.claude-sonnet-4-6` for US cross-Region Sonnet 4.6). See [Use an inference profile in model invocation](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-use.html).
4. **Cross-Region routing** — System-defined inference profiles can route across Regions within a geography. IAM (and any SCPs) must allow the profile and underlying model in **all relevant Regions**; see [Supported Regions and models for inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html).

If a task fails immediately with text like the model is **not available on your Bedrock deployment**, open the Bedrock console model catalog for your deployment Region, complete access steps for that model family, align the repo `model_id` (DynamoDB / Blueprint) and runtime IAM with an **enabled** inference profile, then redeploy and retry.

## Step 4 - Store the GitHub token

The agent reads the GitHub PAT from **AWS Secrets Manager** at runtime. The CDK stack created an empty secret for you - now you need to put your token value in it.

```bash
REGION=us-east-1  # your deployment region

SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name backgroundagent-dev \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`GitHubTokenSecretArn`].OutputValue | [0]' \
  --output text)

aws secretsmanager put-secret-value \
  --region "$REGION" \
  --secret-id "$SECRET_ARN" \
  --secret-string "ghp_your_token_here"
```

Replace `ghp_your_token_here` with the actual token from Step 2. Make sure `REGION` matches where you deployed - if it is empty, the AWS CLI builds a malformed endpoint URL and fails silently.

## Step 5 - Create a Cognito user

The REST API uses Amazon Cognito for authentication. Self-signup is disabled, so you create a user via the AWS CLI. The pool requires the username to be a valid email address, a password of at least 12 characters mixing uppercase, lowercase, digits, and symbols, and the user's email to be pre-verified.

```bash
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)

aws cognito-idp admin-create-user \
  --region "$REGION" \
  --user-pool-id $USER_POOL_ID \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --temporary-password 'TempPass123!@' \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --region "$REGION" \
  --user-pool-id $USER_POOL_ID \
  --username you@example.com \
  --password 'YourPerm@nent1Pass!' \
  --permanent
```

The first command creates the user with a temporary password, pre-verifies the email (required or login fails with `User is not confirmed`), and suppresses Cognito's welcome email (which otherwise errors on accounts without SES configured). The second sets a permanent password so you do not have to go through a password change flow on first login.

## Step 6 - Configure the CLI and submit a task

The `bgagent` CLI is the recommended way to interact with the platform. It handles Cognito authentication, token caching, and output formatting. You configure it once with the stack outputs, log in, and then submit tasks.

```bash
# Get stack outputs
API_URL=$(aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
APP_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`AppClientId`].OutputValue' --output text)

# Build and configure the CLI
cd cli
mise run build
node lib/bin/bgagent.js configure \
  --api-url $API_URL \
  --region "$REGION" \
  --user-pool-id $USER_POOL_ID \
  --client-id $APP_CLIENT_ID

# Log in
node lib/bin/bgagent.js login --username you@example.com

# Submit your first task and wait for it to complete
node lib/bin/bgagent.js submit \
  --repo your-username/agent-plugins \
  --task "Add a CODEOWNERS file to the repository root" \
  --wait
```

The `--wait` flag polls until the task reaches a terminal state. A typical simple task takes 2-5 minutes. When it completes, you will see a PR URL in your terminal - open it in your browser to review the agent's work.

Alternatively, use `watch` to stream progress events in real time:

```bash
node lib/bin/bgagent.js watch <TASK_ID>
```

While a task is running, you can steer the agent with a nudge:

```bash
node lib/bin/bgagent.js nudge <TASK_ID> "Also add a test for the edge case"
```

## Step 7 - See an approval gate in action

If your blueprint defines any Cedar HITL policies tagged `@tier("soft")`, the agent pauses on matching tool calls and waits for your decision. This step walks through the flow end-to-end.

First, check which rules apply to your repo:

```bash
node lib/bin/bgagent.js policies list --repo owner/repo
```

Submit a task that will plausibly trip a soft-deny rule — for example, one of the default blueprint rules guards force-pushes:

```bash
node lib/bin/bgagent.js submit --repo owner/repo \
  --task "Force-push the feature branch so the history is linear"
```

In a second terminal, watch the task:

```bash
node lib/bin/bgagent.js watch <TASK_ID>
```

When the agent hits the guarded tool call, `watch` prints an `approval_requested` event and the task status flips to `AWAITING_APPROVAL`. List the pending approval:

```bash
node lib/bin/bgagent.js pending
```

The output includes ready-to-run approve/deny lines. Pick one:

```bash
# Approve just this call
node lib/bin/bgagent.js approve <TASK_ID> <REQUEST_ID>

# Or deny with a reason that nudges the agent toward a safer approach
node lib/bin/bgagent.js deny <TASK_ID> <REQUEST_ID> \
  --reason "Don't force-push shared branches; open a revert PR instead"
```

The task transitions back to `RUNNING` immediately on a decision. The denial reason is injected into the agent's context so it can adapt rather than retry the same tool call. If no decision arrives within the rule's timeout (300 s by default), the gate is treated as a denial with `timed_out` as the reason.

If you want a task to run without interactive gates (e.g. an unattended overnight job), pre-approve the scopes you trust up-front:

```bash
node lib/bin/bgagent.js submit --repo owner/repo --issue 42 \
  --pre-approve tool_type:Bash \
  --pre-approve write_path:tests/**
```

Hard-deny rules (no `@tier("soft")` annotation) are always enforced — `--pre-approve` only short-circuits soft-deny rules. For the full command reference see [User guide — Approval gates](./USER_GUIDE.md#approval-gates-cedar-hitl); for authoring your own rules see the [Cedar policy guide](./CEDAR_POLICY_GUIDE.md).

## What happened behind the scenes

Here is what the platform did after you ran `bgagent submit`:

1. **Task creation** - The CLI authenticated via Cognito and sent a `POST /v1/tasks` request. The API validated the request, checked idempotency, and stored a task record in DynamoDB with status `SUBMITTED`.
2. **Orchestration** - The durable orchestrator picked up the task and ran admission control (concurrency limits). It then ran **pre-flight checks** - calling the GitHub API to verify your token can access the repository with push permissions. If the token were read-only, the task would have failed here with a clear error instead of failing later inside the agent.
3. **Context hydration** - The orchestrator assembled the agent's prompt: your task description, any repository memory from past tasks, and the system prompt that defines the agent's behavioral contract. The task transitioned to `HYDRATING`.
4. **Agent execution** - An isolated MicroVM started via AgentCore Runtime. The agent cloned your repository, created a branch (`bgagent/<task-id>/<description-slug>`), made the requested changes, ran `mise run build` to verify the build passes, committed incrementally, and opened a pull request. The task transitioned to `RUNNING`.
5. **Finalization** - The orchestrator detected the agent finished, recorded the PR URL, cost, and duration on the task record, and transitioned to `COMPLETED`.

## Common errors

| Error | Cause | Fix |
|---|---|---|
| `yarn: command not found` | Corepack not enabled or mise not activated in your shell | Run `eval "$(mise activate zsh)"`, then `corepack enable && corepack prepare yarn@1.22.22 --activate` |
| `MISE_EXPERIMENTAL required` | Namespaced tasks need the experimental flag | `export MISE_EXPERIMENTAL=1` |
| `AccessDeniedException` on `update-trace-segment-destination` | Fresh account missing CloudWatch Logs resource policy for X-Ray | Run `aws logs put-resource-policy` first (see Step 3) |
| CDK deploy fails with "X-Ray Delivery Destination..." | Missing one-time account setup | Run both X-Ray commands in Step 3 |
| `mise run build` fails with `ec2:DescribeAvailabilityZones` error | AWS credentials missing or insufficient for CDK synth | Set `AWS_PROFILE` or configure credentials with at least EC2 read access |
| CDK deploy prompts for approval and hangs | Non-interactive terminal (CI/CD, scripts) | Pass `--require-approval never` to `cdk deploy` or use an interactive terminal |
| `put-secret-value` returns double-dot endpoint | `REGION` variable is empty | Set `REGION=us-east-1` (or your actual region) before running the command |
| Model / Bedrock errors in logs (`not available on your bedrock`, zero tokens) | Model not entitled for the account or Region, wrong `modelId` shape, or missing Marketplace / FTU steps | Follow **Amazon Bedrock before your first task** above; confirm [model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) and use an [inference profile](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-use.html) ID such as `us.anthropic.claude-sonnet-4-6` where required; keep `grantInvoke` in `agent.ts` aligned with that model |
| `REPO_NOT_ONBOARDED` on task submit | Blueprint `repo` does not match what you passed to the CLI | Confirm `BLUEPRINT_REPO`, CDK context `blueprintRepo`, or the `repo` prop on the `Blueprint` in `cdk/src/stacks/agent.ts` resolves to exactly the same `owner/repo` you pass to the CLI |
| `INSUFFICIENT_GITHUB_REPO_PERMISSIONS` | PAT is missing required permissions or is scoped to the wrong repo | Regenerate the PAT with Contents (read/write) and Pull requests (read/write) scoped to your fork, then update Secrets Manager |
| Task stuck in `SUBMITTED` | Orchestrator Lambda may not have been invoked | Check CloudWatch logs for the orchestrator Lambda; verify the stack deployed successfully |
| `node: command not found` in `cli/` | mise shell activation missing | Run `eval "$(mise activate zsh)"` and confirm `node --version` shows v22.x |

## Customizing the platform

Once you have the basic flow working, here are the main ways to customize the platform for your needs.

### Onboard your own repositories

Add more `Blueprint` constructs in `cdk/src/stacks/agent.ts` and redeploy. Each Blueprint registers one repository. You can onboard as many repos as you want - each one gets its own configuration record in DynamoDB.

```typescript
new Blueprint(this, 'MyServiceBlueprint', {
  repo: 'my-org/my-service',
  repoTable: repoTable.table,
});
```

### Per-repo configuration

Blueprints accept optional overrides to customize agent behavior per repository: which model to use, how many turns the agent gets, cost budget limits, extra system prompt instructions, and network egress rules. See the [User guide - Per-repo overrides](./USER_GUIDE.md) for the full list.

```typescript
new Blueprint(this, 'CustomBlueprint', {
  repo: 'my-org/my-service',
  repoTable: repoTable.table,
  agent: {
    modelId: 'us.anthropic.claude-sonnet-4-6',
    maxTurns: 50,
    systemPromptOverrides: 'Always write tests. Use conventional commits.',
  },
});
```

### Add a CLAUDE.md to your repository

The agent automatically loads project-level instructions from `CLAUDE.md` at the repository root (or `.claude/CLAUDE.md`). This is the most effective way to improve agent output for a specific repo - tell it your build commands, coding conventions, architecture boundaries, and constraints. See the [Prompt guide](./PROMPT_GUIDE.md) for examples and best practices.

### Set up webhook integrations

Webhooks let external systems (GitHub Actions, CI pipelines) create tasks without Cognito credentials, using HMAC-SHA256 authentication. This is useful for automating PR review on every PR, or triggering code changes from CI events. See the [User guide - Webhooks](./USER_GUIDE.md) for setup instructions.

## Next steps

- **Try an issue-based task**: `node lib/bin/bgagent.js submit --repo owner/repo --issue 42`
- **Iterate on a PR**: `node lib/bin/bgagent.js submit --repo owner/repo --pr 1`
- **Review a PR**: `node lib/bin/bgagent.js submit --repo owner/repo --review-pr 1`
- **Watch a task live**: `node lib/bin/bgagent.js watch <TASK_ID>` — stream progress events
- **Steer a running task**: `node lib/bin/bgagent.js nudge <TASK_ID> "focus on tests"` — mid-run guidance
- **Enable tracing**: `node lib/bin/bgagent.js submit --repo owner/repo --issue 42 --trace` then `node lib/bin/bgagent.js trace download <TASK_ID>`
- **Manage webhooks**: `node lib/bin/bgagent.js webhook create --name "My CI"` — automate task submission from external systems
- **Run locally first**: Test with `./agent/run.sh` before deploying - see the [Developer guide](./DEVELOPER_GUIDE.md)
