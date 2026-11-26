---
title: Introduction
description: ABCA  - Autonomous Background Coding Agents on AWS.
---

**ABCA, Autonomous Background Coding Agents on AWS**


## What is ABCA

**ABCA (Autonomous Background Coding Agents on AWS)** is a sample of what a self-hosted platform for background coding agents might look like on AWS. Users can create background coding agents, then submit coding tasks to them. The agents work autonomously in the cloud. They clone repos, write code, run tests, and open pull requests for review. No human interacts with an agent during execution.

The platform is built on AWS CDK with a modular architecture. An input gateway normalizes requests from any channel. A durable orchestrator executes each task according to a blueprint. Isolated compute environments run each agent. Agents learn from past interactions through a tiered memory system backed by AgentCore Memory. A review feedback loop captures PR review comments to improve future runs.

## Why this matters: software dark factories

ABCA is a step toward what the industry is starting to call a **software dark factory**. A software dark factory is a software-delivery system that takes high-level intent as input and autonomously produces code changes, validation evidence, and deployable artifacts under remote supervision. The analogy is the "lights-out" factory in manufacturing. Humans set goals, constraints, and policies. The production system does the reasoning and the typing that engineers used to do.

A software dark factory is not the same thing as "an agent that writes code." A software dark factory surrounds the coding agent with durable control-plane services, memory, validation, policy, and replay. The current market is better described as **"lights-sparse"**. The implementation loop is increasingly autonomous, while governance, release authority, and exception handling remain supervised. ABCA follows that same trajectory and offers a sample architecture to explore it on AWS.

### Key attributes of a software dark factory

Eight attributes distinguish a real software dark factory from a coding agent wrapped in automation:

1. **Machine-actionable intake.** Issues, specs, and incidents become typed work items that the platform can reason about, not free-form prompts.
2. **Isolated execution.** Each task runs in a bounded environment with scoped credentials and no shared state with other runs.
3. **Durable, replayable orchestration.** The platform survives retries, timeouts, cancellations, and operator intervention without losing task state.
4. **Intrinsic evaluation.** Tests, linting, policy checks, and risk scoring are part of the execution loop, not an afterthought that humans perform later.
5. **Persistent memory with guardrails.** Lessons carry across sessions through semantic, episodic, procedural, and review-rule memory, without polluting future runs.
6. **Observability, attribution, and auditability.** Every decision is traceable to a task, prompt version, model, and memory retrieval set.
7. **Metered cost, capacity, and blast radius.** Budgets, concurrency, and scope are enforced rather than advisory.
8. **Governed, reversible release path.** Promotion, approvals, and rollback are policy-aware and tied to the same lineage as the work that produced them.

### Where ABCA stands today

Maturity along these axes is a continuum, not a binary. Organizations typically stop at a "lights-sparse" state for a long time, because the governance burden rises sharply as autonomy expands from code generation to deployment authority. The scorecard below maps each attribute to what the sample already ships and what remains planned.

| # | Attribute | Status | Evidence in this sample |
|---|-----------|--------|-------------------------|
| 1 | Machine-actionable intake | Strong | Typed task schema, CLI/REST API with idempotency keys, HMAC webhooks, input guardrails |
| 2 | Isolated execution | Strong | AgentCore Runtime MicroVM per task, VPC with private subnets, DNS firewall, per-blueprint scoped credentials |
| 3 | Durable, replayable orchestration | Partial | Lambda Durable Functions with checkpoint/resume, typed state machine, concurrency drift reconciliation. Deterministic replay bundles are planned |
| 4 | Intrinsic evaluation | Partial | Pre-flight checks, build/lint verification, Bedrock Guardrails, Cedar tool policy. Tiered validation, PR risk classification, and evaluation pipeline are planned |
| 5 | Persistent memory with guardrails | Partial | AgentCore Memory with semantic and episodic strategies, SHA-256 provenance, fail-open writes. Trust-aware retrieval, decay, quarantine, and procedural memory are planned |
| 6 | Observability, attribution, and auditability | Strong | OpenTelemetry spans, operator dashboard, TaskEvents audit trail, model-invocation logging, prompt versioning, per-commit `Task-Id` trailers |
| 7 | Metered cost, capacity, and blast radius | Partial | Per-task turn caps, USD budget, per-user concurrency, WAF rate limits, tool-call policy. Team/monthly budgets and cost-aware routing are planned |
| 8 | Governed, reversible release path | Planned | Human PR review is the current gate. Signed artifacts, staging→prod promotion, deployment evidence bundles, and rollback lineage are planned |

Planned work to move each row from Partial or Planned to Strong is tracked as [GitHub issues](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues) with priority labels such as `P0` and `P1`.

## The use case

Users submit tasks through webhooks, the CLI, or Slack. For each task, the orchestrator executes the blueprint. An isolated environment is provisioned, and an agent clones the target GitHub repository and works on it. Depending on the resolved workflow, the agent creates a new branch and opens a pull request (`coding/new-task-v1`), iterates on an existing PR to address review feedback (`coding/pr-iteration-v1`, CLI `--pr`), or performs a read-only review and posts structured comments on an existing PR (`coding/pr-review-v1`, CLI `--review-pr`).

Key characteristics:

- **Ephemeral environments.** Each task starts fresh, and no in-process state carries over.
- **Asynchronous.** There is no real-time conversation during execution.
- **Repository-scoped.** Each task targets a specific repo.
- **Outcome-measurable.** The PR is either merged, revised, or rejected.
- **Fire and forget.** Submit the task, forget it, then review the outcome.
- **Learns over time.** The more you use it, the more it self-improves.

## Get started

**New here?** Follow the [Quick Start](/sample-autonomous-cloud-coding-agents/getting-started/quick-start) to deploy the platform, onboard a repo, and submit your first task in about 30 minutes.

## How it works

Each task follows a **blueprint**, a hybrid workflow that mixes deterministic steps (no LLM, predictable, cheap) with agentic steps (LLM-driven, flexible, expensive):

1. **Admission.** The orchestrator validates the request, checks concurrency limits, and queues the task if needed.
2. **Context hydration.** The platform gathers context: task description, GitHub issue body, repo-intrinsic knowledge (CLAUDE.md, README), and memory from past tasks on the same repo.
3. **Pre-flight.** Fail-closed readiness checks verify GitHub API reachability and repository access before the task consumes compute. A task that cannot succeed fails early with a clear reason (`GITHUB_UNREACHABLE`, `REPO_NOT_FOUND_OR_NO_ACCESS`) instead of consuming runtime.
4. **Agent execution.** The agent runs in an isolated MicroVM with persistent session storage for select caches. It clones the repo, creates a branch, edits code, commits, and runs tests and lint. The orchestrator polls for completion without blocking compute.
5. **Finalization.** The orchestrator infers the result (PR created or not), runs optional validation (lint, tests), extracts learnings into memory, and updates task status.
