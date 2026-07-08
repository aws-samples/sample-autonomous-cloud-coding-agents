---
title: Blueprint vs workflow
description: Workflows define task kinds; blueprints configure how those tasks run for each repository.
diataxis: explanation
---

# Blueprint vs workflow

**Level:** 100 — Fundamentals  
**One line:** A **workflow** is the platform recipe for a *kind* of task; a **blueprint** is the per-**repository** configuration (model, credentials, Cedar policy, limits) used when that repo runs.

## What it is

**Workflows** are shared, versioned definitions: “coding new task,” “PR review,” “web research.” They declare requirements (repo optional or not), tool surface, and outcome shape.

A **blueprint** is created when you onboard a repository. It binds that repo to AWS resources: GitHub token scope, compute settings, memory strategies, Cedar policies, and optional step overrides. Many repos can use the same workflow with different blueprints.

Do not conflate them: changing a workflow affects *what* runs; changing a blueprint affects *how* it runs for one repo.

## Analogy

A **workflow** is the menu item (“margherita pizza”). The **blueprint** is your kitchen’s ingredients and house rules for that item at *your* restaurant location.

## Why it matters to you

| Role | Why care |
|------|----------|
| Operator | Blueprints are CDK constructs; misconfiguration affects cost and security per repo. |
| Teammate | You usually only pick repo + workflow at submit time. |
| Repo author | Prompts, Cedar, and overrides live in the blueprint layer. |

## Related concepts

- [Task and workflow](./task-and-workflow.md)
- [Cedar policy guide](../../CEDAR_POLICY_GUIDE.md) — authoring rules
- [Repository onboarding](../../USER_GUIDE.md#repository-onboarding)

## Deep dive

- [REPO_ONBOARDING.md](../../../design/REPO_ONBOARDING.md)
- [WORKFLOWS.md](../../../design/WORKFLOWS.md)
