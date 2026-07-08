---
title: Learning path
description: Goal-based router — what to read or do next after deploy.
diataxis: explanation
---

# Learning path

You deployed (or joined) a stack. **What do you want to do next?** Pick a goal — each card links to the shortest doc path.

| If you want to… | Go to | Workflow / channel |
|-----------------|-------|-------------------|
| Submit your first coding task from the terminal | [Quick Start](./QUICK_START.mdx) (Steps 4–5) | `coding/new-task-v1` · CLI |
| Auto-review every new PR | [Automated PR review tutorial](./use-cases/automated-pr-review.md) | `coding/pr-review-v1` · webhook |
| Address review comments on an open PR | [Workflows](./USER_GUIDE.md#workflows) + `bgagent submit --pr` | `coding/pr-iteration-v1` · CLI |
| Trigger tasks from Linear / Jira / Slack | [Linear](./LINEAR_SETUP_GUIDE.md) · [Jira](./JIRA_SETUP_GUIDE.md) · [Slack](./SLACK_SETUP_GUIDE.md) | Channel-specific |
| Customize prompts or Cedar policy for a repo | [Repository onboarding](./USER_GUIDE.md#repository-onboarding) | Blueprint |
| Run research without a GitHub repo | [Web research brief](./use-cases/web-research-brief.md) | `knowledge/web-research-v1` |
| Understand how the platform works (no deploy yet) | [How the platform works](./concepts/HOW_THE_PLATFORM_WORKS.md) | — |
| Learn what “harness” and “blueprint” mean | [Agent harness](./concepts/level-100/agent-harness.md) · [Blueprint vs workflow](./concepts/level-100/blueprint-vs-workflow.md) | Concepts |
| Contribute to the platform | [Developer guide](./DEVELOPER_GUIDE.md) → [Contributing](../../CONTRIBUTING.md) | — |

## Personas

| Persona | Typical first week |
|---------|-------------------|
| **Operator** | Quick Start → Deployment Guide → Cost Attribution |
| **Teammate** | Roles (in User Guide) → CLI → first task |
| **Repo author** | Repository onboarding → Prompt guide → Cedar policies |
| **Contributor** | Developer guide → AGENTS.md at repo root |
| **Evaluator** | Introduction → Level 100 → Architecture vision |

## Troubleshooting

If something fails during setup or your first task, see [Troubleshooting](./TROUBLESHOOTING.md).
