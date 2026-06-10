---
title: Linear pak migration runbook
---

# Linear PAK → OAuth migration runbook (Phase 2.0a → 2.0b)

> **Who needs this.** Operators who deployed Phase 2.0a (single Linear personal API key shared across all teammates) and need to upgrade to 2.0b (per-workspace OAuth). If you're starting fresh on 2.0b, read [LINEAR_SETUP_GUIDE.md](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide) instead.

2.0b is a **hard cutover** — no `--use-pak` fallback. Plan for a short maintenance window (~30 min for a single workspace).

## What changes under the hood

| 2.0a | 2.0b |
|---|---|
| Single `LinearApiTokenSecret` (one PAK shared by all teammates) | Per-workspace `bgagent-linear-oauth-<slug>` containing `{access_token, refresh_token, expires_at, client_id, client_secret, …}` |
| Agent runtime granted `secretsmanager:GetSecretValue` on one ARN | Same action but on the `bgagent-linear-oauth-*` prefix |
| `LinearApiTokenSecret` CFN resource | Removed entirely — no automated rollback once 2.0b is deployed |

## Pre-deploy checklist

Run these BEFORE deploying 2.0b so the maintenance window is short:

1. **List in-flight tasks**: `bgagent list --status RUNNING,HYDRATING,SUBMITTED`. The migration won't corrupt them, but their final Linear comment may fail because the OAuth token isn't authorized at agent-run time.
2. **Pick one workspace to migrate first** (lowest-traffic if multi-workspace).
3. **Note the workspace's `urlKey`** — the `<slug>` in `linear.app/<slug>/...`. You need it for `bgagent linear setup <slug>`.
4. **Confirm CLI admin access**: AWS principal needs `secretsmanager:CreateSecret` on `bgagent-linear-oauth-*` AND `dynamodb:PutItem` on `LinearWorkspaceRegistryTable`. Without these, `setup` aborts mid-way (OAuth dance succeeds, secret write fails — Linear OAuth app gets stuck with no usable token).

## Migration steps

1. **Drain the queue.** Wait for in-flight tasks to finish. Tasks running at deploy time will fail their final Linear comment because the token resolver short-circuits when neither `LinearApiTokenSecret` (gone) nor `bgagent-linear-oauth-<slug>` (not yet created) is present.

2. **Deploy 2.0b**: `mise //cdk:deploy`. Adds `LinearWorkspaceRegistryTable`, removes `LinearApiTokenSecret` + IAM grants, adds the `bgagent-linear-oauth-*` prefix grant on the agent runtime, webhook processor, and orchestrator.

3. **For each Linear workspace**, follow the [setup walkthrough](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide#setup-walkthrough) starting at step 2. Each workspace needs:
   - A new Linear OAuth app (scopes: `read,write,app:assignable,app:mentionable`)
   - `bgagent linear setup <slug>` to run the OAuth dance and write the per-workspace secret
   - Webhook signing secret pasted into ABCA via `update-webhook-secret`

4. **Re-onboard projects.** `LinearProjectMappingTable` rows survive the migration (keyed on `linear_project_id` UUID, stable). Verify with `bgagent linear list-projects` that the listed projects still match what's mapped.

5. **Verify with a test issue.** Apply the trigger label in each onboarded workspace and confirm the agent posts as `bgagent[bot]` (not as the previous PAK owner's Linear identity). The author byline change is the cleanest signal that OAuth is on the wire.

6. **Decommission the PAK.** Once 2.0b is verified, revoke the personal API key in [Linear → Settings → Security → Personal API keys](https://linear.app/settings/account/security). Clean break, no rollback.

## Rollback

If 2.0b fails verification before you've done the OAuth setup:

- The `LinearApiTokenSecret` CFN resource has been deleted, so `cdk deploy` of the previous commit recreates it but **with an empty secret value**. You'd have to re-paste the PAK manually.
- Recommended: **fix-forward**. The 2.0b OAuth dance is a 5-minute step per workspace; rolling back is rarely worth the time.

## What survives the migration

- `LinearUserMappingTable` — keyed on `(organization, user UUID)`, unchanged across PAK→OAuth
- `LinearProjectMappingTable` — keyed on `linear_project_id` UUID, also stable
- `LinearWebhookDedupTable` — TTL-bounded; rows from the maintenance window TTL out within 8h
- GitHub PR comments and Linear-issue mappings on in-flight task records

## What does NOT survive

- `LinearApiTokenSecret` Secrets Manager value — gone with the CDK resource
- The 2.0a `linear-api-key` AgentCore credential provider, if 2.0a-with-Identity was deployed mid-Phase. Clean it up after with:
  ```bash
  aws bedrock-agentcore-control delete-api-key-credential-provider --name linear-api-key
  ```
  Phase 2.0b-O2 doesn't use AgentCore Identity at all, so there's nothing to clean up if you skipped the parked 2.0a-Identity branch.
