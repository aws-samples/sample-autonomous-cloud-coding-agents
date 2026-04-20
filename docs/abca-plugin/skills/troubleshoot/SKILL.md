---
name: troubleshoot
description: >-
  Diagnose and fix common ABCA issues: deployment failures, preflight errors,
  authentication problems, agent failures, and build issues. Use when the user says
  "troubleshoot", "debug", "not working", "error", "failed", "help me fix",
  "preflight_failed", "task failed", "deploy failed", "auth error", "401", "422", "503",
  or describes something not working as expected.
---

# ABCA Troubleshooting

You are diagnosing an issue with the ABCA platform. Follow a systematic approach: gather symptoms, check the most common causes, and apply targeted fixes.

## Step 1: Identify the Problem Category

Determine which area the issue falls into:

1. **Build/Compilation** — TypeScript errors, test failures, lint issues
2. **Deployment** — CDK deploy/synth failures, CloudFormation errors
3. **Authentication** — Cognito errors, token issues, 401 responses
4. **Task Submission** — 422 errors, validation failures, guardrail blocks
5. **Task Execution** — Preflight failures, agent failures, timeouts
6. **Local Agent Testing** — Docker issues, run.sh problems

## Build/Compilation Issues

```bash
export MISE_EXPERIMENTAL=1
mise run //cdk:compile 2>&1 | tail -50  # TypeScript errors
mise run //cdk:test 2>&1 | tail -50     # Test failures
```

**Common causes:**
- Missing `mise run install` after pulling changes
- `yarn: command not found` — Run `corepack enable && corepack prepare yarn@1.22.22 --activate`
- Type mismatches after editing `cdk/src/handlers/shared/types.ts` without updating `cli/src/types.ts`

## Deployment Issues

```bash
# Check CloudFormation events for the failed stack
aws cloudformation describe-stack-events --stack-name backgroundagent-dev \
  --query 'StackEvents[?ResourceStatus==`CREATE_FAILED` || ResourceStatus==`UPDATE_FAILED`].[LogicalResourceId,ResourceStatusReason]' \
  --output table
```

**Common causes:**
- Docker not running — Required for CDK asset bundling
- Missing CDK bootstrap — Run `mise run //cdk:bootstrap`
- IAM permission issues — Check `aws sts get-caller-identity`
- Region mismatch — Ensure consistent region across all commands

## Authentication Issues

```bash
# Verify credentials
aws sts get-caller-identity

# Check Cognito user exists
aws cognito-idp admin-get-user \
  --user-pool-id $USER_POOL_ID \
  --username user@example.com
```

**Common causes:**
- "App client does not exist" — Region mismatch between CLI config and stack deployment
- Token expired — Re-authenticate with `bgagent login`
- 401 on API calls — Token not included or malformed in Authorization header
- User not created — Self-signup is disabled; admin must create users

## Task Submission Issues (422 / 400)

**"Repository not onboarded" (422):**
- The repo needs a Blueprint construct. Use the `onboard-repo` skill.

**"GUARDRAIL_BLOCKED" (400):**
- Task description triggered Bedrock Guardrails content screening
- Review and rephrase the task description to remove potentially flagged content

**Validation errors:**
- Check required fields: `repo` is required, plus at least one of `issue_number`, `task_description`, `pr_number`
- `max_turns` range: 1-500
- `max_budget_usd` range: $0.01-$100

## Task Execution Issues

```bash
# Check task events for details
node cli/lib/bin/bgagent.js events <TASK_ID> --output json
```

**`preflight_failed`:**
- GitHub credentials lack permissions for the repo
- Repository doesn't exist or is private without proper token scope
- Check event `reason` and `detail` fields for specifics
- **PAT path:** verify the fine-grained token includes the target repository with Contents (read/write), Pull Requests (read/write), Issues (read)
- **Token Vault path:** verify the GitHub App is installed on the target repo (GitHub → Settings → Developer settings → GitHub Apps → your app → Install App), the callback URL (`AgentCoreIdentityGitHubOAuthCallbackUrl` stack output) is registered in the GitHub App settings, the CDK context param `githubApp` was set to true in cdk.json, the real client secret is stored in the credential provider's Secrets Manager secret (retrieve its ARN via `aws bedrock-agent-core get-oauth2-credential-provider`), and the **one-time OAuth consent flow** has been completed (see step 6 in the Developer Guide — GitHub Apps use USER_FEDERATION, not M2M)

