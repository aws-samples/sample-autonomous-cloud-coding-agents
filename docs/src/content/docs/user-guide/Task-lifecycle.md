---
title: Task lifecycle
---

When you create a task via the REST API, the platform automatically orchestrates it through these states:

```
SUBMITTED ──> HYDRATING ──> RUNNING ──> COMPLETED
    │              │           │
    │              │           └──> FAILED / CANCELLED / TIMED_OUT
    │              └──> FAILED / CANCELLED
    └──> FAILED / CANCELLED
```

The orchestrator uses Lambda Durable Functions to manage the lifecycle durably — long-running tasks (up to 9 hours) survive transient failures and Lambda timeouts. The agent commits work regularly, so partial progress is never lost.

| Status | Meaning |
|---|---|
| `SUBMITTED` | Task accepted; orchestrator invoked asynchronously |
| `HYDRATING` | Orchestrator passed admission control; assembling the agent payload |
| `RUNNING` | Agent session started and actively working on the task |
| `COMPLETED` | Agent finished and created a PR (or determined no changes were needed) |
| `FAILED` | Agent encountered an error, user concurrency limit was reached, content was blocked by guardrail screening, or **pre-flight** checks failed before the agent started (for example insufficient GitHub credentials — PAT or OAuth token) |
| `CANCELLED` | Task was cancelled by the user |
| `TIMED_OUT` | Task exceeded the maximum allowed duration (~9 hours) |

Terminal states: `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`.

**Data retention:** Task records in terminal states are automatically deleted from DynamoDB after 90 days (configurable via `taskRetentionDays`). Querying a task after this period returns a `404`. Active tasks are not affected.

### Concurrency limits

Each user can have up to **3 tasks running concurrently** by default (configurable via the `maxConcurrentTasksPerUser` prop on the `TaskOrchestrator` CDK construct). If you exceed the limit, the task transitions to `FAILED` with a concurrency limit message. Wait for an active task to complete, or cancel one, then retry.

There is currently no system-wide concurrency cap — the theoretical maximum across all users is `number_of_users * per_user_limit`. The hard ceiling is the AgentCore concurrent sessions quota for your AWS account, which is an account-level service limit. Check the [AWS Service Quotas console](https://console.aws.amazon.com/servicequotas/) for Bedrock AgentCore in your region to see the current value. The `InvokeAgentRuntime` API is also rate-limited to 25 TPS per agent per account (adjustable via Service Quotas).

### Task events

Each lifecycle transition is recorded as an audit event. Use the events endpoint to see the full history:

```bash
curl "$API_URL/tasks/<TASK_ID>/events" -H "Authorization: $TOKEN"
```

Events include: `task_created`, `admission_rejected`, `preflight_failed`, `hydration_started`, `hydration_complete`, `guardrail_blocked`, `session_started`, `pr_created`, `pr_updated`, `task_completed`, `task_failed`, `task_cancelled`, `task_timed_out`. Event records are subject to the same 90-day retention as task records and are automatically deleted after that period.

**`preflight_failed`:** The orchestrator could not safely start work (GitHub API checks run **before** hydration and AgentCore). Open the event in `bgagent events <TASK_ID>` (or the JSON from `GET /tasks/{id}/events`) and read **`reason`** and **`detail`**. Typical values for **`reason`** include `GITHUB_UNREACHABLE`, `REPO_NOT_FOUND_OR_NO_ACCESS`, `INSUFFICIENT_GITHUB_REPO_PERMISSIONS`, and `PR_NOT_FOUND_OR_CLOSED`. The most common fix for **`INSUFFICIENT_GITHUB_REPO_PERMISSIONS`** depends on your credential path: for **PAT**, update the GitHub PAT in AWS Secrets Manager so it matches your task type — for **`new_task`** / **`pr_iteration`** you need **Contents** read/write and **Pull requests** read/write on the target repo; **`pr_review`** can pass with **Triage** (or higher) when you do not need to push. For **Token Vault**, verify the GitHub App is installed on the target repo (GitHub → **Settings** → **Developer settings** → **GitHub Apps** → your app → **Install App**) and the callback URL is registered. See [Developer guide — Repository preparation](/developer-guide/repository-preparation) for the full table and setup steps.