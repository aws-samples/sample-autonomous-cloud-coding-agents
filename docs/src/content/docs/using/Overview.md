---
title: Overview
---

ABCA is a platform for running autonomous background coding agents on AWS. You submit a task (a GitHub repository + a task description or issue number), an agent works autonomously in an isolated environment, and delivers a pull request when done. This guide covers how to submit coding tasks, monitor their progress, and get the most out of the platform.

There are six ways to interact with the platform. You can use them independently or combine them for different workflows:

1. **CLI** (recommended) - The `bgagent` CLI authenticates via Cognito and calls the Task API. Best for individual developers submitting tasks from the terminal. Handles login, token caching, and output formatting.
2. **REST API** (direct) - Call the Task API endpoints directly with a JWT token. Best for building custom integrations, dashboards, or internal tools on top of the platform. Full validation, audit logging, and idempotency support.
3. **Webhook** - External systems (CI pipelines, GitHub Actions) can create tasks via HMAC-authenticated HTTP requests. Best for automated workflows where tasks should be triggered by events (e.g., a new issue is labeled, a PR needs review). No Cognito credentials needed; uses a shared secret per integration.
4. **Slack** - Submit tasks by @mentioning the bot and receive threaded progress notifications with reaction-based status. See the [Slack setup guide](/using/slack-setup-guide).
5. **Linear** - Apply a label to a Linear issue to trigger a task; the agent posts progress comments back on the issue via Linear's MCP server. See the [Linear setup guide](/using/linear-setup-guide).
6. **Jira** - Add a label to a Jira Cloud issue to trigger a task; the agent posts progress comments back on the issue via the Jira REST v3 API. See the [Jira setup guide](/using/jira-setup-guide).

For example, a team might use the **CLI** for ad-hoc tasks, **webhooks** to auto-trigger `coding/pr-review-v1` on every new PR via GitHub Actions, **Slack** for quick team-wide requests, **Linear** or **Jira** for tickets that already live in the PM tool, and the **REST API** to build a dashboard that tracks task status across repositories.