# Repository onboarding

Before users can submit tasks for a repository, that repository must be onboarded to the platform. Onboarding registers the repo and produces a per-repo configuration that the orchestrator uses at task time: compute strategy, model, credentials, networking, and pipeline customizations. If a user submits a task for a non-onboarded repo, the API returns `422 REPO_NOT_ONBOARDED`.

- **Use this doc for:** the Blueprint construct interface, RepoConfig schema, override precedence, compute strategy interface, and pipeline customization model.
- **For practical usage:** see [Quick Start](../guides/QUICK_START.mdx) for onboarding your first repo and [User Guide](../guides/USER_GUIDE.md) for per-repo overrides.
- **Related docs:** [ORCHESTRATOR.md](./ORCHESTRATOR.md) for how the orchestrator consumes blueprint config, [COMPUTE.md](./COMPUTE.md) for compute backends, [SECURITY.md](./SECURITY.md) for custom step trust boundaries.

## Why onboarding?

Repositories vary in ways that affect how the agent works: different languages, build systems, toolchains, conventions, and security requirements. A Node.js monorepo needs different tooling than a Python microservice. The onboarding pipeline addresses this by producing a specific configuration per repo, covering:

- **Compute** - Runtime image, compute backend, resource profile
- **Agent** - Model, turn limits, cost budget, system prompt overrides
- **Security** - Credentials, tool access tier, egress rules
- **Pipeline** - Custom steps, step ordering, poll interval

## Onboarding mechanism

A repository is onboarded when `RepoTable` holds a `RepoConfig` record for it with `status: 'active'`. Two writers share that record, and each changes only the attributes it names:

- **`bgagent repo onboard`** is the default way to register a repository and to change or remove one of its settings. It writes the record with operator AWS credentials: no Cognito login, no CDK redeploy.
- **A `Blueprint`** is the checked-in declaration of a repository's settings. The stack creates one `Blueprint` construct per definition in `cdk/src/blueprints/definitions.ts`, and every deploy writes what the definition declares.

There is no REST API for repo CRUD: the platform's own handlers only read `RepoTable`. The task API reads the record when a task is submitted (the gate that rejects non-onboarded repos) and the orchestrator reads it again when the task starts. A task that is already running keeps the values it started with.

| Aspect | CDK `Blueprint` | `bgagent repo onboard` / `offboard` |
|--------|-----------------|-------------------------------------|
| **Who** | Deploy role at `mise //cdk:deploy` | Operator AWS credentials (`operator-context`) |
| **What it writes** | The settings its definition declares, on every deploy | The settings its flags name |
| **Removing a setting** | Only a registry asset list, by declaring it as `[]` | `--unset <column>` |
| **Cedar policies, registry pins, prompt, budget, build and lint commands** | Supported via construct props | Supported via flags (`bgagent repo onboard --help` lists them) |
| **Egress domains** | `networking.egressAllowlist` | Not exposed — use CDK |
| **Custom runtime / token IAM** | `additionalRuntimeArns` / `additionalSecretArns` in CDK | Stored in the row, but orchestrator IAM still requires a CDK deploy |
| **Soft-delete** | `status=removed` and a `ttl` when the construct is removed from the stack | `status=removed` and a `ttl` 30 days ahead on `offboard` |
| **Template resources** | Two per `Blueprint`, counted against the application stack's [490-resource ceiling](../guides/DEPLOYMENT_GUIDE.md#network-stack-topology) | None |
| **Audit trail** | CloudFormation change set + deploy logs | CLI stdout only today (see [ADR-017](../decisions/ADR-017-operator-cli-repo-onboarding.md)) |

Use the CLI to register a repository and for every setting that is plain data. Use a Blueprint to keep a repository's settings in the checked-in CDK app, and for egress domains, which only a Blueprint can add. IAM for a custom runtime or token secret needs a CDK deploy with either writer. The onboard command prints notes explaining which platform defaults apply and when a redeploy is still required.

