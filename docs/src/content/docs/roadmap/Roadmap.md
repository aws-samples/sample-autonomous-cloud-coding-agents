---
title: Roadmap
---

# Roadmap

What's shipped and what's coming next.

## What's ready

### Core platform

- [x] **Autonomous agent execution** - Isolated MicroVM (AgentCore Runtime) per task with shell, filesystem, and git access
- [x] **CLI and REST API** - Submit, list, get, cancel, nudge, watch, trace, webhook management; view audit events; Cognito auth with token caching
- [x] **Durable orchestrator** - Lambda Durable Functions with checkpoint/resume; survives transient failures up to 9 hours
- [x] **Task state machine** - SUBMITTED → HYDRATING → RUNNING → COMPLETED / FAILED / CANCELLED / TIMED_OUT
- [x] **Concurrency control** - Per-user limits (default 3) with atomic admission and automated drift reconciliation
- [x] **Stranded task reconciler** - Scheduled Lambda detects tasks stuck in non-terminal states and drives them to failure with proper cleanup
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

### Interactive task UX

- [x] **Real-time watch** - `bgagent watch` streams progress events with adaptive polling (500 ms active; 1/2/5 s idle backoff), cold-start retry, clean exit on terminal state
- [x] **Mid-run steering (nudge)** - `bgagent nudge` sends guidance to a running agent; combined-turn acknowledgement (agent emits `nudge_acknowledged` before incorporating)
- [x] **Execution tracing** - `--trace` on submit raises preview cap to 4 KB and uploads full gzipped NDJSON trajectory to S3; `bgagent trace download` retrieves it
- [x] **Deterministic status snapshot** - `bgagent status` derives all fields from task record + recent events with no LLM in the loop
- [x] **Debug output** - `--verbose` flag emits full HTTP request/response on stderr for any CLI command

### Notification plane

- [x] **DDB Stream fanout** - FanOut Consumer Lambda on TaskEventsTable streams (ParallelizationFactor: 1 for per-task ordering) routes events to channel dispatchers
- [x] **GitHub edit-in-place** - Single status comment per task on the target PR, edited in place as progress events fire (phase, milestone, cost, link)
- [x] **Routable agent milestones** - Named checkpoints (`pr_created`, `nudge_acknowledged`) unwrapped against allowlist for channel filter matching
- [ ] **Slack dispatcher** - Log-only stub; pending full Slack Block Kit integration
- [ ] **Email dispatcher** - Log-only stub; pending SES integration

### Observability

- [x] **OpenTelemetry** - Custom spans for pipeline phases with CloudWatch querying
- [x] **Operator dashboard** - Task success rate, cost, duration, build/lint pass rates, AgentCore metrics
- [x] **Alarms** - Stuck tasks, orchestration failures, counter drift, crash rate, guardrail failures
- [x] **Audit trail** - TaskEvents table with chronological event log per task
- [x] **Runtime error classifier** - Pattern-matching classifier that categorizes task errors (auth/network/concurrency/compute/agent/guardrail/config/timeout/unknown) with human-readable titles, descriptions, remedies, and retryability flags. Computed at API response time; powers structured CLI error display and CloudWatch alarm routing
- [x] **Enhanced error classifiers** - Specific terminal-state classifiers (`error_max_turns`, `error_max_budget_usd`, `error_during_execution`) for precise CLI display and alarm routing

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
| **End-to-end task attribution** | Propagate `task_id`, `user_id`, and trace context consistently across orchestrator logs, agent OpenTelemetry, GitHub/API calls, and `TaskEvents` so every downstream action is attributable in incident response (aligns with Zero Trust agent-identity guidance). |
| **Emergency session containment** | Documented operator runbook and APIs: cancel task, terminate compute session, revoke short-lived credentials (assumed role, GitHub App token). Pairs with **Per-session IAM scoping**, **Per-repo GitHub credentials**, and **Behavioral circuit breaker** automated containment. |
| **Delegation chain propagation** | Embed a cryptographically signed actor chain (`user_id → orchestrator → agent`) in credentials issued to the agent. Downstream services (GitHub commits, API calls) can trace any action back to the originating human principal. Enables per-action accountability, compliance audit, and fine-grained authorization decisions based on the full delegation lineage rather than only the immediate caller. |
| **Workload-anchored credential binding** | Bind agent credentials to the specific MicroVM execution environment via attestation (e.g., instance identity document or platform-level workload identity). Credentials become non-transferable — unusable if exfiltrated from the VM. Complements per-session IAM scoping (which limits scope) with environment binding (which limits where credentials can be exercised). |
| **Layered credential derivation** | Extend per-session scoping with a derivation model where each layer in the execution stack receives progressively narrower credentials. The orchestrator holds a task-scoped token; the agent runtime derives a further-restricted token limited to specific tools and repositories; tool invocations receive single-use or time-boxed tokens for each external call. Limits blast radius at every boundary, not just at task creation. |

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
| **Behavioral circuit breaker** | Per-session limits on tool-call rate, cumulative cost, consecutive failures, and file churn; pause or terminate when thresholds are exceeded. On trip: terminate session, revoke short-lived credentials where applicable, emit a `containment` audit event. Configurable per repo via Blueprint (design: `SECURITY.md`, `REPO_ONBOARDING.md`). Prefer hard containment over friction-only limits (rate/turn caps alone). |
| **Tool capability tiers** | Opt-in **extended** tool profile per repo: MCP servers, plugins, and additional Gateway-mediated tools beyond the default minimal surface (`COMPUTE.md`). Enforced at Gateway and policy layers. |
| **MCP supply-chain controls** | For extended-tier repos: pin or self-host MCP servers; keep `.mcp.json` in version control; verify tool descriptors before enablement; no dynamic tool discovery in production blueprints. Mitigates tool poisoning and rug-pull risks (`SECURITY.md`, `COMPUTE.md`). |
| **Untrusted hydration content boundaries** | Delimit external content in assembled prompts (issue/PR bodies, fetched URLs, review comments) so the model treats it as untrusted context (spotlighting-style framing). Complements Bedrock Guardrails at hydration time (`context-hydration.ts`). |

