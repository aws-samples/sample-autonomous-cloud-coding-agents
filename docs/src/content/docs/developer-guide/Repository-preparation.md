---
title: "Repository preparation"
---

The [Quick Start](/sample-autonomous-cloud-coding-agents/getting-started/quick-start) covers the basic setup: forking a sample repo, creating a PAT, registering a Blueprint, and storing the token in Secrets Manager. This section covers what you need beyond that.

### Pre-flight checks

After deployment, the orchestrator calls the GitHub API before it starts each task, to verify that your token has enough privilege. The check catches common mistakes, such as a read-only PAT, before the task consumes compute. If the check fails, the task transitions to `FAILED` with a reason such as `INSUFFICIENT_GITHUB_REPO_PERMISSIONS`, instead of failing later inside the agent run.

Permission requirements vary by task type:

- `new_task` and `pr_iteration` require Contents (read/write) and Pull requests (read/write).
- `pr_review` needs only Triage or higher, because it does not push branches.

Classic PATs with the `repo` and `read:org` scopes also work. They are required when fine-grained tokens cannot reach the target repo (collaborator access, cross-org repos). See [agent/README.md](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/agent/README.md#github-pat--minimal-permissions) for when to use which token type.

### Quick setup (single repo)

To point the default Blueprint at your own repo without editing code, pass the repo as a CDK context variable or as an environment variable:

```bash
# Context variable (preferred)
mise //cdk:deploy -- -c blueprintRepo=your-org/your-repo

# Or environment variable
BLUEPRINT_REPO=your-org/your-repo mise //cdk:deploy
```

The default is `awslabs/agent-plugins`. For a quick end-to-end test, fork that repo and pass your fork (for example, `-c blueprintRepo=jane-doe/agent-plugins`).

### Multiple repositories

To onboard more repositories, add entries to `resolveBlueprintDefinitions` in `cdk/src/blueprints/definitions.ts`. The app resolves these plain inputs before it constructs either stack, so repository provisioning and the DNS egress policy use the same configuration:

```typescript
definitions.push({
  id: 'MyServiceBlueprint',
  repo: 'acme/my-service',
});
```

Each entry supports the per-repo overrides from `BlueprintProps` in `cdk/src/constructs/blueprint.ts`, without a table reference. Keep the `id` of each entry stable across releases:

```typescript
definitions.push({
  id: 'MyServiceBlueprint',
  repo: 'acme/my-service',
  compute: { runtimeArn: '...' },                    // override the default runtime ARN
  agent: {
    modelId: 'global.anthropic.claude-opus-5-5',     // foundation model override
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

If you use a custom `compute.runtimeArn` or `credentials.githubTokenSecretArn`, pass the ARNs to `TaskOrchestrator` through `additionalRuntimeArns` and `additionalSecretArns`, so that the Lambda has IAM permission. See [Repo onboarding](/sample-autonomous-cloud-coding-agents/architecture/repo-onboarding) for the full model.

#### Build-regression gating (important for non-mise repos)

Before it opens a PR, the agent runs a **build** command and a **lint** command in its cloud container. It runs them once on the clean clone, as the baseline, and again after its changes. If the build passed before and fails after, the task fails. That check is the build-**regression** gate. The gate is a compile and test verification, **not** a deployment. Your app's deploy stays in your own CI/CD after the PR merges.

The commands default to **`mise run build`** and **`mise run lint`**. A repo that uses [mise](https://mise.jdx.dev/) with `build` and `lint` tasks needs no configuration for the gate. A repo that uses another build tool, such as npm, gradle, cargo, or make, **must set `pipeline.buildCommand`** to its real command, and can also set `lintCommand`. Otherwise the default `mise run build` finds no task, **build-regression gating is silently OFF, and a change that breaks the build still reports success**. When that happens, the agent puts a `⚠️ Build-regression gating is OFF` warning on the PR so that the gap is visible, but the fix is to configure the command. The gap matters twice over for #247 orchestration. Dependent sub-issues stack onto the branch of a predecessor, so a broken predecessor that was not verified passes its breakage to every sub-issue that depends on it.

After you change Blueprints, redeploy with `mise //cdk:deploy`. A redeploy writes the overrides that a definition declares. It does not clear an override that was deleted from the definition. See [Removing a per-repo override](/sample-autonomous-cloud-coding-agents/customizing/per-repo-overrides#removing-a-per-repo-override).

### Stack decomposition and synthesis budgets

`networkTopology` defaults to `inline`. That value preserves existing network ownership. For a new installation, `split` puts AgentVpc and DnsFirewall in `${stackName}-network`, and the application consumes the VPC, subnet and security-group exports. The network has no application dependencies. `cdk/src/blueprints/definitions.ts` resolves the plain Blueprint definitions once, so DNS and repository provisioning use the same domains without cross-stack coupling. Task API routes, authorizers, permissions, CORS and deployment remain together in `AgentStack`.

The CDK build and offline census share 142 named profiles: the 40-cell single-backend/service/image product in both topologies, supplemental email/fork/consent cases, explicit three-AZ pins, expanded `bedrockModels` grants, every multi-backend set at default and widest settings, legacy additive selectors, and [deployment-profile](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#deployment-profiles) cells (minimal, each optional feature alone, Linear+Jira, Linear+screenshots, all features). The feature cells also assert that disabled features leave no resources, outputs, routes or Lambda permissions, and that each feature's catalogued footprint stays within 15% of synthesis. The census ignores `abca.deployment.json` (`deploymentProfile=none`). Successful profiles check every parent and nested template against 490 resources, 800,000 bytes and 200 parameters/outputs. They also verify method-scoped API permissions, the absence of console test-invoke grants and of three synthesis warnings (template size, a custom resource left on CDK's default of downloading the latest SDK, a cdk-nag rule that could not be evaluated), backend membership, and two-zone auto-pin versus explicit pins. The model-expansion cases add synthetic IDs to the platform defaults and assert that CDK generates IAM overflow policies for the SessionRole and for each backend's compute role, and that those policies pass the audit. These fixtures test policy size, not model availability. Expected resource-budget failures must identify the application stack and the production ceiling. Unrelated errors cannot satisfy the gate.

```bash
mise //cdk:census -- --output /tmp/stack-census
```

Use `--list` to see the profiles and `--profile NAME` to select them. The census runs the production app with fixed account and AZ inputs, with CDK metadata enabled, and with bundling and staging disabled. It records template inventories, counts, bytes, dependencies and source provenance. The production app sets CDK's `@aws-cdk/core:stackResourceLimit` before it constructs any stack, so operator configurations outside the census also fail above 490. Context overrides can tighten the limit but cannot raise it. `--max-resources` can only tighten the census audit ceiling.

`--check-stability` runs each selected profile twice in independent processes and fails on differences. It does not normalize away timestamps, logical IDs or asset hashes. The existing Blueprint callbacks embed synthesis-time timestamps, so unchanged source can fail this optional diagnostic. The version of the input guardrail no longer differs between two syntheses, because its logical ID contains a hash of the guardrail's configuration ([#1079](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/1079)). Deterministic Blueprint provisioning and Docker build-context changes are deferred. Passing the budget gate is not a claim of repeatable synthesis or live resource preservation.

Network tests compare the moved definitions, generated Name tags, endpoint security-group descriptions, exports, application service properties, shared API resources, solution attribution and provenance tags. Comparison tests fix the clock. The census does not, and it reports the Blueprint timestamps. The tests also map one immutable version ID that differs between the topologies. On ECS, the orchestrator's environment names the private subnets, by reference in the inline topology and by import in the split topology, and the logical ID of the orchestrator's function version hashes that environment. `networkReservedAzs` reserves unused address slots, so that removing a trailing AZ need not shift the remaining subnet CIDRs. Before you change the network, follow the [staged AZ reduction procedure](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#reducing-azs-in-an-existing-split-network) to release old imports.

Migration of an existing inline deployment to split remains deferred under [#852](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/852). A populated `cdk refactor`/import and rollback rehearsal is still required before a supported migration procedure can be published. Retention and the Blueprint ownership handoff must be reviewed and released separately. This change keeps the existing removal policies and the existing Blueprint provider. [ADR-023](/sample-autonomous-cloud-coding-agents/decisions/adr-023-cloudformation-stack-boundaries#deferred-migration-work) records the concrete follow-up requirements. See [Network stack topology](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#network-stack-topology) for fresh-install guidance and migration limits.

### Customizing the agent image

The default image (`agent/Dockerfile`) includes Python, Node 24 (LTS), `git`, `gh`, Claude Code CLI, and `mise`. If your repositories need more runtimes, such as Java, Go, or native libs, extend the Dockerfile. A normal `cdk deploy` rebuilds the image asset.

### Writing Cedar policies for the repo

A blueprint can declare its own `security.cedarPolicies` rules in addition to the built-in starter set of hard-deny and soft-deny rules. A hard-deny rule always blocks a tool call. A soft-deny rule pauses the agent and asks a human before the agent proceeds.

See the [Cedar policy guide](/sample-autonomous-cloud-coding-agents/customizing/cedar-policies) for the full authoring reference. It covers the vocabulary (`execute_bash`, `write_file`, `context.command`, `context.file_path`), the annotations (`@rule_id`, `@tier`, `@approval_timeout_s`, `@severity`, `@category`), worked examples, multi-match rules, and cross-engine parity testing with the [`contracts/cedar-parity/`](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/tree/main/contracts/cedar-parity) fixtures.

### Other options

- **Stack name.** The default is `backgroundagent-dev` (set in `cdk/src/main.ts`). If you rename it, update all `--stack-name` references.
- **Making repos agent-friendly.** Add `CLAUDE.md`, `.claude/rules/`, and clear build commands. See the [Prompt guide](/sample-autonomous-cloud-coding-agents/customizing/prompt-engineering#repo-level-instructions) for details.