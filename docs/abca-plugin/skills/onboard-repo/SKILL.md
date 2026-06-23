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

There are two paths. **Default to the CLI operator path** — it's a single runtime
command against the deployed stack, no code change and no redeploy. Use the CDK
Blueprint path only when the operator wants the repo set declaratively in
infrastructure-as-code.

> **This is an operation, not a contribution.** Onboarding a repo into your own
> deployment writes a record to the platform's RepoTable — it is **not** a change to
> the `aws-samples` codebase, so the ADR-003 contribution flow (GitHub issue →
> approval → feature branch) does **not** apply. Only invoke ADR-003 if the user is
> actually changing the platform source (e.g. wiring a brand-new Bedrock model into
> the stack — see "Model not yet wired into the runtime" below).

## Path A — CLI operator onboarding (default)

`bgagent repo onboard` writes (or re-activates) the repository's `RepoConfig` row in
the deployed RepoTable directly. It takes effect immediately — **no `agent.ts` edit,
no `cdk deploy`.**

```bash
bgagent repo onboard <owner/repo>
# common overrides:
#   --model <inference-profile-id>     e.g. us.anthropic.claude-sonnet-4-6
#   --compute-type <agentcore|ecs>
#   --max-turns <n>
#   --token-secret-arn <arn>           per-repo GitHub token (else platform default)
```

Then confirm it landed:

```bash
bgagent repo list                 # status should be "active"
bgagent repo show <owner/repo>    # full resolved config (secret ARNs redacted)
```

That's it — the repo is onboarded. Submit a task with the `submit-task` skill.

**Pick a model that is already wired into the runtime.** With no `--model`, the repo
uses the platform default (Sonnet 4.6). If you pass `--model`, use a cross-Region
**inference profile ID** (e.g. `us.anthropic.claude-sonnet-4-6`), not a raw
`anthropic.*` foundation-model ID. Only models the stack has granted the runtime can
be invoked — see "Model not yet wired into the runtime" before choosing a model the
deployment doesn't already support.

## Path B — CDK Blueprint (declarative / canonical)

Use this when the operator wants the repo committed to infrastructure-as-code (so a
fresh deploy re-creates it) rather than set as a runtime record. This **does** require
editing the stack and redeploying.

1. Read `cdk/src/stacks/agent.ts` to find where `Blueprint` constructs are defined and
   the `repoTable` reference.
2. Add a construct following the existing pattern:

   ```typescript
   new Blueprint(this, 'MyRepoBlueprint', {
     repo: 'owner/repo',
     repoTable: repoTable.table,
     // Optional overrides:
     // computeType: 'agentcore',
     // modelId: 'us.anthropic.claude-sonnet-4-6',
     // maxTurns: 100,
     // maxBudgetUsd: 50,
     // githubTokenSecretArn: 'arn:aws:secretsmanager:...',
   });
   ```

3. Redeploy: `mise //cdk:compile` → `mise //cdk:diff` (show the diff) → `mise //cdk:deploy -- --require-approval never`.

> **Sample-repo shortcut:** the stack's AgentPlugins blueprint resolves its `repo` from
> `BLUEPRINT_REPO` (env) → CDK context `blueprintRepo` → default `awslabs/agent-plugins`.
> To target a fork of the sample without adding a construct, set
> `export BLUEPRINT_REPO=owner/repo` (or `cdk.json` context) and redeploy.

## Model not yet wired into the runtime (the one real code change)

A repo can only use a model the **runtime IAM role has `grantInvoke` for**. As of now
the stack wires **Sonnet 4.6, Opus 4 (`claude-opus-4-20250514`), and Haiku 4.5** (see
the `grantInvoke` block in `agent.ts`). Onboarding a repo pinned to any **other** model
(e.g. Opus 4.8 / `us.anthropic.claude-opus-4-8`) will fail at invoke with a 403 — the
CLI onboard succeeds, but tasks can't run.

Adding a new model **is** a platform source change, so it follows ADR-003 (issue →
approval → feature branch) and requires:

1. **Wire the model + inference profile and grant the runtime**, in `agent.ts`:
   ```typescript
   const model = new bedrock.BedrockFoundationModel('anthropic.claude-opus-4-8', {
     supportsAgents: true,
     supportsCrossRegion: true,
   });
   model.grantInvoke(runtime);
   const profile = bedrock.CrossRegionInferenceProfile.fromConfig({
     geoRegion: bedrock.CrossRegionInferenceProfileRegion.US,
     model,
   });
   profile.grantInvoke(runtime);
   ```
   then redeploy.
2. **Account-level Bedrock model access** (separate from IAM): the account must have the
   model enabled for the Region — complete [model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
   prerequisites (Marketplace actions / Anthropic first-time use where applicable). For
   cross-Region profiles, IAM and SCPs must allow Bedrock in source **and** destination
   Regions.

If the user just wants the agent working now, steer them to a wired model (Sonnet 4.6)
via Path A and treat "add model X" as a separate, later change.

## Per-repository configuration reference

| Setting | Purpose | Default |
|---------|---------|---------|
| `compute_type` | Execution strategy | `agentcore` |
| `model_id` | AI model for tasks (inference profile ID) | Platform default (Sonnet 4.6) |
| `max_turns` | Turn limit per task | 100 |
| `max_budget_usd` | Cost ceiling per task | Unlimited |
| `system_prompt_overrides` | Custom system instructions | None |
| `github_token_secret_arn` | Repo-specific GitHub token | Platform default |
| `poll_interval_ms` | Completion polling frequency | 30000ms |

Task-level parameters override per-repo defaults; if neither specifies a value, platform defaults apply.

## Common issues

- **`REPO_NOT_ONBOARDED` / 422** — the repo isn't registered. Run `bgagent repo onboard <owner/repo>` (Path A). Confirm the `owner/repo` matches exactly what you pass to `bgagent submit --repo`.
- **Preflight failure after onboarding** — the GitHub PAT lacks access to the new repo. Ensure the token has Contents (read/write) + Pull requests (read/write) on it, or onboard with a repo-specific `--token-secret-arn`.
- **400 "Invocation with on-demand throughput isn't supported"** — `model_id` is a raw foundation-model ID; use the inference-profile ID (e.g. `us.anthropic.claude-sonnet-4-6`).
- **403 "not authorized to perform bedrock:InvokeModelWithResponseStream"** — the repo's model isn't wired into the runtime. See "Model not yet wired into the runtime."
- **Model not available / "not available on your Bedrock deployment"** — account-level Bedrock access isn't enabled for that model/Region (separate from IAM); complete [model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html), then use an enabled inference-profile ID.
