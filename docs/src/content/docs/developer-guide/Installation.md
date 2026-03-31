---
title: Installation
---

Clone the repository and open the project root (commands below assume your shell is at the repo root).

```bash
git clone https://github.com/aws-samples/sample-autonomous-cloud-coding-agents.git
cd bgagent
```

### Pre-requisites

- An AWS account. We recommend you deploy this solution in a new account
- [AWS CLI](https://aws.amazon.com/cli/): configure your credentials

```
aws configure --profile [your-profile] 
AWS Access Key ID [None]: xxxxxx
AWS Secret Access Key [None]:yyyyyyyyyy
Default region name [None]: us-east-1 
Default output format [None]: json
```

- [Node](https://nodejs.org/en) >= v22.0.0
- [AWS CDK](https://github.com/aws/aws-cdk/releases/tag/v2.233.0) >= 2.233.0
- [Python](https://www.python.org/downloads/) >=3.9
- [Projen](https://github.com/projen/projen/releases/tag/v0.98.26) >= 0.98.26
- [Yarn](https://classic.yarnpkg.com/lang/en/docs/cli/install/) >= 1.22.19
- [mise](https://mise.jdx.dev/) (required for local agent Python tasks and checks)
- [Docker](https://docs.docker.com/engine/install/)
- A **GitHub personal access token** (PAT) with permission to access every repository you onboard (clone, push to branches, create and update pull requests). After deployment, store it in the Secrets Manager secret the stack creates ([Post-deployment setup](#post-deployment-setup)); for local agent runs, export `GITHUB_TOKEN` (see **Local testing** below). Required scopes are documented in `agent/README.md`.

#### One-time AWS account setup

The stack routes AgentCore Runtime traces to X-Ray, which requires CloudWatch Logs as a trace segment destination. Run this **once per account** before your first deployment:

```bash
aws xray update-trace-segment-destination --destination CloudWatchLogs
```

Without this, `cdk deploy` will fail with: *"X-Ray Delivery Destination is supported with CloudWatch Logs as a Trace Segment Destination."*

You can use the command below to install the dependencies listed above
```
npm install -g npm aws-cdk yarn projen
```

Install repository dependencies and run an initial build before making changes:

```bash
npx projen install
npx projen build
```

`npx projen install` installs Node/TypeScript dependencies for the repository (including projen subprojects) and runs `mise run install` in `agent/` to install Python dependencies as well.

### Suggested development flow

Use this order to iterate quickly and catch issues early:

1. **Test Python agent code locally first** (fast feedback loop):

```bash
cd agent
# Re-run install only when Python dependencies change
# (npx projen install already runs this once at repo root)
# mise run install
mise run quality
cd ..
```

2. **Test through the local Docker runtime** using `./agent/run.sh` (see **Local testing** below).
3. **Deploy with CDK** once local checks pass (see **Deployment** below).

### Local testing

Before deploying to AWS, you can build and run the agent Docker container locally. The `agent/run.sh` script handles building the image, resolving AWS credentials, and applying AgentCore-matching resource constraints (2 vCPU, 8 GB RAM) so the local environment closely mirrors production.

#### Prerequisites

Set the following environment variables:

```bash
export GITHUB_TOKEN="ghp_..."     # Fine-grained PAT (see agent/README.md for required permissions)
export AWS_REGION="us-east-1"     # Region where Bedrock models are enabled
```

For AWS credentials, either export `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` directly, or have the AWS CLI configured (the script will resolve credentials from your active profile or SSO session automatically).

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
| `DRY_RUN` | | Set to `1` to validate config and print prompt without running the agent |

For the full list of environment variables and GitHub PAT permissions, see `agent/README.md`.

### Deployment

Once your agent works locally, you can deploy it on AWS.

1. Generate project files (dependencies, etc.) from the configuration file and install them.

```bash
npx projen install
```

2. Run a full build

```bash
npx projen build
```

3. Bootstrap your account

```bash
cdk bootstrap
```

4. Run AWS CDK Toolkit to deploy the stack with the runtime resources.

```bash
npx projen deploy
```

### Post-deployment setup

After `npx projen deploy` completes, the stack emits the following outputs:

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

#### Set the GitHub token

The agent reads the GitHub personal access token from Secrets Manager at startup. After deploying, store your PAT in the secret:

```bash
SECRET_ARN=$(aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`GitHubTokenSecretArn`].OutputValue' --output text)

aws secretsmanager put-secret-value \
  --secret-id $SECRET_ARN \
  --secret-string "ghp_your_fine_grained_pat_here"
```

See `agent/README.md` for the required PAT permissions.

#### Onboard repositories

Repositories must be onboarded before tasks can target them. Each repository is registered as a `Blueprint` construct in the CDK stack (`src/stacks/agent.ts`). A `Blueprint` writes a `RepoConfig` record to the shared `RepoTable` DynamoDB table via a CloudFormation custom resource.

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

Then redeploy: `npx projen deploy`.

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