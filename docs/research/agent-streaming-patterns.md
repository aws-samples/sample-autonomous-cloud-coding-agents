# Agent Streaming Architectures: Submission vs. Observation

> Research date: 2026-04-20. Time-sensitive sources (especially AgentCore quotas and LangGraph Platform APIs) are flagged inline. This report surfaces options and published rationale — it does not recommend a specific choice for ABCA.

## Executive summary

Across the platforms surveyed, there are three dominant architectural shapes for "submit a long task + stream its progress":

1. **Same-process streaming** — the agent executes inside the same request/container that holds the SSE/WebSocket connection. Simple; breaks when the client disconnects or when non-interactive consumers (webhooks, Slack, cron) need the same events. Used by **CopilotKit's default `InMemoryAgentRunner`**, **Mastra `agent.stream()`**, and **OpenAI Assistants API streaming runs**.
2. **Orchestrator + Observer (durable run + join stream)** — the agent runs as a background job writing events to a durable log and/or pub/sub channel; any number of clients can attach, detach, and reattach. Used by **LangGraph Platform** (Postgres checkpointer + Redis pubsub, `client.runs.join_stream()`) and **Vercel `resumable-stream`** (Redis pubsub producer/consumer).
3. **Pull/query-based observation** — no streaming primitive; clients poll durable state or issue queries against the running worker. Used by **Temporal** (queries, signals, event history) and — partially — by the **OpenAI Assistants API fallback path** when SSE drops.

AgentCore is interesting because it sits *between* shapes 1 and 2: multiple `InvokeAgentRuntime` calls with the same `runtimeSessionId` **route to the same microVM**, so a streaming observer can in principle attach to a pipeline kicked off by an earlier sync invocation — but the agent code has to explicitly support that "attach" mode; AgentCore itself does not provide a join-stream primitive the way LangGraph does.

---

## 1. CopilotKit / AG-UI

**Runtime vs. gateway.** CopilotKit's `CopilotRuntime` is both orchestrator and gateway. It exposes `/agent/:agentId/run` (execution) and `/agent/:agentId/connect` (context), and it streams AG-UI events back over SSE or WebSockets ([DeepWiki: CopilotRuntime Architecture](https://deepwiki.com/CopilotKit/CopilotKit/4.1-copilotruntime-overview), [Self-hosting docs](https://docs.copilotkit.ai/guides/self-hosting)).

**Execution model.** Each `POST /agent/:agentId/run` triggers a **new agent lifecycle**. The default `InMemoryAgentRunner` is stateless. Persistence options exist (`SqliteAgentRunner` for conversation state, `IntelligenceAgentRunner` for durable threads over WebSocket), but these persist *conversation state*, not the in-flight execution itself — a new client connecting does not attach to an in-progress run; it starts one.