**`task_failed` / task completes with 0 tokens and no PR:**
- Agent encountered an error during execution
- Check CloudWatch logs for the session:
  ```bash
  aws logs filter-log-events \
    --log-group-name "/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/jean_cloude" \
    --filter-pattern "<TASK_ID>" \
    --region us-west-2 --query 'events[*].message' --output text
  ```
- Common: repo build/test commands not documented in CLAUDE.md

**403 "not authorized to perform bedrock:InvokeModelWithResponseStream":**
- The Blueprint specifies a model that the runtime IAM role doesn't have permissions for
- Fix: add `grantInvoke` for the model and its cross-region inference profile in `cdk/src/stacks/agent.ts`, then redeploy

**400 "Invocation with on-demand throughput isn't supported":**
- The Blueprint `modelId` uses a raw foundation model ID (e.g. `anthropic.claude-opus-4-20250514-v1:0`)
- Fix: change to the inference profile ID (e.g. `us.anthropic.claude-opus-4-20250514-v1:0`), update DynamoDB via redeploy

**503 "Too many connections" / task completes with 0 tokens after long duration:**
- Bedrock is throttling model invocations. The agent retries for minutes then gives up.
- Symptoms: task runs for 10-15 minutes, completes with `COMPLETED` status but 0 tokens, 0 cost, no PR, `disk_delta: 0 B`
- Diagnosis:
  1. Check application logs for `"text": "API Error: 503 Too many connections"`
  2. **Check what model_id is actually being passed** — the DynamoDB record may have a stale model override:
     ```bash
     aws dynamodb get-item \
       --table-name <RepoTableName> \
       --key '{"repo": {"S": "owner/repo"}}' \
       --query 'Item.model_id' --output text
     ```
- Causes:
  - **Stale model_id in DynamoDB** (most common) — the Blueprint `onUpdate` only sets fields present in props; removing a `modelId` prop does NOT remove the field from DynamoDB. The task keeps using the old model.
  - Bedrock service-level throttling for the specific model (especially Opus 4 which has limited availability)
  - Account quota limits reached
- Fix:
  1. **Check and fix the DynamoDB record first** — remove stale `model_id` if present:
     ```bash
     aws dynamodb update-item \
       --table-name <RepoTableName> \
       --key '{"repo": {"S": "owner/repo"}}' \
       --update-expression "REMOVE model_id"
     ```
  2. If model_id is correct, wait and retry — throttling is often transient
  3. Switch to a model with higher availability (Sonnet 4.6 > Opus 4 > Haiku)
  4. Request a Bedrock quota increase for `InvokeModel` RPM on your model

**`task_timed_out`:**
- 9-hour maximum exceeded
- Consider reducing scope or increasing `max_turns` for complex tasks
- Check if the agent is stuck in a loop (review logs)

**Concurrency limit:**
- Default: 3 concurrent tasks per user
- Wait for running tasks to complete or cancel them

## Local Agent Testing Issues

```bash
# Verify Docker is running
docker info

# Test locally with dry run
DRY_RUN=1 ./agent/run.sh "owner/repo" "Test task"
```

**Common causes:**
- Missing environment variables: `GITHUB_TOKEN`, `AWS_REGION`
- Docker not running or insufficient resources (needs 2 vCPU, 8 GB RAM)
- Missing AWS credentials for Bedrock access

## Diagnostic Commands Quick Reference

```bash
# Stack status
aws cloudformation describe-stacks --stack-name backgroundagent-dev --query 'Stacks[0].StackStatus'

# Stack outputs
aws cloudformation describe-stacks --stack-name backgroundagent-dev --query 'Stacks[0].Outputs' --output table

# Task status
node cli/lib/bin/bgagent.js status <TASK_ID>
node cli/lib/bin/bgagent.js events <TASK_ID> --output json

# List running tasks
node cli/lib/bin/bgagent.js list --status RUNNING

# Build health
mise run build
```
