# Interactive Agents: Bidirectional Communication Design

> **Status:** Draft — research phase
> **Branch:** `feature/interactive-background-agents`
> **Roadmap:** Pulls forward items from Iteration 4 (WebSocket + nudge) and Iteration 6 (iterative feedback + HITL approval)
> **Last updated:** 2026-04-16 (rev 3 — adds local testing infrastructure for Phase 1a)

---

## Executive summary

ABCA agents currently run in a fire-and-forget model: the user submits a task, the agent works autonomously in a Firecracker MicroVM, and the result appears as a PR. Users have no real-time visibility into agent progress and no ability to steer a running agent.

This design adds **bidirectional interactivity** through two core capabilities:

1. **Progress streaming (agent → user):** Real-time events (thinking, tool calls, milestones, errors) streamed from the agent to connected clients. Phased transport: DynamoDB polling → AgentCore SSE → optional WebSocket upgrade.
2. **User steering (user → agent):** Nudges, pause/resume, and approval gates that let users redirect or gate agent behavior mid-task, delivered via REST API endpoints through existing API Gateway auth.

### Key findings from research

| Area | Finding | Impact |
|------|---------|--------|
| **AgentCore Runtime — AG-UI protocol** | AgentCore supports both **SSE** (`/invocations`) and **WebSocket** (`/ws`) with identical AG-UI event types. SSE is simpler and has no 60-min reconnection limit. AG-UI interrupt/resume pattern enables bidirectional interaction over SSE via sequential POST requests. | **SSE is our primary transport.** WebSocket is an optional upgrade path. |
| **AgentCore Runtime — Lifecycle** | `idleRuntimeSessionTimeout` configurable up to 8 hours. `maxLifetime` up to 8 hours. CPU billing stops during I/O wait (paused sessions cost ~70% less). `/ping` returning `"HealthyBusy"` prevents platform termination. | **Long pauses are economically viable.** Set both timeouts to 8 hours. |
| **AgentCore Identity** | Separate service from AgentCore Runtime. Supports **Cognito User Pool as inbound IdP** — users authenticate with existing Cognito JWT as OAuth bearer token. No IAM credentials or Identity Pool needed. | **Same JWT for REST API and AgentCore direct access.** Single auth credential for users. |
| **Claude Agent SDK** | `ClaudeSDKClient` supports bidirectional multi-turn conversations. `client.query()` injects messages between turns. `can_use_tool` callback enables HITL approval gates. Hooks fire per-tool-call. | **The SDK natively supports everything we need for agent-side interactivity.** |
| **Transport decision** | SSE for streaming (agent→client), REST for commands (client→agent). All commands go through our API Gateway with existing Cognito auth. No new auth infrastructure for Phase 1a. | **Simplest possible architecture for initial delivery.** |

---

## Table of contents

