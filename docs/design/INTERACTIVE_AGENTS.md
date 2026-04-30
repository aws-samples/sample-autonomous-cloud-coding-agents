# Interactive Agents: Async Interaction Design

> **Status:** Active design
> **Branch:** `feature/interactive-background-agents`
> **Last updated:** 2026-04-29 (rev 6)

---

## Executive summary

ABCA runs background coding agents that clone a repo, implement a task, run tests, and open a pull request. Tasks run from minutes to hours inside an isolated cloud runtime. The interaction model is **asynchronous by design**: users submit a task and move on; the agent works without supervision; results arrive through notifications (Slack / GitHub comment / email) and as pull requests.

This document describes the interactivity surfaces layered on top of that model — how users **check in on**, **steer**, and **gate** running agents without requiring a live connection to the compute substrate.

### Interaction capabilities

1. **Submit** — `POST /tasks` with a repo and task description. Fire-and-forget by default; the CLI returns a `task_id` and exits.
2. **Status** — `bgagent status <id>` returns a deterministic, templated snapshot of current state (last milestone, current turn, elapsed time, cost so far). Backed by a Lambda reading `TaskEventsTable`; no LLM, no hallucination, no agent interruption.
3. **Watch** — `bgagent watch <id>` polls `TaskEventsTable` with an adaptive interval (500 ms when events are arriving, back-off to 5 s when idle). Same endpoint used under the hood for foreground-block UX on `ask` and for HITL approval waits.
4. **Nudge** — `bgagent nudge <id> "<text>"` writes a row into `TaskNudgesTable`. The agent reads pending nudges between turns, acknowledges with a `nudge_acknowledged` milestone event, and integrates the nudge on its next turn.
5. **Ask** — `bgagent ask <id> "<question>"` (Phase 2) writes a question row. The agent answers at the next between-turns boundary; the answer surfaces as a `status_response` event. CLI default is foreground block-and-poll with a spinner; task and answer are both durable if the CLI disconnects.
6. **Approval gates** — Phase 3 Cedar-driven hard gates. Agent emits `approval_requested`, waits for a decision from `bgagent approve` / `bgagent deny` or a Slack button-press. Detailed design in `PHASE3_CEDAR_HITL.md`.

### Core architectural choices

- **Single AgentCore Runtime** authenticated via IAM (SigV4) from the orchestrator Lambda. No JWT-authenticated runtime, no direct CLI-to-runtime path.
- **Durable event table (`TaskEventsTable`)** is the one source of truth for agent progress. Every reader — CLI, Slack/GitHub/email dispatchers, status Lambda — reads from this table, never from the live agent.
- **Polling-only CLI.** No SSE, no WebSockets. DDB eventually-consistent reads with an `event_id` cursor are cheap, reliable, and compute-agnostic.
- **Notification plane as first-class.** A FanOutConsumer Lambda subscribes to `TaskEventsTable` DDB Streams and routes per-event-type to per-channel dispatcher Lambdas (Slack, email, GitHub comment). Per-channel defaults ship in v1.
- **Agent interaction via the hook mechanism the Claude Agent SDK provides.** Nudges, asks, and approvals all use `Stop` / between-turns hooks; no mechanism outside the SDK's contract is required.

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

- **Compute-agnostic.** Nothing in the interaction surface depends on a specific compute substrate. The agent could run on AgentCore today and ECS tomorrow with no changes to the CLI or notification plane.
- **Survive disconnect.** Every interaction is durable in DynamoDB. A CLI crash, a closed laptop, or a flaky network never kills a task and never loses a reply.
- **Fire-and-forget by default.** Users submit and move on. Active observation is opt-in through `status`/`watch`.
- **No UX choice at submission time.** There is exactly one submit command and one observation command. Users do not pick between "resilient" and "live" when they submit.
- **Notification as first-class.** When the agent needs a human (approval gate, ask response, task completion), it reaches the user through their configured channel — not by hoping the user is watching a terminal.

### Explicit non-goals

- Token-by-token live streaming. Users want to know *what step* the agent is on, not *what character* it's typing.
- Sub-200 ms interaction latency. Human interaction in an async coding workflow is calibrated to seconds, not milliseconds.
- Transactional undo of agent actions. Tool calls are committed; the agent cannot retroactively revert a filesystem change because a user objected after the fact.
- Pair-programming / co-edit modes. A different product shape.

### Requirements traceability

