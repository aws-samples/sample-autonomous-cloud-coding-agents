---
title: Orchestrator and agent
description: The orchestrator is the durable control plane; the agent is the LLM-driven worker inside compute.
diataxis: explanation
---

# Orchestrator and agent

**Level:** 100 — Fundamentals  
**One line:** The **orchestrator** runs cheap, deterministic platform steps; the **agent** is the LLM-driven worker that edits code, calls tools, and produces outcomes inside isolated compute.

## What it is

The **orchestrator** (Lambda Durable Functions and related services) owns the task state machine: admission, hydration, pre-flight, polling the compute session, and finalization. It does not write your application code — it ensures every task reaches a known end state.

The **agent** runs inside **compute** (by default, an AgentCore MicroVM). It clones repos, invokes the model, runs tests, opens PRs, and respects tool policy. If the agent misbehaves or times out, the orchestrator still updates task status and audit events.

## Analogy

The orchestrator is air traffic control; the agent is the pilot in a single flight. Control tower tracks every flight; pilots do not share one cockpit across flights.

## Why it matters to you

| Role | Why care |
|------|----------|
| Operator | Orchestrator failures are platform incidents; agent failures are often task-scoped. |
| Teammate | You interact with task status and outcomes, not the orchestrator directly. |
| Repo author | Agent prompts and tools are blueprint-scoped; orchestrator behavior is platform-wide. |

## Related concepts

- [Agent harness](./agent-harness.md) — loop around the model inside compute
- [Task and workflow](./task-and-workflow.md)
- [COMPUTE.md](../../../design/COMPUTE.md) — MicroVM isolation

## Deep dive

- [ORCHESTRATOR.md](../../../design/ORCHESTRATOR.md)
- [ARCHITECTURE.md](../../../design/ARCHITECTURE.md) — blueprint step model
