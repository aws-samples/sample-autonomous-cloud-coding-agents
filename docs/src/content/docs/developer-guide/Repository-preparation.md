---
title: Repository preparation
---

The CDK stack ships with a **sample onboarded repository** (`krokoko/agent-plugins` in `src/stacks/agent.ts`) so the project deploys and tests cleanly out of the box. To use ABCA with **your** GitHub repositories, you need to point the platform at those repos and give the agent the right tools and permissions.

### 1. Register repositories with `Blueprint` (required)

The Task API only accepts tasks for repositories that are **onboarded** — each one is a `Blueprint` construct in `src/stacks/agent.ts` that writes a `RepoConfig` row to DynamoDB.

1. Open **`src/stacks/agent.ts`** and locate the `Blueprint` block (for example `AgentPluginsBlueprint`).
2. Set **`repo`** to your repository in **`owner/repo`** form (e.g. `acme/my-service`). This must match the `repo` field users pass in the CLI or API.
3. **Multiple repositories:** add another `new Blueprint(this, 'YourBlueprintId', { repo: 'owner/other-repo', repoTable: repoTable.table, ... })` and append it to the **`blueprints`** array. That array is used to aggregate per-repo **DNS egress** allowlists; skipping it can block the agent from reaching domains your Blueprint declares.

Optional per-repo overrides (same file / `Blueprint` props) include a different AgentCore **`runtimeArn`**, **`modelId`**, **`maxTurns`**, **`systemPromptOverrides`**, or a **`githubTokenSecretArn`** for a dedicated PAT. If you use a custom `runtimeArn` or secret per repo, you must also pass the corresponding ARNs into **`TaskOrchestrator`** via **`additionalRuntimeArns`** and **`additionalSecretArns`** so the orchestrator Lambda’s IAM policy allows them (see [Repo onboarding](/design/repo-onboarding) for the full model).

After changing Blueprints, redeploy: `npx projen deploy`.

### 2. GitHub personal access token

The agent clones, pushes, and opens pull requests using a **GitHub PAT** stored in Secrets Manager (see [Post-deployment setup](#post-deployment-setup)). The token must have permission to access **every** onboarded repository (clone, push to branches, create/update PRs). Use a fine-grained PAT scoped to the right org/repos; see `agent/README.md` for required scopes.

### 3. Agent image (`agent/Dockerfile`)

The default image installs Python, Node 20, `git`, `gh`, Claude Code CLI, and **`mise`** for polyglot builds. If your repositories need extra runtimes (Java, Go, specific CLIs, native libs), **extend `agent/Dockerfile`** (and optionally `agent/` tooling) so `mise run build` and your stack’s workflows succeed inside the container. Rebuild the runtime asset when you change the Dockerfile (a normal `npx projen deploy` / CDK asset build does this).

### 4. Stack name (optional)

The development stack id is set in **`src/main.ts`** (default **`backgroundagent-dev`**). If you rename it, update every place that passes **`--stack-name`** to the AWS CLI (including examples in this guide and any scripts you keep locally).

### 5. Fork-specific metadata (optional)

If you maintain your own fork, you will typically also replace **clone URLs**, **README badges**, **issue links**, and **`package.json` `name`** fields with your org’s identifiers. Those do not affect runtime behavior but avoid confusion for contributors.

### 6. Make target repositories easy for the agent

Keep each repo you onboard **clear and automatable**: documented build/test commands, consistent layout, and project-level agent hints (`CLAUDE.md`, `.claude/`). See [Make your codebase AI ready](https://medium.com/@alain.krok/make-your-codebase-ai-ready-05d6a160f1d5) for practical guidance.