| Req | Covered by |
|---|---|
| R1. Users don't pick compute or observability at submission | Single submit command; `TaskEventsTable` is compute-agnostic |
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

- **One write path in, one read path out.** Every durable agent signal lands in `TaskEventsTable` (or `TaskTable` for state transitions). Every consumer reads from there.
- **Orchestrator is the only substrate-aware component.** Replace `InvokeAgentRuntime` with `ecs:RunTask` and the CLI + notification plane don't notice.
- **No client holds a live connection to the agent.** `watch` is a polling loop against `TaskEventsTable`, not a stream from the runtime.

---

## 3. Components

### 3.1 AgentCore Runtime (IAM-authenticated)

A single AgentCore Runtime, invoked via `bedrock-agentcore:InvokeAgentRuntime` with SigV4 from the orchestrator Lambda. No JWT authorizer; no direct CLI access.

- **Input:** task payload from orchestrator (task_id, repo, task_description, optional initial_approvals, optional trace_flag)
- **Output:** none via response stream — the runtime is invoked fire-and-forget. All observable state flows through `TaskEventsTable` and `TaskTable`.
- **Lifecycle:** `idleRuntimeSessionTimeout` and `maxLifetime` both set to 8 hours (AgentCore max). A running task holds the session; an idle runtime is evicted by AgentCore.
- **Compute substitutability:** replacing this with ECS/Fargate is a change confined to the orchestrator + the AgentCore Runtime CDK construct. Nothing else in the system observes the difference.

### 3.2 OrchestratorFn

Durable-execution Lambda that owns the task lifecycle from submission to terminal state.

Responsibilities:
- **Admission control** — atomic DDB conditional update on `UserConcurrencyTable` (`active_count < max`); reject with 429 if over quota.
- **State transition** `SUBMITTED → HYDRATING → RUNNING → FINALIZING → terminal`.
- **Invocation** — calls `InvokeAgentRuntime` with SigV4.
- **Poll loop** — waits for the agent to land a terminal status in `TaskTable`; enforces heartbeat watchdog; transitions to `FAILED` if the container dies.
- **Finalize** — TTL + concurrency decrement + synthesized terminal event.

Hydration (blueprint merge, repo config, PAT retrieval, prompt assembly) happens **inside the agent container at startup**, not in the orchestrator. This keeps the orchestrator thin, lets heavy I/O fail inside a durable 8 h runtime rather than a 15 min Lambda, and gives the runtime container the IAM it needs for those reads anyway.

### 3.3 SubmitTaskFn

Validates a submission, writes the `TaskRecord` with `status=SUBMITTED`, emits a `task_created` event, and async-invokes `OrchestratorFn`.

- Single path for all tasks. No `execution_mode` branching.
- Works identically for CLI-initiated submissions (Cognito JWT) and webhook-initiated submissions (HMAC, after the webhook authorizer).

### 3.4 TaskEventsTable

The durable event spine. PK = `task_id`, SK = `event_id` (ULID), TTL enabled, **DDB Streams enabled** (`NEW_IMAGE`).

Writers:
- `ProgressWriter` (inside the agent container) — per tool call, per turn, per milestone, cost updates, errors.
- `OrchestratorFn` — `task_created`, `hydration_*`, `session_started`, `task_*`, `preflight_*`, `admission_rejected`, `guardrail_blocked`.
- Cancel/reconciler handlers — `task_cancelled`, `task_stranded`.

Readers:
- `get-task-events` Lambda (backs `bgagent watch` and `bgagent events`).
- `bgagent status` Lambda (templated snapshot).
- `FanOutConsumer` (stream-subscribed; see §6).

Cost profile is negligible: eventually-consistent queries with a cursor return ~0.5 RCU per page. 50 simultaneous watchers polling every 2 seconds is pennies per active hour.

### 3.5 TaskTable

Task state machine: `SUBMITTED → HYDRATING → RUNNING → FINALIZING → {COMPLETED, FAILED, CANCELLED, TIMED_OUT}` with Phase 3 adding `AWAITING_APPROVAL`.

Writers: create-task, orchestrator, cancel, agent pipeline (terminal write), reconcilers. Transitions are conditional DDB writes; illegal transitions are rejected.

### 3.6 TaskNudgesTable

PK = `task_id`, SK = `nudge_id`. A row represents a pending user steering message.

Producer: `POST /tasks/{id}/nudge` handler (after ownership check, guardrail scan, and rate-limit conditional update).
Consumer: agent between-turns hook reads pending nudges, emits `nudge_acknowledged` milestone, and injects the nudge text into the next turn via `decision: "block"`.

