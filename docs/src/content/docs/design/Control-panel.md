---
title: Control panel
---

# Control panel

The **control panel** is a web-based UI (dashboard) that gives operators and users a central place to manage the platform, see what the agents are doing, and inspect outcomes. It complements the CLI and other channels: users can submit and manage tasks from the CLI or Slack, but the control panel provides a unified view across tasks, agents, and system health.

## Purpose

- **Operators** — monitor system health, capacity, and errors; triage stuck or failed tasks; manage which agents or runtimes are available.
- **Users** — view their tasks (status, history, PR links), drill into task details or logs when something goes wrong, and optionally trigger actions (e.g. cancel a task) from the UI.
- **Visibility** — make it easy to see everything that is going on (see [OBSERVABILITY.md](/design/observability)), in line with the platform’s observability design principle.

## Main capabilities

### Manage agents

- View which **agents** (or agent runtimes) are configured and available — e.g. the default coding agent backed by Claude Code SDK and AgentCore Runtime.

### Visualize all tasks

- **Task list** — all tasks (or filtered by user, status, repo, time range). Columns such as task id, user, repo, status, created at, completed at, PR link.
- **Task detail** — drill into a single task: full metadata (repo, branch, PR URL, error message), status history, link to audit events (TaskEvents), and when available link to agent logs or traces (e.g. CloudWatch, runtime session).
- **Actions** — from the panel, users can perform the same task actions as from the CLI: view status and cancel a running task.

### Visualize metrics

- **Dashboards** — key metrics in one place (see [OBSERVABILITY.md](/design/observability) for the candidate list): active task counts, submitted backlog, task completion rate, task duration (e.g. p50/p95), cold start duration, error rates, token usage.
- **System health** — concurrency usage, counter drift alerts, submitted backlog (e.g. when the system is at capacity). Alarms (stuck tasks, orchestration failures, agent crash rate) can be surfaced in the UI or via a separate alerting channel.
- **Cost and usage** — token usage per task/user/repo and cost attribution dashboards.

## Relationship to other channels

- **CLI** — primary channel in MVP for submitting tasks, polling status, and cancelling. The control panel does not replace the CLI; it adds a visual, cross-task view and the same (or a subset of) task actions.
- **Input gateway** — if the control panel allows submitting tasks or approving requests, it connects through the same input gateway as other channels and uses the same internal message/notification formats. See [INPUT_GATEWAY.md](/design/input-gateway).

## Scope and phasing

- The control panel is an operator-facing surface for visibility and task operations.
- Detailed implementation choices (tech stack, auth flow, and exact UI layout) are defined in implementation docs and code.

This document describes the **control panel’s role and capabilities** at a design level. Implementation (tech stack, auth, exact screens) belongs in the architecture and implementation phases.
