---
title: Agent harness
---

# Agent harness

## Overview

An agent is, in its simplest form, an LLM autonomously using tools in a loop. We also call this simple form a shallow agent. It's great for simple tasks, like making simple interactions with a user and calling tools to quickly provide a response. As we give our agents more complicated, long-running tasks, we quickly face issues with this initial architecture: agents suffer from context overflow, get distracted (goal loss), and do not maintain state over long periods of time.

An agent harness is not an agent, but the layer around it: it provides the infrastructure needed to run agents for long periods through complex tasks. It manages everything but the model. It enables reliability by structuring workflows and managing context. This is one of the mechanisms that helps us move from a shallow to a deep agent. Deep agents are a specific type of autonomous, long-running agent built on a harness to handle complex, multi-step tasks. Every AI assistant implements its own version of an agent harness; that is the secret sauce.

For example, an AI assistant can provide an agent harness with specific tools (efficient codebase search, filesystem access), opinionated instructions (for instance, optimized system prompts for specific models), verification and guardrails (quality checks, test execution, error-correction loops), commands or lifecycle hooks (when and how to compact chat history for context management), external persistent storage (memory), and sub-agents for specific tasks run in isolation. All of this comes out of the box and is tied to a specific use case or vertical.

Many AI assistants include an embedded agent harness. Those products provide built-in capabilities and expose different ways to interact with the harness. Here, we evaluate the harness choices needed for this compute environment.

## Role in this platform

The agent harness runs **inside the compute environment** (e.g. AgentCore Runtime MicroVM). The platform orchestrates the task and **hydrates context** (user message, GitHub issue, system instructions); the harness receives the assembled prompt and runs the **agent loop** (reason, plan, call tools, repeat) until the task is done or the session ends.

- **Behavioral contract** — The platform defines **what** the agent should do (commit often, create PR, branch naming, error handling, etc.) via the **system prompt**, which is assembled by the context hydration step and passed into the session. The harness is the **execution framework**; it does not define policy. See the architecture and planning docs for the full agent behavioral contract. Deterministic hooks run to execute steps.
- **Execution model** — Tasks are **fully unattended** and **one-shot**: the user submits a task, the harness runs to completion or failure with no mid-task human interaction. The harness must support long-running execution (hours) and a single continuous loop. On AgentCore Runtime, the harness entrypoint must not block (the agent loop runs in a separate thread so the health ping can respond); the platform or harness adapter is responsible for that pattern. **Important:** The agent thread uses `asyncio.run()` with the stdlib asyncio event loop. The uvicorn server is configured with `--loop asyncio` to avoid uvloop, which conflicts with subprocess SIGCHLD handling when multiple event loops run in different threads.
- **Result** — The agent does not call back to the platform; it follows the contract (push work, create PR) and exits. The platform infers success or failure from the PR and branch state via the GitHub API.

## MVP choice: Claude Code SDK

The MVP uses **[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python)** (`claude-agent-sdk`) as the agent harness. The agent uses the `ClaudeSDKClient` class (connect/query/receive_response pattern) rather than the standalone `query()` function, following the official AWS sample implementation. `ClaudeSDKClient` provides streaming message reception via an async generator, enabling the platform to capture per-turn trajectory data (token usage, cost, tool calls) as messages arrive. The SDK provides the agent loop, built-in tool use (file system, shell), and integrates with the compute environment. Tools beyond the SDK's native ones (GitHub, web search) are exposed via **AgentCore Gateway**.

## MVP tool set

- **GitHub** (clone, push, PR, issues) — AgentCore Gateway + Identity (core workflow).
- **Web search** — AgentCore Gateway (documentation lookups).
- **Shell execution** — Native in MicroVM via the SDK (build, test, lint).
- **File system** — Native in MicroVM via the SDK (read/write code).

Plugins, skills, and MCP servers are **out of scope for MVP**. The harness must support adding tools (the platform adds Gateway-backed tools); the requirement to "add additional tools" is satisfied by the Gateway integration.

## Requirements

The following are desired properties for the harness; MVP satisfies some and defers others:

- **Add additional tools** — In addition to the harness’s built-in tools (e.g. file, shell), the platform must be able to attach more (e.g. via AgentCore Gateway). MVP: satisfied by Gateway (GitHub, web search).
- **Deterministic hooks** — Support for deterministic steps or hooks (e.g. pre/post tool execution, validation) so the platform can mix coded logic with the agent loop. The **blueprint execution framework** (see [REPO_ONBOARDING.md](/design/repo-onboarding#blueprint-execution-framework)) realizes this requirement: the orchestrator runs custom Lambda-backed steps at configurable pipeline phases (`pre-agent`, `post-agent`) with framework-enforced invariants (state transitions, events, cancellation). The agent harness itself does not need to implement hooks — they run at the orchestrator level, outside the agent session.
- **Plugins / skills / MCP** — Support for plugins, skills, or MCP servers for extensibility. Out of scope for MVP.
- **Access to external memory** — The agent should be able to read and write short- and long-term memory (e.g. AgentCore Memory). MVP: AgentCore Memory is available to the agent via the runtime; the SDK or platform wires it in.
- **Session persistence** — Persisting conversation and agent state across session boundaries for crash recovery or resume. MVP: Claude Code SDK has no built-in session manager; durability is via frequent commits. **Update:** AgentCore Runtime persistent session storage (preview) now mounts a per-session filesystem at `/mnt/workspace` that survives stop/resume cycles. Tool caches (mise, npm, Claude Code config) persist across invocations within a session (14-day TTL). Repo clones remain on local ephemeral disk because the S3-backed FUSE mount does not support `flock()`, which breaks build tools like `uv`. See [COMPUTE.md](/design/compute#session-storage-persistent-filesystem).

## Diagnostic tools

The `agent/` directory includes two diagnostic scripts for troubleshooting SDK and subprocess issues in the deployed container:

- **`test_subprocess_threading.py`** — Reproduces and verifies subprocess-in-background-thread behavior. Tests both Python and Node.js child processes with `asyncio.run()` in a background thread vs. `run_coroutine_threadsafe()` on the main loop. Run inside the container to confirm subprocess pipe I/O works correctly.
- **`test_sdk_smoke.py`** — Minimal SDK smoke test that exercises the `ClaudeSDKClient` → Claude Code CLI → Bedrock pipeline with a trivial prompt, outside the web server context. Verifies that the SDK yields messages (SystemMessage, AssistantMessage, ResultMessage) end-to-end. Useful for isolating whether a message-yielding issue is SDK/CLI/Bedrock-level or threading-level.
