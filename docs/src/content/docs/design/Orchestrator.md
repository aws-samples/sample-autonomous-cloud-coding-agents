---
title: Orchestrator
---

# Orchestrator

## Overview

The **orchestrator** is the component that executes the task lifecycle from submission to completion. It is the runtime engine for **blueprints**: it takes a task definition (the blueprint), runs each step in sequence, manages state transitions, handles failures and timeouts, and ensures that every task reaches a terminal state with proper cleanup.

The orchestrator does **not** run the agent. The agent runs inside an isolated compute session (see [COMPUTE.md](/design/compute)); the orchestrator starts that session, monitors it, and acts on its outcome. The orchestrator runs the **deterministic** parts of the pipeline (admission control, context hydration, session start, result inference, cleanup) and delegates the **non-deterministic** part (the agent workload) to the compute environment. This separation is deliberate: deterministic steps are cheap, predictable, and testable; the agent step is expensive, long-running, and unpredictable. The orchestrator wraps the unpredictable part with predictable bookkeeping.

**Why a separate design document?** The architecture document (see [ARCHITECTURE.md](/design/architecture)) defines the blueprint model and the high-level step sequence (deterministic–agentic–deterministic sandwich). Other documents define individual components: [INPUT_GATEWAY.md](/design/input-gateway) covers how tasks enter the system, [COMPUTE.md](/design/compute) covers the session runtime, [MEMORY.md](/design/memory) covers context sources. No existing document defines: the task state machine with formal states and transitions, the execution model for each blueprint step in detail, failure modes and recovery, concurrency management, or the implementation strategy for the orchestrator itself. This document fills that gap.

## At a glance

- **Use this doc for:** task state machine, admission/finalization flow, cancellation behavior, and failure recovery.
- **Most important sections for readers:** Responsibilities, State machine, Admission control, and Cancellation.
- **Scope:** orchestrator behavior only; API surface and security policy are defined in their dedicated docs.

**Relationship to blueprints.** The orchestrator is a **framework** that enforces platform invariants — the task state machine, event emission, concurrency management, and cancellation handling — and delegates variable work to **blueprint-defined step implementations**. A blueprint defines which steps run, in what order, and how each step is implemented (built-in strategy, Lambda-backed custom step, or custom sequence). The default blueprint is defined in this document (Section 4). Per-repo customization (see [REPO_ONBOARDING.md](/design/repo-onboarding)) changes the steps the orchestrator executes, not the framework guarantees it enforces. The orchestrator wraps every step with state transitions, event emission, and cancellation checks — regardless of whether the step is a built-in or a custom Lambda.

### Iteration 1 vs. target state

In **Iteration 1** (current), the orchestrator does not exist as a distinct component. The client calls `invoke_agent_runtime` synchronously, the agent runs to completion inside the AgentCore Runtime MicroVM, and the caller infers the result from the response. There is no durable state, no task management, no concurrency control, and no recovery. If the caller disconnects, the session is orphaned.

The **target state** (Iteration 2 and beyond) introduces a durable orchestrator that manages the full task lifecycle. This document designs for the target state; where Iteration 1 constraints apply, they are called out explicitly.

---

## Responsibilities

### What the orchestrator owns

| Responsibility | Description |
|---|---|
| **Task lifecycle** | Accept tasks from the input gateway, drive them through the state machine to a terminal state, persist state at each transition. |
| **Admission control** | Validate that a task can be accepted: repo onboarded, user within concurrency limits, rate limits, idempotency. |
| **Context hydration** | Assemble the agent prompt from multiple sources (user message, GitHub issue, memory, repo config, system prompt template). |
| **Session start** | Invoke the compute runtime (AgentCore `invoke_agent_runtime`) with the hydrated payload. Map the task ID to the runtime session ID. |
| **Session monitoring** | Track whether the session is still running, detect completion, enforce timeouts (idle and absolute). |
| **Result inference** | After the session ends, determine success or failure by inspecting GitHub state (branch, PR, commits) and/or the session response. |
| **Finalization and cleanup** | Update task status, emit events, release concurrency counters, persist audit records, emit notifications. |
| **Cancellation** | Accept cancel requests at any point in the lifecycle and drive the task to CANCELLED, including stopping the runtime session if running. |
| **Concurrency management** | Track how many tasks are running per user and system-wide; enforce limits at admission and release counters at finalization. |

### What the orchestrator does NOT own

| Component | Owner | Reference |
|---|---|---|
| Request authentication and normalization | Input gateway | [INPUT_GATEWAY.md](/design/input-gateway) |
| Agent logic (clone, code, test, PR) | Agent harness inside compute | [AGENT_HARNESS.md](/design/agent-harness) |
| Compute session lifecycle (VM creation, /ping, image pull) | AgentCore Runtime | [COMPUTE.md](/design/compute) |
| Memory storage and retrieval APIs | AgentCore Memory / MemoryStore | [MEMORY.md](/design/memory) |
| Repository onboarding and per-repo configuration | Onboarding pipeline | [REPO_ONBOARDING.md](/design/repo-onboarding) |
| Outbound notification rendering and delivery | Notification adapters (input gateway outbound) | [INPUT_GATEWAY.md](/design/input-gateway) |
| Evaluation and feedback | Evaluation pipeline | [EVALUATION.md](/design/evaluation) |

---

## Task state machine

### States

| State | Description | Typical duration |
|---|---|---|
| `SUBMITTED` | Task accepted by the input gateway, persisted, awaiting orchestration. | Milliseconds |
| `HYDRATING` | Context hydration in progress (fetching GitHub issue, querying memory, assembling prompt). | Seconds |
| `RUNNING` | Agent session is active inside the compute environment. | Minutes to hours (up to 8h) |
| `FINALIZING` | Session ended; orchestrator is performing result inference, build verification, PR check, cleanup. | Seconds |
| `COMPLETED` | Terminal. Task finished successfully (PR created, or work committed). | — |
| `FAILED` | Terminal. Task could not be completed (agent error, session crash, hydration failure, etc.). | — |
| `CANCELLED` | Terminal. Task was cancelled by the user or system. | — |
| `TIMED_OUT` | Terminal. Task exceeded the maximum allowed duration or was killed by an idle timeout without recovery. | — |

### State transition diagram

```
                          +-----------+
                          | SUBMITTED |
                          +-----+-----+
                                |
                    admission control passes
                                |
                         +------+------+
                         |  HYDRATING  |
                         +------+------+
                  |                           |
         hydration complete            slot becomes available
                  |                           |
                  |                    +------+------+
                  |                    |  HYDRATING  |
                  |                    +------+------+
                  |                           |
                  +-------------+-------------+
                                |
                     session started (invoke_agent_runtime)
                                |
                         +------+------+
                         |   RUNNING   |
                         +------+------+
                                |
              +---------+-------+-------+---------+
              |         |               |         |
         session end  timeout      cancel req   crash
              |         |               |         |
       +------+------+  |        +------+------+  |
       | FINALIZING  |  |        |  CANCELLED  |  |
       +------+------+  |        +-------------+  |
              |         |                          |
     +--------+--------+|                          |
     |        |         |                          |
  success   failure  timed_out                  failure
     |        |         |                          |
+---------+ +------+ +--------+              +------+
|COMPLETED| |FAILED| |TIMED_OUT|             |FAILED|
+---------+ +------+ +--------+              +------+
```

### Transition table

| From | To | Trigger | Guard / condition |
|---|---|---|---|
| `SUBMITTED` | `HYDRATING` | Admission passes, slot available | Concurrency counter incremented |
| `SUBMITTED` | `FAILED` | Admission rejected | Repo not onboarded, rate limit, validation failure |
| `SUBMITTED` | `CANCELLED` | User cancels | Cancel request received |
| `HYDRATING` | `RUNNING` | Hydration complete, session invoked | `invoke_agent_runtime` returns session ID |
| `HYDRATING` | `FAILED` | Hydration error | GitHub API failure, memory failure, prompt assembly error |
| `HYDRATING` | `CANCELLED` | User cancels during hydration | Cancel request received |
| `RUNNING` | `FINALIZING` | Session ends (response received or session status = terminated) | — |
| `RUNNING` | `CANCELLED` | User cancels | `stop_runtime_session` called, then transition |
| `RUNNING` | `TIMED_OUT` | Max duration exceeded | Wall-clock timer fires (configurable, default 8h matching AgentCore max) |
| `RUNNING` | `FAILED` | Session crash detected (runtime error, unrecoverable) | Session status indicates failure |
| `FINALIZING` | `COMPLETED` | Result inference determines success | PR exists or commits on branch |
| `FINALIZING` | `FAILED` | Result inference determines failure | No commits, no PR, or agent reported error |
| `FINALIZING` | `TIMED_OUT` | Finalization discovers the session ended due to idle timeout | Session metadata indicates idle timeout termination |

### Cancellation behavior by state

| State when cancel arrives | Action |
|---|---|
| `SUBMITTED` | Transition directly to `CANCELLED`. No resources to clean up. |
| `HYDRATING` | Abort hydration (best-effort), transition to `CANCELLED`. Release concurrency counter. |
| `RUNNING` | Call `stop_runtime_session` to terminate the agent session. Wait for confirmation. Transition to `CANCELLED`. Release concurrency counter. Partial work (branch, commits) remains on GitHub for the user to inspect or delete. |
| `FINALIZING` | Let finalization complete (it is fast). Mark as `CANCELLED` only if the cancel was received before the terminal state was written. |
| Terminal states | Reject cancel request (task already done). |

### Timeout behavior

