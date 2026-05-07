# Linear integration setup guide

This guide walks through setting up the ABCA Linear integration. Once configured, applying the `bgagent` label to an issue in a mapped Linear project triggers an autonomous task. The agent posts progress comments back on the Linear issue as it works.

## Prerequisites

- ABCA CDK stack deployed (see [Developer guide](./DEVELOPER_GUIDE.md))
- A Cognito user account configured (see [User guide](./USER_GUIDE.md))
- A Linear workspace where you have admin access (to create API keys and webhooks)
- AWS CLI configured with credentials for your ABCA account

## How it works

1. A user adds the `bgagent` label (configurable per project) to a Linear issue.
2. Linear fires a webhook to `POST /v1/linear/webhook`. ABCA verifies the HMAC signature and dedups retries.
3. A processor Lambda resolves the Linear project → GitHub repo mapping and the Linear user → platform user mapping, then creates a task with `channel_source: 'linear'`.
4. The agent clones the repo, writes `.mcp.json` with Linear's hosted MCP server, and runs. It uses `mcp__linear-server__save_comment` / `mcp__linear-server__update_issue` to post updates to the originating issue.
5. The agent opens a PR on GitHub and adds a final comment to the Linear issue with the PR link.

**Authentication for v1** is a Linear personal API key. A single key powers all agent-to-Linear calls for the whole stack. OAuth bot install + multi-workspace is a v3 follow-up.

**Trigger**: only Linear issues with the configured label in a mapped project create tasks. Issues without the label, or in unmapped projects, are ignored. Label removal does not cancel a running task.

## Step-by-step setup

### Step 1: Generate a Linear personal API key