1. [Current architecture analysis](#1-current-architecture-analysis)
2. [AgentCore Runtime API research](#2-agentcore-runtime-api-research)
3. [Claude Agent SDK research](#3-claude-agent-sdk-research)
4. [Transport architecture](#4-transport-architecture-phased-progression)
5. [Bidirectional communication architecture](#5-bidirectional-communication-architecture)
6. [Security and trust model](#6-security-and-trust-model)
7. [State machine extensions](#7-state-machine-extensions)
8. [Error handling and observability](#8-error-handling-and-observability) — error propagation, unified debugging, OTEL traces, dashboard, alarms
9. [Design decisions (rev 2)](#9-design-decisions-rev-2) — transport, auth, HITL modes, nudge limits, memory, pause, testing
10. [Implementation plan](#10-implementation-plan)
11. [Proof-of-concept scope](#11-proof-of-concept-scope)
12. [Open questions](#12-open-questions)

---

## 1. Current architecture analysis

### Communication flow (current — one-directional, async)

```
User ──POST /v1/tasks──▶ API Gateway ──▶ createTask Lambda ──▶ DynamoDB (SUBMITTED)
                                                              ├─▶ orchestrate-task Lambda (durable)
                                                              │     ├─ admission control
                                                              │     ├─ context hydration (→ HYDRATING)
                                                              │     ├─ InvokeAgentRuntimeCommand (→ RUNNING)
                                                              │     ├─ pollTaskStatus every 30s (DDB read)
                                                              │     └─ finalizeTask (→ terminal)
                                                              │
User ──GET /v1/tasks/{id}──▶ API Gateway ──▶ getTask Lambda ──▶ DynamoDB (read)
                                                              │
                                          AgentCore MicroVM ──┘
                                            ├─ server.py /invocations (fire-and-forget thread)
                                            ├─ entrypoint.py run_task() → run_agent()
                                            │   ├─ ClaudeSDKClient.connect()
                                            │   ├─ ClaudeSDKClient.query(prompt)  ← ONE-SHOT
                                            │   └─ async for msg in client.receive_response()
                                            │       └─ _TrajectoryWriter → CloudWatch Logs
                                            └─ task_state.py → DynamoDB (RUNNING → terminal)
```

### Critical gaps

| # | Gap | Impact |
|---|-----|--------|
| 1 | **No bidirectional channel** — REST API only, no WebSocket or SSE | Users must poll; no push notifications |
| 2 | **No real-time streaming** — Trajectory data goes to CloudWatch Logs only | 30s polling granularity at best |
| 3 | **One-shot agent invocation** — `client.query(prompt)` called once, then `receive_response()` until done | No mid-session message injection despite SDK support |
| 4 | **No `can_use_tool` callback** — Agent runs with `bypassPermissions` | No HITL approval gates |
| 5 | **No WebSocket infrastructure** — No connection table, no `$connect`/`$disconnect` routes | No real-time push to clients |
| 6 | **No PAUSED or AWAITING_APPROVAL state** in task state machine | Cannot represent paused or gated tasks |
| 7 | **Agent harness has no nudge channel** — `server.py` spawns a thread and waits | No way to inject messages from outside |

---

## 2. AgentCore Runtime API research

### Complete SDK command inventory

Source: `@aws-sdk/client-bedrock-agentcore@3.1030.0` (published 2026-04-13). Commands extracted from the published npm package type declarations.

#### Runtime operations

| Command | Description | Streaming | Relevance |
|---------|-------------|-----------|-----------|
| `InvokeAgentRuntimeCommand` | Sends payload to the agent runtime's `/invocations` endpoint. Returns a streaming blob response. | Blob stream | **Current usage** — fire-and-forget invocation |
| `InvokeAgentRuntimeCommandCommand` | **Executes a shell command inside a running session** and streams stdout/stderr back to the caller via `contentStart`/`contentDelta`/`contentStop` events. | Event stream (`stdout`, `stderr`, `exitCode`) | **NEW — enables remote command execution in running MicroVM** |
| `StopRuntimeSessionCommand` | Stops a running session. Takes `runtimeSessionId` + `agentRuntimeArn`. | No | **Enables proper cancellation** (currently ABCA only sets DDB status) |

#### `InvokeAgentRuntimeCommandCommand` — detailed analysis

This is the most significant AgentCore API for interactivity. It provides:

```typescript
// Input
{
  agentRuntimeArn: string;      // required
  runtimeSessionId: string;     // target a specific running session
  body: {
    command: string;            // shell command to execute
    timeout: number;            // optional timeout
  }
}

// Output (streaming)
{
  stream: {
    chunk: {
      contentStart: {};                          // stream begins
      contentDelta: { stdout?: string; stderr?: string; };  // incremental output
      contentStop: { exitCode: number; status: "COMPLETED" | "TIMED_OUT"; };
    }
  }
}
```

**Use cases for interactivity:**

1. **Nudge injection via filesystem:** Write a nudge file inside the MicroVM:
   ```
   echo '{"type":"nudge","content":"focus on auth module"}' > /tmp/nudges/pending.json
   ```
   The agent harness polls `/tmp/nudges/` between turns and consumes the nudge.

2. **Progress reading:** Read a structured progress file:
   ```
   cat /tmp/progress/latest.json
   ```
   Or tail a progress event log.

3. **Health check:** Run a diagnostic command to verify the agent is still responsive.

**Limitations:**
- Requires knowing the `runtimeSessionId` (the orchestrator already stores this)
- Shell command execution has latency overhead
- No structured message passing (must serialize/deserialize via files)
- The agent process must be designed to read these files (not automatic)

#### Other AgentCore commands (not directly relevant to interactivity)

| Category | Commands |
|----------|----------|
| **Browser Tool** | `StartBrowserSessionCommand`, `GetBrowserSessionCommand`, `ListBrowserSessionsCommand`, `StopBrowserSessionCommand`, `InvokeBrowserCommand`, `UpdateBrowserStreamCommand`, `SaveBrowserSessionProfileCommand` |
| **Code Interpreter** | `StartCodeInterpreterSessionCommand`, `GetCodeInterpreterSessionCommand`, `ListCodeInterpreterSessionsCommand`, `StopCodeInterpreterSessionCommand`, `InvokeCodeInterpreterCommand` |
| **Memory** | `CreateEventCommand`, `GetEventCommand`, `DeleteEventCommand`, `ListEventsCommand`, `ListSessionsCommand`, `ListActorsCommand`, `ListMemoryRecordsCommand`, `GetMemoryRecordCommand`, `BatchCreateMemoryRecordsCommand`, `BatchDeleteMemoryRecordsCommand`, `BatchUpdateMemoryRecordsCommand`, `RetrieveMemoryRecordsCommand`, `StartMemoryExtractionJobCommand`, `ListMemoryExtractionJobsCommand`, `SearchRegistryRecordsCommand` |
| **Identity/Auth** | `CompleteResourceTokenAuthCommand`, `GetResourceApiKeyCommand`, `GetResourceOauth2TokenCommand`, `GetWorkloadAccessTokenCommand`, `GetWorkloadAccessTokenForJWTCommand`, `GetWorkloadAccessTokenForUserIdCommand` |
| **Evaluation** | `EvaluateCommand` |
| **Agent Card** | `GetAgentCardCommand` |

### AgentCore WebSocket — native bidirectional streaming (CRITICAL FINDING)

Source: [AgentCore Runtime service contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html), [WebSocket guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html)

AgentCore Runtime supports **four protocols** on the container:

| Protocol | Port | Path | Format | Use case |
|----------|------|------|--------|----------|
| **HTTP** | 8080 | `/invocations`, `/ws` | REST JSON/SSE, WebSocket | Direct API calls, real-time streaming |
| **MCP** | 8000 | `/mcp` | JSON-RPC | Tool server discovery |
| **A2A** | 9000 | `/` | JSON-RPC 2.0 | Agent-to-agent communication |
| **AG-UI** | 8080 | `/invocations` (SSE), `/ws` (WebSocket) | Event streams | Interactive UI experiences |

**WebSocket endpoint details:**

```
URL: wss://bedrock-agentcore.<region>.amazonaws.com/runtimes/<agentRuntimeArn>/ws
Session routing: X-Amzn-Bedrock-AgentCore-Runtime-Session-Id (query param or header)
Max frame size: 32KB (chunking required for larger messages)
Auth: SigV4 signed headers, SigV4 pre-signed URL, or OAuth 2.0 bearer token
Idle timeout: Resets on any message activity including ping/pong frames
```

**AG-UI protocol event types** (March 2026):

| Event | Description |
|-------|-------------|
| `RUN_STARTED` | Agent execution begins (`threadId`, `runId`) |
| `TEXT_MESSAGE_START` | Agent starts a text response (`messageId`, `role`) |
| `TEXT_MESSAGE_CONTENT` | Incremental text content (`messageId`, `delta`) |
| `TEXT_MESSAGE_END` | Text response complete |
| `TOOL_CALL_START` | Agent invokes a tool (`toolCallId`, `toolCallName`) |
| `TOOL_CALL_RESULT` | Tool execution result (`toolCallId`, `content`) |
| `RUN_FINISHED` | Agent execution complete |
| `RUN_ERROR` | Error during execution (`code`, `message`) |

**Implication for ABCA:** If we implement the AG-UI protocol in `server.py` (a `/ws` WebSocket handler alongside the existing `/invocations` HTTP handler), clients can connect directly to AgentCore's managed WebSocket endpoint for bidirectional streaming — **without needing a separate API Gateway WebSocket API**.

### Architecture decision: AgentCore WebSocket vs. API Gateway WebSocket

| Factor | AgentCore WebSocket (native) | API Gateway WebSocket (custom) |
|--------|------------------------------|-------------------------------|
| **Infrastructure** | Zero additional infrastructure — already provided by AgentCore | New: WebSocket API, ConnectionsTable, 5+ Lambda handlers |
| **Latency** | Direct connection to MicroVM via managed service (~ms) | DDB Streams → Lambda → PostToConnection (~1-3s) |
| **Bidirectional** | Full duplex — client sends messages, agent responds in real-time | Requires DDB polling on agent side for nudges |
| **Auth** | SigV4 or OAuth — need to grant clients `InvokeAgentRuntime` permissions | Cognito JWT on `$connect` — existing auth model |
| **Fan-out** | One connection per client per session — no built-in fan-out | DDB connection table enables multi-client fan-out |
| **Session binding** | Client needs `runtimeSessionId` (available after session starts) | Decoupled — client subscribes by `task_id` |
| **Offline events** | No event persistence — client must be connected to receive | Events persisted in DDB, queryable via REST API |
| **Cost** | Included in AgentCore Runtime pricing | WebSocket connection hours + Lambda invocations |

**Recommendation:** **Hybrid approach.** Use AgentCore WebSocket for low-latency streaming to connected clients. Use DynamoDB + REST API as the durable event store (existing `TaskEventsTable`). The API Gateway WebSocket layer is deferred — it can be added later if fan-out or connection management needs exceed what AgentCore provides natively.

### What AgentCore does NOT provide

- **No session pause/resume** — `StopRuntimeSessionCommand` is permanent. No `PauseSessionCommand`.
- **No EventBridge events for session lifecycle** — No automatic notifications when sessions start/stop/fail. Observability via CloudWatch only.
- **No native nudge/message injection API** — Bidirectional communication requires implementing the WebSocket handler in the agent container. The WebSocket is a transport, not a structured messaging API.

### Architectural implication

AgentCore provides **compute isolation, remote shell access, AND bidirectional WebSocket transport**. The interactivity architecture should:
- Use the **Claude Agent SDK's bidirectional capabilities** for agent-side conversation management (primary)
- Use **AgentCore WebSocket** (`/ws`) for real-time client-to-agent communication (transport)
- Use **DynamoDB** as the durable event store and signaling plane (persistence)
- Use `InvokeAgentRuntimeCommandCommand` as a backup communication channel

---

## 3. Claude Agent SDK research

### SDK capabilities for interactivity

Source: `claude-agent-sdk==0.1.53` (Python). Inspected from published PyPI package.

The `ClaudeSDKClient` class is explicitly designed for **bidirectional, interactive conversations**. Its docstring states:

> "Client for bidirectional, interactive conversations with Claude Code. This client provides full control over the conversation flow with support for streaming, interrupts, and dynamic message sending."

#### Key capabilities

| Capability | Method | Description |
|------------|--------|-------------|
| **Mid-session message injection** | `client.query(prompt)` | Send a new user message to the running session. Can be called multiple times. This is the **core nudge mechanism**. |
| **Interrupt** | `client.interrupt()` | Send an interrupt signal to stop the current turn. |
| **Per-message streaming** | `async for msg in client.receive_messages()` | Yields `AssistantMessage`, `SystemMessage`, `ResultMessage`, `StreamEvent`, `RateLimitEvent` as they arrive. |
| **Partial message streaming** | `include_partial_messages=True` | Yields `StreamEvent` objects with raw Anthropic API stream events (per-token granularity). |
| **HITL approval gate** | `can_use_tool` callback | Called before every tool use. Returns `PermissionResultAllow` or `PermissionResultDeny`. Can modify tool input or deny with a message. **This is exactly the approval gate mechanism.** |
| **Hooks** | `hooks` parameter | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `Notification`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest` |
| **Model switching** | `client.set_model(model)` | Change model mid-conversation (adaptive model routing). |
| **Permission mode change** | `client.set_permission_mode(mode)` | Change from `bypassPermissions` to `default` mid-session. |
| **File checkpointing** | `enable_file_checkpointing=True` + `client.rewind_files(uuid)` | Rewind files to a checkpoint. |
| **Task control** | `client.stop_task(task_id)` | Stop a running sub-agent task. |
| **Context usage** | `client.get_context_usage()` | Get real-time context window utilization. |
| **Session continuation** | `continue_conversation=True`, `resume=session_id` | Resume previous sessions or fork. |

#### Message types for streaming

```python
# Messages yielded by receive_messages() / receive_response()
Message = (
    UserMessage           # User input (including injected nudges)
    | AssistantMessage    # Agent response with TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock
    | SystemMessage       # System events (init, task_started, task_progress, task_notification)
    | ResultMessage       # Session end with cost, turns, usage
    | StreamEvent         # Partial message updates (when include_partial_messages=True)
    | RateLimitEvent      # Rate limit status changes
)

# Specialized SystemMessage subtypes
TaskStartedMessage      # task_id, description, session_id
TaskProgressMessage     # task_id, usage (total_tokens, tool_uses, duration_ms), last_tool_name
TaskNotificationMessage # task_id, status (completed/failed/stopped), output_file, summary
```

#### `can_use_tool` callback — HITL approval gate design

```python
async def approval_gate(
    tool_name: str,
    tool_input: dict,
    context: ToolPermissionContext,
) -> PermissionResult:
    """
    Called before every tool use. Can:
    1. Allow unconditionally → PermissionResultAllow()
    2. Allow with modified input → PermissionResultAllow(updated_input={...})
    3. Deny with message → PermissionResultDeny(message="reason")
    4. Deny and interrupt → PermissionResultDeny(message="reason", interrupt=True)
    """
    if is_high_risk(tool_name, tool_input):
        # Write approval request to DynamoDB
        # Notify user via WebSocket
        # Wait for user response (poll DDB or asyncio.Event)
        approved = await wait_for_approval(task_id, tool_name, tool_input)
        if approved:
            return PermissionResultAllow()
        else:
            return PermissionResultDeny(message="User denied this operation")
    return PermissionResultAllow()
```

#### Critical limitation: between-turn injection only

The Claude Agent SDK supports **sequential multi-turn conversation** (`query()` → `receive_response()` → `query()` → ...) but **NOT injection into an active turn**. GitHub issue [#24947](https://github.com/anthropics/claude-code/issues/24947) (high-priority, closed) requested a `claude inject <session_id>` command but it was never shipped. Issue [#35072](https://github.com/anthropics/claude-code/issues/35072) documents failed workarounds (PostToolUse hooks, MCP notifications).

**Implication for nudges:** Nudges can only be consumed **between turns** — after the current `AssistantMessage` is fully received and before the next `query()` call. If the agent is in the middle of a long tool call (e.g., running tests for 5 minutes), the nudge waits until that turn completes. This is acceptable for most use cases (steering is inherently non-urgent), but means nudges cannot interrupt a running tool call.

**Implication for approval gates:** The `can_use_tool` callback fires **before** each tool execution, which is the correct time for approval gates. This is not affected by the between-turn limitation.

### Current agent code vs. what's possible

| Current (`entrypoint.py`) | What the SDK supports |
|---|---|
| `ClaudeAgentOptions(permission_mode="bypassPermissions")` | `can_use_tool` callback for per-tool-call approval |
| Single `client.query(prompt)` call | Multiple `client.query()` calls for multi-turn conversations |
| `async for msg in client.receive_response()` (waits for ResultMessage) | `receive_messages()` for indefinite streaming + concurrent `query()` calls |
| No hooks configured | Full hook system for `PreToolUse`, `PostToolUse`, `Notification`, etc. |
| `_TrajectoryWriter` → CloudWatch only | Can emit events to DynamoDB/WebSocket in real-time from the message loop |
| No `include_partial_messages` | Per-token streaming with `StreamEvent` |
| No model switching | `set_model()` for adaptive model routing |

---

## 4. Transport architecture: phased progression

### Design principle: SSE-first, single transport at a time

The architecture progresses through three transport phases. Each phase is independently shippable and fully functional. We implement and validate one phase before starting the next.

### Phase 1a: DynamoDB + REST polling (zero new infrastructure)

```
Agent (MicroVM)                     Our API Gateway                 Client (CLI)
─────────────                       ───────────────                 ──────────
run_agent() loop
  │
  ├─ AssistantMessage received
  │   ├─ _TrajectoryWriter → CloudWatch (existing)
  │   └─ _ProgressWriter → DynamoDB TaskEventsTable (enriched)
  │
  │                                 GET /tasks/{id}/events ◀─────── Poll every 2s
  │                                      │
  │                                 Read DDB ──────────────────────▶ Progress events
  │
  │                                 POST /tasks/{id}/nudge ◀─────── Send nudge
  │                                      │
  │                                 Write DDB (TaskNudgesTable)
  │   Agent polls DDB between turns ◀──┘
  │   await client.query(nudge)
```

**Auth:** Existing Cognito JWT → API Gateway. Zero new auth configuration.
**Latency:** ~2-5 seconds (poll interval). Acceptable for initial delivery.
**Infrastructure:** Zero new AWS resources beyond DDB table writes.

### Phase 1b: AgentCore SSE (real-time streaming upgrade)

```
Agent (MicroVM)                     AgentCore Service               Client (CLI)
─────────────                       ─────────────────               ──────────
server.py /invocations (SSE)
  │
run_agent() loop                    POST /invocations ◀──────────── Connect (Cognito JWT
  │                                 (SSE stream opened)                via AgentCore Identity)
  ├─ AssistantMessage received
  │   ├─ _ProgressWriter → DDB (durable fallback)
  │   └─ SSE event ─────────────────────────────────────▶ Real-time (~100ms)
  │       event: TEXT_MESSAGE_CONTENT
  │       data: {"messageId":"...","delta":"..."}
  │
  │
  │   Our API Gateway (unchanged)
  │   POST /tasks/{id}/nudge ◀──────────────────────────── Send nudge (REST)
  │   POST /tasks/{id}/approve ◀────────────────────────── Approval response (REST)
  │
  │   Agent polls DDB between turns
  │   await client.query(nudge)
```

**Auth:** AgentCore Identity configured with Cognito as inbound IdP. Users send same JWT as `Authorization: Bearer <token>`. REST commands still go through our API Gateway (existing Cognito auth).
**Latency:** ~100ms for streaming events. Compare with Phase 1a to validate improvement.
**Infrastructure:** AgentCore Identity configuration (CDK). No new Lambda/DDB.

### Phase 1c: WebSocket upgrade (optional, future)

Only if SSE proves insufficient (e.g., mid-turn cancellation needed, SSE keepalive unreliable for long pauses). Adds `/ws` handler to `server.py` alongside `/invocations`. Same AG-UI events. Bidirectional on single connection. **This is a separate enhancement task, not part of the initial interactive agents feature.**

### Why SSE-first

| Concern | SSE | WebSocket |
|---------|-----|-----------|
| **Corporate proxy compatibility** | Works everywhere (just HTTP) | Some proxies block `Upgrade` |
| **Streaming duration limit** | **60 minutes** (must reconnect — same limit) | **60 minutes** (must reconnect — same limit) |
| **Auth simplicity** | Standard HTTP `Authorization` header | Handshake-only auth, protocol-level complexity |
| **Client implementation** | `EventSource` API (2 lines of code) | WebSocket lifecycle management |
| **Bidirectional** | Commands via separate REST POST (our API Gateway) | In-band (single connection) |
| **Reconnection** | `EventSource` auto-reconnects | Manual reconnect logic needed |
| **All features supported?** | **Yes** — nudges/approvals/pause via REST endpoints | Yes — all in-band |

---

## 5. Bidirectional communication architecture

### Agent-side changes

The core change is in `agent/entrypoint.py::run_agent()`. Instead of a simple one-shot query-and-receive loop, the agent runs an **interactive loop** that:

1. Sends the initial prompt
2. Streams messages to both CloudWatch (existing) and DynamoDB (new)
3. Between turns, checks for pending nudges in DynamoDB
4. If a nudge is found, injects it via `client.query(nudge_content)`
5. Optionally uses `can_use_tool` callback for HITL approval gates

```python
# Conceptual change to run_agent()
async def run_agent(prompt, system_prompt, config, cwd):
    # ... existing setup ...

    progress_writer = _ProgressWriter(config["task_id"])
    nudge_reader = _NudgeReader(config["task_id"])

    async def approval_gate(tool_name, tool_input, context):
        if not _needs_approval(tool_name, tool_input, config):
            return PermissionResultAllow()
        # Write approval request to DDB, wait for response
        return await _request_approval(config["task_id"], tool_name, tool_input)

    options = ClaudeAgentOptions(
        # ... existing options ...
        can_use_tool=approval_gate if config.get("enable_approval_gates") else None,
        include_partial_messages=config.get("enable_streaming", False),
    )

    client = ClaudeSDKClient(options=options)
    await client.connect()
    await client.query(prompt=prompt)

    async for message in client.receive_messages():
        # Existing trajectory writing
        trajectory.write_turn(...)

        # NEW: Write progress event to DynamoDB for WebSocket fan-out
        progress_writer.write_event(message)

        # NEW: Check for pending nudges between turns
        if isinstance(message, AssistantMessage):
            nudge = await nudge_reader.check_pending()
            if nudge:
                await client.query(nudge.content)
                nudge_reader.mark_consumed(nudge.nudge_id)

        if isinstance(message, ResultMessage):
            break
```

### New DynamoDB tables

#### Progress events in existing TaskEventsTable

Progress events are written to the **existing** `TaskEventsTable` (no new table). The `ProgressWriter` uses the same schema as existing events (`task_id` PK, `event_id` SK as ULID) but with enriched `event_type` values and structured `metadata`:

| `event_type` | `metadata` contents |
|---|---|
| `agent_turn` | `{turn, model, thinking_preview, text_preview, tool_calls_count}` |
| `agent_tool_call` | `{tool_name, tool_input_preview, turn}` |
| `agent_tool_result` | `{tool_name, is_error, content_preview, turn}` |
| `agent_milestone` | `{milestone, details}` (e.g., "cloning repo", "running tests") |
| `agent_cost_update` | `{cost_usd, input_tokens, output_tokens, turn}` |
| `agent_error` | `{error_type, message_preview}` |

Events use the existing table's TTL (90 days, matching task retention). The agent already has `grantReadWriteData` on this table — no new IAM grants needed for Phase 1a.

#### TaskNudgesTable

Stores user-injected nudges for agent consumption.

| Attribute | Type | Description |
|-----------|------|-------------|
| `task_id` (PK) | String | Task identifier |
| `nudge_id` (SK) | String | ULID for ordering |
| `content` | String | Nudge text (max 2,000 chars, guardrail-screened) |
| `user_id` | String | Who sent it |
| `status` | String | `pending` → `consumed` → `expired` |
| `created_at` | String | ISO 8601 |
| `consumed_at` | String | ISO 8601 (set by agent) |
| `ttl` | Number | 1-hour expiry for unclaimed nudges |

### REST API contract for interactive commands

All client → agent commands go through our existing API Gateway with Cognito auth.

#### New REST endpoints

```
POST /v1/tasks/{task_id}/nudge        # Send steering message
POST /v1/tasks/{task_id}/approve      # Respond to approval gate
POST /v1/tasks/{task_id}/pause        # Pause task
POST /v1/tasks/{task_id}/resume       # Resume task
```

#### Nudge request

```typescript
POST /v1/tasks/{task_id}/nudge
{
  content: string,       // Max 2,000 chars. Guardrail-screened.
}
// Response: 202 Accepted { nudge_id: string }
// Errors: 400 (validation/guardrail), 403 (not owner), 404 (task not found),
//         409 (task not in RUNNING/PAUSED state), 429 (rate limit), 503 (guardrail unavailable — fail-closed)
```

#### Approval response

```typescript
POST /v1/tasks/{task_id}/approve
{
  request_id: string,     // From the approval_request event
  decision: "approve" | "deny",
  scope?: "this_call" | "tool_type_session" | "tool_type_pattern" | "all_session",
  pattern?: string,       // Required when scope = "tool_type_pattern" (e.g., "git *")
  message?: string,       // Optional reason (shown to agent on deny)
}
// Response: 200 OK
// Errors: 400 (validation), 403 (not owner), 404 (task/request not found),
//         409 (request already resolved or expired)
```

---

## 6. Security and trust model

### Nudge content security

| Control | Implementation |
|---------|----------------|
| **Authorization** | Only the task creator (`user_id` match) can send nudges. Verified by nudgeHandler Lambda. |
| **Content screening** | Nudge content goes through Bedrock Guardrails (same as task descriptions). Prompt injection in nudges is as dangerous as in task descriptions — same mitigation. |
| **Rate limiting** | Min 5s interval between nudges. Max 50 per task. Max 10 per minute per user. Configurable per Blueprint. |
| **Size limit** | Max 2,000 characters per nudge (same as task description limit). |
| **Audit trail** | All nudges logged in TaskEventsTable with `nudge_sent` / `nudge_consumed` event types, attributed to `user_id`. |
| **Replay protection** | Each nudge has a unique `nudge_id` (ULID). The agent marks nudges as `consumed` with a `ConditionExpression` to prevent re-processing. |

### Approval gate security

| Control | Implementation |
|---------|----------------|
| **Authorization** | Only the task creator can approve/deny. Team approval is deferred to multi-user iteration. |
| **Timeout** | Approval requests expire after 5 minutes. If no response, the tool call is denied (fail-closed). |
| **Scope** | Approval responses support escalation: `this_call` (single invocation), `tool_type_session` (all future calls to this tool type), `tool_type_pattern` (matching pattern, e.g., `git *`), or `all_session` (switch to autonomous). See Section 8.4. |
| **Audit** | All approval requests and decisions logged in TaskEventsTable. |

### Transport security

| Control | Phase 1a (REST polling) | Phase 1b (AgentCore SSE) |
|---------|------------------------|--------------------------|
| **Auth for streaming** | Cognito JWT → API Gateway (existing) | Cognito JWT → AgentCore Identity (OAuth bearer) |
| **Auth for commands** | Cognito JWT → API Gateway (existing) | Same — commands always go through our API Gateway |
| **Encryption** | HTTPS (TLS) | HTTPS (TLS) |
| **Authorization** | `user_id` match on all endpoints | Same + AgentCore Identity validates JWT claims |
| **Connection limits** | N/A (stateless polling) | AgentCore: 1,000 sessions/account (adjustable), 250 frames/s/connection |

### Impact on memory system

Nudges are **not** written to AgentCore Memory. They are ephemeral instructions that affect the current task only. The nudge content becomes part of the conversation context (via `client.query()`) and may influence the agent's behavior within the session, but the memory system's `write_task_episode` and `write_repo_learnings` operate on the agent's final output, not on intermediate nudges.

Nudge content could theoretically poison the conversation context (a form of prompt injection via the trusted user channel). This is mitigated by:
1. Only the authenticated task creator can send nudges
2. Guardrail screening on nudge content
3. Rate limiting to prevent context flooding

---

## 7. State machine extensions

### New states

```
Current states: SUBMITTED → HYDRATING → RUNNING → FINALIZING → terminal

New states:
  RUNNING → PAUSED (user pauses the task)
  PAUSED → RUNNING (user resumes)
  RUNNING → AWAITING_APPROVAL (agent requests HITL approval)
  AWAITING_APPROVAL → RUNNING (user approves)
  AWAITING_APPROVAL → CANCELLED (user denies or timeout)
  PAUSED → CANCELLED (user cancels while paused)
```

### Updated transition table

```typescript
export const VALID_TRANSITIONS: Record<TaskStatusType, readonly TaskStatusType[]> = {
  SUBMITTED: ['HYDRATING', 'FAILED', 'CANCELLED'],
  HYDRATING: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['FINALIZING', 'CANCELLED', 'TIMED_OUT', 'FAILED',
            'PAUSED',              // NEW: user pauses
            'AWAITING_APPROVAL'],  // NEW: agent requests approval
  PAUSED: ['RUNNING', 'CANCELLED'],                   // NEW
  AWAITING_APPROVAL: ['RUNNING', 'CANCELLED'],         // NEW: RUNNING on approve OR deny; CANCELLED only on explicit cancel
  FINALIZING: ['COMPLETED', 'FAILED', 'TIMED_OUT'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
};
```

### PAUSED state mechanics

When a task is paused:
1. Client sends `POST /v1/tasks/{id}/pause` → Lambda writes to DynamoDB
2. Agent checks DDB between turns, enters paused state, completes current turn
3. The Claude Code CLI subprocess remains alive (session preserved in memory)
4. Agent returns `"HealthyBusy"` from `/ping` to prevent platform termination
5. Keepalive coroutine sends periodic activity to prevent idle timeout
6. If SSE stream is open: periodic heartbeat events (`: keepalive\n\n`) keep it alive

**Lifecycle configuration (set in CDK):**
- `idleRuntimeSessionTimeout`: **28,800s (8 hours)** — matches `maxLifetime`. Must set explicitly ([CDK bug #36376](https://github.com/aws/aws-cdk/issues/36376) defaults to 60s).
- `maxLifetime`: **28,800s (8 hours)** — maximum allowed. Absolute, cannot be reset.

**Cost during pause:** CPU billing stops during I/O wait (agent idle, no compute). Only memory billed. ~$0.076/hr for 8GB vs ~$0.255/hr when running (70% savings). Long pauses are economically viable.

**Time budget tracking:** The task record tracks elapsed `maxLifetime`. When <15 minutes remain, the agent sends a warning event to the client and auto-resumes (or transitions to TIMED_OUT if the user doesn't respond).

### AWAITING_APPROVAL state mechanics

When an approval gate triggers:
1. The `can_use_tool` callback writes an approval request to DynamoDB
2. Task status transitions to `AWAITING_APPROVAL`
3. Agent emits approval request event (via SSE stream or DDB progress event)
4. The callback `await`s a DynamoDB poll for the user's decision (with 5-minute timeout)
5. Client sees the approval request, sends `POST /v1/tasks/{id}/approve` via our API Gateway
6. On approval: task returns to `RUNNING`, tool call proceeds
7. On denial/timeout: tool call is denied, agent receives the denial message, task returns to `RUNNING` (agent continues with the denial context)
8. Agent returns `"HealthyBusy"` from `/ping` during the wait (prevents platform termination)
9. With `idleRuntimeSessionTimeout` set to 8 hours, the 5-minute approval timeout is well within bounds

---

### Orchestrator impact (CRITICAL)

The durable orchestrator (`orchestrate-task.ts`) polls DDB every 30s checking for terminal states. New states require orchestrator changes:

**`PAUSED`:** The orchestrator's `waitStrategy` must recognize `PAUSED` as a valid non-terminal state. During pause, increase the poll interval to 60s (reduce Lambda invocations). Resume polling at 30s when state returns to `RUNNING`.

**`AWAITING_APPROVAL`:** Same treatment — recognize as valid non-terminal. Poll at 30s. The 5-minute approval timeout is enforced by the agent-side callback, not the orchestrator.

**Concurrency accounting:** Paused and awaiting-approval tasks **hold their concurrency slot**. This is intentional — the session is alive and consuming resources. Document this as expected behavior. A future enhancement could add a "paused tasks don't count" option.

**`ACTIVE_STATUSES` update:** Add `PAUSED` and `AWAITING_APPROVAL` to `ACTIVE_STATUSES` in `task-status.ts` so `GET /tasks?status=active` includes them. Also affects the concurrency reconciler.

**Files to modify:**
- `orchestrate-task.ts` — `waitStrategy` (defined inline at line 143, NOT in `orchestrator.ts`)
- `orchestrator.ts` — `finalizeTask()` must handle PAUSED/AWAITING_APPROVAL (currently hits "Unexpected state" branch)
- `task-status.ts` — states, transitions, ACTIVE_STATUSES
- `task_state.py` — `write_terminal()` ConditionExpression must include new states (currently only allows RUNNING/HYDRATING/FINALIZING)
- `reconcile-concurrency.ts` — uses hardcoded status strings (not shared ACTIVE_STATUSES constant), must add new states

All must be added to Phase 3 and Phase 4 file change maps.

---

## 8. Error handling and observability

### 8.1 Design principle: events are fail-open, commands are fail-closed

| Direction | Pattern | Rationale |
|-----------|---------|-----------|
| **Agent → Client** (progress events, SSE) | **Fail-open.** A missed event is recoverable — client catches up from DDB. Never crash the agent for a streaming failure. | Progress is observability, not correctness. |
| **Client → Agent** (nudges, approvals, pause) | **Fail-closed at API boundary.** Client gets a clear error and can retry. Inside the agent, command consumption is fail-open (missed nudge poll doesn't crash the agent). | Commands change agent behavior — silent failure is worse than a visible error. |
| **Approval gate** (agent-side `can_use_tool`) | **Fail-closed.** If we can't write an approval request to DDB → deny the tool call. If we can't read the response → auto-deny at timeout. | The agent should not perform a risky action when the approval system is degraded. |

### 8.2 Error propagation per component

#### Progress events (Phase 1a/1b)

```
ProgressWriter DDB write fails
  → Log structured warning with task_id (CloudWatch)
  → Emit "progress_writer_failure" task event to DDB (best-effort)
  → Circuit breaker: disable after 3 consecutive failures (same pattern as _TrajectoryWriter)
  → Agent continues — no impact on task outcome
  → Client sees gap in events, catches up on next successful write

SSE connection drops (Phase 1b: network, 60-min limit, proxy timeout)
  → EventSource auto-reconnects (built-in client behavior)
  → On reconnect: GET /tasks/{id}/events?after={last_event_id} for catch-up
  → Merge DDB events with new SSE stream
  → DDB is source of truth; SSE is the fast path
```

#### Nudges (Phase 2)

```
Nudge submission (client → API → DDB):
  Guardrail service unavailable → 503 SERVICE_UNAVAILABLE (fail-closed)
  Guardrail blocks content      → 400 GUARDRAIL_BLOCKED
  DDB write fails               → 503, client retries
  Task not in RUNNING/PAUSED    → 409 INVALID_TASK_STATE
  Not task owner                → 403 FORBIDDEN
  Rate limit exceeded           → 429 RATE_LIMIT_EXCEEDED

Nudge consumption (agent-side):
  DDB read fails during poll    → Skip this cycle, try next turn (fail-open)
  client.query(nudge) fails     → Log error, emit "nudge_delivery_failed" event
                                   Mark nudge as "delivery_failed" in DDB
                                   Agent continues without nudge — no crash
  Multiple nudges queued        → Process in ULID order, one per turn boundary
  Nudge arrives after terminal  → Expires via TTL (1 hour)
```

#### Approval gates (Phase 3)

```
Approval request (agent-side):
  DDB write fails               → DENY the tool call immediately (fail-closed)
  DDB poll for response fails   → Retry with backoff within 5-min window
                                   If all retries fail → auto-deny at timeout
  5-min timeout reached          → Auto-deny, PermissionResultDeny("timed out")
  Agent crashes during wait      → task_state.write_terminal("FAILED")
                                   Orphaned approval request expires via DDB TTL

Approval response (client-side):
  Request expired                → 409 APPROVAL_EXPIRED
  Already resolved               → 409 APPROVAL_ALREADY_RESOLVED
  DDB write fails                → 503, client retries

Race conditions:
  Approval + timeout same instant → First conditional DDB write wins
  Cancel during approval wait     → Callback polls DDB, sees CANCELLED
                                    → PermissionResultDeny(interrupt=True)
```

#### Pause/resume (Phase 4)

```
  Pause DDB write fails          → 503, client retries
  Agent misses pause signal       → Continues until next turn boundary (delayed, not lost)
  Keepalive fails during pause    → Session terminates → TIMED_OUT (15s graceful shutdown)
  maxLifetime reached in pause    → Same: 15s shutdown → TIMED_OUT
  Resume but session timed out    → 409 TASK_TIMED_OUT
```

### 8.3 Unified observability: task_id as the single correlation key

Today, `task_id` flows through all systems but requires querying 4+ views to debug. For interactive features we consolidate around two primary interfaces:

**Primary: `GET /v1/tasks/{id}/events`** — the single debugging API. ALL errors (progress, nudge, approval, pause, transport) emit events to the existing `TaskEventsTable`. An operator sees the complete timeline in one query.

**Secondary: CloudWatch Logs Insights** — for deep dives. All components emit structured JSON logs with `task_id`.

```
Debugging a failed interactive task:

1. bgagent events <task_id>
   → Full timeline: submitted → running → nudge_submitted → nudge_delivered
     → approval_requested → approval_timed_out → task_failed

2. CloudWatch Logs Insights (if more detail needed):
   filter @message like /"task_id":"<task_id>"/
   → All structured logs from agent + orchestrator + API handlers

3. X-Ray Transaction Search (execution timing):
   filter task.id = "<task_id>"
   → Agent spans: task.pipeline > task.agent_execution > task.nudge_processing
```

### 8.4 Task event types for interactive features

All events flow into the existing `TaskEventsTable` (same schema: task_id PK, event_id SK, event_type, metadata, timestamp, ttl).

| Category | Event type | Metadata | Emitted by |
|----------|-----------|----------|------------|
| **Progress** | `progress_writer_failure` | `{error, consecutive_failures}` | Agent ProgressWriter |
| | `progress_writer_disabled` | `{reason: "circuit_breaker"}` | Agent ProgressWriter |
| **Nudge** | `nudge_submitted` | `{nudge_id, user_id, content_preview}` | Nudge API handler |
| | `nudge_guardrail_blocked` | `{nudge_id, reason}` | Nudge API handler |
| | `nudge_delivered` | `{nudge_id, turn}` | Agent NudgeReader |
| | `nudge_delivery_failed` | `{nudge_id, error}` | Agent NudgeReader |
| | `nudge_expired` | `{nudge_id}` | DDB TTL (implicit) |
| **Approval** | `approval_requested` | `{request_id, tool_name, tool_input_preview, risk_level}` | Agent ApprovalGate |
| | `approval_granted` | `{request_id, scope, user_id}` | Approve API handler |
| | `approval_denied` | `{request_id, reason, user_id}` | Approve API handler |
| | `approval_timed_out` | `{request_id, timeout_seconds}` | Agent ApprovalGate |
| | `approval_write_failed` | `{request_id, error}` | Agent ApprovalGate |
| **Pause** | `task_paused` | `{user_id, remaining_lifetime_s}` | Pause API handler |
| | `task_resumed` | `{user_id, pause_duration_s}` | Resume API handler |
| | `keepalive_failure` | `{error}` | Agent keepalive coroutine |
| | `maxlifetime_warning` | `{remaining_s}` | Agent lifecycle monitor |
| **Transport** | `sse_client_connected` | `{client_info}` | Agent SSE handler |
| | `sse_client_disconnected` | `{reason, duration_s}` | Agent SSE handler |

### 8.5 OTEL trace integration

**Existing traces (agent-side):** `task.pipeline` root span with children: `task.context_hydration`, `task.repo_setup`, `task.agent_execution`, `task.post_hooks`. All carry `task.id` attribute. Exported to X-Ray via ADOT sidecar.

**New spans for interactive features:**

```python
# Phase 2: Nudge processing
with task_span("task.nudge_processing", attributes={
    "nudge.id": nudge_id, "nudge.turn": turn_number
}):
    await client.query(nudge.content)

# Phase 3: Approval gate wait
with task_span("task.approval_wait", attributes={
    "tool.name": tool_name, "approval.request_id": request_id
}):
    result = await poll_for_approval(task_id, request_id, timeout=300)
    # Span duration = approval response time (valuable for SLA tracking)

# Phase 4: Pause duration
with task_span("task.paused", attributes={
    "pause.requested_by": user_id
}):
    await wait_for_resume_or_timeout()
    # Span duration = pause duration
```

**Pre-existing gap:** No trace continuity between orchestrator (Node.js Lambda) and agent (Python in AgentCore). They share `task_id` as a string attribute but not W3C trace parent propagation. This is not introduced by interactive features — it's a pre-existing limitation. The `traceId`/`traceParent` headers are passed to `InvokeAgentRuntimeCommand` but the agent's OTEL root span doesn't use them as parent context.

**Claude Code SDK telemetry:** `ENABLE_CLI_TELEMETRY` is currently disabled in `agent.ts`. Enabling it would provide per-tool-call and per-API-request telemetry via OTLP logs — particularly valuable for Phase 3 (approval gates) where we need to see exactly which tool call triggered a gate. **Recommendation:** Enable `ENABLE_CLI_TELEMETRY=1` in Phase 3 and verify ADOT sidecar forwards OTLP logs.

### 8.6 Dashboard additions

New widgets for the existing `BackgroundAgent-Tasks` CloudWatch Dashboard:

| Widget | Source | Query |
|--------|--------|-------|
| **Nudge activity** | TaskEventsTable via Logs Insights | Count of `nudge_submitted`, `nudge_delivered`, `nudge_delivery_failed` per hour |
| **Approval gate metrics** | TaskEventsTable via Logs Insights | Count of `approval_requested`, `approval_granted`, `approval_denied`, `approval_timed_out` per hour |
| **Approval response time** | TaskEventsTable | Time delta between `approval_requested` and `approval_granted`/`approval_denied` — p50, p99 |
| **Pause/resume activity** | TaskEventsTable | Pause count, avg pause duration |
| **Interactive error rate** | TaskEventsTable | Count of `*_failure`, `*_failed` events per hour |

### 8.7 New CloudWatch alarms

| Alarm | Condition | Action |
|-------|-----------|--------|
| **Nudge delivery failure rate** | >20% of `nudge_submitted` result in `nudge_delivery_failed` over 15 min | Investigate agent DDB connectivity |
| **Approval timeout rate** | >50% of `approval_requested` result in `approval_timed_out` over 1 hour | Users not responding — check notification delivery |
| **Stuck in AWAITING_APPROVAL** | Task in AWAITING_APPROVAL >10 min (timeout is 5 min → something broke) | Approval callback may be hung |
| **Stuck in PAUSED** | Task in PAUSED >2 hours (configurable threshold) | User may have forgotten a paused task |
| **Keepalive failure** | Any `keepalive_failure` event | Session at risk of termination |
| **Progress writer circuit breaker** | Any `progress_writer_disabled` event | DDB connectivity degraded — events going dark |

### 8.8 What remains invisible (known gaps)

| Gap | Impact | Mitigation |
|-----|--------|------------|
| **Client-side SSE disconnect** — server doesn't know if client received events | Low — client catches up from DDB | `sse_client_disconnected` event is emitted on the server side when it detects the connection close |
| **No trace continuity orchestrator → agent** | Medium — must correlate by `task_id` string, not trace parent | Pre-existing gap. W3C trace parent propagation is a future enhancement. |
| **Claude Code SDK per-tool telemetry disabled** | Medium — can't see individual API calls or tool decisions within a turn | Enable `ENABLE_CLI_TELEMETRY=1` in Phase 3 |
| **API handler structured logging** | Low — create-task and nudge handlers use default Lambda logging | Add `task_id`-tagged structured logging to all new handlers |

---

## 9. Design decisions (rev 2)

Decisions made during design review, superseding earlier proposals where noted.

### 9.1 Transport: SSE primary, WebSocket upgrade path

**Decision:** Use AG-UI over SSE (`/invocations`) as the primary transport. WebSocket (`/ws`) is an optional upgrade.

**Rationale:** SSE is simpler (just HTTP), has better proxy/firewall compatibility, and `EventSource` clients auto-reconnect. Both SSE and WebSocket share the same 60-minute streaming limit ([AWS quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)), so neither has an advantage there — both need reconnection logic for long tasks. The AG-UI event types are identical on both transports. Client → agent commands go through our REST API regardless of transport.

> **Note:** The AG-UI interrupt/resume pattern (agent emits `RUN_FINISHED` with `outcome='interrupt'`, client sends new POST with `resume`) is currently a [draft specification](https://docs.ag-ui.com/drafts/interrupts), not finalized. Our design does not depend on it — we use DynamoDB polling for nudges and approvals instead.

```
Primary:   Client ←SSE── AgentCore /invocations  (progress streaming)
           Client ──POST→ AgentCore /invocations  (nudge via interrupt/resume)
Upgrade:   Client ←WS→ AgentCore /ws              (bidirectional, mid-turn cancel)
```

### 9.2 Auth: Cognito JWT directly to AgentCore (no Identity Pool)

**Decision:** Configure Cognito User Pool as an inbound identity provider in AgentCore Identity. Users authenticate with the same Cognito JWT they already have — no IAM credentials or Identity Pool needed.

**How it works:**
1. CDK configures Cognito as an inbound IdP in AgentCore Identity (OIDC discovery URL + clientId)
2. CLI exchanges email/password for Cognito JWT (existing flow, no change)
3. CLI passes JWT as `Authorization: Bearer <token>` when connecting to AgentCore SSE/WebSocket
4. AgentCore validates the JWT against the configured Cognito issuer

**What stays the same:** REST API auth (Cognito JWT → API Gateway) is unchanged. Orchestrator Lambda still uses IAM to invoke AgentCore.

### 9.3 HITL approval gates: 3-tier configurable model

> **⚠️ Pending design update (rev 4, tracked 2026-04-17):** This section describes the Phase 3 HITL design as of rev 3. A team discussion (Sam ↔ Alain, 2026-04-17) agreed to replace the hardcoded 3-tier model below with **Cedar policy-driven HITL**, reusing the existing in-process Cedar engine (`agent/src/policy.py` on branch `fix/validate-aws-before-docker-build`, soon to land on main). The existing Cedar decision model (`ALLOW`/`DENY` for tool governance) will be extended with a `REQUIRE_APPROVAL` outcome — same policy language, broader semantics. This enables workflows like AI-DLC where users gate per phase and relax over time.
>
> **Do not implement Phase 3 from the text below.** The design is being revised. Phase 1a and Phase 1b are unaffected and can proceed.

**Decision:** Approval gates are optional. Three modes configurable per-task or per-Blueprint:

| Mode | Behavior | `ClaudeAgentOptions` setting |
|------|----------|------------------------------|
| `autonomous` (default) | All tools auto-approved. Current behavior. | `permission_mode="bypassPermissions"` |
| `smart` | Deterministic rules classify tool calls. Low-risk auto-approved, high-risk triggers gate. | `can_use_tool` callback with rule engine |
| `gated` | All tool calls trigger approval. | `can_use_tool` callback on every call |

**Risk classification (for `smart` mode):**
- Auto-approve: `Read`, `Glob`, `Grep`, `Bash` read-only (`git status`, `cat`, `ls`, `npm test`)
- Gate: `Bash` destructive (regex: `rm -rf`, `git push --force`, `DROP`, etc.), `Write`/`Edit` to sensitive paths (`*.env`, `*credentials*`, `**/infrastructure/**`)
- Rules configurable per-Blueprint via `approval_rules` in repo config

**Why deterministic over LLM:** <1ms vs ~1-2s latency per tool call. Free vs ~$0.001/call. Predictable. Auditable.

### 9.4 Approval scopes: per-call and per-tool-type

**Decision:** Approval responses support scope escalation:

| Scope | Effect |
|-------|--------|
| `this_call` | Approve only this specific tool invocation |
| `tool_type_session` | Approve all future calls to this tool type (e.g., all `Bash`) for the rest of the session |
| `tool_type_pattern` | Approve calls matching a pattern (e.g., `Bash` commands matching `git *`) |
| `all_session` | Switch to autonomous mode for the rest of the session |

The `can_use_tool` callback maintains an in-memory allowlist that accumulates approved scopes.

### 9.5 Nudge rate limits: revised

**Decision:** More generous defaults, configurable per Blueprint:

| Limit | Value | Rationale |
|-------|-------|-----------|
| Min interval | 5 seconds | Prevent accidental double-send |
| Max per task | 50 | Generous for multi-hour sessions |
| Max per minute (per user) | 10 | Prevent flooding |
| Max nudge size | 2,000 chars | Same as task description |

### 9.6 Memory: nudges NOT persisted

**Decision:** Nudges are ephemeral. Stored in DynamoDB `TaskNudgesTable` for audit only. NOT written to AgentCore Memory.

**Rationale:** Memory stores post-hoc summaries (task episodes, repo learnings) at task end. Nudges are ephemeral mid-task steering with no value for future tasks. They would pollute the 2,000-token context hydration budget.

If a nudge changes the agent's approach, the impact appears indirectly in the PR body's "Agent notes" section, which IS captured in memory.

### 9.7 PAUSED state: viable with AgentCore billing model

**Decision:** Support pause up to the `maxLifetime` (8 hours). Set `idleRuntimeSessionTimeout` to 28,800s (matching `maxLifetime`).

**Cost during pause:** AgentCore charges I/O wait as **free for CPU** — only memory is billed during idle. A paused 2-vCPU/8GB session costs ~$0.076/hr vs ~$0.255/hr running (70% savings).

**Implementation:**
- Agent stops turns, keepalive coroutine sends WebSocket pings every 5 min
- `/ping` returns `"HealthyBusy"` during pause
- Track remaining `maxLifetime` on task record; warn user at <15 min remaining

**CDK config:**
```typescript
lifecycleConfiguration: {
  idleRuntimeSessionTimeout: Duration.hours(8),  // Must set explicitly (CDK bug #36376, fixed in CDK >=2.232.1-alpha.0)
  maxLifetime: Duration.hours(8),
}
```

### 9.8 Multi-user: deferred to Iteration 5

**Decision:** Parked. Current design is single-user per task. Schema includes `user_id` on all records for future attribution. No `team_id` dimension yet.

### 9.9 Testing strategy

| Layer | Local | On AgentCore | Key difference |
|-------|-------|-------------|----------------|
| Progress events | Unit test `ProgressWriter` with mocked DDB | E2E: verify events in DDB | DDB VPC endpoint access |
| SSE/WebSocket handler | `pytest` + `httpx`/`websockets` against local FastAPI | Connect via AgentCore endpoint | Auth (JWT vs none) |
| Nudge flow | Unit test nudge queue + mocked `client.query()` | E2E: CLI sends nudge, agent acts | Real async timing |
| Approval gates | Unit test `can_use_tool` with mocked DDB | E2E: agent triggers gate, user approves | Timeout behavior under load |
| AG-UI events | Validate format against AG-UI schema locally | Verify through AgentCore managed proxy | Event buffering/transformation |
| Lifecycle (pause/resume) | Mock timer with test doubles | Real idle timeout, real keepalive | 15-min vs 8-hr timeouts |

**Local testing approach (rev 3):** DynamoDB Local via `docker compose` for progress event verification. The agent container connects to DDB Local on the `agent-local` network; boto3 is redirected via `AWS_ENDPOINT_URL_DYNAMODB`. No code changes to the feature — the same `_ProgressWriter` code that runs in production writes to DDB Local transparently.

**Local testing workflow:**

```bash
# 1. Start DDB Local and create tables
cd agent && mise run local:up

# 2. Run agent with progress events enabled
./agent/run.sh --local-events "owner/repo" 42

# 3. Query events (in another terminal)
mise run local:events          # table format
mise run local:events:json     # JSON format

# 4. Tear down
mise run local:down
```

**How it works:** `run.sh --local-events` connects the agent container to the `agent-local` Docker network (shared with DDB Local), sets `TASK_EVENTS_TABLE_NAME=TaskEventsTable`, `TASK_TABLE_NAME=TaskTable`, and `AWS_ENDPOINT_URL_DYNAMODB=http://dynamodb-local:8000`. The `_ProgressWriter` and `task_state` modules use boto3's service-specific endpoint override transparently — zero code changes.

**Infrastructure files:**

| File | Purpose |
|------|---------|
| `agent/docker-compose.yml` | DDB Local service on `agent-local` network |
| `agent/scripts/create-local-tables.sh` | Creates `TaskEventsTable` + `TaskTable` schemas in DDB Local |
| `agent/run.sh` (`--local-events` flag) | Connects agent container to DDB Local |
| `agent/mise.toml` (`local:*` tasks) | `local:up` (start + create tables), `local:down`, `local:events` |

**Integration testing:** Deploy to AgentCore, run automated E2E suite via CLI.

## 10. Implementation plan

### Overview: phased transport progression

Each phase is independently shippable. We implement, test, and validate one before starting the next. The application logic (progress events, nudges, approvals) is built in Phase 1a and carried forward unchanged — later phases only change the transport.

```
Phase 1a: DDB + REST polling     → Build all app logic, zero new infra
Phase 1b: AgentCore SSE          → Real-time streaming upgrade, compare latency
Phase 1c: WebSocket (optional)   → Only if SSE insufficient (separate task)
Phase 2:  Nudge                  → User → agent steering via REST endpoints
Phase 3:  HITL approval gates    → can_use_tool callback + approval REST endpoint
Phase 4:  Pause/Resume           → Lifecycle control (leverages 8-hour timeout)
```

### Phase 1a: DDB + REST polling (foundation)

**Goal:** Users can see agent progress. All core plumbing built. Zero new auth or infrastructure.

| Package | File | Change |
|---------|------|--------|
| `agent/` | `progress_writer.py` | NEW: Writes structured AG-UI events to DDB `TaskEventsTable` (best-effort, fail-open) |
| `agent/` | `entrypoint.py` | Add `_ProgressWriter` to `run_agent()` message loop |
| `agent/` | `tests/test_progress_writer.py` | NEW: Tests |
| `cli/` | `src/commands/watch.ts` | NEW: `bgagent watch <task_id>` — polls `GET /tasks/{id}/events` every 2s, renders progress |
| `cli/` | `test/commands/watch.test.ts` | NEW: Tests |

**Auth:** Existing Cognito JWT → API Gateway. No changes.
**Latency:** ~2-5 seconds (poll interval).
**Risk:** Low. Minimal changes, uses existing DDB infrastructure.

**Validation criteria before proceeding to 1b:**
- Progress events written correctly (turn count, tool calls, cost, timing)
- `bgagent watch` displays useful real-time(ish) output
- No regression in existing task flow (fire-and-forget still works)

---

### Phase 1b: AgentCore SSE (real-time streaming upgrade)

**Goal:** Replace polling with real-time SSE from AgentCore `/invocations`. Measure latency improvement.

| Package | File | Change |
|---------|------|--------|
| `agent/` | `server.py` | Add SSE response support to `/invocations` (AG-UI event stream) |
| `agent/` | `sse_handler.py` | NEW: AG-UI SSE event formatter and stream manager |
| `agent/` | `tests/test_sse_handler.py` | NEW: Tests |
| `cdk/` | `src/stacks/agent.ts` | Configure AgentCore Identity with Cognito as inbound IdP |
| `cli/` | `src/commands/watch.ts` | Add SSE mode: connect to AgentCore `/invocations` with JWT bearer auth |
| `cli/` | `src/agentcore-auth.ts` | NEW: AgentCore Identity JWT bearer auth for SSE connections |

**Auth:** AgentCore Identity (separate service from Runtime) configured with Cognito User Pool as inbound IdP. Users send existing Cognito JWT as `Authorization: Bearer <token>`.
**Latency target:** ~100ms (compare with Phase 1a's 2-5s).
**Risk:** Medium. New auth path (AgentCore Identity). SSE keepalive behavior during idle periods needs validation.

**60-minute streaming limit:** Both SSE and WebSocket share a 60-minute max streaming duration ([quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)). The CLI must reconnect every ~55 minutes and fetch missed events from DDB (`GET /tasks/{id}/events?after={last_event_id}`) to maintain a seamless experience.

**Validation criteria before proceeding:**
- SSE events arrive with <500ms latency
- Auth works with existing Cognito JWT (no new credentials for users)
- Graceful degradation when SSE disconnects (fall back to DDB polling)
- Reconnection after 60-minute limit works seamlessly (no missed events)

---

### Phase 1c: WebSocket upgrade (optional, separate task)

**Only if SSE proves insufficient.** Adds `/ws` handler to `server.py`. Same AG-UI events, bidirectional transport. **Not part of the initial interactive agents scope.**

---

### Phase 2: Nudge (user → agent steering)

**Goal:** Users can send course corrections to a running agent between turns.

**Transport:** REST `POST /v1/tasks/{id}/nudge` through our API Gateway (existing Cognito auth). Works with both Phase 1a (polling) and Phase 1b (SSE). No dependency on WebSocket.

| Package | File | Change |
|---------|------|--------|
| `cdk/` | `src/constructs/task-nudges-table.ts` | NEW: DynamoDB table for nudge storage + audit |
| `cdk/` | `src/handlers/nudge-task.ts` | NEW: `POST /tasks/{id}/nudge` Lambda handler (validate, guardrail screen, write DDB) |
| `cdk/` | `src/constructs/task-api.ts` | Add `/tasks/{task_id}/nudge` POST route |
| `agent/` | `nudge_reader.py` | NEW: Polls DDB `TaskNudgesTable` between turns, consumes pending nudges |
| `agent/` | `entrypoint.py` | Modify `run_agent()`: check nudge_reader between turns, inject via `client.query()` |
| `agent/` | `tests/test_nudge_reader.py` | NEW: Tests |
| `cli/` | `src/commands/nudge.ts` | NEW: `bgagent nudge <task_id> "message"` |
| `cli/` | `test/commands/nudge.test.ts` | NEW: Tests |

**Testing:**
- Unit: nudge validation, guardrail screening, DDB consumption logic
- Integration: submit task → send nudge via REST → verify agent acts on it
- Security: non-owner cannot nudge, guardrail blocks injection, rate limits enforced

**Risk:** Medium-High. Core agent loop modification (`run_agent()`) is the riskiest change.

---

### Phase 3: HITL approval gates

**Goal:** Agent requests human approval before high-risk operations. 3-tier model: `autonomous`/`smart`/`gated`.

| Package | File | Change |
|---------|------|--------|
| `cdk/` | `src/constructs/task-status.ts` | Add `AWAITING_APPROVAL` state and transitions |
| `cdk/` | `src/handlers/approve-task.ts` | NEW: `POST /tasks/{id}/approve` Lambda handler |
| `cdk/` | `src/constructs/task-api.ts` | Add `/tasks/{task_id}/approve` POST route |
| `agent/` | `approval_gate.py` | NEW: `can_use_tool` callback with rule engine, DDB write/poll for decisions |
| `agent/` | `entrypoint.py` | Register `can_use_tool` callback based on `approval_mode` config |
| `agent/` | `tests/test_approval_gate.py` | NEW: Tests |
| `cli/` | `src/commands/approve.ts` | NEW: `bgagent approve <task_id> <request_id> [--scope tool_type_session]` |

**Testing:**
- Unit: risk classification rules, approval callback, scope escalation, timeout
- Integration: submit task with `approval_mode: "smart"` → agent hits destructive Bash → approval request event → user approves → agent continues
- Timeout: verify auto-denial after 5 minutes, agent receives denial context

**Risk:** High. Async waiting in agent process, new state machine state, timing-sensitive coordination.

---

### Phase 4: Pause/Resume

**Goal:** Users can temporarily halt and resume agent execution, up to the 8-hour `maxLifetime`.

| Package | File | Change |
|---------|------|--------|
| `cdk/` | `src/constructs/task-status.ts` | Add `PAUSED` state and transitions |
| `cdk/` | `src/handlers/pause-task.ts` | NEW: `POST /tasks/{id}/pause` and `POST /tasks/{id}/resume` Lambda handlers |
| `cdk/` | `src/constructs/task-api.ts` | Add pause/resume routes |
| `cdk/` | `src/stacks/agent.ts` | Set `idleRuntimeSessionTimeout: 28800`, `maxLifetime: 28800` |
| `agent/` | `entrypoint.py` | Add pause detection between turns, keepalive coroutine, `/ping` `"HealthyBusy"` during pause |

**Risk:** Medium. Depends on validated keepalive behavior from Phase 1b/1c.

---

## 11. Proof-of-concept scope

### Phase 1a IS the PoC

Phase 1a (DDB + REST polling) is the smallest useful end-to-end slice. It validates ALL application logic with zero new infrastructure:

1. Agent writes structured progress events to DynamoDB (new `_ProgressWriter`)
2. CLI `bgagent watch <task_id>` polls events every 2 seconds
3. No SSE, no WebSocket, no AgentCore Identity, no new auth

**Estimated effort:** 2-3 days. Changes only in `agent/` and `cli/`.

**What it validates:**
- Agent can write structured progress events without breaking the existing fire-and-forget flow
- Events contain useful information (turn count, tool calls, cost, timing)
- CLI can display near-real-time progress
- The `ProgressWriter` → DDB pattern works (this same writer is reused in all later phases)

### Riskiest assumptions to validate

1. **Can `client.query()` be called while `receive_messages()` is active?** — The SDK docs say yes (bidirectional), but we need to verify this works within the AgentCore MicroVM's asyncio context. Blocks Phase 2 (nudges).
2. **Does the agent's DynamoDB access work for enriched event writes?** — The agent already reads/writes to the task table. Writing more data to the events table needs IAM verification.
3. **Does the nudge-between-turns pattern work reliably?** — The agent may be in the middle of a long tool call (e.g., running tests for 5 minutes). Nudges can only be consumed after the current turn completes. Blocks Phase 2.
4. **Can the `can_use_tool` callback block for minutes?** — Waiting for user approval in an async callback within the Claude SDK. Blocks Phase 3.

---

## 12. Open questions

### Resolved (during design review)

| # | Question | Resolution |
|---|----------|------------|
| OQ-I2 | WebSocket fan-out latency? | **Moot** — using DDB polling (Phase 1a) then AgentCore SSE (Phase 1b), not API Gateway WebSocket fan-out. |
| OQ-I5 | Multi-user nudge authorization? | **Deferred** to Iteration 5. Single-user per task for now. |
| OQ-I7 | Idle timeout makes pause impractical? | **Resolved** — `idleRuntimeSessionTimeout` configurable up to 8 hours. Set to match `maxLifetime`. `/ping` returning `"HealthyBusy"` prevents termination. CPU billing stops during idle. |

### Still open

| # | Question | Needs input from | Impact |
|---|----------|-----------------|--------|
| OQ-I1 | Does AgentCore plan to add native session messaging APIs? If so, we should align rather than building the DDB signaling layer. | AWS AgentCore team | Could simplify nudge/approval delivery |
| OQ-I3 | Can the `can_use_tool` callback block for minutes (waiting for user approval) without causing SDK issues? | Testing / Anthropic SDK team | Blocks Phase 3 (HITL approval gates) |
| OQ-I4 | Should nudges be visible in the PR body? If the agent changes direction because of a nudge, the PR should document why. | Product decision | Affects how nudge context threads into agent conversation |
| OQ-I6 | Should partial message streaming (per-token) be exposed to clients, or is per-turn granularity sufficient? | Product decision + cost analysis | Affects event volume and DDB write cost |
| OQ-I8 | How many concurrent SSE connections can a single AgentCore session handle? Not documented. | Testing | Determines if multiple clients can watch the same task simultaneously via SSE |
| OQ-I9 | Does AgentCore SSE support `Last-Event-ID` for stream resumption? Research indicates no. | Testing | Affects reconnection behavior — missed events must come from DDB fallback |

---

## Appendix A: Competitive landscape

### Platform comparison (April 2026)

| Platform | Streaming | Mid-task steering | Approval gates | Architecture |
|----------|-----------|-------------------|----------------|--------------|
| **GitHub Copilot (cloud)** | None (fire-and-forget) | None — get PR notification | None | Async |
| **Cursor Background Agents** | VM video recording | Limited | Fire-and-forget | Isolated VMs, 8 parallel |
| **Devin AI** | Plan + progress via Slack | **Interruptible at any stage** | Plan-then-execute | Stateful sessions |
| **OpenAI Codex** | Terminal logs in sidebar | None mid-task (cloud) | Per-action in IDE | Isolated containers |
| **Claude Code (CLI)** | Per-token in terminal | **Dual-buffer queue, pause/resume** | 3 modes + 12 hooks | Master agent loop |
| **Augment Code** | AG-UI protocol | Interactive CLI | Fire-and-forget | 10 parallel VM agents |
| **Windsurf/Cascade** | Real-time lockstep | **Mid-generation steering** | Per-edit in IDE | Cascade, 950 tok/s |
| **Cline** | Per-action diff display | **Per-action gate** | Every edit needs approval | Most conservative |

### Emerging standard: AG-UI protocol

The [AG-UI protocol](https://github.com/copilotkit/ag-ui) (CopilotKit, May 2025) defines 17 event types for agent-to-UI communication. Adopted by LangGraph, CrewAI, AG2, Pydantic AI, Microsoft Agent Framework. **AgentCore supports AG-UI natively** (March 2026) — this is the protocol we should implement.

### Key insight

ABCA's current gap (no streaming, no steering) places it alongside GitHub Copilot's cloud agent at the async end. This design moves it to the middle: streaming + between-turn nudges + graduated approval gates. Going to per-action gates (Cline) is not a goal — the background agent model is inherently autonomous.

Sources: [GitHub](https://docs.github.com/en/copilot/responsible-use-of-github-copilot-features/responsible-use-of-copilot-coding-agent-on-githubcom), [Devin](https://cognition.ai/blog/devin-2), [Codex](https://openai.com/index/introducing-codex/), [Claude Code architecture](https://blog.promptlayer.com/claude-code-behind-the-scenes-of-the-master-agent-loop/), [AG-UI](https://www.codecademy.com/article/ag-ui-agent-user-interaction-protocol)

---

## Appendix B: SDK version references

| Package | Version | Source |
|---------|---------|--------|
| `@aws-sdk/client-bedrock-agentcore` | 3.1030.0 | npm (2026-04-13) |
| `claude-agent-sdk` | 0.1.53 | PyPI |
| `@anthropic-ai/claude-code` | 2.1.109 | npm (2026-04-15) |
| `@aws-cdk/aws-bedrock-agentcore-alpha` | (installed in cdk/) | CDK L2 construct |

---

## Appendix C: File change map

### Phase 1a (DDB + REST polling) — New files

```
agent/progress_writer.py                         # Writes AG-UI events to DDB (best-effort, fail-open)
agent/tests/test_progress_writer.py              # Tests
cli/src/commands/watch.ts                        # bgagent watch (polls GET /tasks/{id}/events)
cli/test/commands/watch.test.ts                  # Tests
```

### Phase 1a — Modified files

```
agent/entrypoint.py                              # Add _ProgressWriter to run_agent() message loop
cli/src/bin/bgagent.ts                           # Register watch command
```

### Phase 1b (AgentCore SSE) — New files

```
agent/sse_handler.py                             # AG-UI SSE event formatter + stream manager
agent/tests/test_sse_handler.py                  # Tests
cli/src/agentcore-auth.ts                        # AgentCore Identity JWT bearer auth
```

### Phase 1b — Modified files

```
agent/server.py                                  # Add SSE response to /invocations
cdk/src/stacks/agent.ts                          # Configure AgentCore Identity with Cognito IdP
cli/src/commands/watch.ts                        # Add SSE mode alongside polling fallback
```

### Phase 2 (Nudge) — New files

```
agent/nudge_reader.py                            # Polls DDB TaskNudgesTable between turns
agent/tests/test_nudge_reader.py                 # Tests
cdk/src/constructs/task-nudges-table.ts          # DynamoDB nudge storage + audit table
cdk/src/handlers/nudge-task.ts                   # POST /tasks/{id}/nudge handler
cli/src/commands/nudge.ts                        # bgagent nudge command
cli/test/commands/nudge.test.ts                  # Tests
```

### Phase 2 — Modified files

```
agent/entrypoint.py                              # Check nudge_reader between turns, inject via client.query()
cdk/src/constructs/task-api.ts                   # Add /tasks/{task_id}/nudge route
cdk/src/stacks/agent.ts                          # Wire nudges table, grant Runtime IAM
```

### Phase 3 (Approval Gates) — New files

```
agent/approval_gate.py                           # can_use_tool callback + rule engine + DDB poll
agent/tests/test_approval_gate.py                # Tests
cdk/src/handlers/approve-task.ts                 # POST /tasks/{id}/approve handler
cli/src/commands/approve.ts                      # bgagent approve command
cli/test/commands/approve.test.ts                # Tests
```

### Phase 3 — Modified files

```
cdk/src/constructs/task-status.ts                # Add AWAITING_APPROVAL state, transitions, ACTIVE_STATUSES
cdk/src/constructs/task-api.ts                   # Add /tasks/{task_id}/approve route
cdk/src/handlers/orchestrate-task.ts             # waitStrategy (inline at line 143): recognize AWAITING_APPROVAL
cdk/src/handlers/shared/orchestrator.ts          # finalizeTask(): handle AWAITING_APPROVAL (avoid "Unexpected state")
cdk/src/handlers/reconcile-concurrency.ts        # Active states filter (hardcoded strings, not shared constant)
agent/entrypoint.py                              # Register can_use_tool callback based on approval_mode
agent/task_state.py                              # write_terminal() ConditionExpression: add AWAITING_APPROVAL
cli/src/types.ts                                 # Add AWAITING_APPROVAL to TaskStatusType (keep in sync)
docs/design/ORCHESTRATOR.md                      # Update state machine documentation
```

### Phase 4 (Pause/Resume) — New files

```
cdk/src/handlers/pause-task.ts                   # POST /tasks/{id}/pause and /resume handlers
```

### Phase 4 — Modified files

```
cdk/src/constructs/task-status.ts                # Add PAUSED state, transitions, ACTIVE_STATUSES
cdk/src/constructs/task-api.ts                   # Add pause/resume routes
cdk/src/handlers/orchestrate-task.ts             # waitStrategy (inline): longer interval during PAUSED (60s vs 30s)
cdk/src/handlers/shared/orchestrator.ts          # finalizeTask(): handle PAUSED (avoid "Unexpected state")
cdk/src/handlers/reconcile-concurrency.ts        # Active states filter (hardcoded strings)
cdk/src/stacks/agent.ts                          # Set idleRuntimeSessionTimeout + maxLifetime to 8hrs
agent/entrypoint.py                              # Pause detection, keepalive coroutine, HealthyBusy ping
agent/task_state.py                              # write_terminal() ConditionExpression: add PAUSED
agent/server.py                                  # /ping: return HealthyBusy during PAUSED (verify AgentCore format)
cli/src/types.ts                                 # Add PAUSED to TaskStatusType (keep in sync)
```

> **Note on `/ping` response format:** The current `/ping` returns `{"status": "healthy"}` (JSON dict). AgentCore's async agent guide expects `{"status": "HealthyBusy"}` — verify the exact expected format before implementation. See [AgentCore long-running agents guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html).
