# Interactive Agents: Async Interaction Design

> **Status:** Active design
> **Branch:** `feature/interactive-background-agents`
> **Last updated:** 2026-04-29 (rev 6)

---

## Executive summary

ABCA runs background coding agents that clone a repo, implement a task, run tests, and open a pull request. Tasks run for minutes to hours inside an isolated cloud runtime. The interaction model is **asynchronous by design**. Users submit a task and move on. The agent works without supervision. Results arrive through notifications (Slack, GitHub comment, or email) and as pull requests.

This document describes the interaction features built on top of that model. With them, users **check in on**, **steer**, and **gate** running agents without a live connection to the compute substrate.

### Interaction capabilities

1. **Submit.** `POST /tasks` with a repo and task description. Fire-and-forget by default. The CLI returns a `task_id` and exits.
2. **Status.** `bgagent status <id>` returns a deterministic, templated snapshot of current state (last milestone, current turn, elapsed time, cost so far). A Lambda that reads `TaskEventsTable` backs it. There is no LLM, no hallucination, and no agent interruption.
3. **Watch.** `bgagent watch <id>` polls `TaskEventsTable` with an adaptive interval (500 ms when events are arriving, back-off to 5 s when idle). The foreground-block UX of `ask` and the HITL approval waits use the same endpoint.
4. **Nudge.** `bgagent nudge <id> "<text>"` writes a row into `TaskNudgesTable`. The agent reads pending nudges between turns, acknowledges them with a `nudge_acknowledged` milestone event, and integrates the nudge on its next turn.
5. **Ask.** `bgagent ask <id> "<question>"` (Phase 2) writes a question row. The agent answers at the next between-turns boundary, and the answer appears as a `status_response` event. By default the CLI blocks in the foreground and polls, with a spinner. The task and the answer are both durable if the CLI disconnects.
6. **Approval gates.** Phase 3 adds Cedar-driven hard gates. The agent emits `approval_requested` and waits for a decision from `bgagent approve`, `bgagent deny`, or a Slack button press. [`CEDAR_HITL_GATES.md`](./CEDAR_HITL_GATES.md) has the detailed design.

### Core architectural choices

- **Single AgentCore Runtime.** The orchestrator Lambda authenticates to it with IAM (SigV4). There is no JWT-authenticated runtime and no direct path from the CLI to the runtime.
- **Durable event table (`TaskEventsTable`).** This table is the one source of truth for agent progress. Every reader reads from this table, never from the live agent. The readers are the CLI, the Slack, GitHub, and email dispatchers, and the status Lambda.
- **Polling-only CLI.** The CLI uses no SSE and no WebSockets. Eventually consistent DDB reads with an `event_id` cursor are cheap, reliable, and compute-agnostic.
- **Notification plane as first-class.** A FanOutConsumer Lambda subscribes to `TaskEventsTable` DDB Streams and routes each event by type to per-channel dispatcher Lambdas (Slack, email, GitHub comment). Per-channel defaults ship in v1.
- **Agent interaction via the hook mechanism the Claude Agent SDK provides.** Nudges, asks, and approvals all use `Stop` hooks, which run between turns. They need no mechanism outside the SDK's contract.

---

## Revision history

| Rev | Date | Summary |
|-----|------|---------|
| 6 | 2026-04-29 | Current active design. Async-only interaction model: single runtime, polling-only CLI, notification plane as first-class UX, `bgagent status` + `bgagent watch` + `bgagent nudge` in v1, `bgagent ask` + Phase 3 Cedar HITL layered on top. |

---

## Table of contents

