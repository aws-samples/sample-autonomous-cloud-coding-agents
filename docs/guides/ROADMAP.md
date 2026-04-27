# Roadmap

What's shipped and what's coming next.

## What's ready

### Core platform

- [x] **Autonomous agent execution** - Isolated MicroVM (AgentCore Runtime) per task with shell, filesystem, and git access
- [x] **CLI and REST API** - Submit, list, get, cancel tasks; view audit events; Cognito auth with token caching
- [x] **Durable orchestrator** - Lambda Durable Functions with checkpoint/resume; survives transient failures up to 9 hours
- [x] **Task state machine** - SUBMITTED → HYDRATING → RUNNING → COMPLETED / FAILED / CANCELLED / TIMED_OUT
- [x] **Concurrency control** - Per-user limits (default 3) with atomic admission and automated drift reconciliation
- [x] **Idempotency** - `Idempotency-Key` header on POST requests (24-hour TTL)

### Task types

- [x] **`new_task`** - Branch, implement, build/test, open PR
- [x] **`pr_iteration`** - Check out PR branch, read review feedback, address it, push
- [x] **`pr_review`** - Read-only structured code review via GitHub Reviews API (no Write/Edit tools)

### Onboarding and customization

- [x] **Blueprint construct** - Per-repo CDK configuration (model, turns, budget, prompt overrides, egress, GitHub token)
- [x] **Repo-level project config** - Agent loads `CLAUDE.md`, `.claude/rules/`, `.claude/settings.json`, `.mcp.json`
- [x] **Per-repo overrides** - Model ID, max turns, max budget, system prompt overrides, poll interval, dedicated token

### Security

- [x] **Network isolation** - VPC with private subnets, HTTPS-only egress, VPC endpoints for AWS services
- [x] **DNS Firewall** - Domain allowlist with observation mode and path to enforcement
- [x] **Input guardrails** - Bedrock Guardrails screen task descriptions and PR/issue content (fail-closed)
- [x] **Output screening** - Regex-based secret/PII scanner with PostToolUse hook redaction
- [x] **Content sanitization** - HTML stripping, injection pattern neutralization, control character removal
- [x] **Cedar policy engine** - Tool-call governance with fail-closed default and per-repo custom policies
- [x] **WAF** - Managed rule groups + rate-based rule (1,000 req/5 min/IP)
- [x] **Pre-flight checks** - GitHub API reachability, repo access, token permissions (fail-closed)
- [x] **Model invocation logging** - Full prompt/response audit trail (90-day retention)

### Memory and learning

- [x] **AgentCore Memory** - Semantic (repo knowledge) and episodic (task episodes) strategies with namespace templates
- [x] **Content integrity** - SHA-256 hashing, source provenance tracking, schema v3
- [x] **Fail-open design** - Memory never blocks task execution; 2,000-token budget

### Context hydration

- [x] **Rich prompt assembly** - Task description + GitHub issue/PR content + memory context (~100K token budget)
- [x] **Token budget management** - Oldest comments trimmed first; title/body always preserved

### Webhooks

- [x] **HMAC-SHA256 webhooks** - External systems create tasks without Cognito credentials
- [x] **Webhook management** - Create, list, revoke with soft delete (30-day TTL)

### Cost and limits

- [x] **Turn caps** - Per-task max turns (1-500, default 100) with Blueprint defaults
- [x] **Cost budget** - Per-task max budget in USD ($0.01-$100)
- [x] **Data retention** - Automatic TTL-based cleanup (default 90 days)

### Observability

- [x] **OpenTelemetry** - Custom spans for pipeline phases with CloudWatch querying
- [x] **Operator dashboard** - Task success rate, cost, duration, build/lint pass rates, AgentCore metrics
- [x] **Alarms** - Stuck tasks, orchestration failures, counter drift, crash rate, guardrail failures
- [x] **Audit trail** - TaskEvents table with chronological event log per task
- [x] **Runtime error classifier** - Pattern-matching classifier that categorizes task errors (auth/network/concurrency/compute/agent/guardrail/config/timeout/unknown) with human-readable titles, descriptions, remedies, and retryability flags. Computed at API response time; powers structured CLI error display and CloudWatch alarm routing

### Agent harness

