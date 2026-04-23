# Interactive Agents: Bidirectional Communication Design

> **Status:** Draft — research phase
> **Branch:** `feature/interactive-background-agents`
> **Roadmap:** Pulls forward items from Iteration 4 (WebSocket + nudge) and Iteration 6 (iterative feedback + HITL approval)
> **Last updated:** 2026-04-17 (rev 4 — Phase 1b decisions D1/D2/D3 resolved; incorporates AWS primary-source research on AgentCore streaming caps and lifecycle timers; adds control/streaming/fan-out plane framing)

---

## Executive summary

ABCA agents currently run in a fire-and-forget model: the user submits a task, the agent works autonomously in a Firecracker MicroVM, and the result appears as a PR. Users have no real-time visibility into agent progress and no ability to steer a running agent.

This design adds **bidirectional interactivity** through two core capabilities:

1. **Progress streaming (agent → user):** Real-time events (thinking, tool calls, milestones, errors) streamed from the agent to connected clients. Phased transport: DynamoDB polling → AgentCore SSE → optional WebSocket upgrade.
2. **User steering (user → agent):** Nudges, pause/resume, and approval gates that let users redirect or gate agent behavior mid-task, delivered via REST API endpoints through existing API Gateway auth.

### Key findings from research

| Area | Finding | Impact |
|------|---------|--------|
| **AgentCore Runtime — AG-UI protocol** | AgentCore supports both **SSE** (`/invocations`) and **WebSocket** (`/ws`) with identical AG-UI event types. SSE is simpler to implement and operate. Both transports share AgentCore's hard 60-minute streaming cap — §9.12 covers the reconnect + DDB catch-up pattern. AG-UI interrupt/resume pattern enables bidirectional interaction over SSE via sequential POST requests. | **SSE is our primary transport.** WebSocket is the Phase 1c+ upgrade path for bidirectional nudges. |
| **AgentCore Runtime — Lifecycle** | `idleRuntimeSessionTimeout` configurable up to 8 hours. `maxLifetime` up to 8 hours. CPU billing stops during I/O wait (paused sessions cost ~70% less). `/ping` returning `"HealthyBusy"` prevents platform termination. | **Long pauses are economically viable.** Set both timeouts to 8 hours. |
| **AgentCore Identity** | Separate service from AgentCore Runtime. Supports **Cognito User Pool as inbound IdP** — users authenticate with existing Cognito JWT as OAuth bearer token. No IAM credentials or Identity Pool needed. | **Same JWT for REST API and AgentCore direct access.** Single auth credential for users. |
| **Claude Agent SDK** | `ClaudeSDKClient` supports bidirectional multi-turn conversations. `client.query()` injects messages between turns. `can_use_tool` callback enables HITL approval gates. Hooks fire per-tool-call. | **The SDK natively supports everything we need for agent-side interactivity.** |
| **Transport decision** | SSE for streaming (agent→client), REST for commands (client→agent). All commands go through our API Gateway with existing Cognito auth. No new auth infrastructure for Phase 1a. | **Simplest possible architecture for initial delivery.** |

---

## Revision history

| Rev | Date | Summary |
|-----|------|---------|
| 1 | 2026-04-xx | Initial draft — research on AgentCore, Claude Agent SDK, AG-UI, competitive landscape. |
| 2 | 2026-04-xx | Design review outcomes: SSE-first transport, Cognito-direct auth, 3-tier HITL, nudge rate limits, PAUSED viability confirmed, testing strategy. |
| 3 | 2026-04-16 | Phase 1a scope locked (DDB + REST polling). Adds local testing infrastructure (DynamoDB Local via `docker compose`, `run.sh --local-events`, `mise run local:*` tasks). |
| 4 | 2026-04-17 | Phase 1b decisions **D1 / D2 / D3 resolved** (two-runtime split, background-thread + `asyncio.Queue` SSE, hybrid CLI SSE client). Incorporates AWS primary-source research on the three AgentCore streaming duration ceilings (15 min sync / **60 min streaming** / 8 h async) and the two adjustable session timers (`idleRuntimeSessionTimeout`, `maxLifetime`). Adds the **control plane / streaming plane / fan-out plane** framing (§8.9) and channel-fit matrix. Records the Phase 3 ADR trigger for revisiting a full-async `server.py` refactor. Marks §9.3 (HITL) as still pending Cedar-driven rev (Phase 2/3 scope). |
| 5 | 2026-04-21 | **Execution-location clarification (§9.13):** first live SSE bring-up against the deployed stack revealed that the initial Phase 1b design conflated three distinct interaction modes, causing duplicate pipeline execution when a CLI opened SSE for a task that was already spawned via the orchestrator path. Resolved by adopting **Branch A** from a competitive-architecture study (LangGraph Platform, Vercel `resumable-stream`, CopilotKit, Mastra, OpenAI Assistants — see `docs/research/agent-streaming-patterns.md`): introduce a direct **`submit --watch` / `bgagent run`** path where the CLI POSTs straight to Runtime-JWT and the pipeline runs **same-process** with the SSE stream (real-time, no orchestrator). Plain `submit` (no watch) continues to go via the orchestrator for fire-and-forget / non-interactive flows. `watch` against a task started elsewhere degrades to **polling** — real-time cross-runtime attach is deferred to **Phase 1c** (pub/sub layer: IoT Core MQTT or ElastiCache Redis). Also lands the **attach-don't-spawn** logic in `server.py` (same-session-ID re-invocations observe the existing in-process pipeline rather than spawning a duplicate) and the **`/ping HealthyBusy`** idle-eviction guard while a task's pipeline is active. Three SSE-path production bugs fixed in the same cycle: access-token vs ID-token routing, 33-char session-ID minimum (`bgagent-watch-<task_id>` prefix), and CloudWatch debug writes running on a daemon thread so uvicorn binds port 8080 before AgentCore's health check fires. |

---

## Table of contents