### 3.7 TaskApprovalsTable (Phase 3)

Phase 3 approval-request spine. Detailed schema in `PHASE3_CEDAR_HITL.md`. Semantics summary:
- Agent writes an approval row with the request context.
- Agent transitions `RUNNING → AWAITING_APPROVAL` and enters a poll loop.
- User responds via REST (`POST /tasks/{id}/approvals/{request_id}`) or via a Slack button dispatched by the notification plane.
- On decision, agent transitions back to `RUNNING`; denial reasons are injected as Stop-hook steering on the next turn.

### 3.8 FanOutConsumer (router)

Lambda subscribed to `TaskEventsTable` DDB Streams (`ParallelizationFactor: 1`, preserving per-`task_id` ordering by shard). Reads per-task notification config (from `TaskTable` metadata or `RepoTable` defaults), filters events by channel subscription, and invokes per-channel dispatcher Lambdas.

- **SlackDispatchFn** — posts to configured channel / DM. Includes action buttons for `approval_required` events.
- **EmailDispatchFn** — SES.
- **GitHubDispatchFn** — edits a single GitHub issue comment in place via `PATCH /repos/{o}/{r}/issues/comments/{id}` with `If-Match` ETag; on 412 Precondition Failed, re-GETs and retries.

Detailed routing and default filters in §6.

### 3.9 Reconcilers

Two scheduled Lambdas that backstop the state machine:

- **Stranded-task reconciler** (every 5 min) — catches tasks stuck in non-terminal states past a unified timeout (`STRANDED_TIMEOUT_SECONDS=1200` default). Covers `OrchestratorFn` async-invoke crashes and container crashes. Transitions stuck tasks to `FAILED` with a `task_stranded` event.
- **Concurrency reconciler** (every 15 min) — recomputes `active_count` per user by querying the `UserStatusIndex` GSI and corrects drift in `UserConcurrencyTable`.

### 3.10 CLI (`bgagent`)

Commands:
- `submit` — fire-and-forget; returns `task_id`.
- `status <id>` — templated snapshot.
- `watch <id>` — adaptive polling loop.
- `events <id>` — raw event stream (debug).
- `nudge <id> "<text>"` — steer.
- `cancel <id>` — stop the task.
- `ask <id> "<question>"` (Phase 2) — ask the agent a question.
- `approve <id>` / `deny <id>` / `pending` / `policies` (Phase 3) — HITL.

Authentication: Cognito User Pool ID token in `Authorization` header for all REST calls. Token caching in `~/.bgagent/credentials.json` with auto-refresh.

---

## 4. Event model

### 4.1 Schema

`TaskEventsTable` row:

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
| `agent_turn` | Runner | One model-roundtrip completed; includes turn number, model, thinking preview |
| `agent_tool_call` | Runner / PreToolUse hook | About to invoke a tool |
| `agent_tool_result` | Runner / PostToolUse hook | Tool returned |
| `agent_milestone` | Agent code (pipeline, hooks) | Named checkpoint (`repo_cloned`, `pr_opened`, `nudge_acknowledged`, ...) |
| `agent_cost_update` | Runner | Cumulative token + dollar cost |
| `agent_error` | Runner | Handled exception |
| `approval_required` (P3) | PreToolUse Cedar hook | Cedar policy requires user decision |
| `approval_decided` (P3) | Approve/Deny Lambda | User responded |
| `status_response` (P2) | Between-turns hook | Agent answered an `ask` |
| `nudge_acknowledged` | Between-turns hook | Agent saw a nudge before incorporating it |
| `pr_created` | Pipeline | PR opened for the task |
| `task_completed` / `task_failed` / `task_cancelled` / `task_stranded` | Orchestrator / reconciler | Terminal |

### 4.3 Previews and truncation

Text fields (thinking, tool input, tool output, error details) are truncated to 200 characters by default to keep event rows small. The `--trace` flag raises the cap to 4 KB and additionally writes a full trajectory to S3 (see §10).

### 4.4 Cursor semantics

Consumers page `TaskEventsTable` using `event_id` as a cursor: `KeyConditionExpression: task_id = :id AND event_id > :cursor`, `ConsistentRead: true`. ULID sort order is time-monotonic, so lexical comparison gives time ordering.

---

## 5. User interactions

### 5.1 `bgagent submit`

```
$ bgagent submit --repo org/repo "fix the auth timeout bug"
task submitted: abc123
```

