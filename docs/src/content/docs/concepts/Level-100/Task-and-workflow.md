---
title: Task and workflow
description: A task is one unit of background work; a workflow is the versioned recipe for what kind of work runs.
diataxis: explanation
---

# Task and workflow

**Level:** 100 — Fundamentals  
**One line:** A **task** is one admitted unit of work from submit to terminal state; a **workflow** is the versioned recipe that defines *what kind* of work runs.

## What it is

When you submit work to ABCA, you create a **task** — a durable record with an ID, status, workflow reference, and outcome (PR URL, failure reason, etc.). The platform drives every task to a terminal state (`SUCCEEDED`, `FAILED`, `CANCELLED`, …) even if the agent crashes.

A **workflow** (for example `coding/new-task-v1`, `coding/pr-review-v1`, `knowledge/web-research-v1`) selects the agent behavior: which tools are allowed, whether a GitHub repo is required, and what success looks like. Workflows are versioned so you can adopt new behavior without silent changes.

## Analogy

Think of a **workflow** as a printed playbook (“how we do PR reviews”) and a **task** as one game played from that playbook tonight.

## Why it matters to you

| Role | Why care |
|------|----------|
| Operator | Tasks are metered (turns, USD budget, concurrency); workflows define blast radius. |
| Teammate | You pick workflow + repo when submitting; the task ID is how you track progress. |
| Repo author | Blueprint config maps repos to defaults; workflows stay platform-wide recipes. |

## Related concepts

- [Blueprint vs workflow](/sample-autonomous-cloud-coding-agents/architecture/blueprint-vs-workflow) — per-repo settings vs task kind
- [Orchestrator and agent](/sample-autonomous-cloud-coding-agents/architecture/orchestrator-and-agent) — who runs the task
- [Using workflows](/sample-autonomous-cloud-coding-agents/using/workflows) — which workflow when

## Deep dive

- [WORKFLOWS.md](/sample-autonomous-cloud-coding-agents/architecture/workflows) — workflow catalog and resolution
- [Task lifecycle](/sample-autonomous-cloud-coding-agents/using/task-lifecycle) — states and transitions (operational detail)
