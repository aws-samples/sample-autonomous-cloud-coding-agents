---
name: abca-submit
description: Quick task submission shortcut — submit a coding task with guided prompts. Use when the user says "submit task", "run agent on", "submit to ABCA", or "quick submit".
argument-hint: <repo> [description]
allowed-tools:
  - Bash
  - Read
---

# Quick Task Submission

Submit a task to ABCA quickly. If arguments are missing, ask the user.

## Collect Required Info

If the repository is not provided, ask for the repository (owner/repo format).
If the description is not provided, ask what the agent should do.

## Determine Task Type

Parse the description to infer the type:
- If it looks like a PR number or mentions "review PR": use `--review-pr`
- If it mentions "iterate on PR" or "fix PR feedback": use `--pr`
- If it's an issue number (just a number): use `--issue`
- Otherwise: use `--task` with the text description

## Submit

```bash
cd cli && node lib/bin/bgagent.js submit \
  --repo $REPO \
  $FLAGS \
  --max-turns 100 \
  --wait
```

Show the task ID and status. If `--wait` is used, show the final outcome including PR URL if created.
