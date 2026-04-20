---
title: Repository preparation
---

The [Quick Start](/getting-started/quick-start) covers the basic setup: forking a sample repo, creating a PAT, registering a Blueprint, and storing the token in Secrets Manager. This section covers what you need beyond that.

### Pre-flight checks

After deployment, the orchestrator calls the GitHub API before starting each task to verify your token has enough privilege. This catches common mistakes (like a read-only PAT) before compute is consumed. If the check fails, the task transitions to `FAILED` with a clear reason like `INSUFFICIENT_GITHUB_REPO_PERMISSIONS` instead of failing deep inside the agent run.

Permission requirements vary by task type:

- `new_task` and `pr_iteration` require Contents (read/write) and Pull requests (read/write).
- `pr_review` only needs Triage or higher since it does not push branches.

Classic PATs with `repo` scope also work. See `agent/README.md` for edge cases.

### Multiple repositories

To onboard additional repositories, add more `Blueprint` constructs in `cdk/src/stacks/agent.ts` and append them to the `blueprints` array (used to aggregate DNS egress allowlists):

```typescript
new Blueprint(this, ‘MyServiceBlueprint’, {
  repo: ‘acme/my-service’,
  repoTable: repoTable.table,
});
```

Each Blueprint supports per-repo overrides: `runtimeArn`, `modelId`, `maxTurns`, `systemPromptOverrides`, `githubTokenSecretArn`, and `pollIntervalMs`. If you use a custom `runtimeArn` or secret, pass the ARNs to `TaskOrchestrator` via `additionalRuntimeArns` and `additionalSecretArns` so the Lambda has IAM permission. See [Repo onboarding](/architecture/repo-onboarding) for the full model.

Redeploy after changing Blueprints: `mise run //cdk:deploy`.

### Customizing the agent image

The default image (`agent/Dockerfile`) includes Python, Node 20, `git`, `gh`, Claude Code CLI, and `mise`. If your repositories need additional runtimes (Java, Go, native libs), extend the Dockerfile. A normal `cdk deploy` rebuilds the image asset.

### Other options

- **Stack name** - The default is `backgroundagent-dev` (set in `cdk/src/main.ts`). If you rename it, update all `--stack-name` references.
- **Making repos agent-friendly** - Add `CLAUDE.md`, `.claude/rules/`, and clear build commands. See the [Prompt guide](/customizing/prompt-engineering#repo-level-instructions) for details.