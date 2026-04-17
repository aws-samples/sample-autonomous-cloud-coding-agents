# Repository onboarding

## Why onboarding?

The platform runs agent tasks against **specific repositories** (e.g. a GitHub org/repo). Before a user can submit a task for a repository, that repository must be **onboarded** to the system. If a user submits a task for a repository that is not onboarded, the input gateway returns an error and no task is created. Onboarding is the process of registering a repository with the platform and producing a **per-repository agent configuration** that the task pipeline uses when running tasks against that repo.

## The challenge: every repository is different

Repositories vary in ways that affect how the agent should work:

- **Requirements** — different tools, environment, and setup instructions (e.g. Node vs Python, different build commands).
- **Languages and stacks** — the agent needs to know what to run (linters, tests, package managers).
- **Hygiene** — some repos have a clear entry point, README, quality gates (CI/lint), and documentation; others are opaque or inconsistent. Good hygiene makes it easier for the agent to navigate and make correct decisions; poor hygiene increases the risk of wrong assumptions and wasted effort.

The **repository onboarding pipeline** addresses this by producing a **specific agent configuration for that repository**. That configuration is used whenever a task targets that repo. It typically includes:

- **Workload configuration** — runtime image (e.g. Dockerfile), system prompt or prompt template, and any workload-specific settings.
- **Security** — permissions and access control for that repository (who can submit tasks, what the agent is allowed to do).
- **Customization** — expertise artifacts that help the agent interact with the repo (rules, MCP servers, plugins, or other context).
- **Blueprint / task definition** — the *deterministic* steps of the task pipeline (see [Architecture](./ARCHITECTURE.md#blueprints-deterministic-orchestration-and-agent-workload)) may be customized per repo or per task type. Examples: which validation or lint steps run before or after the agent, which CI integration to use, timeouts, retry limits, or the order of steps. Not all repos need the same flow (e.g. one may require a SAST step before PR creation; another may use a different lint command). Onboarding can associate a repository with a **blueprint variant** or with parameters that the orchestrator uses when running the deterministic steps for that repo.

## Onboarding mechanism

Onboarding is **CDK-based**. The `Blueprint` CDK construct is the entry point for registering a repository with the platform. Each onboarded repo is an instance of `Blueprint` in the CDK stack. The construct provisions per-repo infrastructure and writes a `RepoConfig` record to the shared `RepoTable` in DynamoDB. **Deploying the stack = onboarding or updating repos.** There is no runtime API for repo CRUD.

This design treats **blueprints as infrastructure, not runtime config**. Each repo's blueprint defines the orchestrator pipeline, compute provider, model, system prompt, networking — things that require real AWS resources. CDK manages the lifecycle.

The **gate** (rejecting tasks for non-onboarded repos) reads DynamoDB at runtime, regardless of how the config was written. This keeps the runtime path simple and decoupled from the provisioning mechanism.

### Blueprint construct interface

```typescript
interface BlueprintProps {
  repo: string;                        // "owner/repo"
  repoTable: dynamodb.ITable;          // shared repo config table
  // Compute strategy
  compute?: {
    type?: 'agentcore' | 'ecs';        // compute strategy key (default: 'agentcore')
    runtimeArn?: string;               // override default runtime (agentcore strategy)
    config?: Record<string, unknown>;  // strategy-specific configuration
  };
  // Agent
  agent?: {
    modelId?: string;                  // foundation model override
    maxTurns?: number;                 // default turn limit for this repo
    maxBudgetUsd?: number;             // default cost budget for this repo ($0.01–$100)
    memoryTokenBudget?: number;        // memory context token budget override (default: 2000)
    systemPromptOverrides?: string;    // additional system prompt instructions
  };
  // Security (planned — Iteration 5)
  security?: {
    capabilityTier?: 'standard' | 'elevated' | 'read-only';  // tool access tier
    filePathDenyList?: string[];       // deny writes to these paths (e.g. '.github/workflows/')
    bashAllowlist?: string[];          // allowed bash commands (overrides default tier allowlist)
    circuitBreaker?: {                 // behavioral circuit breaker thresholds
      maxCallsPerMinute?: number;      // default: 50
      maxCostUsd?: number;             // default: 10
      maxConsecutiveFailures?: number; // default: 5
    };
  };
  // Credentials
  credentials?: {
    githubTokenSecretArn?: string;                    // per-repo GitHub token (PAT path)
    workloadIdentityName?: string;                    // AgentCore Token Vault identity (preferred)
    githubOAuth2CredentialProviderName?: string;      // Token Vault credential provider (required with workloadIdentityName)
  };
  // Networking
  networking?: {
    egressAllowlist?: string[];        // additional allowed domains
  };
  // Pipeline customization — 3-layer model
  pipeline?: {
    // Layer 1: Parameterized built-in strategies (select/configure built-in steps)
    pollIntervalMs?: number;           // override default 30s poll
    // Layer 2: Lambda-backed custom steps
    customSteps?: CustomStepConfig[];  // custom logic at specific pipeline phases
    // Layer 3: Custom step sequence (overrides default step order)
    stepSequence?: StepRef[];          // ordered list of steps to execute
  };
}

// Layer 2: Lambda-backed custom step definition
interface CustomStepConfig {
  name: string;                        // unique step identifier
  functionArn: string;                 // Lambda ARN to invoke
  phase: 'pre-agent' | 'post-agent';  // when the step runs
  timeoutSeconds?: number;             // step timeout (default: 120)
  maxRetries?: number;                 // retry count for infra failures (default: 2)
  config?: Record<string, unknown>;    // step-specific configuration
}

// Layer 3: Step reference in a custom sequence
interface StepRef {
  type: 'builtin' | 'custom';         // built-in step or custom Lambda step
  name: string;                        // step name (must match a built-in or CustomStepConfig.name)
}
```

### RepoConfig schema

The DynamoDB record written by the construct and read at runtime:

```typescript
interface RepoConfig {
  // Key
  repo: string;                        // PK — "owner/repo"
  status: 'active' | 'removed';
  // Metadata
  onboarded_at: string;                // ISO 8601
  updated_at: string;                  // ISO 8601
  // Compute
  compute_type?: string;               // compute strategy key (default: 'agentcore')
  runtime_arn?: string;
  // Agent
  model_id?: string;
  max_turns?: number;
  max_budget_usd?: number;
  memory_token_budget?: number;
  system_prompt_overrides?: string;
  // Credentials
  github_token_secret_arn?: string;
  workload_identity_name?: string;
  github_oauth2_provider_name?: string;
  // Networking
  egress_allowlist?: string[];
  // Pipeline
  poll_interval_ms?: number;
  custom_steps?: CustomStepConfig[];   // Lambda-backed custom step definitions
  step_sequence?: StepRef[];           // ordered step list (layer 3)
}

// Serialized form of CustomStepConfig (snake_case for DynamoDB)
interface CustomStepConfig {
  name: string;
  function_arn: string;
  phase: 'pre-agent' | 'post-agent';
  timeout_seconds?: number;
  max_retries?: number;
  config?: Record<string, unknown>;
}

// Serialized form of StepRef
interface StepRef {
  type: 'builtin' | 'custom';
  name: string;
}
```

### What the construct does at deploy time

The `Blueprint` construct creates a **CDK custom resource** (Lambda-backed) that manages the `RepoConfig` record in DynamoDB:

- **Create/Update:** The custom resource writes (PutItem) the `RepoConfig` record for this repo with `status: 'active'`. All fields from the construct props are mapped to the record. Timestamps (`onboarded_at`, `updated_at`) are set automatically.
- **Delete:** When the construct is removed from the stack, the custom resource marks the record as `status: 'removed'` (soft delete). This ensures the gate rejects tasks for removed repos without losing audit history. A TTL attribute can be set for eventual cleanup.

Redeploying the stack with updated props overwrites the record. The custom resource handles the full create/update/delete lifecycle.

### RepoTable DynamoDB schema

**Table:** Single table shared across all onboarded repos.

| Attribute | Type | Key | Description |
|---|---|---|---|
| `repo` | String | PK | `owner/repo` format |

No GSI is required for the current runtime path (no list-repos API).

**TTL:** `ttl` attribute for cleanup of removed records.

**Point-in-time recovery:** Enabled (consistent with other tables).

## Blueprint contract

This section defines how a `Blueprint` integrates with the rest of the system. Each integration point specifies what the blueprint provides and how the system consumes it.

### Integration points

| Integration point | What the blueprint provides | How the system consumes it |
|---|---|---|
| **Gate** (`createTaskCore`) | `repo` (PK) + `status` in RepoTable | `GetItem` by `repo`. If not found or `status !== 'active'`, return 422 `REPO_NOT_ONBOARDED`. |
| **Orchestrator: load config** | Full `RepoConfig` record | `GetItem` by `repo` after `load-task`. Merged with platform defaults. Stored as `blueprint_config` snapshot on the task record. |
| **Step execution** | `compute_type`, `custom_steps`, `step_sequence` | The orchestrator framework resolves each step in the blueprint: built-in steps use the strategy selected by `compute_type` and pipeline config; custom steps invoke the Lambda ARN from `custom_steps`; step order follows `step_sequence` if provided, otherwise the default sequence. Each step is wrapped with state transitions, event emission, and cancellation checks. |
| **Context hydration** | `github_token_secret_arn`, `workload_identity_name`, `github_oauth2_provider_name`, `system_prompt_overrides` | `resolveGitHubToken()` uses Token Vault (preferred) or per-repo Secrets Manager ARN instead of global. System prompt = platform default + `system_prompt_overrides` (appended). |
| **Session start** | `compute_type`, `runtime_arn`, `model_id`, `max_turns` | The compute strategy (resolved from `compute_type`) determines how the session is started. For `agentcore`: `InvokeAgentRuntimeCommand` uses per-repo runtime ARN. Model and turns passed in payload. |
| **Polling** | `poll_interval_ms` | `waitStrategy` uses per-repo interval (default: 30s). |
| **Credentials** | `github_token_secret_arn`, `workload_identity_name`, `github_oauth2_provider_name` | Token Vault (preferred) or Secrets Manager ARN for per-repo token. Orchestrator Lambda needs `bedrock-agentcore:GetWorkloadAccessToken` + `GetResourceOauth2Token` for Token Vault, or `secretsmanager:GetSecretValue` for PAT. |
| **Networking** | `egress_allowlist` | VPC security group / NAT rules configured at CDK time. |

### Platform defaults

Used when a `RepoConfig` field is absent:

| Field | Default | Source |
|---|---|---|
| `compute_type` | `agentcore` | Platform constant |
| `runtime_arn` | Stack-level `RUNTIME_ARN` env var | CDK stack props |
| `model_id` | Claude Sonnet 4 | CDK stack props |
| `max_turns` | 100 | Platform constant (`DEFAULT_MAX_TURNS`) |
| `max_budget_usd` | None (no budget limit) | — |
| `memory_token_budget` | 2000 | Platform constant |
| `github_token_secret_arn` | Stack-level `GITHUB_TOKEN_SECRET_ARN` | CDK stack props |
| `workload_identity_name` | Stack-level `WORKLOAD_IDENTITY_NAME` | CDK stack props (when Token Vault configured) |
| `github_oauth2_provider_name` | Stack-level `GITHUB_OAUTH2_PROVIDER_NAME` | CDK stack props (when Token Vault configured) |
| `poll_interval_ms` | 30000 | Orchestrator constant |
| `system_prompt_overrides` | None | — |
| `custom_steps` | None (no custom steps) | — |
| `step_sequence` | None (use default sequence) | — |

### Override precedence

From lowest to highest priority:

1. **Platform defaults** (CDK stack props)
2. **Per-repo config** (`RepoConfig` in DynamoDB, written by `Blueprint`)
3. **Per-task overrides** (API request fields, e.g. `max_turns` on `POST /v1/tasks`)

For example, if the platform default `max_turns` is 100, a repo's `RepoConfig` sets it to 50, and a task request specifies 25, the effective value is 25.

### Step-to-config field mapping

The orchestrator loads the `RepoConfig` in the first step (after `load-task`) and passes it to each subsequent step. Each step reads only the fields it needs:

| Orchestrator step | RepoConfig fields consumed |
|---|---|
| `load-blueprint` | `compute_type`, `custom_steps`, `step_sequence` (resolves the full step pipeline) |
| `admission-control` | `status` (defense-in-depth; already checked at API level) |
| `hydrate-context` | `github_token_secret_arn`, `workload_identity_name`, `github_oauth2_provider_name`, `system_prompt_overrides` |
| `pre-flight` | `github_token_secret_arn`, `workload_identity_name`, `github_oauth2_provider_name` (verifies GitHub API reachability and repo access) |
| `start-session` | `compute_type`, `runtime_arn`, `model_id`, `max_turns`, `max_budget_usd` |
| `await-agent-completion` | `poll_interval_ms` |
| `finalize` | (custom post-agent steps run before finalize if configured) |
| Custom steps (layer 2/3) | `custom_steps[].config` (step-specific configuration) |

## Blueprint execution framework

The orchestrator uses a **framework model**: a single orchestrator that enforces platform invariants and delegates variable work to customizable steps. This section defines the customization model, the step contracts, and the compute strategy interface.

### The 3-layer customization model

Blueprints customize the orchestrator pipeline through three progressively powerful layers:

**Layer 1: Parameterized built-in strategies.** Select and configure built-in step implementations without writing any code. The blueprint declares a strategy key (e.g. `compute.type: 'agentcore'`) and provides strategy-specific configuration. The orchestrator resolves the strategy, instantiates it, and delegates execution. This is the simplest and most common customization.

Example — select AgentCore compute with a custom runtime:
```typescript
new Blueprint(stack, 'MyRepo', {
  repo: 'org/my-repo',
  repoTable,
  compute: {
    type: 'agentcore',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/custom-runtime',
  },
});
```

**Layer 2: Lambda-backed custom steps.** Inject custom logic at specific pipeline phases by providing a Lambda ARN. Each custom step declares a `phase` (`pre-agent` or `post-agent`), a unique `name`, an optional `timeoutSeconds`, and optional `config`. The orchestrator invokes the Lambda with a `StepInput` payload and expects a `StepOutput` response.

Example — add a SAST scan after the agent finishes:
```typescript
new Blueprint(stack, 'SecureRepo', {
  repo: 'org/secure-repo',
  repoTable,
  pipeline: {
    customSteps: [
      {
        name: 'sast-scan',
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:sast-scanner',
        phase: 'post-agent',
        timeoutSeconds: 300,
        config: { scanProfile: 'strict' },
      },
    ],
  },
});
```

**Layer 3: Custom step sequences.** Override the default step order entirely. A `stepSequence` is an ordered list of step references, each pointing to a built-in step (by name) or a custom step (by `CustomStepConfig.name`). This enables inserting custom steps between built-in steps or reordering the pipeline.

Example — insert a custom preparation step between hydration and session start:
```typescript
new Blueprint(stack, 'CustomPipeline', {
  repo: 'org/custom-repo',
  repoTable,
  pipeline: {
    customSteps: [
      {
        name: 'prepare-environment',
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:env-prep',
        phase: 'pre-agent',
        timeoutSeconds: 60,
      },
    ],
    stepSequence: [
      { type: 'builtin', name: 'admission-control' },
      { type: 'builtin', name: 'hydrate-context' },
      { type: 'custom', name: 'prepare-environment' },
      { type: 'builtin', name: 'start-session' },
      { type: 'builtin', name: 'await-agent-completion' },
      { type: 'builtin', name: 'finalize' },
    ],
  },
});
```

### Step sequence validation

When a `stepSequence` is provided (Layer 3), the framework validates it at deploy time (CDK) and at runtime (orchestrator load-blueprint step). Invalid sequences are rejected before any task runs.

**Required steps.** The following built-in steps must always be present in any sequence:

| Step | Why it's required |
|---|---|
| `admission-control` | Enforces concurrency limits. Omitting it leaks concurrency slots. |
| `pre-flight` | Fail-closed readiness checks (GitHub API reachability, repo access). Omitting it allows doomed tasks to consume compute. |
| `start-session` | Starts the compute session. Without it, nothing runs. |
| `await-agent-completion` | Polls for session completion. Without it, the orchestrator cannot detect when the agent finishes. |
| `finalize` | Releases concurrency slots, emits terminal events, persists outcome. Omitting it leaks concurrency counters and leaves tasks in non-terminal states. |

`hydrate-context` is not strictly required (a blueprint could skip hydration and pass a minimal prompt), but omitting it emits a warning.

**Ordering constraints:**
- `admission-control` must be first.
- `pre-flight` must precede `start-session`.
- `start-session` must precede `await-agent-completion`.
- `finalize` must be last.
- Custom steps can be inserted between any adjacent pair of built-in steps, but cannot precede `admission-control` or follow `finalize`.

**Validation errors** are surfaced at CDK synth time (construct validation) and as a `FAILED` task with reason `INVALID_STEP_SEQUENCE` if the runtime check catches a configuration that slipped past CDK validation.

### Step input/output contract

Every step — built-in or custom Lambda — receives a `StepInput` and returns a `StepOutput`:

```typescript
interface StepInput {
  taskId: string;                          // current task ID
  repo: string;                            // "owner/repo"
  blueprintConfig: FilteredRepoConfig;     // merged blueprint config, filtered per step (see below)
  previousStepResults: Record<string, StepOutput>;  // results from earlier steps (pruned)
}

interface StepOutput {
  status: 'success' | 'failed' | 'skipped';
  metadata?: Record<string, unknown>;      // step-specific output data (max 10KB serialized)
  error?: string;                          // error message if status === 'failed'
}
```

**Config filtering (least-privilege).** The framework does not pass the full `RepoConfig` to every step. Built-in steps receive only the fields they consume (per the [step-to-config field mapping](#step-to-config-field-mapping)). Custom Lambda steps receive a **sanitized** config that strips credential ARNs (`github_token_secret_arn`) and networking configuration (`egress_allowlist`). If a custom step needs credentials, it must declare them explicitly in its `CustomStepConfig.config` and the platform operator must grant the Lambda's execution role the necessary permissions. This follows the principle of least privilege (SEC 3): each step receives the minimum information it needs.

**Checkpoint size budget.** `StepOutput.metadata` is limited to **10KB serialized** per step. The framework enforces this limit before storing the result. `previousStepResults` is pruned to include only the **last 5 steps** by default (configurable). This keeps the durable execution checkpoint well within the 256KB limit documented in the [orchestrator implementation options](./ORCHESTRATOR.md#option-a-lambda-durable-functions). Steps that need to pass large artifacts between each other should write to an external store (e.g. S3, DynamoDB) and pass a reference in `metadata`.

**Retry semantics for custom steps.** The framework retries failed custom Lambda steps with the following default policy:

| Parameter | Default | Configurable? |
|---|---|---|
| Max retries | 2 (3 total attempts) | Yes, via `CustomStepConfig.maxRetries` |
| Backoff | Exponential, base 1s, max 10s | No (fixed policy) |
| Retryable conditions | Lambda timeout, throttle (429), transient errors (5xx) | No |
| Non-retryable conditions | `StepOutput.status === 'failed'`, Lambda invocation error (4xx except 429) | No |

When a custom step returns `StepOutput.status === 'failed'`, the framework treats this as an **explicit failure** (the step ran and determined it cannot succeed) and does **not** retry. Retries apply only to infrastructure-level failures (timeouts, throttles, transient errors) where the step did not get a chance to run to completion. After all retries are exhausted, the task transitions to `FAILED`. This aligns with the idempotency requirement in the [step execution contract](./ORCHESTRATOR.md#step-execution-contract) — retried steps must produce the same result or detect they already ran.

For Lambda-backed custom steps, the orchestrator invokes the Lambda synchronously with the `StepInput` as the event payload and expects a `StepOutput` as the response.

### Compute strategy interface

The compute strategy abstracts how agent sessions are started and monitored. Each strategy implements:

```typescript
interface ComputeStrategy {
  readonly type: string;                   // strategy key (e.g. 'agentcore', 'ecs')

  startSession(input: {
    taskId: string;
    sessionId: string;
    payload: HydratedPayload;
    config: Record<string, unknown>;
  }): Promise<SessionHandle>;

  pollSession(handle: SessionHandle): Promise<SessionStatus>;

  stopSession(handle: SessionHandle): Promise<void>;
}

interface SessionHandle {
  sessionId: string;
  strategyType: string;
  metadata: Record<string, unknown>;       // strategy-specific handle data
}

type SessionStatus =
  | { status: 'running' }
  | { status: 'completed'; result: StepOutput }
  | { status: 'failed'; error: string };
```

The default `agentcore` strategy implements `startSession` via `invoke_agent_runtime`, `pollSession` via re-invocation on the same session (sticky routing), and `stopSession` via `stop_runtime_session`. Alternative strategies (e.g. `ecs`) can be added by implementing the same interface.

### What the framework enforces vs. what's customizable

| Aspect | Framework-enforced (not customizable) | Blueprint-customizable |
|---|---|---|
| **State machine** | Task states and valid transitions (SUBMITTED → HYDRATING → RUNNING → ...) | — |
| **Event emission** | Step start/end events emitted automatically for every step | Custom steps can add metadata to events |
| **Cancellation** | Checked between every step; aborts pipeline if pending | — |
| **Concurrency** | Slot acquisition at admission, release at finalization | — |
| **Timeouts** | Per-step timeout enforcement | Timeout values configurable per step |
| **Step sequence validation** | Required steps must be present and correctly ordered (see [validation rules](#step-sequence-validation)) | Custom steps can be inserted between built-in steps |
| **Config filtering** | Credential ARNs stripped from custom step inputs (least-privilege) | Custom steps declare needed config in `CustomStepConfig.config` |
| **Retry policy** | Infrastructure failures retried with exponential backoff (default: 2 retries) | `maxRetries` configurable per custom step |
| **Checkpoint budget** | `StepOutput.metadata` capped at 10KB; `previousStepResults` pruned to last 5 steps | — |
| **Compute provider** | — | `compute_type` selects the strategy |
| **Pipeline steps** | — | `custom_steps` adds steps; `step_sequence` reorders (within validation constraints) |
| **Step configuration** | — | `config` on each step and strategy |
| **Agent workload** | — | `model_id`, `max_turns`, `system_prompt_overrides` |

## Agent-friendly repos and the role of onboarding

An **agent-friendly** repository is one that is easy for an agent to work in: clear structure, good documentation (e.g. README, CONTRIBUTING), consistent conventions, and automated quality gates (lint, test, CI). Improving repo hygiene benefits both human developers and the agent. Onboarding does not replace that; it adds a **per-repo configuration layer** on top. For repos with good hygiene, onboarding may mainly capture workload and security settings. For repos with weaker hygiene, onboarding can generate or attach **dynamic artifacts** (see below) to compensate, for example: generated summaries, skills to use the repo, rule files, or indexed context so the agent can still operate effectively.

## Customization stack

AI agents can be customized in several different ways (for instance, see [this article](https://medium.com/@alain.krok/the-customization-stack-for-ai-coding-assistants-4013b501933c)). We want to expose the same kinds of customization for our background agents: some **statically defined** by developers (in the repo or in platform config), some **dynamically created** by the onboarding pipeline.

These artifacts are then used by all agent sessions running against a specific repository.

### Statically defined customizations

These are defined once and committed to the repository or stored in platform configuration. Examples: rule files (e.g. `.cursor/rules` or `CLAUDE.md`), documented conventions in the README, or repo-specific MCP servers/plugins that the team maintains. The onboarding pipeline can **discover and reference** these (e.g. "load rules from this path") rather than generating them. Scoped rules (by directory or file pattern) help avoid filling the agent's context with irrelevant instructions.

### Dynamically generated customizations

The agent does not necessarily know how to interact with an arbitrary codebase. If the repository's hygiene is weak (no clear docs, no rules, complex or inconsistent structure), the onboarding pipeline can **generate artifacts** that help the agent: for example, codebase summaries, dependency graphs, suggested rules derived from the repo layout, or indexed searchable context. These artifacts are produced by the pipeline (e.g. when the repo is first onboarded or when it is updated) and attached to the repo's agent configuration so that tasks run with that extra context.

## Prompt best practices and user guide

For prompt writing guidelines and best practices, see the dedicated [Prompt Guide](../guides/PROMPT_GUIDE.md).

## Re-onboarding

The onboarded configuration can become stale as repositories evolve (e.g. language migration, new build system, changed conventions). The platform supports re-onboarding to keep per-repo configuration current.

### CDK-based re-onboarding

Redeploying the stack with updated `Blueprint` props overwrites the `RepoConfig` record. The custom resource handles the create/update/delete lifecycle automatically. Manual re-onboarding = change CDK props + deploy.

### Automated re-onboarding triggers

| Trigger | Mechanism | When to use |
|---|---|---|
| **Manual** | Update `Blueprint` props in CDK + deploy | After known major changes (framework migration, monorepo restructure) |
| **On major change** | GitHub webhook detects significant changes in the default branch: new language detected, build system changed, or CI config restructured. Triggers a re-analysis pipeline. | Automated, event-driven — catches changes as they happen |
| **Periodic** | EventBridge scheduled rule triggers re-analysis for all onboarded repos. Lightweight: compare current repo state against stored config and only update if differences are detected. | Safety net for gradual drift |

### What gets re-onboarded

- **Container image**: Rebuilt with updated dependencies (already covered by snapshot-on-schedule in [COMPUTE.md](./COMPUTE.md)).
- **System prompt / rules**: Re-discovered from repo-intrinsic files (CLAUDE.md, README, CI config). If the repo has added or changed instruction files since onboarding, the per-repo prompt is updated.
- **Tool profile**: Re-evaluated if the repo's technology stack has changed (e.g. new MCP servers may be relevant, or previously needed tools may no longer apply).
- **Blueprint config**: Re-evaluated for validation steps, turn limits, and model selection if the repo's CI or test setup has changed.

### What is preserved

- **Memory**: Long-term memory (repo knowledge, task episodes, review feedback rules) is NOT cleared during re-onboarding. The memory represents accumulated learnings and should persist. If re-onboarding changes the repo's conventions significantly, the memory consolidation strategy (see [MEMORY.md](./MEMORY.md)) handles contradictions via recency and scope-aware resolution.
- **Webhook integrations**: Existing webhook secrets and integrations are preserved.

## Tools

The onboarding pipeline could also provide tools that help to containerize an existing GitHub repository (a.k.a creation of the image used by the compute environment).
