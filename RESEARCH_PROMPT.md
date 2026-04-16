# Research Prompt: Interactive Background Agents

> **Use this prompt when starting a new Claude Code session in this worktree.**
> Copy everything below the line into your first message.

---

## Context

You are working in the ABCA repository (Autonomous Background Coding Agents on AWS) on branch `feature/interactive-background-agents`. This feature aims to add **bidirectional interactivity** between users and background coding agents. Today, agents run in a fire-and-forget model with no real-time communication. We need to change that.

Read `AGENTS.md`, `docs/guides/ROADMAP.md`, and the design docs in `docs/design/` (especially `ARCHITECTURE.md`, `ORCHESTRATOR.md`, `API_CONTRACT.md`, `COMPUTE.md`) to understand the current system before proceeding.

## What this feature is about

Two core capabilities:

### 1. Progress streaming (agent -> user)

Background agents currently report results only when they finish (terminal DynamoDB write, polled by orchestrator every 30s). Users have no visibility into what the agent is doing while it runs. We need **real-time progress updates** streamed back to the user, including:

- **Task lifecycle transitions**: SUBMITTED -> HYDRATING -> RUNNING -> FINALIZING -> terminal state
- **Agent reasoning trajectory**: thinking steps, tool calls (file reads, edits, bash commands), tool results, cost/token accumulation
- **Structured milestones**: "cloning repo", "running tests", "creating PR", turn count, files modified
- **Error/warning signals**: test failures, lint errors, build failures as they happen (not just at the end)

### 2. User interruption and steering (user -> agent)

Users currently can only cancel a task (DELETE /v1/tasks/{id}). We need richer interaction:

- **Nudge/steer**: inject a one-shot course correction into the running agent ("focus on the auth module, not the UI", "use library X instead of Y", "skip the refactoring and just fix the bug")
- **Pause/resume**: temporarily halt agent execution (e.g., while user reviews intermediate state)
- **Priority redirect**: change the agent's focus mid-task based on progress observed via streaming
- **Approval gates**: agent requests human approval before high-risk operations ("I'm about to delete 50 files - approve?")

## Current architecture (what exists today)

Before researching solutions, you MUST thoroughly understand the current state. Read and analyze these files:

### Communication flow (current - one-directional, async)

1. **User -> System**: REST API (`POST /v1/tasks`) via API Gateway + Cognito auth
2. **System -> Agent**: Orchestrator Lambda invokes AgentCore Runtime via `InvokeAgentRuntimeCommand` (`cdk/src/handlers/shared/orchestrator.ts`)
3. **Agent -> System**: Agent writes status directly to DynamoDB (`agent/task_state.py` - `write_running()`, `write_terminal()`)
4. **System -> User**: User polls `GET /v1/tasks/{id}` or `GET /v1/tasks/{id}/events` (no push)

### Key files to read

| File | What to look for |
|------|-----------------|
| `cdk/src/handlers/shared/orchestrator.ts` | Core lifecycle engine: how sessions are started, polled (30s DynamoDB poll loop), finalized. The `startSession()` and `awaitAgentCompletion()` functions are the critical integration points |
| `cdk/src/handlers/orchestrate-task.ts` | Lambda Durable Function entry point. 6-step pipeline. Note: 9-hour execution timeout, 14-day retention |
| `agent/entrypoint.py` | Agent runtime: how Claude Code SDK is invoked (`ClaudeAgentOptions`), trajectory writer (`_TrajectoryWriter`), post-hooks |
| `agent/server.py` | FastAPI server for AgentCore `/invocations` endpoint. Fire-and-forget thread model |
| `agent/task_state.py` | How agent writes RUNNING/terminal status to DynamoDB. Note the `ConditionExpression` guards |
| `cdk/src/constructs/task-api.ts` | REST API Gateway construct. No WebSocket endpoint exists |
| `cdk/src/stacks/agent.ts` | Main CDK stack: AgentCore Runtime config, VPC, models, environment variables |
| `cdk/src/constructs/task-status.ts` | Task state machine definition (8 states). No `AWAITING_APPROVAL` or `PAUSED` state |
| `docs/design/ORCHESTRATOR.md` | Full orchestrator design (91KB). State machine, failure modes, polling model |
| `docs/design/API_CONTRACT.md` | REST API endpoints. Note the open question OQ1 about WebSocket |
| `docs/guides/ROADMAP.md` | Iteration 4 plans WebSocket + nudge. Iteration 6 plans iterative feedback + HITL approval |

### Critical gaps identified