### Channels and integrations

| Capability | Description |
|------------|-------------|
| ~~**Task attachments (multimodal)**~~ | **Implemented.** End-to-end support for the `attachments` array: inline base64 (≤ 500 KB), presigned upload (up to 10 MB), and URL fetch with SSRF protection. Images (PNG, JPEG, GIF, WebP) and text files (TXT, CSV, MD, JSON, PDF, LOG) pass through Bedrock Guardrail screening, magic bytes validation, EXIF stripping, and re-encoding. CLI `--attachment` flag, Slack file uploads, and Linear image extraction all feed the same schema. See [ATTACHMENTS.md](/architecture/attachments). |
| **Additional git providers** | GitLab (and optionally Bitbucket). Same workflow, provider-specific API adapters. |
| **Slack integration** | Submit tasks, check status, receive notifications from Slack. Block Kit rendering. |
| **Control panel** | Web UI: task list, task detail with logs/traces, cancel, metrics dashboards, cost attribution. |
| **Slack notification dispatcher** | Full Slack Block Kit rendering for the existing DDB-Stream fanout pipeline. Stub exists today (logs only). |
| **Email notification dispatcher** | SES-based email notifications via the existing fanout pipeline. Stub exists today (logs only). |
| **Per-user notification preferences** | DynamoDB (or equivalent) store for preferred channels, per-channel config, and event filters (`INPUT_GATEWAY.md`). |
| **Browser extension channel** | Lightweight extension to open tasks from GitHub issue/PR pages using existing webhook or OAuth-issued JWT; same internal message contract as other channels. |

### Compute and performance

| Capability | Description |
|------------|-------------|
| **Adaptive model router** | Per-turn model selection by complexity. Cheaper models for reads, Opus for complex reasoning. ~30-40% cost reduction. |
| **Alternative compute** | ECS/Fargate or EKS via ComputeStrategy interface. For workloads exceeding AgentCore's 2 GB image limit or requiring GPU. |
| **Environment pre-warming** | Pre-build container layers per repo. Snapshot-on-schedule (rebuild on push). Cold start from minutes to seconds. |
| **S3-backed SDK session store (portable transcripts)** | Plumb the Claude Agent SDK `SessionStore` to S3 (dedicated bucket or prefix) with eager flush, IAM-scoped access, conditional part creates, checksums, adaptive retries, and structured logging. Emit metrics or alarms on transcript mirror failures; own graceful shutdown (`disconnect` on SIGTERM/cancel) so in-flight frames can flush. Persist `task_id` ↔ Claude session UUID (from the first `ResultMessage`) for resume on another worker; keep agent `cwd` stable so SDK-derived `project_key` paths stay predictable. Plan compaction when part count threatens resume latency; optional S3 Express One Zone when the fleet is single-AZ. Complements checked **Persistent session storage** (FUSE caches on `/mnt/workspace`) and end-of-task **trace** upload to `traces/...jsonl.gz`. |

### Onboarding and repo lifecycle

