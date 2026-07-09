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

Common Phase 2 snags to pre-empt (don't let these read as a broken environment):
- "yarn: command not found" → Corepack wasn't activated (step 3).
- `prek install` fails about `core.hooksPath` → another hook manager owns hooks; suggest `git config --unset-all core.hooksPath`.
- Node, Yarn, AND CDK all "not found" at once → expected before `mise install` finishes; mise provisions them.
- `mise install` fails Node on GPG verification (headless/EC2, no gpg-agent) → `mise settings set node.gpg_verify false` (still checksum-verified), retry.
- "config not trusted" for `~/.config/mise/config.toml` → run `mise trust` on the user-global config too, not just the project one.
- In a non-interactive/spawned shell, `mise` may not be on `PATH` → use `~/.local/bin/mise` or `mise exec --`.

## Phase 3: One-Time Host Setup (build architecture)

The agent image is built for **linux/arm64** (AgentCore runs on Graviton). On an **x86_64** build host this is the most common first-deploy blocker — the image build dies with `exec /bin/sh: exec format error`. Register QEMU emulation once per host:

```bash
docker run --privileged --rm tonistiigi/binfmt --install arm64
```

If `docker run --privileged` is blocked (security-managed hosts), deploy from a **native arm64 host** (Graviton EC2 / Apple Silicon) instead. On Apple Silicon / arm64 hosts, skip this phase.

**X-Ray tracing is OPTIONAL — do not gate deployment on it.** The stack ships with X-Ray→CloudWatch-Logs export disabled (`tracingEnabled` in `agent.ts`), so it deploys and runs fully without any X-Ray setup. Do NOT run `aws xray update-trace-segment-destination` as a prerequisite — on a security-managed AWS Org account an SCP can make that call fail with `AccessDeniedException` no matter what, dead-ending the user on a step the platform doesn't use. Mention tracing only as an opt-in extra.

## Phase 4: First Deployment

Guide through:

1. `mise //cdk:bootstrap` — Bootstrap CDK (if not already done for this account/region)
2. `mise //cdk:deploy -- --require-approval never` — Deploy the stack (~9.5 minutes). The flag avoids the approval prompt hanging in a non-interactive shell.
   - If the deploy rolls back on a missing IAM permission and lands in `ROLLBACK_COMPLETE`, the stack can't be updated — `mise //cdk:destroy` then redeploy. Teardown can stall in `DELETE_FAILED` for ~20–40 min while AgentCore's service-managed (Hyperplane) ENIs are reclaimed; wait, then retry destroy. Never force-delete past stuck VPC resources (orphans the VPC; VPCs are quota-capped per Region).
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
   mise //cli:build
   node cli/lib/bin/bgagent.js configure \
     --api-url $API_URL --region $REGION \
     --user-pool-id $USER_POOL_ID --client-id $APP_CLIENT_ID
   node cli/lib/bin/bgagent.js login --username user@example.com
   ```

## Completion

After all phases pass, summarize:
- Stack outputs (API URL, User Pool ID, etc.)
- Next steps: onboard a repository (use the `onboard-repo` skill)
- Point to the Quick Start: https://aws-samples.github.io/sample-autonomous-cloud-coding-agents/getting-started/quick-start/
