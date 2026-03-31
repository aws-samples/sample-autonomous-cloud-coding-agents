---
title: Overview
---

ABCA is a platform for running autonomous background coding agents on AWS. You submit a task (a GitHub repository + a task description or issue number), an agent works autonomously in an isolated environment, and delivers a pull request when done.

There are three ways to interact with the platform:

1. **CLI** (recommended) — The `bgagent` CLI authenticates via Cognito and calls the Task API. Handles login, token caching, and output formatting.
2. **REST API** (direct) — Call the Task API endpoints directly with a JWT token. Full validation, audit logging, and idempotency support.
3. **Webhook** — External systems (CI pipelines, GitHub Actions) can create tasks via HMAC-authenticated HTTP requests. No Cognito credentials needed; uses a shared secret per integration.