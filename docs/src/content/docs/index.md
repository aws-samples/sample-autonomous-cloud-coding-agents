---
title: Introduction
description: ABCA  - Autonomous Background Coding Agents on AWS.
---

# ABCA


**Autonomous Background Coding Agents on AWS**


## What is ABCA

**ABCA (Autonomous Background Coding Agents on AWS)** is a sample of what a self-hosted background coding agents platform might look like on AWS. Users can create background coding agents, then submit coding tasks to them and the agents work autonomously in the cloud  - cloning repos, writing code, running tests, and opening pull requests for review. No human interaction during execution.

The platform is built on AWS CDK with a modular architecture: an input gateway normalizes requests from any channel, a durable orchestrator executes each task according to a blueprint, and isolated compute environments run each agent. Agents learn from past interactions through a tiered memory system backed by AgentCore Memory, and a review feedback loop captures PR review comments to improve future runs.

## Why this matters: software dark factories

ABCA is a step toward what the industry is starting to call a **software dark factory** - a software-delivery system that takes high-level intent as input and autonomously produces code changes, validation evidence, and deployable artifacts under remote supervision. The analogy is the "lights-out" factory in manufacturing: humans set goals, constraints, and policies; the production system absorbs the cognition that used to sit in engineers' heads and keyboards.

A software dark factory is not the same thing as "an agent that writes code." A dark factory surrounds the coding agent with durable control-plane services, memory, validation, policy, and replay. The current market is better described as **"lights-sparse"**: the implementation loop is increasingly autonomous, while governance, release authority, and exception handling remain supervised. ABCA embraces that same trajectory and offers a sample architecture to explore it on AWS.

### Key attributes of a software dark factory

Eight attributes distinguish a real dark factory from a coding agent wrapped in automation:

1. **Machine-actionable intake** - issues, specs, and incidents become typed work items the platform can reason about, not free-form prompts.
2. **Isolated execution** - each task runs in a bounded environment with scoped credentials and no shared state with other runs.
3. **Durable, replayable orchestration** - the platform survives retries, timeouts, cancellations, and operator intervention without losing task state.
4. **Intrinsic evaluation** - tests, linting, policy checks, and risk scoring are part of the execution loop, not an afterthought performed by humans later.
5. **Persistent memory with guardrails** - lessons carry across sessions via semantic, episodic, procedural, and review-rule memory, without polluting future runs.
6. **Observability, attribution, and auditability** - every decision is traceable to a task, prompt version, model, and memory retrieval set.
7. **Metered cost, capacity, and blast radius** - budgets, concurrency, and scope are enforced rather than advisory.
8. **Governed, reversible release path** - promotion, approvals, and rollback are policy-aware and tied to the same lineage as the work that produced them.

### Where ABCA stands today

Maturity along these axes is a continuum, not a binary. Organizations typically stop at a "lights-sparse" state for a long time, because the governance burden rises sharply as autonomy expands from code generation to deployment authority. The scorecard below maps each attribute to what the sample already ships and what is still on the [Roadmap](/sample-autonomous-cloud-coding-agents/roadmap/roadmap).

| # | Attribute | Status | Evidence in this sample |
|---|-----------|--------|-------------------------|
| 1 | Machine-actionable intake | Strong | Typed task schema, CLI/REST API with idempotency keys, HMAC webhooks, input guardrails |
| 2 | Isolated execution | Strong | AgentCore Runtime MicroVM per task, VPC with private subnets, DNS firewall, per-blueprint scoped credentials |
| 3 | Durable, replayable orchestration | Partial | Lambda Durable Functions with checkpoint/resume, typed state machine, concurrency drift reconciliation; deterministic replay bundles are roadmap |
| 4 | Intrinsic evaluation | Partial | Pre-flight checks, build/lint verification, Bedrock Guardrails, Cedar tool policy; tiered validation, PR risk classification, and evaluation pipeline are roadmap |
| 5 | Persistent memory with guardrails | Partial | AgentCore Memory with semantic and episodic strategies, SHA-256 provenance, fail-open writes; trust-aware retrieval, decay, quarantine, and procedural memory are roadmap |
| 6 | Observability, attribution, and auditability | Strong | OpenTelemetry spans, operator dashboard, TaskEvents audit trail, model-invocation logging, prompt versioning, per-commit `Task-Id` trailers |
| 7 | Metered cost, capacity, and blast radius | Partial | Per-task turn caps, USD budget, per-user concurrency, WAF rate limits, tool-call policy; team/monthly budgets and cost-aware routing are roadmap |
| 8 | Governed, reversible release path | Roadmap | Human PR review is the current gate; signed artifacts, staging→prod promotion, deployment evidence bundles, and rollback lineage are roadmap |

The [Roadmap](/sample-autonomous-cloud-coding-agents/roadmap/roadmap#strategy-retire-risk-then-raise-autonomy) sequences the work needed to move each row from Partial or Roadmap to Strong, grouped by the risk each milestone retires.

## The use case

Users submit tasks through webhooks, CLI, or Slack. For each task, the orchestrator executes the blueprint: an isolated environment is provisioned, an agent clones the target GitHub repository and works on it. Depending on the task type, the agent creates a new branch and opens a pull request (`new_task`), iterates on an existing PR to address review feedback (`pr_iteration`), or performs a read-only review and posts structured comments on an existing PR (`pr_review`).

Key characteristics:

- **Ephemeral environments**  - each task starts fresh, no in-process state carries over
- **Asynchronous**  - no real-time conversation during execution
- **Repository-scoped**  - each task targets a specific repo
- **Outcome-measurable**  - the PR is either merged, revised, or rejected
- **Fire and forget**  - submit, forget, review the outcome
- **Learns over time**  - the more you use it, the more it self-improves

## Get started

**New here?** Follow the [Quick Start](/sample-autonomous-cloud-coding-agents/getting-started/quick-start)  - deploy the platform, onboard a repo, and submit your first task in about 30 minutes.

## How it works

Each task follows a **blueprint**  - a hybrid workflow that mixes deterministic steps (no LLM, predictable, cheap) with agentic steps (LLM-driven, flexible, expensive):

1. **Admission**  - the orchestrator validates the request, checks concurrency limits, and queues the task if needed.
2. **Context hydration**  - the platform gathers context: task description, GitHub issue body, repo-intrinsic knowledge (CLAUDE.md, README), and memory from past tasks on the same repo.
3. **Pre-flight**  - fail-closed readiness checks verify GitHub API reachability and repository access before consuming compute. Doomed tasks fail fast with a clear reason (`GITHUB_UNREACHABLE`, `REPO_NOT_FOUND_OR_NO_ACCESS`) instead of burning runtime.
4. **Agent execution**  - the agent runs in an isolated MicroVM with persistent session storage for select caches: clones the repo, creates a branch, edits code, commits, runs tests and lint. The orchestrator polls for completion without blocking compute.
5. **Finalization**  - the orchestrator infers the result (PR created or not), runs optional validation (lint, tests), extracts learnings into memory, and updates task status.
