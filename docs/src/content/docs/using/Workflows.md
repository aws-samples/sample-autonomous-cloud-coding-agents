---
title: Workflows
---

Every task runs a **workflow** — a named, versioned recipe that decides whether to clone a repo, which tools the agent may use, and how the result is delivered. You select one with `workflow_ref` (REST/webhook) or `--workflow` (CLI); the `--pr`/`--review-pr` flags select the coding PR workflows for you. If you specify nothing, the platform resolves a default (your repo's Blueprint default, or the conservative `default/agent-v1`). Workflows replace the old `task_type` field — see [Workflows](/architecture/workflows) for the full design and how to author your own.

The shipped workflows that cover the full lifecycle of a code change:

| Workflow | Description | Outcome |
|---|---|---|
| `coding/new-task-v1` | Create a new branch, implement changes, and open a new PR. | New pull request |
| `coding/pr-iteration-v1` | Check out an existing PR's branch, read review feedback, address it, and push updates. | Updated pull request |
| `coding/pr-review-v1` | Check out an existing PR's branch, analyze the changes read-only, and post a structured review. | Review comments on the PR |
| `knowledge/web-research-v1` | Research a question from the task description and attachments (no repo required), delivering a written result. | Research artifact |
| `default/agent-v1` | The conservative fallback when nothing else is selected: run the request through a read-leaning agent and deliver the result. No repo, build, or PR assumptions. | Artifact |

### When to use each coding workflow

**`coding/new-task-v1`** (the mapping target for the old `new_task`) - You have a feature request, bug report, or task description and want the agent to implement it from scratch. The agent creates a fresh branch, writes code, runs tests, and opens a new PR. Use this for greenfield work: adding features, fixing bugs, writing tests, refactoring, or updating documentation. Submitted via the CLI with `--issue`/`--task` and no PR flag.

**`coding/pr-iteration-v1`** (CLI `--pr`) - A reviewer left feedback on an existing PR and you want the agent to address it. The agent reads the review comments, makes targeted changes, and pushes to the same branch. Use this to accelerate the review-fix-push cycle without context-switching from your current work.

**`coding/pr-review-v1`** (CLI `--review-pr`) - You want a structured code review of an existing PR before a human reviewer looks at it. The agent reads the changes and posts review comments without modifying code. Use this as a first-pass review to catch issues early, especially for large PRs or when reviewers are busy.

### Combining coding workflows

The three coding workflows work together as a development loop:

```mermaid
flowchart LR
    A[coding/new-task-v1] --> B[PR opened]
    B --> C[coding/pr-review-v1]
    C --> D{Approved?}
    D -- No --> E[coding/pr-iteration-v1]
    E --> C
    D -- Yes --> F[Merge]
```

1. Submit a `coding/new-task-v1` task - the agent implements the change and opens a PR.
2. Submit a `coding/pr-review-v1` task on the new PR - the agent posts structured review comments.
3. Submit a `coding/pr-iteration-v1` task - the agent addresses the review feedback and pushes updates.
4. Repeat steps 2-3 until the PR is ready to merge.

You can automate this loop with webhooks: trigger `coding/pr-review-v1` automatically when a PR is opened, and `coding/pr-iteration-v1` when review comments are posted.