1. [Current architecture analysis](#1-current-architecture-analysis)
2. [AgentCore Runtime API research](#2-agentcore-runtime-api-research)
3. [Claude Agent SDK research](#3-claude-agent-sdk-research)
4. [Transport architecture](#4-transport-architecture-phased-progression)
5. [Bidirectional communication architecture](#5-bidirectional-communication-architecture)
6. [Security and trust model](#6-security-and-trust-model)
7. [State machine extensions](#7-state-machine-extensions)
8. [Error handling and observability](#8-error-handling-and-observability) — error propagation, unified debugging, OTEL traces, dashboard, alarms, control/streaming/fan-out planes
9. [Design decisions (rev 4)](#9-design-decisions-rev-4) — transport, auth, HITL modes, nudge limits, memory, pause, testing, D1/D2/D3 resolutions, AgentCore streaming limits
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

### Phase 1b: resolved design parameters

Three architectural decisions were resolved on 2026-04-17 after primary-source AWS research and CDK/SDK code inspection. Full rationale in §9.1.1, §9.10, and §9.11; §9.12 documents the AgentCore streaming constraints that shape them.

**D1 — Two AgentCore Runtimes, shared Docker image (§9.1.1).** Deploy a second AgentCore Runtime alongside the existing one. `Runtime-IAM` preserves the orchestrator path (SigV4 from `OrchestratorFn` Lambda, Phase 1a behavior intact). `Runtime-JWT` is new, with `authorizerConfiguration: customJWTAuthorizer` pointing at the Cognito User Pool JWKS URL plus allowed audiences — this is the CLI's direct SSE path. Both runtimes consume the **same `AgentRuntimeArtifact`** / Docker image. Sessions are scoped to a single runtime ARN and cannot transfer across runtimes; cross-path *observation* still works because `ProgressWriter` writes to the same `TaskEventsTable` from inside the container regardless of which runtime invoked it. An API-Gateway JWT→IAM bridge (Option B in exploration) was rejected because it defeats the "direct CLI→AgentCore" latency goal and re-introduces the very failure point we are routing around.

**D2 — Background thread + `asyncio.Queue` bridge in `server.py` (§9.10).** The synchronous `run_task` stays on a background thread, keeping the Phase 1a REST path regression-free (305 passing tests). A new `agent/src/sse_adapter.py` is added as a **sibling of `agent/src/progress_writer.py`**; both receive events at the same call sites in `pipeline.py` and `runner.py`. `ProgressWriter` writes to DynamoDB (durable, auditable, catch-up source); `SSEAdapter` pushes to a per-session `asyncio.Queue`. A new SSE handler drains the queue, emits AG-UI-formatted `data: <json>\n\n` frames, and injects `: ping\n\n` keepalives every ~15 s. A full-async refactor (Option A) would require the orchestrator path — which is a synchronous `InvokeAgentRuntimeCommand` inside a 15-minute Lambda — to hold open streams of up to 60 minutes, which is incompatible. The queue boundary makes the producer agnostic: thread today, coroutine tomorrow.

**D3 — Hybrid CLI SSE client (§9.11).** Import `@ag-ui/core` for the 17 event **types and Zod schemas only**. Own the transport via native `fetch` plus `eventsource-parser` (32.7 M weekly npm downloads). A CLI-side wrapper handles reconnection with exponential backoff, JWT refresh, and the mandatory 60-minute stream restart. **Do not use `@ag-ui/client` `HttpAgent`** — it is 0.0.x pre-1.0, single-shot request model, with no built-in reconnection, backoff, or token refresh (a 60-minute stream with a blip terminates as `RUN_ERROR`; we would wrap it anyway). Betting on the wire format is cheap (AG-UI is the multi-framework standard, officially supported by AgentCore as of March 2026); hand-maintaining the type catalog is a losing bet because the event set grew from 4→16 types in 2025.

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

    progress_writer = _ProgressWriter(config["task_id"])  # DDB durability (Phase 1a, unchanged)
    sse_adapter   = _SSEAdapter(config["task_id"])        # Phase 1b: sibling, pushes to asyncio.Queue
    nudge_reader  = _NudgeReader(config["task_id"])

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

        # Write progress event (Phase 1a): durable, auditable, catch-up source for reconnects.
        progress_writer.write_event(message)

        # Phase 1b: ALSO push to the per-session asyncio.Queue for the SSE handler to drain.
        # Both writers receive events at identical call sites; they are siblings, not a chain.
        sse_adapter.emit(message)

        # Check for pending nudges between turns
        if isinstance(message, AssistantMessage):
            nudge = await nudge_reader.check_pending()
            if nudge:
                await client.query(nudge.content)
                nudge_reader.mark_consumed(nudge.nudge_id)

        if isinstance(message, ResultMessage):
            break
```

**Architectural note (rev 4):** `ProgressWriter` is the Phase 1a deployed code and is **not modified** in Phase 1b. `SSEAdapter` is added as a peer (same call sites in `pipeline.py` and `runner.py`), so the durable DDB path and the live SSE push path cannot diverge. The SSE handler in `server.py` drains the queue asynchronously; if no clients are attached the queue is bounded and events are dropped silently (DDB remains authoritative). See §9.10 for the full producer-consumer architecture.

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

SSE connection drops (Phase 1b: network, 60-min streaming cap, proxy timeout)
  → CLI wrapper (own `fetch` + eventsource-parser, see §9.11) detects close and
    reconnects with exponential backoff; JWT is refreshed if expiring
  → On reconnect: GET /tasks/{id}/events?after=<event_id> for app-level catch-up
    (this is the ONLY reconnection mechanism — AgentCore does not support
     Last-Event-ID or any SSE-native resume; see §9.12)
  → Merge DDB events with the new SSE stream (deduplicate by event_id)
  → DDB is source of truth; SSE is the fast path
  → Behavior at the 60-min streaming cap is partially documented by AWS:
    may arrive as a clean `RUN_ERROR` SSE frame OR an abrupt TCP close.
    The CLI handles both cases identically (reconnect + catch-up)
```

**AgentCore streaming hard cap (new in rev 4).** Three independent duration ceilings apply to `InvokeAgentRuntime`, all **hard / non-adjustable**: 15 min for sync invocations, **60 min for streaming invocations** (the SSE-relevant one), and 8 h for async jobs. These are orthogonal to the two session-level timers (`idleRuntimeSessionTimeout` default 900 s, `maxLifetime` default 28,800 s — both adjustable via `LifecycleConfiguration`, see §9.12). A 60-minute streaming cap means every long-running CLI watcher **must** reconnect at least once per hour even on a healthy connection; catch-up via `GET /tasks/{id}/events?after=<event_id>` is therefore a required path, not a degraded path. Sources: [Quotas for Amazon Bedrock AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html), [Runtime lifecycle settings](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html).

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

### 8.9 Control plane vs streaming plane vs fan-out plane

A recurring source of confusion in the rev 1–3 drafts was the label "REST path" for the non-SSE code. That framing is misleading: the REST control plane is not a legacy fallback — it is the persistent backbone that every channel (interactive and non-interactive) uses. SSE and DDB-Stream fan-out are additive delivery layers on top of it, not replacements. Rev 4 makes the three planes explicit.

**Three orthogonal planes:**

1. **Control plane — REST (always on).** `POST /tasks` submission is fire-and-forget and channel-agnostic: CLI, Slack bot, GitHub webhook handler, cron job, and agent-to-agent callers all use it. Admission control (guardrail screening, idempotency keys, repo-onboarded check, concurrency caps), `GET /tasks/{id}` status, cancellation, onboarding, and webhook config all live here. Crucially, **`GET /tasks/{id}/events?after=<event_id>` is the only event reconnection mechanism** — because AgentCore SSE has no `Last-Event-ID` and no native resume (§9.12), any SSE client that drops must come back through the control plane to catch up.

2. **Streaming plane — SSE (consumption-only, for interactive watchers).** SSE adds real-time server→client delivery for CLI and web-SPA clients who are watching a task live. It does **not** replace the control plane — it augments it. Clients always submit through `POST /tasks` and always catch up through `GET /tasks/{id}/events?after=<event_id>`; SSE sits between those two control-plane calls. The streaming plane is bounded by the AgentCore 60-minute hard cap (§9.12) and is only useful while a human (or interactive agent) is attached.

3. **Fan-out plane — DDB Stream → destination APIs (for async consumers).** Non-interactive channels (Slack bot, GitHub PR comments, email, SMS, cron, archival) consume from the `TaskEventsTable` DynamoDB Stream via a fan-out Lambda that posts to the destination API (`chat.postMessage`, GitHub `POST /issues/{n}/comments`, SES `SendEmail`, SNS publish). The fan-out plane is **additive to Phase 1b** — at minimum Phase 1b ensures DynamoDB Streams are enabled on `TaskEventsTable`; the fan-out Lambda itself can ship later without any change to the agent or CLI. This is the right delivery mechanism for ack-in-3-seconds channels (Slack) and one-shot-on-completion channels (email/SMS).

**WebSocket (Phase 1c+) is complementary, not a replacement.** AgentCore exposes `/ws` alongside `/invocations`; a future upgrade to bidirectional nudges (real-time mid-turn steering, mid-turn cancellation) needs WebSocket because SSE is server→client only. WebSocket sits next to REST + SSE in the channel matrix — it does not subsume them. Not in Phase 1b scope.

**Channel-fit matrix:**

| Channel | Submission | Consumption pattern | Consumption transport |
|---|---|---|---|
| CLI | `POST /tasks` (sync reply) | User watches live | SSE direct to Runtime-JWT |
| Web SPA | `POST /tasks` | User watches live | SSE direct to Runtime-JWT |
| Slack bot | `POST /tasks` (must ack in 3 s) | Async push into channel | DDB Stream → `chat.postMessage` |
| GitHub webhook | internal `POST /tasks` | Async PR comment on completion | DDB Stream → PR comment |
| Email / SMS | `POST /tasks` | One-shot on completion | DDB Stream → SES / SNS |
| Cron / CI | `POST /tasks` | Status check later | REST `GET` polling |
| Agent-to-agent | either | either | SSE or polling |

**Implication for Phase 1b implementation:** the streaming plane requires the Runtime-JWT construct (D1) and the SSE adapter (D2); the fan-out plane requires only that `TaskEventsTable` has DynamoDB Streams enabled (and optionally a skeleton fan-out Lambda — the actual Slack/email/GitHub integrations can follow in later iterations without any breaking change).

---

## 9. Design decisions (rev 4)

Decisions made during design review, superseding earlier proposals where noted.

### 9.1 Transport: SSE primary, WebSocket upgrade path

**Decision:** Use AG-UI over SSE (`/invocations`) as the primary transport. WebSocket (`/ws`) is an optional upgrade.

**Rationale:** SSE is simpler (just HTTP), has better proxy/firewall compatibility, and properly-written clients can auto-reconnect with app-level catch-up. Both SSE and WebSocket share the same 60-minute streaming limit ([AWS quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)), so neither has an advantage there — both need reconnection logic for long tasks. The AG-UI event types are identical on both transports. Client → agent commands go through our REST API regardless of transport.

> **Note:** The AG-UI interrupt/resume pattern (agent emits `RUN_FINISHED` with `outcome='interrupt'`, client sends new POST with `resume`) is currently a [draft specification](https://docs.ag-ui.com/drafts/interrupts), not finalized. Our design does not depend on it — we use DynamoDB polling for nudges and approvals instead.

```
Primary:   Client ←SSE── AgentCore /invocations  (progress streaming)
           Client ──POST→ AgentCore /invocations  (nudge via interrupt/resume)
Upgrade:   Client ←WS→ AgentCore /ws              (bidirectional, mid-turn cancel)
```

#### 9.1.1 Two-runtime split (D1 resolved, 2026-04-17)

**Decision:** Deploy **two AgentCore Runtimes** from the same container image, differing only in their `authorizerConfiguration`.

| Runtime | Authorizer | Used by | Replaces |
|---|---|---|---|
| `Runtime-IAM` | Default (SigV4 / IAM) | `OrchestratorFn` Lambda (control plane invocations) | Identical to Phase 1a runtime — no behavior change |
| `Runtime-JWT` (new) | `customJWTAuthorizer` → Cognito User Pool JWKS URL + allowed audiences | CLI direct SSE watchers, web SPAs | N/A — new path |

Both runtimes consume the same `AgentRuntimeArtifact` (Docker image). `ProgressWriter` and `SSEAdapter` both run inside the container regardless of which runtime is invoked, and both write to the same `TaskEventsTable`. This means cross-path *observation* works (a task submitted via `Runtime-IAM` is fully visible to a CLI watcher on `Runtime-JWT`'s SSE stream, because events flow through DDB and through the per-session `asyncio.Queue` inside the same container). Cross-path *control* does not: a session is scoped to one runtime ARN and cannot be re-invoked on the other.

**Why not a single runtime?** `authorizerConfiguration` is mutually exclusive on the AgentCore Runtime construct — a runtime either uses IAM or one `customJWTAuthorizer`, never both. This is documented in the AgentCore API reference and enforced in the CDK L2 source.

**Why not an API-Gateway JWT→IAM bridge (Option B)?** That approach puts API Gateway REST in the SSE path, which is incompatible with streaming past 30 seconds (hard integration timeout). It would defeat the "direct CLI→AgentCore" latency goal that motivates Phase 1b in the first place, and it adds a new failure point for no benefit.

**Lifecycle configuration for both runtimes (CDK, explicit):**

```typescript
lifecycleConfiguration: {
  idleRuntimeSessionTimeout: Duration.hours(8),  // 28,800 s — default is 900 s; max is 28,800 s
  maxLifetime: Duration.hours(8),                // 28,800 s — default and max both 28,800 s
}
```

See §9.12 for the full constraint table on AgentCore streaming limits.

### 9.2 Auth: Cognito JWT directly to AgentCore (no Identity Pool)

**Decision (rev 4, D1-resolved):** The CLI's Cognito JWT is validated **directly on `Runtime-JWT`** via its `customJWTAuthorizer` (pointing at the Cognito User Pool JWKS URL + allowed audiences). There is no AgentCore Identity indirection and no Identity Pool.

**How it works:**
1. CDK deploys `Runtime-JWT` with `authorizerConfiguration: customJWTAuthorizer` — `discoveryUrl` set to the Cognito User Pool's OIDC discovery endpoint, `allowedAudience` set to the app client ID.
2. CLI exchanges email/password for Cognito JWT (existing flow, no change).
3. CLI passes JWT as `Authorization: Bearer <token>` when opening the SSE stream on `Runtime-JWT`'s data-plane endpoint.
4. AgentCore validates the JWT against the configured Cognito issuer/audience before the request reaches the container.

**What stays the same:** REST API auth (Cognito JWT → API Gateway) is unchanged — the control plane continues to use the existing authorizer. `OrchestratorFn` Lambda continues to use IAM (SigV4) to invoke `Runtime-IAM` for task execution. The orchestrator path is entirely unchanged from Phase 1a.

### 9.3 HITL approval gates: 3-tier configurable model

> **⚠️ Pending design update (still pending in rev 4, tracked 2026-04-17):** This section describes the Phase 3 HITL design as of rev 3. A team discussion (Sam ↔ Alain, 2026-04-17) agreed to replace the hardcoded 3-tier model below with **Cedar policy-driven HITL**, reusing the existing in-process Cedar engine (`agent/src/policy.py`, rebased onto `upstream/main` at `396a245` 2026-04-17). The existing Cedar decision model (`ALLOW`/`DENY` for tool governance) will be extended with a `REQUIRE_APPROVAL` outcome — same policy language, broader semantics. This enables workflows like AI-DLC where users gate per phase and relax over time.
>
> **Do not implement Phase 3 from the text below.** The design is being revised.
>
> **Scope note (rev 4):** HITL approval gates remain Phase 2/3 scope. Real-time **nudges** (mid-turn steering that interrupts the current tool call) are explicitly **not** in Phase 1b — they require bidirectional transport and trigger the Phase 1c WebSocket upgrade (`/ws`). Phase 1a and Phase 1b cover progress streaming (server→client) and between-turn nudges via REST `POST /tasks/{id}/nudge`; anything that must interrupt an in-flight tool call waits for Phase 1c.

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

### 9.10 SSE architecture inside `server.py` (D2 resolved, 2026-04-17): background thread + `asyncio.Queue`

**Decision:** Keep the synchronous `run_task` on a background thread; add an `agent/src/sse_adapter.py` as a **sibling of `agent/src/progress_writer.py`**; bridge the two worlds through a per-session `asyncio.Queue` that the SSE handler drains.

**Producer-consumer topology:**

```
pipeline.py / runner.py  (emit events at existing call sites)
       │
       ├────────────▶ ProgressWriter.write_event()  ──▶ DynamoDB TaskEventsTable
       │                                                (durable, auditable,
       │                                                 catch-up source)
       │
       └────────────▶ SSEAdapter.emit()             ──▶ asyncio.Queue (per session)
                                                         │
                                                         ▼
                                              server.py SSE handler
                                                         │
                                                         ▼
                                 `data: <AG-UI JSON>\n\n` frames to client
                                 + `: ping\n\n` keepalive every ~15 s
```

**Why this over a full-async refactor (Option A):**

The synchronous `run_task` is not a Phase 1a oversight — it is required by the orchestrator path. `OrchestratorFn` Lambda issues a synchronous `InvokeAgentRuntimeCommand` and is bounded by the 15-minute Lambda execution cap. The SSE path must also support streams held open up to 60 minutes (§9.12). A single `async` handler cannot satisfy both without breaking one or the other. The background-thread + queue design lets each path keep its own timing envelope: the orchestrator gets its synchronous return, the SSE client gets a long-held stream draining the queue, and the agent produces events exactly once for both.

**Sibling placement preserves the 305-test Phase 1a baseline.** `ProgressWriter` is not refactored; it is not moved; its DDB writes are not funnelled through the new queue. `SSEAdapter` is added as a new module that is imported and called at the same existing call sites in `pipeline.py` and `runner.py`. If `SSEAdapter` fails (no clients connected, queue full, handler panicked), the DDB path is unaffected.

**The queue boundary makes the producer agnostic.** Today the producer is a synchronous thread calling `queue.put_nowait()` via `asyncio.run_coroutine_threadsafe`. Tomorrow the producer can be a native coroutine. The SSE handler does not know or care.

**Phase 3 ADR trigger to revisit a full-async refactor.** A future ADR to re-open D2 (full-async `server.py`) is triggered by **any** of:
- Bidirectional nudges ship and require WebSocket (`/ws`) alongside SSE (i.e., Phase 1c goes from "optional" to "required").
- Nightly tasks routinely hit the AgentCore 60-minute streaming cap and the overhead of app-level catch-up becomes load-bearing rather than an edge case.
- Cedar policy engine (§9.3) needs mid-task policy updates that must be pushed into the running container in real time.

Until one of those triggers fires, Option B stands.

**SSE handler endpoint choice (resolved 2026-04-17).** The handler lives at the existing `/invocations` endpoint via content-type negotiation: `Accept: text/event-stream` (anywhere in the header, case-insensitive) routes the request to the SSE flow; any other value (including `application/json`, `*/*`, or a missing header) preserves the existing sync behavior byte-for-byte. One endpoint, one contract, matches AgentCore's documented AG-UI pattern. The orchestrator's existing `InvokeAgentRuntime` calls are unaffected because they do not send `text/event-stream` in `Accept`.

### 9.11 CLI SSE client (D3 resolved, 2026-04-17): hybrid

**Decision:** Import `@ag-ui/core` for its 17 AG-UI event **types and Zod schemas only**. Own the transport with native `fetch` + `eventsource-parser` (32.7 M weekly npm downloads). A CLI-side `cli/src/sse-client.ts` wrapper handles reconnection, exponential backoff, JWT refresh, and the mandatory 60-minute stream restart. **Do not use `@ag-ui/client` `HttpAgent`**.

**What we are betting on vs. against:**

| Bet | Stability signal | Why we can rely on it |
|---|---|---|
| **AG-UI wire format** (the event shapes) | Multi-framework standard — 14+ server-side emitters (LangGraph, CrewAI, AG2, Pydantic AI, Microsoft Agent Framework, AWS AgentCore as of March 2026), multi-vendor recognition | If this changes incompatibly, the entire ecosystem breaks; strong coordination cost against that. |
| **`@ag-ui/core` types/schemas** (not runtime) | Same as above — types track the wire format | Low code surface; Zod schemas give us runtime validation; refactors are mechanical. |

| Bet we **decline** | Instability signal | Why we avoid it |
|---|---|---|
| **`@ag-ui/client` `HttpAgent`** (the runtime library) | 0.0.x pre-1.0; single-shot request model; **no built-in reconnection, backoff, or token refresh** | A 60-minute stream with a blip terminates as `RUN_ERROR`. We would have to wrap it anyway — and wrapping a pre-1.0 API is worse than writing to a standard primitive (`fetch` + `eventsource-parser`). |
| **Hand-maintaining the type catalog** (pure Option B — no `@ag-ui/core` at all) | Event catalog went from 4 → 16 types in 2025; it will keep growing | Type parity drift becomes a perpetual maintenance tax. |

**Concrete module split:**

```
cli/src/sse-client.ts       # Wrapper: fetch + eventsource-parser + reconnect/backoff
                            # + JWT refresh + 60-min restart, emits typed events
cli/src/commands/watch.ts   # Consumes sse-client.ts; falls back to REST polling
                            # (`GET /tasks/{id}/events?after=<event_id>`)
                            # when SSE is unavailable or on extended failure
```

**Dependencies added to `cli/package.json`:**

- `@ag-ui/core` — types + Zod schemas
- `eventsource-parser` — SSE frame parser

**Explicit call-out:** do **not** add `@ag-ui/client`.

### 9.12 AgentCore streaming limits — design constraints (new in rev 4)

Primary-source AWS research on 2026-04-17 produced a clearer picture of AgentCore Runtime's timing surface. These constraints shape the entire streaming plane design and are load-bearing for D1 / D2 / D3.

**Three independent duration ceilings on `InvokeAgentRuntime` — all hard, non-adjustable:**

| Invocation mode | Maximum duration | Relevance to Phase 1b |
|---|---|---|
| Synchronous `InvokeAgentRuntime` | **15 min** | Used by `OrchestratorFn` for control-plane task kickoff. |
| Streaming `InvokeAgentRuntime` | **60 min** | **The SSE-relevant cap.** CLI watchers must reconnect at least once per hour. |
| Async job | 8 h | Not used in Phase 1b. |

Sources: [Quotas for Amazon Bedrock AgentCore (devguide)](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html), [endpoints and quotas (general reference)](https://docs.aws.amazon.com/general/latest/gr/bedrock-agentcore.html).

**Two session-level timers — both adjustable via `LifecycleConfiguration` on the Runtime construct:**

| Timer | Default | Range | Reset behavior |
|---|---|---|---|
| `idleRuntimeSessionTimeout` | 900 s (15 min) | 60 s – 28,800 s (8 h) | **Resets per invocation** on the session. |
| `maxLifetime` | 28,800 s (8 h) | 60 s – 28,800 s | Starts when the microVM is created. **Does not reset.** |

Sources: [Runtime lifecycle settings](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html), [API_LifecycleConfiguration](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_LifecycleConfiguration.html).

Both values must be set explicitly in CDK on **both** `Runtime-IAM` and `Runtime-JWT` — defaults are too tight for long-running background agents.

**Behavior at the 60-minute streaming cap is partially documented.** AWS does not publish whether the connection closes with a clean AG-UI `RUN_ERROR` SSE frame or an abrupt TCP close. The CLI SSE client (§9.11) must handle both cases identically (reconnect + catch-up).

**No SSE-native resume on AgentCore.** There is no `Last-Event-ID` header support and no server-side checkpointing. Reconnection is always an app-level operation:

```
1. CLI opens a new `InvokeAgentRuntime` streaming call, reusing the same `runtimeSessionId`
2. CLI issues `GET /tasks/{id}/events?after=<last_event_id>` via the REST control plane
3. CLI merges the catch-up batch with the new live stream (deduplicate by event_id)
```

This is the only reconnection mechanism. The handler `cdk/src/handlers/get-task-events.ts` must therefore accept `?after=<event_id>` as a query parameter (in addition to its existing `next_token` support). See Appendix C Phase 1b file change map.

**API Gateway REST is incompatible with SSE past 30 seconds.** API Gateway REST has a hard integration timeout of 30 seconds — streaming cannot be proxied through it. The SSE path must go **direct to the AgentCore data-plane endpoint** on Runtime-JWT (this is why D1 does not use an API Gateway authorizer bridge). Lambda Function URL streaming is an alternative for non-AgentCore streaming workloads, but is not used here.

**Rule: never put API Gateway REST in the SSE path.**

**SDK client defaults will kill streams if not overridden.** Both the server-side and client-side AWS SDKs have default timeouts that are far below the 60-minute cap:

| SDK | Default timeout | Must override to |
|---|---|---|
| boto3 (Python, agent-side) | `read_timeout=60` seconds | Effectively unbounded for streaming requests (e.g., `read_timeout=None` or `>= 3700`). |
| AWS JS SDK v3 (`@aws-sdk/*`) | Request timeout ~2 minutes | `NodeHttp2Handler.requestTimeout: 0` (unlimited) for the streaming invocation. |

These overrides are mandatory in any code path that opens a streaming `InvokeAgentRuntime`.

### 9.13 Execution location: interactive direct-submit vs. orchestrator fan-out (added in rev 5, 2026-04-21)

First live SSE bring-up against the deployed stack revealed a design gap: the rev‑4 plan routed every SSE invocation through `_spawn_background(...)` in `agent/src/server.py`, which meant that after a plain `bgagent submit` fired the orchestrator pipeline on Runtime‑IAM, a subsequent `bgagent watch --transport sse` on Runtime‑JWT would spawn a **second pipeline** for the same task. Both microVMs would clone the repo, run the agent, and create PRs — the observed failure mode. The root cause is that AgentCore's ``same `runtimeSessionId` → same microVM`` routing ([AgentCore sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)) is scoped **per runtime ARN**; Runtime‑IAM and Runtime‑JWT are distinct microVM pools, so same-session-ID attach across them is not possible without an external pub/sub layer.

The competitive survey (`docs/research/agent-streaming-patterns.md`) identified three shapes: **same‑process streaming** (CopilotKit, Mastra, OpenAI Assistants), **orchestrator + observer with pub/sub** (LangGraph Platform `join_stream`, Vercel `resumable-stream`), and **pull-based** (Temporal queries, OpenAI fallback). AgentCore sits between the first two — same-session-ID routing provides the substrate for in-process attach within a single runtime, but no managed join-stream across runtimes.

**Decision: Branch A — same-process streaming for interactive flows, polling fallback for cross-runtime observation.**

#### 9.13.1 Two submission paths, three observation modes

| Submission | Runtime | Pipeline lives in | Watcher behaviour |
|---|---|---|---|
| `bgagent submit --watch` (or `bgagent run`) | Runtime‑JWT (direct) | The same microVM that serves the SSE stream | **Real-time SSE**, same-process. Reconnect routes to the same microVM via same-session-ID → attaches to the existing `_SSEAdapter`. |
| `bgagent submit` (plain) | Runtime‑IAM (via orchestrator) | A microVM on Runtime‑IAM (different pool than Runtime‑JWT) | No real-time cross-runtime attach possible. `bgagent watch` on this task falls back to **polling** against DDB (Phase 1a path, now with 500 ms interval instead of 2 s). |
| Non-interactive (webhook, Slack bot, cron) | Runtime‑IAM (via orchestrator) | A microVM on Runtime‑IAM | DDB Streams fan-out (§8.9) pushes events to the non-interactive consumer (`chat.postMessage`, PR comment, SES, etc.). |

#### 9.13.2 Lifetime semantics (honest trade-off)

A pipeline is a Python background thread **inside a microVM**. Its lifetime is bounded by AgentCore's ``maxLifetime`` (8 h in our CDK — `LifecycleConfiguration`) and ``idleRuntimeSessionTimeout`` (also 8 h). DynamoDB persistence records the event log; it does **not** continue pipeline execution on a fresh microVM.

- **Direct-submit (`submit --watch`)**: task lifetime == microVM lifetime. If the CLI disconnects and does not reconnect before the microVM is evicted (idle timeout or `maxLifetime`), the task dies with the microVM. For coding-agent workloads (minutes to low single-digit hours), the 8 h ceiling is comfortable.
- **Orchestrator-submit (`submit`)**: task lifetime is similarly bounded on Runtime‑IAM — **also 8 h**. DDB is just the audit log. For tasks that genuinely exceed 8 h, architect outside AgentCore Runtime (Fargate, Step Functions) — out of scope for Phase 1b.

`/ping` returning ``{"status": "HealthyBusy"}`` whenever a pipeline thread is alive is defence-in-depth against idle eviction with non-default `idleRuntimeSessionTimeout`. We set 8 h explicitly, but `HealthyBusy` makes the server correct under any configuration ([runtime service contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html), [long-running agents guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html)).

#### 9.13.3 `server.py` attach-don't-spawn logic

A per-process registry `{task_id: _SSEAdapter}` is maintained under `_threads_lock`. The `/invocations` handler:

1. If `Accept: text/event-stream` **and** an `_SSEAdapter` already exists for the requested `task_id` in this microVM → **attach**: return a `StreamingResponse` backed by a new `_sse_event_stream(...)` generator that drains the existing adapter's queue. Do **not** call `_spawn_background`.
2. Otherwise → **spawn**: create a new `_SSEAdapter`, insert it into the registry, call `_spawn_background(params, sse_adapter=adapter)`. On `run_task` completion (success or failure), the pipeline's `finally` block removes the adapter from the registry.

The registry is process-local; cross-microVM attach is out of scope (that's the polling fallback).

For the sync `Accept: application/json` path (orchestrator → Runtime‑IAM), behaviour is unchanged: always spawn via `_spawn_background`, return 202. The orchestrator never needs to attach.

#### 9.13.4 Admission control with two submission paths

Admission checks (guardrail screening, idempotency, repo-onboarded, concurrency limits) live in `cdk/src/handlers/shared/create-task-core.ts` today and run in the `CreateTask` Lambda. They must run for **both** submission paths. The control-plane REST endpoint stays the authoritative admission gate:

- `POST /v1/tasks` with new optional field `execution_mode` (default `"orchestrator"`, or `"interactive"`). Admission is unconditional.
- `execution_mode: "orchestrator"` (default, plain `submit`): Lambda writes TaskTable record, fires the orchestrator Lambda via async invoke, returns `202 {task_id}`.
- `execution_mode: "interactive"` (CLI `submit --watch` / `run`): Lambda writes TaskTable record + initial `task_created` event, **skips** the orchestrator invoke, returns `202 {task_id}`. The CLI then opens SSE directly to Runtime‑JWT's `/invocations` with the returned `task_id`, and server.py executes the pipeline.

Server.py on Runtime‑JWT fetches the TaskTable record by `task_id` to resolve `repo_url`, hydrated context, prompt version, etc. — it does **not** re-admit; the Lambda already did. Unauthenticated/unauthorised requests are blocked earlier by the Cognito JWT authoriser on Runtime‑JWT.

Both paths write to the same `TaskTable` and `TaskEventsTable`, preserving the single source of truth.

#### 9.13.5 Phase 1c: real-time cross-runtime attach (future)

Current polling fallback is acceptable for attach-to-already-running because the common case is "I just submitted; show me live" (direct-submit path handles this natively). The uncommon case ("Slack bot fired a task yesterday; I want to watch it now") uses polling.

Phase 1c adds a pub/sub layer so the uncommon case is real-time too. Two candidates, to be chosen then:

- **IoT Core MQTT** — `tasks/{task_id}/events` topics; SSE microVMs subscribe via MQTT-over-WSS. ~100 ms fan-out, native topic filtering, scales to very large fan-outs. Adds IoT dep.
- **ElastiCache Redis + port of `vercel/resumable-stream`** — proven pattern (Vercel / LangGraph Platform), pubsub channels + resumable buffer. Adds ElastiCache cluster.

In both cases the orchestrator-spawned pipeline gains a lightweight publisher alongside `ProgressWriter`; the SSE observer on Runtime‑JWT subscribes by `task_id`. Catch-up from DDB continues to be the reconnection backstop. No Branch A code change is required — the observer path on Runtime‑JWT gets a "subscribe to live topic" option in addition to "poll DDB".

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

**Goal:** Replace polling with real-time SSE from AgentCore. Measure latency improvement. Reflects resolved D1 (two runtimes), D2 (background-thread + `asyncio.Queue`), and D3 (hybrid CLI SSE client).

| Package | File | Change |
|---------|------|--------|
| `cdk/` | `src/stacks/agent.ts` | Add **`Runtime-JWT`** alongside existing `Runtime-IAM`. Both share the same `AgentRuntimeArtifact` (Docker image). `Runtime-JWT` uses `authorizerConfiguration: customJWTAuthorizer` pointing at the Cognito User Pool JWKS URL + allowed audiences. Set explicit `LifecycleConfiguration` (`idleRuntimeSessionTimeout: 28800`, `maxLifetime: 28800`) on both runtimes. |
| `cdk/` | `src/handlers/get-task-events.ts` | Accept **`?after=<event_id>`** query parameter for catch-up reconnection. Current code only supports `next_token`; AG-UI has no Last-Event-ID and AgentCore has no SSE-native resume (§9.12), so DDB catch-up is the only reconnection mechanism. |
| `cdk/` | `src/stacks/agent.ts` | Ensure DynamoDB Streams are enabled on `TaskEventsTable` (prerequisite for the Phase 1b+ fan-out plane, §8.9). Fan-out Lambda itself can be skeleton / deferred. |
| `agent/` | `src/sse_adapter.py` | NEW: Sibling of `progress_writer.py`. Pushes events to a per-session `asyncio.Queue` (D2). |
| `agent/` | `src/server.py` | Content-type-negotiated `/invocations`: `Accept: text/event-stream` routes to new SSE handler (drains the per-session `asyncio.Queue`, emits AG-UI `data: <json>\n\n` frames, injects `: ping\n\n` keepalive every 15 s); any other `Accept` preserves the existing sync path byte-for-byte. |
| `agent/` | `src/sse_wire.py` | NEW: Pure-function translator from semantic events (SSEAdapter dicts) to AG-UI wire-format frames (TEXT_MESSAGE_*, TOOL_CALL_*, STEP_*, CUSTOM for cost, RUN_ERROR / RUN_FINISHED). Kept separate from transport for testability. |
| `agent/` | `src/pipeline.py` | Add `SSEAdapter.emit()` call at the existing `ProgressWriter.write_event()` call sites (sibling pattern, §5). |
| `agent/` | `src/runner.py` | Same as `pipeline.py`: `SSEAdapter.emit()` alongside `ProgressWriter.write_event()` at existing call sites. |
| `agent/` | `tests/test_sse_adapter.py` | NEW: Unit tests for the adapter (queue semantics, backpressure, no-clients-attached case). |
| `cli/` | `package.json` | Add runtime deps: **`@ag-ui/core`** (types + Zod schemas only) and **`eventsource-parser`** (transport). Do NOT add `@ag-ui/client` (§9.11). |
| `cli/` | `src/sse-client.ts` | NEW: SSE wrapper — native `fetch` + `eventsource-parser`, exponential backoff reconnect, JWT refresh, mandatory 60-min stream restart (§9.12). |
| `cli/` | `src/commands/watch.ts` | SSE primary path via `sse-client.ts`; REST polling (`GET /tasks/{id}/events?after=<event_id>`) as fallback and as the catch-up path after every reconnect. |
| `cli/` | `src/types.ts` | Add `?after=<event_id>` to the events query request type (keep in sync with CDK handler types). |
| `cli/` | `src/api-client.ts` | Add catch-up method `getEventsAfter(taskId, afterEventId)`. |

**Auth:** CLI Cognito JWT validated directly by `Runtime-JWT`'s `customJWTAuthorizer` (§9.2, D1). No AgentCore Identity indirection. Orchestrator path continues to use IAM / SigV4 into `Runtime-IAM` — unchanged from Phase 1a.

**Latency target:** ~100 ms streaming event arrival (compare with Phase 1a's 2–5 s poll interval).

**SDK client timeouts (mandatory overrides, §9.12):** boto3 `read_timeout` default 60 s must be raised for streaming invocations (agent side); AWS JS SDK v3 default request timeout (~2 min) must be disabled (`NodeHttp2Handler.requestTimeout: 0`) on the CLI side for the streaming call.

**Risk:** Medium. Dominated by the `asyncio.Queue` bridge (correctness of the threadsafe producer) and the 60-min restart path. Phase 1a's 305 tests must continue to pass — `ProgressWriter` is not modified.

**60-minute streaming cap (§9.12):** Hard AWS cap on streaming `InvokeAgentRuntime`. CLI must reconnect at least once per hour and fetch missed events from `GET /tasks/{id}/events?after=<event_id>` on every reconnect. Behavior at the cap (clean `RUN_ERROR` vs abrupt TCP close) is not fully documented — the client handles both.

**Validation criteria before proceeding:**
- SSE events arrive with <500 ms latency end-to-end.
- CLI Cognito JWT is validated by `Runtime-JWT`'s `customJWTAuthorizer` without touching AgentCore Identity.
- `ProgressWriter` → DDB path is unchanged and all Phase 1a regression tests pass.
- Graceful degradation when SSE disconnects: CLI transparently falls back to REST polling.
- Reconnection after the 60-minute streaming cap works seamlessly (no missed events, exactly-once semantics via event_id deduplication).
- DynamoDB Streams on `TaskEventsTable` are enabled (prerequisite for fan-out plane).

---

### Phase 1c: WebSocket upgrade (optional, separate task)

**Only if SSE proves insufficient.** Adds `/ws` handler to `server.py`. Same AG-UI events, bidirectional transport. **Not part of the initial interactive agents scope.**

---

### Phase 2: Nudge (user → agent steering)

**Goal:** Users can send course corrections to a running agent between turns.

**Transport:** REST `POST /v1/tasks/{task_id}/nudge` through our API Gateway (existing Cognito auth). Works identically on both runtime paths (Runtime-IAM / orchestrator, Runtime-JWT / interactive-SSE). **No dependency on WebSocket.** See `docs/interactive-agents-phases-v4.drawio` page 8 for the architecture.

**Data path:**
- Client authenticates with Cognito, POSTs `{ "message": "<free text>" }`.
- Nudge Lambda: extract `user_id` from JWT → verify task ownership → reject if task status is terminal → **rate-limit** (see below) → **guardrail-screen** the message via the same Bedrock Guardrail path used for `task_description` (`screenWithGuardrail` in `cdk/src/handlers/shared/context-hydration.ts`) → write `NudgeRecord` to `TaskNudgesTable` → return `202 { task_id, nudge_id, submitted_at }`.
- Agent runtime polls `TaskNudgesTable` at the **between-turns seam**, injects each pending nudge as a `<user_nudge>` XML block into the next `client.query()`, and atomically marks it `consumed=true` via a conditional DDB UpdateItem (`consumed = :false` precondition) for idempotency across restarts.

**Nudge injection format** (what the model sees):

```
<user_nudge timestamp="2026-04-22T10:55:00Z" nudge_id="01KPT...">
{free-text message}
</user_nudge>
```

The base system prompt includes a one-line note instructing the model to treat `<user_nudge>` blocks as authoritative mid-task steering from the human operator.

**DynamoDB table — `TaskNudgesTable`:**
- PK: `task_id` (STRING) — groups all nudges for a task.
- SK: `nudge_id` (STRING, ULID — lexicographic == chronological).
- Attributes: `message`, `created_at`, `consumed` (BOOL), `consumed_at`, `user_id`, `ttl`.
- `PAY_PER_REQUEST`, PITR enabled, AWS-owned encryption, no stream (nudges are poll-consumed, not fanned out).
- **TTL: 30 days.** Gives enough retention to review nudge patterns during dogfooding; can be shortened later via CDK change without data migration.

**Rate limit:** Per-task, per-minute cap. Default **10 nudges/task/minute**. Configurable via the **`NUDGE_RATE_LIMIT_PER_MINUTE`** env var on the nudge Lambda — can be tuned per environment without a code change. Enforced by a conditional DDB counter row (`task_id = RATE#<task_id>`, `nudge_id = MINUTE#<yyyymmddhhmm>`, 120s TTL). Exceeded → `429` with `ErrorCode.RATE_LIMITED`.

**Between-turns hook composition:** The runner exposes `between_turns_hooks: list[Callable[[TurnContext], list[str]]]` so Phase 3 approval-gate polling and other future extensions can register alongside the nudge reader without re-modifying the turn loop. Nudge reader is registered as the first hook.

**Files (as implemented):**

| Package | File | Change |
|---------|------|--------|
| `cdk/` | `src/handlers/shared/types.ts` | Add `NudgeRequest`, `NudgeResponse`, `NudgeRecord` |
| `cdk/` | `src/constructs/task-nudges-table.ts` | NEW: DDB table (mirrors `task-events-table.ts`) |
| `cdk/` | `src/handlers/nudge-task.ts` | NEW: POST handler (ownership, rate-limit, guardrail, PutItem) |
| `cdk/` | `src/constructs/task-api.ts` | Wire `/v1/tasks/{task_id}/nudge` POST + Lambda + grants |
| `cdk/` | `src/stacks/agent.ts` | Instantiate nudges table, grant both runtimes, set `NUDGES_TABLE_NAME` env |
| `agent/` | `src/nudge_reader.py` | NEW: `read_pending`, `mark_consumed`, `format_as_user_message` |
| `agent/` | `src/runner.py` | Add `between_turns_hooks` machinery + nudge hook registration |
| `agent/` | `src/prompts/base.py` | One-line system-prompt note on `<user_nudge>` semantics |
| `agent/` | `tests/test_nudge_reader.py` | NEW: Tests (query, empty, ordering, idempotency, error resilience) |
| `cli/` | `src/types.ts` | Mirror `NudgeRequest`, `NudgeResponse` |
| `cli/` | `src/api-client.ts` | Add `nudgeTask(taskId, message)` |
| `cli/` | `src/commands/nudge.ts` | NEW: `bgagent nudge <task_id> "<message>"` |
| `cli/` | `src/bin/bgagent.ts` | Register nudge command |
| `cli/` | `test/commands/nudge.test.ts` | NEW: Tests (happy, 401/400/403/404/429, empty message, `--json`) |

**Testing:**
- **Unit:** nudge validation, ownership check, rate-limit conditional, guardrail screening, DDB put, `mark_consumed` idempotency, nudge-reader resilience to DDB outage, XML formatter handles special chars.
- **Integration:** submit task → send nudge via REST → verify agent acts on it in its next turn.
- **Security:** non-owner cannot nudge (403), guardrail blocks injection attempts (400), rate limit enforced (429), terminal-status tasks rejected (409).

**Risk:** Medium-High. Core agent loop modification is the riskiest change; nudge-reader errors must never break the turn loop (fail-open at the reader, reports zero pending nudges on DDB errors).

**Observability:** Every consumed nudge is written as an event to `TaskEventsTable` with `event_type=nudge_consumed` (metadata: `nudge_id`, `created_at`, truncated message prefix). The fan-out Lambda forwards `nudge_consumed` to configured dispatchers.

---

### Phase 2.5: Mid-turn interrupt (deferred — scoped, not implemented)

**Goal:** Stop a running turn *mid-stream* — not just between turns. Complements nudges (which wait for the current turn to finish) for cases where the agent is visibly going off the rails and the user wants to halt NOW.

**Status:** **Deferred.** Viable with today's Claude Agent SDK; scoped during Phase 2 research (see `project_phase25_midturn_interrupt_research.md` in the Claude memory store).

**Key finding:** `ClaudeSDKClient.interrupt()` is supported today on the Python SDK. Signature: `async def interrupt(self) -> None`. Ends the current turn with `ResultMessage(subtype="error_during_execution")`, preserves session state (subsequent `client.query(...)` continues the conversation), no server-side cancel API needed at the Anthropic Messages layer.

**Preconditions (must hold at runtime):**
- Streaming mode (which we already use).
- Connected `ClaudeSDKClient` (already true).
- **A concurrent asyncio task actively consuming `client.receive_response()`** — otherwise the interrupt signal is not processed. Our runner already has this consumer loop; an interrupt trigger runs as a sibling task.

**Proposed integration:**
- Add a `stop_requested` flag on the `TaskRecord` (or a dedicated side table), toggleable via new `POST /v1/tasks/{task_id}/stop`.
- Agent runtime runs a sibling asyncio polling task (2–5s cadence) on that flag alongside the existing `receive_response()` consumer.
- On stop signal: `await client.interrupt()` → drain remaining messages from the stream (mandatory; otherwise the next `query()` reads the interrupted turn's tail) → write a `turn_interrupted` event to `TaskEventsTable` → terminal-stop closes the client, redirect-style stop issues a new `query()` with replacement instructions.

**Critical risks (call out in implementation):**
- **Side effects are NOT rolled back.** A partially-executed `Bash` or `Edit` tool may already have written files or run `git push`. `agent/src/policy.py` / `hooks.py` sandboxing is the only safety layer — `interrupt()` is not a transaction abort.
- Tool subprocess may keep running after interrupt until MicroVM kill (e.g. a 10-minute test run). Consider a watchdog SIGTERM on interrupt.
- Drain-before-next-query is load-bearing; skipping leaves stale tail messages that look like a bug.
- Partial tool_use blocks may appear in the stream — consumer must tolerate them.
- Billing for cancelled streams is undocumented; assume already-streamed tokens are billed.
- `asyncio.Task.cancel()` is NOT an alternative — it kills your reader while the CLI subprocess keeps generating tokens. `interrupt()` first, cancel never.

**Upstream state (as of 2026-04-22):**
- Python SDK: `interrupt()` supported (anthropics/claude-agent-sdk-python).
- TS SDK V2: regressed, `interrupt()` not yet re-added — tracked at anthropics/claude-agent-sdk-typescript#120.
- Feature request for richer interrupt semantics (lifecycle hooks, partial-result preservation): anthropics/claude-code#12439, **closed as not planned**. Don't design around hypothetical richer APIs.

**Not in scope for this design doc:** implementation details. When scheduled, Phase 2.5 gets its own subsection with task breakdown + test plan. The `between_turns_hooks` abstraction introduced in Phase 2 is intentionally compatible with adding a sibling `stop_poller` concurrent task.

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
agent/src/sse_adapter.py                         # Sibling of progress_writer.py; pushes events
                                                 # to per-session asyncio.Queue (D2)
agent/tests/test_sse_adapter.py                  # Tests (queue semantics, backpressure, no-clients case)
cli/src/sse-client.ts                            # fetch + eventsource-parser wrapper:
                                                 # reconnect + backoff + JWT refresh + 60-min restart (D3)
# CDK construct: second AgentCore Runtime.
# May be inline in cdk/src/stacks/agent.ts (new Runtime-JWT alongside Runtime-IAM),
# or extracted into a construct if complexity warrants.
```

### Phase 1b — Modified files

```
cdk/src/stacks/agent.ts                          # Add Runtime-JWT alongside Runtime-IAM
                                                 # (customJWTAuthorizer → Cognito User Pool JWKS + audiences).
                                                 # Both runtimes share the same AgentRuntimeArtifact (Docker image).
                                                 # Set explicit LifecycleConfiguration on both runtimes
                                                 # (idleRuntimeSessionTimeout: 28800, maxLifetime: 28800).
                                                 # Enable DynamoDB Streams on TaskEventsTable
                                                 # (prerequisite for fan-out plane, §8.9).
cdk/src/handlers/get-task-events.ts              # Accept ?after=<event_id> query param
                                                 # (only reconnection mechanism — §9.12).
cli/src/types.ts                                 # Add ?after=<event_id> to events query request type
                                                 # (keep in sync with CDK handler).
cli/src/api-client.ts                            # Add getEventsAfter(taskId, afterEventId) catch-up method.
cli/src/commands/watch.ts                        # SSE primary via sse-client.ts;
                                                 # REST polling fallback + catch-up path after reconnect.
cli/package.json                                 # Add @ag-ui/core (types+Zod only) and eventsource-parser.
                                                 # Do NOT add @ag-ui/client (§9.11).
agent/src/server.py                              # SSE handler draining the per-session asyncio.Queue;
                                                 # emits AG-UI `data: <json>\n\n` frames + `: ping\n\n` every ~15 s.
agent/src/pipeline.py                            # SSEAdapter.emit() alongside ProgressWriter.write_event()
                                                 # at existing call sites (sibling pattern, §5).
agent/src/runner.py                              # Same as pipeline.py — SSEAdapter.emit() alongside
                                                 # ProgressWriter.write_event().
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