| Capability | Description |
|------------|-------------|
| **Automated re-onboarding** | Event-driven refresh of blueprint-related artifacts when the default branch changes materially (GitHub webhook); optional EventBridge schedule for periodic drift checks. Distinct from **Scheduled triggers** (task creation). |
| **Dynamic onboarding artifacts** | When repo hygiene is weak, generate attachments for the agent context: codebase summaries, dependency graphs, suggested rules from layout (`REPO_ONBOARDING.md`). |

### Documentation and specifications

| Capability | Description |
|------------|-------------|
| **Exposed project specifications** | Publish and surface human- and machine-readable specs—for example OpenAPI or JSON Schema generated from the REST API, explicit extension-point and integration indexes, and stable links into architecture contracts—so operators and contributors can modify, extend, or fork the solution without reverse-engineering the codebase. Complements the design-doc links at the end of this page. |

### Cost governance

| Capability | Description |
|------------|-------------|
| **Org and team budgets** | Per-user and per-team monthly token or USD budgets with alerting (e.g. 80%) and optional hard stop at 100%. |
| **Complexity-aware model router** | Route each request to the most appropriate model based on task complexity (simple reads/edits to cheaper models, deeper reasoning to stronger models) while honoring budget and policy constraints. |

### Observability and safe deploy

| Capability | Description |
|------------|-------------|
| **Admission backlog observability** | Metric and alarm when `SUBMITTED` task depth exceeds an operator threshold (capacity and admission health). |
| **Admission queue with deferred pickup** | When admission is at capacity, persist tasks in a durable queue instead of failing them. Automatically re-attempt admission and continue processing in FIFO order (with optional priority lanes) as concurrency becomes available. Preserve cancel/idempotency semantics and expose queue position/ETA in task status. |
| **Safe orchestrator deploys** | Pre-deploy checks for active tasks (drain or warn); blue-green or canary Lambda deploy for the durable orchestrator with rollback on error regressions (`OBSERVABILITY.md`). |
| **Unified cross-plane trace correlation** | Single trace root per task across orchestrator, MicroVM OpenTelemetry, `TaskEvents`, and S3 trace artifacts. Gap-fill beyond existing AgentCore session baggage (`OBSERVABILITY.md`). |
| **Immutable audit export** | Append-only export of `TaskEvents` and policy decisions to S3 (e.g. Object Lock). Complements **Centralized policy framework** `PolicyDecisionEvent` schema for compliance and tamper-evident investigation. |
| **Security operations metrics (dwell time and coverage)** | CloudWatch metrics and dashboard panels: time from anomaly (circuit breaker, guardrail spike, policy deny burst) to operator awareness; fraction of security/ops alarms investigated. Targets shortened exploit windows. |
| **Automated alert first-pass triage** | On selected security/ops alarms, a Lambda produces a structured disposition from logs, traces, and `TaskEvents` before human review. Distinct from **LLM-assisted trace analysis** (post-mortem on failed tasks). |

### Scale and collaboration

| Capability | Description |
|------------|-------------|
| **Multi-user and teams** | Team visibility, shared approval queues, team concurrency/cost budgets, memory isolation. |
| **Agent swarm** | Planner-worker architecture for complex multi-file tasks. DAG of subtasks, merge orchestrator, one consolidated PR. Workers receive a strict subset of planner credentials; orchestrator-issued subtask intent; per-worker OpenTelemetry spans under a shared trace root (prevents confused-deputy / unscoped privilege inheritance). |
| **Cedar-driven HITL approval gates** | Three-outcome model (allow/hard-deny/soft-deny) for tool-call governance with Cedar policy engine. |
| **Multi-user nudge** | Extend `bgagent nudge` to support multiple users injecting context into the same running task. Per-nudge commit attribution. (Single-user nudge shipped.) |
| **Scheduled triggers** | Cron-based task creation via EventBridge (dependency updates, nightly flaky test checks). |

### Platform maturity

