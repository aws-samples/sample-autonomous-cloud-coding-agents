---
title: Implement from a GitHub issue
description: Onboard a repo and submit a coding task that produces a pull request.
diataxis: tutorial
---

# Implement from a GitHub issue

**Category:** Coding  
**Persona:** Teammate  
**Time:** ~30 min (includes first-time deploy if needed)  
**Workflow:** `coding/new-task-v1`  
**Channel:** CLI

## What you'll achieve

A pull request opened by an autonomous agent from a task description (and optional linked issue), running in an isolated MicroVM in your AWS account.

**Success criteria:** Task reaches `SUCCEEDED`; PR URL appears in `bgagent status` and on the task record.

## Prerequisites

- Completed [Quick Start](../QUICK_START.mdx) through repo onboarding — you need a deployed stack and onboarded repository.
- `bgagent configure` finished (valid JWT).
- Run commands from your workstation (not inside the agent runtime).

## Steps

### 1. Pick an issue or write a task description

Use a small, testable change (docs fix, isolated bug). Copy the issue body or write a short spec.

### 2. Submit the task

```bash
bgagent submit \
  --repo YOUR_ORG/YOUR_REPO \
  --workflow coding/new-task-v1 \
  --description "Fix the typo in README noted in issue #42"
```

Expected: CLI prints a **task ID** and initial status `QUEUED` or `RUNNING`.

### 3. Watch progress (optional)

```bash
bgagent watch TASK_ID
```

Expected: Progress events until terminal state.

### 4. Review the PR

```bash
bgagent status TASK_ID
```

Open the `pullRequestUrl` from the output. Review diff like any teammate-authored PR.

## What happens under the hood

See [Task and workflow](../concepts/level-100/task-and-workflow.md) and [Orchestrator and agent](../concepts/level-100/orchestrator-and-agent.md). Platform steps: admission → hydration → pre-flight → agent execution → finalization ([Architecture](../../design/ARCHITECTURE.md)).

## If something fails

| Symptom | Fix |
|---------|-----|
| `REPO_NOT_FOUND_OR_NO_ACCESS` | [Troubleshooting — GitHub PAT](../TROUBLESHOOTING.md#repo_not_found_or_no_access--github-pat) |
| Task `FAILED` with guardrail message | Narrow task scope; check Cedar and prompt |
| No PR but `SUCCEEDED` | Read `status` details; agent may have determined no change needed |

## Next steps

- [Automated PR review](./automated-pr-review.md)
- [Iterate on review feedback](../USER_GUIDE.md#workflows) with `coding/pr-iteration-v1`