Writes `TaskRecord`, fires orchestrator, returns. The CLI does not wait. `--wait` flag is available for scripting (blocks until terminal state, returns non-zero on failure).

### 5.2 `bgagent status`

Deterministic, templated snapshot. No LLM.

```
$ bgagent status abc123
Task abc123 — RUNNING (3m 14s elapsed)
  Repo: org/repo
  Turn: 7 / ~12
  Last milestone: nudge_acknowledged (42s ago)
  Current: Bash tool call
  Cost: $0.18 / budget $2.00
  Last event: 2026-04-29T15:30:12Z
```

Implementation:
- Lambda reads the last N events from `TaskEventsTable` + current `TaskRecord`.
- Renders from a fixed template. Never calls an LLM. Never hallucinates.
- Fast (<200 ms P95), free, safe to call repeatedly.

### 5.3 `bgagent watch`

Polling loop against `GET /tasks/{id}/events?after=<cursor>` with **adaptive interval**:

- Start at 500 ms.
- If a poll returns ≥1 event, keep at 500 ms.
- If a poll returns 0 events, back off: 1 s, 2 s, 5 s (cap).
- Reset to 500 ms on the next event.

Renders events as they arrive. Exits on terminal status. Cursor is the last `event_id` seen.

Cost profile: 50 simultaneous watchers × ~0.5 RCU per empty poll × 5 s intervals when idle ≈ negligible.

### 5.4 `bgagent nudge`

```
$ bgagent nudge abc123 "also fix the logging module, separate commit"
nudge queued: nudge_01JX...
```

Flow:
1. CLI `POST /tasks/{id}/nudge` → rate-limit conditional update + `PutItem` in `TaskNudgesTable`.
2. Agent's Stop hook fires between turns. Calls `nudge_reader.read_pending(task_id)` — returns all pending nudges for this task (concatenated into one `<user_nudge>` block if multiple).
3. Hook emits `nudge_acknowledged` milestone to `ProgressWriter` **before** returning to the SDK. User sees this event immediately via `watch` or Slack.
4. Hook returns `{"decision": "block", "reason": <formatted_nudge_text>}`. The SDK treats this as the start of the next user turn; the agent incorporates the nudge on its response.
5. Nudge row is marked consumed via conditional update (`consumed_at` set only if currently null).

**Cost model — honest:** the nudge burns one turn from the task's `max_turns` budget. The acknowledgment rides in the same turn (the combined-turn ack pattern). This is the only mechanism the Claude Agent SDK exposes for injecting user-visible text mid-run; there is no "append to system prompt mid-conversation" API (see Appendix A).

### 5.5 `bgagent ask` (Phase 2)