| Capability | Description |
|------------|-------------|
| **Unified liveness decision model (follow-up design ticket)** | Normalize task health evaluation across compute backends so heartbeat, compute session status, and DynamoDB state are handled through a single typed decision path. Define explicit backend capabilities (for example, heartbeat support), deterministic precedence rules for terminal outcomes, and regression tests that prevent cross-runtime false failures like ECS heartbeat mismatch. |
| **Pure decision function orchestrator refactor** | Extract orchestrator decision logic into pure functions that take a frozen snapshot and return a typed action. Side-effectful execution applies actions with CAS (compare-and-swap) guards on DynamoDB `updated_at` to prevent stale writes. Makes the orchestrator exhaustively unit-testable without mocking I/O, eliminates competing-worker race conditions, and is a prerequisite for the autonomous feedback loop. |
| **Blueprint custom steps and step sequences** | Lambda-backed `pre-agent` / `post-agent` steps and optional `step_sequence` overrides with CDK synth + runtime validation and `INVALID_STEP_SEQUENCE` on misconfiguration (`REPO_ONBOARDING.md`, `ORCHESTRATOR.md`). |
| **Blueprint RepoConfig parity** | Extend the Blueprint construct to persist per-repo default `max_budget_usd` and `memory_token_budget` in DynamoDB (orchestrator already merges `max_budget_usd` when present; hydration uses a fixed memory token cap today). |
| **Orchestrator DLQ** | Dead-letter path for task orchestration after retry exhaustion so operators can inspect and replay failed durable executions (`ORCHESTRATOR.md`). |
| **Stuck-task reconciliation (operator notify/resume)** | The scheduled stranded-task reconciler shipped (detects and fails stuck tasks). Further: operator notification before forced failure, manual resume option (`ORCHESTRATOR.md`). |
| **EventBridge / SNS integration** | Publish task lifecycle events to EventBridge or SNS for external consumers beyond the built-in DDB-Stream fanout (which already powers GitHub edit-in-place, Slack, and email dispatchers). |
| **CDK constructs library** | Publish reusable constructs to Construct Hub with semver versioning. |
| **Centralized policy framework** | Unified Cedar-based framework with `PolicyDecisionEvent` audit schema. Three enforcement modes with observe-before-enforce rollout. |
| **Zero Trust control review ("impossible vs tedious")** | Document a standing design test in `SECURITY.md`: prefer controls that remove capability over friction-only mitigations (rate limits, observe-only DNS). Use when prioritizing DNS enforcement, credential scoping, and containment vs. throttling. |
| **Formal verification** | TLA+ specification of task state machine, concurrency, cancellation races, reconciler interleavings. |

### Agent asset registry

| Capability | Description |
|------------|-------------|
| **Central asset registry** | A versioned, platform-managed registry from which agents resolve assets at runtime instead of requiring them to be vendored in source. Assets include skills, plugins, MCP server definitions, capabilities (Change Manifest verification strategies, knowledge tool configurations), custom prompt fragments, and Cedar policy modules. The registry is the single source of truth the Change Manifest's L1 (`tool_needed` validation) and L5 (knowledge resolution) evaluate against — replacing the implicit "known tool registry" currently assumed in the design. Backed by DynamoDB (metadata + version index) with S3 (artifact storage). |
| **Asset versioning and immutability** | Every asset version is immutable once published. Blueprints pin asset versions explicitly (no floating `latest` in production). Version resolution follows semver constraints. Rollback is a re-pin to a prior version, not mutation. Enables reproducible agent executions and safe rollout of new tool versions without affecting running tasks. |
| **Asset lifecycle management** | Publish, deprecate, and retire flow for registry assets. Deprecation emits warnings in task telemetry when a pinned asset version is nearing end-of-life. Retirement blocks new task starts that reference the asset. Operator API for bulk migration (re-pin all blueprints from v1 to v2). |
| **Capability descriptors** | Structured metadata per registry asset declaring what the asset provides (tool surface, permissions required, resource limits, Cedar actions it introduces) and what it requires (runtime dependencies, network egress domains, minimum compute profile). The agent runtime uses descriptors to configure the execution environment dynamically — enabling MCP servers, injecting context, and adjusting sandbox permissions based on resolved capabilities rather than static blueprint lists. |
| **Blueprint registry references** | Extend the Blueprint construct so `knowledge_tools`, `mcp_servers`, tool profiles, and capability configurations reference registry asset identifiers and version constraints instead of inline definitions. At task start the orchestrator resolves pinned versions from the registry, fetches artifacts, and provisions the agent environment. Decouples asset authoring from infrastructure deployment. |
| **Registry access control** | Cedar policies govern who can publish, deprecate, or pin assets. Scoped by asset type and namespace (e.g., org-private vs. platform-provided). Read access (resolution at task start) is unrestricted within the deployment; write access requires operator or publisher role. |

---

Design docs to keep in sync: [ARCHITECTURE.md](/architecture/architecture), [ORCHESTRATOR.md](/architecture/orchestrator), [API_CONTRACT.md](/architecture/api-contract), [INPUT_GATEWAY.md](/architecture/input-gateway), [REPO_ONBOARDING.md](/architecture/repo-onboarding), [MEMORY.md](/architecture/memory), [OBSERVABILITY.md](/architecture/observability), [COMPUTE.md](/architecture/compute), [SECURITY.md](/architecture/security), [EVALUATION.md](/architecture/evaluation).