| Timeout type | Value | Source | Effect |
|---|---|---|---|
| **Max session duration** | 8 hours | AgentCore Runtime hard limit | AgentCore terminates the session. Orchestrator detects session end, transitions to `TIMED_OUT`. |
| **Idle timeout** | 15 minutes | AgentCore Runtime inactivity threshold | If the agent is idle for 15 min, AgentCore terminates the session. See Session management section for mitigation. |
| **Orchestrator max duration** | Configurable (default: 8h) | Orchestrator timer | Orchestrator calls `stop_runtime_session` if its own timer fires. Safety net if AgentCore's timeout fails or if the orchestrator wants a shorter limit. |
| **Max turns / iterations** | Configurable per task (default: 100, range 1–500) | API `max_turns` field / agent harness | Limits the number of agent loop iterations (tool calls or reasoning turns) per session. Complements time-based limits with a cost-oriented bound. Capping turns prevents runaway sessions that burn tokens without progress. The platform default (100) is applied when no per-task value is specified. Users can override via the API (`max_turns` field on `POST /v1/tasks`) or CLI (`--max-turns`). The value is persisted in the task record, included in the orchestrator payload, and consumed by the agent's `server.py` -> `ClaudeAgentOptions(max_turns=...)`. The `MAX_TURNS` env var on the AgentCore Runtime provides a defense-in-depth fallback. Per-repo overrides via `blueprint_config` are supported. |
| **Max cost budget** | Configurable per task ($0.01–$100) | API `max_budget_usd` field / agent harness | Limits the total cost in USD for a single agent session. When the budget is reached, the agent stops regardless of remaining turns. Users can set via the API (`max_budget_usd` field on `POST /v1/tasks`) or CLI (`--max-budget`). Per-repo defaults can be configured via `blueprint_config.max_budget_usd`. If neither the task nor the Blueprint specifies a value, no budget limit is applied (turn limit and session timeout still apply). The value is persisted in the task record, resolved via a 2-tier override (task → Blueprint, absent = unlimited), and consumed by the agent's `server.py` → `ClaudeAgentOptions(max_budget_usd=...)`. |
| **Hydration timeout** | Configurable (default: 2 min) | Orchestrator timer | If context hydration takes too long (e.g. GitHub API slow), fail the task. |

---

## Blueprint execution model

### The default blueprint

The default blueprint is the "deterministic–agentic–deterministic sandwich" described in [ARCHITECTURE.md](/design/architecture). Every task follows this blueprint unless per-repo customization overrides specific steps.

#### Step 1: Admission control (deterministic)

See the Admission control section for details. Validates that the task is allowed to run: repo is onboarded, user is within limits, request is not a duplicate. On success, the orchestrator acquires a concurrency slot and transitions the task to `HYDRATING`.

#### Step 2: Context hydration (deterministic)

See the Context hydration section for details. Assembles the agent's prompt from multiple sources depending on task type. For `new_task`: user message, GitHub issue (title, body, comments), memory, repo configuration, and platform defaults. For `pr_iteration`: PR metadata, review comments, diff summary, and optional user instructions. An additional **pre-flight** sub-step verifies PR accessibility when `pr_number` is set (see [preflight.ts](../../cdk/src/handlers/shared/preflight.ts)). The output is a fully assembled prompt, ready to pass to the compute session.

#### Step 3: Session start and agent execution (deterministic start + agentic execution)

The orchestrator calls `invoke_agent_runtime` with the assembled payload and receives a session ID. It records the mapping (task ID → session ID) and transitions the task to `RUNNING`. From this point, the agent runs autonomously inside the MicroVM (see [AGENT_HARNESS.md](/design/agent-harness) and [COMPUTE.md](/design/compute)). The orchestrator monitors the session but does not influence the agent's behavior.

**Invocation model.** In Iteration 1, `invoke_agent_runtime` is called synchronously: the call blocks until the agent finishes and returns the response. In the target state, the orchestrator uses AgentCore's **asynchronous invocation model** (see [Runtime async docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html)): the agent receives the payload, starts the coding task in a **background thread**, and returns an acknowledgment immediately. The orchestrator then polls for completion by re-invoking on the same session (sticky routing — see Session management for details). This frees the orchestrator to manage other tasks concurrently and eliminates the need for a blocking call that spans hours.

#### Step 4: Result inference and finalization (deterministic)

See the Result inference and finalization section for details. After the session ends, the orchestrator inspects the outcome: checks GitHub for a PR on the agent's branch, verifies the build, examines the session response for errors. Based on this, it transitions the task to `COMPLETED`, `FAILED`, or `TIMED_OUT`. It then runs cleanup: releases the concurrency counter, emits task events, sends notifications, and persists the final task record.

### Step execution contract

Each step in the blueprint is executed as a function with these properties:

