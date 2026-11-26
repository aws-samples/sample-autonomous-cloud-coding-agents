---
title: "Repository onboarding"
---

Before users can submit tasks for a repository, that repository must be onboarded to the platform. Onboarding registers the repo and produces a per-repo configuration that the orchestrator uses at task time. The configuration covers the compute strategy, model, credentials, networking, and pipeline customizations. If a user submits a task for a repo that is not onboarded, the API returns `422 REPO_NOT_ONBOARDED`.

- **Use this doc for:** the Blueprint construct interface, RepoConfig schema, override precedence, compute strategy interface, and pipeline customization model.
- **For practical usage:** see [Quick Start](/sample-autonomous-cloud-coding-agents/getting-started/quick-start) for onboarding your first repo and [User Guide](/sample-autonomous-cloud-coding-agents/using/overview) for per-repo overrides.
- **Related docs:** [ORCHESTRATOR.md](/sample-autonomous-cloud-coding-agents/architecture/orchestrator) for how the orchestrator consumes blueprint config, [COMPUTE.md](/sample-autonomous-cloud-coding-agents/architecture/compute) for compute backends, [SECURITY.md](/sample-autonomous-cloud-coding-agents/architecture/security) for custom step trust boundaries.

## Why onboarding?

Repositories differ in ways that affect how the agent works: languages, build systems, toolchains, conventions, and security requirements. A Node.js monorepo needs different tooling than a Python microservice. So the onboarding pipeline produces a configuration for each repo. The configuration covers:

- **Compute.** Runtime image, compute backend, resource profile.
- **Agent.** Model, turn limits, cost budget, system prompt overrides.
- **Security.** Credentials, tool access tier, egress rules.
- **Pipeline.** Custom steps, step ordering, poll interval.

## Onboarding mechanism

The canonical onboarding path uses CDK. Each repo is an instance of the `Blueprint` construct in the CDK stack. The construct writes a `RepoConfig` record to DynamoDB. Deploying the stack onboards or updates repos. There is no task-submitter REST API for repo CRUD. The orchestrator gate reads `RepoTable` at runtime.

This design treats blueprints as infrastructure, not runtime config. Each repo's blueprint defines AWS resources (compute, networking, credentials). CDK manages the lifecycle. The gate, which rejects tasks for repos that are not onboarded, reads DynamoDB at runtime, so the runtime path stays simple.

### Operator CLI path (day-2)