See also: [Using the CLI — operator commands](../guides/USER_GUIDE.md#operator-commands-stack-admin) and [ADR-017](../decisions/ADR-017-operator-cli-repo-onboarding.md).

### Blueprint construct

```typescript
interface BlueprintProps {
  repo: string;                        // "owner/repo"
  repoTable: dynamodb.ITable;
  compute?: {
    type?: 'agentcore' | 'ecs';        // inherits first deployed backend; lambda-microvm: CLI only
    runtimeArn?: string;
  };
  agent?: {
    modelId?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;             // $0.01-$100
    memoryTokenBudget?: number;        // default: 2000
    systemPromptOverrides?: string;
  };
  security?: {
    cedarPolicies?: string[];          // custom Cedar policies
    approvalGateCap?: number;          // 1-500, default: 50
  };
  credentials?: {
    githubTokenSecretArn?: string;
  };
  networking?: {
    egressAllowlist?: string[];
  };
  pipeline?: {
    pollIntervalMs?: number;
    buildCommand?: string;             // default: mise run build
    lintCommand?: string;              // default: mise run lint
  };
  assets?: {                           // registry:// refs
    mcpServers?: string[];
    cedarPolicyModules?: string[];
    skills?: string[];
  };
}
```

At deploy time, the construct creates a CDK custom resource that writes the `RepoConfig` record:

- **Create and update** (every deploy of the construct): one `UpdateItem` sets `status: 'active'`, `updated_at`, `onboarded_at` (only if the record has none) and every override the Blueprint declares. It removes `ttl`, so that a record that was soft-deleted earlier does not expire once it is active again, and each registry asset list (`mcp_servers`, `cedar_policy_modules`, `skills`) that the Blueprint declares as `[]`. It leaves every other attribute as it is. A Blueprint created for a repository whose record still exists (also a removed one that has not expired) therefore merges into that record and keeps the attributes it does not declare.
- **Delete** (the construct is removed from the stack): `UpdateItem` soft-deletes the record (`status: 'removed'`) and sets a `ttl`, after which DynamoDB deletes it. The `ttl` is 30 days after the synthesis of the last deploy that still contained the construct, because the value is a literal in that deploy's template. It does not count from the removal: the record expires less than 30 days after the removal, and at once if that deploy is more than 30 days old.

A redeploy therefore does not overwrite the record. An override that was deleted from the Blueprint keeps its last value: a deleted `agent.maxBudgetUsd` is still the repo's default budget, a deleted `agent.modelId` still selects the old model, and a deleted asset list keeps its pins. An empty string or an empty list does not clear an override either. The one exception is an asset list declared as `[]` (`assets: { mcpServers: [] }`), which is removed from the record.

The write is selective on purpose. `bgagent repo onboard` writes the same record with the same kind of `UpdateItem` ([ADR-017](../decisions/ADR-017-operator-cli-repo-onboarding.md)), and the Blueprint's write runs on every deploy: if it cleared what the Blueprint does not declare, an unrelated deploy would delete a value an operator set with the CLI, such as a model pin. So a Blueprint owns the attributes it declares, which every deploy writes again. Any other attribute stays as its last writer left it. To remove a setting, run `bgagent repo onboard <owner/repo> --unset <column>` and, if the Blueprint declares it, delete it there too: see [Removing a per-repo override](../guides/USER_GUIDE.md#removing-a-per-repo-override).

### RepoConfig schema

The DynamoDB record read at runtime:

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
  build_command?: string;
  lint_command?: string;
  cedar_policies?: string[];
  approval_gate_cap?: number;
  mcp_servers?: string[];              // registry:// refs
  cedar_policy_modules?: string[];     // registry:// refs
  skills?: string[];                   // registry:// refs
}
```

The first four attributes identify the record and its state; the 17 below them are the per-repo settings, absent when not set. `bgagent repo onboard` sets and removes 16 of them; the [user guide](../guides/USER_GUIDE.md#per-repo-overrides) lists each with its flag, its Blueprint property and its default. The exception is `egress_allowlist`, which only a Blueprint writes: no runtime reader uses it, because the domains take effect through the deploy. A soft-deleted record also carries `ttl`. `bgagent repo show <owner/repo>` prints the settings a record holds.

### Override precedence

From lowest to highest priority:

1. **Platform defaults** (CDK stack props)
2. **Per-repo config** (the repository's `RepoConfig` record)
3. **Per-task overrides** (API request fields, e.g. `max_turns`)

### Platform defaults

| Field | Default | Source |
|---|---|---|
| `compute_type` | First deployed backend (`agentcore` with legacy context) | Ordered `DEPLOYED_COMPUTE_TYPE` list on the orchestrator; `ComputeTypes`, `ComputeSubstrate` and `ComputeDeploymentMode` outputs for CLI discovery |
| `runtime_arn` | Stack-level env var | CDK stack props |
| `model_id` | `global.anthropic.claude-opus-5-5` | injected by the stack as `ANTHROPIC_MODEL` from `bedrockGeoRegion`; `agent/src/config.py` holds the no-env fallback — see [Model configuration](../guides/DEVELOPER_GUIDE.md#model-configuration) |
| `max_turns` | 100 | Platform constant |
| `max_budget_usd` | None (unlimited) | No platform default by design — a global ceiling would kill long tasks mid-change. Set a per-repo default with `bgagent repo onboard --max-budget` or Blueprint `agent.maxBudgetUsd` (`0.01`–`100`, checked by the CLI and at synth) or per task with `bgagent submit --max-budget` / `max_budget_usd`. See [Per-repo overrides](../guides/USER_GUIDE.md#per-repo-overrides) for the complete list of surfaces a budget can come from |
| `memory_token_budget` | 2000 | Platform constant (`DEFAULT_MEMORY_TOKEN_BUDGET` in `cdk/src/handlers/shared/memory.ts`). Set a per-repo value with `bgagent repo onboard --memory-token-budget` or Blueprint `agent.memoryTokenBudget` (a positive integer, checked by the CLI and at synth); there is no per-task override |
| `github_token_secret_arn` | Stack-level secret | CDK stack props |
| `poll_interval_ms` | 30000 | Orchestrator constant |

## Blueprint integration points

The orchestrator reads `RepoConfig` at task time. Each pipeline step consumes specific fields:

| Step | Fields consumed |
|---|---|
| `load-blueprint` | `compute_type` |
| `admission-control` | `status` (defense-in-depth) |
| `hydrate-context` | `github_token_secret_arn`, `system_prompt_overrides`, `memory_token_budget` |
| `pre-flight` | `github_token_secret_arn` |
| `start-session` | `compute_type`, `runtime_arn`, `model_id`, `max_turns`, `max_budget_usd` |
| `await-agent-completion` | `poll_interval_ms` |

## Pipeline customization

Blueprints customize the orchestrator pipeline through three progressively powerful layers. See [ORCHESTRATOR.md](./ORCHESTRATOR.md) for how the framework enforces invariants regardless of customization.

> **Implementation status:** Only **Layer 1** is shipped today. The Blueprint construct's `pipeline` prop currently exposes `pollIntervalMs`, `buildCommand` and `lintCommand` (`cdk/src/constructs/blueprint.ts`); there is no `customSteps`/`stepSequence` support, no `CustomStepConfig`/`StepRef` wiring, and no `INVALID_STEP_SEQUENCE` validation in code. **Layer 2 (Lambda-backed custom steps)** and **Layer 3 (custom step sequences)** below describe a planned design — tracked as [GitHub issues](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues). The interfaces and validation rules in those subsections are forward-looking, not current behavior.

### Layer 1: Parameterized strategies

Select and configure built-in step implementations without writing code. Set `compute.type`, `agent.modelId`, `agent.maxTurns`, and other Blueprint props. (Under `pipeline`, the overrides available today are `pollIntervalMs`, `buildCommand` and `lintCommand`.)

### Layer 2: Lambda-backed custom steps (planned)

Inject custom logic at `pre-agent` or `post-agent` phases:

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

Override the default step order entirely:

```typescript
interface StepRef {
  type: 'builtin' | 'custom';
  name: string;
}
```

### Step sequence validation

When a `stepSequence` is provided, the framework will validate it at CDK synth time and at runtime, raising `INVALID_STEP_SEQUENCE` on misconfiguration. (Planned — see the status note above; not enforced in code today.)

**Required steps:**

| Step | Why |
|---|---|
| `admission-control` | Concurrency slot management. Must be first. |
| `pre-flight` | Fail-closed readiness checks. Must precede `start-session`. |
| `start-session` | Starts compute. Must precede `await-agent-completion`. |
| `await-agent-completion` | Detects when agent finishes. |
| `finalize` | Releases concurrency, emits events. Must be last. |

`hydrate-context` is not strictly required but omitting it emits a warning. Custom steps can be inserted between any adjacent built-in steps, but not before `admission-control` or after `finalize`.

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

**Config filtering:** Custom Lambda steps receive a sanitized config with credential ARNs stripped. Steps that need secrets must declare them in `config` and the operator must grant IAM permissions.

**Retry policy:** Infrastructure failures (timeout, throttle, 5xx) retry with exponential backoff (default: 2 retries, base 1s, max 10s). Explicit failures (`status: 'failed'`) do not retry.

**Checkpoint budget:** `metadata` capped at 10KB per step. `previousStepResults` pruned to last 5 steps to stay within the 256KB durable execution checkpoint limit.

## Compute strategy interface

The compute strategy abstracts how sessions are started and monitored, allowing the orchestrator to work with different backends without code changes:

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

The `agentcore` strategy implements `startSession` via `invoke_agent_runtime`, `pollSession` via re-invocation with sticky routing, and `stopSession` via `stop_runtime_session`. Alternative strategies (e.g. `ecs`) implement the same interface. The deployment selects one or more backends with `compute_types`. A Blueprint `compute_type` override must name one of them; omit the override to inherit the first backend in the list. Legacy `compute_type` deployment contexts continue to include AgentCore as the default. See [Compute](./COMPUTE.md#selecting-and-changing-the-backend) before changing an existing deployment.

## Re-onboarding

Configurations can become stale as repos evolve. The platform supports re-onboarding through multiple triggers:

| Trigger | Mechanism | When to use |
|---|---|---|
| Manual | `bgagent repo onboard` with the changed settings, or updated Blueprint props + `cdk deploy` | Known major changes (migration, restructure) |
| On major change | GitHub webhook detects significant changes in default branch | Automated, event-driven |
| Periodic | EventBridge scheduled re-analysis | Safety net for gradual drift |

**What gets re-onboarded:** Container image (rebuilt with updated deps), system prompt and rules (re-discovered from repo files), tool profile, and blueprint config (turn limits, model selection).

**What is preserved:** Long-term memory (repo knowledge, episodes, review rules) persists across re-onboarding. The memory consolidation strategy handles contradictions. Webhook integrations are also preserved.

## Customization artifacts

The onboarding pipeline can produce two kinds of customization artifacts that help the agent work with a specific repo:

**Static artifacts** are committed to the repo by the team: `CLAUDE.md`, `.claude/rules/`, README, CI config. The pipeline discovers and references these.

**Dynamic artifacts** are generated by the pipeline when repo hygiene is weak: codebase summaries, dependency graphs, suggested rules from the repo layout. These compensate for missing documentation and are attached to the repo's agent configuration.

For prompt writing guidelines, see the [Prompt Guide](../guides/PROMPT_GUIDE.md).
