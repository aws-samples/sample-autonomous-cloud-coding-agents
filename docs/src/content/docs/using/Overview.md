---
title: "Overview"
---

ABCA is a platform that runs autonomous background coding agents on AWS. A task is a GitHub repository with a task description or an issue number. You submit a task, an agent works on it autonomously in an isolated environment, and the agent delivers a pull request when it is done. This guide covers how to submit coding tasks, how to monitor their progress, and how to use the platform well.

There are six ways to interact with the platform. You can use each one alone or combine them:

1. **CLI (recommended).** The `bgagent` CLI authenticates through Cognito and calls the Task API. It is best for individual developers who submit tasks from the terminal. It handles login, token caching, and output formatting.
2. **REST API (direct).** Call the Task API endpoints directly with a JWT token. It is best for custom integrations, dashboards, or internal tools that you build on the platform. The API provides full validation, audit logging, and idempotency support.
3. **Webhook.** External systems such as CI pipelines and GitHub Actions can create tasks with HMAC-authenticated HTTP requests. It is best for automated workflows in which an event triggers a task, for example when a new issue is labeled or a PR needs review. A webhook needs no Cognito credentials. It uses one shared secret per integration.
4. **Slack.** Submit tasks by @mentioning the bot, and receive threaded progress notifications with reaction-based status. See the [Slack setup guide](/sample-autonomous-cloud-coding-agents/using/slack-setup-guide).
5. **Linear.** Apply a label to a Linear issue to trigger a task. The platform posts progress comments and status reactions back on the issue as it works. The label has one variant. `bgagent` means do it, and `bgagent:help` means explain the labels. See [Trigger labels](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide#trigger-labels) in the Linear setup guide.
6. **Jira.** Add a label to a Jira Cloud issue to trigger a task. A dedicated Forge `bgagent` app posts comments and transitions through Jira REST v3, and the human who triggered the task remains the task owner. See the [Jira setup guide](/sample-autonomous-cloud-coding-agents/using/jira-setup-guide).

For example, a team might use the CLI for ad-hoc tasks and Slack for quick team-wide requests. The same team might use webhooks to trigger `coding/pr-review-v1` on every new PR through GitHub Actions, and Linear or Jira for tickets that are already in the project management tool. It might use the REST API to build a dashboard that tracks task status across repositories.