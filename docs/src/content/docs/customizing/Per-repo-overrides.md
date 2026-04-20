---
title: Per-repo overrides
---

Blueprints can configure per-repository settings that override platform defaults:

| Setting | Description | Default |
|---|---|---|
| `compute_type` | Compute strategy (`agentcore` or `ecs`) | `agentcore` |
| `runtime_arn` | AgentCore runtime ARN override | Platform default |
| `model_id` | Foundation model ID | Platform default |
| `max_turns` | Default turn limit for tasks | 100 |
| `max_budget_usd` | Default cost budget in USD per task | None (unlimited) |
| `system_prompt_overrides` | Additional system prompt instructions | None |
| `github_token_secret_arn` | Per-repo GitHub token (Secrets Manager ARN) | Platform default |
| `poll_interval_ms` | Poll interval for awaiting completion (5000–300000) | 30000 |

When you specify `--max-turns` (CLI) or `max_turns` (API) on a task, your value takes precedence over the Blueprint default. If neither is specified, the platform default (100) is used. The same override pattern applies to `--max-budget` / `max_budget_usd`, except there is no platform default  - if neither the task nor the Blueprint specifies a budget, no cost limit is applied.