1. **No bidirectional communication channel** - REST API only, no WebSocket or SSE
2. **No real-time progress streaming** - Trajectory data goes to CloudWatch Logs (`_TrajectoryWriter`), not to clients
3. **No mid-execution intervention** - Claude Code SDK runs one-shot with no way to inject mid-session messages
4. **Polling-only status** - Clients poll DynamoDB via API, 30s granularity at best
5. **No connection management** - No DynamoDB table for WebSocket connections
6. **No `AWAITING_APPROVAL` or `PAUSED` state** in the task state machine
7. **Agent harness has no message injection** - `server.py` spawns a thread and waits; no channel for incoming messages
8. **Orchestrator is poll-based** - `awaitAgentCompletion()` polls DynamoDB every 30s, no event-driven notification

## Research required

### Phase 1: Amazon Agent Core Runtime API research (2026)

This is the HIGHEST PRIORITY research area. The agents run on AgentCore Runtime (Firecracker MicroVMs). We need to understand what primitives AgentCore provides for interactivity.

Research questions:
- **Does AgentCore Runtime (2026) support any form of session communication channel?** (e.g., WebSocket to the running session, message passing, signal injection)
- **Does AgentCore have a streaming API for session output?** (i.e., can we stream agent stdout/stderr or structured events from the MicroVM back to the caller in real-time, instead of polling DynamoDB?)
- **Does AgentCore support session pause/resume or checkpoint APIs?** (beyond the existing persistent session storage for `/mnt/workspace`)
- **What SDK operations exist in `@aws-sdk/client-bedrock-agentcore` beyond `InvokeAgentRuntimeCommand`?** Look for: `SendMessageToSessionCommand`, `GetSessionEventsCommand`, `PauseSessionCommand`, `StreamSessionCommand`, or similar
- **Does AgentCore's `/invocations` endpoint support streaming responses?** Currently `server.py` returns a JSON response after the thread completes. Can it be changed to a streaming response?
- **Are there any AgentCore event integrations?** (EventBridge events for session state changes, CloudWatch real-time log streaming hooks, etc.)
- **What are the CDK L2 construct capabilities in `@aws-cdk/aws-bedrock-agentcore-alpha` for configuring session communication?**

Sources to check:
- AWS documentation for Amazon Bedrock AgentCore (2026)
- `@aws-sdk/client-bedrock-agentcore` SDK reference
- `@aws-cdk/aws-bedrock-agentcore-alpha` construct library docs
- AWS blog posts and re:Invent 2025/2026 sessions about AgentCore
- Any AWS samples or reference architectures using AgentCore with streaming

### Phase 2: Claude Code SDK / Agent SDK research

The agent uses the Claude Code SDK (headless mode via `@anthropic-ai/claude-code`). Research:

- **Does the Claude Code SDK or Claude Agent SDK support mid-session message injection?** (i.e., can you send a new user message to a running agent session without starting a new session?)
- **Does the SDK support streaming callbacks for per-turn events?** (thinking, tool calls, tool results). The current `_TrajectoryWriter` gets the full result object after completion. Can we get events *during* execution?
- **Is there a "conversation continuation" or "session append" API?** Where you can add messages to an ongoing autonomous session
- **What callback/hook mechanisms exist?** e.g., `onTurnStart`, `onToolCall`, `onThinking` that could be used to emit real-time events
- **Can the SDK be configured with an approval callback?** (for HITL gates - "agent wants to do X, call this function to get approval before proceeding")

Sources to check:
- Claude Code SDK documentation (latest 2026)
- Claude Agent SDK documentation
- Anthropic API reference for streaming and tool use
- Any examples of interactive/steerable agent implementations using Claude SDKs

### Phase 3: WebSocket and streaming architecture patterns

Research the infrastructure layer for delivering real-time events to clients:

- **API Gateway WebSocket API vs AppSync Subscriptions vs direct WebSocket**: trade-offs for this use case (the roadmap already chose WebSocket over SSE for multiplayer support)
- **Connection management patterns**: DynamoDB connection table, heartbeat/keepalive, reconnection
- **Fan-out patterns**: How to fan out events from a single agent session to multiple connected clients (CLI, web dashboard, Slack bot)
- **Backpressure and buffering**: What happens when the client is slower than the event rate? Event queue design
- **Authentication for WebSocket**: Cognito JWT validation on $connect, authorization for which tasks a user can subscribe to
- **Cost implications**: WebSocket connection hours, message costs, Lambda invocation costs for $connect/$disconnect/$default routes

