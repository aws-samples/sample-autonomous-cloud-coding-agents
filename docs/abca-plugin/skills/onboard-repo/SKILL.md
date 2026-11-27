---
name: onboard-repo
description: >-
  Onboard a new GitHub repository to the ABCA platform so the agent can target it.
  Use when the user says "onboard a repo", "add a repository", "register a repo",
  "new repo", or gets a `REPO_NOT_ONBOARDED` / 422 error about an unregistered
  repository.
---

# Repository Onboarding

You are helping an **operator** register a GitHub repository with their running ABCA
deployment so tasks can target it.

There are two paths.

**Prefer the CLI operator path (Path A).** It's a single runtime command against the
deployed stack: no code change, no redeploy. Its flags set the repo's **own** config
too: model, turn limit, cost budget, build and lint commands, system-prompt
additions, Cedar HITL policies and registry pins.

**Use the CDK Blueprint path (Path B)** when the repo needs **custom egress domains**,
which only a Blueprint can add, or when the operator wants the registration checked
in. It requires a redeploy (with the correct permissions).

These need a redeploy on either path: IAM for a custom runtime ARN or a per-repo
GitHub token secret, and what the stack does not have yet. `bgagent repo onboard`
refuses a model not granted to the runtime, a compute backend the stack does not deploy
and a registry pin on a stack without the Agent Registry, and says what to deploy.

> **This is an operation, not a contribution.** Onboarding a repo into your own
> deployment writes a record to the platform's RepoTable — it is **not** a change to
> the `aws-samples` codebase, so the ADR-003 contribution flow (GitHub issue →
> approval → feature branch) does **not** apply. Only invoke ADR-003 if the user is
> actually changing the platform source (e.g. wiring a brand-new Bedrock model into
> the stack — see "Model not yet wired into the runtime" below).

## Gather repository details

Use AskUserQuestion to collect (only the repository is required — the rest fall back to platform defaults):