- [x] **Default branch detection** - Dynamic detection via `gh repo view`
- [x] **Uncommitted work safety net** - Auto-commit before PR creation
- [x] **Build/lint verification** - Pre- and post-agent baselines in PR body
- [x] **Prompt versioning** - SHA-256 hash for A/B comparison
- [x] **Per-commit attribution** - `Task-Id` and `Prompt-Version` git trailers
- [x] **Persistent session storage** - `/mnt/workspace` for npm and config caches

### Docs and DX

- [x] **Quick start guide** - Zero to first PR in ~30 minutes
- [x] **Prompt guide** - Best practices, anti-patterns, examples
- [x] **Claude Code plugin** - Interactive skills for setup, deploy, submit, troubleshoot

---

## What's next

Planned capabilities, grouped by theme. Items are independent and may ship in any order.

### Credentials and authorization

| Capability | Description |
|------------|-------------|
| **Per-session IAM scoping** | Generate short-lived, scoped credentials per task via `sts:AssumeRole` with session tags (`user_id`, `repo`, `task_id`). DynamoDB leading-key conditions restrict each session to its own partition. Bedrock model access scoped to an explicit ARN allowlist instead of `*`. Eliminates cross-tenant blast radius from a compromised agent session. |
| **Per-repo GitHub credentials** | GitHub App per org/repo via AgentCore Token Vault. Auto-refresh for long sessions. Sets the pattern for GitLab, Jira, Slack integrations. |
| **Principal-to-repo authorization** | Map Cognito identities to allowed repository sets. Users can only trigger work on authorized repos. |

### Agent quality

| Capability | Description |
|------------|-------------|
| **Autonomous feedback loop** | Extend the orchestrator state machine beyond `PR_OPENED` with a PR watcher phase. Auto-resume the agent when CI fails (inject failure logs), merge conflicts arise (rebase instructions), or reviewers request changes (inline comments). Continue the loop until the PR is merged or a human cancels. Optionally auto-merge when CI passes and review is approved. Transforms ABCA from "open PR" to "merge PR". |
| **Tiered validation pipeline** | Three post-agent tiers: tool validation (build/test/lint), code quality (DRY/SOLID/complexity), risk and blast radius analysis. |
| **In-pipeline build/lint fix-up loop** | Today the agent path is linear (clone → code → build → lint → PR); a post-change **verify_build** / **verify_lint** failure fails the task. Instead, loop back into the agent with the failure output as extra context, up to a **configurable retry count**, then fail only if fixes are exhausted—while still respecting the existing **max_turns** budget. Likely implementable in **`pipeline.py`** (after `run_agent()`, on verification failure re-invoke the agent) **without orchestrator changes**; distinct from the **Autonomous feedback loop** (PR/CI after the PR exists). |
| **In-pipeline pre-PR self-review** | Post-hooks already run **build** / **lint**, but the LLM is not prompted to **self-review** its own diff before the PR. Add an optional in-pipeline step: surface the change set (diff), have the model **critique** it (bugs, style, edge cases, test gaps), then **iterate** on fixes—within the same **max_turns** / budget constraints. Aims to improve first-pass PR quality before human or CI review; implementable alongside other **`pipeline.py`** phases. |
| **PR risk classification** | Rule-based risk classifier at submission. Drives model selection, budget defaults, approval requirements. |
| **PR scope creep check (`pr_review`)** | Add an advisory-first scope analysis in `pr_review` that compares declared intent (task description / issue / PR narrative) to the actual diff and touched areas. Return structured output with `scope_rating` (`within_scope`/`mild_expansion`/`significant_expansion`/`likely_scope_creep`), confidence, and rationale (files, API/schema/config changes, unrelated dependency churn). Start as non-blocking reviewer guidance; optional policy gates can be enabled later for high-risk repos. |
| **Review feedback memory loop** | Capture PR review comments via webhook, extract rules via LLM, persist as searchable memory. |
| **PR outcome tracking** | Track merge/reject via GitHub webhooks. Positive/negative signals feed evaluation and memory. |
| **Evaluation pipeline** | Failure categorization, memory effectiveness metrics (merge rate, revision cycles, CI pass rate). |
| **A/B prompt experiments** | Assign prompt variants per task or cohort; compare merge rate, failure rate, and token usage with statistical guardrails. |
| **LLM-assisted trace analysis** | Automated deep dive on failed trajectories (logs + spans) to surface recurring reasoning and tool-use failure modes. |
| **Validation and risk analytics** | Dashboards for PR risk labels, validation outcomes, and trends by repo, user, and `prompt_version`; eventually feed learned memory rules into Tier 2 when the tiered pipeline ships. |