For operators with IAM access to the deployed stack, `bgagent repo onboard` and `bgagent repo offboard` write `RepoTable` directly, with no Cognito login and no CDK redeploy. This path ships in [#378](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/378) and PR [#385](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/385), ahead of a future `POST /v1/repos` API.

| Aspect | CDK `Blueprint` | `bgagent repo onboard` and `offboard` |
|--------|-----------------|-------------------------------------|
| **Who** | Deploy role at `mise //cdk:deploy` | Operator AWS credentials (`operator-context`) |
| **What it writes** | Full `RepoConfig` and supporting AWS resources | `RepoTable` row only (same schema) |
| **Soft-delete** | `status=removed` and a 30-day TTL on stack removal | Same semantics on `offboard` |
| **IAM for a custom runtime or token** | `additionalRuntimeArns` and `additionalSecretArns` in CDK | Stored in the row, but orchestrator IAM still requires a CDK deploy |
| **Cedar, egress, pipeline steps** | Supported through construct props | Not exposed. Use CDK |
| **Audit trail** | CloudFormation change set and deploy logs | CLI stdout only today (see [ADR-017](/sample-autonomous-cloud-coding-agents/decisions/adr-017-operator-cli-repo-onboarding)) |

Use the CLI path for quick day-2 registration with platform defaults (runtime ARN, GitHub token secret). Use CDK when the repo needs durable infrastructure, custom IAM, Cedar policies, egress rules, or pipeline customization. The onboard command prints notes that explain which platform defaults apply and when a redeploy is still required.

See also [the operator commands in the User Guide](/sample-autonomous-cloud-coding-agents/using/using-the-cli#operator-commands-stack-admin) and [ADR-017](/sample-autonomous-cloud-coding-agents/decisions/adr-017-operator-cli-repo-onboarding).

### Blueprint construct

```typescript
interface BlueprintProps {
  repo: string;                        // "owner/repo"
  repoTable: dynamodb.ITable;
  compute?: {
    type?: 'agentcore' | 'ecs' | 'lambda-microvm'; // inherits first deployed backend
    runtimeArn?: string;
    config?: Record<string, unknown>;
  };
  agent?: {
    modelId?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;             // $0.01-$100
    memoryTokenBudget?: number;        // default: 2000
    systemPromptOverrides?: string;
  };
  security?: {
    capabilityTier?: 'standard' | 'elevated' | 'read-only';
    cedarPolicies?: string[];          // custom Cedar policies
    circuitBreaker?: {
      maxCallsPerMinute?: number;      // default: 50
      maxCostUsd?: number;             // default: 10
      maxConsecutiveFailures?: number; // default: 5
    };
  };
  credentials?: {
    githubTokenSecretArn?: string;
  };
  networking?: {
    egressAllowlist?: string[];
  };
  pipeline?: {
    pollIntervalMs?: number;
    customSteps?: CustomStepConfig[];
    stepSequence?: StepRef[];
  };
}
```

At deploy time, the construct creates a CDK custom resource that writes the `RepoConfig` record:

- **Create** (the first deploy of the construct): `PutItem` writes the whole record with `status: 'active'` and every override the Blueprint declares. It replaces a record that already exists for the repo.
- **Update** (every later deploy): `UpdateItem` sets `status: 'active'`, `updated_at` and every override the Blueprint declares. It removes the registry asset lists (`mcp_servers`, `cedar_policy_modules`, `skills`) that the Blueprint does not declare, and leaves every other attribute as it is.
- **Delete** (the construct is removed from the stack): `UpdateItem` soft-deletes the record (`status: 'removed'`).

A redeploy therefore does not overwrite the record. An override that was deleted from the Blueprint keeps its last value. A deleted `agent.maxBudgetUsd` is still the repo's default budget, and a deleted `agent.modelId` still selects the old model. This rule holds for every override except the asset lists: `compute_type`, `runtime_arn`, `model_id`, `max_turns`, `max_budget_usd`, `memory_token_budget`, `system_prompt_overrides`, `github_token_secret_arn`, `poll_interval_ms`, `build_command`, `lint_command`, `egress_allowlist`, `cedar_policies` and `approval_gate_cap`. An empty string or an empty list does not clear one either.

The update is selective on purpose. `bgagent repo onboard` writes the same record ([ADR-017](/sample-autonomous-cloud-coding-agents/decisions/adr-017-operator-cli-repo-onboarding)), and the update runs on every deploy. If the update cleared what the Blueprint does not declare, an unrelated deploy would delete a value that an operator set with the CLI, such as a model pin. So a Blueprint owns the three asset lists and the attributes it declares, which every deploy writes again. Any other attribute stays as its last writer left it. To clear one, see [Removing a per-repo override](/sample-autonomous-cloud-coding-agents/customizing/per-repo-overrides#removing-a-per-repo-override).

### RepoConfig schema

The DynamoDB record that is read at runtime:

```typescript
interface RepoConfig {
  repo: string;                        // PK
  status: 'active' | 'removed';
  onboarded_at: string;                // ISO 8601
  updated_at: string;
  compute_type?: string;
  runtime_arn?: string;
  model_id?: string;
  max_turns?: number;
  max_budget_usd?: number;
  memory_token_budget?: number;
  system_prompt_overrides?: string;
  github_token_secret_arn?: string;
  egress_allowlist?: string[];
  poll_interval_ms?: number;
  custom_steps?: CustomStepConfig[];
  step_sequence?: StepRef[];
}
```

### Override precedence

From lowest to highest priority:

1. **Platform defaults** (CDK stack props)
2. **Per-repo config** (`RepoConfig` from Blueprint)
3. **Per-task overrides** (API request fields, for example `max_turns`)

### Platform defaults

| Field | Default | Source |
|---|---|---|
| `compute_type` | First deployed backend (`agentcore` with legacy context) | Ordered `DEPLOYED_COMPUTE_TYPE` list on the orchestrator. The `ComputeTypes`, `ComputeSubstrate` and `ComputeDeploymentMode` outputs are for CLI discovery |
| `runtime_arn` | Stack-level env var | CDK stack props |
| `model_id` | `global.anthropic.claude-opus-5-5` | Injected by the stack as `ANTHROPIC_MODEL` from `bedrockGeoRegion`. `agent/src/config.py` holds the fallback for when the variable is not set. See [Model configuration](/sample-autonomous-cloud-coding-agents/developer-guide/model-configuration) |
| `max_turns` | 100 | Platform constant |
| `max_budget_usd` | None (unlimited) | No platform default by design. A global ceiling would stop long tasks in the middle of a change. Set a per-repo default with Blueprint `agent.maxBudgetUsd` (`0.01` to `100`, validated at synth) or a per-task value with `--max-budget` or `max_budget_usd`. See [Per-repo overrides](/sample-autonomous-cloud-coding-agents/customizing/per-repo-overrides) for the complete list of places a budget can come from |
| `memory_token_budget` | 2000 | Platform constant (`DEFAULT_MEMORY_TOKEN_BUDGET` in `cdk/src/handlers/shared/memory.ts`). Set a per-repo value with Blueprint `agent.memoryTokenBudget` (a positive integer, validated at synth). There is no per-task override |
| `github_token_secret_arn` | Stack-level secret | CDK stack props |
| `poll_interval_ms` | 30000 | Orchestrator constant |

## Blueprint integration points

The orchestrator reads `RepoConfig` at task time. Each pipeline step consumes specific fields:

| Step | Fields consumed |
|---|---|
| `load-blueprint` | `compute_type`, `custom_steps`, `step_sequence` |
| `admission-control` | `status` (defense-in-depth) |
| `hydrate-context` | `github_token_secret_arn`, `system_prompt_overrides`, `memory_token_budget` |
| `pre-flight` | `github_token_secret_arn` |
| `start-session` | `compute_type`, `runtime_arn`, `model_id`, `max_turns`, `max_budget_usd` |
| `await-agent-completion` | `poll_interval_ms` |
| Custom steps | `custom_steps[].config` |

## Pipeline customization

Blueprints customize the orchestrator pipeline through three layers, each more powerful than the one before. See [ORCHESTRATOR.md](/sample-autonomous-cloud-coding-agents/architecture/orchestrator) for how the framework enforces invariants regardless of customization.

> **Implementation status.** Only Layer 1 is shipped today. The `pipeline` prop of the Blueprint construct currently exposes a single override, `pollIntervalMs` (`cdk/src/constructs/blueprint.ts`). The code has no `customSteps` or `stepSequence` support, no `CustomStepConfig` or `StepRef` wiring, and no `INVALID_STEP_SEQUENCE` validation. Layer 2 (Lambda-backed custom steps) and Layer 3 (custom step sequences) below describe a planned design, tracked as [GitHub issues](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues). The interfaces and validation rules in those subsections describe that plan, not current behavior.

### Layer 1: Parameterized strategies

Select and configure built-in step implementations without writing code. Set `compute.type`, `agent.modelId`, `agent.maxTurns`, and other Blueprint props. The only pipeline-stage override available today is `pipeline.pollIntervalMs`.

### Layer 2: Lambda-backed custom steps (planned)

Inject custom logic at the `pre-agent` or `post-agent` phase:

```typescript
interface CustomStepConfig {
  name: string;                        // unique step ID
  functionArn: string;                 // Lambda ARN
  phase: 'pre-agent' | 'post-agent';
  timeoutSeconds?: number;             // default: 120
  maxRetries?: number;                 // default: 2
  config?: Record<string, unknown>;
}
```

### Layer 3: Custom step sequences (planned)

Override the whole default step order:

```typescript
interface StepRef {
  type: 'builtin' | 'custom';
  name: string;
}
```

### Step sequence validation

When a Blueprint provides a `stepSequence`, the framework will validate it at CDK synth time and at runtime, and will raise `INVALID_STEP_SEQUENCE` on misconfiguration. This validation is planned and is not enforced in code today. See the status note above.

**Required steps:**

| Step | Why |
|---|---|
| `admission-control` | Concurrency slot management. Must be first. |
| `pre-flight` | Fail-closed readiness checks. Must precede `start-session`. |
| `start-session` | Starts compute. Must precede `await-agent-completion`. |
| `await-agent-completion` | Detects when the agent finishes. |
| `finalize` | Releases concurrency, emits events. Must be last. |

`hydrate-context` is not required, but a sequence that omits it emits a warning. You can insert custom steps between any adjacent built-in steps, but not before `admission-control` or after `finalize`.

### Step input/output contract

Every step receives a `StepInput` and returns a `StepOutput`:

```typescript
interface StepInput {
  taskId: string;
  repo: string;
  blueprintConfig: FilteredRepoConfig;     // filtered per step
  previousStepResults: Record<string, StepOutput>;  // last 5 steps
}

interface StepOutput {
  status: 'success' | 'failed' | 'skipped';
  metadata?: Record<string, unknown>;      // max 10KB
  error?: string;
}
```

**Config filtering.** Custom Lambda steps receive a sanitized config with the credential ARNs stripped. A step that needs secrets must declare them in `config`, and the operator must grant the IAM permissions.

**Retry policy.** Infrastructure failures (timeout, throttle, 5xx) are retried with exponential backoff. The default is 2 retries, with a base of 1s and a maximum of 10s. Explicit failures (`status: 'failed'`) are not retried.

**Checkpoint budget.** `metadata` is capped at 10KB per step. `previousStepResults` is pruned to the last 5 steps, to stay within the 256KB checkpoint limit of durable execution.

## Compute strategy interface

The compute strategy abstracts how sessions are started and monitored, so the orchestrator works with different backends without code changes:

```typescript
interface ComputeStrategy {
  readonly type: string;

  startSession(input: {
    taskId: string;
    sessionId: string;
    payload: HydratedPayload;
    config: Record<string, unknown>;
  }): Promise<SessionHandle>;

  pollSession(handle: SessionHandle): Promise<SessionStatus>;

  stopSession(handle: SessionHandle): Promise<void>;
}
```

The `agentcore` strategy implements `startSession` with `invoke_agent_runtime`, `pollSession` through re-invocation with sticky routing, and `stopSession` with `stop_runtime_session`. Alternative strategies, for example `ecs`, implement the same interface. The deployment selects one or more backends with `compute_types`. A Blueprint `compute_type` override must name one of them. Omit the override to inherit the first backend in the list. Legacy `compute_type` deployment contexts continue to include AgentCore as the default. Before you change an existing deployment, see [Compute](/sample-autonomous-cloud-coding-agents/architecture/compute#selecting-and-changing-the-backend).

## Re-onboarding

A configuration can become stale as its repo changes. The platform supports re-onboarding through multiple triggers:

| Trigger | Mechanism | When to use |
|---|---|---|
| Manual | Update Blueprint props and run `cdk deploy` | Known major changes (migration, restructure) |
| On major change | GitHub webhook detects significant changes in default branch | Automated, event-driven |
| Periodic | EventBridge scheduled re-analysis | Catches gradual drift |

**What gets re-onboarded:** the container image (rebuilt with updated dependencies), the system prompt and rules (discovered again from repo files), the tool profile, and the blueprint config (turn limits, model selection).

**What is preserved.** Long-term memory (repo knowledge, episodes, review rules) persists across re-onboarding. The memory consolidation strategy handles contradictions. Webhook integrations are preserved too.

## Customization artifacts

The onboarding pipeline can produce two kinds of customization artifacts that help the agent work with a specific repo:

**Static artifacts** are files that the team commits to the repo: `CLAUDE.md`, `.claude/rules/`, the README, and the CI config. The pipeline discovers and references them.

**Dynamic artifacts** are generated by the pipeline when repo hygiene is weak: codebase summaries, dependency graphs, and rules suggested from the repo layout. They compensate for missing documentation and are attached to the repo's agent configuration.

For prompt writing guidelines, see the [Prompt Guide](/sample-autonomous-cloud-coding-agents/customizing/prompt-engineering).
