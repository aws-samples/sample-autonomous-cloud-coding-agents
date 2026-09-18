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

### Blueprint controller handoff

`blueprintProvisioning` selects the repository-provisioning lifecycle. Its default is `legacy`, so upgrading source alone does not switch an existing installation to a different custom-resource provider.

| Context value | Behavior |
|---|---|
| `legacy` | Existing `AwsCustomResource` writes, including synthesis-time timestamps. |
| `prepare` | Preserve the legacy resource identity, retain it on removal/replacement, and replace Create/Update with read-only `DescribeTable` calls. Delete has no callback. Repository configuration is frozen during this stage. |
| `adopt` | Replace the retained legacy resource with the new controller. Reconcile declared settings while preserving onboarding time and undeclared overrides. Retain the new resource and disable deletion, including during rollback. |
| `managed` | Keep the new provider and resource identity; enable normal configuration updates and soft deletion with a TTL 30 days after the delete callback executes. |

For **existing deployments**, use separate, verified deployments of `prepare`, then `adopt`, then `managed`. Pass the selected value through the normal CDK context mechanism, for example `-c blueprintProvisioning=prepare`. Keep the same stack identity, complete Blueprint set, repository names, table and configuration throughout the handoff. Inventory the deployed resource IDs and repository rows, establish backups/recovery, and rehearse on a populated disposable deployment first. Review the complete change set, including image/version changes and unrelated resources.

After `prepare`, verify the deployed legacy resource has both retention policies, read-only Create/Update calls and no Delete property. After `adopt`, verify each row remains active, its original onboarding time and CLI overrides survive, stale TTLs are absent, and its new ownership record is present. Only then enable `managed`. Going directly to `managed` cannot adopt an existing unowned row; the transaction fails instead of overwriting it.

Adoption disables deletion so a failed cutover can return to the prepared template without tombstoning repository rows. Recovery must use the **prepared** template, whose Create callback is also inert; returning to the original legacy template can run its unconditional `PutItem`. Once managed deletion is enabled, first deploy `adopt` again before any recovery that removes the new resource. Do not roll an existing managed deployment directly back to an old legacy checkout. Reconcile retained resources explicitly after a failed operation.

For **new installations with no existing repository rows**, `managed` can be selected directly. Existing CLI-onboarded rows require adoption too. A different active Blueprint cannot claim the same row; repository/table changes get a new physical identity, and deletion of the old identity is scoped to its old row. Supported backend selection and transition rules still apply separately.

The provider and its private DynamoDB ownership ledger live in one shared nested stack. Transactions update repository configuration, ownership and a request receipt together. A duplicate request, even after later updates, returns its original result without replaying a configuration write. An older owner's Delete cannot remove a row claimed by a newer owner. Coordination metadata is separate from RepoTable because older CLI versions rewrite repository rows. The ledger has PITR; normal group teardown deletes it only after dependent custom resources finish. Do not manually delete or restore it independently of those resources. A failed Create can leave external state if the CloudFormation response is lost; inspect the ledger and repository before retrying or retiring that stack identity.

Managed writes preserve `onboarded_at`, timestamp actual operations, clear stale TTLs on activation, and set only declared overrides. Empty asset lists explicitly remove `mcp_servers`, `cedar_policy_modules`, and `skills`; other omitted overrides remain available to the CLI. An unchanged template no longer writes repository configuration on every deployment.

To measure a lifecycle stage across the structural profiles without deploying, first let build and test tasks finish. The current repository-root image context includes generated test artifacts; concurrent writes can change image hashes even when the Git source fingerprint is unchanged.

```bash
MISE_EXPERIMENTAL=1 mise //cdk:census -- --blueprint-provisioning managed --check-stability
```

This verifies template structure and repeatability. Live transactions, rollback and deployed-state reconciliation still need a rehearsal before production migration.

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