---
title: Roadmap
---

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
| **Per-repo GitHub credentials** | GitHub App per org/repo via AgentCore Token Vault. Auto-refresh for long sessions. Sets the pattern for GitLab, Jira, Slack integrations. |
| **Principal-to-repo authorization** | Map Cognito identities to allowed repository sets. Users can only trigger work on authorized repos. |

### Agent quality

| Capability | Description |
|------------|-------------|
| **Tiered validation pipeline** | Three post-agent tiers: tool validation (build/test/lint), code quality (DRY/SOLID/complexity), risk and blast radius analysis. |
| **PR risk classification** | Rule-based risk classifier at submission. Drives model selection, budget defaults, approval requirements. |
| **Review feedback memory loop** | Capture PR review comments via webhook, extract rules via LLM, persist as searchable memory. |
| **PR outcome tracking** | Track merge/reject via GitHub webhooks. Positive/negative signals feed evaluation and memory. |
| **Evaluation pipeline** | Failure categorization, memory effectiveness metrics (merge rate, revision cycles, CI pass rate). |

### Memory security

| Capability | Description |
|------------|-------------|
| **Trust-aware retrieval** | Weight memories by freshness, source type, pattern consistency. |
| **Temporal decay** | Configurable per-entry TTL with faster decay for unverified content. |
| **Anomaly detection** | CloudWatch metrics on write patterns; alarms for burst writes or suspicious content. |
| **Quarantine and rollback** | Operator API for isolating suspicious entries and restoring pre-task snapshots. |
| **Write-ahead validation** | Route proposed memory writes through a guardian model. |

### Channels and integrations

| Capability | Description |
|------------|-------------|
| **Multi-modal input** | Accept images in task payload (screenshots, UI mockups, design specs). |
| **Additional git providers** | GitLab (and optionally Bitbucket). Same workflow, provider-specific API adapters. |
| **Slack integration** | Submit tasks, check status, receive notifications from Slack. Block Kit rendering. |
| **Control panel** | Web UI: task list, task detail with logs/traces, cancel, metrics dashboards, cost attribution. |
| **Real-time event streaming** | WebSocket API for live task updates. Replaces polling for CLI, control panel, Slack. |

### Compute and performance

| Capability | Description |
|------------|-------------|
| **Adaptive model router** | Per-turn model selection by complexity. Cheaper models for reads, Opus for complex reasoning. ~30-40% cost reduction. |
| **Alternative compute** | ECS/Fargate or EKS via ComputeStrategy interface. For workloads exceeding AgentCore's 2 GB image limit or requiring GPU. |
| **Environment pre-warming** | Pre-build container layers per repo. Snapshot-on-schedule (rebuild on push). Cold start from minutes to seconds. |

### Scale and collaboration

| Capability | Description |
|------------|-------------|
| **Multi-user and teams** | Team visibility, shared approval queues, team concurrency/cost budgets, memory isolation. |
| **Agent swarm** | Planner-worker architecture for complex multi-file tasks. DAG of subtasks, merge orchestrator, one consolidated PR. |
| **Iterative feedback** | Follow-up instructions to running tasks. Multiple users inject context. Per-prompt commit attribution. |
| **Scheduled triggers** | Cron-based task creation via EventBridge (dependency updates, nightly flaky test checks). |

### Platform maturity

| Capability | Description |
|------------|-------------|
| **CDK constructs library** | Publish reusable constructs to Construct Hub with semver versioning. |
| **Centralized policy framework** | Unified Cedar-based framework with `PolicyDecisionEvent` audit schema. Three enforcement modes with observe-before-enforce rollout. |
| **Formal verification** | TLA+ specification of task state machine, concurrency, cancellation races, reconciler interleavings. |

---

Design docs to keep in sync: [ARCHITECTURE.md](/architecture/architecture), [ORCHESTRATOR.md](/architecture/orchestrator), [API_CONTRACT.md](/architecture/api-contract), [INPUT_GATEWAY.md](/architecture/input-gateway), [REPO_ONBOARDING.md](/architecture/repo-onboarding), [MEMORY.md](/architecture/memory), [OBSERVABILITY.md](/architecture/observability), [COMPUTE.md](/architecture/compute), [SECURITY.md](/architecture/security), [EVALUATION.md](/architecture/evaluation).
