---
title: Repository preparation
---

The [Quick Start](./QUICK_START.mdx) covers the basic setup: forking a sample repo, creating a PAT, registering a Blueprint, and storing the token in Secrets Manager. This section covers what you need beyond that.

### Pre-flight checks

After deployment, the orchestrator calls the GitHub API before starting each task to verify your token has enough privilege. This catches common mistakes (like a read-only PAT) before compute is consumed. If the check fails, the task transitions to `FAILED` with a clear reason like `INSUFFICIENT_GITHUB_REPO_PERMISSIONS` instead of failing deep inside the agent run.

Permission requirements vary by task type:

- `new_task` and `pr_iteration` require Contents (read/write) and Pull requests (read/write).
- `pr_review` only needs Triage or higher since it does not push branches.

Classic PATs with `repo` + `read:org` scopes also work and are required when fine-grained tokens cannot reach the target repo (collaborator access, cross-org repos). See [agent/README.md](/sample-autonomous-cloud-coding-agents/architecture/readme#github-pat--minimal-permissions) for when to use which token type.

### Quick setup (single repo)

To point the default Blueprint at your own repo without editing code, pass it as a CDK context variable or environment variable:

```bash
# Context variable (preferred)
MISE_EXPERIMENTAL=1 mise //cdk:deploy -- -c blueprintRepo=your-org/your-repo

# Or environment variable
BLUEPRINT_REPO=your-org/your-repo MISE_EXPERIMENTAL=1 mise //cdk:deploy
```

The default is `awslabs/agent-plugins`. For a quick end-to-end test, fork that repo and pass your fork (e.g. `-c blueprintRepo=jane-doe/agent-plugins`).

### Multiple repositories

To onboard additional repositories, add more `Blueprint` constructs in `cdk/src/stacks/agent.ts` and append them to the `blueprints` array (used to aggregate DNS egress allowlists):

```typescript
new Blueprint(this, 'MyServiceBlueprint', {
  repo: 'acme/my-service',
  repoTable: repoTable.table,
});
```

Each Blueprint supports per-repo overrides grouped into nested props (`BlueprintProps` in `cdk/src/constructs/blueprint.ts`):

```typescript
new Blueprint(this, 'MyServiceBlueprint', {
  repo: 'acme/my-service',
  repoTable: repoTable.table,
  compute: { runtimeArn: '...' },                    // override the default runtime ARN
  agent: {
    modelId: 'global.anthropic.claude-opus-5',       // foundation model override
    maxTurns: 150,                                    // default turn limit for this repo
    systemPromptOverrides: 'Extra instructions...',   // appended to the platform prompt
  },
  credentials: { githubTokenSecretArn: '...' },       // per-repo GitHub token secret
  pipeline: {
    pollIntervalMs: 5000,                             // poll interval awaiting completion
    buildCommand: 'npm run build && npm test',        // build/test verification (default: mise run build)
    lintCommand: 'npm run lint',                      // lint verification (default: mise run lint)
  },
});
```

If you use a custom `compute.runtimeArn` or `credentials.githubTokenSecretArn`, pass the ARNs to `TaskOrchestrator` via `additionalRuntimeArns` and `additionalSecretArns` so the Lambda has IAM permission. See [Repo onboarding](/sample-autonomous-cloud-coding-agents/architecture/repo-onboarding) for the full model.

#### Build-regression gating (important for non-mise repos)

Before opening a PR, the agent runs a **build** and **lint** command in its cloud container — once on the clean clone (baseline) and again after its changes. If the build was green before and fails after, the task fails (a build-**regression** gate). This is a compile/test verification, **not** a deployment — your app's actual deploy stays in your own CI/CD after the PR merges.

The command defaults to **`mise run build`** / **`mise run lint`**. A repo that uses [mise](https://mise.jdx.dev/) with `build` / `lint` tasks gets gating for free. A repo that uses npm, gradle, cargo, make, etc. **must set `pipeline.buildCommand`** (and optionally `lintCommand`) to its real command — otherwise the default `mise run build` finds no task, **build-regression gating is silently OFF, and a change that breaks the build still reports success**. When that happens the agent surfaces a `⚠️ Build-regression gating is OFF` warning on the PR so the gap is visible, but the fix is to configure the command. For #247 orchestration this matters doubly: dependent sub-issues stack onto a predecessor's branch, so an unverified broken predecessor propagates downstream.

Redeploy after changing Blueprints: `mise //cdk:deploy`.

### Customizing the agent image

The default image (`agent/Dockerfile`) includes Python, Node 24 (LTS), `git`, `gh`, Claude Code CLI, and `mise`. If your repositories need additional runtimes (Java, Go, native libs), extend the Dockerfile. A normal `cdk deploy` rebuilds the image asset.

### Writing Cedar policies for the repo

A blueprint can declare its own `security.cedarPolicies` rules on top of the built-in hard/soft-deny starter set. Hard-deny rules absolutely block a tool call; soft-deny rules pause the agent and ask a human before proceeding.

See the [Cedar policy guide](/sample-autonomous-cloud-coding-agents/customizing/cedar-policies) for the full authoring reference — vocabulary (`execute_bash`, `write_file`, `context.command`, `context.file_path`), annotations (`@rule_id`, `@tier`, `@approval_timeout_s`, `@severity`, `@category`), worked examples, multi-match rules, and cross-engine parity testing with [`contracts/cedar-parity/`](../../contracts/cedar-parity/) fixtures.

### Input guardrail versions

The input guardrail publishes one version for each rendered configuration. Its logical ID hashes the final guardrail CloudFormation properties, excluding deployment tags, plus the publication description. Unrelated CDK tokens and GitHub run tags do not publish a new version. Policy changes, including changes made through CDK escape hatches, do; changing the publication description also requires a new version under CloudFormation's replacement rules. Published versions have `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain` so older executions can keep using them while the guardrail exists. Retained versions need explicit cleanup after consumers and rollback windows have expired, and count toward Bedrock version quotas. Retaining a version does not protect it if its parent guardrail is deleted.

**Existing installations need an explicit binding before upgrading from the earlier alpha-CDK versioning scheme.** Without it, the new logical ID would remove the old version from the template, and that old resource may not yet have a retention policy. New installations need no binding.

For an existing installation:

1. Capture the deployed template and the input guardrail version's logical and physical IDs. Read the published Bedrock version's configuration too; the mutable `DRAFT` alone is not evidence of what that version contains.
2. Synthesize the candidate using the installation's exact stack name, account, Region, configuration and build inputs. Read `abca:guardrail-configuration-sha256` from the candidate `AWS::Bedrock::GuardrailVersion` metadata. Compare the native guardrail configuration with both the deployed template and published version. Do not use a structural census fixture's hash for a real installation.
3. Set the CDK context `guardrailVersionMigration` to `{"logicalId":"<deployed-version-logical-id>","configurationHash":"<candidate-64-character-sha256>"}`. CDK accepts this object in context or as a quoted JSON string passed through `-c`. Synthesize again and review the complete change set: the native guardrail, existing version identity/properties, and consumers must remain unchanged. Retention policies, metadata and an explicit dependency on the guardrail are the expected version changes.
4. Rehearse the normalization before deploying it to a protected installation. Check all unrelated changes, active executions, rollback and quota headroom too. The binding checks the candidate hash locally; it does not query AWS or prove that the supplied logical ID and published configuration belong together.

Keep the binding through unchanged releases. A configuration change while it is present fails synthesis. When intentionally releasing a new guardrail configuration, remove the binding in that release; this switches to configuration-derived identities and publishes a new version. First verify that the normalization successfully installed retention on the old version. Retain the binding with the old release inputs for rollback review; do not assume rolling back to the earlier alpha-CDK implementation reproduces its original token-derived identity.

### Other options

- **Stack name** - The default is `backgroundagent-dev` (set in `cdk/src/main.ts`). If you rename it, update all `--stack-name` references.
- **Making repos agent-friendly** - Add `CLAUDE.md`, `.claude/rules/`, and clear build commands. See the [Prompt guide](/sample-autonomous-cloud-coding-agents/customizing/prompt-engineering#repo-level-instructions) for details.