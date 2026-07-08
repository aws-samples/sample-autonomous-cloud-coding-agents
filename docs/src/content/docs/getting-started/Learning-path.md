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
| Auto-review every new PR | [Automated PR review tutorial](/sample-autonomous-cloud-coding-agents/architecture/automated-pr-review) | `coding/pr-review-v1` · webhook |
| Address review comments on an open PR | [Workflows](/sample-autonomous-cloud-coding-agents/using/workflows) + `bgagent submit --pr` | `coding/pr-iteration-v1` · CLI |
| Trigger tasks from Linear / Jira / Slack | [Linear](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide) · [Jira](/sample-autonomous-cloud-coding-agents/using/jira-setup-guide) · [Slack](/sample-autonomous-cloud-coding-agents/using/slack-setup-guide) | Channel-specific |
| Customize prompts or Cedar policy for a repo | [Repository onboarding](/sample-autonomous-cloud-coding-agents/customizing/repository-onboarding) | Blueprint |
| Run research without a GitHub repo | [Web research brief](/sample-autonomous-cloud-coding-agents/architecture/web-research-brief) | `knowledge/web-research-v1` |
| Understand how the platform works (no deploy yet) | [How the platform works](/sample-autonomous-cloud-coding-agents/concepts/how-the-platform-works) | — |
| Learn what “harness” and “blueprint” mean | [Agent harness](/sample-autonomous-cloud-coding-agents/architecture/agent-harness) · [Blueprint vs workflow](/sample-autonomous-cloud-coding-agents/architecture/blueprint-vs-workflow) | Concepts |
| Contribute to the platform | [Developer guide](/sample-autonomous-cloud-coding-agents/developer-guide/introduction) → [Contributing](/sample-autonomous-cloud-coding-agents/developer-guide/contributing) | — |

## Personas

| Persona | Typical first week |
|---------|-------------------|
| **Operator** | Quick Start → Deployment Guide → Cost Attribution |
| **Teammate** | Roles (in User Guide) → CLI → first task |
| **Repo author** | Repository onboarding → Prompt guide → Cedar policies |
| **Contributor** | Developer guide → AGENTS.md at repo root |
| **Evaluator** | Introduction → Level 100 → Architecture vision |

## Troubleshooting

If something fails during setup or your first task, see [Troubleshooting](/sample-autonomous-cloud-coding-agents/troubleshooting/troubleshooting).
