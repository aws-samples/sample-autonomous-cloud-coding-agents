---
title: Repository onboarding
---

Before submitting tasks against a repository, the repository must be **onboarded** to the platform. Onboarding is managed by the platform administrator through CDK — each repository is registered as a `Blueprint` construct in the CDK stack, which writes a configuration record to the `RepoTable` DynamoDB table.

If you submit a task against a repository that has not been onboarded, the API returns a `422` error with code `REPO_NOT_ONBOARDED`:

```json
{
  "error": {
    "code": "REPO_NOT_ONBOARDED",
    "message": "Repository 'owner/repo' is not onboarded. Register it with a Blueprint before submitting tasks."
  }
}
```

Contact your platform administrator to onboard a new repository. For details on how administrators register repositories, see the [Developer guide](/developer-guide/introduction#repository-onboarding).

### Per-repo configuration

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

When you specify `--max-turns` (CLI) or `max_turns` (API) on a task, your value takes precedence over the Blueprint default. If neither is specified, the platform default (100) is used. The same override pattern applies to `--max-budget` / `max_budget_usd`, except there is no platform default — if neither the task nor the Blueprint specifies a budget, no cost limit is applied.