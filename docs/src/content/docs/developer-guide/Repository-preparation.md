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

To onboard additional repositories, add entries to `resolveBlueprintDefinitions` in `cdk/src/blueprints/definitions.ts`. The app resolves these plain inputs before constructing either stack, so repository provisioning and DNS egress policy use the same configuration:

```typescript
definitions.push({
  id: 'MyServiceBlueprint',
  repo: 'acme/my-service',
});
```

Each entry supports the per-repo overrides from `BlueprintProps` in `cdk/src/constructs/blueprint.ts`, without a table reference. Keep its `id` stable across releases:

```typescript
definitions.push({
  id: 'MyServiceBlueprint',
  repo: 'acme/my-service',
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

### Stack decomposition and synthesis budgets

`networkTopology` defaults to `inline`, preserving existing network ownership. For a new installation, `split` puts AgentVpc and DnsFirewall in `${stackName}-network`; the application consumes VPC, subnet and security-group exports. The network has no application dependencies. Plain Blueprint definitions are resolved once in `cdk/src/blueprints/definitions.ts` so DNS and repository provisioning use the same domains without cross-stack coupling. Task API routes, authorizers, permissions, CORS and deployment remain together in `AgentStack`.

The CDK build and offline census share 116 named profiles: the 40-cell single-backend/service/image product in both topologies, supplemental email/fork/consent cases, explicit three-AZ pins, every multi-backend set at default and widest settings, and legacy additive selectors. Successful profiles check every parent and nested template against 490 resources, 800,000 bytes and 200 parameters/outputs. They also verify method-scoped API permissions, absence of console test-invoke grants and template-size warnings, backend membership, and two-zone auto-pin versus explicit pins. Expected resource-budget failures must identify the application stack and the production ceiling; unrelated errors cannot satisfy the gate.

```bash
MISE_EXPERIMENTAL=1 mise //cdk:census -- --output /tmp/stack-census
```

Use `--list` to see the profiles and `--profile NAME` to select them. The census runs the production app with fixed account/AZ inputs, CDK metadata enabled and bundling/staging disabled. It records template inventories, counts, bytes, dependencies and source provenance. The production app sets CDK's `@aws-cdk/core:stackResourceLimit` before any stack is constructed, so actual operator configurations outside the census also fail above 490. Context overrides may tighten but cannot raise the limit. `--max-resources` can only tighten the census audit ceiling.

`--check-stability` runs each selected profile twice in independent processes and fails on differences. It does not normalize away timestamps, logical IDs or asset hashes. The existing Blueprint callbacks embed synthesis-time timestamps, and the alpha Bedrock guardrail uses token-derived version IDs; unchanged source can therefore fail this optional diagnostic. Deterministic Blueprint provisioning, guardrail versioning and Docker build-context changes are deferred. Passing the budget gate is not a claim of repeatable synthesis or live resource preservation.

Network tests compare the moved definitions, generated Name tags, endpoint security-group descriptions, exports, application service properties, shared API resources, solution attribution and provenance tags. Comparison tests fix the clock and account for existing immutable guardrail/orchestrator version IDs; the census reports those real differences. `networkReservedAzs` reserves unused address slots so removing a trailing AZ need not shift remaining subnet CIDRs. Follow the [staged AZ reduction procedure](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#reducing-azs-in-an-existing-split-network) to release old imports before changing the network.

Existing inline-to-split migration remains deferred under [#852](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/852). A populated `cdk refactor`/import and rollback rehearsal is still required before a supported migration procedure can be published. Retention and Blueprint ownership handoff must be separately reviewed and released; this change keeps existing removal policies and the existing Blueprint provider. The concrete follow-up requirements are recorded in [ADR-023](/sample-autonomous-cloud-coding-agents/architecture/adr-023-cloudformation-stack-boundaries#deferred-migration-work). See [Network stack topology](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#network-stack-topology) for fresh-install guidance and migration limits.

### Customizing the agent image

The default image (`agent/Dockerfile`) includes Python, Node 24 (LTS), `git`, `gh`, Claude Code CLI, and `mise`. If your repositories need additional runtimes (Java, Go, native libs), extend the Dockerfile. A normal `cdk deploy` rebuilds the image asset.

### Writing Cedar policies for the repo

A blueprint can declare its own `security.cedarPolicies` rules on top of the built-in hard/soft-deny starter set. Hard-deny rules absolutely block a tool call; soft-deny rules pause the agent and ask a human before proceeding.

See the [Cedar policy guide](/sample-autonomous-cloud-coding-agents/customizing/cedar-policies) for the full authoring reference — vocabulary (`execute_bash`, `write_file`, `context.command`, `context.file_path`), annotations (`@rule_id`, `@tier`, `@approval_timeout_s`, `@severity`, `@category`), worked examples, multi-match rules, and cross-engine parity testing with [`contracts/cedar-parity/`](../../contracts/cedar-parity/) fixtures.

### Other options

- **Stack name** - The default is `backgroundagent-dev` (set in `cdk/src/main.ts`). If you rename it, update all `--stack-name` references.
- **Making repos agent-friendly** - Add `CLAUDE.md`, `.claude/rules/`, and clear build commands. See the [Prompt guide](/sample-autonomous-cloud-coding-agents/customizing/prompt-engineering#repo-level-instructions) for details.