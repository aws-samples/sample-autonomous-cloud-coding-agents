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
- **Model preference**: Claude Sonnet 4 (default), Claude Opus 4 (complex repos), or Claude Haiku (lightweight)
- **Max turns**: Default 100 (range: 1-500)
- **Max budget**: USD cost ceiling per task (optional)
- **Custom GitHub PAT**: If this repo needs a different token than the platform default

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
  // modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
  // maxTurns: 100,
  // maxBudgetUsd: 50,
  // runtimeArn: runtime.runtimeArn,
  // githubTokenSecretArn: 'arn:aws:secretsmanager:...',
});
```

Use a descriptive construct ID derived from the repo name.

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
| `github_token_secret_arn` | Repo-specific GitHub token | Platform default |
| `poll_interval_ms` | Completion polling frequency | 30000ms |

Task-level parameters override Blueprint defaults. If neither specifies a value, platform defaults apply.

## Common Issues

- **422 "Repository not onboarded"** — Blueprint hasn't been deployed yet. Add the construct and redeploy.
- **Preflight failures after onboarding** — GitHub PAT may lack permissions for the new repo. Check the PAT's fine-grained access includes the target repository.
