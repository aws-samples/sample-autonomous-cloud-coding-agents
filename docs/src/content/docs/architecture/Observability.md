---
title: Observability
---

# Observability

For a system where agents run for hours and burn tokens autonomously, observability is load-bearing infrastructure. The platform captures task lifecycle, agent reasoning, tool use, and outcomes so operators can monitor health, debug failures, and improve agent performance over time.

- **Use this doc for:** understanding what the platform observes, how telemetry flows, metrics, dashboards, alarms, and deployment safety.
- **Related docs:** [ORCHESTRATOR.md](/architecture/orchestrator) for task state machine, [MEMORY.md](/architecture/memory) for code attribution and cross-session learning, [EVALUATION.md](/architecture/evaluation) for agent performance measurement.

## Telemetry architecture

The platform combines three telemetry sources: AgentCore built-in metrics, custom OpenTelemetry spans from the agent harness, and structured task events from the orchestrator. All data flows to CloudWatch.

```mermaid
flowchart TB
    subgraph Agent["Agent (MicroVM)"]
        H[Agent harness]
        ADOT[ADOT auto-instrumentation]
    end
    subgraph Orchestrator
        DF[Lambda Durable Functions]
        EV[Task events]
    end
    subgraph CloudWatch
        CWM[Metrics<br/>bedrock-agentcore namespace]
        CWL[Logs<br/>application + usage]
        XR[X-Ray traces<br/>custom + built-in spans]
        TE[TaskEvents table<br/>audit trail]
        DASH[Dashboard<br/>BackgroundAgent-Tasks]
    end

    H -->|custom spans| ADOT
    ADOT -->|traces| XR
    ADOT -->|logs| CWL
    Agent -->|built-in metrics| CWM
    DF -->|structured events| TE
    CWM --> DASH
    CWL --> DASH
    XR --> DASH
```

**AgentCore built-in metrics** (automatic): invocations, session count, latency, errors, throttles, CPU/memory usage per session. Published to the `bedrock-agentcore` CloudWatch namespace.

**Custom spans** from the agent harness provide task-level tracing:

| Span | What it covers |
|------|----------------|
| `task.pipeline` | Root span: end-to-end task execution |
| `task.context_hydration` | GitHub issue fetch + prompt assembly |
| `task.repo_setup` | Clone, branch, mise install, initial build |
| `task.agent_execution` | Claude Agent SDK invocation |
| `task.post_hooks` | Safety-net commit, build/lint verification, PR creation |

Root span attributes (`task.id`, `repo.url`, `agent.model`, `agent.cost_usd`, `build.passed`, `pr.url`, etc.) enable CloudWatch querying and filtering.

**Session correlation**: the AgentCore session ID propagates via OTEL baggage, linking custom spans to AgentCore's built-in session metrics in the CloudWatch GenAI Observability dashboard.

## What to observe

The platform tracks four categories of signals, each serving different consumers (operators, users, evaluation pipeline).

### Task lifecycle

Every task emits structured events at each state transition, stored in the TaskEvents table:

- State transitions: `task_created`, `admission_passed`, `admission_rejected`, `hydration_started`, `hydration_complete`, `session_started`, `session_ended`, `pr_created`, `task_completed`, `task_failed`, `task_cancelled`, `task_timed_out`
- Blueprint custom step events: `{step_name}_started`, `{step_name}_completed`, `{step_name}_failed`
- Guardrail events: `guardrail_blocked` (content blocked during hydration)

All events carry `task_id` and `user_id` for filtering.

### Agent execution

- **Logs** - Agent and runtime logs in CloudWatch (application log group). Primary debugging window after a session ends.
- **Traces** - Custom spans + AgentCore built-in spans in X-Ray, visible in CloudWatch GenAI Observability. Span attributes enable queries like "show all tasks for repo X that failed."
- **Live streaming** - Not available in MVP. Users poll task status via the API.

### System health

- **Concurrency** - RUNNING task count (system-wide and per user), SUBMITTED backlog depth. Used for admission control and capacity planning.
- **Counter drift** - Reconciliation of UserConcurrency counters with actual task counts. Alert when drift is detected.
- **Orchestration health** - Durable function execution status, failures, and retries.

### Cost and performance

- **Token usage** - Per task, per user, per repo. Feeds cost attribution and budget enforcement.
- **Task duration** - End-to-end, cold start (clone + install), and time to first agent output.
- **Error rates** - By failure type (agent crash, timeout, cancellation, orchestration failure).

## Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| Task duration (p50, p95) | Latency | Performance baseline and regression detection |
| Token usage per task | Cost | Cost attribution and budget enforcement |
| Cold start duration | Latency | Image optimization signal |
| Active tasks (RUNNING count) | Capacity | Admission control and capacity planning |
| Pending tasks (SUBMITTED count) | Capacity | Backlog depth and throughput monitoring |
| Task completion rate | Reliability | Success vs failed/cancelled/timed out |
| Error rate by failure type | Reliability | Regression and bottleneck detection |
| Agent crash rate | Reliability | Runtime stability |
| Counter drift frequency | Correctness | Concurrency accounting health |
| Guardrail blocked rate | Security | Content screening activity |
| Guardrail screening failure rate | Availability | Bedrock Guardrail API health |

Emitted as custom CloudWatch metrics and used in dashboards and alarms.

## Dashboard

A CloudWatch dashboard (`BackgroundAgent-Tasks`) is deployed via the `TaskDashboard` CDK construct. It provides Logs Insights widgets for:

- Task success rate and count by status
- Cost per task and turns per task
- Duration distribution
- Build and lint pass rates
- AgentCore built-in metrics (invocations, errors, latency)

The CloudWatch GenAI Observability console provides additional views: per-session traces, CPU/memory usage, trace timeline with custom spans, and transaction search by span attributes.

## Alarms

| Alarm | Trigger | Action |
|-------|---------|--------|
| Stuck task | RUNNING > 9 hours | Check session liveness. If dead, trigger manual finalization. If alive but unresponsive, cancel. |
| Counter drift | UserConcurrency differs from actual task counts | Reconciliation Lambda auto-corrects. If it fails, manual correction. |
| Orchestration failures | Repeated durable function execution failures | Check failing step, verify service health. Durable execution auto-retries transient failures. |
| Agent crash rate spike | Sustained high session failure rate | Check for model API errors, compute quota exhaustion, image pull failures. |
| Submitted backlog depth | SUBMITTED count exceeds threshold | System at capacity. Increase concurrency limits or wait for running tasks. |
| Guardrail screening failures | Sustained Bedrock Guardrail API failures | Tasks fail at submission (503) and hydration (FAILED). Recovers when Bedrock recovers. |

## Code attribution

Every agent commit carries `Task-Id:` and `Prompt-Version:` trailers (via a git hook installed during repo setup). This links code changes to the task and prompt that produced them, enabling queries like "what prompt led to this change?" and supporting the evaluation pipeline.

Task conversations, tool calls, decisions, and outcomes are persisted with metadata (`task_id`, `session_id`, `repo`, `branch`, `commit SHAs`, `pr_url`) in a searchable store. The agent retrieves relevant past context via memory search at task start. See [MEMORY.md](/architecture/memory) for the memory lifecycle and retrieval strategy.

## Audit and retention

- **TaskEvents table** - Append-only audit log of all task events. Records carry a DynamoDB TTL and are auto-deleted after the retention period (default 90 days, configurable via `taskRetentionDays`).
- **Task records** - Status, timestamps, metadata. TTL is stamped when the task reaches a terminal state (default 90 days). Active tasks are retained indefinitely.
- **Logs** - Application and usage logs retained for 90 days in CloudWatch. Traces flow to X-Ray via CloudWatch Transaction Search.
- **Model invocation logs** - Bedrock model invocation logging with 90-day retention for compliance and prompt injection investigation.

## Deployment safety

Agent sessions run for up to 8 hours. CDK deployments replace Lambda functions, which can orphan in-flight orchestrator executions. The platform handles this through multiple mechanisms:

- **Drain before deploy** - Pre-deploy check for active tasks. Warn or block if tasks are running.
- **Durable execution resilience** - Lambda Durable Functions checkpoints are stored externally. A replaced Lambda can resume from its last checkpoint.
- **Consistency recovery** - If a deploy interrupts a running orchestrator, the counter drift reconciliation Lambda (every 5 minutes) corrects the concurrency counter. The stuck task alarm fires and triggers manual finalization.
- **Blue-green deployment** - CI/CD pipeline uses blue-green for the orchestrator Lambda, with automatic rollback if error rates increase.

## Account prerequisites

Two one-time, account-level setup steps are required before deployment (not managed by CDK):

1. **X-Ray trace segment destination** - Run `aws xray update-trace-segment-destination --destination CloudWatchLogs`. Without this, `cdk deploy` fails.
2. **CloudWatch Transaction Search** - Enable in the CloudWatch console (Application Signals > Transaction Search > Enable, with "ingest spans as structured logs" checked).
