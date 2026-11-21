---
title: "Task lifecycle"
---

When you create a task, the platform orchestrates it through these states:

```mermaid
flowchart LR
    S[SUBMITTED] --> H[HYDRATING]
    H --> R[RUNNING]
    R <--> A[AWAITING_APPROVAL]
    R --> C[COMPLETED]
    R --> F[FAILED]
    R --> X[CANCELLED]
    R --> T[TIMED_OUT]
    A --> X
    H --> F
    H --> X
    S --> F
    S --> X
    S <--> Q[QUEUED]
    Q --> F
    Q --> X
```

The orchestrator uses Lambda Durable Functions to manage the lifecycle durably - long-running tasks (up to 9 hours) survive transient failures and Lambda timeouts. The agent commits work regularly, so partial progress is never lost.

| Status | Meaning |
|---|---|
| `PENDING_UPLOADS` | Initial state while presigned attachment uploads are pending confirmation |
| `SUBMITTED` | Task accepted; orchestrator invoked asynchronously |
| `QUEUED` | You are at your concurrency limit; the task waits for a free slot and starts automatically. See [Concurrency limits](#concurrency-limits). |
| `HYDRATING` | Orchestrator passed admission control; assembling the agent payload |
| `RUNNING` | Agent session started and actively working on the task |
| `AWAITING_APPROVAL` | Agent paused at a Cedar HITL gate; waiting for your `approve` or `deny` decision. See [Approval gates](/sample-autonomous-cloud-coding-agents/using/approval-gates-cedar-hitl). |
| `FINALIZING` | Agent session ended; task is wrapping up (post-session hooks / PR finalization) before reaching a terminal state |
| `COMPLETED` | Agent finished and created a PR (or determined no changes were needed) |
| `FAILED` | Something went wrong - pre-flight check failed, guardrail blocked the content, the task stayed queued for more than 24 hours, or the agent encountered an error |
| `CANCELLED` | Task was cancelled by the user |
| `TIMED_OUT` | Task exceeded the maximum allowed duration (~8 hours, the AgentCore max session duration; the orchestrator safety-net timer is slightly longer) |

Terminal states: `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`. `AWAITING_APPROVAL` is not terminal — a decision (or an approval-timeout) always flips it back to `RUNNING` or onto a terminal state.

Task records in terminal states are automatically deleted after 90 days (configurable via `taskRetentionDays`).

### Concurrency limits

Each user can run up to 10 tasks concurrently. If you exceed the limit, the task is queued (`QUEUED`) instead of failing: it starts automatically, oldest first, as your active tasks finish or are cancelled, and fails only if it is still queued 24 hours after submission. A task with an uploaded file attachment (a file over 500 KB, or a smaller one once 3 MB are sent inline) is checked when you confirm its uploads: if your slots are all in use at that moment, the confirmation is refused with `429 RATE_LIMIT_EXCEEDED`. Through the API, confirm again once a slot is free, within 30 minutes of submitting; after that the unconfirmed task is cancelled. `bgagent submit` does not retry the confirmation: submit the task again.

There is no system-wide cap - the theoretical maximum is `number_of_users * per_user_limit`. The hard ceiling is the AgentCore concurrent sessions quota for your AWS account (check the [AWS Service Quotas console](https://console.aws.amazon.com/servicequotas/) for Bedrock AgentCore in your region).

### Task events

Each lifecycle transition is recorded as an audit event. Query them with:

```bash
curl "$API_URL/tasks/<TASK_ID>/events" -H "Authorization: $TOKEN"
```

Available events:

- **Lifecycle** - `task_created`, `session_started`, `task_completed`, `task_failed`, `task_cancelled`, `task_timed_out`
- **Orchestration** - `admission_queued`, `queue_pickup`, `hydration_started`, `hydration_complete`
- **Checks** - `preflight_failed`, `guardrail_blocked`
- **Interactive** - `nudge_acknowledged`, `agent_milestone`
- **Approvals (Cedar HITL)** - `approval_requested`, `approval_recorded`, `approval_timed_out`
- **Output** - `pr_created`, `pr_updated`

**Error classifiers** on terminal failure events provide a specific reason:

| Classifier | Meaning |
|---|---|
| `error_max_turns` | Agent exhausted its turn limit without completing |
| `error_max_budget_usd` | Agent hit the cost budget ceiling |
| `error_during_execution` | Agent encountered a runtime error during execution |

Event records follow the same 90-day retention as task records.

### Troubleshooting preflight failures

If a task fails with a `preflight_failed` event, the platform rejected the run before the agent started - no compute was consumed. Check the event's `reason` field to understand what went wrong:

- `GITHUB_UNREACHABLE` - The platform could not reach the GitHub API. Check network connectivity and GitHub status.
- `REPO_NOT_FOUND_OR_NO_ACCESS` - The GitHub PAT does not have access to the target repository, or the repo does not exist.
- `INSUFFICIENT_GITHUB_REPO_PERMISSIONS` - The PAT lacks the required permissions for the workflow. For `coding/new-task-v1` and `coding/pr-iteration-v1`, you need Contents (read/write) and Pull requests (read/write). For `coding/pr-review-v1`, Triage or higher is enough.
- `PR_NOT_FOUND_OR_CLOSED` - The specified PR does not exist or is already closed.
- `PR_FROM_FORK` - The specified PR comes from a fork. The agent works on branches of the onboarded repository, and the branch of this PR is in the fork. Push the branch to the repository itself, open the PR from there, and submit the task for that PR.

To fix permission issues, update the GitHub PAT in AWS Secrets Manager and submit a new task. See [Developer guide - Repository preparation](/sample-autonomous-cloud-coding-agents/developer-guide/repository-preparation) for the full permissions table.

### Viewing logs

The application logs are in the CloudWatch log group:

```
/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/jean_cloude
```

Filter by task ID to find logs for a specific task.

### Notifications (GitHub edit-in-place)

When a task targets a pull request (`coding/pr-iteration-v1` or `coding/pr-review-v1`) or was submitted for a GitHub issue (`--issue`, or `issue_number` through the API), the platform automatically posts a status comment on that pull request or issue and edits it in place as the task progresses. This gives collaborators visibility into the agent's work without polling the CLI or API.

The notification plane uses DynamoDB Streams to fan out task events to channel-specific dispatchers: this GitHub comment for every task with a pull request or issue target, and the Slack, Linear and Jira notifications for tasks that came from those channels. Email notifications are not sent yet.

The status comment shows the task ID, the repository, the status, the last event and, once the agent has opened one, a link to the pull request. A task that the agent finished itself, successfully or not, also shows the duration and the cost of the run. A task that was cancelled or timed out shows neither: the agent records both when it ends the run itself. The comment is posted or updated when the agent opens the pull request and when the task ends, whether it completed, failed, was cancelled or timed out.

### Preview-deploy screenshots (optional)

If your repo is wired to a deploy provider that publishes GitHub `deployment_status` events (Vercel, Amplify Hosting, Netlify, GitHub Actions custom CD, etc.), ABCA can capture a full-page screenshot of each preview URL and post it as an image comment on the open PR — and on the linked Linear issue if Linear is configured.

This runs independently of the agent: there's no LLM involved, just a Lambda that drives a headless browser via AgentCore Browser. End-to-end latency is typically 10–15 seconds after the deploy provider reports success.

Setup is opt-in and per-repo. See the [Deploy preview screenshots guide](/sample-autonomous-cloud-coding-agents/using/deploy-preview-screenshots-guide) for the wiring (one webhook on the repo, one secret pasted into AWS).