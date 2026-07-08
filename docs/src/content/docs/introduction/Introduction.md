---
title: Introduction
description: What ABCA is — a self-hosted autonomous agent platform on AWS for coding, review, research, and more.
diataxis: explanation
---

# Introduction

**ABCA (Autonomous Background Coding Agents on AWS)** is a sample of a **self-hosted autonomous agent platform** you deploy in your own AWS account. You submit background work through a channel (CLI, API, Slack, Linear, Jira, or webhook); agents run in isolated compute, under policy; you get a **governed outcome** — a pull request, review comments, or a research brief — plus an audit trail.

## What you get

- **Background agents** — submit intent; the platform runs to completion without a live chat session
- **Isolated execution** — one MicroVM per task with scoped credentials
- **Workflow-driven tasks** — versioned recipes (`coding/*`, `knowledge/*`), not one-off prompts
- **Governance built in** — Cedar HITL, Bedrock Guardrails, human PR review as the default release gate
- **Your AWS account** — CDK-deployed sample you control, not a SaaS black box

For how channels, orchestrator, agent, and outcomes fit together, see [How the platform works](/sample-autonomous-cloud-coding-agents/concepts/how-the-platform-works).

## Beyond coding

Coding agents showed that **isolated, tool-using runtimes** can do real work unattended. ABCA generalizes that pattern: the same orchestrator, policy gates, memory, and audit trail support **coding, review, research, and ops-style workflows** — not only pull requests. Repo-optional workflows (`requires_repo: false`) run knowledge and analysis tasks without cloning a repository.

See [All use cases](/sample-autonomous-cloud-coding-agents/use-cases/use-cases-index) for outcome-first tutorials.

## Who it is for

- **Operators** — deploy and run the stack in AWS
- **Teammates** — submit tasks from CLI, chat, or issue trackers
- **Repo authors** — customize prompts, Cedar policy, and blueprint defaults
- **Evaluators** — understand the platform before deploy; start with [Concepts](/sample-autonomous-cloud-coding-agents/concepts/how-the-platform-works)
- **Contributors** — extend the CDK app, agent runtime, or CLI

## Next steps

- [Quick Start](./QUICK_START.mdx) — deploy and submit your first task (~30 min)
- [How the platform works](/sample-autonomous-cloud-coding-agents/concepts/how-the-platform-works) — end-to-end story and fundamentals
- [All use cases](/sample-autonomous-cloud-coding-agents/use-cases/use-cases-index) — outcome-first tutorials
- [Vision](/sample-autonomous-cloud-coding-agents/architecture/vision) — long-term direction and dark-factory scorecard
