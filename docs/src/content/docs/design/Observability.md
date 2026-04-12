---
title: Observability
---

# Observability

Observability is a design principle for this platform: **it should be easy to see everything that is going on** — task lifecycle, agent reasoning, tool use, and outcomes — so the system can be monitored, debugged, and improved over time. For a system where agents run for hours and burn tokens, observability is load-bearing infrastructure.

This document summarizes what the plans call for in terms of visibility, metrics, dashboards, and alarms.

## Implementation status

The agent is instrumented with **AWS Distro for OpenTelemetry (ADOT)** via `aws-opentelemetry-distro`. ADOT auto-instrumentation is activated by wrapping the agent process with `opentelemetry-instrument` in the Dockerfile. For AgentCore-hosted agents, the runtime pre-sets all OTEL environment variables — no additional configuration is needed.

### What's implemented

**AgentCore built-in metrics** (automatic, no code changes):
- Invocations, Session Count, Latency, System/User Errors, Throttles — in the `bedrock-agentcore` CloudWatch metric namespace.
- CPU/Memory usage (vCPU-hours, GB-hours) — per-session resource metrics.
- Application logs and usage logs — routed to CloudWatch Log Groups via CDK mixins.

**Custom spans** (via `observability.py` + instrumented `entrypoint.py`):
| Span name | What it covers |
|-----------|---------------|
| `task.pipeline` | Root span: end-to-end task execution |
| `task.context_hydration` | GitHub issue fetch + prompt assembly |
| `task.repo_setup` | Clone, branch, mise install, initial build (cold start) |
| `task.agent_execution` | Claude Agent SDK invocation |
| `task.post_hooks` | Safety-net commit, build verification, lint verification, PR creation |

**Span attributes** on the root span for CloudWatch querying:
`task.id`, `repo.url`, `issue.number`, `agent.model`, `task.status`, `agent.cost_usd`, `agent.turns`, `build.passed`, `lint.passed`, `pr.url`, `task.duration_s`.

**Span attributes** on the `task.post_hooks` span:
`safety_net.committed` (boolean — whether the uncommitted work safety net created a commit), `build.passed`, `lint.passed`, `pr.url`.

**Session correlation**: The AgentCore session ID is propagated via OTEL baggage so custom spans are linked to AgentCore's built-in session metrics in the CloudWatch GenAI Observability dashboard.

**Operator dashboard**: A CloudWatch Dashboard (`BackgroundAgent-Tasks`) is deployed via the `TaskDashboard` CDK construct (`src/constructs/task-dashboard.ts`). It provides Logs Insights widgets for: task success rate, task count by status, cost per task, turns per task, duration distribution, build pass rate, lint pass rate, and AgentCore built-in metrics (invocations, errors, latency).

**Claude Code SDK native telemetry** (via `CLAUDE_CODE_ENABLE_TELEMETRY=1`):

The Claude Code CLI has built-in OTel support that exports events with per-turn, per-tool granularity. The agent enables this telemetry (opt-in via `ENABLE_CLI_TELEMETRY=1`) and points the OTLP exporter at the ADOT sidecar or CloudWatch OTLP endpoint. This supplements the custom pipeline spans (which capture deterministic phases) with fine-grained data from inside the agent session.

Metrics export is disabled (`OTEL_METRICS_EXPORTER=none`) following AWS ADOT best practices — all AWS examples disable OTLP metrics export. CloudWatch does not ingest OTLP metrics through the ADOT sidecar or collector-less path. The SDK metrics listed below are documented for reference but are not exported; only events (OTLP logs) are exported.

*SDK-native metrics:*

| Metric | Description | Key attributes |
|--------|-------------|----------------|
| `claude_code.token.usage` | Tokens per API call | `type` (input/output/cacheRead/cacheCreation), `model` |
| `claude_code.cost.usage` | Cost per API call (USD) | `model` |
| `claude_code.lines_of_code.count` | Lines added/removed | `type` (added/removed) |
| `claude_code.commit.count` | Git commits created | — |
| `claude_code.pull_request.count` | PRs created | — |
| `claude_code.session.count` | Sessions started | — |
| `claude_code.code_edit_tool.decision` | Edit/Write/NotebookEdit accept/reject | `tool_name`, `decision`, `source`, `language` |
| `claude_code.active_time.total` | Active time (seconds) | `type` (user/cli) |

