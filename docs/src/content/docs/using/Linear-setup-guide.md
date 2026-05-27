---
title: Linear setup guide
---

# Linear integration setup guide

Set up the ABCA Linear integration so that applying a label to a Linear issue triggers an autonomous task. The agent posts progress comments back on the issue as it works.

## Prerequisites

- ABCA CDK stack deployed (see [Developer guide](/developer-guide/introduction))
- A Cognito user account configured (see [User guide](/using/overview))
- A Linear workspace where you have **admin** access
- The `bgagent` CLI installed and logged in (`bgagent configure` + `bgagent login`)

## How it works

A Linear-workspace admin creates a Linear OAuth app and authorizes it on the workspace. The OAuth token is stored in a per-workspace Secrets Manager secret (`bgagent-linear-oauth-<slug>`). When a user adds the trigger label to a Linear issue, Linear fires a webhook to ABCA; the receiver verifies the HMAC, looks up the workspace, refreshes the access token if needed, and creates a task. The agent clones the repo, opens a PR, and comments on the Linear issue as `bgagent[bot]`.

**Multi-workspace**: a single ABCA deployment can serve multiple Linear workspaces. Each workspace gets its own per-workspace OAuth secret + signing secret. Webhook subscriptions are workspace-scoped (Linear generates a fresh signing secret per subscription), so each workspace must configure its own webhook in Linear.

## Setup walkthrough

This walkthrough covers both the first install and adding additional workspaces. The branching is small — call out at each step which commands run for which case.

### 1. Decide the workspace `<slug>`

The slug is the URL key from `https://linear.app/<slug>/...`. Find it in Linear → Settings → Workspace → URL key, or look at any URL while logged into the workspace.

### 2. Create a Linear OAuth app

```bash
bgagent linear app-template
```

