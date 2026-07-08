---
title: Agent harness
description: The harness is the SDK loop around the model — tools, policy, turns, and session lifecycle.
diataxis: explanation
---

# Agent harness

**Level:** 100 — Fundamentals  
**One line:** The **harness** is the runtime loop around the foundation model: context, tool calls, guardrails, turn limits, and session lifecycle — not the model weights themselves.

## What it is

ABCA’s agent does not call Bedrock once and exit. The **harness** (Claude Agent SDK in the sample) repeatedly: reads context, proposes tool use (bash, file edit, GitHub API, …), enforces Cedar and guardrails, records telemetry, and stops when the workflow goal is met or limits hit.

The harness is **not** the orchestrator. The orchestrator lives outside compute; the harness runs **inside** the MicroVM with the repo clone.

## Analogy

The harness is flight software around the pilot: autopilot rules, checklists, and instruments — the pilot (model) still decides, but cannot bypass the aircraft’s safety envelope.

## Why it matters to you

| Role | Why care |
|------|----------|
| Operator | Turn caps and tool policy are harness/orchestrator contracts — they bound cost and risk. |
| Teammate | Odd agent behavior is often harness + prompt + memory, not “random AI.” |
| Repo author | Repo-local `AGENTS.md` and rules shape what the harness sees. |

## Related concepts

- [Orchestrator and agent](./orchestrator-and-agent.md)
- [Blueprint vs workflow](./blueprint-vs-workflow.md)
- [What the agent does](../../USER_GUIDE.md#what-the-agent-does) — operational view

## Deep dive

- [COMPUTE.md](../../../design/COMPUTE.md) — harness section and constraints
- [SECURITY.md](../../../design/SECURITY.md) — tool policy and isolation
