---
title: "Per-repo overrides"
---

Blueprints can configure per-repository settings that override platform defaults. [Model configuration](/sample-autonomous-cloud-coding-agents/developer-guide/model-configuration) explains how `model_id` is layered against the platform default, per-task overrides, and the IAM invoke allowlist. It also covers the cost tradeoffs of picking a different model.

| Setting | Description | Default |
|---|---|---|
| `compute_type` | Compute strategy (`agentcore`, `ecs`, or `lambda-microvm`) | `agentcore` |
| `runtime_arn` | AgentCore runtime ARN override | Platform default |
| `model_id` | Bedrock inference-profile ID (geo-prefixed, matching the deployment's `bedrockGeoRegion`) | `global.anthropic.claude-opus-5-5` |
| `max_turns` | Default turn limit for tasks | 100 |
| `max_budget_usd` | Default cost budget in USD per task, `0.01` to `100` (Blueprint `agent.maxBudgetUsd`) | None (unlimited) |
| `memory_token_budget` | Token budget for the memory context (repository knowledge and past task episodes) loaded into the agent's prompt. A positive integer (Blueprint `agent.memoryTokenBudget`) | 2000 |
| `system_prompt_overrides` | Additional system prompt instructions | None |
| `github_token_secret_arn` | Per-repo GitHub token (Secrets Manager ARN) | Platform default |
| `poll_interval_ms` | Poll interval for awaiting completion (5000 to 300000) | 30000 |

> `lambda-microvm` is **experimental** and requires operator setup (a re-bootstrap to policy bundle ≥ 1.9.0 and a supported Region) before a repo can select it. Keep production repos on `agentcore` or `ecs`. See the [Deployment guide](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#lambda-microvms-backend-experimental).

When you specify `--max-turns` (CLI) or `max_turns` (API) on a task, your value takes precedence over the Blueprint default. If neither is specified, the platform default (100) applies. The same override pattern applies to `--max-budget` and `max_budget_usd`, except that there is no platform default. If neither the task nor the Blueprint specifies a budget, the platform applies no cost limit.

`memory_token_budget` has no per-task override. The value in the repository's record applies to every task on the repository, and the platform default (2000) applies to a repository whose record has none. The budget trims what context hydration retrieves from memory (at most five knowledge records and three episodes). It does not retrieve more. A value that is not a positive integer fails at CDK synth. `bgagent repo show <owner/repo>` prints the value in effect.

### Removing a per-repo override

If you delete an override from the Blueprint and redeploy, the override stays. A redeploy writes the settings the Blueprint declares and leaves the rest of the repository's record in `RepoTable` as it is, so the repository keeps the last value. A deleted `agent.maxBudgetUsd` is still the default budget of its tasks, and a deleted `agent.modelId` still selects the old model. An empty string or an empty list does not clear a setting either. Only the registry asset lists (`assets.mcpServers`, `assets.cedarPolicyModules`, `assets.skills`) are removed from the record when the Blueprint stops declaring them.

`bgagent repo onboard` has no option that removes a setting. When you run it again for an onboarded repository, it keeps the stored value of every option you leave out, and a stored `max_budget_usd` or `memory_token_budget`.

To change an override, set the new value in the Blueprint and redeploy. To remove one, so that the platform default applies again:

1. Delete the setting from the Blueprint. Otherwise the next deploy writes it back.
2. Remove the attribute from the repository's record. The table is the `RepoTableName` stack output (`bgagent platform outputs` prints it), and the attribute has the name of the setting in the table above. The design document linked below names the attributes that are not in that table. The condition makes a mistyped repository name fail instead of writing a new, empty record:

   ```bash
   aws dynamodb update-item \
     --table-name <RepoTableName> \
     --key '{"repo": {"S": "owner/repo"}}' \
     --update-expression "REMOVE max_budget_usd" \
     --condition-expression "attribute_exists(repo)" \
     --return-values UPDATED_OLD
   ```

   The command prints the value it removed. No output means that the record had no attribute of that name.

3. Run `bgagent repo show <owner/repo>`. The setting is no longer marked `(per-blueprint override)`. `bgagent repo show` does not list `build_command` or `lint_command`. For these two, the output of step 2 is the check.

The change applies to tasks submitted after it. A task that is already running keeps the values it started with. [Repository onboarding](/sample-autonomous-cloud-coding-agents/architecture/repo-onboarding#blueprint-construct) lists every attribute that behaves this way and explains why a redeploy leaves them alone.

### Where can I set `max_budget_usd`?

These are all the places a per-task runtime budget can come from:

| Source | How | Scope | Notes |
|---|---|---|---|
| Per task, CLI | `bgagent submit --max-budget <dollars>` | One task | Range `0.01` to `100`. An out-of-range value is rejected client-side before the request is sent |
| Per task, REST | `max_budget_usd` in the `POST /v1/tasks` body | One task | Same `0.01` to `100` range, validated server-side |
| Per repo, Blueprint | `agent.maxBudgetUsd` on the repo's `Blueprint` construct | Every task on that repo | Persisted to `RepoTable.max_budget_usd`. Same `0.01` to `100` range, enforced at CDK synth, so an out-of-range value cannot deploy |
| Local batch runs | `MAX_BUDGET_USD` shell env | One local run | **Local `entrypoint.py` batch mode only.** The deployed AgentCore **server** mode ignores this variable. It reads the budget from the `/invocations` request body, so setting the variable on the runtime has no effect |
| Platform-wide per-task default | — | — | **None exists.** Unset means unlimited (see below) |

The two that apply to a deployed task resolve in this order: **the per-task value wins, then the repo's Blueprint default, then no budget at all.** A Blueprint edit during a task does not change the budget of the running task.

Administrators set the Blueprint default in the CDK stack:

```typescript
new Blueprint(this, 'MyRepo', {
  repo: 'my-org/my-repo',
  repoTable,
  agent: { maxBudgetUsd: 5.0 },  // every task on this repo caps at $5 unless overridden
});
```

Run `bgagent repo show <owner/repo>` to see which value is in effect. The `max_budget_usd` line reads `(per-blueprint override)` when the repo sets one and `(platform default) unlimited` when it does not. Deleting `agent.maxBudgetUsd` from the Blueprint does not remove the budget. See [Removing a per-repo override](#removing-a-per-repo-override).

### Per-task budgets are unlimited by default

By design, there is no platform-wide **per-task runtime** ceiling. A hard runtime cap stops a long-running task in the middle of a change, and the result is a half-finished branch and no PR. The intended runtime controls are the per-repo Blueprint default above, the per-task flag, and `max_turns`. Separately, administrators can configure the monthly user and team admission budgets described below. Those budgets reject new work instead of interrupting work already in progress.

The documented way to reduce cost is to **choose a lighter-token model** instead of relying on a cap:

- **Per repo.** Set Blueprint `agent.modelId`. This needs no code change and no agent redeploy.
- **Per task.** Set `model_id` in the task payload.

The model you pick must be in the platform's Bedrock IAM grant list, or the task fails at turn 0 with `AccessDenied`. You can use a lighter model only if the grant list includes it. For how the model layers resolve, the grant list, and the measured cost comparison, see [Model configuration](/sample-autonomous-cloud-coding-agents/developer-guide/model-configuration).

The reported `cost_usd` is a client-side estimate, not authoritative billing. See [Cost attribution](/sample-autonomous-cloud-coding-agents/getting-started/cost-attribution).

### Monthly user and team budgets

Operators can set recurring monthly USD limits for a Cognito user or team. Team IDs are Cognito group names, and every configured group budget applies to each member. Standard users can inspect their personal limit but cannot change it or view other users' budgets.

For the lowest-overhead organization-wide control, create one Cognito group such as `Everyone`, add every existing user, and make group assignment part of the new-user onboarding process. The budget command validates that the group exists. It does not create the group or manage membership.

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

`budget set` and operator-scoped `budget status` use AWS credentials and discover `BudgetTableName` and `UserPoolId` from the deployed CloudFormation stack. You can identify a user by email, Cognito username, or Cognito subject. A team must already exist as a Cognito group. Running `budget set` again replaces the recurring limit and enables or disables the hard stop for that scope.

`budget status --me` is different. It uses the caller's cached Cognito login and the authenticated REST API, requires no operator AWS credentials, and never permits a change. It reports personal estimated spend even when no personal limit is configured. This view does not show team and organization budgets, and those budgets may still block new work.

Monthly accounting uses the `cost_usd` estimates of terminal tasks and UTC calendar months. A task is attributed to the user who submitted it and to that user's Cognito groups as captured when the task was created. Failed tasks count when they report a positive cost. Running tasks do not count until they finish, so concurrent or long-running work can overshoot a limit.

At 80% and 100%, each scope claims a CloudWatch threshold metric for the UTC month. The platform emits the metric before it persists the claim, so a crash cannot permanently suppress an alert. In rare cases, a concurrent retry or a retry after a crash can emit a harmless duplicate. The aggregate threshold alarms notify the shared `OperationalAlerts` SNS topic. Simultaneous scope crossings may be coalesced into one alarm notification, so inspect the `OrchestrationReconciler` Lambda logs for the exact scope and spend. `--hard-stop` rejects new task creation at 100% with `429 BUDGET_EXCEEDED`. It does not interrupt existing tasks, same-user idempotent replays, or tasks that already await upload confirmation.

Like `max_budget_usd`, monthly spend is based on the Claude Agent SDK's estimated `cost_usd`, not the AWS invoice. Use AWS Cost Explorer or CUR 2.0 for authoritative financial controls.

Administrative overhead is one budget command per controlled scope. A single `Everyone` group needs one initial bulk membership pass and one group assignment for each new user. The recurring limit and UTC-month reset require no monthly maintenance. See [Cost attribution](/sample-autonomous-cloud-coding-agents/getting-started/cost-attribution#setting-up-cost-controls) for the setup checklist and incremental AWS cost.