**AG-UI protocol** ([CopilotKit blog](https://www.copilotkit.ai/blog/introducing-ag-ui-the-protocol-where-agents-meet-users/)) standardises the *wire format* (JSON events: messages, tool calls, state patches, lifecycle signals) but leaves the attach-vs-restart question to the implementation. AG2, Phoenix, and Microsoft Agent Framework ship their own runtimes ([MS Learn AG-UI integration](https://learn.microsoft.com/en-us/agent-framework/integrations/ag-ui/?pivots=programming-language-csharp)).

**Implication for ABCA:** AG-UI defines *what* flows over the wire, not *where* the agent lives. The protocol is compatible with both the same-process and orchestrator+observer patterns.

---

## 2. LangGraph Cloud / LangGraph Platform

This is the clearest published example of the orchestrator+observer pattern in the agent space.

**Architecture** ([LangGraph persistence docs](https://docs.langchain.com/oss/python/langgraph/persistence), [Redis fault-tolerant task execution](https://neuralware.github.io/posts/langgraph-redis/)):

- **Postgres** is the checkpointer — every node execution writes a state snapshot keyed by thread + checkpoint id. This is the durable log.
- **Redis** handles fault-tolerant task queueing and real-time pub/sub between workers and streaming endpoints.
- **Threads** hold state; **runs** are individual executions against a thread.

**Stream modes** ([Streaming concepts](https://langchain-ai-langgraph-40.mintlify.app/concepts/streaming)): `values` (full state after each node), `updates` (deltas), `messages` (token-by-token), `events` (detailed lifecycle). Each can be requested per-run.

**Reliable streaming + `join_stream`** ([Changelog: reliable streaming](https://changelog.langchain.com/announcements/reliable-streaming-and-efficient-state-management-in-langgraph)):

- `GET /threads/{thread_id}/runs/{run_id}/stream` and the SDK method `client.runs.join_stream()` let a client **attach to an already-running run**, including background runs started earlier with no streaming consumer.
- Clients can navigate away and return; the run keeps executing; reconnection resumes streaming.
- Thread status values (`idle`, `busy`, `error`, `interrupted`) are queryable for non-streaming consumers.

**How LangGraph avoids double-execution:** the run is kicked off as a background job; the SSE endpoint is purely an observer over Redis pubsub + Postgres checkpoints. The agent does not re-run when a client connects.

**Time-sensitive:** `join_stream` and background runs are platform features (LangGraph Platform / LangGraph Cloud). Self-hosted OSS `langgraph` gets the primitives (checkpointers, pub/sub interface) but not the hosted endpoint out of the box.

---

## 3. OpenAI Assistants API

**Streaming runs** ([API reference](https://platform.openai.com/docs/api-reference/assistants-streaming/events.xlsx)): pass `"stream": true` to Create Run, Create Thread and Run, or Submit Tool Outputs; the response is SSE.

**No resume / no attach.** The OpenAI forum and implementation guides ([production patterns](https://michaeljohnpena.com/blog/2024-01-03-assistants-api-patterns), [community threads](https://community.openai.com/t/how-to-resume-streaming-in-python-after-submitting-function-call-outputs-in-openai-assistants-api/1119902)) confirm:

- Once an SSE stream ends with `[DONE]`, the connection cannot be reused.
- There is no documented way to attach a second stream to an in-progress run. Disconnected clients must fall back to polling `GET /threads/{thread_id}/runs/{run_id}` for status and reading messages from the thread after completion.
- Submitting tool outputs **ends the current stream**; a fresh stream must be opened for the continuation.
- "Background mode" responses have a **5-minute staleness window** — if the client doesn't reconnect within 5 minutes, streaming is no longer possible and results must be fetched via GET ([community: 5-min limit](https://community.openai.com/t/stream-background-this-response-can-no-longer-be-streamed-because-it-is-more-than-5-minutes-old/1372287)).

**How OpenAI avoids double-running:** the run is stateful on their side (thread + run entities); the SSE stream is one-shot and disposable. They own the whole stack, so they can guarantee the run keeps going server-side even if the client drops — clients just can't observe live after disconnect. The API is being sunset in favour of the Responses API ([migration guide](https://calstudio.com/blog/responses-api)).

---

## 4. Mastra

**Architecture** ([Mastra streaming overview](https://mastra.ai/docs/streaming/overview), [Mastra streaming blog](https://mastra.ai/blog/mastra-streaming)): `agent.stream()` runs the agent **synchronously within the request context**. The returned object exposes `textStream`, `text` (full-response promise), `finishReason`, `usage`. Workflows use `run.stream()` for event-based streams.

- Heavy investment in **nested streaming** — agent-in-tool, agent-in-workflow-step compose correctly.
- No documented background/interactive split; no join-stream primitive. Same-process model.
- Custom protocol layered on AI SDK v5 compatibility ([v5 announcement](https://mastra.ai/blog/announcing-mastra-improved-agent-orchestration-ai-sdk-v5-support)).

**Implication:** Mastra optimises for the interactive case. Non-interactive fan-out (webhooks, cron) is outside the streaming layer's scope.

---

## 5. AWS Bedrock AgentCore

Two findings are load-bearing for ABCA.

### 5.1 Same session ID → same microVM

From the [Runtime sessions doc](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html):

> "Context is preserved between invocations to the same session … By using the same `runtimeSessionId` for related invocations, you ensure that context is maintained across the conversation … Without a consistent session ID, each request may be routed to a new microVM."

So AgentCore *does* support multiple concurrent `InvokeAgentRuntime` calls landing on the same container. This is the primitive you need to build an attach pattern — but AgentCore does not provide a managed join-stream. Whether the second invocation observes the first or starts a new pipeline depends entirely on **your agent code**: the container receives a new HTTP invocation on `/invocations` and decides what to do with it.

The documented recent additions ([filesystem + execute command](https://aws.amazon.com/blogs/machine-learning/persist-session-state-with-filesystem-configuration-and-execute-shell-commands/), [observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-get-started.html)) persist *filesystem* and *OTel traces* across invocations, not a running pipeline's live event stream. No native pub/sub on sessions is documented.

### 5.2 Quotas — the 60-minute streaming cap is real

From the [AgentCore quotas page](https://docs.aws.amazon.com/fr_fr/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html) (fetched 2026-04-20):

| Limit | Value |
|---|---|
| Streaming max duration (response streaming and WebSocket) | **60 minutes** |
| Asynchronous job max duration | **8 hours** |
| Session max lifetime (`maxLifetime`) | 60s min, 28,800s (8h) max, default 900s (15m) |
| Idle session timeout | 15 min default (configurable) |
| Synchronous request timeout | 15 min |
| Active session workloads | 1,000 (us-east-1/us-west-2), 500 elsewhere, adjustable |
| Hardware per session | 2 vCPU / 8 GB |

**Contradiction resolved during research.** An initial summary claimed "no maximum time for streaming connections." The authoritative quotas page disagrees — streaming is capped at 60 minutes; the 8-hour figure applies only to **async jobs**. A long-running pipeline (>60 min) cannot be observed through a single AgentCore streaming connection; the observer must reconnect.

**Time-sensitive:** AgentCore is a young service; quotas and feature surface area change. Verify at deploy time.

---

## 6. Temporal.io (analogy, not a direct fit)

Temporal deliberately separates "run the workflow" from "observe the workflow" ([message passing encyclopedia](https://docs.temporal.io/encyclopedia/workflow-message-passing)):

- **Queries** — synchronous, read-only inspection of workflow state. No activities, no mutation. Served from the worker replaying history.
- **Signals** — asynchronous writes delivered into the workflow.
- **Updates** — synchronous validated writes (combine query + signal semantics).
- **Event History** — every workflow produces a durable, replayable log. Retrievable via `temporal workflow show`, `DescribeWorkflowExecution`, or the Web UI.

**No native event streaming.** The [community thread on listening to event streams](https://community.temporal.io/t/listening-to-event-streams-in-a-workflow/10677/2) recommends: external Kafka/SNS consumer dispatches signals into the workflow, and workflow uses `continue-as-new` to manage history size. The observer-facing UI is effectively a rich front-end over event history + describe APIs.

**Implication for ABCA:** Temporal's pattern is "durable log + periodic describe/query" rather than live push. Latency for observation is poll-interval bound, not sub-second. But reconnection is trivial — event history is the source of truth and always resumable.

---

## 7. Vercel AI SDK / Next.js

Vercel's ecosystem has painfully learned that the Next.js request model (serverless, per-connection, time-limited) fights long-running streams:

- [Issue #230: running as background jobs with QStash](https://github.com/vercel/ai/issues/230) — streaming doesn't compose cleanly with async background execution.
- [Issue #12949: 30s idle timeout drops tool_call streaming](https://github.com/vercel/ai/issues/12949) — edge/serverless idle timeouts kill streams.

Their answer: **[`vercel/resumable-stream`](https://github.com/vercel/resumable-stream)** — a small library implementing exactly the orchestrator+observer pattern over Redis:

- The **first** request for a given `streamId` becomes the **producer**: it runs the generator to completion even if the original client disconnects, buffering chunks to Redis.
- **Subsequent** requests for the same `streamId` (with optional `resumeAt` position) publish a message on a Redis pubsub channel; the producer replays buffered messages from the resume point, then forwards new chunks.
- Storage: Redis `INCR` + `SUBSCRIBE` for the common single-consumer case; `SET`/`GET` for buffering; pubsub channels for fan-out.

**Why it matters for ABCA:** this is the reference implementation of "one producer, many observers, reconnectable, catch-up via log" in a serverless-friendly shape. The primitives map directly to DynamoDB (durable log) + pubsub (SNS/EventBridge/IoT Core) or to ElastiCache Redis if you want the same library.

---

## 8. Named architectural patterns

Costs, latencies, and AWS mappings for each.

### 8.1 Same-process streaming (Model A)

- **Who uses it:** CopilotKit `InMemoryAgentRunner`, Mastra, OpenAI Assistants streaming, current ABCA JWT runtime behaviour.
- **Latency:** sub-100ms; the agent is writing directly to the socket.
- **AWS shape:** one Lambda/container per request; streaming via API Gateway HTTP API response streaming, Lambda Function URL with `RESPONSE_STREAM`, or AgentCore Runtime streaming mode.
- **Trade-offs vs ABCA's current design:** this *is* ABCA's current design. Breaks when the CLI closes the tab (no durable consumer), and does not fan out to webhooks/Slack without duplicating work.

### 8.2 Orchestrator + Observer (durable run + join stream)

- **Who uses it:** LangGraph Platform (`join_stream`), Vercel `resumable-stream`.
- **Latency:** sub-100ms live (pubsub hop), few-seconds catch-up (log replay).
- **AWS-native implementations:**
  - **DynamoDB log + SNS per-task topic.** Cost: SNS topic-per-task isn't idiomatic (topics are long-lived); better to use **one topic, filter by `task_id` message attribute**. Subscribers (Lambda for webhooks, WebSocket Lambda for CLI) filter via subscription filter policies.
  - **DynamoDB log + EventBridge** with event-pattern match on `task_id`. Works but EventBridge has ~0.5s publish latency and rule limits.
  - **DynamoDB Streams + Lambda fan-out** — Streams support 2 simultaneous consumers per shard natively; use **EventBridge Pipes** to fan out to more ([DDB → EventBridge Pipes pattern](https://www.boyney.io/blog/2022-11-03-eventbridge-events-with-dynamodb), [transactional outbox with Pipes](https://aws.amazon.com/blogs/compute/implementing-the-transactional-outbox-pattern-with-amazon-eventbridge-pipes/)).
  - **IoT Core MQTT** — topic per task (`tasks/{task_id}/events`), clients subscribe via MQTT-over-WSS. Scales to very high fan-out; adds an IoT dependency.
  - **API Gateway WebSocket + DynamoDB connection registry** ([AWS tutorial](https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-chat-app.html)): store `(connectionId, task_id)` in DDB with a GSI on `task_id`; on new event, query GSI and `postToConnection` to each. Standard pattern.
- **Trade-offs vs current design:** fixes double-execution; adds one infra component (pubsub) and one write path in the pipeline. Plays perfectly with reconnect/catch-up via DDB log.

### 8.3 Dual-write / CQRS

- **Who uses it:** LangGraph (Postgres checkpointer + Redis pubsub), generally the AWS transactional-outbox pattern.
- **Latency:** same as orchestrator+observer for live subscribers; tail-read from log for late joiners.
- **Key concern:** atomicity. If pipeline writes DDB then publishes, a crash between the two loses the pubsub event (live subscribers miss it, but the log is intact — they catch up on reconnect). If pubsub fails, the log is still authoritative. AWS outbox pattern ([EventBridge Pipes + DDB Streams](https://aws.amazon.com/blogs/compute/implementing-the-transactional-outbox-pattern-with-amazon-eventbridge-pipes/)) solves this by making the log the only write and deriving the pubsub from DDB Streams.

### 8.4 Pull-based with push signal

- **Who uses it:** OpenAI Assistants fallback (`GET /runs/{id}`), Temporal (describe + query), many CI systems.
- **Latency:** poll interval bound (1–5s typical).
- **AWS shape:** clients call `GET /tasks/{id}/events?after=<cursor>` against a Lambda backed by DDB. Optionally a lightweight SSE/WS channel sends "new event, poll now" signals to avoid constant polling.
- **Trade-offs:** simplest to build; worst live latency; trivially handles non-interactive consumers (they just GET on their schedule).

### 8.5 WebSocket/MQTT hub

- **Who uses it:** IoT platforms, trading floors, collaborative editors.
- **AWS shape:** **API Gateway WebSocket API** (Lambda-backed, good ≤100k concurrent) or **IoT Core MQTT** (millions of concurrent subscribers, topic-based filtering native).
- **Latency:** sub-100ms.
- **Trade-offs:** WebSocket reconnection + backfill is the application's problem; IoT Core requires adopting the IoT SDK/MQTT dependency on the client.

---

## 9. 60-minute streaming cap — reality check

The quotas page confirms AgentCore streaming is capped at **60 minutes** per connection, while asynchronous jobs can run **8 hours** ([quotas](https://docs.aws.amazon.com/fr_fr/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)). Patterns that match the observation question:

- **Orchestrator runs as async job (up to 8h); observer opens a fresh 60-min streaming connection and reconnects as needed.** This is exactly the LangGraph `join_stream` shape. Every 60 minutes the observer drops and reopens, picking up from the last event cursor in the durable log — no pipeline interruption.
- **Pipeline outside AgentCore.** If the orchestrator pipeline lives in ECS/Fargate or Step Functions, AgentCore's streaming quota only constrains the *observer* runtime. Pipeline duration is bounded by the executor (Fargate tasks: up to 14 days; Step Functions Standard: 1 year).
- **No documented pattern for >60-min single-connection observation.** All published long-running-agent guidance assumes reconnect + durable log.

**Time-sensitive:** the 60-min figure was documented 2026-04-20. AgentCore is iterating fast; verify before making long-term decisions.

---

## Comparison matrix

| Platform | Execution location | Attach to running? | Reconnect / resume | Non-interactive fan-out | Durable log |
|---|---|---|---|---|---|
| CopilotKit `InMemoryAgentRunner` | Same process as stream | No (restart) | No | Not built in | No |
| LangGraph Platform | Background worker | **Yes** (`join_stream`) | **Yes** (Redis + Postgres) | Yes (thread/run APIs) | Postgres checkpointer |
| OpenAI Assistants | OpenAI-hosted | No | No (5-min background window, else poll) | Via polling | Thread/run entities |
| Mastra | Same process as stream | No | No | Not built in | No |
| AWS AgentCore | microVM per session | **Same session → same VM**, but no managed join-stream | Agent code responsibility | Not built in | Filesystem + OTel traces |
| Temporal | Worker | Query / signal (not stream) | N/A (history is authoritative) | Yes (event history) | Event history |
| Vercel `resumable-stream` | First-request producer | **Yes** (same streamId) | **Yes** (Redis pubsub + buffer) | Via polling | Redis buffer |

---

## Sources

1. CopilotKit AG-UI blog — https://www.copilotkit.ai/blog/introducing-ag-ui-the-protocol-where-agents-meet-users/
2. CopilotRuntime Architecture (DeepWiki) — https://deepwiki.com/CopilotKit/CopilotKit/4.1-copilotruntime-overview
3. CopilotKit Self-Hosting — https://docs.copilotkit.ai/guides/self-hosting
4. MS Agent Framework AG-UI integration — https://learn.microsoft.com/en-us/agent-framework/integrations/ag-ui/?pivots=programming-language-csharp
5. LangGraph reliable streaming announcement — https://changelog.langchain.com/announcements/reliable-streaming-and-efficient-state-management-in-langgraph
6. LangGraph streaming concepts — https://langchain-ai-langgraph-40.mintlify.app/concepts/streaming
7. LangGraph persistence docs — https://docs.langchain.com/oss/python/langgraph/persistence
8. LangGraph Redis fault-tolerant task execution — https://neuralware.github.io/posts/langgraph-redis/
9. OpenAI Assistants API reference (streaming) — https://platform.openai.com/docs/api-reference/assistants-streaming/events.xlsx
10. OpenAI Assistants production patterns — https://michaeljohnpena.com/blog/2024-01-03-assistants-api-patterns
11. OpenAI community: resume after tool outputs — https://community.openai.com/t/how-to-resume-streaming-in-python-after-submitting-function-call-outputs-in-openai-assistants-api/1119902
12. OpenAI community: 5-min background streaming window — https://community.openai.com/t/stream-background-this-response-can-no-longer-be-streamed-because-it-is-more-than-5-minutes-old/1372287
13. OpenAI → Responses API migration — https://calstudio.com/blog/responses-api
14. Mastra streaming overview — https://mastra.ai/docs/streaming/overview
15. Mastra streaming blog — https://mastra.ai/blog/mastra-streaming
16. AgentCore runtime sessions — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html
17. AgentCore invoke runtime — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-invoke-agent.html
18. AgentCore filesystem + execute command — https://aws.amazon.com/blogs/machine-learning/persist-session-state-with-filesystem-configuration-and-execute-shell-commands/
19. AgentCore observability — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-get-started.html
20. AgentCore quotas — https://docs.aws.amazon.com/fr_fr/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html
21. AgentCore WebSocket limits analysis — https://www.paulserban.eu/blog/post/amazon-bedrock-agentcore-websocket-limits-5-critical-bottlenecks-you-need-to-know/
22. Temporal message passing encyclopedia — https://docs.temporal.io/encyclopedia/workflow-message-passing
23. Temporal community: listening to event streams — https://community.temporal.io/t/listening-to-event-streams-in-a-workflow/10677/2
24. Vercel AI SDK — QStash background jobs issue #230 — https://github.com/vercel/ai/issues/230
25. Vercel AI SDK — 30s idle timeout issue #12949 — https://github.com/vercel/ai/issues/12949
26. vercel/resumable-stream — https://github.com/vercel/resumable-stream
27. DynamoDB + EventBridge integration — https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/eventbridge-for-dynamodb.html
28. DynamoDB Streams → EventBridge (Boyney) — https://www.boyney.io/blog/2022-11-03-eventbridge-events-with-dynamodb
29. Transactional outbox with EventBridge Pipes — https://aws.amazon.com/blogs/compute/implementing-the-transactional-outbox-pattern-with-amazon-eventbridge-pipes/
30. API Gateway WebSocket chat app tutorial — https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-chat-app.html
31. AWS prescriptive guidance: orchestration models — https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-serverless/orchestration-models.html

---

## Methodology

Two rounds of parallel research via `kiro-search.sh`:

- Round 1: 9 parallel searches (one per topic area).
- Round 1 fetches: 6 parallel URL fetches for depth on CopilotKit runtime, LangGraph reconnect, AgentCore session attach semantics, Vercel resumable-stream internals, AgentCore quotas, and Mastra streaming.
- Round 2: 3 gap-closing searches (LangGraph Platform internals, OpenAI resume limitations, API Gateway WebSocket fan-out).

**Contradiction surfaced and resolved:** an initial Kiro summary asserted "no maximum time for streaming connections" on AgentCore. The authoritative quotas page (source 20) contradicts this — streaming is capped at 60 minutes, and the 8-hour figure applies only to asynchronous jobs. This report uses the quotas-page figures.

Date: 2026-04-20.
