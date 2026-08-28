---
title: Per-repo overrides
---

Blueprints can configure per-repository settings that override platform defaults. For how `model_id` is layered against the platform default, per-task overrides, and the IAM invoke allowlist — plus the cost tradeoffs of picking a different model — see [Model configuration](/sample-autonomous-cloud-coding-agents/developer-guide/model-configuration).

| Setting | Description | Default |
|---|---|---|
| `compute_type` | Compute strategy (`agentcore`, `ecs`, or `lambda-microvm`) | `agentcore` |
| `runtime_arn` | AgentCore runtime ARN override | Platform default |
| `model_id` | Bedrock inference-profile ID (geo-prefixed, matching the deployment's `bedrockGeoRegion`) | `global.anthropic.claude-opus-5` |
| `max_turns` | Default turn limit for tasks | 100 |
| `max_budget_usd` | Default cost budget in USD per task, `0.01`–`100` (Blueprint `agent.maxBudgetUsd`) | None (unlimited) |
| `system_prompt_overrides` | Additional system prompt instructions | None |
| `github_token_secret_arn` | Per-repo GitHub token (Secrets Manager ARN) | Platform default |
| `poll_interval_ms` | Poll interval for awaiting completion (5000–300000) | 30000 |

> `lambda-microvm` is **experimental** and requires operator setup (a re-bootstrap to policy bundle ≥ 1.6.0 and a supported Region) before a repo can select it. Keep production repos on `agentcore` or `ecs` — see the [Deployment guide](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#lambda-microvms-backend-experimental).

When you specify `--max-turns` (CLI) or `max_turns` (API) on a task, your value takes precedence over the Blueprint default. If neither is specified, the platform default (100) is used. The same override pattern applies to `--max-budget` / `max_budget_usd`, except there is no platform default  - if neither the task nor the Blueprint specifies a budget, no cost limit is applied.

### Where can I set `max_budget_usd`?

Every place a cost budget can come from, and nowhere else:

| Surface | How | Scope | Notes |
|---|---|---|---|
| Per task, CLI | `bgagent submit --max-budget <dollars>` | One task | Range `0.01`–`100`; rejected client-side before the request is sent |
| Per task, REST | `max_budget_usd` in the `POST /v1/tasks` body | One task | Same `0.01`–`100` range, validated server-side |
| Per repo, Blueprint | `agent.maxBudgetUsd` on the repo's `Blueprint` construct | Every task on that repo | Persisted to `RepoTable.max_budget_usd`; same `0.01`–`100` range, enforced at CDK synth so an out-of-range value cannot deploy |
| Local batch runs | `MAX_BUDGET_USD` shell env | One local run | **Local `entrypoint.py` batch mode only.** The deployed AgentCore **server** mode ignores this variable — it reads the budget from the `/invocations` request body, so setting it on the runtime has no effect |
| Platform-wide default | — | — | **None exists.** Unset means unlimited (see below) |

The two that apply to a deployed task resolve in this order: **per-task value wins, then the repo's Blueprint default, then no budget at all.** A mid-task Blueprint edit does not move a running task's budget.

Administrators set the Blueprint default in the CDK stack:

```typescript
new Blueprint(this, 'MyRepo', {
  repo: 'my-org/my-repo',
  repoTable,
  agent: { maxBudgetUsd: 5.0 },  // every task on this repo caps at $5 unless overridden
});
```

Run `bgagent repo show <owner/repo>` to see which value is in effect; the `max_budget_usd` line reads `(per-blueprint override)` when the repo pins one and `(platform default) unlimited` when it does not.

### Unlimited by default is deliberate

There is intentionally no platform-wide budget ceiling. A hard global cap would kill long-running tasks mid-change — the failure mode is a half-finished branch and no PR, which is worse than a task that costs more than expected. The intended controls are the per-repo Blueprint default above (opt in where you want a ceiling), the per-task flag, and `max_turns`.

The documented escape hatch for cost is **choosing a lighter-token model** rather than relying on a cap:

- **Per repo:** Blueprint `agent.modelId` — no code change and no agent redeploy
- **Per task:** `model_id` in the task payload

The model you pick must be in the platform's Bedrock IAM grant list, or the task fails at turn 0 with `AccessDenied` — the grant is the gate, so a lighter model is only reachable if it has been granted. For how the model layers resolve, the grant list, and the measured cost comparison, see [Model configuration](/sample-autonomous-cloud-coding-agents/developer-guide/model-configuration).

Note that the reported `cost_usd` is a client-side estimate, not authoritative billing — see [Cost attribution](/sample-autonomous-cloud-coding-agents/getting-started/cost-attribution).