---
name: onboard-repo
description: >-
  Onboard a new GitHub repository to the ABCA platform by adding a Blueprint CDK
  construct. Use when the user says "onboard a repo", "add a repository",
  "register a repo", "new repo", "Blueprint construct", "REPO_NOT_ONBOARDED error",
  or gets a 422 error about an unregistered repository.
---

# Repository Onboarding

You are guiding the user through onboarding a new GitHub repository to ABCA. Repositories must be registered as `Blueprint` constructs in the CDK stack before tasks can target them.

## Step 1: Gather Repository Details

Use AskUserQuestion to collect:
- **Repository**: GitHub `owner/repo` format
- **Compute type**: `agentcore` (default) or `ecs`
- **Model preference**: Claude Sonnet 4 (default), Claude Opus 4 (complex repos), or Claude Haiku (lightweight). **Important:** Models must be specified using their cross-region inference profile ID (e.g. `us.anthropic.claude-opus-4-20250514-v1:0`), not the raw foundation model ID. On-demand invocation of raw model IDs is not supported for most models.
- **Max turns**: Default 100 (range: 1-500)
- **Max budget**: USD cost ceiling per task (optional)
- **Custom GitHub credentials**: If this repo needs a different token than the platform default (per-repo PAT via `credentials.githubTokenSecretArn`, or per-repo Token Vault via `credentials.workloadIdentityName` + `credentials.githubOAuth2CredentialProviderName`)

## Step 2: Read the Current Stack

Read the CDK stack file to understand existing Blueprint definitions:

```
Read cdk/src/stacks/agent.ts
```

Identify:
- Where existing Blueprint constructs are defined
- The `repoTable` reference used
- Any patterns for compute/model overrides

## Step 3: Add the Blueprint Construct

Add a new `Blueprint` construct instance to the stack. Follow the existing pattern. Example:

```typescript
new Blueprint(this, 'MyRepoBlueprint', {
  repo: 'owner/repo',
  repoTable: repoTable,
  // Optional overrides:
  // computeType: 'agentcore',
  // modelId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  // maxTurns: 100,
  // maxBudgetUsd: 50,
  // runtimeArn: runtime.runtimeArn,
  // credentials: {
  //   githubTokenSecretArn: 'arn:aws:secretsmanager:...',        // PAT path
  //   // OR Token Vault path (preferred):
  //   // workloadIdentityName: 'my-identity',
  //   // githubOAuth2CredentialProviderName: 'my-github-provider',
  // },
});
```

Use a descriptive construct ID derived from the repo name.

### Model ID and IAM Permissions

When specifying a non-default model via `agent.modelId`, two things are required:

1. **Use the inference profile ID, not the raw model ID.** Bedrock does not support on-demand invocation of raw foundation model IDs for most models. Use the cross-region inference profile ID instead:
   - Sonnet 4: `us.anthropic.claude-sonnet-4-20250514-v1:0`
   - Opus 4: `us.anthropic.claude-opus-4-20250514-v1:0`
   - Haiku 4.5: `us.anthropic.claude-haiku-4-5-20251001-v1:0` (on-demand works for Haiku)

2. **Grant the runtime IAM permissions for the model.** The Blueprint construct does not automatically grant `bedrock:InvokeModel*` — this is by design (least privilege). You must add a `grantInvoke` block in the stack for each model used:
   ```typescript
   const opusModel = new bedrock.BedrockFoundationModel('anthropic.claude-opus-4-20250514-v1:0', {
     supportsAgents: true,
     supportsCrossRegion: true,
   });
   opusModel.grantInvoke(runtime);

   const opusProfile = bedrock.CrossRegionInferenceProfile.fromConfig({
     geoRegion: bedrock.CrossRegionInferenceProfileRegion.US,
     model: opusModel,
   });
   opusProfile.grantInvoke(runtime);
   ```

## Step 4: Deploy

After adding the Blueprint, the stack must be redeployed:

```bash
export MISE_EXPERIMENTAL=1
mise run //cdk:compile   # Verify TypeScript compiles
mise run //cdk:test      # Run tests
mise run //cdk:diff      # Preview changes
```

Show the diff to the user. If it looks correct, ask if they want to deploy now.

```bash
mise run //cdk:deploy
```

## Step 5: Verify

After deployment, verify the repo config was written to DynamoDB:

```bash
aws dynamodb scan --table-name <RepoTableName> \
  --filter-expression "repo = :r" \
  --expression-attribute-values '{":r":{"S":"owner/repo"}}' \
  --output json
```

## Per-Repository Configuration Reference

| Setting | Purpose | Default |
|---------|---------|---------|
| `compute_type` | Execution strategy | `agentcore` |
| `runtime_arn` | AgentCore runtime override | Platform default |
| `model_id` | AI model for tasks | Platform default (Sonnet 4) |
| `max_turns` | Turn limit per task | 100 |
| `max_budget_usd` | Cost ceiling per task | Unlimited |
| `system_prompt_overrides` | Custom system instructions | None |
| `github_token_secret_arn` | Repo-specific GitHub token (PAT path) | Platform default |
| `workload_identity_name` | Token Vault workload identity (preferred) | Platform default |
| `github_oauth2_provider_name` | Token Vault credential provider (required with above) | Platform default |
| `poll_interval_ms` | Completion polling frequency | 30000ms |

Task-level parameters override Blueprint defaults. If neither specifies a value, platform defaults apply.

## Common Issues

- **422 "Repository not onboarded"** — Blueprint hasn't been deployed yet. Add the construct and redeploy.
- **Preflight failures after onboarding** — GitHub credentials may lack permissions for the new repo. For PAT: check the fine-grained token includes the target repository with Contents (read/write) and Pull requests (read/write) permissions. For Token Vault: verify the GitHub App is installed on the target repo (GitHub → Settings → Developer settings → GitHub Apps → your app → Install App) and the callback URL is registered.
- **400 "Invocation with on-demand throughput isn't supported"** — The Blueprint `modelId` is using a raw foundation model ID instead of an inference profile ID. Change e.g. `anthropic.claude-opus-4-20250514-v1:0` to `us.anthropic.claude-opus-4-20250514-v1:0`.
- **403 "not authorized to perform bedrock:InvokeModelWithResponseStream"** — The runtime IAM role lacks permissions for the model specified in the Blueprint. Add `grantInvoke` for both the model and its cross-region inference profile in `agent.ts`.
