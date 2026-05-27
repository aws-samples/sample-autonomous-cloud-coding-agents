---
title: Linear setup guide
---

# Linear integration setup guide

This guide walks through setting up the ABCA Linear integration. Once configured, applying the `bgagent` label to an issue in a mapped Linear project triggers an autonomous task. The agent posts progress comments back on the Linear issue as it works.

> **Phase 2.0b** — ABCA now authenticates to Linear via OAuth (`actor=app`) instead of a personal API key. One per-workspace OAuth secret in AWS Secrets Manager, one OAuth app (or one per workspace, your choice). Personal API keys are no longer supported (see [Migration from 2.0a (PAK) to 2.0b (OAuth)](#migration-from-20a-pak-to-20b-oauth) below).

## Prerequisites

- ABCA CDK stack deployed (see [Developer guide](/developer-guide/introduction))
- A Cognito user account configured (see [User guide](/using/overview))
- A Linear workspace where you have **admin** access (you'll create an OAuth app and install it on the workspace)
- AWS CLI configured with credentials for your ABCA account, with `bedrock-agentcore-control:*` permissions on the deployment region
- The `bgagent` CLI installed and logged in (`bgagent configure` + `bgagent login`)

## How it works

1. A Linear-workspace admin creates a Linear OAuth app and authorizes it on the workspace via `bgagent linear setup`. The workspace's OAuth token (access + refresh) is stored in a per-workspace Secrets Manager secret named `bgagent-linear-oauth-<slug>`. **One install per workspace, used by all teammates** — this matches the v1 personal-API-key semantics.
2. A user adds the `bgagent` label (configurable per project) to a Linear issue.
3. Linear fires a webhook to `POST /v1/linear/webhook`. ABCA verifies the HMAC signature and dedups retries.
4. A processor Lambda looks up the Linear `organizationId` in `LinearWorkspaceRegistryTable` to find that workspace's OAuth secret ARN, reads the secret, refreshes the access token if expiring, then resolves the project → repo mapping and creates a task with `channel_source: 'linear'`.
5. The agent clones the repo, writes `.mcp.json` with Linear's hosted MCP server using the freshly-resolved access token, and runs. It uses `mcp__linear-server__save_comment` / `mcp__linear-server__update_issue` to post updates as `bgagent[bot]` (the OAuth app's identity).
6. The agent opens a PR on GitHub and adds a final comment to the Linear issue with the PR link.

**Trigger**: only Linear issues with the configured label in a mapped project create tasks. Issues without the label, or in unmapped projects, are ignored. Label removal does not cancel a running task.

**Multi-workspace**: a single ABCA deployment can serve multiple Linear workspaces. Each workspace gets its own per-workspace OAuth secret via `bgagent linear add-workspace`. See [Adding additional Linear workspaces](#adding-additional-linear-workspaces) for details, including the per-workspace OAuth-app option needed when Linear apps are kept private.

> **Phase 2.0a (parked).** The previous design routed OAuth through AgentCore Identity credential providers. That path is parked — Phase 2.0b-O2 (shipped) reads Secrets Manager directly because AgentCore Identity's `USER_FEDERATION` flow has an open service-side bug. The setup steps below describe the shipped flow only.

## Step-by-step setup

### Step 1: Create the Linear OAuth app

Run:

```bash
bgagent linear app-template
```

This prints the exact field values to paste into Linear's OAuth app form. Open [Linear Settings → API → New application](https://linear.app/settings/api/applications/new) (make sure you're signed into the workspace where you want the app to live — use Linear's workspace switcher in the sidebar if needed) and fill in the fields the template lists. Critical fields (each gates the `actor=app` agent flow — without them Linear surfaces a misleading "Invalid redirect_uri" error):

- **GitHub username**: must end with the literal `[bot]` suffix (e.g., `bgagent[bot]`)
- **Webhooks**: toggle ON (the URL value can be a placeholder; we don't subscribe to events for the OAuth flow itself)
- **Callback URLs**: `http://localhost:8080/oauth/callback` — the localhost server `bgagent linear setup` listens on for the redirect. Wildcards are not accepted; if you serve setup from multiple machines, register each callback URL fully.
- **Public**: leave OFF unless you plan to install this app in multiple Linear workspaces — see [Adding additional Linear workspaces](#adding-additional-linear-workspaces) for the trade-offs.

> **Note.** The `app-template` command currently prints a placeholder for the AWS-hosted callback URL referencing the parked Phase 2.0a flow. The actual callback for the shipped Phase 2.0b-O2 flow is `http://localhost:8080/oauth/callback`. The template will be updated to print this value once the parked path is removed; for now, override the placeholder when you paste into Linear.

Click **Save**, then copy the **Client ID** and **Client Secret** from the app's detail page.

### Step 2: Authorize via OAuth

```bash
bgagent linear setup <workspace-slug>
```

Where `<workspace-slug>` is the Linear `urlKey` of the workspace (e.g. `acme` from `https://linear.app/acme/...`).

The wizard:

1. Prompts for the **Client ID** and **Client Secret** you copied at the end of Step 1 (or pass them via `--client-id` / `--client-secret`).
2. Generates a PKCE code verifier + challenge and starts an ephemeral HTTP server on `localhost:8080` to listen for the callback.
3. Opens Linear's authorization URL in your browser. **Make sure your browser is currently signed into the right workspace** (use Linear's workspace switcher if needed); this is the workspace the app is being installed in.
4. You authorize the OAuth app on the Linear consent screen — Linear redirects to `http://localhost:8080/oauth/callback?code=...&state=...`.
5. The wizard exchanges the code for an `access_token` + `refresh_token`, queries Linear's `viewer { id, organization { id, urlKey } }`, and:
   - Creates `bgagent-linear-oauth-<slug>` in Secrets Manager with the full token bundle (access, refresh, expires_at, scope, client_id, client_secret, workspace metadata).
   - Writes a row into `LinearWorkspaceRegistryTable` with `(linear_workspace_id, workspace_slug, oauth_secret_arn, status='active')`.
   - Auto-links you in `LinearUserMappingTable` so tasks you trigger via Linear get attributed to your Cognito user.
6. Then prompts for the **webhook signing secret** — see Step 3 below for where to find it.

> **Where the OAuth token lives.** Stored in Secrets Manager at `bgagent-linear-oauth-<slug>`, with `client_id` + `client_secret` co-located in the same secret so Lambda-side refresh works without per-Lambda env vars. Lambdas refresh on demand and write the rotated token back; the agent runtime has read-only access (S1 hardening — untrusted repo code can't overwrite tokens).

### Step 3: Configure the Linear webhook

While `bgagent linear setup` is paused at the `Webhook signing secret:` prompt, open [Linear Settings → API](https://linear.app/settings/api) → **Webhooks** → **+**:

- **URL**: `https://<your-api-id>.execute-api.<region>.amazonaws.com/v1/linear/webhook` — find this in the CloudFormation stack's `ApiUrl` output, or look up your API Gateway in the AWS console
- **Resource types**: check **Issues** only
- **Team**: whichever team owns the projects you'll map to ABCA (or all teams)

Save, then open the webhook's detail page and copy the **signing secret** (starts with `lin_wh_`). Paste it back into the terminal where setup is paused.

> **Where the signing secret is stored.** `bgagent linear setup` stores the signing secret on the workspace's per-workspace OAuth bundle (`bgagent-linear-oauth-<slug>`), where the webhook receiver looks it up by `organizationId` at verify time. On the first install, it's also mirrored into the stack-wide `LinearWebhookSecret` for back-compat with single-workspace deployments — see [How webhook signature verification works](#how-webhook-signature-verification-works) for the full story.

> **Re-running setup later** skips the webhook prompt if the signing secret is already configured. To rotate the signing secret without re-running the OAuth dance, use [`bgagent linear update-webhook-secret <slug>`](#webhook-signature-verification-fails-repeatedly).

### Step 4: Onboard a Linear project

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

### Step 5: Link your Linear account (optional but recommended)

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

### Step 6: Test it

Add the `bgagent` label to a Linear issue in a mapped project. Within a few seconds:

- The Linear webhook Lambda logs an `INFO` entry and invokes the processor.
- The processor looks up `LinearWorkspaceRegistryTable` by the webhook's `organizationId`, reads the workspace's OAuth secret from Secrets Manager (refreshing the access token if expiring), and creates a task in `TaskTable` with `channel_source: 'linear'`.
- The agent container starts, clones the repo, and posts a `🤖 Starting on this issue…` comment as `bgagent[bot]`.
- When the agent opens a PR, another comment appears with the PR link and the issue transitions to `In Review` (if that state exists).
- On completion or failure, a final status comment is posted.

## Adding additional Linear workspaces

A single ABCA deployment can serve multiple Linear workspaces. Once you've completed initial `bgagent linear setup` for one workspace, additional workspaces use the lighter `add-workspace` command:

```bash
bgagent linear add-workspace <workspace-slug>
```

This:

- Prompts for the OAuth Client ID — defaults to the existing workspace's value (Enter to reuse, or paste a different one for a per-workspace OAuth app)
- Prompts for the Client Secret if you supplied a new Client ID; otherwise reuses the existing one
- Runs the OAuth dance against the new workspace
- Creates `bgagent-linear-oauth-<slug>` in Secrets Manager and writes a registry row
- **Prompts for the webhook signing secret** — Linear generates a fresh signing secret per webhook subscription, and webhook subscriptions are workspace-scoped, so each workspace must configure its own webhook in Linear and bring its own signing secret
- Refuses to silently overwrite an already-onboarded workspace's registry row (use `setup` to re-authorize an existing workspace)

### One OAuth app for all workspaces vs. one per workspace

Linear OAuth apps are **workspace-scoped at install time**:

- A **private** Linear OAuth app (default) can only be authorized from the workspace that created it. Trying to install it in a second workspace returns `Could not find OAuth client with clientId <id>`.
- A **public** Linear OAuth app can be authorized from any workspace by anyone with the install URL. The client_secret is still yours; "public" only means "anyone can run the consent flow." For a self-hosted ABCA install this is usually fine.

Pick one of:

**Option A: Single shared OAuth app (recommended for personal demos and single-org setups).** In your initial workspace's Linear settings, edit the OAuth app and toggle **Public: ON**. Then `bgagent linear add-workspace <new-slug>` works without `--client-id`. Cleanest UX, single point of revocation.

**Option B: Separate OAuth app per workspace (recommended for multi-org / production setups).** Create a new OAuth app in each new workspace's Linear settings (Step 1 above), then pass the new credentials explicitly:

```bash
bgagent linear add-workspace <new-slug> \
  --client-id <new-id> --client-secret <new-secret>
```

Per-workspace apps give cleaner revocation, per-workspace branding, and isolation if one workspace's credentials leak. Each new app needs its own callback URL (`http://localhost:8080/oauth/callback`) and its own `bgagent[bot]` GitHub username.

There's no AWS-side ceiling on the number of installable workspaces — each is just an SM secret + DDB row. Practical limits are Linear's API rate limits and per-workspace operator overhead.

## How webhook signature verification works

Linear generates a fresh signing secret **per webhook subscription**, and webhook subscriptions are **workspace-scoped**. There's no Linear-side mechanism to share one signing secret across multiple workspaces. So multi-workspace ABCA installs need each workspace's signing secret stored separately, indexed by `organizationId` (the workspace UUID embedded in the webhook payload).

ABCA stores each workspace's signing secret on its per-workspace OAuth bundle (`bgagent-linear-oauth-<slug>`, alongside the access/refresh tokens). The webhook receiver runs this verification flow on each event:

1. Parse the body to extract `organizationId` (untrusted at this point — only used to select which secret to verify against, never trusted before the signature passes).
2. Look up the registry row for that `organizationId`. If `status='active'` and the OAuth bundle has a `webhook_signing_secret` field:
   - Verify the HMAC. If it matches → event is trusted, dispatch to the processor.
   - If it doesn't match → reject 401. **No fallback** to the stack-wide secret — that would let an attacker bypass the per-workspace secret by signing with whatever the stack-wide one happens to be.
3. If the registry has no row, or the OAuth bundle lacks `webhook_signing_secret` (pre-migration single-workspace install), fall back to the stack-wide `LinearWebhookSecret` and verify against that. If it matches → trusted; if not → 401.

The fallback path keeps existing single-workspace deployments working without re-onboarding. The migration to the per-workspace shape happens automatically the next time you run `bgagent linear setup <slug>` — it reads the existing stack-wide secret and mirrors it onto the workspace's OAuth bundle without re-prompting.

**Trust model.** The `organizationId` in the body is attacker-controlled — they can claim any workspace. But it only **selects** which secret to verify against; an attacker still needs the matching signing secret to forge a valid signature, which they don't have. Cross-workspace impersonation is prevented by the no-fallback-on-mismatch rule above.

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

The Linear user who applied the label hasn't been mapped to a Cognito user. See [Step 5](#step-5-link-your-linear-account-optional-but-recommended).

### "Invalid redirect_uri parameter for the application" during Step 4

This is Linear's misleading error for `actor=app` flows where the OAuth app config is incomplete. Check, in your Linear app settings:

- **GitHub username** field is set to a value ending in `[bot]` (e.g. `bgagent[bot]`)
- **Webhooks** toggle is ON
- The AWS-hosted callback URL is on a **single line** in the Callback URLs textarea (line-wrapped URLs become two malformed entries that Linear silently rejects)

Re-run `bgagent linear setup` after fixing.

### Agent doesn't post comments to Linear

1. Verify the per-workspace OAuth secret exists: `aws secretsmanager describe-secret --secret-id bgagent-linear-oauth-<workspace-slug> --region <region>`.
2. Verify the workspace is registered: scan `LinearWorkspaceRegistryTable` and confirm the row's `oauth_secret_arn` matches the secret from step 1 and `status = 'active'`.
3. Check the agent container logs for `Linear MCP configured at …` — absence means `channel_source` wasn't set on the task or the workspace lookup failed.
4. Check for `WARN linear_reactions: HTTP 401 from Linear` in CloudWatch — usually means the refresh token has been revoked from the Linear side, or the workspace admin uninstalled the app. Re-run `bgagent linear setup <slug>` to re-authorize.
5. Check for `resolve_linear_api_token: invalid_grant` in CloudWatch — Linear permanently rejected the refresh token (rotation race or revocation). Re-run `bgagent linear setup <slug>` to issue a new refresh token.

### Webhook signature verification fails repeatedly

Most likely the signing secret stored on this workspace's OAuth bundle doesn't match the webhook subscription that Linear is sending from. Run:

```bash
bgagent linear update-webhook-secret <slug>
```

Paste the current signing secret from Linear's webhook detail page. This works for any installed workspace — it skips the OAuth dance entirely (Linear refuses to re-issue codes for already-installed apps) and just updates the per-workspace `webhook_signing_secret` field on the SM bundle.

To inspect what's currently stored:

```bash
aws secretsmanager get-secret-value --secret-id bgagent-linear-oauth-<slug> --query SecretString --output text | jq .webhook_signing_secret
```

Other failure modes:

- **You rotated the signing secret in Linear but never updated ABCA** — same fix as above.
- **You're running multi-workspace and the wrong webhook (from a different workspace) is targeting your ABCA endpoint** — check the `organizationId` field in the failing webhook's payload (CloudWatch log on the receiver Lambda) against the registry table. If it doesn't match any registered workspace and the stack-wide secret also doesn't match, you have a webhook configured in a Linear workspace you haven't onboarded — either onboard it via `add-workspace` or remove the webhook in Linear.

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

AWS quotas worth knowing:

| Metric | Limit |
|--------|-------|
| Secrets Manager secrets per region | 500,000 (soft) |
| Secrets Manager `GetSecretValue` ops/sec | 10,000 |

Token refresh: Linear access tokens expire in 24h (since April 2026). The webhook processor and orchestrator auto-refresh via the stored `refresh_token` and write the rotated token back to Secrets Manager. Race recovery: if Linear returns `invalid_grant` (a concurrent caller already refreshed), the resolver re-reads the secret and uses the freshly-rotated token without a second `/oauth/token` POST.

## What's out of scope in v1.x

- **Comment-driven task triggers**: only labels trigger tasks. Comment commands (e.g. `@bgagent fix this`) are v2+.
- **Self-service user linking**: see Step 5 — admins must insert mapping rows manually until v2.x ships the `@bgagent link` comment flow.
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