The command prints exact field values to paste. Open [Linear Settings → API → New application](https://linear.app/settings/api/applications/new) (signed into the right workspace — use Linear's sidebar workspace switcher if needed) and fill in the fields exactly as the template lists.

The template marks which fields are required for the `actor=app` agent flow; missing them produces a cryptic "Invalid redirect_uri" error.

Click **Save**, then copy the **Client ID** and **Client Secret** from the app's detail page.

> **Adding a second workspace?** You only need a new OAuth app if you want per-workspace isolation. Otherwise, edit your existing app and toggle **Public: ON** so it can be authorized from any workspace. Trade-off: shared apps revoke together; per-workspace apps don't.

### 3. Authorize the app on the workspace

For your first workspace:

```bash
bgagent linear setup <slug>
```

For each additional workspace after the first:

```bash
bgagent linear add-workspace <slug>
```

Both commands prompt for the **Client ID** and **Client Secret**, open your browser to Linear's consent screen, and store the OAuth token bundle. **Make sure your browser is signed into the right workspace** before authorizing — that's where the app gets installed.

`add-workspace` defaults the Client ID to the existing workspace's value; press Enter to reuse it (Public app), or paste a new one (per-workspace app).

`setup` also pauses at a `Webhook signing secret:` prompt and you can finish the webhook configuration inline. `add-workspace` exits after the OAuth dance — you'll configure the webhook in steps 4–5.

### 4. Configure the Linear webhook

```bash
bgagent linear webhook-info
```

This prints the URL and values to paste into Linear. Open `https://linear.app/<slug>/settings/api/webhooks` and create the webhook with those values.

Then open the webhook detail page and copy the **signing secret** (`lin_wh_…`).

### 5. Tell ABCA the signing secret

If you ran `setup` and it's paused at `Webhook signing secret:`, paste the value there.

If you ran `add-workspace` (or you skipped step 4 during `setup`):

```bash
bgagent linear update-webhook-secret <slug>
```

Paste the secret at the prompt. ABCA stores it on the workspace's per-workspace OAuth bundle — the receiver Lambda looks it up by `organizationId` at verify time.

### 6. Link your Linear identity to your platform user

```bash
bgagent linear link-user <slug>
```

You'll be prompted for your **Linear user UUID in this workspace**. Find it by running `query { viewer { id } }` against `https://api.linear.app/graphql` while logged in as yourself, or trigger an issue first and grep CloudWatch for `linear_user_id` in the resulting "no linked platform user" warning.

The command writes a row mapping `(workspace, linear-user) → your Cognito sub`. Without this row, **every Linear-triggered task you submit is silently dropped** — see [Why this step exists](#why-link-user-is-required) below.

For each teammate who'll trigger tasks from Linear, run `link-user` once with their Linear UUID and Cognito sub:

```bash
bgagent linear link-user <slug> \
  --linear-user-id <their-linear-uuid> \
  --platform-user-id <their-cognito-sub>
```

### 7. Onboard a project

```bash
bgagent linear list-projects --slug <slug>     # find the project UUID
bgagent linear onboard-project <project-uuid> --repo owner/repo --label abca
```

Default trigger label is `bgagent`; pass `--label <name>` to override.

Optional flags on `onboard-project`: `--team-id` (Linear team UUID, debug only), `--region`, `--stack-name`.

### 8. Test

Apply the trigger label to a Linear issue in the onboarded project. The agent should start within ~30 seconds, post a `🤖 Starting on this issue…` comment, then a PR link when ready.

## Why `link-user` is required

ABCA's `actor=app` OAuth flow installs the Linear app under a synthetic **bot user** (e.g. `<uuid>@oauthapp.linear.app`). Linear's `viewer` query during `setup` returns this bot user's UUID — not the human admin who clicked Authorize. So we can't auto-link the admin from the OAuth dance the way we could under v1's PAK flow (where the API token's owner *was* the human).

`link-user` is the explicit, no-magic mapping step. One row per human who'll trigger tasks from Linear, per workspace. Run it once per teammate; the row never expires.

## How webhook signature verification works

Linear generates a fresh signing secret **per webhook subscription**, and webhook subscriptions are **workspace-scoped**. Multi-workspace ABCA installs need each workspace's signing secret stored separately, indexed by `organizationId`.

ABCA stores each workspace's signing secret on its per-workspace OAuth bundle (`bgagent-linear-oauth-<slug>`). On each event, the webhook receiver:

1. Parses the body to extract `organizationId` (untrusted at this point — only used to select which secret to verify against).
2. Looks up the registry row for that `organizationId`. If `status='active'` and the bundle has a `webhook_signing_secret`:
   - Verify HMAC. If it matches → trusted, dispatch.
   - If it doesn't match → reject 401. **No fallback** to the stack-wide secret; that would let an attacker bypass the per-workspace secret.
3. If the registry has no row, or the bundle lacks `webhook_signing_secret` (pre-migration single-workspace install), fall back to the stack-wide `LinearWebhookSecret`. Match → trusted; no match → 401.

The fallback path keeps existing single-workspace deployments working without re-onboarding. Migration to the per-workspace shape happens automatically the next time you run `bgagent linear setup <slug>`.

**Trust model.** The `organizationId` in the body is attacker-controlled, but it only **selects** which secret to verify against; an attacker still needs the matching signing secret to forge a valid signature. Cross-workspace impersonation is prevented by the no-fallback-on-mismatch rule.

## Usage

- **Trigger a task**: apply the trigger label to an issue in a mapped Linear project. The issue title + description becomes the task description.
- **Check status**: from the Linear issue (progress comments) or `bgagent list` / `bgagent status <task-id>`.
- **Cancel**: `bgagent cancel <task-id>`. Removing the Linear label does not cancel a running task.

## Troubleshooting

### Webhook doesn't trigger a task

- Is the project mapped? `aws dynamodb scan --table-name <LinearProjectMappingTableName>`
- Is the workspace registered? Scan `LinearWorkspaceRegistryTable` for the `organizationId` from the webhook payload.
- Is the label spelled exactly as configured? Match is case-insensitive but must be the same word.
- Check CloudWatch logs for `WebhookFn` and `WebhookProcessorFn` — common errors include `Invalid Linear webhook signature`, `Linear workspace is not onboarded`, `Linear project is not onboarded`, `Linear actor has no linked platform user`.

### Webhook signature verification fails repeatedly

The signing secret stored on this workspace's OAuth bundle doesn't match the webhook subscription Linear is sending from. Most often: you configured the webhook in Linear but didn't run `update-webhook-secret` (or rotated the secret in Linear without re-running it). Fix:

```bash
bgagent linear update-webhook-secret <slug>
```

To inspect what's currently stored:

```bash
aws secretsmanager get-secret-value --secret-id bgagent-linear-oauth-<slug> --query SecretString --output text | jq .webhook_signing_secret
```

If the failing event's `organizationId` doesn't match any registered workspace and the stack-wide secret also doesn't match, you have a webhook configured in a Linear workspace you haven't onboarded — either onboard it via `add-workspace` or remove the webhook in Linear.

### "Invalid redirect_uri parameter for the application" during step 3

Linear's misleading error for `actor=app` flows where the OAuth app config is incomplete. In your Linear app settings:

- **GitHub username** must end with `[bot]` (e.g. `bgagent[bot]`)
- **Webhooks** toggle must be ON
- The Callback URL must be on a **single line** (line-wrapped URLs become two malformed entries Linear silently rejects)

Re-run `bgagent linear setup` after fixing.

### Agent doesn't post comments to Linear

- Verify the per-workspace OAuth secret exists: `aws secretsmanager describe-secret --secret-id bgagent-linear-oauth-<slug>`.
- Verify the registry row's `oauth_secret_arn` matches that secret and `status = 'active'`.
- Check the agent container logs for `Linear MCP configured at …`. Absence means `channel_source` wasn't set on the task or the workspace lookup failed.
- Check for `WARN linear_reactions: HTTP 401 from Linear` — usually means the refresh token was revoked Linear-side. Re-run `bgagent linear setup <slug>`.
- Check for `resolve_linear_api_token: invalid_grant` — Linear permanently rejected the refresh token. Re-run `bgagent linear setup <slug>` to issue a new one.

## Limits and quotas

Linear API rate limits per OAuth-installed app, per workspace: **5,000 requests/hour, 3,000,000 complexity points/hour**. A typical task makes ~10 Linear API calls — nowhere near the ceiling.

Linear access tokens expire in 24h. The webhook processor and orchestrator auto-refresh via the stored `refresh_token` and write the rotated token back to Secrets Manager. If Linear returns `invalid_grant` (a concurrent caller already refreshed), the resolver re-reads the secret and uses the freshly-rotated token.

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
aws secretsmanager delete-secret --secret-id bgagent-linear-oauth-<slug> --force-delete-without-recovery

aws dynamodb update-item \
  --table-name <LinearWorkspaceRegistryTableName> \
  --key '{"linear_workspace_id":{"S":"<linear-org-uuid>"}}' \
  --update-expression 'SET #s = :revoked' \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":revoked":{"S":"revoked"}}'
```

Then delete the Linear webhook from [Linear Settings → API](https://linear.app/settings/api) and uninstall the OAuth app from [Workspace Settings → Integrations](https://linear.app/settings/integrations) on the Linear side.
