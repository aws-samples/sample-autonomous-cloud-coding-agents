---
title: How the platform works
description: End-to-end story — submit a task, orchestrate in the cloud, get a governed outcome.
diataxis: explanation
---

# How the platform works

ABCA is a **self-hosted platform** that runs autonomous agents in your AWS account. You submit work through a **channel** (CLI, API, Slack, Linear, Jira, or webhook). The **orchestrator** admits the task, hydrates context, and runs pre-flight checks. An **agent** executes inside an isolated **compute** session under a **harness** (tool loop + policy). You get a **reviewable outcome** — a pull request, review comments, or a research brief — plus an audit trail.

## Sixty-second flow

```mermaid
flowchart LR
  A[Channels] --> B[Orchestrator]
  B --> C[Agent in compute]
  C --> D[Outcome]
  B --> E[Memory and audit]
```

1. **Submit** — A typed task (workflow, repo, description) enters the input gateway.
2. **Admit** — Concurrency, auth, and guardrails are enforced; doomed tasks fail fast.
3. **Hydrate** — Issue body, repo docs, and memory are assembled into agent context.
4. **Execute** — The agent runs in a per-task MicroVM with scoped credentials.
5. **Finalize** — Status, PR links, learnings, and events are recorded.

## Start here if…

| You are… | Read first |
|----------|------------|
| New operator deploying the stack | [Quick Start](../QUICK_START.mdx) |
| Teammate submitting tasks | [Task and workflow](/sample-autonomous-cloud-coding-agents/architecture/task-and-workflow) → [Using the CLI](/sample-autonomous-cloud-coding-agents/using/using-the-cli) |
| Evaluator (no deploy yet) | [Introduction](/sample-autonomous-cloud-coding-agents/introduction/introduction), then Level 100 pages below |
| Repo author customizing behavior | [Blueprint vs workflow](/sample-autonomous-cloud-coding-agents/architecture/blueprint-vs-workflow) → Customizing guides |
| Platform contributor | [Developer guide](/sample-autonomous-cloud-coding-agents/developer-guide/introduction) |

## Level 100 — Fundamentals

Plain-language concepts (no code required):

- [Task and workflow](/sample-autonomous-cloud-coding-agents/architecture/task-and-workflow) — unit of work and versioned recipe
- [Blueprint vs workflow](/sample-autonomous-cloud-coding-agents/architecture/blueprint-vs-workflow) — per-repo config vs task kind
- [Orchestrator and agent](/sample-autonomous-cloud-coding-agents/architecture/orchestrator-and-agent) — control plane vs reasoning
- [Agent harness](/sample-autonomous-cloud-coding-agents/architecture/agent-harness) — the execution loop around the model

## Level 200 and architecture

Deeper “how it fits together” pages and implementation detail are in Phase 2. Until then, use [Architecture](/sample-autonomous-cloud-coding-agents/architecture/architecture) for full design docs and [Using the platform](/sample-autonomous-cloud-coding-agents/using/overview) for day-to-day operations.

## Next steps

- [Learning path](/sample-autonomous-cloud-coding-agents/getting-started/learning-path) — goal-based router after deploy
- [Use cases index](/sample-autonomous-cloud-coding-agents/use-cases/use-cases-index) — outcome tutorials
- [Vision](/sample-autonomous-cloud-coding-agents/architecture/vision) — long-term direction and dark-factory scorecard