- **Repository** — GitHub `owner/repo`. Must match exactly what's passed to `bgagent submit --repo` later.
- **Compute type** — `agentcore` (default) or `ecs`.
- **Model** — default is the platform model (Opus 5.5). The geo prefix in the examples
  below (`global.`) must match the deployment's `bedrockGeoRegion`; `bgagent repo
  onboard` rejects a mismatch at the CLI rather than letting the task fail at turn 0. If overriding, it must be a model **already granted to the runtime** (see "Model not yet wired into the runtime"), specified as a cross-Region **inference-profile ID** (e.g. `global.anthropic.claude-opus-5-5`), not a raw `anthropic.*` foundation-model ID.
- **Max turns** — default 100 (range 1–500).
- **Per-repo GitHub token** — only if this repo needs a different token than the platform default (provide its Secrets Manager ARN).
- **Build and lint commands** — only if the repo does not build with `mise run build` / `mise run lint` (e.g. `npm run build && npm test`). Without its real build command, build-regression gating is off for the repo.

> **Per-task cost limits aren't set here.** `max_budget` / `max_turns` *per task* are flags on `bgagent submit` (the `submit-task` skill), not repo-onboarding fields. Onboarding sets the per-repo **defaults** (`--max-turns`, `--max-budget`).

If the repo needs custom egress domains, use **Path B** instead.

## Path A — CLI operator onboarding (default)

`bgagent repo onboard` writes (or re-activates) the repository's `RepoConfig` row in
the deployed RepoTable directly. Run again for an onboarded repo, it changes the
settings it names and keeps the others. It takes effect immediately — **no source
edit, no `cdk deploy`.**

```bash
bgagent repo onboard <owner/repo>
# common overrides:
#   --model <inference-profile-id>     e.g. global.anthropic.claude-opus-5-5 (must be runtime-granted)
#   --compute-type <agentcore|ecs>
#   --max-turns <n>                    per-repo default turn limit (1-500)
#   --max-budget <usd>                 per-repo default cost budget (0.01-100)
#   --build-command <command>          for a repo without mise, e.g. 'npm run build && npm test'
#   --lint-command <command>           e.g. 'npm run lint'
#   --system-prompt-file <path>        extra system prompt instructions (UTF-8 file, at most 64 KB)
#   --cedar-policy-file <path>         Cedar rules, one tier per file; repeatable, the files given replace the stored rules
#   --token-secret-arn <arn>           per-repo GitHub token (else platform default); its IAM needs a redeploy
#   --runtime-arn <arn>                override AgentCore runtime ARN (agentcore only); its IAM needs a redeploy
#   --poll-interval <ms>               agent completion poll interval
#   --unset <column>                   remove a setting, e.g. --unset max_budget_usd
```

`bgagent repo onboard --help` lists every flag, including the registry pins and the
approval-gate cap. Keep prompt and rule files in version control: the row is the only
other copy.

Then confirm it landed:

```bash
bgagent repo list                 # status should be "active"
bgagent repo show <owner/repo>    # full resolved config (secret ARNs redacted)
```

That's it — the repo is onboarded. Submit a task with the `submit-task` skill.

**Pick a model that is already wired into the runtime.** With no `--model`, the repo
uses the platform default — read it from the stack's `BedrockGeoRegion` +
`BedrockModelIds` outputs rather than a literal here. If you pass `--model`, use a cross-Region
**inference profile ID** (e.g. `global.anthropic.claude-opus-5-5`), not a raw
`anthropic.*` foundation-model ID. Only models the stack has granted the runtime can
be invoked — see "Model not yet wired into the runtime" before choosing a model the
deployment doesn't already support.

## Path B — CDK Blueprint (declarative, checked in)

Use this when the operator wants the repo committed to infrastructure-as-code (so a
fresh deploy re-creates it) rather than set as a runtime record, or when the repo needs
custom egress domains. This **does** require editing the CDK app and redeploying.

1. Read `resolveBlueprintDefinitions` in `cdk/src/blueprints/definitions.ts`. The stack
   creates a `Blueprint` for each definition, and the DNS allowlist is built from the
   same list, so do not add a `Blueprint` construct to `cdk/src/stacks/agent.ts`.
2. Add a definition following the existing pattern:

   ```typescript
   definitions.push({
     id: 'MyRepoBlueprint', // construct ID: keep it stable across releases
     repo: 'owner/repo',
     // Optional overrides:
     // compute: { type: 'agentcore' },
     // agent: { modelId: 'global.anthropic.claude-opus-5-5', maxTurns: 100, maxBudgetUsd: 50 },
     // credentials: { githubTokenSecretArn: 'arn:aws:secretsmanager:...' },
     // networking: { egressAllowlist: ['npm.internal.example.com'] },
   });
   ```

3. Redeploy with the `deploy` skill: `bgagent setup` with the stack's current features (`DeploymentFeatures` output) and `--yes`. Setup shows the diff and refuses to delete data without the user's confirmation.

A setting deleted from a definition stays in the row: to remove it, also run
`bgagent repo onboard <owner/repo> --unset <column>`.

> **Sample-repo shortcut:** the stack's AgentPlugins blueprint resolves its `repo` from
> `BLUEPRINT_REPO` (env) → CDK context `blueprintRepo` → default `awslabs/agent-plugins`.
> To target a fork of the sample without adding a construct, set
> `export BLUEPRINT_REPO=owner/repo` (or `cdk.json` context) and redeploy.

## Model not yet wired into the runtime (the one real code change)

A repo can only use a model the **runtime IAM role has `grantInvoke` for**. The granted
set is `DEFAULT_BEDROCK_MODEL_IDS` in
`cdk/src/handlers/shared/bedrock-model-constants.ts` — Opus 5.5 and Haiku 5.5 (the
defaults) plus Sonnet 4.6, Opus 4.8, Opus 5, and Haiku 4.5 — and a deployed stack publishes it as the
`BedrockModelIds` output, so read that rather than trusting this list to stay current:

```bash
aws cloudformation describe-stacks --stack-name <stack> \
  --query "Stacks[0].Outputs[?OutputKey=='BedrockModelIds'].OutputValue" --output text