### Memory security

| Capability | Description |
|------------|-------------|
| **Trust-aware retrieval** | Weight memories by freshness, source type, pattern consistency. |
| **Temporal decay** | Configurable per-entry TTL with faster decay for unverified content. |
| **Anomaly detection** | CloudWatch metrics on write patterns; alarms for burst writes or suspicious content. |
| **Quarantine and rollback** | Operator API for isolating suspicious entries and restoring pre-task snapshots. |
| **Write-ahead validation** | Route proposed memory writes through a guardian model. |
| **Review feedback quorum** | Promote review-derived rules to persistent memory only after corroboration (e.g. pattern seen across trusted reviewers and PRs), reducing single-comment poisoning. Complements **Review feedback memory loop**. |
| **Memory backup to S3** | Scheduled export of AgentCore Memory namespaces to versioned S3 for disaster recovery and pre-poisoning restore (see design: `SECURITY.md`). |
| **Memory extraction replay** | Operator API (e.g. `start_memory_extraction_job`) to re-run failed PR-review extraction after webhook or Lambda errors. |
| **Structured knowledge graph (tier 4)** | Optional long-term direction if semantic + episodic memory proves insufficient for repo-specific query patterns. |

### Security (execution guardrails)

| Capability | Description |
|------------|-------------|
| **Behavioral circuit breaker** | Per-session limits on tool-call rate, cumulative cost, consecutive failures, and file churn; pause or terminate when thresholds are exceeded. Configurable per repo via Blueprint (design: `SECURITY.md`, `REPO_ONBOARDING.md`). |
| **Tool capability tiers** | Opt-in **extended** tool profile per repo: MCP servers, plugins, and additional Gateway-mediated tools beyond the default minimal surface (`COMPUTE.md`). Enforced at Gateway and policy layers. |

### Channels and integrations

| Capability | Description |
|------------|-------------|
| **Multi-modal input** | Accept images in task payload (screenshots, UI mockups, design specs). |
| **Additional git providers** | GitLab (and optionally Bitbucket). Same workflow, provider-specific API adapters. |
| **Slack integration** | Submit tasks, check status, receive notifications from Slack. Block Kit rendering. |
| **Control panel** | Web UI: task list, task detail with logs/traces, cancel, metrics dashboards, cost attribution. |
| **Real-time event streaming** | WebSocket API for live task updates. Replaces polling for CLI, control panel, Slack. |
| **Outbound notification pipeline** | Canonical internal notification schema emitted on task lifecycle events; channel adapters (Slack, email, CLI) render and deliver. Complements polling and WebSocket. |
| **Per-user notification preferences** | DynamoDB (or equivalent) store for preferred channels, per-channel config, and event filters (`INPUT_GATEWAY.md`). |
| **Browser extension channel** | Lightweight extension to open tasks from GitHub issue/PR pages using existing webhook or OAuth-issued JWT; same internal message contract as other channels. |

### Compute and performance

| Capability | Description |
|------------|-------------|
| **Adaptive model router** | Per-turn model selection by complexity. Cheaper models for reads, Opus for complex reasoning. ~30-40% cost reduction. |
| **Alternative compute** | ECS/Fargate or EKS via ComputeStrategy interface. For workloads exceeding AgentCore's 2 GB image limit or requiring GPU. |
| **Environment pre-warming** | Pre-build container layers per repo. Snapshot-on-schedule (rebuild on push). Cold start from minutes to seconds. |

### Onboarding and repo lifecycle

| Capability | Description |
|------------|-------------|
| **Automated re-onboarding** | Event-driven refresh of blueprint-related artifacts when the default branch changes materially (GitHub webhook); optional EventBridge schedule for periodic drift checks. Distinct from **Scheduled triggers** (task creation). |
| **Dynamic onboarding artifacts** | When repo hygiene is weak, generate attachments for the agent context: codebase summaries, dependency graphs, suggested rules from layout (`REPO_ONBOARDING.md`). |

### Cost governance

| Capability | Description |
|------------|-------------|
| **Org and team budgets** | Per-user and per-team monthly token or USD budgets with alerting (e.g. 80%) and optional hard stop at 100%. |
| **Automated model downgrade** | When approaching budget limits, shift to a cheaper default model for new work (e.g. Sonnet → Haiku) per policy. |

### Observability and safe deploy