Ask the agent a natural-language question that requires its own reasoning. Always burns a turn. Always has latency (bounded above by the agent's current turn duration, which can be minutes).

**CLI default: foreground block-and-poll with a spinner.**

```
$ bgagent ask abc123 "why did you change the retry logic?"
⠋ queued as ask_01JX... — waiting for agent
⠙ agent is running tool: Bash (turn 7/~12) — 42s elapsed
✓ agent responded (1m 14s)

The existing retry used exponential backoff with no jitter, causing thundering
herd under load. Added jitter to spread retries across the window.
```

Flow:
1. CLI `POST /tasks/{id}/asks` → `{ask_id, cursor}`.
2. CLI polls `GET /events?after=<cursor>&type=status_response&correlation_id=<ask_id>` with adaptive interval.
3. Spinner renders last `agent_turn` / `agent_tool_call` so the user sees the agent is alive.
4. Agent's between-turns hook reads the pending ask, injects it as a user turn via `decision: "block"`, agent answers, hook emits `status_response{ask_id, content, turn}`.
5. CLI prints the response and exits.

Flags:
- default → foreground block
- `--no-wait` → returns `ask_id` immediately; response delivered via Slack/watch
- `--timeout N` → override default 5 min (hard cap 10 min)

**Durability:** the ask row lives in DDB regardless of CLI state. If the user Ctrl-Cs or the terminal closes, the ask still executes; the response is retrievable via `bgagent asks show <ask_id>`, `bgagent watch`, or Slack.

**Rate limit:** 1 open ask per task per user (429 otherwise). Forward-compatible with multi-user team scenarios.

### 5.6 `bgagent approve` / `deny` / `pending` / `policies` (Phase 3)

HITL approval commands. All flows are REST + DDB; no streaming. Detailed design in `PHASE3_CEDAR_HITL.md`. Summary:

- Agent emits `approval_required` with the tool context.
- Notification plane dispatches the event (Slack with action buttons, email, GitHub).
- User responds via `bgagent approve <id>`, `bgagent deny <id> --reason "…"`, or Slack button click.
- Agent's poll loop sees the decision and proceeds or deny-steers.

### 5.7 `bgagent cancel`

Writes `cancellation_requested` flag on `TaskRecord`; agent's between-turns hook checks it and terminates. Agent's PR-short-circuit logic commits partial work before exit.

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

- Single Lambda subscribes to the DDB Stream. Stateless; fails-forward into SQS DLQ on per-event errors.
- `ParallelizationFactor: 1` on the event-source mapping → per-`task_id` shard ordering preserved for free.
- Router reads per-task notification config (channel enablement + event-type filters), then invokes the relevant dispatcher Lambda(s) per event.
- Dispatchers are separate Lambdas so a GitHub API outage doesn't block Slack notifications.

### 6.2 Per-channel defaults (v1)

| Channel | Default subscribed events | Opt-in via `--verbose` |
|---|---|---|
| **Slack** | `task_completed`, `task_failed`, `task_cancelled`, `pr_created`, `agent_error`, `approval_required`, `status_response` | adds `agent_milestone` |
| **Email** | `task_completed`, `task_failed`, `approval_required` | — |
| **GitHub issue comment** | `pr_created`, terminal status (single edit-in-place comment) | — already minimal |

Rationale: if Slack pings on every milestone, users mute the bot within days. Default to the minimal set that surfaces decision-requiring events and completion; power users opt into verbose streams.

### 6.3 Slack approval buttons

`approval_required` events delivered to Slack include `Approve` / `Deny` action buttons. On click, Slack invokes an interaction callback Lambda which writes to `TaskApprovalsTable` via the same `POST /approvals` path the CLI uses. This gives the common case (reviewer in Slack, not at a terminal) a one-click response path.

### 6.4 GitHub issue comment — edit-in-place

A single comment per task, edited in place as the agent progresses (terminal states + `pr_created` by default). Concurrency is handled with GitHub's `If-Match` ETag on `PATCH /issues/comments/{id}`: on 412 Precondition Failed, re-GET and retry. This avoids the need for SQS FIFO serialization; DDB Stream ordering + ETag optimistic concurrency is sufficient.

### 6.5 Per-task notification config

Submitted with the task (optional) or resolved from repo defaults:

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

- Ownership check: the Lambda verifies `user_id` (from Cognito claims) matches the task's `user_id` before accepting the nudge.
- Rate limit: 10 nudges per task per minute (conditional update on a `RATE#<task>#MINUTE#<bucket>` row).
- Size cap: 2 KB per nudge.
- Guardrail pre-screen: Bedrock guardrail scans nudge text for prompt-injection patterns before persisting.

### 7.3 Approval security (Phase 3)

- Ownership check on approve/deny.
- Atomic state transition via `TransactWriteItems` (approval row + TaskTable status).
- Recent-decision cache (60 s) prevents retry-loop storms.
- Denial reason sanitized by the DenyTaskFn Lambda (Bedrock output scanner) before persisting.

### 7.4 Event table privacy

- Previews truncate to 200 chars → low risk of accidental secret capture in common cases.
- Agent-side output scanners redact secrets before calling `ProgressWriter`.
- `--trace` flag opts into larger previews + S3 trajectory dumps; S3 objects are written to a user-scoped prefix with short TTL.

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

The `AWAITING_APPROVAL` state holds the user's concurrency slot (paused but alive). See `PHASE3_CEDAR_HITL.md` for full semantics.

### 8.3 Write rules

- Every transition is a conditional DDB write: `#status = :fromStatus`.
- Illegal transitions are rejected at the storage layer (not enforced in code).
- The valid-transition table lives in `cdk/src/handlers/shared/task-status.ts`.

---

## 9. Error handling and observability

### 9.1 Fail-open vs fail-closed

| Component | Failure posture | Rationale |
|---|---|---|
| `ProgressWriter` | Fail-open (3-strike circuit breaker) | Event telemetry must never crash the task |
| Nudge/ask rate-limit conditional update | Fail-closed (return 429) | Accurate throttling is a product guarantee |
| Cedar policy evaluation | Fail-closed (treat as DENY) | Security-critical; unknown outcome = deny |
| Approval poll DDB read | Fail-open with tolerance (10 consecutive failures → TIMED_OUT) | Tolerate transient DDB errors; fail closed on sustained |
| Notification dispatcher | Fail-open (log + DLQ) | A Slack outage must not block the agent |

### 9.2 Unified debugging: event correlation

Every log line, event, and metric carries `task_id`. CloudWatch Logs Insights queries across all Lambdas on `task_id = "abc123"` give the full cross-component picture.

### 9.3 OpenTelemetry

Each component emits OTEL traces with `task_id` as a baggage item. OrchestratorFn starts the root span; AgentCore runtime continues it via env-var propagation; Lambdas downstream of DDB Streams resume from the event's `traceparent` attribute.

### 9.4 Dashboards

CloudWatch dashboard shows, per task:
- State transitions timeline
- Event rate by type
- Cost accumulation
- Concurrency slot utilization

### 9.5 Alarms

Currently deferred — no operational notification channel exists for this project beyond Slack/email user-facing notifications. When an ops channel is added (SNS/PagerDuty), the alarm plumbing is a small follow-up; the metric data is already flowing.

---

## 10. Debug escape hatch

### 10.1 `--trace` flag

Without live streaming, a developer debugging a misbehaving agent needs a richer offline view than the default 200-char event previews. The `--trace` flag:

```
$ bgagent submit --trace "fix the auth bug"
```

Changes for a trace-enabled task:
- `ProgressWriter` preview truncation raised from 200 chars → 4 KB.
- Full agent trajectory (SDK message log, tool I/O, hook callbacks) written to S3 on task completion.
- A `trajectory_uploaded` milestone event with the S3 URI is emitted; the CLI can surface it at the end of `watch` or `status`.

Storage:
- S3 prefix: `s3://<bucket>/traces/<user_id>/<task_id>.jsonl.gz`.
- TTL: 7 days (lifecycle policy).
- Pre-signed URLs available via `bgagent trace download <task_id>`.

### 10.2 When to use it

- Reproducible failure modes during development.
- Customer-reported "agent did the wrong thing" incidents.
- Reward-hacking / hallucination audits.

Not intended for routine observability — that's what `watch` and notifications are for.

---

## 11. Architectural decisions

Short summaries of the load-bearing choices. Each decision is phrased as the chosen option; rationales are concise.

### AD-1. Single AgentCore Runtime, IAM-authenticated

Exactly one runtime, invoked via SigV4 from the orchestrator. The CLI never talks directly to the runtime.

*Why:* Compute-substrate portability (ECS/Fargate swap requires only orchestrator changes); simpler auth; one runtime to operate and observe. Direct CLI-to-runtime paths would reintroduce substrate coupling and force a choice between live-stream and durability at submission time.

### AD-2. Polling-only CLI

`bgagent watch` / `bgagent status` / `bgagent ask` all use REST-polling against `TaskEventsTable` with an adaptive interval. No SSE. No WebSockets.

*Why:* Human-scale interaction latency (seconds) is well-served by polling; DDB costs are trivial; no streaming infrastructure to build, operate, or secure. Cursor, GitHub Copilot coding agent, and Codex all use the same pattern.

### AD-3. `TaskEventsTable` as the single event spine

Every durable signal from the agent flows through this table. Every consumer reads from it.

*Why:* Decouples the agent from every consumer. CLI, Slack bot, GitHub integration, and any future web UI all read the same substrate without touching the runtime.

### AD-4. Notification plane as first-class

FanOutConsumer routes events per-channel with sensible defaults shipping in v1.

*Why:* In an async product, notifications are the primary UX. Shipping without defaults would cause users to mute integrations on day one.

### AD-5. Nudge acknowledgment via combined-turn ack

The between-turns hook emits a `nudge_acknowledged` milestone to `ProgressWriter` **before** returning `decision: "block"` with the nudge text. One turn burned (same as today); acknowledgment visible immediately.

*Why:* The Claude Agent SDK does not expose a mechanism to append to system context mid-conversation. The `HookEvent` enum is fixed; `ClaudeAgentOptions.system_prompt` is construction-time only; `hookSpecificOutput.additionalContext` is user-visible-only (confirmed `not-planned` by Anthropic). One-turn-per-nudge is an architectural constraint of the SDK; we surface it honestly rather than pretending it's free.

### AD-6. `bgagent status` is deterministic; `bgagent ask` is the agent

`status` = templated Lambda reading `TaskEventsTable`. `ask` = a real question to the agent, always costs a turn, always has latency.

*Why:* Users understand dashboard reads vs. questions-to-a-thinking-entity. One command per contract is clearer than one command with a flag that silently changes execution model.

### AD-7. `bgagent ask` foreground block-and-poll

Default UX blocks with a spinner showing current agent activity. Durable underneath — CLI disconnect does not cancel the ask or lose the answer.

*Why:* Matches user expectation of a synchronous CLI call. Survives a closed laptop. Spinner surfaces the bounded-but-non-trivial latency (turns can take minutes) without feeling like a hang.

### AD-8. HITL: hard gates only in v1

Phase 3 ships hard gates. No soft questions, no "proceed with default if no response" semantics.

*Why:* Soft-question-with-timeout creates a ticking-clock UX that's actively hostile in an async workflow. "Gate or no gate" is the coherent choice. A future `effect: "advise"` tier (non-blocking FYI events, no timeout) is documented in the Phase 3 design as post-v1.

### AD-9. GitHub edit-in-place via ETag, not SQS FIFO

DDB Streams with `ParallelizationFactor: 1` gives per-`task_id` ordering. GitHub's `If-Match` ETag handles the residual race from Lambda retries.

*Why:* Simpler than FIFO (no queue, no DLQ, no per-group throughput ceiling). Lower latency. GitHub's API already supports optimistic concurrency; use it.

### AD-10. Stranded-task reconciler with a unified timeout

One timeout value covers all stranded cases (orchestrator crash, container crash, general abandonment).

*Why:* The interactive-specific timeout disappeared along with the interactive path. One reconciler, one threshold, easier to reason about.

### AD-11. Agent-side hydration

Blueprint merging, repo config, PAT retrieval, and prompt assembly happen inside the agent container at startup, not in the orchestrator Lambda.

*Why:* Hydration artifacts (cloned repos, merged blueprints, rendered prompts) are large and only needed inside the runtime. Failures belong inside the durable 8 h runtime rather than a 15 min Lambda. The runtime already has the IAM it needs for those reads.

### AD-12. `--trace` as the debug escape hatch

Opt-in per task: 4 KB previews + full trajectory to S3 with TTL.

*Why:* Without live streaming, debugging needs a richer offline artifact. Opt-in keeps normal-task storage costs flat.

---

## 12. Implementation phases

### Phase 1 — v1 PR

- Single orchestrator path; delete all direct-SSE / two-runtime / interactive-mode infrastructure
- `bgagent status` (deterministic)
- `bgagent watch` with adaptive polling interval
- `bgagent nudge` with combined-turn acknowledgment
- FanOutConsumer router + per-channel default filters
- GitHub edit-in-place dispatcher with ETag
- Stub Slack/email dispatchers (log-only, ready for real integration in Phase 2)
- Unified stranded-task reconciler timeout
- `--trace` debug flag

### Phase 2 — Ask + first real notifications

- `bgagent ask` end-to-end (REST, agent-side between-turns hook, foreground block-and-poll CLI, durability-on-disconnect)
- Real Slack dispatcher (webhook + action buttons → approval callback Lambda)
- Per-task notification config + `bgagent notifications configure`

### Phase 3 — Cedar HITL

- Hard-gate approval gates with Cedar policy evaluation
- `bgagent approve` / `deny` / `pending` / `policies`
- `AWAITING_APPROVAL` state + orchestrator handling
- Full design in `PHASE3_CEDAR_HITL.md`

### Phase 4 — Dispatcher polish

- Real email dispatcher (SES)
- Real GitHub dispatcher (beyond the v1 edit-in-place stub)
- Per-repo default notification config
- `--verbose` opt-in for milestone-level events
- Dashboard widgets for notification delivery health

### Deferred

- **LLM-synthesized status summary** — `bgagent ask` without targeting the agent; Lambda calls an LLM to narrate state. Cost + hallucination trade-offs; revisit if v1 feedback warrants.
- **Cedar `effect: "advise"` tier** — non-blocking FYI policy tier for post-v1. Design sketch in `PHASE3_CEDAR_HITL.md`.
- **Outbound WebSocket from agent** — only if a concrete sub-200 ms latency requirement surfaces. Agent-initiated egress avoids dual-auth problems and works on any compute.
- **Multi-user watch** — multiple users attached to the same task's live event stream (teams).

---

## 13. Open questions

| ID | Question | Owner |
|---|---|---|
| Q1 | Retention policy for `--trace` S3 artifacts — 7 days or 30? Size cap per user? | Design |
| Q2 | Should `bgagent pending` (Phase 3) show all pending approvals across all of a user's tasks, or filter to a single `task_id`? | Phase 3 impl |
| Q3 | Slack action button callbacks — Slack signing secret rotation strategy? | Phase 2 impl |
| Q4 | Per-repo default notification config precedence vs per-task overrides — does per-task always win? Partial overrides? | Phase 4 impl |
| Q5 | `bgagent ask` concurrent limit — do we expose `--queue` semantics to explicitly enqueue vs 429? | Phase 2 impl |

---

## Appendix A — Claude Agent SDK reference

Pinned version: `claude-agent-sdk==0.1.53` (Python).

### A.1 Hook surface (v0.1.53)

`HookEvent` enum: `PreToolUse | PostToolUse | PostToolUseFailure | UserPromptSubmit | Stop | SubagentStart | SubagentStop | PreCompact | PermissionRequest | Notification`.

Our usage:
- `PreToolUse` → Cedar policy evaluation (Phase 3), `can_use_tool`-style allow/deny.
- `PostToolUse` → output scanner (secret/PII redaction).
- `Stop` (between-turns) → `_cancel_between_turns_hook`, `_nudge_between_turns_hook`, Phase 2 ask hook, Phase 3 approval poll.

### A.2 Between-turns injection mechanism

Stop hook return values:
- `{}` → no-op, SDK proceeds to stop or loop.
- `{"decision": "block", "reason": "<text>"}` → SDK emits `reason` as a synthetic user turn; agent responds on its next iteration.

This is the **only** SDK-supported mechanism to inject agent-visible text mid-conversation. Implications:
- Every nudge, ask, and deny-with-steering burns one turn from `max_turns`.
- No "append to system prompt mid-run" primitive exists. `ClaudeAgentOptions.system_prompt` is set at construction.
- `hookSpecificOutput.additionalContext` on PostToolUse appears in docs but does not reach the model's context; Anthropic has confirmed this as `not-planned` (GitHub issues `claude-code#18427`, `claude-code#19643`).

### A.3 Mid-run cancellation

`ClaudeSDKClient.interrupt()` cancels the current turn without rolling back prior tool results. Used in our cancel path along with `cancellation_requested` flag on `TaskRecord`.

---

## Appendix B — AgentCore Runtime reference

### B.1 Service contract

- HTTP on port 8080: `/invocations` (JSON + optional SSE response), `/ping` (liveness).
- `/ping` returning `"HealthyBusy"` signals an active session and prevents idle eviction.
- `maxLifetime` and `idleRuntimeSessionTimeout` both configurable up to 8 hours. We set both to the maximum.

### B.2 Invocation

`bedrock-agentcore:InvokeAgentRuntime` — SigV4-authenticated API call from the orchestrator. Payload is the task context; response is ignored (fire-and-forget).

### B.3 Session management

Same `runtimeSessionId` routes to the same MicroVM **within the same runtime ARN**. We use this property for the agent's own internal resumability (re-invocation with the same session ID lands on the same container if it's still alive), but never for CLI→runtime direct attach (which we don't do).

---

## Appendix C — Competitive landscape

Products surveyed for interaction patterns (primary sources: product docs, engineering blogs):

| Product | Interaction model | Notes |
|---|---|---|
| **Devin (Cognition)** | Slack-thread chat during execution; fully async notifications | Closest analog; mid-run Q&A via in-thread messages is a shipped feature |
| **GitHub Copilot coding agent** | Fire-and-forget; progress visible as commits/PR activity | No mid-run steering; notifications via GitHub itself |
| **OpenAI Codex (cloud)** | SSE in web UI; external view is polling; no mid-run course-correction | Explicitly documents inability to steer mid-run |
| **Replit Agent** | Task board UI; user checks progress; no live terminal stream | Novel: automated "Decision-Time Guidance" (internal classifier-driven steering) |
| **Cursor background agents** | Pure fire-and-forget; user manually checks state | No built-in completion notifications (open feature request) |

Key observations:
- Fire-and-forget + notifications is the dominant pattern for long-running coding agents.
- Mid-run steering exists only where there's a persistent conversation surface (Devin's Slack thread); our `bgagent nudge` + `bgagent ask` is the equivalent.
- No product ships "proceed with default if no response" for approval gates. Hard gates or no gates — that's the shipped landscape.
- Polling-based observation is ubiquitous and well-tolerated at minute-to-hour task durations.