1. [Design goals](#1-design-goals)
2. [Architecture overview](#2-architecture-overview)
3. [Components](#3-components)
4. [Event model](#4-event-model)
5. [User interactions](#5-user-interactions)
6. [Notification plane](#6-notification-plane)
7. [Security and trust model](#7-security-and-trust-model)
8. [State machine](#8-state-machine)
9. [Error handling and observability](#9-error-handling-and-observability)
10. [Debug escape hatch](#10-debug-escape-hatch)
11. [Architectural decisions](#11-architectural-decisions)
12. [Implementation phases](#12-implementation-phases)
13. [Open questions](#13-open-questions)
14. [Appendix A — Claude Agent SDK reference](#appendix-a--claude-agent-sdk-reference)
15. [Appendix B — AgentCore Runtime reference](#appendix-b--agentcore-runtime-reference)
16. [Appendix C — Competitive landscape](#appendix-c--competitive-landscape)

---

## 1. Design goals

### Primary goals

- **Compute-agnostic.** Nothing in the interaction design depends on a specific compute substrate. The agent could run on AgentCore today and ECS tomorrow with no changes to the CLI or notification plane.
- **Survive disconnect.** Every interaction is durable in DynamoDB. A CLI crash, a closed laptop, or a flaky network never stops a task and never loses a reply.
- **Fire-and-forget by default.** Users submit and move on. Active observation is opt-in through `status` or `watch`.
- **No UX choice at submission time.** There is exactly one submit command and one observation command. Users do not pick between "resilient" and "live" when they submit.
- **Notification as first-class.** When the agent needs a human (approval gate, ask response, task completion), it reaches the user through their configured channel. It does not rely on the user watching a terminal.

### Explicit non-goals

- Token-by-token live streaming. Users want to know *what step* the agent is on, not *what character* it's typing.
- Sub-200 ms interaction latency. Human interaction in an async coding workflow is measured in seconds, not milliseconds.
- Transactional undo of agent actions. Tool calls are committed. The agent cannot revert a filesystem change because a user objected afterwards.
- Pair-programming or co-edit modes. Those are a different product.

### Requirements traceability

| Req | Covered by |
|---|---|
| R1. Users don't pick compute or observability at submission | Single submit command. `TaskEventsTable` is compute-agnostic |
| R2. Fire-and-forget runs independently | Orchestrator path runs without a client connection |
| R3. HITL notification when configured | `approval_requested` event → FanOutConsumer → Slack/email |
| R4. Users can check in + steer any time | `bgagent status` + `bgagent watch` + `bgagent nudge` + (Phase 2) `bgagent ask` |
| R5. Agent updates source context if configured | FanOutConsumer → GitHub issue-comment dispatcher (edit-in-place) |

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            CLIENT SURFACES                              │
│                                                                         │
│  bgagent CLI     Slack bot      GitHub webhook      Web UI (future)     │
│       │             │                │                    │             │
│       └─────────────┴────────────────┴────────────────────┘             │
│                                │                                        │
└────────────────────────────────┼────────────────────────────────────────┘
                                 │ REST (Cognito JWT or HMAC webhook)
                                 ▼
         ┌──────────────────────────────────────────────┐
         │             API Gateway (v1)                 │
         │                                              │
         │  POST   /tasks                   submit      │
         │  GET    /tasks/{id}              status-api  │
         │  GET    /tasks/{id}/events       watch       │
         │  DELETE /tasks/{id}              cancel      │
         │  POST   /tasks/{id}/nudge        nudge       │
         │  POST   /tasks/{id}/asks         ask (P2)    │
         │  POST   /tasks/{id}/approvals    approve P3  │
         │  POST   /webhooks/tasks          GH webhook  │
         └───────────┬──────────────────────────────────┘
                     │
        ┌────────────┼───────────────┬───────────────────────┐
        ▼            ▼               ▼                       ▼
  SubmitTaskFn   CLI-read Fns    Nudge/Ask/Approve      Webhook Fn
        │       (status/events)   write Fns                 │
        │            │               │                      │
        │ async      │  read         │  write               │ async
        │ invoke     │               │                      │ invoke
        ▼            ▼               ▼                      ▼
   OrchestratorFn                                      OrchestratorFn
        │                                                   │
        │ admission check                                   │
        │ InvokeAgentRuntime (SigV4)                        │
        ▼                                                   ▼
  ┌─────────────────────────────────────────────────────────────┐
  │          AgentCore Runtime — single IAM-authed              │
  │          (agent container: pipeline, runner, hooks)         │
  └──┬────────────────┬───────────────┬──────────────────────┬──┘
     │ writes         │ reads         │ reads                │ reads
     ▼                ▼               ▼                      ▼
  TaskEvents      TaskTable       TaskNudges           TaskApprovals
   Table           (state)         Table                Table (P3)
     │                                                        ▲
     │ DDB Stream (NEW_IMAGE)                                 │
     ▼                                                        │
  FanOutConsumer (router)                                     │
     │                                                        │
     ├─→ SlackDispatchFn    ──▶ Slack Web API                 │
     ├─→ EmailDispatchFn    ──▶ SES                           │
     └─→ GitHubDispatchFn   ──▶ GitHub REST (edit-in-place)   │
                                    │                         │
                                    │ action-button callback  │
                                    │ (approve/deny)          │
                                    └─────────────────────────┘
```

Key properties:

- **One write path in, one read path out.** Every durable agent signal is written to `TaskEventsTable` (or `TaskTable` for state transitions). Every consumer reads from there.
- **The orchestrator is the only component that knows the compute substrate.** Replace `InvokeAgentRuntime` with `ecs:RunTask`, and the CLI and the notification plane are unaffected.
- **No client holds a live connection to the agent.** `watch` is a polling loop against `TaskEventsTable`, not a stream from the runtime.

---

## 3. Components

### 3.1 AgentCore Runtime (IAM-authenticated)

There is a single AgentCore Runtime, which the orchestrator Lambda invokes through `bedrock-agentcore:InvokeAgentRuntime` with SigV4. It has no JWT authorizer and no direct CLI access.

- **Input:** the task payload from the orchestrator (task_id, repo, task_description, optional initial_approvals, optional trace_flag).
- **Output:** none through the response stream. The runtime is invoked fire-and-forget. All observable state goes through `TaskEventsTable` and `TaskTable`.
- **Lifecycle:** `idleRuntimeSessionTimeout` and `maxLifetime` are both set to 8 hours, the AgentCore maximum. A running task holds the session. AgentCore evicts an idle runtime.
- **Compute substitutability:** replacing this runtime with ECS/Fargate changes only the orchestrator and the AgentCore Runtime CDK construct. Nothing else in the system sees the difference.

### 3.2 OrchestratorFn

OrchestratorFn is a durable-execution Lambda that owns the task lifecycle from submission to terminal state.

Responsibilities:
- **Admission control.** An atomic DDB conditional update on `UserConcurrencyTable` (`active_count < max`). A task over the limit is parked as `QUEUED` (#441).
- **State transition** `SUBMITTED → HYDRATING → RUNNING → FINALIZING → terminal`.
- **Invocation.** Calls `InvokeAgentRuntime` with SigV4.
- **Poll loop.** Waits for the agent to write a terminal status to `TaskTable`, enforces the heartbeat watchdog, and transitions the task to `FAILED` if the container dies.
- **Finalize.** TTL, concurrency decrement, and synthesized terminal event.

The target is for hydration (blueprint merge, repo config, PAT retrieval, prompt assembly) to run **inside the agent container at startup**, not in the orchestrator. That placement keeps the orchestrator thin, lets heavy I/O fail inside a durable 8 h runtime instead of a 15 min Lambda, and gives the runtime container the IAM that it needs for those reads anyway.

> **Status (2026-04-30):** the rev-6 PR ships with hydration still in the orchestrator Lambda, for scope reasons. Moving it is pure architectural relocation with no user-visible change, and the port is about 2,700 lines (TypeScript to Python, with new boto3 clients and a GraphQL GitHub path). The move is tracked as the AD-11 carry-forward in upstream [issue #53](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/53). The current plan is a hybrid split: keep lightweight preflight in the orchestrator, and move heavy I/O hydration to the container. The `SUPPORTED_HYDRATED_CONTEXT_VERSION` version gate in `agent/src/models.py` bounds contract drift during the deferral window.

### 3.3 SubmitTaskFn

SubmitTaskFn validates a submission, writes the `TaskRecord` with `status=SUBMITTED`, emits a `task_created` event, and invokes `OrchestratorFn` asynchronously.

- All tasks take a single path. There is no `execution_mode` branching.
- It works identically for CLI-initiated submissions (Cognito JWT) and webhook-initiated submissions (HMAC, after the webhook authorizer).

### 3.4 TaskEventsTable

`TaskEventsTable` is the durable event spine. PK = `task_id`, SK = `event_id` (ULID), TTL enabled, **DDB Streams enabled** (`NEW_IMAGE`).

Writers:
- `ProgressWriter` (inside the agent container) writes an event per tool call, per turn, and per milestone, and writes cost updates and errors.
- `OrchestratorFn` writes `task_created`, `hydration_*`, `session_started`, `task_*`, `preflight_*`, `admission_queued`, and `guardrail_blocked`.
- The cancel and reconciler handlers write `task_cancelled` and `task_stranded`.

Readers:
- The `get-task-events` Lambda, which backs `bgagent watch` and `bgagent events`.
- The `bgagent status` Lambda (templated snapshot).
- `FanOutConsumer`, which subscribes to the stream (see §6).

The cost is negligible. Eventually consistent queries with a cursor consume about 0.5 RCU per page. 50 simultaneous watchers that poll every 2 seconds cost pennies per active hour.

### 3.5 TaskTable

The task state machine is `SUBMITTED → HYDRATING → RUNNING → FINALIZING → {COMPLETED, FAILED, CANCELLED, TIMED_OUT}`. Phase 3 adds `AWAITING_APPROVAL`.

The writers are create-task, the orchestrator, cancel, the agent pipeline (terminal write), and the reconcilers. Transitions are conditional DDB writes, and illegal transitions are rejected.

### 3.6 TaskNudgesTable

PK = `task_id`, SK = `nudge_id`. A row is a pending steering message from a user.

Producer: the `POST /tasks/{id}/nudge` handler, after the ownership check, the guardrail scan, and the rate-limit conditional update.
Consumer: the agent's between-turns hook, which reads pending nudges, emits a `nudge_acknowledged` milestone, and injects the nudge text into the next turn through `decision: "block"`.

### 3.7 TaskApprovalsTable (Phase 3)

`TaskApprovalsTable` is the Phase 3 approval-request table. [`CEDAR_HITL_GATES.md`](./CEDAR_HITL_GATES.md) has the detailed schema. The semantics in summary:
- The agent writes an approval row with the request context.
- The agent transitions `RUNNING → AWAITING_APPROVAL` and enters a poll loop.
- The user responds through REST (`POST /tasks/{id}/approvals/{request_id}`) or through a Slack button that the notification plane dispatches.
- On a decision, the agent transitions back to `RUNNING`. Denial reasons are injected as Stop-hook steering on the next turn.

### 3.8 FanOutConsumer (router)

FanOutConsumer is a Lambda subscribed to `TaskEventsTable` DDB Streams. It relies on the DynamoDB Streams **default** `ParallelizationFactor` of 1, which preserves per-`task_id` ordering by shard. `fanout-consumer.ts` does not set the factor explicitly (see §6.1). The Lambda reads the per-task notification config (from `TaskTable` metadata or `RepoTable` defaults), filters events by channel subscription, and invokes per-channel dispatcher Lambdas.

- **SlackDispatchFn.** Posts to the configured channel or DM. Includes action buttons for `approval_required` events.
- **EmailDispatchFn.** SES.
- **GitHubDispatchFn.** Edits a single GitHub issue comment in place through `PATCH /repos/{o}/{r}/issues/comments/{id}`. On a 404 (the comment was deleted upstream) it falls back to POSTing a fresh comment. The DDB Streams default `ParallelizationFactor` of 1 guarantees per-task ordering upstream (see §6.1), so no conditional-request header is needed. Also, GitHub's REST API does not accept `If-Match` on this endpoint (see §6.4).

§6 has the detailed routing and the default filters.

### 3.9 Reconcilers

Two scheduled Lambdas act as a backstop for the state machine:

- **Stranded-task reconciler** (every 5 min). Catches tasks that stay in a non-terminal state past a unified timeout (`STRANDED_TIMEOUT_SECONDS=1200` by default). It covers `OrchestratorFn` async-invoke crashes and container crashes, and it transitions stuck tasks to `FAILED` with a `task_stranded` event.
- **Concurrency reconciler** (every 15 min). Recomputes `active_count` per user from a query of the `UserStatusIndex` GSI and corrects drift in `UserConcurrencyTable`.

### 3.10 CLI (`bgagent`)

Commands:
- `submit` is fire-and-forget and returns `task_id`.
- `status <id>` returns a templated snapshot.
- `watch <id>` runs an adaptive polling loop.
- `events <id>` prints the raw event stream (debug).
- `nudge <id> "<text>"` steers the agent.
- `cancel <id>` stops the task.
- `ask <id> "<question>"` (Phase 2) asks the agent a question.
- `approve <id>`, `deny <id>`, `pending`, and `policies` (Phase 3) are the HITL commands.

Authentication: all REST calls carry a Cognito User Pool ID token in the `Authorization` header. The CLI caches tokens in `~/.bgagent/credentials.json` and refreshes them automatically.

---

## 4. Event model

### 4.1 Schema

A `TaskEventsTable` row:

```jsonc
{
  "task_id": "abc123",          // PK
  "event_id": "01JXY...",       // SK, ULID (time-sortable)
  "event_type": "agent_tool_call",
  "timestamp": "2026-04-29T15:30:12Z",
  "ttl": 1735689600,
  "metadata": {
    "tool_name": "Bash",
    "tool_input_preview": "pytest tests/ -x",   // ≤200 chars by default; 4KB with --trace
    "turn": 7,
    "...": "..."
  }
}
```

### 4.2 Event types

| Type | Emitted by | Meaning |
|---|---|---|
| `task_created` | SubmitTaskFn | New task accepted |
| `hydration_started` / `hydration_completed` | Agent startup | Blueprint + repo config loaded |
| `session_started` | Orchestrator | AgentCore session established |
| `agent_turn` | Runner | One model-roundtrip completed. Includes turn number, model, thinking preview |
| `agent_tool_call` | Runner / PreToolUse hook | About to invoke a tool |
| `agent_tool_result` | Runner / PostToolUse hook | Tool returned |
| `agent_milestone` | Agent code (pipeline, hooks) | Named checkpoint (`repo_cloned`, `pr_opened`, `nudge_acknowledged`, ...) |
| `agent_cost_update` | Runner | Cumulative token and dollar cost. Its `turn` is the turn number the `agent_turn` events carry |
| `agent_error` | Runner | Handled exception |
| `approval_required` (P3) | PreToolUse Cedar hook | Cedar policy requires user decision |
| `approval_decided` (P3) | Approve/Deny Lambda | User responded |
| `status_response` (P2) | Between-turns hook | Agent answered an `ask` |
| `nudge_acknowledged` | Between-turns hook | Agent saw a nudge before incorporating it |
| `pr_created` | Pipeline | PR opened for the task |
| `task_completed` / `task_failed` / `task_cancelled` / `task_stranded` | Orchestrator / reconciler | Terminal |

Named milestones (`pr_created`, `nudge_acknowledged`, `repo_setup_complete`, …) are written as `agent_milestone` events, and `metadata.milestone` carries the name. The fan-out router unwraps an allowlisted subset (§6.2) so that per-channel default filters can target milestone names directly. For example, GitHub's default set includes `pr_created`. Milestone names that are not on the allowlist stay wrapped and are not routed. The watch CLI renders all milestones, whatever the allowlist says.

### 4.3 Previews and truncation

Text fields (thinking, tool input, tool output, error details) are truncated to 200 characters by default to keep event rows small. The `--trace` flag raises the cap to 4 KB and also writes a full trajectory to S3 (see §10).

### 4.4 Cursor semantics

Consumers page through `TaskEventsTable` with `event_id` as a cursor: `KeyConditionExpression: task_id = :id AND event_id > :cursor`, `ConsistentRead: true`. ULID sort order is time-monotonic, so lexical comparison gives time ordering.

---

## 5. User interactions

### 5.1 `bgagent submit`

```
$ bgagent submit --repo org/repo "fix the auth timeout bug"
task submitted: abc123
```

The command writes the `TaskRecord`, starts the orchestrator, and returns. The CLI does not wait. A `--wait` flag is available for scripting. It blocks until a terminal state and returns non-zero on failure.

### 5.2 `bgagent status`

`bgagent status` returns a deterministic, templated snapshot, with no LLM.

```
$ bgagent status abc123
Task abc123 — RUNNING (3m 14s elapsed)
  Repo: org/repo
  Turn: 7 / 12
  Last milestone: nudge_acknowledged (42s ago)
  Current: Bash tool call
  Cost: $0.18 / budget $2.00
  Last event: 2026-04-29T15:30:12Z
```

Implementation:
- The Lambda reads the last N events from `TaskEventsTable` and the current `TaskRecord`.
- It renders from a fixed template. It never calls an LLM and never hallucinates.
- It is fast (<200 ms P95), free, and safe to call repeatedly.
- `Turn` is the number of answers of the model so far, shown against `max_turns`, which limits that count. While the task runs, the number is the `turn` of the newest `agent_turn` event. Once the task has finished, it is the record's `turns_completed`, or the event's `turn` if the record holds no count. The record's `turns_attempted` is the Claude Code CLI's own counter. That counter grows with every tool result (as of the pinned CLI 2.1.319) and can exceed `max_turns`. It is not shown against the limit.

### 5.3 `bgagent watch`

`bgagent watch` is a polling loop against `GET /tasks/{id}/events?after=<cursor>` with an **adaptive interval**:

- Start at 500 ms.
- If a poll returns at least 1 event, stay at 500 ms.
- If a poll returns 0 events, back off to 1 s, then 2 s, then 5 s (the cap).
- Reset to 500 ms on the next event.

The command renders events as they arrive and exits on a terminal status. The cursor is the last `event_id` seen.

The cost is negligible: 50 simultaneous watchers at about 0.5 RCU per empty poll and 5 s intervals when idle.

### 5.4 `bgagent nudge`

```
$ bgagent nudge abc123 "also fix the logging module, separate commit"
nudge queued: nudge_01JX...
```

Flow:
1. The CLI calls `POST /tasks/{id}/nudge`, which runs the rate-limit conditional update and a `PutItem` in `TaskNudgesTable`.
2. The agent's Stop hook fires between turns. It calls `nudge_reader.read_pending(task_id)`, which returns all pending nudges for this task. Several nudges are concatenated into one `<user_nudge>` block.
3. The hook emits a `nudge_acknowledged` milestone to `ProgressWriter` **before** it returns to the SDK. The user sees this event immediately in `watch` or Slack.
4. The hook returns `{"decision": "block", "reason": <formatted_nudge_text>}`. The SDK treats this as the start of the next user turn, and the agent incorporates the nudge in its response.
5. The nudge row is marked consumed through a conditional update (`consumed_at` is set only if it is currently null).

**Cost model.** The nudge costs one turn of the task's `max_turns` budget. The acknowledgment is part of the same turn (the combined-turn ack pattern). This is the mechanism a nudge uses to inject its text mid-run. There is no "append to system prompt mid-conversation" API. See Appendix A. Section A.2 describes the one other way, text that a hook attaches to a tool result.

### 5.5 `bgagent ask` (Phase 2)

The command asks the agent a natural-language question that requires the agent's own reasoning. An ask always costs a turn and always has latency. The latency is bounded above by the duration of the agent's current turn, which can be minutes.

**CLI default: foreground block-and-poll with a spinner.**

```
$ bgagent ask abc123 "why did you change the retry logic?"
⠋ queued as ask_01JX... — waiting for agent
⠙ agent is running tool: Bash (turn 7/12) — 42s elapsed
✓ agent responded (1m 14s)

The existing retry used exponential backoff with no jitter, causing thundering
herd under load. Added jitter to spread retries across the window.
```

Flow:
1. The CLI calls `POST /tasks/{id}/asks` and receives `{ask_id, cursor}`.
2. The CLI polls `GET /events?after=<cursor>&type=status_response&correlation_id=<ask_id>` with an adaptive interval.
3. The spinner renders the last `agent_turn` or `agent_tool_call`, so the user sees that the agent is still running.
4. The agent's between-turns hook reads the pending ask and injects it as a user turn through `decision: "block"`. The agent answers, and the hook emits `status_response{ask_id, content, turn}`.
5. The CLI prints the response and exits.

Flags:
- By default the command blocks in the foreground.
- `--no-wait` returns `ask_id` immediately. The response is delivered through Slack or `watch`.
- `--timeout N` overrides the default of 5 min (hard cap 10 min).

**Durability:** the ask row is in DDB whatever the state of the CLI. If the user presses Ctrl-C or the terminal closes, the ask still executes. The response can be retrieved with `bgagent asks show <ask_id>`, `bgagent watch`, or Slack.

**Rate limit:** 1 open ask per task per user (429 otherwise). The limit is forward-compatible with multi-user team scenarios.

### 5.6 `bgagent approve` / `deny` / `pending` / `policies` (Phase 3)

These are the HITL approval commands. All flows are REST and DDB, with no streaming. [`CEDAR_HITL_GATES.md`](./CEDAR_HITL_GATES.md) has the detailed design. In summary:

- The agent emits `approval_required` with the tool context.
- The notification plane dispatches the event (Slack with action buttons, email, GitHub).
- The user responds with `bgagent approve <id>`, `bgagent deny <id> --reason "…"`, or a Slack button click.
- The agent's poll loop sees the decision, and the agent proceeds or takes the denial as steering.

### 5.7 `bgagent cancel`

The command writes the `cancellation_requested` flag on the `TaskRecord`. The agent's between-turns hook checks the flag and terminates. The agent's PR-short-circuit logic commits partial work before exit.

---

## 6. Notification plane

### 6.1 FanOutConsumer as router

```
TaskEventsTable ──DDB Stream──▶ FanOutConsumer
                                     │
                                     │ reads notification config
                                     │  (per-task or per-repo)
                                     │
                       ┌─────────────┼─────────────┐
                       ▼             ▼             ▼
                 SlackDispatch  EmailDispatch  GitHubDispatch
                       │             │             │
                  Slack Web API    SES        GitHub REST API
```

- A single Lambda subscribes to the DDB Stream. It is stateless, and on a per-event error it fails forward into an SQS DLQ.
- Per-`task_id` shard ordering is preserved without extra configuration, because the DynamoDB Streams `ParallelizationFactor` **defaults to 1**. `cdk/src/constructs/fanout-consumer.ts` configures the `DynamoEventSource` **without** setting `parallelizationFactor`, so this ordering guarantee depends on the AWS default, not on an explicit setting. To enforce the guarantee against future changes of the default or accidental edits, set `parallelizationFactor: 1` explicitly on the event source.
- The router reads the per-task notification config (channel enablement and event-type filters), then invokes the relevant dispatcher Lambdas for each event.
- Dispatchers are separate Lambdas so that a GitHub API outage does not block Slack notifications.

### 6.2 Per-channel defaults (v1)

| Channel | Default subscribed events | Opt-in via `--verbose` |
|---|---|---|
| **Slack** | `task_completed`, `task_failed`, `task_cancelled`, `pr_created`, `agent_error`, `approval_required`, `status_response` | adds `agent_milestone` |
| **Email** | `task_completed`, `task_failed`, `approval_required` | — |
| **GitHub issue comment** | `pr_created`, terminal status (single edit-in-place comment) | — already minimal |

Rationale: if Slack pings on every milestone, users mute the bot within days. The default is the minimal set that reports completion and the events that require a decision. Power users opt into verbose streams.

### 6.3 Slack approval buttons

`approval_required` events delivered to Slack include `Approve` and `Deny` action buttons. On a click, Slack invokes an interaction callback Lambda, which writes to `TaskApprovalsTable` through the same `POST /approvals` path that the CLI uses. A reviewer who is in Slack and not at a terminal, the common case, can then respond with one click.

### 6.4 GitHub issue comment — edit-in-place

Each task has a single comment, edited in place as the agent progresses (terminal states and `pr_created` by default).

**Concurrency:** DDB Streams on `TaskEventsTable` guarantees per-`task_id` ordering upstream through the default `ParallelizationFactor` of 1, which `fanout-consumer.ts` does not set explicitly (see §6.1), and the fanout Lambda is the only writer on its own comment, so concurrent edits of the same comment body are not possible. Last-writer-wins is safe because there is no concurrent writer to lose to. The dispatcher issues a single PATCH per event (no GET round-trip, no conditional headers). If the comment has been deleted upstream (404), the dispatcher falls back to POSTing a fresh comment.

**Tolerated races (bounded, logged, not silenced):**

- *Persist failure after successful POST.* If the GitHub POST succeeds but the subsequent `TaskTable` UpdateItem that persists `github_comment_id` fails non-benignly (for example DDB throttling or an IAM deny), the next event for the same task POSTs a second comment. This is bounded to at most one duplicate per task per failure window (the per-invocation cap stops a runaway). It is logged at ERROR with `error_id: FANOUT_GITHUB_PERSIST_FAILED` so that operators can alarm on it and reconcile. A sweeper that matches on the `bgagent:task-id=` marker body prefix is a post-v1 follow-up.
- *404 → POST race between sibling invocations.* If the previously posted comment was deleted upstream and two consecutive fanout invocations each POST again before either persists the new id, both POSTs succeed. The UpdateItem uses `ConditionExpression: github_comment_id = :prev`, so only the first persist wins. The sibling's `saveCommentState` logs a benign `ConditionalCheckFailedException` at INFO, and the sibling's comment stays on GitHub as an orphan (the `bgagent:` marker makes it reconcilable offline).
- *Transient `loadTaskForComment` failure.* If the GetItem of the task record fails transiently, the `Promise.allSettled` in `routeEvent` records the dispatcher as rejected and the batch continues. Nothing is written. The event is in effect dropped. The next event (for example `task_completed` after `pr_created`) renders the current task state.

**Legacy field:** A previous revision persisted `github_comment_etag` on the TaskRecord. That field is no longer written or read. Items that still carry it from earlier deploys are ignored by the DocumentClient (fields that the type does not declare pass through untouched). No migration is required.

**Why not ETag / `If-Match`:** An earlier revision attempted optimistic concurrency with GitHub's ETag and `If-Match`. In-account validation (PR #52 Scenario 7-extended) proved that this does not work. GitHub's REST API rejects conditional-request headers on `PATCH /issues/comments/{id}` with `HTTP 400 "Conditional request headers are not allowed in unsafe requests unless supported by the endpoint"`. The ETag returned on GET is a cache validator only, and the write endpoint does not honor it. Upstream ordering through the DDB-Stream configuration above is sufficient on its own.

### 6.5 Per-task notification config

The config is submitted with the task (optional) or resolved from the repo defaults:

```jsonc
{
  "notifications": {
    "slack":  { "enabled": true, "channel": "#coding-agents", "events": ["default"] },
    "email":  { "enabled": true, "events": ["approval_required", "task_failed"] },
    "github": { "enabled": true, "events": ["default"] }
  }
}
```

`"default"` resolves to the v1 per-channel defaults above.

---

## 7. Security and trust model

### 7.1 Authentication surfaces

| Surface | Auth | Notes |
|---|---|---|
| CLI → REST API (all endpoints) | Cognito JWT (ID token) | Managed by User Pool |
| GitHub webhook → `POST /webhooks/tasks` | HMAC-SHA256 via request authorizer | Shared secret in Secrets Manager |
| OrchestratorFn → AgentCore Runtime | SigV4 (IAM) | Lambda execution role |
| Agent container → AWS APIs (DDB, S3, Bedrock) | SigV4 via runtime's execution role | Scoped per-runtime |
| Slack button → interaction callback | Slack signing secret | Standard Slack pattern |

### 7.2 Nudge security

- Ownership check: the Lambda verifies that `user_id` (from the Cognito claims) matches the task's `user_id` before it accepts the nudge.
- Rate limit: 10 nudges per task per minute (conditional update on a `RATE#<task>#MINUTE#<bucket>` row).
- Size cap: 2 KB per nudge.
- Guardrail pre-screen: a Bedrock guardrail scans the nudge text for prompt-injection patterns before the nudge is persisted.

### 7.3 Approval security (Phase 3)

- Ownership check on approve and deny.
- Atomic state transition through `TransactWriteItems` (approval row and TaskTable status).
- A recent-decision cache (60 s) prevents retry-loop storms.
- The DenyTaskFn Lambda sanitizes the denial reason (Bedrock output scanner) before it is persisted.

### 7.4 Event table privacy

- Previews are truncated to 200 chars, so the risk of accidental secret capture is low in common cases.
- The runner screens the text of its events before `ProgressWriter` cuts it to a preview: the model's thinking and text, tool input, tool output and the message of a session error. What the output scanner (`agent/src/output_scanner.py`) or the redaction of log lines takes for a credential is replaced by a marker such as `[REDACTED-AWS_KEY]`.
- The `--trace` flag opts into larger previews and S3 trajectory dumps. The S3 objects are written to a user-scoped prefix with a short TTL.

---

## 8. State machine

### 8.1 Core transitions

```
SUBMITTED ──▶ HYDRATING ──▶ RUNNING ──▶ FINALIZING ──▶ COMPLETED
    │              │            │            │
    │              │            │            └──▶ FAILED
    │              │            │            └──▶ TIMED_OUT
    │              │            └──▶ CANCELLED
    │              │            └──▶ AWAITING_APPROVAL (P3)
    │              └──▶ FAILED (stranded)
    └──▶ FAILED (stranded)
```

### 8.2 Phase 3 addition: `AWAITING_APPROVAL`

```
RUNNING ──▶ AWAITING_APPROVAL ──▶ RUNNING    (approve or deny-with-steering)
              │
              ├──▶ CANCELLED    (explicit cancel)
              └──▶ FAILED       (stranded reconciler catches abandoned approval)
```

The `AWAITING_APPROVAL` state holds the user's concurrency slot (paused but alive). See [`CEDAR_HITL_GATES.md`](./CEDAR_HITL_GATES.md) for the full semantics.

### 8.3 Write rules

- Every transition is a conditional DDB write: `#status = :fromStatus`.
- The storage layer rejects illegal transitions (they are not enforced in code).
- The valid-transition table lives in `cdk/src/constructs/task-status.ts`.

---

## 9. Error handling and observability

### 9.1 Fail-open vs fail-closed

| Component | Failure posture | Rationale |
|---|---|---|
| `ProgressWriter` | Fail-open (3-strike circuit breaker) | Event telemetry must never crash the task |
| Nudge/ask rate-limit conditional update | Fail-closed (return 429) | Accurate throttling is a product guarantee |
| Cedar policy evaluation | Fail-closed (treat as DENY) | Security-critical. Unknown outcome = deny |
| Approval poll DDB read | Fail-open with tolerance (10 consecutive failures → TIMED_OUT) | Tolerate transient DDB errors. Fail closed on sustained errors |
| Notification dispatcher | Fail-open (log + DLQ) | A Slack outage must not block the agent |

### 9.2 Unified debugging: event correlation

Every log line, event, and metric carries `task_id`. CloudWatch Logs Insights queries across all Lambdas on `task_id = "abc123"` give the full picture across components.

### 9.3 OpenTelemetry

Each component emits OTEL traces with `task_id` as a baggage item. OrchestratorFn starts the root span. The AgentCore runtime continues it through env-var propagation. Lambdas downstream of DDB Streams resume from the event's `traceparent` attribute.

### 9.4 Dashboards

A CloudWatch dashboard shows the following for each task:
- State transitions timeline
- Event rate by type
- Cost accumulation
- Concurrency slot utilization

### 9.5 Alarms

The alarms the stack deploys notify the `OperationalAlerts` topic. For this design that is the DLQ-depth alarm of the fan-out consumer, the signal that the fail-open notification dispatcher of section 9.1 is losing events. The topic has no subscriber until an operator adds one. See [Alarm notifications](./OBSERVABILITY.md#alarm-notifications).

---

## 10. Debug escape hatch

### 10.1 `--trace` flag

Without live streaming, a developer who debugs a misbehaving agent needs more offline detail than the default 200-char event previews give. The `--trace` flag provides it:

```
$ bgagent submit --trace "fix the auth bug"
```

Changes for a trace-enabled task:
- The `ProgressWriter` preview truncation is raised from 200 chars to 4 KB.
- The full agent trajectory (SDK message log, tool I/O, hook callbacks) is written to S3 on task completion.
- A `trajectory_uploaded` milestone event with the S3 URI is emitted. The CLI can show it at the end of `watch` or `status`.

Storage:
- S3 prefix: `s3://<bucket>/traces/<user_id>/<task_id>.jsonl.gz`.
- TTL: 7 days (lifecycle policy).
- Pre-signed URLs are available through `bgagent trace download <task_id>`.

### 10.2 When to use it

- Reproducible failure modes during development.
- Customer-reported "agent did the wrong thing" incidents.
- Reward-hacking or hallucination audits.

The flag is not intended for routine observability. Use `watch` and notifications for that.

---

## 11. Architectural decisions

Short summaries of the choices that the rest of the design depends on. Each decision is phrased as the chosen option, with a concise rationale.

### AD-1. Single AgentCore Runtime, IAM-authenticated

There is exactly one runtime, which the orchestrator invokes with SigV4. The CLI never talks directly to the runtime.

*Why:* The compute substrate stays portable (a swap to ECS/Fargate requires only orchestrator changes), auth is simpler, and there is one runtime to operate and observe. Direct CLI-to-runtime paths would couple the design to the compute substrate again and force a choice between live stream and durability at submission time.

### AD-2. Polling-only CLI

`bgagent watch`, `bgagent status`, and `bgagent ask` all use REST polling against `TaskEventsTable` with an adaptive interval. No SSE. No WebSockets.

*Why:* Polling is fast enough for interaction latency on a human scale (seconds). DDB costs are trivial. There is no streaming infrastructure to build, operate, or secure. Cursor, GitHub Copilot coding agent, and Codex all use the same pattern.

### AD-3. `TaskEventsTable` as the single event spine

Every durable signal from the agent goes through this table. Every consumer reads from it.

*Why:* The table decouples the agent from every consumer. The CLI, the Slack bot, the GitHub integration, and any future web UI all read the same table and never touch the runtime.

### AD-4. Notification plane as first-class

FanOutConsumer routes events per channel, and v1 ships with per-channel defaults.

*Why:* In an async product, notifications are the primary UX. Shipping without defaults would cause users to mute integrations on day one.

### AD-5. Nudge acknowledgment via combined-turn ack

The between-turns hook emits a `nudge_acknowledged` milestone to `ProgressWriter` **before** it returns `decision: "block"` with the nudge text. The nudge costs one turn (same as today), and the acknowledgment is visible immediately.

*Why:* The Claude Agent SDK does not expose a mechanism to append to system context mid-conversation. The `HookEvent` enum is fixed, and `ClaudeAgentOptions.system_prompt` is set only at construction. `hookSpecificOutput.additionalContext` was recorded here as visible only to the user. With the pinned SDK, a `PostToolUse` or `PostToolUseFailure` hook can hand text to the model through it, attached to the tool result (Appendix A.2). The stuck guard uses that route. A nudge still arrives through the Stop hook. One turn per nudge is the cost of the Stop-hook path. We state that cost instead of presenting the nudge as free.

### AD-6. `bgagent status` is deterministic; `bgagent ask` is the agent

`status` is a templated Lambda that reads `TaskEventsTable`. `ask` is a real question to the agent. It always costs a turn and always has latency.

*Why:* Users understand the difference between reading a dashboard and asking a question of an entity that thinks. One command per contract is clearer than one command with a flag that silently changes the execution model.

### AD-7. `bgagent ask` foreground block-and-poll

The default UX blocks with a spinner that shows the current agent activity. The ask is durable. A CLI disconnect does not cancel the ask or lose the answer.

*Why:* This matches the user's expectation of a synchronous CLI call and survives a closed laptop. The spinner shows the bounded but non-trivial latency (turns can take minutes), so the wait does not look like a hang.

### AD-8. HITL: hard gates only in v1

Phase 3 ships hard gates. It has no soft questions and no "proceed with default if no response" semantics.

*Why:* A soft question with a timeout gives the user a deadline, which is hostile to an async workflow. "Gate or no gate" is the coherent choice. A future `effect: "advise"` tier (non-blocking FYI events, no timeout) is documented in the Phase 3 design as post-v1.

### AD-9. GitHub edit-in-place via DDB-Stream ordering, not SQS FIFO

DDB Streams on `TaskEventsTable` give per-`task_id` ordering through the **default** `ParallelizationFactor` of 1. The code relies on this default and does not set it explicitly. `cdk/src/constructs/fanout-consumer.ts` configures the `DynamoEventSource` without `parallelizationFactor`. To make the ordering guarantee hold if the default changes, set `parallelizationFactor: 1` explicitly. The fanout Lambda is the only writer on its own comment, so no concurrent writer exists to race, and last-writer-wins is safe. The dispatcher PATCHes directly (no GET-then-PATCH, no conditional headers).

*Why:* This is simpler than SQS FIFO (no queue, no DLQ, no per-group throughput ceiling) and has lower latency than a GET-then-PATCH round-trip.

*Rejected alternative, `If-Match` ETag:* An earlier revision of this design used optimistic concurrency through GitHub's ETag. Deploy-validation (PR #52 Scenario 7-extended) proved that `PATCH /issues/comments/{id}` rejects `If-Match` with HTTP 400 (`"Conditional request headers are not allowed in unsafe requests unless supported by the endpoint"`). The ETag returned on GET is a cache validator only. Upstream DDB-Stream ordering makes the ETag unnecessary anyway.

### AD-10. Stranded-task reconciler with a unified timeout

One timeout value covers all stranded cases (orchestrator crash, container crash, general abandonment).

*Why:* The interactive-specific timeout went away with the interactive path. One reconciler with one threshold is easier to reason about.

### AD-11. Agent-side hydration (hybrid split; partially deferred)

Blueprint merging, repo config, PAT retrieval, and prompt assembly are targeted for the agent container at startup, not the orchestrator Lambda.

*Why:* Hydration artifacts (cloned repos, merged blueprints, rendered prompts) are large and needed only inside the runtime. Failures belong inside the durable 8 h runtime, not in a 15 min Lambda. The runtime already has the IAM it needs for those reads. Industry precedent (Cursor background agents, GitHub Copilot coding agent, Devin, Temporal's activity-worker pattern, LangGraph's queue-worker split) converges on worker-side hydration for long-running async agents.

*Target shape, hybrid split:* keep the **cheap preflight** in the orchestrator (PAT validity check, repo-existence check, guardrail screen on the raw `task_description`) so that a task still fails fast before it uses an AgentCore compute slot. Move the **heavy I/O hydration** (GitHub issue / PR fetch including review threads, prompt assembly, Memory retrieval, S3 blueprint reads) into the agent container.

*Status (2026-04-30):* **deferred to a follow-up PR**, tracked at [upstream issue #53](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/53). Rev-6 ships with full hydration still in the orchestrator Lambda. Reasons: (a) the move is pure architectural relocation with no user-visible change, (b) the port is about 2,700 lines (1,190 LOC of `context-hydration.ts` and 1,514 LOC of tests) and requires new boto3 clients in the container and a GraphQL GitHub client, (c) PR #52 already ships 10,000+ lines of changes across the SSE removal, and adding hydration would make that PR harder to review. The Pydantic `SUPPORTED_HYDRATED_CONTEXT_VERSION` gate in `agent/src/models.py` bounds drift risk during the deferral window.

### AD-12. `--trace` as the debug escape hatch

Opt-in per task: 4 KB previews and the full trajectory to S3 with a TTL.

*Why:* Without live streaming, debugging needs a more detailed offline artifact. Because the flag is opt-in, storage costs for normal tasks stay flat.

---

## 12. Implementation phases

### Phase 1 — v1 PR

- Single orchestrator path. Delete all direct-SSE, two-runtime, and interactive-mode infrastructure
- `bgagent status` (deterministic)
- `bgagent watch` with adaptive polling interval
- `bgagent nudge` with combined-turn acknowledgment
- FanOutConsumer router and per-channel default filters
- GitHub edit-in-place dispatcher (DDB-Stream ordering, 404 → POST fallback)
- Stub Slack and email dispatchers (log-only, ready for real integration in Phase 2)
- Unified stranded-task reconciler timeout
- `--trace` debug flag

### Phase 2 — Ask + first real notifications

- `bgagent ask` end-to-end (REST, agent-side between-turns hook, foreground block-and-poll CLI, durability-on-disconnect)
- Real Slack dispatcher (webhook + action buttons → approval callback Lambda)
- Per-task notification config and `bgagent notifications configure`

### Phase 3 — Cedar HITL

- Hard-gate approval gates with Cedar policy evaluation
- `bgagent approve` / `deny` / `pending` / `policies`
- `AWAITING_APPROVAL` state and orchestrator handling
- Full design in [`CEDAR_HITL_GATES.md`](./CEDAR_HITL_GATES.md)

### Phase 4 — Dispatcher polish

- Real email dispatcher (SES)
- Real GitHub dispatcher (beyond the v1 edit-in-place stub)
- Per-repo default notification config
- `--verbose` opt-in for milestone-level events
- Dashboard widgets for notification delivery health

### Deferred

- **LLM-synthesized status summary.** `bgagent ask` without targeting the agent. A Lambda calls an LLM to narrate the state. It has cost and hallucination trade-offs. Revisit it if v1 feedback warrants. Tracked as a [GitHub issue](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues) under **Smart progress updates**.
- **Cedar `effect: "advise"` tier.** A non-blocking FYI policy tier for post-v1. [`CEDAR_HITL_GATES.md`](./CEDAR_HITL_GATES.md) has a design sketch.
- **Outbound WebSocket from agent.** Only if a concrete sub-200 ms latency requirement appears. Agent-initiated egress avoids dual-auth problems and works on any compute.
- **Multi-user watch.** Multiple users attached to the live event stream of the same task (teams).

---

## 13. Open questions

| ID | Question | Owner |
|---|---|---|
| Q1 | Retention policy for `--trace` S3 artifacts. 7 days or 30? Size cap per user? | Design |
| Q2 | Should `bgagent pending` (Phase 3) show all pending approvals across all of a user's tasks, or filter to a single `task_id`? | Phase 3 impl |
| Q3 | Slack action button callbacks. What is the rotation strategy for the Slack signing secret? | Phase 2 impl |
| Q4 | Per-repo default notification config precedence vs per-task overrides. Does per-task always win? Partial overrides? | Phase 4 impl |
| Q5 | `bgagent ask` concurrent limit. Do we expose `--queue` semantics to explicitly enqueue vs 429? | Phase 2 impl |

---

## Appendix A — Claude Agent SDK reference

Pinned version: `claude-agent-sdk==0.2.179` (Python, see `agent/pyproject.toml`).

> **Caution, re-verify against 0.2.x.** The hook-surface details in this
> appendix (the `HookEvent` enum members, `PostToolUseFailure`, the Stop-hook
> return-value contract, and others) were originally written against
> `claude-agent-sdk==0.1.53`. The pin has since advanced to `0.2.179`, and the
> SDK's hook API may have changed across that range. Before you rely on any
> specific enum member or hook signature below, verify it against the installed
> 0.2.x SDK and the actual usage in `agent/src/hooks.py`.

### A.1 Hook surface (verify against 0.2.x — originally documented for v0.1.53)

`HookEvent` enum: `PreToolUse | PostToolUse | PostToolUseFailure | UserPromptSubmit | Stop | SubagentStart | SubagentStop | PreCompact | PermissionRequest | Notification`.

Our usage:
- `PreToolUse` runs the Cedar policy evaluation (Phase 3), a `can_use_tool`-style allow or deny. A call that needs an approval waits here for the decision.
- `PostToolUse` runs the output scanner (secret and PII redaction). The egress-denial detector and the stuck guard see every tool call that completed.
- `PostToolUseFailure` runs the egress-denial detector and the stuck guard for a tool call that failed. The CLI fires this event, and no `PostToolUse`, for such a call. For Bash, such a call is a command that exits non-zero, unless the CLI reads that status as an answer, such as 1 from `grep` without a match.
- `Stop` (between-turns) runs `_cancel_between_turns_hook`, `_nudge_between_turns_hook`, and `_denial_between_turns_hook` (deny-with-steering), in this order.

### A.2 Between-turns injection mechanism

Stop hook return values:
- `{}` is a no-op. The SDK proceeds to stop or loop.
- With `{"decision": "block", "reason": "<text>"}`, the SDK emits `reason` as a synthetic user turn, and the agent responds on its next iteration.

This is the mechanism that nudges and deny-with-steering use to inject agent-visible text mid-conversation. Implications:
- Every nudge, ask, and deny-with-steering costs one turn of `max_turns`.
- No "append to system prompt mid-run" API exists. `ClaudeAgentOptions.system_prompt` is set at construction.

A hook that runs after a tool call can hand text to the model as well. With the pinned SDK (0.2.179, CLI 2.1.319), `hookSpecificOutput.additionalContext` returned by a `PostToolUse` or `PostToolUseFailure` hook reaches the model. The CLI sends it with the tool result, in the same request, as a system reminder, so it costs no turn. The stuck guard's advisory about a failing command that the agent keeps repeating is delivered this way (`_observe_tool_result` in `agent/src/hooks.py`), because an agent that keeps calling tools never reaches the Stop hook. This appendix used to say that such text does not reach the model's context (GitHub issues `claude-code#18427`, `claude-code#19643`). That does not hold for the pinned version.

### A.3 Mid-run cancellation

`ClaudeSDKClient.interrupt()` cancels the current turn without rolling back prior tool results. Our cancel path uses it together with the `cancellation_requested` flag on the `TaskRecord`.

---

## Appendix B — AgentCore Runtime reference

### B.1 Service contract

- HTTP on port 8080: `/invocations` (JSON and an optional SSE response), `/ping` (liveness).
- `/ping` returning `"HealthyBusy"` signals an active session and prevents idle eviction.
- `maxLifetime` and `idleRuntimeSessionTimeout` are both configurable up to 8 hours. We set both to the maximum.

### B.2 Invocation

`bedrock-agentcore:InvokeAgentRuntime` is a SigV4-authenticated API call from the orchestrator. The payload is the task context. The response is ignored (fire-and-forget).

### B.3 Session management

The same `runtimeSessionId` routes to the same MicroVM **within the same runtime ARN**. We use this property for the agent's own internal resumability. A re-invocation with the same session ID reaches the same container if that container is still alive. We never use the property to attach the CLI directly to the runtime, which we don't do.

---

## Appendix C — Competitive landscape

Products surveyed for interaction patterns (primary sources: product docs, engineering blogs):

| Product | Interaction model | Notes |
|---|---|---|
| **Devin (Cognition)** | Slack-thread chat during execution, fully async notifications | Closest analog. Mid-run Q&A through in-thread messages is a shipped feature |
| **GitHub Copilot coding agent** | Fire-and-forget. Progress visible as commits and PR activity | No mid-run steering. Notifications through GitHub itself |
| **OpenAI Codex (cloud)** | SSE in web UI. External view is polling. No mid-run course-correction | Explicitly documents inability to steer mid-run |
| **Replit Agent** | Task board UI. User checks progress. No live terminal stream | Novel: automated "Decision-Time Guidance" (internal classifier-driven steering) |
| **Cursor background agents** | Pure fire-and-forget. User manually checks state | No built-in completion notifications (open feature request) |

Key observations:
- Fire-and-forget with notifications is the dominant pattern for long-running coding agents.
- Mid-run steering exists only where there is a persistent conversation channel (Devin's Slack thread). Our `bgagent nudge` and `bgagent ask` are the equivalent.
- No product ships "proceed with default if no response" for approval gates. Products ship hard gates or no gates.
- Polling-based observation is ubiquitous, and users tolerate it well at minute-to-hour task durations.
