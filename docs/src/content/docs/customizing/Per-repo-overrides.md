---
title: "Per-repo overrides"
---

A repository's record can hold settings that override the platform defaults. Set them with the flags of `bgagent repo onboard <owner/repo>`, which changes only the settings it names and needs no deploy, or declare them in the repository's Blueprint, which every deploy writes again. For how `model_id` is layered against the platform default, per-task overrides, and the IAM invoke allowlist — plus the cost tradeoffs of picking a different model — see [Model configuration](/sample-autonomous-cloud-coding-agents/developer-guide/model-configuration).

| Setting | Description | Set with (`repo onboard` flag, Blueprint property) | Default |
|---|---|---|---|
| `compute_type` | Compute strategy (`agentcore`, `ecs`, or `lambda-microvm`) | `--compute-type`, `compute.type` (`agentcore` or `ecs`) | `agentcore` |
| `runtime_arn` | AgentCore runtime ARN override | `--runtime-arn`, `compute.runtimeArn` | Platform default |
| `model_id` | Bedrock inference-profile ID (geo-prefixed, matching the deployment's `bedrockGeoRegion`) | `--model`, `agent.modelId` | `global.anthropic.claude-opus-5-5` |
| `max_turns` | Default turn limit for tasks, 1–500 | `--max-turns`, `agent.maxTurns` | 100 |
| `max_budget_usd` | Default cost budget in USD per task, `0.01`–`100` | `--max-budget`, `agent.maxBudgetUsd` | None (unlimited) |
| `memory_token_budget` | Token budget for the memory context (repository knowledge and past task episodes) loaded into the agent's prompt; a positive integer | `--memory-token-budget`, `agent.memoryTokenBudget` | 2000 |
| `system_prompt_overrides` | Additional system prompt instructions | `--system-prompt-file`, `agent.systemPromptOverrides` | None |
| `github_token_secret_arn` | Per-repo GitHub token (Secrets Manager ARN) | `--token-secret-arn`, `credentials.githubTokenSecretArn` | Platform default |
| `poll_interval_ms` | Poll interval for awaiting completion (5000–300000) | `--poll-interval`, `pipeline.pollIntervalMs` | 30000 |
| `build_command` | Command the agent runs to build and verify the repository | `--build-command`, `pipeline.buildCommand` | `mise run build` |
| `lint_command` | Command the agent runs to lint the repository | `--lint-command`, `pipeline.lintCommand` | `mise run lint` |
| `approval_gate_cap` | Cap on the approval gates of one task, 1–500 | `--approval-gate-cap`, `security.approvalGateCap` | 50 |
| `cedar_policies` | The repository's own Cedar rules, added to the built-in ones (see the [Cedar policy guide](/sample-autonomous-cloud-coding-agents/customizing/cedar-policies)) | `--cedar-policy-file`, `security.cedarPolicies` | None |
| `mcp_servers` | MCP servers pinned from the registry | `--mcp-server`, `assets.mcpServers` | None |
| `cedar_policy_modules` | Cedar policy modules pinned from the registry | `--cedar-policy-module`, `assets.cedarPolicyModules` | None |
| `skills` | Skills pinned from the registry | `--skill`, `assets.skills` | None |

`--system-prompt-file` and `--cedar-policy-file` name UTF-8 text files of at most 64 KB (the rule files together). Keep these files in version control: the repository's record is the only other copy. The four list flags (`--cedar-policy-file`, `--mcp-server`, `--cedar-policy-module`, `--skill`) take one entry each and can be repeated; the entries given replace the stored list, so pass every entry that should remain.

Some things still take a deploy: extra egress domains, which only a Blueprint can add (`networking.egressAllowlist`); IAM for a custom runtime or token secret; and what the stack does not have yet. `bgagent repo onboard` refuses a model outside the stack's grant list, a compute backend the stack does not deploy and a registry pin on a stack without the Agent Registry, and its message says what to deploy.

> `lambda-microvm` is **experimental** and requires operator setup (a re-bootstrap to policy bundle ≥ 1.9.0 and a supported Region) before a repo can select it. Keep production repos on `agentcore` or `ecs` — see the [Deployment guide](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#lambda-microvms-backend-experimental).

When you specify `--max-turns` (CLI) or `max_turns` (API) on a task, your value takes precedence over the repository's default. If neither is specified, the platform default (100) is used. The same override pattern applies to `--max-budget` / `max_budget_usd`, except there is no platform default  - if neither the task nor the repository's record specifies a budget, no cost limit is applied. A stored `max_turns` or `max_budget_usd` outside the range that the API accepts for a task is held to that range when a task starts, and a stored value of zero or less counts as not set.

`memory_token_budget` has no per-task override: the value in the repository's record applies to every task on it, and the platform default (2000) applies to a repository whose record has none. The budget trims what context hydration retrieves from memory (at most five knowledge records and three episodes); it does not retrieve more. A value that is not a positive integer is refused by `bgagent repo onboard` and fails at CDK synth. `bgagent repo show <owner/repo>` prints the value in effect.

### Removing a per-repo override

`bgagent repo onboard <owner/repo> --unset <column>` removes a setting from the repository's record, so that the platform default applies again. The column is the setting's name in the table above, and the flag can be repeated:

```bash
bgagent repo onboard owner/repo --unset max_budget_usd --unset model_id
```

The command refuses a repository that has no record, and a setting that the same command also sets. Like every `repo onboard`, it leaves the settings it does not name as they are, and it activates the repository, also one that was offboarded. Afterwards `bgagent repo show <owner/repo>` no longer marks the setting `(per-blueprint override)`, the label of every stored value, whichever way it was stored.

If a Blueprint declares the setting, delete it there too: otherwise the next deploy writes it back. Deleting it from the Blueprint alone does not remove it. A deploy writes the settings the Blueprint declares and leaves the rest of the record as it is, so the repository keeps the last value: a deleted `agent.maxBudgetUsd` is still the default budget of its tasks, and a deleted `agent.modelId` still selects the old model. An empty string or an empty `security.cedarPolicies` does not clear a setting either. The registry asset lists are the exception: a Blueprint detaches one by declaring it empty (`assets: { mcpServers: [] }`), not by leaving it out, which keeps the stored list.

To change a setting, run `bgagent repo onboard` with the new value. If a Blueprint declares the setting, change it there and redeploy instead: every deploy writes the Blueprint's value again, so a value set with the command lasts only until the next deploy. The change applies to tasks that start after it, one that is waiting in the queue included. A task that is already running keeps the values it started with. [Repository onboarding](/sample-autonomous-cloud-coding-agents/architecture/repo-onboarding#blueprint-construct) explains why a deploy leaves the settings a Blueprint does not declare alone.

### Where can I set `max_budget_usd`?

Every place a per-task runtime budget can come from:

| Surface | How | Scope | Notes |
|---|---|---|---|
| Per task, CLI | `bgagent submit --max-budget <dollars>` | One task | Range `0.01`–`100`; rejected client-side before the request is sent |
| Per task, REST | `max_budget_usd` in the `POST /v1/tasks` body | One task | Same `0.01`–`100` range, validated server-side |
| Per repo, CLI | `bgagent repo onboard <owner/repo> --max-budget <dollars>` | Every task on that repo | Persisted to `RepoTable.max_budget_usd` without a deploy; same `0.01`–`100` range, refused before any AWS call |
| Per repo, Blueprint | `agent.maxBudgetUsd` on the repo's `Blueprint` construct | Every task on that repo | Persisted to `RepoTable.max_budget_usd`; same `0.01`–`100` range, enforced at CDK synth so an out-of-range value cannot deploy |
| Local batch runs | `MAX_BUDGET_USD` shell env | One local run | **Local `entrypoint.py` batch mode only.** The deployed AgentCore **server** mode ignores this variable — it reads the budget from the `/invocations` request body, so setting it on the runtime has no effect |
| Platform-wide per-task default | — | — | **None exists.** Unset means unlimited (see below) |

The two levels that apply to a deployed task resolve in this order: **per-task value wins, then the repository's default, then no budget at all.** A change of the repository's default does not move a running task's budget.

Administrators set the repository's default with the CLI, or with `agent.maxBudgetUsd` in its Blueprint:

```bash
# every task on this repo caps at $5 unless overridden
bgagent repo onboard my-org/my-repo --max-budget 5
```

Run `bgagent repo show <owner/repo>` to see which value is in effect; the `max_budget_usd` line reads `(per-blueprint override)` when the repo pins one and `(platform default) unlimited` when it does not. Deleting `agent.maxBudgetUsd` from the Blueprint does not lift the budget: see [Removing a per-repo override](#removing-a-per-repo-override).

### Per-task budgets are unlimited by default

There is intentionally no platform-wide **per-task runtime** ceiling. A hard runtime cap kills a long-running task mid-change — the failure mode is a half-finished branch and no PR. The intended runtime controls are the per-repo default above, the per-task flag, and `max_turns`. Administrators can separately configure monthly user/team admission budgets below; those reject new work instead of interrupting work already in progress.

The documented escape hatch for cost is **choosing a lighter-token model** rather than relying on a cap:

- **Per repo:** `bgagent repo onboard <owner/repo> --model <model-id>`, or `agent.modelId` in its Blueprint — no agent code change and no agent redeploy
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

At 80% and 100%, each scope claims a CloudWatch threshold metric for the UTC month. The metric is emitted before the claim is persisted so a crash cannot permanently suppress an alert; a concurrent or crash retry can rarely emit a harmless duplicate. The aggregate threshold alarms notify the shared `OperationalAlerts` SNS topic; simultaneous scope crossings may be coalesced into one alarm notification, so inspect the `OrchestrationReconciler` Lambda logs for exact scope and spend details. `--hard-stop` rejects new task creation at 100% with `429 BUDGET_EXCEEDED`. Existing tasks, same-user idempotent replays, and tasks already awaiting upload confirmation are not interrupted.

Like `max_budget_usd`, monthly spend is based on the Claude Agent SDK's estimated `cost_usd`, not the AWS invoice. Use AWS Cost Explorer or CUR 2.0 for authoritative financial controls.

Administrative overhead is one budget command per controlled scope. A single `Everyone` group needs one initial bulk membership pass and one group assignment for each new user; the recurring limit and UTC-month reset require no monthly maintenance. See [Cost attribution](/sample-autonomous-cloud-coding-agents/getting-started/cost-attribution#setting-up-cost-controls) for the setup checklist and incremental AWS cost.