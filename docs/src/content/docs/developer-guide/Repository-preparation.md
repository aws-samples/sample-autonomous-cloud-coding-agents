---
title: Repository preparation
---

The CDK stack ships with a **sample onboarded repository** (`krokoko/agent-plugins` in `cdk/src/stacks/agent.ts`) so the project deploys and CDK tests run cleanly out of the box. That value is for **default wiring only**: a real agent run **pushes branches and opens pull requests** with your GitHub PAT, so the onboarded repo must be one your token can **clone, push to, and open PRs on**. Most people do **not** have that access to the upstream repo.

**Recommended first setup:** fork [`awslabs/agent-plugins`](https://github.com/awslabs/agent-plugins) on GitHub, set the `Blueprint` **`repo`** to **`your-github-username/agent-plugins`** (match your fork’s owner and repo name), and use a **fine-grained PAT** scoped to **that fork** with the permissions in step 2. Use the same token for **`GITHUB_TOKEN`** when running `./agent/run.sh` locally and store it in Secrets Manager (step 3) after deploy.

After deployment, the orchestrator **pre-flight** step calls the GitHub API to verify your token can access the task repository with enough privilege (`preflight.ts`). That catches common mistakes (for example a read-only PAT) **before** AgentCore work starts: the task fails with `INSUFFICIENT_GITHUB_REPO_PERMISSIONS` and a clear detail string instead of completing after a `git push` 403 buried in CloudWatch logs.

### Required setup

#### 1. Register repositories with `Blueprint`

The Task API only accepts tasks for repositories that are **onboarded** — each one is a `Blueprint` construct in `cdk/src/stacks/agent.ts` that writes a `RepoConfig` row to DynamoDB.

**Quick method** — pass the repo as a CDK context variable or environment variable (no code edits needed):

```bash
# Context variable (preferred)
MISE_EXPERIMENTAL=1 mise //cdk:deploy -- -c blueprintRepo=your-org/your-repo

# Or environment variable
BLUEPRINT_REPO=your-org/your-repo MISE_EXPERIMENTAL=1 mise //cdk:deploy
```

The default is `awslabs/agent-plugins`. For a quick end-to-end test, fork that repo and pass your fork (e.g. `-c blueprintRepo=jane-doe/agent-plugins`).

**Multiple repositories** — edit `cdk/src/stacks/agent.ts` directly:

1. Open **`cdk/src/stacks/agent.ts`** and locate the `Blueprint` block (for example `AgentPluginsBlueprint`).
2. Add another `new Blueprint(this, 'YourBlueprintId', { repo: 'owner/other-repo', repoTable: repoTable.table, ... })` and append it to the **`blueprints`** array. That array is used to aggregate per-repo **DNS egress** allowlists; skipping it can block the agent from reaching domains your Blueprint declares.

Optional per-repo overrides (same file / `Blueprint` props) include a different AgentCore **`runtimeArn`**, **`modelId`**, **`maxTurns`**, **`systemPromptOverrides`**, or a **`githubTokenSecretArn`** for a dedicated PAT. If you use a custom `runtimeArn` or secret per repo, you must also pass the corresponding ARNs into **`TaskOrchestrator`** via **`additionalRuntimeArns`** and **`additionalSecretArns`** so the orchestrator Lambda’s IAM policy allows them (see [Repo onboarding](/design/repo-onboarding) for the full model).

After changing Blueprints, redeploy: `cd cdk && npx cdk deploy` (or `MISE_EXPERIMENTAL=1 mise //cdk:deploy`).

#### 2. GitHub personal access token (fine-grained)

Create a **fine-grained PAT** at GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**.

**Repository access:** select only the repo(s) the agent will use (for the fork workflow, **only your fork**).

| Permission | Access | Reason |
|------------|--------|--------|
| **Contents** | Read and write | `git clone` and `git push` |
| **Pull requests** | Read and write | `gh pr create` / update PRs |
| **Issues** | Read | Issue title, body, and comments for context |
| **Metadata** | Read | Granted by default |

For **`new_task`** and **`pr_iteration`**, pre-flight requires **Contents write** (REST `permissions.push`, or GraphQL `viewerPermission` of `WRITE` / `MAINTAIN` / `ADMIN`). For **`pr_review`**, **Triage** or higher is sufficient when the workflow does not need to push branches. Classic PATs with equivalent **`repo`** scope still work; see `agent/README.md` for environment variables and edge cases.

#### 3. Store the PAT in AWS Secrets Manager (after deploy)

The stack creates a secret (output **`GitHubTokenSecretArn`**). After your first successful **`mise run //cdk:deploy`**, store the **same** PAT string you use locally:

```bash
# Same Region you deployed to (example: us-east-1). Must be non-empty—see [Post-deployment setup](#post-deployment-setup) if `put-secret-value` fails with a double-dot endpoint.
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

If you use a **per-repo** secret (`githubTokenSecretArn` on a Blueprint), put the PAT in that secret instead; the orchestrator reads whichever ARN is configured for the repo.

### Optional customization

#### Agent image (`agent/Dockerfile`)

The default image installs Python, Node 20, `git`, `gh`, Claude Code CLI, and **`mise`** for polyglot builds. If your repositories need extra runtimes (Java, Go, specific CLIs, native libs), **extend `agent/Dockerfile`** (and optionally `agent/` tooling) so `mise run build` and your stack’s workflows succeed inside the container. Rebuild the runtime asset when you change the Dockerfile (a normal `cd cdk && npx cdk deploy` / CDK asset build does this).

#### Stack name (optional)

The development stack id is set in **`cdk/src/main.ts`** (default **`backgroundagent-dev`**). If you rename it, update every place that passes **`--stack-name`** to the AWS CLI (including examples in this guide and any scripts you keep locally).

#### Fork-specific metadata (optional)

If you maintain your own fork, you will typically also replace **clone URLs**, **README badges**, **issue links**, and **`package.json` `name`** fields with your org’s identifiers. Those do not affect runtime behavior but avoid confusion for contributors.

#### Make target repositories easy for the agent

Keep each repo you onboard **clear and automatable**: documented build/test commands, consistent layout, and project-level agent hints (`CLAUDE.md`, `.claude/`). See [Make your codebase AI ready](https://medium.com/@alain.krok/make-your-codebase-ai-ready-05d6a160f1d5) for practical guidance.