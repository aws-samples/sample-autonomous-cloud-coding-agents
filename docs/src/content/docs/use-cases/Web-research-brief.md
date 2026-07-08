---
title: Web research brief
description: Run a repo-optional knowledge workflow and collect a structured brief.
diataxis: tutorial
---

# Web research brief

**Category:** Research  
**Persona:** Teammate or knowledge worker  
**Time:** ~15 min  
**Workflow:** `knowledge/web-research-v1`  
**Channel:** CLI

## What you'll achieve

A **background research task** that does not require a GitHub repository — demonstrating ABCA as a general agent platform, not only a coding bot.

**Success criteria:** Task `SUCCEEDED`; output artifact or summary available via task status / configured channel.

## Prerequisites

- Deployed stack and `bgagent configure` complete.
- Workflow `knowledge/web-research-v1` enabled on your deployment (default in sample).

## Steps

### 1. Submit a research task

```bash
bgagent submit \
  --workflow knowledge/web-research-v1 \
  --description "Summarize AWS Bedrock AgentCore pricing changes in the last quarter. Cite sources."
```

Note: no `--repo` flag — repo-optional workflow.

### 2. Monitor

```bash
bgagent watch TASK_ID
```

### 3. Retrieve outcome

```bash
bgagent status TASK_ID
```

Read the summary field or linked artifact per your stack configuration.

## What happens under the hood

Same orchestrator path as coding tasks; compute session runs without repo clone. See [Introduction](/sample-autonomous-cloud-coding-agents/introduction/introduction#beyond-coding) and [Task and workflow](/sample-autonomous-cloud-coding-agents/architecture/task-and-workflow).

## If something fails

| Symptom | Fix |
|---------|-----|
| Workflow not found | Confirm workflow catalog in deployment; check operator config |
| Guardrail block | Rephrase task; avoid disallowed content classes |
| Timeout | Increase limits in blueprint or shorten scope |

## Next steps

- [How the platform works](/sample-autonomous-cloud-coding-agents/concepts/how-the-platform-works)
- [Implement from issue](/sample-autonomous-cloud-coding-agents/architecture/implement-from-issue) — coding path
