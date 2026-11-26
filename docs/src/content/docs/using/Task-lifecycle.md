---
title: "Task lifecycle"
---

When you create a task, the platform moves it through these states:

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

The orchestrator uses Lambda Durable Functions to manage the lifecycle durably. Long-running tasks (up to 9 hours) survive transient failures and Lambda timeouts. The agent commits work regularly, so partial progress is never lost.

| Status | Meaning |
|---|---|
| `PENDING_UPLOADS` | Initial state while presigned attachment uploads are pending confirmation |
| `SUBMITTED` | Task accepted. Orchestrator invoked asynchronously |
| `QUEUED` | You are at your concurrency limit. The task waits for a free slot and starts automatically. See [Concurrency limits](#concurrency-limits). |
| `HYDRATING` | Orchestrator passed admission control and is assembling the agent payload |
| `RUNNING` | Agent session started and actively working on the task |
| `AWAITING_APPROVAL` | Agent paused at a Cedar HITL gate and is waiting for your `approve` or `deny` decision. See [Approval gates](/sample-autonomous-cloud-coding-agents/using/approval-gates-cedar-hitl). |
| `FINALIZING` | Agent session ended. Task is finishing (post-session hooks / PR finalization) before it reaches a terminal state |
| `COMPLETED` | Agent finished and the task succeeded. Depending on the [workflow](/sample-autonomous-cloud-coding-agents/using/workflows), the result is a new pull request, an update or a review of an existing one, an artifact, or an answer or a question from the agent with no change to the code |
| `FAILED` | A pre-flight check failed, a guardrail blocked the content, the task stayed queued for more than 24 hours, or the agent encountered an error |
| `CANCELLED` | Task was cancelled by the user |
| `TIMED_OUT` | Task exceeded the maximum allowed duration of about 8 hours, the AgentCore max session duration. The orchestrator safety-net timer is slightly longer |

A task that is expected to open a new pull request ends as `FAILED`, not `COMPLETED`, when its agent reports success but leaves no commit on the task's branch, no pull request and no question. The platform expects a new pull request from every `coding/new-task-v1` task, and from a `default/agent-v1` or `knowledge/web-research-v1` task whose request names a repository. The agent of the last two is told to answer in its final message, so such a task ends this way each time the agent changes no file.

The error is "No change was delivered" (`deliverable=lost` in the `error_message`). Either the agent made no change, for example because the repository already had what you asked for, or its changes were lost before they reached the branch. The platform cannot tell which. Check the repository before you retry. If it has what you asked for, a retry ends the same way. [#751](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/751) tracks a way for the agent to report that no change was needed.

The terminal states are `COMPLETED`, `FAILED`, `CANCELLED`, and `TIMED_OUT`. `AWAITING_APPROVAL` is not terminal. A decision or an approval timeout always moves the task back to `RUNNING` or on to a terminal state.

Task records in terminal states are automatically deleted after 90 days (configurable with `taskRetentionDays`).

### Concurrency limits

Each user can run up to 10 tasks concurrently. If you exceed the limit, the task is queued (`QUEUED`) instead of failing. A queued task starts automatically, oldest first, as your active tasks finish or are cancelled. It fails only if it is still queued 24 hours after submission. A task with an uploaded file attachment (a file over 500 KB, or a smaller one once 3 MB are sent inline) is checked when you confirm its uploads. If your slots are all in use at that moment, the confirmation is refused with `429 RATE_LIMIT_EXCEEDED`. Through the API, confirm again once a slot is free, within 30 minutes of submitting. After that, the unconfirmed task is cancelled. `bgagent submit` does not retry the confirmation, so submit the task again.

There is no system-wide cap. The theoretical maximum is `number_of_users * per_user_limit`. The hard limit is the AgentCore concurrent sessions quota for your AWS account. Check the [AWS Service Quotas console](https://console.aws.amazon.com/servicequotas/) for Bedrock AgentCore in your region.

### Task events

Each lifecycle transition is recorded as an audit event. Query the events with:

```bash
curl "$API_URL/tasks/<TASK_ID>/events" -H "Authorization: $TOKEN"
```

Available events:

- **Lifecycle.** `task_created`, `session_started`, `task_completed`, `task_failed`, `task_cancelled`, `task_timed_out`.
- **Orchestration.** `admission_queued`, `queue_pickup`, `hydration_started`, `hydration_complete`.
- **Checks.** `preflight_failed`, `guardrail_blocked`.
- **Interactive.** `nudge_acknowledged`, `agent_milestone`.
- **Approvals (Cedar HITL).** `approval_decision_recorded`, written when a request is approved or denied, and milestones of `agent_milestone`, among them `approval_requested`, `approval_granted`, `approval_denied`, `approval_timed_out` and `approval_stranded`.
- **Output.** `pr_created`, `pr_updated`.
- **After the task.** `pr_outcome_recorded` means that ABCA read on GitHub that the pull request the task opened was merged or closed. That can be days after the task finished. ABCA reads about once an hour, and the event comes with the read that records it.

**Error classifiers** on terminal failure events provide a specific reason:

| Classifier | Meaning |
|---|---|
| `error_max_turns` | Agent exhausted its turn limit without completing |
| `error_max_budget_usd` | Agent hit the cost budget ceiling |
| `error_during_execution` | Agent encountered a runtime error during execution |

Event records follow the same 90-day retention as task records.

### Troubleshooting preflight failures

If a task fails with a `preflight_failed` event, the platform rejected the run before the agent started, and no compute was consumed. Check the event's `reason` field for the cause:

- `GITHUB_UNREACHABLE`. The platform could not reach the GitHub API. Check network connectivity and GitHub status.
- `REPO_NOT_FOUND_OR_NO_ACCESS`. The GitHub PAT does not have access to the target repository, or the repo does not exist.
- `INSUFFICIENT_GITHUB_REPO_PERMISSIONS`. The PAT lacks the required permissions for the workflow. For `coding/new-task-v1` and `coding/pr-iteration-v1`, you need Contents (read and write) and Pull requests (read and write). For `coding/pr-review-v1`, Triage or higher is enough.
- `PR_NOT_FOUND_OR_CLOSED`. The specified PR does not exist or is already closed.
- `PR_FROM_FORK`. The specified PR comes from a fork. The agent works on branches of the onboarded repository, and the branch of this PR is in the fork. Push the branch to the repository itself, open the PR from there, and submit the task for that PR.

To fix permission issues, update the GitHub PAT in AWS Secrets Manager and submit a new task. See [Repository preparation](/sample-autonomous-cloud-coding-agents/developer-guide/repository-preparation) in the Developer guide for the full permissions table.

### Viewing logs

The application logs are in the CloudWatch log group:

```
/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/jean_cloude
```

Filter by task ID to find logs for a specific task.

### Notifications (GitHub edit-in-place)

When a task targets a pull request (`coding/pr-iteration-v1` or `coding/pr-review-v1`) or was submitted for a GitHub issue (`--issue`, or `issue_number` through the API), the platform automatically posts a status comment on that pull request or issue and edits the comment in place as the task progresses. Collaborators can follow the agent's work in the comment without polling the CLI or API.

The notification plane uses DynamoDB Streams to fan out task events to channel-specific dispatchers: this GitHub comment for every task with a pull request or issue target, and the Slack, Linear and Jira notifications for tasks that came from those channels. Email notifications are not sent yet.

The status comment shows the task ID, the repository, the status, the last event and, once the agent has opened one, a link to the pull request. A task that the agent finished itself, successfully or not, also shows the duration and the cost of the run. A task that was cancelled or timed out shows neither. The agent records both when it ends the run itself. The comment is posted or updated when the agent opens the pull request and when the task ends, whether it completed, failed, was cancelled or timed out.

### Preview-deploy screenshots (optional)

If your repo is connected to a deploy provider that publishes GitHub `deployment_status` events, such as Vercel, Amplify Hosting, Netlify, or GitHub Actions custom CD, ABCA can capture a full-page screenshot of each preview URL and post it as an image comment on the open PR. If Linear is configured, ABCA also posts it on the linked Linear issue.

The capture runs independently of the agent. No LLM is involved. A Lambda drives a headless browser through AgentCore Browser. End-to-end latency is typically 10 to 15 seconds after the deploy provider reports success.

Setup is opt-in and per repo. See the [Deploy preview screenshots guide](/sample-autonomous-cloud-coding-agents/using/deploy-preview-screenshots-guide) for the setup steps (one webhook on the repo and one secret pasted into AWS).