| Capability | Description |
|------------|-------------|
| **Admission backlog observability** | Metric and alarm when `SUBMITTED` task depth exceeds an operator threshold (capacity and admission health). |
| **Safe orchestrator deploys** | Pre-deploy checks for active tasks (drain or warn); blue-green or canary Lambda deploy for the durable orchestrator with rollback on error regressions (`OBSERVABILITY.md`). |

### Scale and collaboration

| Capability | Description |
|------------|-------------|
| **Multi-user and teams** | Team visibility, shared approval queues, team concurrency/cost budgets, memory isolation. |
| **Agent swarm** | Planner-worker architecture for complex multi-file tasks. DAG of subtasks, merge orchestrator, one consolidated PR. |
| **Configurable human-in-the-loop (operator gate)** | Blueprint- or task-level workflow with **multiple gates per run** (for example: draft plan → operator review → implement → operator review). **Each gate is configured** as **human-review** (pause until the operator responds) or **auto** (continue through that checkpoint without blocking). Mix gates in one run—for example plan review enforced, implementation review auto. Resume, timeout, and cancel stay well-defined at every human-review wait. Complements **Iterative feedback** (soft inject without a hard pause). |
| **Iterative feedback** | Follow-up instructions to running tasks. Multiple users inject context. Per-prompt commit attribution. |
| **Scheduled triggers** | Cron-based task creation via EventBridge (dependency updates, nightly flaky test checks). |

### Platform maturity

| Capability | Description |
|------------|-------------|
| **Unified liveness decision model (follow-up design ticket)** | Normalize task health evaluation across compute backends so heartbeat, compute session status, and DynamoDB state are handled through a single typed decision path. Define explicit backend capabilities (for example, heartbeat support), deterministic precedence rules for terminal outcomes, and regression tests that prevent cross-runtime false failures like ECS heartbeat mismatch. |
| **Pure decision function orchestrator refactor** | Extract orchestrator decision logic into pure functions that take a frozen snapshot and return a typed action. Side-effectful execution applies actions with CAS (compare-and-swap) guards on DynamoDB `updated_at` to prevent stale writes. Makes the orchestrator exhaustively unit-testable without mocking I/O, eliminates competing-worker race conditions, and is a prerequisite for the autonomous feedback loop. |
| **Blueprint custom steps and step sequences** | Lambda-backed `pre-agent` / `post-agent` steps and optional `step_sequence` overrides with CDK synth + runtime validation and `INVALID_STEP_SEQUENCE` on misconfiguration (`REPO_ONBOARDING.md`, `ORCHESTRATOR.md`). |
| **Blueprint RepoConfig parity** | Extend the Blueprint construct to persist per-repo default `max_budget_usd` and `memory_token_budget` in DynamoDB (orchestrator already merges `max_budget_usd` when present; hydration uses a fixed memory token cap today). |
| **Orchestrator DLQ** | Dead-letter path for task orchestration after retry exhaustion so operators can inspect and replay failed durable executions (`ORCHESTRATOR.md`). |
| **Automated stuck-task reconciliation** | Scheduled job beyond passive alarms: detect tasks stuck in non-terminal states longer than policy allows and drive explicit resume, fail, or notify (`ORCHESTRATOR.md`). |
| **Task lifecycle push notifications** | On terminal transitions, publish events (e.g. EventBridge/SNS) for email, chat, or **Per-user notification preferences** without requiring clients to poll. |
| **CDK constructs library** | Publish reusable constructs to Construct Hub with semver versioning. |
| **Centralized policy framework** | Unified Cedar-based framework with `PolicyDecisionEvent` audit schema. Three enforcement modes with observe-before-enforce rollout. |
| **Formal verification** | TLA+ specification of task state machine, concurrency, cancellation races, reconciler interleavings. |

---

Design docs to keep in sync: [ARCHITECTURE.md](../design/ARCHITECTURE.md), [ORCHESTRATOR.md](../design/ORCHESTRATOR.md), [API_CONTRACT.md](../design/API_CONTRACT.md), [INPUT_GATEWAY.md](../design/INPUT_GATEWAY.md), [REPO_ONBOARDING.md](../design/REPO_ONBOARDING.md), [MEMORY.md](../design/MEMORY.md), [OBSERVABILITY.md](../design/OBSERVABILITY.md), [COMPUTE.md](../design/COMPUTE.md), [SECURITY.md](../design/SECURITY.md), [EVALUATION.md](../design/EVALUATION.md).