```

Onboarding a repo pinned to any **other** model fails at invoke with a 403 — the CLI
onboard succeeds, but tasks can't run. `bgagent repo onboard --model` checks the value
against that output and rejects an ungranted model up front.

Pin the **geo-prefixed inference-profile** form, matching the stack's `BedrockGeoRegion`
output (e.g. `global.anthropic.claude-opus-4-8`), not the bare id — Bedrock refuses bare
ids for on-demand invocation, and the IAM grant is scoped to one geography's profile ARNs.

Granting a **new** model is a deploy-time change, not a construct edit: the list is overridable via CDK context, either on the command line or in `cdk.json`. Both forms behave identically — the resolver JSON-parses the string `-c` delivers.

```bash
cdk deploy -c bedrockModels='["anthropic.claude-opus-5-5","anthropic.claude-haiku-5-5","anthropic.claude-sonnet-4-6"]'
```

The override **REPLACES** the default list rather than adding to it, so it must include the two models the stack injects as `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_HAIKU_MODEL` — Opus 5.5 and Haiku 5.5. Omitting either fails at synth, naming the missing model, because every substrate is told to invoke them regardless of this list. (`--context-file` does not work for this: it is accepted and silently ignored.)

For a persistent setting, put the same array in the `context` block of `cdk.json`:

```jsonc
// cdk.json — this REPLACES the default list, so include the platform defaults
// (Opus 5.5 + Haiku 5.5) or the stack's own defaults are ungranted
"context": {
  "bedrockModels": [
    "anthropic.claude-opus-5-5",
    "anthropic.claude-haiku-5-5",
    "anthropic.claude-sonnet-4-6"
  ]
}
```

Three constraints on the value. Entries are **bare** ids — the geo prefix is derived from
`bedrockGeoRegion`, and a prefixed entry is rejected. Patterns are rejected too: these ids
become the resource half of the IAM grant, so a `*` would grant every inference profile in
the account. And each entry must have a live cross-Region inference profile:

```bash
aws bedrock get-inference-profile --inference-profile-identifier <geo>.<model>
```

A granted model with **no** profile is the trap — it passes the CLI's `--model` check and
workflow admission (both read the grant list) and only fails at turn 0.
`bgagent platform doctor` checks the whole granted set for exactly this and names any
model that does not resolve.

**Account-level Bedrock model access** is separate from IAM: the account must have the
model enabled for the Region — complete [model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
prerequisites (Marketplace actions / Anthropic first-time use where applicable). For
cross-Region profiles, IAM and SCPs must allow Bedrock in source **and** destination
Regions.

If the user just wants the agent working now, leave `model_id` unset so the repo takes the
platform default, and treat "add model X" as a separate, later change.

## Per-repository configuration reference

| Setting | Purpose | Default |
|---------|---------|---------|
| `compute_type` | Execution strategy | `agentcore` |
| `runtime_arn` | AgentCore runtime override | Platform default |
| `model_id` | AI model for tasks (inference profile ID) | Platform default (Opus 5.5, as `<BedrockGeoRegion>.anthropic.claude-opus-5-5`) |
| `max_turns` | Turn limit per task | 100 |
| `max_budget_usd` | Cost ceiling per task | Unlimited |
| `memory_token_budget` | Token budget for the memory context loaded into the agent's prompt | 2000 |
| `system_prompt_overrides` | Custom system instructions | None |
| `github_token_secret_arn` | Repo-specific GitHub token | Platform default |
| `poll_interval_ms` | Completion polling frequency | 30000ms |

The other seven settings (`build_command`, `lint_command`, `approval_gate_cap`, `cedar_policies` and the registry pins `mcp_servers`, `cedar_policy_modules`, `skills`) have flags too: see `bgagent repo onboard --help`.

Task-level parameters override per-repo defaults where one exists (`memory_token_budget` has none); if neither specifies a value, platform defaults apply.

## Common issues

- **`REPO_NOT_ONBOARDED` / 422** — the repo isn't registered. Run `bgagent repo onboard <owner/repo>` (Path A). Confirm the `owner/repo` matches exactly what you pass to `bgagent submit --repo`.
- **Preflight failure after onboarding** — the GitHub PAT lacks access to the new repo. Ensure the token has Contents (read/write) + Pull requests (read/write) on it, or onboard with a repo-specific `--token-secret-arn`.
- **400 "Invocation with on-demand throughput isn't supported"** — `model_id` is a raw foundation-model ID; use the inference-profile ID (e.g. `global.anthropic.claude-opus-5-5`).
- **403 "not authorized to perform bedrock:InvokeModelWithResponseStream"** — the repo's model isn't wired into the runtime. See "Model not yet wired into the runtime."
- **Model not available / "not available on your Bedrock deployment"** — account-level Bedrock access isn't enabled for that model/Region (separate from IAM); complete [model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html), then use an enabled inference-profile ID.
