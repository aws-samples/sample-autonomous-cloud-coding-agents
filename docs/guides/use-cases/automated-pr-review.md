---
title: Automated PR review
description: Trigger background PR review when pull requests open.
diataxis: tutorial
---

# Automated PR review

**Category:** Review  
**Persona:** Operator or repo author  
**Time:** ~20 min  
**Workflow:** `coding/pr-review-v1`  
**Channel:** Webhook (GitHub Actions or repository webhook)

## What you'll achieve

Every new or updated pull request triggers a **read-only** agent run that posts structured review comments on the PR.

**Success criteria:** Opening a test PR creates a task; agent comments appear on the PR within the workflow timeout.

## Prerequisites

- Deployed ABCA stack and onboarded target repository.
- [Webhook integration](../USER_GUIDE.md#webhook-integration) credentials (HMAC secret from stack).
- Permission to add a GitHub webhook or Actions workflow to the repo.

## Steps

### 1. Confirm workflow is available

```bash
bgagent workflows list
```

Expected: `coding/pr-review-v1` appears for your repo or org defaults.

### 2. Configure GitHub to call ABCA

Follow [Webhook integration](../USER_GUIDE.md#webhook-integration) to send `pull_request` events to your API Gateway URL with a valid signature.

For GitHub Actions, use the pattern in the user guide to POST a signed payload on `pull_request: opened` and `synchronize`.

### 3. Open a test PR

Create a small PR in the onboarded repo.

### 4. Verify task and comments

```bash
bgagent tasks list --repo YOUR_ORG/YOUR_REPO --limit 5
```

Expected: New task with review workflow; PR shows agent comments.

## What happens under the hood

The orchestrator admits the webhook, resolves `coding/pr-review-v1`, and runs the agent without write access to the default branch. See [Blueprint vs workflow](../concepts/level-100/blueprint-vs-workflow.md).

## If something fails

| Symptom | Fix |
|---------|-----|
| Webhook 401 | [Troubleshooting — webhook signatures](../TROUBLESHOOTING.md#webhook-signature-failures) |
| No task created | Verify event type and repo match blueprint |
| Empty review | Check agent logs via operator dashboard |

## Next steps

- [Cedar policies](../CEDAR_POLICY_GUIDE.md) — gate risky tools during review runs
- [Implement from issue](./implement-from-issue.md) — coding workflow pairing
