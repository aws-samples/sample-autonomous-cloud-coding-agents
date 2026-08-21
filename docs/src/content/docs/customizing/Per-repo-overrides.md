---
title: Per-repo overrides
---

Blueprints can configure per-repository settings that override platform defaults. For how `model_id` is layered against the platform default, per-task overrides, and the IAM invoke allowlist — plus the cost tradeoffs of picking a different model — see [Model configuration](/sample-autonomous-cloud-coding-agents/developer-guide/model-configuration).

| Setting | Description | Default |
|---|---|---|
| `compute_type` | Compute strategy (`agentcore` or `ecs`) | `agentcore` |
| `runtime_arn` | AgentCore runtime ARN override | Platform default |
| `model_id` | Bedrock inference-profile ID (`us.`-prefixed) | `us.anthropic.claude-opus-4-8` |
| `max_turns` | Default turn limit for tasks | 100 |
| `max_budget_usd` | Default cost budget in USD per task, `0.01`–`100` (Blueprint `agent.maxBudgetUsd`) | None (unlimited) |
| `system_prompt_overrides` | Additional system prompt instructions | None |
| `github_token_secret_arn` | Per-repo GitHub token (Secrets Manager ARN) | Platform default |
| `poll_interval_ms` | Poll interval for awaiting completion (5000–300000) | 30000 |

When you specify `--max-turns` (CLI) or `max_turns` (API) on a task, your value takes precedence over the Blueprint default. If neither is specified, the platform default (100) is used. The same override pattern applies to `--max-budget` / `max_budget_usd`, except there is no platform default  - if neither the task nor the Blueprint specifies a budget, no cost limit is applied.

### Where can I set `max_budget_usd`?

Every place a per-task runtime budget can come from:

| Surface | How | Scope | Notes |
|---|---|---|---|
| Per task, CLI | `bgagent submit --max-budget <dollars>` | One task | Range `0.01`–`100`; rejected client-side before the request is sent |
| Per task, REST | `max_budget_usd` in the `POST /v1/tasks` body | One task | Same `0.01`–`100` range, validated server-side |
| Per repo, Blueprint | `agent.maxBudgetUsd` on the repo's `Blueprint` construct | Every task on that repo | Persisted to `RepoTable.max_budget_usd`; same `0.01`–`100` range, enforced at CDK synth so an out-of-range value cannot deploy |
| Local batch runs | `MAX_BUDGET_USD` shell env | One local run | **Local `entrypoint.py` batch mode only.** The deployed AgentCore **server** mode ignores this variable — it reads the budget from the `/invocations` request body, so setting it on the runtime has no effect |
| Platform-wide per-task default | — | — | **None exists.** Unset means unlimited (see below) |

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

### Per-task budgets are unlimited by default

There is intentionally no platform-wide **per-task runtime** ceiling. A hard runtime cap kills a long-running task mid-change — the failure mode is a half-finished branch and no PR. The intended runtime controls are the per-repo Blueprint default above, the per-task flag, and `max_turns`. Administrators can separately configure monthly user/team admission budgets below; those reject new work instead of interrupting work already in progress.

The documented escape hatch for cost is **choosing a lighter-token model** rather than relying on a cap:

- **Per repo:** Blueprint `agent.modelId` — no code change and no agent redeploy
- **Per task:** `model_id` in the task payload

The model you pick must be in the platform's Bedrock IAM grant list, or the task fails at turn 0 with `AccessDenied` — the grant is the gate, so a lighter model is only reachable if it has been granted. For how the model layers resolve, the grant list, and the measured cost comparison, see [Model configuration](/sample-autonomous-cloud-coding-agents/developer-guide/model-configuration).

Note that the reported `cost_usd` is a client-side estimate, not authoritative billing — see [Cost attribution](/sample-autonomous-cloud-coding-agents/getting-started/cost-attribution).

### Monthly user and team budgets

Operators can set recurring monthly USD limits for a Cognito user or team. Team IDs are Cognito group names, and every configured group budget applies to each member. Standard users can inspect their personal limit but cannot change it or view other users' budgets.

For the lowest-overhead organization-wide control, create one Cognito group such as `Everyone`, add every existing user, and make group assignment part of the new-user onboarding process. The budget command validates an existing group; it does not create the group or manage membership.

```bash
# One shared organization pool. Every member contributes to the same limit.
bgagent budget set --team Everyone --monthly-usd 10000 --hard-stop

# Alert at 80% and 100%, but continue admitting tasks.
bgagent budget set --user alice@example.com --monthly-usd 100

# Reject new tasks after the Platform group reaches 100%.
bgagent budget set --team Platform --monthly-usd 1000 --hard-stop

# Show every configured scope, or select one scope. JSON is also available.
bgagent budget status
bgagent budget status --user alice@example.com
bgagent budget status --team Platform --output json

# Cognito-authenticated users can inspect only their own personal scope.
bgagent budget status --me
bgagent budget status --me --output json
```

`budget set` and operator-scoped `budget status` use AWS credentials and discover `BudgetTableName` and `UserPoolId` from the deployed CloudFormation stack. A user may be supplied by email or Cognito username/subject; a team must already exist as a Cognito group. Running `budget set` again replaces the recurring limit and enables or disables the hard stop for that scope.

`budget status --me` is different: it uses the caller's cached Cognito login and the authenticated REST API, requires no operator AWS credentials, and never permits mutation. It reports personal estimated spend even when no personal limit is configured. Team and organization budgets are not exposed by this view and may still block new work.

Monthly accounting uses terminal task `cost_usd` estimates and UTC calendar months. A task is attributed to its submitting user and the user's Cognito groups captured when the task was created. Failed tasks count when they report a positive cost. Running tasks do not count until they finish, so concurrent or long-running work can overshoot a limit.

At 80% and 100%, each scope emits a one-shot CloudWatch threshold metric for the UTC month. The aggregate threshold alarms notify the shared `OperationalAlerts` SNS topic; simultaneous scope crossings may be coalesced into one alarm notification, so inspect the `OrchestrationReconciler` Lambda logs for exact scope and spend details. `--hard-stop` rejects new task creation at 100% with `429 BUDGET_EXCEEDED`. Existing tasks, same-user idempotent replays, and tasks already awaiting upload confirmation are not interrupted.

Like `max_budget_usd`, monthly spend is based on the Claude Agent SDK's estimated `cost_usd`, not the AWS invoice. Use AWS Cost Explorer or CUR 2.0 for authoritative financial controls.

Administrative overhead is one budget command per controlled scope. A single `Everyone` group needs one initial bulk membership pass and one group assignment for each new user; the recurring limit and UTC-month reset require no monthly maintenance. See [Cost attribution](/sample-autonomous-cloud-coding-agents/getting-started/cost-attribution#setting-up-cost-controls) for the setup checklist and incremental AWS cost.