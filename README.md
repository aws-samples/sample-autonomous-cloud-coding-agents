<div align="center">
  <h1>ABCA</h1>
  <img alt="ABCA" width="350" src="docs/imgs/ABCA.png" />

  <br />
  <br />

  <strong>
    Autonomous Background Coding Agents on AWS
  </strong>
 
  <br />
  <br />
  <p align="center">
    <img alt="Stability" src="https://img.shields.io/badge/stability-Experimental-important.svg?style=for-the-badge" />
  </p>
  <br />
  <a href="https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/actions/workflows/build.yml">
    <img alt="CI Status" src="https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/actions/workflows/build.yml/badge.svg" />
  </a>
  <br />
  <br />
</div>

## What is ABCA

**ABCA (Autonomous Background Coding Agents on AWS)** is a sample of what a self-hosted background coding agents platform might look like on AWS. Users can create background coding agents, then submit coding tasks to them and the agents work autonomously in the cloud — cloning repos, writing code, running tests, and opening pull requests for review. No human interaction during execution.

The platform is built on AWS CDK with a modular architecture: an input gateway normalizes requests from any channel, a durable orchestrator executes each task according to a blueprint, and isolated compute environments run each agent. Agents learn from past interactions through a tiered memory system backed by AgentCore Memory, and a review feedback loop captures PR review comments to improve future runs.

## The Use Case

Users submit tasks through webhooks, CLI, or Slack. For each task, the orchestrator executes the blueprint: an isolated environment is provisioned, an agent clones the target GitHub repository, creates a branch, works on the task, and opens a pull request.

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
3. **Agent execution** — the agent runs in an isolated MicroVM: clones the repo, creates a branch, edits code, commits, runs tests and lint. The orchestrator polls for completion without blocking compute.
4. **Finalization** — the orchestrator infers the result (PR created or not), runs optional validation (lint, tests), extracts learnings into memory, and updates task status.

For the full architecture, see [ARCHITECTURE.md](./docs/design/ARCHITECTURE.md).

## Current status

ABCA is under active development. The platform ships iteratively — each iteration adds features and builds on the previous one.

| Iteration | Status | What it delivers |
|---|---|---|
| **1** | Done | Agent runs on AWS, CLI submit, branch + PR |
| **2** | Done | Production orchestrator, API contract, task management, observability, security, webhooks |
| **3a** | Done | Repo onboarding, per-repo GitHub App credentials, turn caps, prompt guide |
| **3b** | Done | Memory Tier 1, insights, agent self-feedback, prompt versioning, commit attribution |
| **3bis** | Done | Hardening — reconciler error tracking, error serialization, test coverage gaps |
| **3c** | WIP | Deterministic validation, PR review task type, multi-modal input |
| **3d** | Planned | Review feedback loop, PR outcome tracking, evaluation pipeline |
| **4** | Planned | GitLab, visual proof, Slack, control panel, WebSocket streaming |
| **5** | Planned | Pre-warming, multi-user/team, cost management, guardrails, alternate runtime |
| **6** | Planned | Skills learning, multi-repo, iterative feedback, multiplayer, CDK constructs |

See the full [ROADMAP](./docs/guides/ROADMAP.md) for details on each iteration.

## Getting started

### Installation and deployment

Follow the [Developer Guide](./docs/guides/DEVELOPER_GUIDE.md) to set up your environment and deploy the application to your AWS account.
Then, follow the [User Guide](./docs/guides/USER_GUIDE.md) to learn how to use the system.

## Documentation

A documentation site is available containing all design documents, roadmap and guides to deploy and use the platform. You can access it [here](https://aws-samples.github.io/sample-autonomous-cloud-coding-agents/).

## Disclaimer

The example provided in this repository is for experimental and educational purposes only. It demonstrates concepts and techniques but are not intended for direct use in production environments.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](./LICENSE) file.
