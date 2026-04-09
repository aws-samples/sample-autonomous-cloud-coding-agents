---
title: Introduction
description: ABCA — Autonomous Background Coding Agents on AWS.
---

# ABCA


**Autonomous Background Coding Agents on AWS**


## What is ABCA

**ABCA (Autonomous Background Coding Agents on AWS)** is a sample of what a self-hosted background coding agents platform might look like on AWS. Users can create background coding agents, then submit coding tasks to them and the agents work autonomously in the cloud — cloning repos, writing code, running tests, and opening pull requests for review. No human interaction during execution.

The platform is built on AWS CDK with a modular architecture: an input gateway normalizes requests from any channel, a durable orchestrator executes each task according to a blueprint, and isolated compute environments run each agent. Agents learn from past interactions through a tiered memory system backed by AgentCore Memory, and a review feedback loop captures PR review comments to improve future runs.

## The use case

Users submit tasks through webhooks, CLI, or Slack. For each task, the orchestrator executes the blueprint: an isolated environment is provisioned, an agent clones the target GitHub repository and works on it. Depending on the task type, the agent creates a new branch and opens a pull request (`new_task`), iterates on an existing PR to address review feedback (`pr_iteration`), or performs a read-only review and posts structured comments on an existing PR (`pr_review`).

Key characteristics:

- **Ephemeral environments** — each task starts fresh, no in-process state carries over
- **Asynchronous** — no real-time conversation during execution
- **Repository-scoped** — each task targets a specific repo
- **Outcome-measurable** — the PR is either merged, revised, or rejected
- **Fire and forget** — submit, forget, review the outcome
- **Learns over time** — the more you use it, the more it self-improves

## How it works

Each task follows a **blueprint** — a hybrid workflow that mixes deterministic steps (no LLM, predictable, cheap) with agentic steps (LLM-driven, flexible, expensive):

1. **Admission** — the orchestrator validates the request, checks concurrency limits, and queues the task if needed.
2. **Context hydration** — the platform gathers context: task description, GitHub issue body, repo-intrinsic knowledge (CLAUDE.md, README), and memory from past tasks on the same repo.
3. **Pre-flight** — fail-closed readiness checks verify GitHub API reachability and repository access before consuming compute. Doomed tasks fail fast with a clear reason (`GITHUB_UNREACHABLE`, `REPO_NOT_FOUND_OR_NO_ACCESS`) instead of burning runtime.
4. **Agent execution** — the agent runs in an isolated MicroVM with persistent session storage for select caches: clones the repo, creates a branch, edits code, commits, runs tests and lint. The orchestrator polls for completion without blocking compute.
5. **Finalization** — the orchestrator infers the result (PR created or not), runs optional validation (lint, tests), extracts learnings into memory, and updates task status.

