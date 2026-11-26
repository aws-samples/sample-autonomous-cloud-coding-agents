---
title: "Workflows"
---

Every task runs a **workflow**. A workflow is a named, versioned definition that decides whether to clone a repo, which tools the agent may use, and how the result is delivered. You select a workflow with `workflow_ref` (REST or webhook) or `--workflow` (CLI). The `--pr` and `--review-pr` flags select the coding PR workflows for you. A REST or webhook request without `workflow_ref` falls back to the conservative `default/agent-v1`. `bgagent submit` with `--repo` and none of these flags sends `coding/new-task-v1`. Workflows replace the old `task_type` field. See [Workflows](/sample-autonomous-cloud-coding-agents/architecture/workflows) for the full design and for how to author your own.

These shipped workflows cover the full lifecycle of a code change:

| Workflow | Description | Outcome |
|---|---|---|
| `coding/new-task-v1` | Create a new branch, implement changes, and open a new PR. | New pull request |
| `coding/pr-iteration-v1` | Check out an existing PR's branch, read review feedback, address it, and push updates. | Updated pull request |
| `coding/pr-review-v1` | Check out an existing PR's branch, analyze the changes read-only, and post a structured review. | Review comments on the PR |
| `knowledge/web-research-v1` | Research a question from the task description and attachments, with no repo required, and deliver a written result. | Research artifact |
| `default/agent-v1` | The conservative fallback when nothing else is selected: run the request through a read-leaning agent and deliver the result. No repo, build, or PR assumptions. | Artifact |

### When to use each coding workflow

**`coding/new-task-v1`** (the mapping target for the old `new_task`). You have a feature request, a bug report, or a task description, and you want the agent to implement it. The agent creates a new branch, writes code, runs tests, and opens a new PR. Use this workflow for new work: adding features, fixing bugs, writing tests, refactoring, or updating documentation. Submit it from the CLI with `--issue` or `--task` and no PR flag.

**`coding/pr-iteration-v1`** (CLI `--pr`). A reviewer left feedback on an existing PR, and you want the agent to address it. The agent reads the review comments, makes targeted changes, and pushes to the same branch. Use this workflow to shorten the cycle of review, fix, and push without leaving your current work.

**`coding/pr-review-v1`** (CLI `--review-pr`). You want a structured code review of an existing PR before a human reviewer looks at it. The agent reads the changes and posts review comments without modifying code. Use this workflow as a first-pass review to catch issues early, especially for large PRs or when reviewers are busy.

### Combining coding workflows

The three coding workflows form a development loop:

```mermaid
flowchart LR
    A[coding/new-task-v1] --> B[PR opened]
    B --> C[coding/pr-review-v1]
    C --> D{Approved?}
    D -- No --> E[coding/pr-iteration-v1]
    E --> C
    D -- Yes --> F[Merge]
```

1. Submit a `coding/new-task-v1` task. The agent implements the change and opens a PR.
2. Submit a `coding/pr-review-v1` task on the new PR. The agent posts structured review comments.
3. Submit a `coding/pr-iteration-v1` task. The agent addresses the review feedback and pushes updates.
4. Repeat steps 2 and 3 until the PR is ready to merge.

You can automate this loop with webhooks. Trigger `coding/pr-review-v1` automatically when a PR is opened, and `coding/pr-iteration-v1` when review comments are posted.