- **Idempotent.** If the orchestrator retries a step (e.g. after a crash or transient failure), the step produces the same result or safely detects that it already ran. For example, context hydration produces the same prompt for the same inputs; session start is idempotent if the session ID is pre-generated and reused on retry.
- **Timeout-bounded.** Each step has a configurable timeout so a stuck step does not block the pipeline indefinitely.
- **Failure-aware.** Each step returns a success/failure signal via `StepOutput.status`. On explicit failure (`status === 'failed'`), the orchestrator transitions the task to `FAILED` without retry. On infrastructure-level failures (Lambda timeout, throttle, transient errors), the framework retries with exponential backoff (default: 2 retries, base 1s, max 10s). See [REPO_ONBOARDING.md](/design/repo-onboarding#step-inputoutput-contract) for the full retry policy.
- **Least-privilege input.** Each step receives a filtered `blueprintConfig` containing only the fields it needs. Custom Lambda steps receive a sanitized config with credential ARNs stripped. See [REPO_ONBOARDING.md](/design/repo-onboarding#step-inputoutput-contract) for the config filtering policy.
- **Bounded output.** `StepOutput.metadata` is limited to 10KB serialized per step. `previousStepResults` is pruned to the last 5 steps to keep durable execution checkpoints within the 256KB limit.

### Extension points: the 3-layer customization model

The orchestrator is a **framework** that enforces platform invariants and delegates variable work to blueprint-defined step implementations. Per [REPO_ONBOARDING.md](/design/repo-onboarding), blueprints customize execution through three layers:

**Layer 1: Parameterized built-in strategies.** Select and configure built-in step implementations without writing code. Examples: `compute.type: 'agentcore'` selects AgentCore Runtime as the compute provider; `compute.type: 'ecs'` selects ECS Fargate. Each strategy exposes its own configuration surface (e.g. `runtime_arn` for agentcore, `taskDefinitionArn` for ECS). The orchestrator resolves the strategy by `compute_type` key, instantiates it with the provided config, and delegates step execution.

**Layer 2: Lambda-backed custom steps.** Inject custom logic at specific pipeline phases by providing a Lambda ARN. Each custom step declares a `phase` (`pre-agent` or `post-agent`), a `name`, an optional `timeoutSeconds`, and optional `config`. The orchestrator invokes the Lambda with a `StepInput` payload and expects a `StepOutput` response (see [REPO_ONBOARDING.md](/design/repo-onboarding#blueprint-execution-framework) for the contracts). Examples: SAST scan before the agent, custom lint after the agent, notification webhook on finalization.

**Layer 3: Custom step sequences.** Override the default step order entirely. A `step_sequence` is an ordered list of `StepRef` entries, each referencing either a built-in step (by name) or a custom step (by `CustomStepConfig.name`). The orchestrator iterates the sequence, resolving each reference to a built-in implementation or Lambda invocation. This enables inserting custom steps between built-in steps or reordering the pipeline. If `step_sequence` is absent, the default sequence applies.

**What the framework enforces (regardless of customization):**
- State transitions: every step runs within a state machine transition — the task cannot skip states.
- Event emission: step start/end events are emitted automatically.
- Cancellation: the framework checks for cancellation between steps and aborts if a cancel request is pending.
- Concurrency: slot acquisition and release are managed by the framework, not by individual steps.
- Timeouts: each step is bounded by a configurable timeout.

### Step resolution

When the orchestrator loads a task's `blueprint_config`, it resolves the step pipeline:

1. **Load `RepoConfig`** from the `RepoTable` by `repo` (PK). Merge with platform defaults (see [REPO_ONBOARDING.md](/design/repo-onboarding#platform-defaults) for default values and override precedence).
2. **Resolve compute strategy** from `compute_type` (default: `agentcore`). The strategy implements the `ComputeStrategy` interface (see [REPO_ONBOARDING.md](/design/repo-onboarding#compute-strategy-interface)).
3. **Build step list.** If `step_sequence` is provided, use it; otherwise use the default sequence (`admission-control` → `hydrate-context` → `start-session` → `await-agent-completion` → `finalize`). For each entry, resolve to a built-in step function or a Lambda invocation wrapper.
4. **Inject custom steps.** If `custom_steps` are defined and no explicit `step_sequence` is provided, insert them at their declared `phase` position (pre-agent steps before `start-session`, post-agent steps after `await-agent-completion`).
5. **Validate.** Check that required steps are present and correctly ordered (see [step sequence validation](/design/repo-onboarding#step-sequence-validation)). If invalid, fail the task with `INVALID_STEP_SEQUENCE`.
6. **Execute.** Iterate the resolved list. For each step: check cancellation, filter `blueprintConfig` to only the fields that step needs (stripping credential ARNs for custom Lambda steps), execute with retry policy, enforce `StepOutput.metadata` size budget (10KB), prune `previousStepResults` to last 5 steps, emit events. Built-in steps that need durable waits (e.g. `await-agent-completion`) receive the `DurableContext` and `ComputeStrategy` so they can call `waitForCondition` and `computeStrategy.pollSession()` internally — no name-based special-casing in the framework loop.

---

## Admission control

Admission control runs immediately after the input gateway dispatches a "create task" message. It is the first step of the blueprint. Its purpose is to reject tasks that should not run, before any compute resources are consumed.

### Checks (in order)

1. **Repo onboarding check (Iteration 3+).** Is the target repository registered with the platform? If not, reject with an error. In Iteration 1–2, this check is skipped (any repo the credentials can access is allowed). In Iteration 3+, this check is performed at the **API handler level** (`createTaskCore`) rather than in the orchestrator, for faster rejection (no orphan `SUBMITTED` tasks). The handler does a `GetItem` on the `RepoTable` by `repo` (PK). If not found or `status !== 'active'`, the request is rejected with 422 `REPO_NOT_ONBOARDED`. The orchestrator's admission control step can optionally re-check as defense-in-depth. See [REPO_ONBOARDING.md](/design/repo-onboarding) for the `RepoConfig` schema and blueprint contract.

2. **User concurrency limit.** How many tasks is this user currently running? If the count equals or exceeds the per-user limit (configurable, e.g. 3), the task is rejected. A `UserConcurrency` counter is checked atomically. If below the limit, the counter is incremented and the task proceeds to hydration. If at the limit, the task is rejected with a concurrency limit error.

3. **System-wide concurrency limit.** Is the system at capacity? The total number of `RUNNING` + `HYDRATING` tasks is compared to the system-wide limit (bounded by AgentCore quotas, e.g. concurrent session limit per account). If at capacity, the task is queued even if the user has room.

4. **Rate limiting.** A per-user rate limit (e.g. 10 tasks per hour) prevents abuse. Implemented as a sliding window counter (e.g. in DynamoDB with TTL). Tasks that exceed the rate are rejected, not queued.

5. **Idempotency check.** If the task request includes an idempotency key (e.g. client-supplied header), check whether a task with that key already exists. If so, return the existing task ID and status without creating a duplicate. Idempotency keys are stored with a TTL (e.g. 24 hours).

### Admission result

- **Accepted.** Task transitions to `HYDRATING`. Concurrency counter incremented.
- **Rejected.** Task transitions to `FAILED` with a reason (repo not onboarded, rate limit exceeded, concurrency limit, validation error). No counter change.
- **Deduplicated.** Existing task ID returned. No new task created.

---

## Context hydration

Context hydration assembles the agent's user prompt from multiple sources. It runs as a deterministic step in the orchestrator Lambda after admission control and before session start. The goal is to perform I/O-bound work (GitHub API calls, Secrets Manager lookups) *before* expensive agent compute is consumed, enabling fast failure when external APIs are unavailable.

### Current implementation (Iteration 3a+)

The orchestrator's `hydrateAndTransition()` function calls `hydrateContext()` (`src/handlers/shared/context-hydration.ts`) which:

1. **Resolves the GitHub token** from Secrets Manager (if `GITHUB_TOKEN_SECRET_ARN` is configured). The token is cached in a module-level variable with a 5-minute TTL for Lambda execution context reuse.
2. **Fetches external context** based on task type:
   - **`new_task`**: Fetches the GitHub issue (title, body, comments) via the GitHub REST API if `issue_number` is present.
   - **`pr_iteration`** / **`pr_review`**: Fetches the pull request context via `fetchGitHubPullRequest()` — four parallel calls: three REST API calls (PR metadata, conversation comments, changed files) plus one GraphQL query for inline review comments. The GraphQL query filters out resolved review threads at fetch time so the agent only sees unresolved feedback. PR metadata includes title, body, head/base refs, and state; the diff summary covers changed files. The PR's `head_ref` is stored as `resolved_branch_name` and `base_ref` as `resolved_base_branch` on the hydrated context. These are used by the orchestrator to update the task record's `branch_name` from the placeholder `pending:pr_resolution` to the actual PR branch. For `pr_review`, if no `task_description` is provided, a default review instruction is used.
3. **Enforces a token budget** on the combined context. Uses a character-based heuristic (~4 chars per token). Default budget: 100K tokens (configurable via `USER_PROMPT_TOKEN_BUDGET` environment variable). When the budget is exceeded, oldest comments are removed first. The `truncated` flag is set in the result.
4. **Assembles the user prompt** based on task type:
   - **`new_task`**: A structured markdown document with Task ID, Repository, GitHub Issue section, and Task section. The format mirrors the Python `assemble_prompt()` in `agent/entrypoint.py`.
   - **`pr_iteration`**: Assembled by `assemblePrIterationPrompt()` — includes PR metadata (number, title, body), the diff summary (changed files and patches), review comments (inline and conversation), and optional user instructions from `task_description`.
5. **Returns a `HydratedContext` object** containing `version`, `user_prompt`, `issue`, `sources`, `token_estimate`, `truncated`, and for `pr_iteration`/`pr_review` tasks: `resolved_branch_name` and `resolved_base_branch`.

The hydrated context is passed to the agent as a new `hydrated_context` field in the invocation payload, alongside the existing legacy fields (`repo_url`, `task_id`, `branch_name`, `issue_number`, `prompt`). The agent checks for `hydrated_context` with `version == 1`; if present, it uses the pre-assembled `user_prompt` directly and skips in-container GitHub fetching and prompt assembly. If absent (e.g. during a deployment rollout or when the secret ARN isn't configured), the agent falls back to its existing behavior.

**Graceful degradation:** If any step fails (Secrets Manager unavailable, GitHub API error, network timeout), the orchestrator proceeds with whatever context is available. The worst case is a minimal prompt with just the task ID and repository — the agent can still attempt its own GitHub fetch as a fallback via the legacy `issue_number` field.

**PR iteration branch resolution:** After hydration, if `resolved_branch_name` is present on the hydrated context, the orchestrator updates the task record's `branch_name` in DynamoDB from the placeholder (`pending:pr_resolution`) to the PR's actual `head_ref`. This ensures the task record always reflects the real branch name that the agent will push to.

### Hydration events

The orchestrator emits two task events during hydration:

- `hydration_started` — emitted when the task transitions to `HYDRATING`
- `hydration_complete` — emitted after context assembly, with metadata: `sources` (array of context sources used, e.g. `["issue", "task_description"]`), `token_estimate` (estimated token count of the assembled prompt), `truncated` (whether the token budget was exceeded)

### AgentCore Gateway — evaluated and deferred

We evaluated routing GitHub API calls through AgentCore Gateway (with the GitHub MCP server or GitHub REST API as an OpenAPI target). Conclusion: not needed for this iteration. The core agent operations (git clone, commit, push) are git-protocol operations that cannot go through the MCP server — the agent must keep its direct PAT regardless. The Gateway would only abstract the read-only operations (issue fetching) used in hydration, adding infrastructure complexity for minimal benefit over direct API calls. If AgentCore Gateway is introduced later (e.g. for multi-provider git support or centralized credential management), the hydration code's `fetchGitHubIssue` function can be swapped to call the Gateway endpoint without changing the pipeline's structure.

### Sources (in assembly order)

1. **System prompt template.** The platform's default system prompt (see `agent/system_prompt.py`). Stays in the agent container because the template has a `{setup_notes}` placeholder that depends on `setup_repo()` running inside the container. In future, this template may be overridden per-repo via onboarding config.

2. **Repo configuration (Iteration 3+).** Per-repo rules, instructions, or context loaded from the onboarding store. This can include static artifacts discovered during onboarding (e.g. content from `.cursor/rules`, `CLAUDE.md`, `CONTRIBUTING.md`) and dynamic artifacts generated by the onboarding pipeline (e.g. codebase summaries, dependency graphs). See [REPO_ONBOARDING.md](/design/repo-onboarding).

3. **GitHub issue context** (`new_task`). If the task references a GitHub issue: fetch the issue title, body, and comments via the GitHub REST API. **Now done in the orchestrator** (`fetchGitHubIssue` in `src/handlers/shared/context-hydration.ts`), not in the agent container.

3b. **Pull request context** (`pr_iteration`, `pr_review`). If the task references a PR (`pr_number` set): fetch the PR metadata, conversation comments, and changed files via REST API, and inline review comments via GraphQL (which filters out resolved threads at fetch time) — four parallel calls total via `fetchGitHubPullRequest()`. The PR's `head_ref` and `base_ref` are extracted for branch resolution. Review comments and diff are formatted into the user prompt so the agent understands the feedback to address.

4. **User message.** The free-text task description provided by the user (via CLI `--task` flag or equivalent). May supplement or replace the issue context.

5. **Memory context (Iteration 3+).** Query long-term memory (e.g. AgentCore Memory) for relevant past context: insights from previous tasks on this repo, failure summaries, learned patterns. See [MEMORY.md](/design/memory) for how insights and code attribution feed into hydration. Not yet implemented.

6. **Attachments.** Images or files provided by the user (multi-modal input). Passed through to the agent prompt as base64 or URLs.

### Prompt assembly

The orchestrator assembles one artifact during hydration:

- **User prompt.** Assembled differently based on task type:
  - **`new_task`**: `assembleUserPrompt()` — Format: `Task ID: {id}\nRepository: {repo}\n\n## GitHub Issue #{n}: {title}\n...\n\n## Task\n\n{description}`. This mirrors the Python `assemble_prompt()` function.
  - **`pr_iteration`**: `assemblePrIterationPrompt()` — Format: `Task ID: {id}\nRepository: {repo}\n\n## Pull Request #{n}: {title}\n\n{body}\n\n### Changed Files\n...\n\n### Review Comments\n...\n\n## Additional Instructions\n\n{description}`. This provides the agent with the full PR context, diff summary, and reviewer feedback.
  - **`pr_review`**: Uses `assemblePrIterationPrompt()` (same format as `pr_iteration`). If no task description is provided, defaults to "Review this pull request. Follow the workflow in your system instructions."

The system prompt is **not** assembled in the orchestrator — it remains in the agent container because it depends on `setup_repo()` output (`{setup_notes}` placeholder). The agent selects the appropriate system prompt template based on `task_type`: the `new_task` workflow (understand → implement → test → commit → create PR), the `pr_iteration` workflow (understand feedback → address → test → push → comment on PR), or the `pr_review` workflow (analyze changes → compose findings → post review comments → post summary). In the target state, additional sections may be injected: repo-specific rules, memory-derived insights.

### Payload contract

```
Legacy:   { repo_url, task_id, branch_name, issue_number?, prompt? }
Current:  { repo_url, task_id, branch_name, issue_number?, prompt?, task_type, pr_number?, base_branch?, hydrated_context }
```

For `new_task` (default):
```json
{
  "repo_url": "owner/repo",
  "task_id": "01HYX...",
  "branch_name": "bgagent/01HYX.../fix-auth-bug",
  "task_type": "new_task",
  "hydrated_context": {
    "version": 1,
    "user_prompt": "Task ID: ...\nRepository: ...\n\n## GitHub Issue #42: ...",
    "issue": { "number": 42, "title": "...", "body": "...", "comments": [...] },
    "sources": ["issue", "task_description"],
    "token_estimate": 1250,
    "truncated": false
  }
}
```

For `pr_iteration`:
```json
{
  "repo_url": "owner/repo",
  "task_id": "01HYX...",
  "branch_name": "feature/my-branch",
  "task_type": "pr_iteration",
  "pr_number": 42,
  "base_branch": "main",
  "hydrated_context": {
    "version": 1,
    "user_prompt": "Task ID: ...\nRepository: ...\n\n## Pull Request #42: ...\n\n### Review Comments\n...",
    "sources": ["pr_context", "task_description"],
    "token_estimate": 3400,
    "truncated": false,
    "resolved_branch_name": "feature/my-branch",
    "resolved_base_branch": "main"
  }
}
```

The `branch_name` for `pr_iteration` and `pr_review` tasks is the PR's `head_ref` (resolved during hydration), not a generated `bgagent/...` branch. The `base_branch` field is populated from the PR's `base_ref` so the agent knows the merge target.

### Token budget

The orchestrator enforces a token budget on the user prompt before assembly:

- **Estimation heuristic:** `Math.ceil(text.length / 4)` (~4 characters per token).
- **Default budget:** 100,000 tokens (configurable via `USER_PROMPT_TOKEN_BUDGET` CDK prop / environment variable).
- **Truncation strategy:** Differs by task type:
  - **`new_task`:** When the combined estimated token count (issue body + comments + task description) exceeds the budget, oldest comments are removed first. If still over budget after removing all comments, the issue body and task description are kept as-is (they are assumed to be essential).
  - **`pr_iteration`/`pr_review`:** When the assembled PR prompt exceeds the budget, oldest issue comments are trimmed first (conversation comments on the PR), then oldest review comments (inline code review comments). The PR metadata, diff summary, and user instructions are preserved.
  - The `truncated` flag is set in the hydrated context metadata when truncation occurs.
- The agent harness handles its own context compaction during the run for multi-turn conversations.

---

## Session management

### Starting a session

The orchestrator invokes `invoke_agent_runtime` (AgentCore API) with:

- `agentRuntimeArn` — the ARN of the deployed runtime (from CDK stack output).
- `runtimeSessionId` — a pre-generated UUID tied to the task. Pre-generating the session ID is important for idempotency: if the orchestrator retries after a crash, it reuses the same session ID. If the session was already started, AgentCore either returns the existing session or rejects the duplicate.
- `payload` — the hydrated prompt and configuration (repo, max turns, model).

The orchestrator records the `(task_id, session_id)` mapping in the task record immediately before the invocation call. This ensures that even if the orchestrator crashes after the call succeeds, the session ID is recoverable.

### Invocation model: synchronous vs. asynchronous

**Iteration 1 (current).** `invoke_agent_runtime` is called synchronously with a long read timeout. The call blocks until the agent finishes. This is simple but limits concurrency: one orchestrator process per task.

**Target state.** The orchestrator uses AgentCore's **asynchronous processing model** ([Runtime async docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html)). The key capabilities:

1. **Non-blocking invocation.** The agent's `@app.entrypoint` handler receives the payload and starts the coding task in a **background thread** (using the SDK's `add_async_task` / `complete_async_task` API for task tracking). It returns an acknowledgment immediately. The `invoke_agent_runtime` call completes in seconds, not hours.

2. **Sticky routing on session.** Subsequent calls to `invoke_agent_runtime` with the **same `runtimeSessionId`** are routed to the **same instance**. This enables a poll pattern: the orchestrator re-invokes on the same session to ask for status, and the agent responds with its current state (running, completed, failed) and, on completion, the result payload (PR URL, cost, error, etc.).

3. **Health status via `/ping`.** The agent's `/ping` endpoint reports processing status: `{"status": "HealthyBusy"}` while the background task is running, `{"status": "Healthy"}` when idle. AgentCore polls `/ping` automatically; the 15-minute idle timeout starts only when the status is `Healthy` (idle). As long as the agent reports `HealthyBusy`, the session stays alive.

**Agent-side contract.** The agent entrypoint must:
- Start the coding task in a separate thread (so `/ping` remains responsive).
- Call `app.add_async_task(...)` when work begins and `app.complete_async_task(...)` when work ends.
- On subsequent invocations (poll requests), return the current status and, if complete, the result.

This model eliminates the need for a wrapper Lambda or Fargate task to hold a blocking call. The orchestrator's poll is a lightweight, fast `invoke_agent_runtime` call that returns immediately.

### Liveness monitoring

The orchestrator needs to know whether the session is still running. Two complementary mechanisms:

1. **`/ping` health status.** AgentCore automatically polls the agent's `/ping` endpoint. The agent reports `HealthyBusy` while the coding task is active and `Healthy` when idle. The orchestrator does not call `/ping` directly — AgentCore does. However, the `/ping` status drives the session lifecycle: a session in `Healthy` (idle) state for 15 minutes is automatically terminated. As long as the agent reports `HealthyBusy`, the session stays alive indefinitely (up to the 8-hour hard cap).

2. **Re-invocation on the same session (target state).** The orchestrator calls `invoke_agent_runtime` with the same `runtimeSessionId`. Sticky routing ensures the request reaches the same instance. The agent's entrypoint can detect this is a poll (e.g., via a `poll: true` field in the payload or by tracking the initial task) and return the current status without starting a new task. This is a fast, lightweight call that returns immediately.

**Iteration 1.** The `invoke_agent_runtime` call blocks; when it returns, the session is over. No explicit liveness check needed.

**Fallback: DynamoDB heartbeat (optional enhancement).** As defense in depth, the agent can write a heartbeat timestamp to DynamoDB every N minutes. The orchestrator reads it during its poll cycle. A missing heartbeat (e.g. none in the last 10 minutes while `/ping` reports `HealthyBusy`) could indicate the agent is stuck but not idle — triggering investigation or forced termination.

### The 15-minute idle timeout problem

AgentCore Runtime terminates sessions after 15 minutes of inactivity (no `/ping` response or no invocations). This is a critical constraint for coding tasks: the agent may take several minutes between tool calls (e.g. during a long build or a complex reasoning step).

**Mitigation (async model).** In the target state, the agent uses the AgentCore SDK's async task management: `add_async_task` registers a background task, and the SDK automatically reports `HealthyBusy` via `/ping` while any async task is active. AgentCore polls `/ping` and sees the agent is busy, preventing idle termination. When the agent calls `complete_async_task`, the status reverts to `Healthy`. The `/ping` endpoint runs on the main thread (or async event loop) while the coding task runs in a separate thread, so `/ping` remains responsive.

**Mitigation (Iteration 1 / current).** The agent container's FastAPI server defines `/ping` as a separate async endpoint. Because the agent task runs in a threadpool worker (not in the asyncio event loop), the `/ping` endpoint remains responsive while the agent works. AgentCore calls `/ping` periodically and the server responds, preventing idle timeout.

**Risk.** If the agent's computation blocks the entire process (not just a thread) — e.g. due to a subprocess that consumes all resources, or the server becomes unresponsive — the `/ping` response may be delayed, triggering idle termination. This risk applies to both models. The defense is to ensure the coding task runs in a separate thread or process and does not starve the main thread.

### Session completion detection

When the session ends (agent finishes, crashes, or is terminated), the orchestrator detects this:

- **Iteration 1:** The `invoke_agent_runtime` call returns (it blocks). The response body contains the agent's output (status, PR URL, cost, etc.).
- **Target state:** The orchestrator polls the agent via re-invocation on the same session (see Invocation model above). Completion is detected when: (a) the agent responds with a "completed" or "failed" status in the poll response, or (b) the re-invocation fails because the session was terminated (idle timeout, crash, or 8-hour limit reached). In the durable orchestrator, a `waitForCondition` evaluates the poll result at each interval and resumes the pipeline when the condition is met. See the session monitoring pattern in the Implementation options section.

### External termination (cancellation)

When the user cancels a task in `RUNNING` state, the orchestrator calls `stop_runtime_session`. The orchestrator must:

1. Call `stop_runtime_session`.
2. Wait for confirmation (the call succeeds or the session is already terminated).
3. Transition the task to `CANCELLED`.
4. Run partial finalization: release concurrency counter, emit events, persist state. Do **not** attempt result inference (the session was intentionally killed).

---

## Result inference and finalization

### How the orchestrator determines success or failure

After the session ends, the orchestrator examines multiple signals:

1. **Session response.** If the `invoke_agent_runtime` call returns a response body (as in Iteration 1), parse it for the agent's self-reported status (`success`, `error`, `end_turn`), PR URL, cost, and error message.

2. **GitHub state inspection.** Regardless of the agent's self-report, verify against GitHub:
   - **Branch exists?** Check if the agent's branch (`bgagent/{task_id}/{slug}`) was pushed to the remote.
   - **PR exists?** Query the GitHub API for a PR from the agent's branch.
   - **Commit count.** How many commits are on the branch beyond `main`? Zero commits with no PR likely means the agent did nothing useful.

3. **Decision matrix.**

   | Agent self-report | PR exists | Commits on branch | Outcome |
   |---|---|---|---|
   | success / end_turn | Yes | > 0 | `COMPLETED` |
   | success / end_turn | Yes | > 0 (build failed) | `COMPLETED` (with warning: build failed post-agent) |
   | success / end_turn | No | > 0 | `COMPLETED` (partial: work committed but no PR; orchestrator may attempt PR creation as a post-hook) |
   | success / end_turn | No | 0 | `FAILED` (agent reported success but did nothing) |
   | error | Yes | > 0 | `COMPLETED` (with warning: agent reported error but PR exists) |
   | error | No | > 0 | `FAILED` (partial work on branch, no PR) |
   | error | No | 0 | `FAILED` |
   | unknown / no response | — | — | `FAILED` (session ended unexpectedly) |

### Fragility of GitHub-based inference and proposed improvements

Relying solely on GitHub state to determine task outcome is fragile:

- **Race condition.** The agent may have pushed commits but not yet created the PR when the session was terminated (timeout or crash). The orchestrator sees commits but no PR.
- **GitHub API availability.** If the GitHub API is down when finalization runs, the orchestrator cannot determine the outcome. It must retry or mark as `FAILED` with an infrastructure-error reason.
- **Ambiguity.** Commits exist but no PR — is this a failure or partial success?

**Proposed improvement: explicit completion signal.** In the target state, the agent should write a **completion record** to an external store (e.g. DynamoDB or AgentCore Memory) before the session ends. This record would contain: `task_id`, `status` (success/failure), `pr_url` (if any), `error_message` (if any), `branch_name`, `commit_count`. The orchestrator reads this record during finalization. GitHub inspection becomes a fallback, not the primary signal.

This is more reliable because the agent writes the record as the last step before exiting (deterministic, under its control), and the orchestrator reads it from DynamoDB (fast, highly available, independent of GitHub). If the record is missing (crash before write), the orchestrator falls back to GitHub inspection.

### Cleanup

After determining the outcome, the orchestrator:

1. **Updates task status** in the Tasks table (terminal state + metadata: PR URL, error, duration, cost).
2. **Stamps TTL for data retention.** When the task reaches a terminal state, a `ttl` attribute is set on the task record (current time + `taskRetentionDays`, default 90 days). DynamoDB automatically deletes the record after the TTL expires. If the agent wrote the terminal status directly (e.g. COMPLETED), the orchestrator retroactively stamps the TTL during finalization. All task events also carry a TTL set at creation time.
3. **Emits task events** to the TaskEvents audit log (e.g. `task_completed`, `task_failed`).
4. **Releases concurrency counter.** Decrements the user's `UserConcurrency` counter. If this fails (e.g. DynamoDB error), the counter drifts; a reconciliation job detects and corrects drift (see [OBSERVABILITY.md](/design/observability)).
5. **Emits notifications.** Sends an internal notification (per [INPUT_GATEWAY.md](/design/input-gateway) outbound schema) so channel adapters can inform the user.
6. **Future: queue processing.** Reserved for future implementation of task queuing when capacity is at limit.
7. **Persists code attribution data (Iteration 3+).** Writes task metadata (task_id, repo, branch, commits, PR URL, outcome) to memory for future retrieval. See [MEMORY.md](/design/memory) and [OBSERVABILITY.md](/design/observability).

---

## Failure modes and recovery

This section uses an FMEA (Failure Mode and Effects Analysis) approach: for each component and step, what can go wrong, what is the impact, and what the orchestrator does.

### Admission control failures

| Failure mode | Impact | Recovery |
|---|---|---|
| DynamoDB unavailable (cannot read repo config or concurrency counters) | Task cannot be admitted | Retry with backoff (up to 3 attempts). If still failing, reject the task with a transient error. |
| Concurrency counter is drifted (shows higher than actual) | Legitimate tasks get queued unnecessarily | Reconciliation job runs periodically (e.g. every 5 min) and corrects counter based on actual `RUNNING` task count. |

### Context hydration failures

| Failure mode | Impact | Recovery |
|---|---|---|
| GitHub API unavailable or rate limited | Cannot fetch issue context | Retry with backoff. If the issue is essential (issue-based task), fail the task. If the user also provided a task description, proceed with degraded context (no issue body). |
| Memory service unavailable | Cannot retrieve past insights | Proceed without memory context (memory is an enrichment, not required for MVP). Log warning. |
| Prompt exceeds token budget | Agent may lose coherence or fail to start | Truncate lower-priority sources (old comments, memory) to fit budget. |

### Session start failures

| Failure mode | Impact | Recovery |
|---|---|---|
| `invoke_agent_runtime` returns error (e.g. throttled — 25 TPS limit) | Session not started | Retry with exponential backoff. If repeatedly failing, transition task to `FAILED` with reason "session start failed". |
| `invoke_agent_runtime` returns but session crashes immediately | Session starts then dies | Orchestrator detects session end (from the blocking call returning or from polling). Result inference finds no commits, no PR. Task transitions to `FAILED`. |
| AgentCore Runtime is unavailable (service outage) | No sessions can start | All tasks in `HYDRATING` that attempt session start will fail. Queue new tasks. Alert operators (see [OBSERVABILITY.md](/design/observability)). |

### Agent execution failures (during RUNNING)

| Failure mode | Impact | Recovery |
|---|---|---|
| Agent crashes mid-task (unhandled exception) | Partial branch may exist on GitHub | Orchestrator detects session end. Finalization inspects GitHub state. If commits exist, may mark as partial completion. Task transitions to `FAILED` or `COMPLETED` with partial flag. |
| Agent runs out of turns (max_turns limit) | Agent stopped by SDK, not by crash | Session ends normally with status `end_turn`. Orchestrator finalizes; if PR exists, task is `COMPLETED`. |
| Agent exceeds cost budget (max_budget_usd limit) | Agent stopped by SDK when budget is reached | Session ends normally. Orchestrator finalizes; if PR exists, task is `COMPLETED`. |
| Agent is idle for 15 min (AgentCore kills session) | Work in progress may be lost if not committed | Task transitions to `TIMED_OUT`. Partial work may be on the branch if the agent committed before going idle. |
| Agent exceeds 8-hour max session duration | AgentCore terminates session | Task transitions to `TIMED_OUT`. Partial work may be on the branch. |

### Result inference failures

| Failure mode | Impact | Recovery |
|---|---|---|
| GitHub API unavailable during finalization | Cannot determine outcome | Retry finalization after a delay (e.g. 1 min, up to 3 retries). If still failing, mark task as `FAILED` with reason "finalization failed — could not verify GitHub state". |
| Explicit completion signal missing and GitHub shows ambiguous state | Outcome uncertain | Apply decision matrix. When truly ambiguous, mark as `FAILED` with the ambiguity reason and let the user inspect the branch. |

### Orchestrator failures

| Failure mode | Impact | Recovery |
|---|---|---|
| Orchestrator crashes during `HYDRATING` | Task stuck in `HYDRATING` | Durable execution (Lambda Durable Functions) automatically replays from the last checkpoint, skipping completed steps. Without durable orchestration, a recovery process detects stuck tasks (in `HYDRATING` for > N minutes) and restarts them. |
| Orchestrator crashes during `RUNNING` | Task stuck in `RUNNING`, session may still be alive | Recovery process detects task is in `RUNNING` but orchestrator is not managing it. It resumes monitoring the session (using the stored session ID). When the session ends, it runs finalization. |
| Orchestrator crashes during `FINALIZING` | Task stuck in `FINALIZING` | Recovery process detects and restarts finalization. Finalization steps must be idempotent (decrementing a counter twice should be detected and handled). |
| DynamoDB unavailable during state transition | State not persisted | Retry with backoff. If the state transition cannot be persisted, the orchestrator must not proceed (risk of inconsistency). After retries are exhausted, alert operators. |

### Recovery mechanisms summary

1. **Durable execution.** The orchestrator uses a durable execution model (see Implementation options) that survives process crashes. State is checkpointed at each transition.
2. **Idempotent operations.** All steps and transitions are designed to be safely retried.
3. **Stuck-task detection.** A periodic process (e.g. CloudWatch Events + Lambda) scans for tasks stuck in non-terminal states beyond expected durations and either resumes or fails them.
4. **Counter reconciliation.** A periodic process compares concurrency counters to actual running task counts and corrects drift.
5. **Dead-letter queue.** Tasks that fail all retries are sent to a DLQ for manual investigation.

---

## Concurrency and scaling

### How multiple tasks run in parallel

Each task runs in its own isolated AgentCore Runtime session. The orchestrator manages multiple tasks concurrently. There is no shared mutable state between tasks at the compute layer; the orchestrator's concurrency management is purely at the coordination layer (counters, state transitions, queue processing).

### Capacity limits

| Limit | Value | Source |
|---|---|---|
| `invoke_agent_runtime` TPS | 25 per agent, per account | AgentCore quota (adjustable) |
| Concurrent sessions | Account-level limit (check AgentCore quotas) | AgentCore quota |
| Per-user concurrency | Configurable (recommended default: 3–5) | Platform config |
| System-wide max concurrent tasks | Configurable (bounded by AgentCore session limit) | Platform config |

### Queue design

When tasks cannot start immediately (user or system at capacity), they are placed in a queue.

**Note:** Task queuing (QUEUED state) was removed from the implementation in Iteration 3bis. Tasks that exceed the concurrency limit are rejected immediately rather than queued. If queuing is needed in the future, a DynamoDB-based queue design can be added back.

The queue processor is triggered by:
- Task finalization (when a slot opens) via EventBridge or DynamoDB Streams
- A periodic sweep (e.g. every 30 seconds via CloudWatch Events) to catch missed triggers

### Counter management

Concurrency is tracked using atomic counters:

- **UserConcurrency.** A DynamoDB item per user: `{ user_id, active_count }`. Incremented atomically (conditional update: `active_count < max`) during admission. Decremented during finalization.
- **SystemConcurrency.** A single DynamoDB item: `{ pk: "SYSTEM", active_count }`. Same pattern.

**Counter drift.** If the orchestrator crashes after starting a session but before persisting the session-to-task mapping, or after a session ends but before decrementing the counter, the counter drifts. Mitigation:

- Always persist the task state transition **before** taking the action (write-ahead pattern). For example, persist the task as `RUNNING` and record the session ID before calling `invoke_agent_runtime`.
- Run a **reconciliation Lambda** every 5 minutes (EventBridge schedule): query the Tasks table for tasks in `RUNNING` + `HYDRATING` state per user (GSI on `user_id` + `status`), compare the count to `UserConcurrency.active_count`, and correct via `UpdateItem` if different. The Lambda emits a `counter_drift_corrected` CloudWatch metric (dimensions: `user_id`, `drift_amount`) when it corrects a value, and a `counter_reconciliation_run` metric on every execution for health monitoring.
- Emit a CloudWatch alarm when drift is detected (see [OBSERVABILITY.md](/design/observability)). If automated reconciliation fails (e.g. Lambda error), escalate to operator via SNS notification.

---

## Implementation options

### Option A: Lambda Durable Functions

**How it works.** The orchestrator is a single Lambda function using the [Lambda Durable Execution SDK](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html) (available for TypeScript and Python). The blueprint is written as sequential code with durable operations (`step`, `wait`, `waitForCallback`, `waitForCondition`). Each operation creates a checkpoint; if the function is interrupted or needs to wait, it suspends without compute charges. On resumption, the SDK replays from the beginning, skipping completed checkpoints using stored results.

**Conceptual orchestrator code (TypeScript):**

```typescript
export const handler = withDurableExecution(
  async (event: TaskEvent, context: DurableContext) => {

    // --- Framework: load blueprint, validate, and resolve step pipeline ---
    const blueprint = await context.step('load-blueprint', async () => {
      const repoConfig = await loadRepoConfig(event.repo);
      const merged = mergeWithDefaults(repoConfig);
      const pipeline = resolveStepPipeline(merged);
      validateStepSequence(pipeline.steps); // Throws INVALID_STEP_SEQUENCE if invalid
      return pipeline;
      // Returns: { steps: ResolvedStep[], computeStrategy, config }
    });

    // --- Framework: iterate steps with invariant enforcement ---
    let pipelineState: PipelineState = { event };

    for (const step of blueprint.steps) {
      // Framework: check for cancellation between steps
      await context.step(`cancel-check-${step.name}`, async () => {
        const task = await getTask(event.taskId);
        if (task.cancelRequested) throw new CancellationError();
      });

      // Framework: filter config per step (least-privilege)
      const filteredConfig = filterConfigForStep(step, blueprint.config);

      // Framework: build step input with pruned previous results
      const input: StepInput = {
        taskId: event.taskId,
        repo: event.repo,
        blueprintConfig: filteredConfig,
        previousStepResults: pruneResults(pipelineState, /* keepLast */ 5),
      };

      // Framework: emit step-start event, execute step, emit step-end event
      const stepResult = await context.step(step.name, async () => {
        await emitEvent(event.taskId, `${step.name}_started`);
        try {
          let result: StepOutput;
          if (step.type === 'builtin') {
            // Built-in step: call the registered step function.
            // Built-in steps that need durable waits (e.g. await-agent-completion)
            // receive the DurableContext and ComputeStrategy so they can call
            // waitForCondition + computeStrategy.pollSession() internally.
            result = await step.execute(input, {
              durableContext: context,
              computeStrategy: blueprint.computeStrategy,
            });
          } else {
            // Custom Lambda step: invoke with retry policy
            result = await invokeCustomStepWithRetry(
              step.functionArn, input, step.timeoutSeconds,
              step.maxRetries ?? 2, // default: 2 retries
            );
          }

          enforceMetadataSize(result, /* maxBytes */ 10_240);
          await emitEvent(event.taskId, `${step.name}_completed`, result.metadata);
          return result;
        } catch (err) {
          await emitEvent(event.taskId, `${step.name}_failed`, { error: String(err) });
          throw err;
        }
      });

      pipelineState[step.name] = stepResult;
    }

    return pipelineState['finalize'];
  }
);

// --- Built-in step: await-agent-completion ---
// Polling is delegated to the ComputeStrategy, not hardcoded by step name.
async function awaitAgentCompletion(
  input: StepInput,
  opts: { durableContext: DurableContext; computeStrategy: ComputeStrategy },
): Promise<StepOutput> {
  const sessionHandle = input.previousStepResults['start-session']?.metadata?.sessionHandle;
  const pollIntervalMs = input.blueprintConfig.poll_interval_ms ?? 30_000;

  const sessionResult = await opts.durableContext.waitForCondition(
    'agent-completion-poll',
    async () => {
      const status = await opts.computeStrategy.pollSession(sessionHandle);
      return status.status !== 'running' ? status : undefined;
    },
    {
      interval: { seconds: pollIntervalMs / 1000 },
      timeout: { hours: 8, minutes: 30 },
    },
  );

  return {
    status: sessionResult.status === 'completed' ? 'success' : 'failed',
    metadata: { sessionResult },
    error: sessionResult.status === 'failed' ? sessionResult.error : undefined,
  };
}
```

**Pros:**
- **Durable execution natively in Lambda.** Checkpoint/replay mechanism survives interruptions. State is automatically persisted at each durable operation. No separate orchestration service needed.
- **Sequential code, not a DSL.** The blueprint is standard TypeScript/Python — no Amazon States Language, no JSON state machine definitions. Easier to read, test, debug, and refactor. The orchestrator logic lives in the same codebase and language as the CDK infrastructure.
- **No compute charges during waits.** When the orchestrator waits for the agent session to finish (hours), it suspends between poll intervals via `waitForCondition`. No Lambda compute is billed during suspension. Charges apply only to actual processing (admission, hydration, poll calls, finalization).
- **Execution duration up to 1 year.** Far exceeds the 8-hour agent session limit. No risk of the orchestrator timing out before the agent finishes.
- **Condition-based polling for session completion.** The `waitForCondition` primitive evaluates a condition function at configurable intervals (e.g. every 30 seconds). Combined with AgentCore's async invocation model and sticky routing, the orchestrator re-invokes the same session to check status — a fast, lightweight call. This cleanly solves the "how does the orchestrator know the session is done" problem without a blocking wrapper, Fargate sidecar, or external callback infrastructure.
- **Built-in retry with checkpointing.** Steps support configurable retry strategies and `at-most-once` / `at-least-once` execution semantics. Failed steps can retry without re-executing already-completed work.
- **Parallel execution.** `context.parallel()` and `context.map()` enable concurrent operations (e.g. parallel hydration sources, parallel post-agent checks).
- **Operational simplicity.** Serverless, auto-scaling, scale-to-zero. No Step Functions state machines to deploy and manage separately.
- **Same development toolchain.** Standard Lambda development: CDK, SAM, IDE, unit tests, LLM agents for code generation. No separate visual designer or DSL required.

**Cons:**
- **New service (launched 2025).** Lambda Durable Functions is relatively new. Less battle-tested than Step Functions. Documentation and community examples are still growing.
- **Determinism requirement.** Code outside durable operations must be deterministic (same result on replay). Non-deterministic operations (UUID generation, timestamps, API calls) must be wrapped in `step`. This is a programming discipline requirement that developers must understand.
- **Checkpoint size limit.** 256 KB per checkpoint. Step results larger than this require child contexts and re-execution during replay. For this orchestrator, step results (task metadata, hydrated prompt references) are small — not expected to be an issue.
- **No visual workflow editor.** Unlike Step Functions, there is no drag-and-drop visual designer or built-in execution graph view. Debugging relies on CloudWatch logs, execution history API, and code-level tracing.
- **Less mature cross-service integration.** Step Functions has 220+ native service integrations. Durable Functions operates within Lambda — external service calls go through the SDK in steps. For this orchestrator (which calls DynamoDB, AgentCore, GitHub), this is not a limitation since all calls are made via SDKs anyway.

### Option B: AWS Step Functions (Standard Workflows)

**How it works.** Each task triggers a Step Functions state machine execution. The state machine defines the blueprint steps as states: admission control (Lambda), hydration (Lambda), session start (Lambda + wait), session monitor (Lambda + wait loop), finalization (Lambda). State is automatically persisted at each transition.

**Pros:**
- Mature, battle-tested service with extensive documentation.
- Visual workflow in the AWS console for debugging.
- Native support for wait states (up to 1 year), retries with backoff, parallel branches.
- 220+ native AWS service integrations.
- Pay per state transition, not per second of wait time.

**Cons:**
- **Workflow defined in ASL/DSL, not code.** The blueprint must be translated to Amazon States Language or CDK Step Functions constructs. This is a separate abstraction from the application code, harder to test as a unit, and requires context-switching between code and state machine definitions.
- **Session monitoring requires a Wait+Poll state machine loop.** With the async invocation model, `invoke_agent_runtime` returns immediately, so the 15-minute Lambda limit is no longer a problem. However, the poll loop must be modeled as a Wait state + Lambda task + Choice state cycle in the state machine definition (ASL), which is verbose compared to a single `waitForCondition` call in code.
- **Separate infrastructure to manage.** The state machine is a separate deployed resource. Changes to the orchestration logic require redeploying the state machine, not just a Lambda function.
- **Cost per state transition.** $0.025 per 1,000 transitions. For ~50 transitions per task, ~$0.00125 per task — negligible but non-zero.

### Option C: Lambda + DynamoDB (manual orchestration)

**How it works.** A coordinator Lambda is triggered by task creation. It reads the task record, runs admission control, performs hydration, starts the session, and writes state back to DynamoDB. A separate Lambda on a schedule checks for tasks in `RUNNING` state. Finalization is triggered when session completion is detected.

**Pros:**
- Full control over the implementation.
- No dependency on durable execution framework.

**Cons:**
- Must implement state persistence, retry logic, error handling, timeout management, and crash recovery manually. This is error-prone and the core value proposition of durable execution frameworks.
- Lambda 15-minute max execution time means the monitoring loop must be periodic invocations.
- No built-in checkpoint/replay — all durability is hand-rolled.
- Idempotency and exactly-once semantics are the developer's responsibility.

### Option D: EventBridge + Lambda (event-driven)

**How it works.** Each state transition emits an EventBridge event. Lambda functions trigger on events and perform the next step.

**Pros:**
- Loosely coupled; easy to add new steps or side-effects.
- EventBridge provides retry, DLQ, and filtering.

**Cons:**
- No centralized view of workflow state.
- Debugging distributed event chains is harder.
- Session monitoring does not fit naturally into an event-driven model.
- All durability is the developer's responsibility.

### Recommendation: Lambda Durable Functions

**Lambda Durable Functions** is the recommended implementation. Rationale:

1. **Durable execution is the core requirement.** Tasks run for hours. The orchestrator must survive crashes, resume from checkpoints, and handle retries. Durable Functions provides this natively with checkpoint/replay.
2. **The blueprint maps to sequential code.** The blueprint's step sequence (admission → hydration → session start → wait for completion → finalize) is naturally expressed as sequential code with durable operations. No DSL translation, no state machine abstraction — the code *is* the orchestrator.
3. **Condition-based polling solves the session-monitoring problem cleanly.** The `waitForCondition` primitive suspends the orchestrator between poll intervals (no compute charges). Combined with AgentCore's async invocation model (non-blocking start, sticky routing for status polls), the orchestrator detects session completion without a blocking wrapper Lambda, Fargate sidecar, or external callback infrastructure — the key technical challenge that makes Step Functions awkward for this use case.
4. **Cost-efficient for long-running waits.** The orchestrator pays nothing during the hours the agent runs. Charges apply only to the seconds of actual processing (admission, hydration, finalization).
5. **Same language, same codebase.** The orchestrator is TypeScript (or Python), co-located with the CDK infrastructure code and the agent code. Standard development toolchain: IDE, unit tests, code review, CDK deploy.
6. **Simpler operational model.** One Lambda function, not a Lambda + Step Functions state machine + optional Fargate task. Fewer moving parts to deploy, monitor, and debug.

**Trade-off acknowledged:** Lambda Durable Functions is newer than Step Functions. If the team encounters maturity issues (bugs, missing features, insufficient documentation), Step Functions (Option B) is the fallback. The blueprint step contract (idempotent, timeout-bounded, failure-aware) is implementation-agnostic — switching from Durable Functions to Step Functions requires re-wiring the orchestrator, not redesigning the blueprint.

### Session monitoring pattern (async invocation + poll)

The key architectural pattern that makes Lambda Durable Functions work for this use case leverages AgentCore's **asynchronous processing model** and **sticky session routing**:

1. **Orchestrator starts the session** via `context.step('start-session', ...)`. The `invoke_agent_runtime` call sends the hydrated payload. The agent receives it, starts the coding task in a **background thread** (registering via `add_async_task`), and returns an acknowledgment **immediately**. The step completes in seconds.

2. **Orchestrator polls for completion** via `context.waitForCondition(...)`. At configurable intervals (e.g. every 30 seconds), the condition function **re-invokes** `invoke_agent_runtime` on the **same `runtimeSessionId`**. Sticky routing ensures the request reaches the same instance. The agent's entrypoint detects this is a status poll and returns the current state:
   - `{ status: "running" }` — task still in progress. The condition returns `undefined`, and the orchestrator suspends until the next interval (no compute charges during the wait).
   - `{ status: "completed", pr_url: "...", cost_usd: ... }` — task finished. The condition returns the result, and the orchestrator resumes to finalization.
   - `{ status: "failed", error: "..." }` — task failed. Same as above, with an error payload.

3. **Session termination detection.** If the session is terminated externally (idle timeout, 8-hour limit, crash, or user cancellation), the re-invocation call either fails (session not found) or AgentCore starts a new session for that ID. The orchestrator detects this (e.g. by checking if the response is an unexpected acknowledgment rather than a status) and proceeds to finalization using GitHub-based result inference as a fallback.

4. **Timeout safety net.** The `waitForCondition` has a timeout (e.g. 8.5 hours — slightly beyond the AgentCore 8-hour max). If no completion is detected within this window, the orchestrator resumes with a timeout error and runs finalization.

**Why this pattern works:**
- **No blocking call.** Each `invoke_agent_runtime` call (initial and polls) completes in seconds. No Lambda, Fargate task, or wrapper needs to hold a connection for 8 hours.
- **No external callback infrastructure.** The orchestrator detects completion by polling — no need for the agent to call `SendDurableExecutionCallbackSuccess`, no EventBridge subscription, no sidecar.
- **No compute charges during waits.** The durable execution suspends between poll intervals. At 30-second intervals over an 8-hour session, the orchestrator performs ~960 lightweight polls. Each poll is a fast Lambda invocation (sub-second). Total orchestrator compute is minutes, not hours.
- **Resilient to agent crashes.** If the agent crashes, the next poll detects the session is gone. The orchestrator does not hang waiting for a callback that will never arrive.

**Poll interval cost analysis at scale:**

| Concurrent tasks | Polls/day (30s interval, 8hr avg) | Lambda invocations/day | `invoke_agent_runtime` TPS (peak) | Lambda cost/month |
|---|---|---|---|---|
| 10 | ~9,600 | ~9,600 | ~0.3 | ~$0.002 |
| 50 | ~48,000 | ~48,000 | ~1.7 | ~$0.01 |
| 200 | ~192,000 | ~192,000 | ~6.7 | ~$0.04 |
| 500 | ~480,000 | ~480,000 | ~16.7 | ~$0.10 |

The `invoke_agent_runtime` quota is 25 TPS per agent per account (adjustable). At 500 concurrent tasks with 30-second polls, peak TPS is ~16.7 — within quota. Lambda cost is negligible at all projected scales. The first bottleneck is the AgentCore concurrent session quota, not the poll mechanism.

**Tuning:** The 30-second interval is suitable for typical tasks (1–2 hours). For longer tasks (4+ hours), a 60-second or adaptive interval halves poll invocations with minimal impact on status update latency. The poll interval should be configurable per blueprint (via `blueprint_config.poll_interval_ms`).

**Agent-side contract for the poll pattern:**

The agent's entrypoint must distinguish between an initial task invocation and a status poll. Recommended approach:
- The initial invocation payload contains the full task context (prompt, repo, etc.) and a `type: "task"` field.
- Poll invocations contain `type: "poll"` (or simply an empty/minimal payload that the agent interprets as a status check).
- The agent maintains task state in memory (or a local store) and responds to polls with the current status.
- On completion, the agent writes a **completion record** to an external store (e.g. DynamoDB) as a durable backup — so even if the next poll fails, the orchestrator can query DynamoDB during finalization.

---

## Data model (conceptual)

### Tasks table

The primary table for task state. DynamoDB.

| Field | Type | Description |
|---|---|---|
| `task_id` (PK) | String (ULID) | Unique task identifier. ULID provides sortable, unique IDs. |
| `user_id` | String | Cognito sub or mapped platform user ID. |
| `status` | String | Current state (see state machine). |
| `repo` | String | GitHub owner/repo (e.g. `org/myapp`). |
| `task_type` | String | Task type: `new_task` (default), `pr_iteration`, or `pr_review`. Determines the agent workflow (create new PR, iterate on existing PR, or review a PR). |
| `issue_number` | Number (optional) | GitHub issue number, if task is issue-based. |
| `pr_number` | Number (optional) | Pull request number, required when task type is `pr_iteration` or `pr_review`. |
| `task_description` | String (optional) | Free-text task description. For `pr_iteration`/`pr_review`, used as additional instructions alongside PR context. |
| `branch_name` | String | Agent branch. For `new_task`: `bgagent/{task_id}/{slug}`. For `pr_iteration`/`pr_review`: initially `pending:pr_resolution`, resolved to the PR's `head_ref` during context hydration. |
| `session_id` | String (optional) | AgentCore runtime session ID, set when session is started. |
| `execution_id` | String (optional) | Lambda durable execution ID, set when the orchestrator starts. |
| `pr_url` | String (optional) | Pull request URL, set during finalization. |
| `error_message` | String (optional) | Error reason if FAILED. |
| `error_code` | String (optional) | Machine-readable error code if FAILED (e.g. `INVALID_STEP_SEQUENCE`, `SESSION_START_FAILED`, `TIMEOUT`). Used for failure categorization in the evaluation pipeline and surfaced via `GET /v1/tasks/{id}`. |
| `idempotency_key` | String (optional) | Client-supplied idempotency key. |
| `channel_source` | String | Originating channel (`cli`, `slack`, `web`, etc.). |
| `channel_metadata` | Map (optional) | Channel-specific routing data (Slack channel+thread, CLI request ID). |
| `created_at` | String (ISO 8601) | Task creation timestamp. |
| `updated_at` | String (ISO 8601) | Last state transition timestamp. |
| `started_at` | String (optional) | When the session was started (entered RUNNING). |
| `completed_at` | String (optional) | When the task reached a terminal state. |
| `cost_usd` | Number (optional) | Agent cost from the SDK result. |
| `duration_s` | Number (optional) | Total task duration in seconds. |
| `build_passed` | Boolean (optional) | Post-agent build verification result. |
| `max_turns` | Number (optional) | Maximum agent turns for this task. Set during task creation — either the user-specified value (1–500) or the platform default (100). Included in the orchestrator payload and consumed by the agent SDK's `ClaudeAgentOptions(max_turns=...)`. |
| `max_budget_usd` | Number (optional) | Maximum cost budget in USD for this task. Set during task creation — either the user-specified value ($0.01–$100) or the per-repo Blueprint default. When reached, the agent stops regardless of remaining turns. If neither the task nor the Blueprint specifies a value, no budget limit is applied (turn limit and session timeout still apply). Included in the orchestrator payload and consumed by the agent SDK's `ClaudeAgentOptions(max_budget_usd=...)`. |
| `blueprint_config` | Map (optional) | Snapshot of the `RepoConfig` record at task creation time (or a reference to it). This ensures tasks are not affected by mid-flight config changes. The schema follows the `RepoConfig` interface defined in [REPO_ONBOARDING.md](/design/repo-onboarding#repoconfig-schema). Includes `compute_type`, `runtime_arn`, `model_id`, `max_turns`, `system_prompt_overrides`, `github_token_secret_arn`, `poll_interval_ms`, `custom_steps`, `step_sequence`, and `egress_allowlist`. The `max_turns` value from `blueprint_config` serves as the per-repo default; per-task `max_turns` (from the API request) takes higher priority. `max_budget_usd` follows the same 2-tier override pattern: per-task value takes priority over `blueprint_config.max_budget_usd`; if neither is specified, no budget limit is applied. |
| `prompt_version` | String | Hash or version identifier of the system prompt used for this task. Required for prompt versioning (Iteration 3b). Enables correlation between prompt changes and task outcomes in the evaluation pipeline. |
| `model_id` | String (optional) | Foundation model ID used for this task (e.g. `anthropic.claude-sonnet-4-20250514`). Defaults to the platform default; overridden by `blueprint_config.model_id` from onboarding. Stored for cost attribution and evaluation correlation. |
| `ttl` | Number (optional) | DynamoDB TTL epoch (seconds). Set when the task reaches a terminal state. DynamoDB automatically deletes the record after this timestamp. Configurable via `taskRetentionDays` (default 90 days). |

**Global Secondary Indexes:**

| GSI | Key schema | Purpose |
|---|---|---|
| `UserStatusIndex` | PK: `user_id`, SK: `status#created_at` | List tasks by user, filtered by status. Powers "my tasks" and queue processing. |
| `StatusIndex` | PK: `status`, SK: `created_at` | List tasks by status. Powers system-wide queue processing and monitoring dashboards. |
| `IdempotencyIndex` | PK: `idempotency_key` | Idempotency check during admission. Sparse index (only tasks with a key). |

### TaskEvents table

Append-only audit log. See [OBSERVABILITY.md](/design/observability) for the event list.

| Field | Type | Description |
|---|---|---|
| `task_id` (PK) | String | Task identifier. |
| `event_id` (SK) | String (ULID) | Unique, sortable event ID. |
| `event_type` | String | E.g. `task_created`, `admission_passed`, `preflight_failed`, `hydration_complete`, `session_started`, `session_ended`, `pr_created`, `task_completed`, `task_failed`, `task_cancelled`, `task_timed_out`. |
| `timestamp` | String (ISO 8601) | When the event occurred. |
| `metadata` | Map (optional) | Event-specific data (e.g. error message, PR URL, session ID). |
| `ttl` | Number | DynamoDB TTL epoch (seconds). Set at event creation time. DynamoDB automatically deletes the record after this timestamp. Configurable via `taskRetentionDays` (default 90 days). |

### UserConcurrency table

Atomic counters for per-user concurrency management.

| Field | Type | Description |
|---|---|---|
| `user_id` (PK) | String | User identifier. |
| `active_count` | Number | Number of currently running tasks for this user. |
| `updated_at` | String (ISO 8601) | Last update timestamp. |

Operations:
- **Increment:** `UpdateItem` with `SET active_count = active_count + 1` and `ConditionExpression: active_count < :max`.
- **Decrement:** `UpdateItem` with `SET active_count = active_count - 1` and `ConditionExpression: active_count > 0`.

### Session mapping

The session ID → task ID mapping is stored as a field on the Tasks table (`session_id`). No separate table is needed. To look up a task by session ID (e.g. when processing a session completion event), a GSI on `session_id` can be added if needed.

---

## Open questions

These are design decisions not yet resolved. Each is framed as a question with options and trade-offs.

### Q1: Session completion signaling — RESOLVED

**Question:** Given that `invoke_agent_runtime` blocks until the session ends (up to 8 hours), how does the durable orchestrator detect session completion without burning compute?

**Resolution:** This question is resolved by AgentCore's **asynchronous invocation model**. `invoke_agent_runtime` does **not** need to block for hours. The agent starts work in a background thread and returns immediately. The orchestrator uses `waitForCondition` to poll the session via re-invocation (sticky routing) at 30-second intervals. Each poll is a fast, non-blocking call. The orchestrator suspends between polls (no compute charges). See the session monitoring pattern in the Implementation options section.

The original options (a) wrapper Lambda/Fargate and (c) agent calls callback directly are no longer needed. The poll-based approach (originally option b) is the natural fit now that the invocation itself is non-blocking.

### Q2: Session status API availability — RESOLVED

**Question:** Does AgentCore provide a way to query session status (running, completed, failed) without blocking?

**Resolution:** Yes, via two mechanisms:

1. **Re-invocation on the same session (sticky routing).** Calling `invoke_agent_runtime` with the same `runtimeSessionId` routes to the same instance. The agent responds with its current status. This is the primary status mechanism.

2. **`/ping` health endpoint.** The agent reports `HealthyBusy` (processing) or `Healthy` (idle) via the `/ping` endpoint. AgentCore uses this for session lifecycle management (idle timeout). The orchestrator does not call `/ping` directly but benefits from it keeping the session alive.

No separate `GetRuntimeSessionStatus` API is needed — the re-invocation pattern provides equivalent functionality.

### Q3: Completion signal mechanism — RESOLVED

**Question:** How should the agent signal task completion to the orchestrator?

**Resolution:** The agent signals completion via the **re-invocation poll response**. When the orchestrator re-invokes on the same session, the agent returns `{ status: "completed", ... }` or `{ status: "failed", ... }`. This is the primary signal.

**Layered reliability:**

| Layer | Mechanism | Purpose |
|---|---|---|
| Primary | Re-invocation poll response | Agent returns status directly to the orchestrator's poll call. Fast, reliable, in-band. |
| Secondary | DynamoDB completion record | Agent writes a completion record (task_id, status, pr_url, error) to DynamoDB before exiting. The orchestrator checks this during finalization or if the poll detects session termination without a clean status response. |
| Fallback | GitHub state inspection | If both the poll and DynamoDB record are unavailable (agent crash before writing), the orchestrator falls back to GitHub-based result inference (branch exists? PR exists? commits?). |

**Recommendation:** Implement the primary (poll) and secondary (DynamoDB record) signals in Iteration 2. GitHub inspection remains the fallback as it is today.

### Q4: Queue priority

**Question:** Should the task queue support priority levels?

**Recommendation:** Start without priority (strict FIFO per user). Add priority if a concrete need arises.

### Q5: Token budget management — RESOLVED

**Question:** Should the orchestrator enforce a token budget during context hydration, or should the agent harness manage its own context window?

**Resolution:** Both. The orchestrator enforces a character-based token budget (~4 chars/token, default 100K tokens) during context hydration, truncating oldest issue comments first when the budget is exceeded. The agent harness handles its own context compaction during multi-turn conversations. See the Context hydration section for implementation details.

### Q6: Post-agent validation and retry cycles

**Question:** When a post-agent validation step fails (e.g. build fails), should the orchestrator restart the agent for a fix cycle?

| Option | Description | Trade-off |
|---|---|---|
| (a) No retry | Agent gets one shot. Failure reported in PR. | Simplest; cheapest. |
| (b) Orchestrator retry (up to N) | New session with failure context. | Adds cost and complexity; doubles compute for each retry. |
| (c) In-session retry | Agent harness includes a "verify and fix" loop via system prompt. | No orchestrator changes; relies on agent following instructions. |

**Recommendation:** Option (c) for MVP (the current system prompt already instructs the agent to run tests and fix errors). Option (b) for Iteration 3+ when deterministic validation is introduced.

### Q7: Orchestrator crash recovery

**Question:** What if a durable execution itself gets stuck or fails to resume?

**Recommendation:** Lambda Durable Functions handles most crash recovery via checkpoint/replay. As defense in depth, add a periodic Lambda scanner that checks for tasks stuck in non-terminal states beyond their expected duration (e.g. `RUNNING` for > 9 hours when the max session is 8 hours). The scanner can trigger finalization or mark tasks as `TIMED_OUT`. Accept the risk for Iteration 1 (no durable orchestrator).

### Q8: Branch name pre-generation

**Question:** Should the orchestrator pre-generate the branch name, or should the agent generate it inside the session?

**Current behavior:** The agent entrypoint generates the branch name from task ID and issue title.

**Recommendation:** Pre-generate in the orchestrator. The branch name follows a deterministic pattern (`bgagent/{task_id}/{slug}`) so it can be computed from task metadata. This enables the orchestrator to store the branch name in the task record before the session starts, simplifying result inference.

### Q9: DynamoDB single-table vs. multi-table

**Question:** Should Tasks, TaskEvents, and UserConcurrency share one DynamoDB table or use separate tables?

**Recommendation:** Start with separate tables (simpler, clearer access patterns). Consolidate later if the operational burden becomes an issue.

### Q10: Notification timing

**Question:** When should the orchestrator emit user notifications?

**Recommendation:** Notify on task accepted, task running, and terminal states (completed/failed/cancelled/timed_out) in Iteration 2. Add configurable per-user preferences in later iterations.
