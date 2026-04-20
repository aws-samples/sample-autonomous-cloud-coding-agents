---
title: Repo onboarding
---

# Repository onboarding

Before users can submit tasks for a repository, that repository must be onboarded to the platform. Onboarding registers the repo and produces a per-repo configuration that the orchestrator uses at task time: compute strategy, model, credentials, networking, and pipeline customizations. If a user submits a task for a non-onboarded repo, the API returns `422 REPO_NOT_ONBOARDED`.

- **Use this doc for:** the Blueprint construct interface, RepoConfig schema, override precedence, compute strategy interface, and pipeline customization model.
- **For practical usage:** see [Quick Start](/getting-started/quick-start) for onboarding your first repo and [User Guide](/using/overview) for per-repo overrides.
- **Related docs:** [ORCHESTRATOR.md](/architecture/orchestrator) for how the orchestrator consumes blueprint config, [COMPUTE.md](/architecture/compute) for compute backends, [SECURITY.md](/architecture/security) for custom step trust boundaries.

## Why onboarding?

Repositories vary in ways that affect how the agent works: different languages, build systems, toolchains, conventions, and security requirements. A Node.js monorepo needs different tooling than a Python microservice. The onboarding pipeline addresses this by producing a specific configuration per repo, covering:

- **Compute** - Runtime image, compute backend, resource profile
- **Agent** - Model, turn limits, cost budget, system prompt overrides
- **Security** - Credentials, tool access tier, egress rules
- **Pipeline** - Custom steps, step ordering, poll interval

## Onboarding mechanism

Onboarding is **CDK-based**. Each repo is an instance of the `Blueprint` construct in the CDK stack. The construct writes a `RepoConfig` record to DynamoDB. Deploying the stack = onboarding or updating repos. There is no runtime API for repo CRUD.

This treats blueprints as infrastructure, not runtime config. Each repo's blueprint defines AWS resources (compute, networking, credentials). CDK manages the lifecycle. The gate (rejecting tasks for non-onboarded repos) reads DynamoDB at runtime, keeping the runtime path simple.

### Blueprint construct

```typescript
interface BlueprintProps {
  repo: string;                        // "owner/repo"
  repoTable: dynamodb.ITable;
  compute?: {
    type?: 'agentcore' | 'ecs';        // default: 'agentcore'
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

At deploy time, the construct creates a CDK custom resource that writes (PutItem) the `RepoConfig` record with `status: 'active'`. When removed from the stack, it soft-deletes (`status: 'removed'`). Redeploying with updated props overwrites the record.

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
  custom_steps?: CustomStepConfig[];
  step_sequence?: StepRef[];
}
```

### Override precedence

From lowest to highest priority:

1. **Platform defaults** (CDK stack props)
2. **Per-repo config** (`RepoConfig` from Blueprint)
3. **Per-task overrides** (API request fields, e.g. `max_turns`)

### Platform defaults

| Field | Default | Source |
|---|---|---|
| `compute_type` | `agentcore` | Platform constant |
| `runtime_arn` | Stack-level env var | CDK stack props |
| `model_id` | Claude Sonnet 4 | CDK stack props |
| `max_turns` | 100 | Platform constant |
| `max_budget_usd` | None (unlimited) | - |
| `memory_token_budget` | 2000 | Platform constant |
| `github_token_secret_arn` | Stack-level secret | CDK stack props |
| `poll_interval_ms` | 30000 | Orchestrator constant |

## Blueprint integration points

The orchestrator reads `RepoConfig` at task time. Each pipeline step consumes specific fields:

| Step | Fields consumed |
|---|---|
| `load-blueprint` | `compute_type`, `custom_steps`, `step_sequence` |
| `admission-control` | `status` (defense-in-depth) |
| `hydrate-context` | `github_token_secret_arn`, `system_prompt_overrides` |
| `pre-flight` | `github_token_secret_arn` |
| `start-session` | `compute_type`, `runtime_arn`, `model_id`, `max_turns`, `max_budget_usd` |
| `await-agent-completion` | `poll_interval_ms` |
| Custom steps | `custom_steps[].config` |

## Pipeline customization

Blueprints customize the orchestrator pipeline through three progressively powerful layers. See [ORCHESTRATOR.md](/architecture/orchestrator) for how the framework enforces invariants regardless of customization.

### Layer 1: Parameterized strategies

Select and configure built-in step implementations without writing code. Set `compute.type`, `agent.modelId`, `agent.maxTurns`, and other Blueprint props.

### Layer 2: Lambda-backed custom steps

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

### Layer 3: Custom step sequences

Override the default step order entirely:

```typescript
interface StepRef {
  type: 'builtin' | 'custom';
  name: string;
}
```

### Step sequence validation

When a `stepSequence` is provided, the framework validates it at CDK synth time and at runtime. Invalid sequences cause `INVALID_STEP_SEQUENCE`.

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

The `agentcore` strategy implements `startSession` via `invoke_agent_runtime`, `pollSession` via re-invocation with sticky routing, and `stopSession` via `stop_runtime_session`. Alternative strategies (e.g. `ecs`) implement the same interface. The backend is selected per repo via `compute_type` in the Blueprint.

## Re-onboarding

Configurations can become stale as repos evolve. The platform supports re-onboarding through multiple triggers:

| Trigger | Mechanism | When to use |
|---|---|---|
| Manual | Update Blueprint props + `cdk deploy` | Known major changes (migration, restructure) |
| On major change | GitHub webhook detects significant changes in default branch | Automated, event-driven |
| Periodic | EventBridge scheduled re-analysis | Safety net for gradual drift |

**What gets re-onboarded:** Container image (rebuilt with updated deps), system prompt and rules (re-discovered from repo files), tool profile, and blueprint config (turn limits, model selection).

**What is preserved:** Long-term memory (repo knowledge, episodes, review rules) persists across re-onboarding. The memory consolidation strategy handles contradictions. Webhook integrations are also preserved.

## Customization artifacts

The onboarding pipeline can produce two kinds of customization artifacts that help the agent work with a specific repo:

**Static artifacts** are committed to the repo by the team: `CLAUDE.md`, `.claude/rules/`, README, CI config. The pipeline discovers and references these.

**Dynamic artifacts** are generated by the pipeline when repo hygiene is weak: codebase summaries, dependency graphs, suggested rules from the repo layout. These compensate for missing documentation and are attached to the repo's agent configuration.

For prompt writing guidelines, see the [Prompt Guide](/customizing/prompt-engineering).