Open [Linear Settings → Security](https://linear.app/settings/account/security), scroll to **Personal API keys**, and create one. Copy the token — it starts with `lin_api_…`. You won't be able to see it again.

This key is used by the agent to post comments and update issue state. Personal API keys are full-workspace-scoped; document internally that you're handing that authority to ABCA.

### Step 2: Run the setup wizard

```bash
bgagent linear setup
```

The wizard prints the exact webhook URL for your deployment, then waits at a **Webhook signing secret:** prompt. Leave it running; go create the webhook in the next step, then return and paste both values.

### Step 3: Create the Linear webhook

In [Linear Settings → API](https://linear.app/settings/api), under **Webhooks**, click **+**:

- **URL**: paste the URL the wizard printed in Step 2.
- **Resource types**: check **Issues** only.
- **Team**: whichever team owns the projects you'll map to ABCA (or all teams).
- Save, then open the webhook's detail page and copy the **signing secret**.

### Step 4: Finish the wizard

Back in your terminal at the paused `bgagent linear setup` prompt:

- Paste the **webhook signing secret** (from Step 3).
- Paste the **personal API key** (from Step 1).

Both are stored in Secrets Manager (`LinearWebhookSecret` and `LinearApiTokenSecret`). The wizard validates that the personal API key starts with `lin_api_`. Full authentication is verified the first time a webhook arrives or the agent calls the Linear MCP.

As a final step, `setup` calls the Linear API with the token you just stored, looks up the token owner, and auto-links that Linear identity to the Cognito user currently logged in to the CLI. This skips the code-exchange ceremony for the common case where one person installs ABCA for their own workspace. If the auto-link fails (token invalid, not logged in, etc.) setup prints a warning and continues — you can always fall back to the manual link flow in Step 6.

### Step 5: Onboard a Linear project

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

**Finding the Linear project UUID.** Linear's project URL (`https://linear.app/<workspace>/project/<slug>-<short>`) contains a *truncated* UUID at the end — that's not the full UUID the webhook sends. List the full UUIDs for all projects visible to the stored API token:

```bash
bgagent linear list-projects
```

Copy the `id` of the project you want to onboard. `onboard-project` validates the UUID format and will reject the truncated slug version with a pointer back to this command.

### Step 6: Link your Linear account

ABCA needs to know which platform user a Linear actor maps to so tasks are attributed correctly.

**The token owner is linked automatically.** `bgagent linear setup` calls Linear's `viewer` query with the token you just pasted and writes the mapping for the Cognito user running the CLI. Look for `✓ Linked Linear user …` in the setup output — if you saw that, you're done. Skip to Step 7.

**Linking additional Linear users** (anyone other than the API-token owner) isn't supported in v1. A comment-triggered flow (`bgagent link` in a Linear comment → receive code → `bgagent linear link <code>`) is a planned follow-up; the `bgagent linear link <code>` CLI command exists today but no Linear-side code generator ships with it yet.

For v1, design the flow around the API-token owner: that person installs ABCA, runs `bgagent linear setup`, and submits tasks on their own behalf. Tasks triggered by other Linear users in the workspace will be dropped by the processor with `"Linear actor has no linked platform user — skipping task creation"`.

### Step 7: Test it

Add the `bgagent` label to a Linear issue in a mapped project. Within a few seconds:

- The Linear webhook Lambda logs an `INFO` entry and invokes the processor.
- The processor creates a task in the `TaskTable` with `channel_source: 'linear'`.
- The agent container starts, clones the repo, and posts a `🤖 Starting on this issue…` comment to the Linear issue.
- When the agent opens a PR, another comment appears with the PR link and the issue transitions to `In Review` (if that state exists).
- On completion or failure, a final status comment is posted.

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
2. Is the label spelled exactly as configured? Match is case-insensitive but must be the same word.
3. Check CloudWatch logs for the `WebhookFn` and `WebhookProcessorFn` Lambdas for `Invalid Linear webhook signature`, `Linear project is not onboarded`, or `Linear actor has no linked platform user`.

### "Linear actor has no linked platform user — skipping task creation"

The Linear user who applied the label hasn't linked their account. Run `bgagent linear link <code>`.

### "Invalid or expired link code"

Link codes expire in 10 minutes. Generate a new one.

### Agent doesn't post comments to Linear

1. Verify the API token is stored: `aws secretsmanager get-secret-value --secret-id <LinearApiTokenSecretArn>` (admin-only).
2. Check the agent container logs for `Linear MCP configured at …` — absence means `channel_source` wasn't set on the task.
3. Check for `${LINEAR_API_TOKEN}` in the MCP handshake — if unresolved, the token secret wasn't piped into the container. Re-deploy.

### Webhook signature verification fails repeatedly

The signing secret in Secrets Manager doesn't match the webhook. Re-run `bgagent linear setup` and paste the secret from the webhook's detail page (not the API key page).

## Limits and budgets

Linear's API rate limits (personal API key, per user):

| Metric | Limit / hour |
|--------|--------------|
| Requests | 5,000 |
| Complexity points | 3,000,000 |

A typical task makes ~10 Linear API calls (one starting comment, one PR comment, one state transition, one final comment), nowhere near the ceiling. Heavy users should monitor the `X-RateLimit-Requests-Remaining` header in agent logs.

## What's out of scope in v1

- **Attachments**: v1 tickets are text-only. Linear attachments (mockups, screenshots) are planned for v1.1 via S3 pre-fetch.
- **OAuth bot install**: v1 uses a single personal API key. OAuth + multi-workspace is v3.
- **Comment-driven triggers**: only labels trigger tasks. Comment commands are v2+.
- **Per-issue status polling**: use `bgagent status` or watch the Linear issue comments.

## Removing the integration

Deactivate a project mapping:

```bash
# manual DynamoDB update — no CLI for this yet
aws dynamodb update-item \
  --table-name <LinearProjectMappingTableName> \
  --key '{"linear_project_id":{"S":"<uuid>"}}' \
  --update-expression 'SET #s = :removed' \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":removed":{"S":"removed"}}'
```

Delete the Linear webhook from [Linear Settings → API](https://linear.app/settings/api).

To remove the Linear integration from your ABCA deployment entirely, delete the webhook in Linear, delete the `LinearIntegration` construct from the stack, and redeploy.
