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
7. `mise run build` — Full monorepo build (agent quality + CDK, CLI, web and docs builds + Jira Forge app tests + drift checks)

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

Deploy with `bgagent setup`, not `mise //cdk:deploy`. Setup chooses the minimal deployment profile, checks Region support, installs ABCA's least-privilege CDK bootstrap when the account has none, reviews `cdk diff`, refuses to delete data without a typed confirmation, and points the CLI at the new stack. A bare `mise //cdk:deploy` skips all of that and deploys every optional feature.

1. Ask the user (AskUserQuestion) for:
   - the AWS Region;
   - optional features: none (recommended for a first deployment) or any of `slack`, `linear`, `jira`, `deployPreviewScreenshots`, `agentRegistry`, `toolGateway`;
   - compute: `agentcore` (recommended), `ecs` or `agentcore,ecs`.
2. Confirm the account with `aws sts get-caller-identity` and show it to the user before deploying.
3. Run setup from `cli/`. Your shell has no terminal, so pass `--features` and `--yes`. Deploying takes about 10 minutes; run it in the background and report progress from the log under `~/.bgagent/logs/<stack>/`.
   ```bash
   cd cli
   node lib/bin/bgagent.js setup --region <region> --features none --compute agentcore --yes
   ```
   - Use `--features none` for the minimal profile, or a comma-separated list.
   - **Never pass `--accept-data-loss`.** If setup refuses because the change would delete state-bearing resources, stop. Tell the user what it would remove and ask them to run `node lib/bin/bgagent.js setup` themselves in a terminal, where they confirm by typing the stack name.
   - If the deploy rolls back and the stack lands in `ROLLBACK_COMPLETE`, it can't be updated: `mise //cdk:destroy`, then run setup again. Teardown can stall in `DELETE_FAILED` for ~20–40 min while AgentCore's service-managed (Hyperplane) ENIs are reclaimed; wait, then retry destroy. Never force-delete past stuck VPC resources (orphans the VPC; VPCs are quota-capped per Region).
4. Setup prints next steps. Follow them in order, from `cli/`:
   - store the GitHub PAT: `node lib/bin/bgagent.js github set-token --region <region>` (interactive, so ask the user to run it, or use `aws secretsmanager put-secret-value` on the `GitHubTokenSecretArn` output);
   - create a user: `node lib/bin/bgagent.js admin invite-user <email> --region <region>` (the password is in `~/.bgagent/invites/<email>.txt`);
   - sign in: `node lib/bin/bgagent.js login --username <email>`;
   - onboard a repository: `node lib/bin/bgagent.js repo onboard <owner/repo> --region <region>` (see the `onboard-repo` skill).

For a stack other than `backgroundagent-dev`, add `--stack-name <name>` to each command. ABCA's bootstrap only deploys `backgroundagent-dev` and `backgroundagent-dev-<suffix>`.

## Phase 5: Smoke Test

1. `node lib/bin/bgagent.js platform doctor --region <region>` from `cli/`: checks the API, Cognito, GitHub token, Bedrock model access and onboarded repositories.
2. `node lib/bin/bgagent.js list` should return an empty task list.

## Completion

After all phases pass, summarize:
- Stack outputs (API URL, User Pool ID, etc.)
- Next steps: submit a first task (use the `submit-task` skill)
- Point to the Quick Start: https://aws-samples.github.io/sample-autonomous-cloud-coding-agents/getting-started/quick-start/
