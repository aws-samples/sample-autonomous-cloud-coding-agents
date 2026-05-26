---
title: Linear setup guide
---

# Linear integration setup guide

This guide walks through setting up the ABCA Linear integration. Once configured, applying the `bgagent` label to an issue in a mapped Linear project triggers an autonomous task. The agent posts progress comments back on the Linear issue as it works.

> **Phase 2.0b** — ABCA now authenticates to Linear via OAuth (`actor=app`) instead of a personal API key. One OAuth app per ABCA deployment, one credential provider per Linear workspace. Personal API keys are no longer supported (see [Migration from 2.0a (PAK) to 2.0b (OAuth)](#migration-from-20a-pak-to-20b-oauth) below).

## Prerequisites

- ABCA CDK stack deployed (see [Developer guide](/developer-guide/introduction))
- A Cognito user account configured (see [User guide](/using/overview))
- A Linear workspace where you have **admin** access (you'll create an OAuth app and install it on the workspace)
- AWS CLI configured with credentials for your ABCA account, with `bedrock-agentcore-control:*` permissions on the deployment region
- The `bgagent` CLI installed and logged in (`bgagent configure` + `bgagent login`)

## How it works

1. A Linear-workspace admin creates a Linear OAuth app, registers it as an AgentCore Identity credential provider, and authorizes it on the workspace via `bgagent linear setup`. The workspace's OAuth token lives in the AgentCore Identity vault, keyed on `userId=linear-workspace-<organizationId>`. **One install per workspace, used by all teammates** — this matches the v1 personal-API-key semantics.
2. A user adds the `bgagent` label (configurable per project) to a Linear issue.
3. Linear fires a webhook to `POST /v1/linear/webhook`. ABCA verifies the HMAC signature and dedups retries.
4. A processor Lambda looks up the Linear `organizationId` in `LinearWorkspaceRegistryTable` to find the credential provider name, retrieves the workspace's OAuth token via AgentCore Identity, then resolves the project → repo mapping and creates a task with `channel_source: 'linear'`.
5. The agent clones the repo, writes `.mcp.json` with Linear's hosted MCP server, and runs. It uses `mcp__linear-server__save_comment` / `mcp__linear-server__update_issue` to post updates as `bgagent[bot]` (the OAuth app's identity).
6. The agent opens a PR on GitHub and adds a final comment to the Linear issue with the PR link.

**Trigger**: only Linear issues with the configured label in a mapped project create tasks. Issues without the label, or in unmapped projects, are ignored. Label removal does not cancel a running task.

**Multi-workspace**: a single ABCA deployment can serve multiple Linear workspaces. Each workspace gets its own AgentCore credential provider via `bgagent linear add-workspace`.

## Step-by-step setup

### Step 1: Create the AgentCore credential provider

The credential provider is an AWS-side OAuth2 client registration. It generates the **AWS-hosted callback URL** that Linear will redirect the browser to during consent — without this URL, you can't complete Step 2.

```bash
bgagent linear oauth-register-workspace <workspace-slug>
```

Where `<workspace-slug>` is the Linear `urlKey` of the workspace (e.g. `acme` from `https://linear.app/acme/...`). The command prompts for the Linear OAuth app's `clientId` and `clientSecret` — you don't have these yet, so first create the Linear OAuth app in Step 2 below, then come back and finish this step. Either order works; just pair them.

The command:
- Calls `aws bedrock-agentcore-control create-oauth2-credential-provider` with `credentialProviderVendor='CustomOauth2'` (Linear is not a built-in vendor, so the command supplies an explicit `authorizationServerMetadata` block — Linear has no `.well-known/openid-configuration`).
- Prints the AWS-hosted callback URL you'll paste into Linear's app form.
- Records the provider name (`linear-oauth-<workspace-slug>`) for `bgagent linear setup` to use later.

> **Why AWS hosts the callback.** Earlier ABCA designs (and most third-party docs at the time of writing) assumed the integrator hosted their own callback service. AgentCore Identity actually proxies the callback itself; the URL it surfaces in `create-oauth2-credential-provider` response (`callbackUrl`) is what Linear redirects to, **not** an URL you control. The `resourceOauth2ReturnUrl` you pass to `get_resource_oauth2_token` is just where AWS sends the **browser** after AWS finishes the code-exchange — typically a localhost URL that `bgagent linear setup` listens on for that one redirect.

### Step 2: Create the Linear OAuth app

Run:

```bash
bgagent linear app-template
```

This prints the exact field values to paste into Linear's OAuth app form. Open [Linear Settings → API → New application](https://linear.app/settings/api/applications/new) and fill in the fields the template lists. Critical fields (each gates the `actor=app` agent flow — without them Linear surfaces a misleading "Invalid redirect_uri" error):

- **GitHub username**: must end with the literal `[bot]` suffix (e.g., `bgagent[bot]`)
- **Webhooks**: toggle ON (the URL value can be a placeholder; we don't subscribe to events for the OAuth flow itself)
- **Callback URLs**: paste the AWS-hosted URL from Step 1 on a single line. Wildcards are not accepted; if you have multiple environments, register each URL fully.

If you ran Step 1 first, pass the AWS callback URL to the template so it's filled in:

```bash
bgagent linear app-template --aws-callback-url "<paste from Step 1 output>"
```

Click **Save**, then copy the **Client ID** and **Client Secret** from the app's detail page.

### Step 3: Finish Step 1 — paste Linear secrets

Return to the terminal where Step 1 is paused at the `Client ID:` prompt and paste the values you copied from Linear. The credential provider is now wired up.

### Step 4: Authorize via OAuth

```bash
bgagent linear setup
```

The wizard:

1. Looks up the credential provider you registered in Step 1.
2. Starts an ephemeral HTTPS server on `localhost:8443` with a self-signed cert. **Your browser will warn about the cert** — click through, it's local-only.
3. Calls `get_resource_oauth2_token` with `customParameters={'actor': 'app'}` and opens the returned `authorizationUrl` in your default browser.
4. You authorize the OAuth app on the Linear consent screen.
5. AWS handles the code-exchange with Linear behind the scenes, then redirects your browser to `https://localhost:8443/oauth/callback?session_id=...`.
6. The wizard captures the `session_id`, polls for the access token (5s/600s timeout), then queries Linear's `viewer { id, organization { id, urlKey } }` to record workspace metadata in `LinearWorkspaceRegistryTable`.

The OAuth token is stored in the AWS-managed token vault under `userId=linear-workspace-<organizationId>`. **All teammates' Linear-triggered tasks share this single token** — that's by design (matches the v1 PAK semantics, just with a revocable / scoped credential and audit trail).

### Step 5: Configure the Linear webhook

In [Linear Settings → API](https://linear.app/settings/api) → **Webhooks** → **+**:

- **URL**: paste the URL `bgagent linear setup` printed at the end of Step 4 (looks like `https://<your-api-id>.execute-api.<region>.amazonaws.com/v1/linear/webhook`)
- **Resource types**: check **Issues** only
- **Team**: whichever team owns the projects you'll map to ABCA (or all teams)

Save, then open the webhook's detail page and copy the **signing secret**. Run:

```bash
bgagent linear setup --webhook-secret <paste>
```

This stores the secret in `LinearWebhookSecret`. (Webhook signing is independent of OAuth — it's how Linear authenticates inbound calls to your API Gateway, separate from how the agent authenticates outbound calls to Linear.)

### Step 6: Onboard a Linear project

Map a Linear project UUID to the GitHub repo you want tasks routed to:

```bash
bgagent linear onboard-project <linear-project-id> --repo owner/repo
```

Optional flags:

| Flag | Purpose | Default |
|------|---------|---------|
| `--label <label>` | Linear label that triggers a task | `bgagent` |
| `--team-id <id>` | Linear team UUID (stored for debug only) | — |
| `--region <region>` | AWS region | from `bgagent configure` |
| `--stack-name <name>` | CloudFormation stack name | `backgroundagent-dev` |

**Finding the Linear project UUID.** Linear's project URL (`https://linear.app/<workspace>/project/<slug>-<short>`) contains a *truncated* UUID at the end — that's not the full UUID the webhook sends. List the full UUIDs for all projects visible to the OAuth token:

```bash
bgagent linear list-projects
```

Copy the `id` of the project you want to onboard. `onboard-project` validates the UUID format and will reject the truncated slug version with a pointer back to this command.

### Step 7: Link your Linear account (optional but recommended)

ABCA needs to know which platform user a Linear actor maps to so triggered tasks are attributed correctly (concurrency caps, billing, `bgagent list`).

**The admin who ran `bgagent linear setup` is auto-linked.** Setup queries Linear's `viewer { id }` with the new OAuth token and writes a row in `LinearUserMappingTable` for the Cognito user running the CLI. Look for `✓ Linked Linear user …` in the setup output.

**For other teammates**: Linear-triggered tasks they apply the label on will be **dropped** by the processor with `"Linear actor has no linked platform user — skipping task creation"` until their identity is mapped. Two paths:

- **Manual (today):** the admin inserts a row into `LinearUserMappingTable`:

  ```bash
  aws dynamodb put-item \
    --table-name <stack>-LinearIntegrationUserMappingTable... \
    --item '{
      "linear_identity": {"S": "<workspaceId>#<viewerId>"},
      "platform_user_id": {"S": "<their Cognito sub>"},
      "status": {"S": "active"},
      "linked_at": {"S": "2026-05-19T00:00:00Z"}
    }'
  ```

  Find the `viewerId` via Linear's API (`viewer { id }` while logged in as that teammate) and the Cognito sub via `bgagent admin invite-user` (printed when you create their user) or by decoding their cached id_token.

- **Self-service (planned, v2.x):** a comment-driven `@bgagent link` flow that exchanges a code for a row write — `bgagent linear link <code>` exists in v1 but is non-functional until the Linear-side code generator ships.

### Step 8: Test it

Add the `bgagent` label to a Linear issue in a mapped project. Within a few seconds:

- The Linear webhook Lambda logs an `INFO` entry and invokes the processor.
- The processor looks up `LinearWorkspaceRegistryTable` by the webhook's `organizationId`, retrieves the workspace's OAuth token via AgentCore Identity, and creates a task in `TaskTable` with `channel_source: 'linear'`.
- The agent container starts, clones the repo, and posts a `🤖 Starting on this issue…` comment as `bgagent[bot]`.
- When the agent opens a PR, another comment appears with the PR link and the issue transitions to `In Review` (if that state exists).
- On completion or failure, a final status comment is posted.

## Adding additional Linear workspaces

A single ABCA deployment can serve multiple Linear workspaces. Each workspace gets its own credential provider and OAuth install:

```bash
bgagent linear add-workspace <workspace-slug>
```

This re-runs Steps 1, 2, and 4 of the setup (asks for a new clientId/secret pair, creates a `linear-oauth-<workspace-slug>` provider, runs the OAuth dance against the new workspace). You'll need to create a separate Linear OAuth app for each workspace — Linear apps are workspace-scoped at install time even though the same OAuth credentials *could* technically install in multiple workspaces. Per-workspace apps give cleaner revocation and per-workspace branding.

The 50-credential-provider-per-account quota in AgentCore is the practical ceiling for multi-tenant deployments.

## Usage

### Trigger a task

Add the `bgagent` label (or whatever you configured) to an issue in a mapped Linear project. The issue title + description becomes the task description.

### Check status

- **From Linear**: the issue itself — progress comments are posted as the agent works.
- **From the CLI**: `bgagent list` / `bgagent status <task-id>`.

### Cancel a task

Use `bgagent cancel <task-id>`. Removing the Linear label does not cancel a running task.

## Troubleshooting

### Webhook doesn't trigger a task

1. Is the project mapped? Run `aws dynamodb scan --table-name <LinearProjectMappingTableName>` (look up the table name via `aws cloudformation describe-stacks`).
2. Is the workspace registered? Scan `LinearWorkspaceRegistryTable` for the Linear `organizationId` from the webhook payload.
3. Is the label spelled exactly as configured? Match is case-insensitive but must be the same word.
4. Check CloudWatch logs for `WebhookFn` and `WebhookProcessorFn` for `Invalid Linear webhook signature`, `Linear workspace is not onboarded`, `Linear project is not onboarded`, or `Linear actor has no linked platform user`.

### "Linear actor has no linked platform user — skipping task creation"

The Linear user who applied the label hasn't been mapped to a Cognito user. See [Step 7](#step-7-link-your-linear-account-optional-but-recommended).

### "Invalid redirect_uri parameter for the application" during Step 4

This is Linear's misleading error for `actor=app` flows where the OAuth app config is incomplete. Check, in your Linear app settings:

- **GitHub username** field is set to a value ending in `[bot]` (e.g. `bgagent[bot]`)
- **Webhooks** toggle is ON
- The AWS-hosted callback URL is on a **single line** in the Callback URLs textarea (line-wrapped URLs become two malformed entries that Linear silently rejects)

Re-run `bgagent linear setup` after fixing.

### Agent doesn't post comments to Linear

1. Verify the OAuth credential provider exists: `aws bedrock-agentcore-control list-oauth2-credential-providers --region <region>` — look for `linear-oauth-<workspace-slug>`.
2. Verify the workspace is registered: scan `LinearWorkspaceRegistryTable`.
3. Check the agent container logs for `Linear MCP configured at …` — absence means `channel_source` wasn't set on the task or the workspace lookup failed.
4. Check for `WARN linear_reactions: HTTP 401 from Linear` in CloudWatch — usually means the OAuth token in the vault has been revoked from the Linear side. Re-run `bgagent linear setup` to re-authorize.

### Webhook signature verification fails repeatedly

The signing secret in Secrets Manager doesn't match the webhook. Re-run `bgagent linear setup --webhook-secret <new-secret>` and paste the secret from the webhook's detail page (not the OAuth app page).

## Migration from 2.0a (PAK) to 2.0b (OAuth)

If your deployment is on Phase 2.0a (personal API key), 2.0b is a **hard cutover** — there is no `--use-pak` fallback flag. Plan for a short maintenance window (typically <30 min for a single workspace).

> **What changes under the hood.** 2.0a stored a single `LinearApiTokenSecret` (one PAK shared by all teammates) and granted the agent runtime `secretsmanager:GetSecretValue` on that one ARN. 2.0b stores a per-workspace `bgagent-linear-oauth-<slug>` secret containing `{access_token, refresh_token, expires_at, client_id, client_secret, …}`, and replaces the single-ARN grant with a `bgagent-linear-oauth-*` prefix grant. The CDK stack drops the `LinearApiTokenSecret` resource entirely, so there's no automated rollback once 2.0b is deployed.

### Pre-deploy checklist

Run these BEFORE deploying 2.0b so you have everything ready when the maintenance window starts:

1. **List your in-flight tasks.** `bgagent list --status RUNNING --status PENDING` — the migration will not corrupt these, but their final Linear comment may fail because the OAuth token isn't yet authorized when the agent runs.
2. **Pick one Linear workspace to migrate first.** Multi-workspace orgs should rehearse on the lowest-traffic workspace before doing the rest.
3. **Note the workspace's `urlKey`** (the `<slug>` in `linear.app/<slug>/...`). You'll need it for `bgagent linear setup <slug>`.
4. **Confirm CLI admin access.** You need an AWS principal with `secretsmanager:CreateSecret` on `bgagent-linear-oauth-*` AND `dynamodb:PutItem` on `LinearWorkspaceRegistryTable`. Without these, `bgagent linear setup` aborts mid-way (the OAuth dance succeeds, the secret write fails — your Linear OAuth app gets stuck with no usable token).

### Migration steps

1. **Drain the queue.** Wait for in-flight tasks to finish. In-flight tasks at deploy time will fail their final Linear comment because their token resolver short-circuits when neither `LinearApiTokenSecret` (gone) nor `bgagent-linear-oauth-<slug>` (not yet created) is present.
2. **Deploy 2.0b.** `mise //cdk:deploy`. This adds `LinearWorkspaceRegistryTable`, removes the `LinearApiTokenSecret` resource and IAM grants, and adds the `bgagent-linear-oauth-*` prefix grant on the agent runtime + webhook processor + orchestrator.
3. **For each Linear workspace, run [Steps 1–4 above](#step-by-step-setup).** Each workspace needs:
   - A new Linear OAuth app (Settings → API → Applications → Create new app, scopes `read,write,app:assignable,app:mentionable`)
   - `bgagent linear setup <slug>` to run the OAuth dance and write the per-workspace secret
   - The webhook signing secret pasted into the Secrets Manager `LinearWebhookSecret` resource
4. **Re-onboard projects.** If 2.0a had `LinearProjectMappingTable` rows, they survive — but verify with `bgagent linear list-projects` that the listed projects still match what's mapped. The mapping rows are keyed on `linear_project_id` UUID which is stable across the migration.
5. **Verify with a test issue.** Apply the trigger label in each onboarded workspace and confirm the agent posts as `bgagent[bot]` (not as the previous PAK owner's Linear identity). The author byline change is the cleanest signal that OAuth — not the PAK — is on the wire.
6. **Decommission the PAK.** Once 2.0b is verified working, revoke the personal API key in Linear settings ([Linear Settings → Security](https://linear.app/settings/account/security) → Personal API keys → revoke). The PAK is no longer used by any code path; revoking is a clean break with no rollback.

### Rollback

If 2.0b fails verification and you need to revert before doing the OAuth setup:

- The `LinearApiTokenSecret` CFN resource has been deleted, so a `cdk deploy` of the previous commit will recreate it but **the secret value will be empty**. You'd need to re-paste the PAK value manually.
- Recommend instead: **fix-forward**. The 2.0b OAuth dance is a 5-minute step per workspace; rolling back is rarely worth the time.

### What survives the migration

- **`LinearUserMappingTable`** — keyed on Linear identity (organization + user UUID), which is unchanged across PAK→OAuth.
- **`LinearProjectMappingTable`** — keyed on `linear_project_id` UUID, also stable.
- **`LinearWebhookDedupTable`** — TTL-bounded; rows from the maintenance window will TTL out within 8h.
- **GitHub PR comments and Linear-issue mappings** in any in-flight task records.

### What does NOT survive

- `LinearApiTokenSecret` Secrets Manager value — gone with the CDK resource.
- The 2.0a `linear-api-key` AgentCore credential provider (if 2.0a-with-Identity was deployed mid-Phase) — clean it up after with: `aws bedrock-agentcore-control delete-api-key-credential-provider --name linear-api-key`. Phase 2.0b-O2 does not use AgentCore Identity at all, so there's nothing to clean up if you skipped the parked 2.0a-Identity branch.

## Limits and budgets

Linear's API rate limits per OAuth-installed app, per workspace:

| Metric | Limit / hour |
|--------|--------------|
| Requests | 5,000 |
| Complexity points | 3,000,000 |

A typical task makes ~10 Linear API calls (one starting comment, one PR comment, one state transition, one final comment), nowhere near the ceiling. Heavy users should monitor the `X-RateLimit-Requests-Remaining` header in agent logs.

AgentCore Identity quotas worth knowing:

| Metric | Limit |
|--------|-------|
| OAuth2 credential providers per account-region | 50 |
| Workload identities per account-region | (check Service Quotas console) |

Token refresh: Linear access tokens expire in 24h (since April 2026). AgentCore Identity auto-refreshes via the stored refresh token; the agent's `get_resource_oauth2_token` call returns a fresh token transparently.

## What's out of scope in v1.x

- **Comment-driven task triggers**: only labels trigger tasks. Comment commands (e.g. `@bgagent fix this`) are v2+.
- **Self-service user linking**: see Step 7 — admins must insert mapping rows manually until v2.x ships the `@bgagent link` comment flow.
- **Attachments**: tickets are text-only. Linear attachments (mockups, screenshots) are planned via S3 pre-fetch.
- **Per-issue status polling**: use `bgagent status` or watch the Linear issue comments.

## Removing the integration

Deactivate a project mapping:

```bash
aws dynamodb update-item \
  --table-name <LinearProjectMappingTableName> \
  --key '{"linear_project_id":{"S":"<uuid>"}}' \
  --update-expression 'SET #s = :removed' \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":removed":{"S":"removed"}}'
```

Revoke a workspace install:

```bash
aws bedrock-agentcore-control delete-oauth2-credential-provider \
  --name linear-oauth-<workspace-slug> \
  --region <region>

aws dynamodb update-item \
  --table-name <LinearWorkspaceRegistryTableName> \
  --key '{"linear_workspace_id":{"S":"<linear-org-uuid>"}}' \
  --update-expression 'SET #s = :revoked' \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":revoked":{"S":"revoked"}}'
```

Delete the Linear webhook from [Linear Settings → API](https://linear.app/settings/api) and uninstall the OAuth app from [Workspace Settings → Integrations](https://linear.app/settings/integrations) on the Linear side.

To remove the Linear integration from your ABCA deployment entirely, delete the webhook in Linear, uninstall the OAuth app, run the `delete-oauth2-credential-provider` for each workspace, then delete the `LinearIntegration` construct from the stack and redeploy.
