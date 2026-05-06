---
name: status
description: Check ABCA platform status — stack health, running tasks, and recent task history. Use when the user says "status", "health check", "is ABCA running", "check platform", or "what's the state".
allowed-tools:
  - Bash
  - Read
---

# ABCA Platform Status

Check the current state of the ABCA platform and report a concise status summary.

## Checks to Run

Run these in parallel where possible:

1. **Stack status:**
   ```bash
   aws cloudformation describe-stacks --stack-name backgroundagent-dev \
     --query 'Stacks[0].{Status:StackStatus,Updated:LastUpdatedTime}' --output json 2>&1 || echo "Stack not found"
   ```

2. **Running tasks:**
   ```bash
   node cli/lib/bin/bgagent.js list --status RUNNING,SUBMITTED,HYDRATING --output json 2>&1 || echo "CLI not configured"
   ```

3. **Recent completed tasks:**
   ```bash
   node cli/lib/bin/bgagent.js list --limit 5 --output json 2>&1 || echo "CLI not configured"
   ```

4. **Local build health:**
   ```bash
   export MISE_EXPERIMENTAL=1 && mise run //cdk:compile 2>&1 | tail -5
   ```

## Output Format

Present a concise status report:

```
ABCA Platform Status
====================
Stack:    [UPDATE_COMPLETE | CREATE_COMPLETE | ...]
Updated:  [timestamp]
Active:   [N] tasks running
Recent:   [N] tasks in last batch (show status breakdown)
Build:    [PASS | FAIL with error summary]
```

If the CLI isn't configured, note this and suggest running the `setup` skill.

**Tip:** For real-time streaming of a specific task's progress, suggest `bgagent watch <TASK_ID>` instead of polling status.