### Phase 4: Bidirectional communication architecture

Research how the *full loop* works - not just streaming out, but also sending messages in:

- **Message injection into AgentCore sessions**: If AgentCore doesn't natively support this, what are the workaround patterns? (e.g., DynamoDB "nudge table" that the agent polls between turns, SQS queue consumed by the agent, shared filesystem signal file)
- **Agent-side polling for nudges**: How to modify the agent harness (`entrypoint.py`, `server.py`) to check for incoming messages between Claude Code turns
- **Nudge delivery guarantees**: At-most-once vs at-least-once vs exactly-once delivery of user messages to the agent
- **State machine extensions**: What new states are needed? (`PAUSED`, `AWAITING_APPROVAL`, `STEERING`). Transition rules, race conditions with existing states
- **Cancellation vs steering**: Current cancellation works by transitioning task status in DynamoDB. Can steering use the same mechanism with a different payload?
- **Session resumability**: If we pause an agent, can we resume it? Or do we need to start a new session with the accumulated context?

### Phase 5: Security and trust model

This is critical. We're introducing new attack surfaces:

- **WebSocket injection**: Can a malicious client inject messages that alter agent behavior? How do we validate and sanitize nudge content?
- **Authorization model for nudges**: Who can send messages to a running agent? Only the task creator? Team members? What about the approval gate - who can approve?
- **Nudge content screening**: Should nudges go through Bedrock Guardrails (like task descriptions already do in Iteration 3c)?
- **Rate limiting on nudges**: Prevent abuse (flooding the agent with contradictory instructions)
- **Audit trail**: All nudges must be logged and attributed (who sent what, when, to which task)
- **Replay protection**: Prevent replay attacks on WebSocket messages
- **Connection security**: WSS only, token rotation, connection timeout policies
- **Impact on memory system**: Do nudges affect what gets written to AgentCore Memory? Should they?

### Phase 6: Local development and testing

The system must be testable locally before deploying to AWS:

- **Local WebSocket server**: Can we run a local WebSocket server that mimics the API Gateway WebSocket behavior?
- **Local agent interactivity**: For local testing (without AgentCore), how do we simulate the bidirectional channel?
- **Integration test patterns**: How to test WebSocket connections, message delivery, and agent response to nudges
- **Mock AgentCore session communication**: If AgentCore has streaming/messaging APIs, how to mock them locally

## Deliverables

After completing the research, produce:

### 1. Research report (`docs/design/INTERACTIVE_AGENTS.md`)

A comprehensive design document covering:
- Findings from each research phase
- Capabilities and limitations of AgentCore Runtime APIs for interactivity
- Capabilities and limitations of Claude Code SDK for mid-session interaction
- Recommended architecture (with diagrams if helpful)
- Trade-offs considered and decisions made
- Open questions that need AWS team input

### 2. Implementation plan