All metrics also carry standard attributes: `session.id`, `user.id`, `organization.id`, `user.account_uuid`, `app.version`. See the [Claude Code monitoring docs](https://code.claude.com/docs/en/monitoring-usage) for the full attribute reference.

*SDK-native events (via OTel logs exporter):*

| Event | Description | Key attributes |
|-------|-------------|----------------|
| `claude_code.tool_result` | Tool execution result | `tool_name`, `success`, `duration_ms`, `error`, `decision_type`, `decision_source`, `tool_result_size_bytes`, `tool_parameters` (JSON: bash commands, git commit IDs, MCP server/tool names) |
| `claude_code.api_request` | Per-API-call telemetry | `model`, `cost_usd`, `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `speed` |
| `claude_code.api_error` | API failures | `model`, `error`, `status_code`, `duration_ms`, `attempt`, `speed` |
| `claude_code.user_prompt` | Prompt submitted | `prompt_length` (content available via `OTEL_LOG_USER_PROMPTS=1`, not enabled) |
| `claude_code.tool_decision` | Tool permission decision | `tool_name`, `decision`, `source` |

All SDK metrics and events carry `task.id`, `repo.url`, and `agent.model` as resource attributes (percent-encoded) for CloudWatch filtering. Events include a `prompt.id` attribute (UUID v4) that correlates all events produced while processing a single user prompt — this enables tracing all API calls and tool executions triggered by one prompt. `prompt.id` is intentionally excluded from metrics to avoid unbounded cardinality.

*Configuration* (set in `run_agent()` after stripping Python auto-instrumentation vars, gated on `ENABLE_CLI_TELEMETRY=1`):

| Variable | Value | Purpose |
|----------|-------|---------|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` | Master switch for SDK telemetry |
| `OTEL_METRICS_EXPORTER` | `none` | Disabled — AWS ADOT examples do not export metrics via OTLP |
| `OTEL_TRACES_EXPORTER` | `none` | Disabled — agent's own custom spans provide trace coverage |
| `OTEL_LOGS_EXPORTER` | `otlp` | Export events via OTLP logs (the primary SDK telemetry) |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | (from ADOT, default: `http/protobuf`) | AWS-recommended OTLP protocol |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (from ADOT, default: `http://localhost:4318`) | ADOT sidecar or collector endpoint |
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS` | `x-aws-log-group={LOG_GROUP_NAME}` | Routes logs to the application log group (used by CloudWatch OTLP endpoint; may be ignored by sidecar) |
| `OTEL_LOG_TOOL_DETAILS` | `1` | Include MCP server/tool names and skill names in tool events |
| `OTEL_RESOURCE_ATTRIBUTES` | `task.id=...,repo.url=...,agent.model=...` | Task-level correlation (values percent-encoded) |

**Current status: disabled.** Testing confirmed that the ADOT sidecar in AgentCore Runtime **does not forward OTLP logs** — only traces (configured via `CfnRuntimeLogsMixin.TRACES.toXRay()`). The `OTEL_EXPORTER_OTLP_ENDPOINT` env var is not set by the ADOT auto-instrumentation; the Python ADOT SDK configures its trace exporter programmatically. CLI events sent to `localhost:4318` are silently dropped. `ENABLE_CLI_TELEMETRY` is therefore not set in the runtime environment variables.

**Collector-less OTLP export (alternative):** AWS supports sending OTLP data directly to CloudWatch endpoints without a collector: traces to `https://xray.{Region}.amazonaws.com/v1/traces`, logs to `https://logs.{Region}.amazonaws.com/v1/logs`, using `http/protobuf` protocol and `OTEL_EXPORTER_OTLP_LOGS_HEADERS` for log group routing. This requires SigV4 request signing, which the ADOT SDK handles but the Claude Code CLI's standard OTEL JS exporter does not support natively. Enabling this path would require either a signing proxy or a custom OTEL exporter.

### Viewing observability data

All data flows to **CloudWatch GenAI Observability** (Bedrock AgentCore tab):
- **Agents view** — session count, invocations, error rates, latency graphs.
- **Sessions view** — per-session traces, CPU/memory usage, duration.
- **Traces view** — trace timeline with custom spans (`task.pipeline` → child spans), span attributes, error status.
- **Transaction Search** — query by span attributes (e.g. `task.id`, `repo.url`).

Standard and OTEL structured logs are in CloudWatch Logs under the runtime application log group. Spans are in the `aws/spans` log group. Service metrics are in the `bedrock-agentcore` CloudWatch namespace.

### Prerequisites

**X-Ray trace segment destination** must be configured once per account **before deployment** (`CfnRuntimeLogsMixin.TRACES.toXRay()` requires it):

```bash
aws xray update-trace-segment-destination --destination CloudWatchLogs
```

Without this, `cdk deploy` will fail with: *"X-Ray Delivery Destination is supported with CloudWatch Logs as a Trace Segment Destination."*

**CloudWatch Transaction Search** must be enabled once per account to view traces and spans:
1. Open CloudWatch console → Application Signals (APM) → Transaction search.
2. Choose **Enable Transaction Search**.
3. Select the checkbox to **ingest spans as structured logs**.
4. Choose **Save**.

Both are one-time, account-level setup steps — not managed by CDK.

## Goals

- **Operational visibility** — operators and users can see task status, submitted backlog, and system health at a glance.
- **Debugging** — when a task fails or behaves unexpectedly, there is enough data (logs, traces, task history) to understand what happened.
- **Evaluation and improvement** — the platform can measure agent performance (duration, success rate, token usage, failure reasons) and feed that into evaluation and memory updates.
- **Code attribution and search** — capture all conversations and interactions with metadata (task, repo, branch, commits, PR) and store them in a searchable form so the agent can retrieve relevant past context in later tasks (see [Code attribution and capture for agent search](#code-attribution-and-capture-for-agent-search)).

## What to observe

### Task lifecycle

- Task creation, status transitions (SUBMITTED → HYDRATING → RUNNING → COMPLETED / FAILED / CANCELLED / TIMED_OUT), and terminal state.
- **Step-level events** — The blueprint framework emits events for each pipeline step: `{step_name}_started`, `{step_name}_completed`, `{step_name}_failed`. For built-in steps these overlap with the fixed event types (e.g. `hydration_started`). For custom Lambda steps, the step name is user-defined (e.g. `sast-scan_started`, `prepare-environment_completed`). See [REPO_ONBOARDING.md](/design/repo-onboarding#blueprint-execution-framework) and [API_CONTRACT.md](/design/api-contract).
- **Guardrail screening events** — `guardrail_blocked` (content blocked by Bedrock Guardrail during hydration, with metadata: `reason`, `task_type`, `pr_number`, `sources`, `token_estimate`). Screening failures are logged with structured `metric_type` fields (not emitted as task events).
- Time in each state (e.g. time in HYDRATING, time RUNNING, cold start to first agent activity).
- Correlation with a task id and user id so users and operators can filter by task or user.
- **Planned (Iteration 5, Phase 1): `PolicyDecisionEvent`** — A unified event schema for all policy decisions across the task lifecycle: admission control, budget/quota resolution, guardrail screening, tool-call interception, and finalization. Each event carries: decision ID, policy name, version, phase, input hash, result (`allow` | `deny` | `modify`), reason codes, and enforcement mode (`enforced` | `observed` | `steered`). This normalizes the current mix of structured events (e.g. `admission_rejected`, `guardrail_blocked`) and silent HTTP errors into a single auditable event type. See [ROADMAP.md Iteration 5](/roadmap/roadmap) (Centralized policy framework) and [SECURITY.md](/design/security) (Policy enforcement and audit).

### Agent execution

- **Logs** — agent and runtime logs (e.g. from the compute layer such as AgentCore Runtime) are the primary window into what the agent did once a session has ended. In the MVP, agent logs are available in CloudWatch via the runtime session; there is no live streaming of agent output (users poll task status).
- **Traces** — detailed reasoning traces (steps, tool calls, model interactions) for analysis and debugging. AgentCore has built-in observability (OpenTelemetry traces/spans); integration with the platform’s own metrics and dashboards should be defined.
- **Streaming** — live logs or events (e.g. runtime WebSocket) so users can watch agent progress in real time.

### System health and capacity

- **Concurrency** — number of RUNNING tasks (system-wide and per user), number of SUBMITTED tasks. Used for admission control and to detect when the system is at capacity (e.g. AgentCore quota bottleneck).
- **Counter drift** — reconciliation of the UserConcurrency (and any system-wide capacity counter) with actual task counts; alert when drift is detected.
- **Orchestration** — durable function execution status, failures, and retries so stuck or failed orchestrations are visible.

### Cost and performance

- **Token usage** — tokens consumed per task (and optionally per user or per repo) for cost attribution and rate limiting.
- **Task duration** — end-to-end task duration and, where available, cold start duration (clone + install deps) and time to first meaningful agent output.
- **Error and failure rates** — failure rate by type (e.g. agent crash, timeout, cancellation, orchestration failure) to spot regressions and bottlenecks.

## Metrics (candidate list from plans)

Plans call for defining at least:

- Task duration (p50, p95, or similar).
- Token usage per task.
- Approval wait time (if HITL is in scope).
- Cold start duration.
- Error rate by failure type.
- Agent crash rate.
- Counter drift frequency (e.g. reconciliation runs that correct drift).
- Active tasks (RUNNING count).
- Pending tasks (SUBMITTED count).
- Task completion rate (success vs failed/cancelled/timed out).
- Guardrail screening failure rate (`metric_type: 'guardrail_screening_failure'` in structured logs — use CloudWatch Logs Insights metric filter).
- Guardrail blocked rate (`guardrail_blocked` task events).

These can be emitted as custom CloudWatch metrics (or equivalent) and used in dashboards and alarms.

## Dashboards (candidate list from plans)

- **Active and submitted tasks** — current RUNNING and SUBMITTED counts (system-wide and optionally per user).
- **Task completion rate** — proportion of tasks that reach COMPLETED vs FAILED / CANCELLED / TIMED_OUT over a time window.
- **Task duration** — e.g. p50/p95 task duration, and cold start duration where available.
- **Operational view** — list or view of recent tasks, status, and errors for quick triage.

The control panel (see [CONTROL_PANEL.md](/design/control-panel)) is expected to provide a way to manage agents and **visualize metrics and all tasks**; dashboards can be built into that or into a separate observability platform.

## Alarms (candidate list from plans)

Critical alarms called out in the plans include:

- **Stuck tasks** — tasks in RUNNING for longer than the max session duration (e.g. 8 hours), indicating a possible orchestration or runtime bug.
- **Counter drift detected** — UserConcurrency (or system capacity counter) no longer matches actual active task count. Triggers the reconciliation Lambda (see [ORCHESTRATOR.md](/design/orchestrator), counter drift section): compare `UserConcurrency.active_count` to actual tasks in `RUNNING` + `HYDRATING` state per user, correct if different, emit a `counter_drift_corrected` metric. If automated reconciliation fails, escalate to operator via SNS/PagerDuty.
- **Orchestration / execution failures** — durable function execution failures (e.g. repeated session start failures).
- **Agent crash rate** — spike or sustained high rate of agent/session failures.
- **Pending depth** — SUBMITTED tasks exceeding a threshold (signals that the system is at capacity, e.g. AgentCore concurrent session quota bottleneck); may warrant a quota increase or capacity planning.
- **Guardrail screening failures** — sustained Bedrock Guardrail API failures blocking task submissions and PR task hydration (fail-closed). Filter: `metric_type = "guardrail_screening_failure"`. Indicates a Bedrock outage affecting task throughput.

## Code attribution and capture for agent search

We want to **capture all information and conversations** from each task and **store them with rich metadata** so they can be **searched later by the agent** (or by users/operators) as needed. This is sometimes called **code attribution**: linking what was discussed and decided to the actual code artifacts (commits, PRs, repos).

### What to capture

- **Conversations and interactions** — user message(s), agent reasoning, tool calls and results, decisions made during the task.
- **Outcomes** — what was implemented, what failed, what was deferred; summary of changes.
- **Code artifacts** — which repo, branch, commits (SHAs), and PR were produced or touched.

All of this should be persisted, not only in an audit log but in a **searchable store** (e.g. AgentCore Memory long-term memory, or a dedicated store with semantic or structured search) so the agent can query it in later tasks.

### Metadata to store alongside each capture

So that captures can be found and filtered later, they should be stored with metadata such as:

- **Task and session** — task_id, session_id, user_id.
- **Repository and code** — repo_url, branch_name, commit SHAs, pr_url (once created).
- **Time** — task created_at, completed_at, and optionally per-event timestamps.
- **Outcome** — status (COMPLETED, FAILED, etc.), error_message if any, and optionally extracted insights (e.g. “fixed auth bug in login flow”).

This metadata enables queries like: “What did we do on this repo or this PR?”, “What went wrong on tasks that failed?”, “What context do we have for issue X?” The agent can use the same store (e.g. via memory search or a retrieval API) to pull relevant past context into the current task.

### Relationship to memory and evaluation

- **Memory** (see [MEMORY.md](/design/memory)) — the platform uses short-term memory within a session and long-term memory across sessions (e.g. AgentCore Memory). Storing interactions with commit/PR metadata is the “code attribution” use of long-term memory: the agent (or the pipeline) writes summaries and key interactions into memory with metadata, and the agent retrieves them via semantic search when relevant. MVP may do this in a basic form; advanced code attribution (rich extraction, structured search by repo/PR/commit) is a natural evolution.
- **Evaluation** — the same captured data (conversations, traces, outcomes) feeds evaluation work (reasoning errors, failure analysis, learning from incidents). Code attribution makes it possible to tie evaluation results back to specific repos, PRs, or commits.

## Audit and history

- **TaskEvents table** — append-only audit log of task events (task_created, admission_rejected, preflight_failed, agent_started, pr_created, task_completed, task_failed, task_cancelled, task_timed_out, etc.). Used for "what happened with my task" and for compliance/evaluation. Event records carry a DynamoDB TTL (`ttl` attribute) set at creation time and are automatically deleted after the retention period (default 90 days, configurable via `taskRetentionDays`).
- **Task record** — each task has status, timestamps, repo, branch, PR URL, error message, and other metadata so users and operators can reconstruct the outcome. Task records carry a DynamoDB TTL stamped when the task reaches a terminal state and are automatically deleted after the retention period (default 90 days). Records without a `ttl` attribute (e.g. pre-existing data or active tasks) are retained indefinitely.

## Integration with runtime observability

The compute layer (AgentCore Runtime) exposes logs, metrics, and traces via OpenTelemetry. The platform integrates as follows:

- **Application logs** are routed to a CloudWatch Log Group (`/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/{runtimeName}`) via the `CfnRuntimeLogsMixin.APPLICATION_LOGS` CDK mixin. Retention is set to 90 days (`RetentionDays.THREE_MONTHS`).
- **Usage logs** (per-session CPU/memory) are routed to a separate CloudWatch Log Group via the `CfnRuntimeLogsMixin.USAGE_LOGS` CDK mixin. Retention is set to 90 days (`RetentionDays.THREE_MONTHS`).
- **Traces** are routed to X-Ray (and then to CloudWatch Transaction Search) via the `CfnRuntimeLogsMixin.TRACES.toXRay()` CDK mixin.
- **Custom spans** from the agent code (created via ADOT auto-instrumentation + `observability.py`) flow through the same X-Ray trace pipeline and appear alongside AgentCore's built-in spans in the CloudWatch GenAI Observability dashboard.
- **Session correlation**: the AgentCore session ID is propagated into the agent's OTEL context via baggage, linking custom spans to the AgentCore session.

## Operational procedures (runbook stubs)

When an alarm fires, the operator should follow the corresponding procedure. These are stubs — expand with detailed steps as operational experience accumulates.

| Alarm | Procedure |
|---|---|
| **Stuck task (RUNNING > 9 hours)** | 1. Query `GET /v1/tasks/{id}` to confirm status. 2. Check CloudWatch logs for the task's AgentCore session (session ID in task record). 3. If the session is dead but the task is still RUNNING, the orchestrator durable execution likely crashed. Manually invoke the orchestrator with the task ID to trigger finalization. 4. If the session is alive but unresponsive, cancel the task via `DELETE /v1/tasks/{id}`. |
| **Counter drift detected** | 1. Verify the reconciliation Lambda ran (check `counter_reconciliation_run` metric). 2. If it corrected the drift, no action needed (the alarm auto-resolves). 3. If reconciliation failed, check the Lambda's CloudWatch logs for errors. 4. Manual correction: query Tasks table for actual RUNNING + HYDRATING count per user, `UpdateItem` on UserConcurrency to correct `active_count`. |
| **Orchestration failures** | 1. Check Lambda Durable Functions execution logs. 2. Identify the failing step (load-blueprint, admission-control, start-session, etc.). 3. For `INVALID_STEP_SEQUENCE`: fix the Blueprint CDK construct config and redeploy. 4. For transient failures (DynamoDB throttle, AgentCore timeout): verify service health; the durable execution should auto-retry. |
| **Agent crash rate spike** | 1. Check for common root causes: model API errors (Bedrock throttling), compute quota exceeded (AgentCore session limit), image pull failures. 2. Query recent failed tasks by `error_code` for patterns. 3. If quota-related: request a quota increase or reduce concurrency limits. |
| **Submitted backlog over threshold** | 1. Check system concurrency: are all slots occupied by running tasks? 2. If yes: the system is at capacity. Options: increase per-user or system-wide concurrency limits (if quota allows), or wait for running tasks to complete. 3. If no: check for orchestrator backlog (tasks in SUBMITTED state not being picked up). |
| **Guardrail screening failures** | 1. Check Bedrock service health in the AWS console. 2. Query CloudWatch Logs: `filter metric_type = "guardrail_screening_failure" | stats count() by bin(5m)`. 3. If Bedrock is down, tasks will fail at submission (503) and during hydration (FAILED). No action needed — tasks will succeed once Bedrock recovers. 4. If failures are unexpected, check guardrail configuration (`GUARDRAIL_ID`, `GUARDRAIL_VERSION` env vars on the orchestrator Lambda). |

## Deployment safety for long-running sessions

The platform manages agent sessions that run for up to 8 hours. A CDK deployment replaces Lambda functions, which can orphan in-flight orchestrator executions. Safe deployment practices:

- **Drain before deploy.** Before deploying, check for active tasks (`GET /v1/tasks?status=RUNNING`). If possible, wait for running tasks to complete or cancel them before deploying. Automated: a pre-deploy script that queries active task count and warns or blocks if tasks are running.
- **Durable execution resilience.** Lambda Durable Functions checkpoints are stored externally (not in the Lambda instance). A replaced Lambda function can resume a durable execution from its last checkpoint. Verify this behavior in staging before relying on it.
- **Task record consistency.** If a deploy interrupts a running orchestrator, the task may be stuck in a non-terminal state. The counter drift reconciliation Lambda (every 5 minutes) will detect and correct the concurrency counter. The stuck task alarm (RUNNING > 9 hours) will fire and trigger the manual finalization procedure.
- **Blue-green or canary.** The CI/CD pipeline should use blue-green deployment for the orchestrator Lambda, with automatic rollback if error rates increase after deployment.
