---
name: setup
description: >-
  Guided installation and first-time setup for ABCA. Walks through prerequisites,
  toolchain installation, dependency setup, and initial deployment. Use when the user
  says "set up the project", "get started", "install", "first time setup",
  "how do I start", "prerequisites", or is new to the project.
---

# ABCA First-Time Setup

You are guiding a developer through the complete ABCA setup process. Work through each phase sequentially, verifying success before moving on. Use AskUserQuestion when you need input.

## Phase 1: Verify Prerequisites

Check each prerequisite and report status. Run these checks:

```bash
# Check each tool
aws --version 2>/dev/null
docker --version 2>/dev/null
mise --version 2>/dev/null
node --version 2>/dev/null
cdk --version 2>/dev/null
yarn --version 2>/dev/null
```

**Required tools:**
- AWS CLI (configured with credentials for a dedicated AWS account)
- Docker (running — needed for local agent runs and CDK asset builds)
- mise (task runner and version manager — https://mise.jdx.dev/)
- Node.js 22.x (managed by mise)
- Yarn Classic 1.22.x (via Corepack)
- AWS CDK CLI >= 2.233.0
- GitHub fine-grained PAT with repository access

For any missing tool, provide the specific installation command for the user's platform. Do NOT proceed until all prerequisites are met.

## Phase 2: Toolchain Setup

Run these steps in order, verifying each:

1. `mise trust` — Trust the project config
2. `mise install` — Install tool versions
3. `corepack enable && corepack prepare yarn@1.22.22 --activate` — Enable Yarn
4. Verify: `node --version` (should be v22.x), `yarn --version` (should be 1.22.x)
5. `export MISE_EXPERIMENTAL=1` — Required for namespaced tasks
6. `mise run install` — Install all workspace dependencies
7. `mise run build` — Full monorepo build (agent quality + CDK + CLI + docs)

If `mise run install` fails with "yarn: command not found", Corepack wasn't activated. If `prek install` fails about `core.hooksPath`, another hook manager owns hooks — suggest `git config --unset-all core.hooksPath`.

## Phase 3: One-Time AWS Setup

```bash
aws xray update-trace-segment-destination --destination CloudWatchLogs
```

This must be run once per AWS account before first deployment.

## Phase 4: First Deployment

Guide through:

1. `mise run //cdk:bootstrap` — Bootstrap CDK (if not already done for this account/region)
2. `mise run //cdk:deploy` — Deploy the stack (~9.5 minutes)
3. Retrieve stack outputs:
   ```bash
   aws cloudformation describe-stacks --stack-name backgroundagent-dev \
     --query 'Stacks[0].Outputs' --output table
   ```
4. Store the GitHub PAT in Secrets Manager using the `GitHubTokenSecretArn` output
5. Create a Cognito user (self-signup is disabled):
   ```bash
   aws cognito-idp admin-create-user --user-pool-id $USER_POOL_ID \
     --username user@example.com --temporary-password 'TempPass123!@#'
   aws cognito-idp admin-set-user-password --user-pool-id $USER_POOL_ID \
     --username user@example.com --password 'YourPermanentPass123!@#' --permanent
   ```

## Phase 5: Smoke Test

1. Authenticate and get a JWT token
2. Test the API: `curl -s -H "Authorization: $TOKEN" $API_URL/tasks`
3. Configure the CLI:
   ```bash
   cd cli && mise run build
   node lib/bin/bgagent.js configure \
     --api-url $API_URL --region $REGION \
     --user-pool-id $USER_POOL_ID --client-id $APP_CLIENT_ID
   node lib/bin/bgagent.js login --username user@example.com
   ```

## Completion

After all phases pass, summarize:
- Stack outputs (API URL, User Pool ID, etc.)
- Next steps: onboard a repository (use the `onboard-repo` skill)
- Point to the User Guide: https://aws-samples.github.io/sample-autonomous-cloud-coding-agents/user-guide/introduction/