A phased implementation plan that:
- Defines clear milestones with dependencies
- Identifies which changes go in `cdk/`, `agent/`, `cli/`, and `docs/`
- Specifies new DynamoDB tables or GSIs needed
- Specifies new API endpoints (WebSocket routes)
- Specifies state machine changes
- Specifies agent harness changes
- Includes security controls for each phase
- Includes testing strategy for each phase
- Estimates complexity/risk per phase
- Maps to the existing roadmap (Iteration 4 items + Iteration 6 items we're pulling forward)

### 3. Proof-of-concept scope

Identify the **smallest useful slice** that demonstrates the feature end-to-end:
- What's the MVP that proves the architecture works?
- What can we defer to later phases?
- What are the riskiest assumptions that the PoC should validate first?

## Important constraints

- **AgentCore Runtime is the production compute environment**. Any solution must work within its constraints (Firecracker MicroVM, 8hr max session, 15min idle timeout, no direct network access from client to MicroVM)
- **Lambda Durable Functions is the orchestrator**. The solution should integrate with the existing durable execution model, not replace it
- **The REST API must remain functional**. WebSocket is additive, not a replacement for the polling-based API
- **Security model must be at least as strong as current**. No regressions on auth, isolation, or audit
- **Backward compatibility**. Existing CLI commands and API clients must continue to work without changes (new features are opt-in)
- **Cost awareness**. WebSocket connections have ongoing costs. Design should account for idle connections, connection limits, and cleanup

## How to approach this

### Step 1: Read the codebase (do this first)

Spend real time understanding the current flow before researching solutions. The files listed in the "Key files to read" table above are the minimum. Use the Explore agent for deep codebase dives when needed.

### Step 2: Web research (use subagents heavily)

This is a research-heavy task. You have access to a `/research` skill and can spawn `web-research` subagents. **Use them aggressively and in parallel.** Do not guess about API capabilities — go find the real answers on the live internet.

Launch **parallel web research agents** for each of these areas:

**Agent Core Runtime APIs (highest priority):**
- "Amazon Bedrock AgentCore Runtime API 2026 streaming session communication"
- "AWS SDK client-bedrock-agentcore commands operations 2026" — look for any SDK commands beyond `InvokeAgentRuntimeCommand` (e.g., session messaging, streaming, pause/resume)
- "@aws-cdk/aws-bedrock-agentcore-alpha construct library API reference" — what configuration options exist for session communication
- "Amazon AgentCore Runtime EventBridge events session lifecycle" — does AgentCore emit events we can subscribe to?
- Check the AWS SDK for JavaScript v3 source on GitHub (`@aws-sdk/client-bedrock-agentcore`) for the full list of commands and types
- AWS re:Invent 2025 and AWS Summit 2026 sessions about AgentCore interactivity

**Claude Code SDK and Agent SDK (second priority):**
- "@anthropic-ai/claude-code SDK npm streaming callbacks hooks 2026" — look for `onMessage`, `onToolUse`, `onThinking`, or similar event hooks
- "claude-agent-sdk mid-session message injection conversation continuation"
- "Anthropic Claude Agent SDK documentation streaming interactive agents"
- Inspect the published npm package types: run `npm view @anthropic-ai/claude-code --json` and `npm pack @anthropic-ai/claude-code --dry-run` to see what's published, then read the `.d.ts` type declaration files for the full public API surface
- Check Anthropic's official documentation site, developer blog, and GitHub repos for any examples of interactive/steerable agents
- "Claude Code hooks system 2026" — the hooks system may offer extension points for interactivity

**WebSocket and real-time patterns on AWS:**
- "API Gateway WebSocket API DynamoDB connection management pattern 2026"
- "AWS Lambda WebSocket fan-out real-time agent events pattern"
- "API Gateway WebSocket Cognito JWT authentication $connect route"
- Look for AWS samples or blog posts about real-time agent monitoring dashboards

**Competitive landscape (what others are doing):**
- "GitHub Copilot Workspace real-time streaming agent progress 2026"
- "Cursor background agent streaming progress updates architecture"
- "Devin AI agent real-time collaboration interactive steering"
- "OpenAI Codex agent streaming progress human-in-the-loop"
- How do other agentic coding tools handle real-time progress and user steering?

### Step 3: Inspect published SDK artifacts

Run these commands to examine the public API surface of the SDKs we depend on:

```bash
# Claude Code SDK - check published types and exports
npm view @anthropic-ai/claude-code versions --json 2>/dev/null | tail -5
npm info @anthropic-ai/claude-code

# AWS SDK AgentCore client - check available commands
npm view @aws-sdk/client-bedrock-agentcore versions --json 2>/dev/null | tail -5

# If the packages are installed in the repo, read the type declarations directly
# Look for .d.ts files that define the full API surface
```

The published TypeScript type declarations (`.d.ts` files) are the authoritative source for what the SDK supports. These are legitimately public — they ship with the npm package. Read them carefully for any streaming, callback, or session communication interfaces.

### Step 4: Cross-reference and synthesize

Map research findings to the codebase. For each capability discovered:
- Where in the current code would it integrate?
- What files need to change?
- What are the failure modes?
- What's the security implication?

### Step 5: Write deliverables

1. **Design document** (`docs/design/INTERACTIVE_AGENTS.md`) — be specific about API calls, data flows, failure modes
2. **Implementation plan** — file-level specificity, phased milestones, testing strategy
3. **PoC scope** — smallest useful end-to-end slice

### General research guidance

- **Prefer multiple parallel research agents** over sequential searches. Time is expensive; parallelize.
- **Cite your sources.** Every capability claim should reference a URL, SDK version, or documentation page.
- **Distinguish confirmed vs speculated.** If you can't find documentation for a capability, say so explicitly. Don't assume it exists.
- **Check dates.** AgentCore is evolving rapidly. A blog post from early 2025 may describe capabilities that have since changed. Prefer the latest docs.
- **If a research avenue hits a dead end, say so.** "AgentCore does not appear to support X as of [date]" is a valuable finding that shapes the architecture.

Take your time. This is a foundational feature that affects the entire system architecture. Thoroughness matters more than speed.
