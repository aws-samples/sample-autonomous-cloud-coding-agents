---
title: Linear setup guide
---

# Linear integration setup guide

Set up the ABCA Linear integration so that applying a label to a Linear issue triggers an autonomous task. The agent posts progress comments back on the issue as it works.

## Prerequisites

- ABCA CDK stack deployed (see [Developer guide](/sample-autonomous-cloud-coding-agents/developer-guide/introduction))
- A Cognito user account configured (see [User guide](/sample-autonomous-cloud-coding-agents/using/overview))
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

> **⚠️ Do NOT enable Linear "agent" / app-notification events on the OAuth app.** ABCA is a **comment-based** integration: it posts a maturing threaded reply and reacts 👀→✅ on ordinary Linear comments. If the OAuth app is configured as a Linear **agent** (agent-session / app-notification events turned on), Linear renders an `@mention` of the app as its **interactive agent-activity surface** instead of a normal comment thread — which breaks the reply/reaction UX (mentions appear "interactive" and the agent's comment thread doesn't behave like a comment). ABCA does not consume agent-session events; the webhook receiver ignores them and logs a WARN naming the workspace. **Leave agent/app events OFF and rely on the Issues + Comments webhook events (step 4).** If comments start behaving "interactively" instead of as threads, this toggle is the cause.

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

Under **Resource types**, enable both **Issues** and **Comments**:

- **Issues** — label-triggered tasks and parent/sub-issue epic orchestration.
- **Comments** — the `@bgagent` re-iteration trigger: a reviewer comments `@bgagent <change>` on a sub-issue and ABCA updates that sub-issue's PR, then re-stacks its dependents. Without the Comments subscription this trigger silently never fires.

Then open the webhook detail page and copy the **signing secret** (`lin_wh_…`).

### 5. Tell ABCA the signing secret

If you ran `setup` and it's paused at `Webhook signing secret:`, paste the value there.

If you ran `add-workspace` (or you skipped step 4 during `setup`):

```bash
bgagent linear update-webhook-secret <slug>
```

Paste the secret at the prompt. ABCA stores it on the workspace's per-workspace OAuth bundle — the receiver Lambda looks it up by `organizationId` at verify time.

### 6. Onboard a project

```bash
bgagent linear list-projects --slug <slug>     # find the project UUID
# Add --decompose-allowed if you want the bgagent:decompose / bgagent:auto
# planning flow on this project (it is OFF by default).
bgagent linear onboard-project <project-uuid> --repo owner/repo --label abca --decompose-allowed
```

Default trigger label is `bgagent`; pass `--label <name>` to override.

Optional flags on `onboard-project`: `--decompose-allowed` (enable the `bgagent:decompose` / `bgagent:auto` Mode-B planning flow — **off by default**, so without it those labels silently run as a single task), `--team-id` (Linear team UUID, debug only), `--region`, `--stack-name`.

### 7. Test

Apply the trigger label to a Linear issue in the onboarded project. The agent should start within ~30 seconds, post a `🤖 Starting on this issue…` comment, then a PR link when ready.

## Inviting teammates

The setup walkthrough offers an inline self-link picker that lets the **person running the wizard** map their own Linear identity to their Cognito sub. To onboard additional teammates so they can trigger tasks from Linear from their own ABCA accounts, run:

### Admin: generate the invite

```bash
bgagent linear invite-user <slug>
```

The CLI shows a picker of human Linear members in the workspace. After you pick the teammate, it generates a one-time code (24h TTL) and prints a CLI command to send them via Slack/email/etc.

### Teammate: redeem the invite

The teammate needs their own ABCA account first (Cognito user + configured CLI). If they don't have one yet:

1. **Admin** runs `bgagent admin invite-user teammate@example.com` to create their Cognito user (see [User guide → Joining an existing deployment](/sample-autonomous-cloud-coding-agents/using/overview#joining-an-existing-deployment) for the full Cognito-side flow).
2. **Teammate** pastes the bundle + password from the admin into:

   ```bash
   bgagent configure --from-bundle <bundle>
   bgagent login --username teammate@example.com
   ```

3. **Teammate** redeems the Linear invite code:

   ```bash
   bgagent linear link <code>
   ```

   The CLI shows them the Linear identity name+email and asks for confirmation **before** writing the mapping row. If the admin picked the wrong member, the teammate sees the mismatch and aborts. After confirmation, the binding is recorded — the teammate can now apply the trigger label to a Linear issue and it'll fire as a task under their ABCA account (their concurrency, their cost attribution, their notifications).

### Why this two-step handshake

ABCA's `actor=app` OAuth flow installs the Linear app under a synthetic **bot user** (e.g. `<uuid>@oauthapp.linear.app`). Linear's `viewer` query during `setup` returns this bot user — not the human who clicked Authorize. Setup gets around this by showing a member picker so the admin can self-link inline.

For teammates, the admin can't authenticate as them — so `invite-user` separates the two halves of the binding: admin asserts the Linear identity (picker), teammate confirms with their own Cognito-authenticated CLI session. No PAKs change hands; no admin can silently misattribute since the teammate sees the identity before confirming.

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

## Attachments and documents

Beyond the issue title and description, Linear stores additional context the agent may need:

- **Paperclip attachments** (PDFs, logs, spec files attached to an issue)
- **Project documents** (Linear's wiki-style docs attached to a project)
- **Comments posted after the task starts** (clarifications, approve / deny signals)

ABCA does not pre-fetch this material into S3 or run it through Bedrock Guardrails — it stays in Linear, and the agent fetches it on demand at runtime via the Linear MCP. Concretely:

- The webhook processor calls Linear's GraphQL API once per triggered issue to check for paperclip attachments and project documents. If anything is present it prepends a one-line hint (`Linear may have additional context for this issue: …`) to the task description, naming the relevant MCP tools.
- The agent's system prompt addendum tells it to call `mcp__linear-server__get_issue` for the full issue (including the `attachments` connection), `mcp__linear-server__get_attachment` per paperclip, `mcp__linear-server__list_documents` / `get_document` for project wikis, and `mcp__linear-server__list_comments` before opening the PR to pick up new comments.

No additional setup is required — once Linear MCP is wired (steps above), this works automatically. Only embedded markdown images in the issue description (`![alt](https://…)`) are still pre-fetched and screened at task-creation time, because they enter the agent's context as URL attachments.

## Usage

- **Trigger a task**: apply the trigger label to an issue in a mapped Linear project. The issue title + description becomes the task description.
- **Check status**: from the Linear issue (progress comments) or `bgagent list` / `bgagent status <task-id>`.
- **Cancel**: `bgagent cancel <task-id>`. Removing the Linear label does not cancel a running task.

## Trigger labels

The base trigger label (default `bgagent`, or whatever you passed to `--label` at onboarding) has three variants. All examples below assume the default `bgagent`; substitute your workspace's label if you overrode it.

| Label | What it does | Use it when |
|-------|--------------|-------------|
| `bgagent` | **Do it.** Reads the issue, makes the change, opens a PR. If the issue already has sub-issues, it runs those in dependency order instead (see [orchestration](#parentsub-issue-orchestration)). | The issue is a single, well-defined piece of work. |
| `bgagent:decompose` | **Plan it first.** Breaks a larger issue into a set of smaller sub-issues, posts the plan as a comment, and **waits for your approval** before creating or running anything. | The issue has several parts and you want to review the breakdown (and its worst-case cost) before spending. |
| `bgagent:auto` | **Plan it and start immediately** — same breakdown as `:decompose`, but no approval step. | You trust ABCA to split the work and want it to just go. |
| `bgagent:help` | **Explain the labels.** Posts a one-time comment describing what each label does, then creates no task. Remove it afterward. | You're new to ABCA on this issue and want a reminder of the options. |

> **Create these labels in Linear and give each a one-line description.** ABCA matches labels by name, so you create them yourself (Linear → Settings → Labels, or inline on any issue). Add a short description to each — Linear shows it on hover in the label picker, which is the only discoverability a first-time teammate gets. Suggested descriptions: **`bgagent`** — "Hand this issue to ABCA — makes the change and opens a PR"; **`bgagent:decompose`** — "ABCA proposes a plan first and waits for your approval"; **`bgagent:auto`** — "ABCA plans and starts immediately, no approval"; **`bgagent:help`** — "ABCA explains what its labels do". Grouping them under a shared label prefix/group also keeps them together and away from unrelated labels in the picker.

Notes:

- **The approval conversation is interactive.** After a `:decompose` plan is posted, reply `@bgagent approve` to run it, `@bgagent reject` to discard it, or just tell it what to change in plain language — e.g. `@bgagent make it 2 tasks instead of 3` — and it re-plans and posts an updated breakdown. Repeat until you're happy, then approve.
- **A plain `bgagent` label on a multi-part issue still runs as one task.** If the description looks like it has several parts, ABCA posts a one-line hint suggesting `:decompose` — but it does **not** block the single-task run it already started. If you wanted a plan, add `:decompose` instead.
- **`:decompose` / `:auto` on an issue that already has sub-issues** is a no-op suffix — there's nothing to decompose, so ABCA just runs the existing sub-issue graph (Mode A).
- **Once ABCA is working**, reply to its comments with `@bgagent <what you want>` to ask a question or request a change.
- **Per-project caps** (max sub-issues, max total budget) are set at onboarding and apply to `:decompose` / `:auto`; an over-cap plan is rejected with an explanatory comment.

## Parent/sub-issue orchestration

If you apply the trigger label to a **parent issue that has sub-issues**, ABCA orchestrates the whole epic instead of creating one task:

1. **Discovery** — it reads the sub-issues and their `blocked by` / `blocking` relations, builds a dependency graph (DAG), and rejects cycles with a terminal comment on the parent.
2. **Dependency-ordered execution** — root sub-issues (no blockers) start immediately; a blocked sub-issue does not start until **all** its blockers reach terminal-success (a sub-issue that completes but fails its build does **not** release its dependents). Independent sub-issues run in parallel.
3. **Stacked PRs** — a sub-issue with a single predecessor branches from that predecessor's branch (so it sees its code before merge); a sub-issue with multiple predecessors branches from the default branch and merges all predecessor branches in. Review/merge the resulting stack bottom-up.
4. **Rollup** — when every sub-issue reaches a terminal state, ABCA posts an aggregate **rollup comment on the parent** (succeeded / failed / skipped counts + per-child status). Each sub-issue also gets its own final-status comment.
5. **Failure handling** — if a sub-issue fails (or is cancelled), its transitive dependents are **skipped** (never started); independent siblings still finish. The parent rollup reflects the partial outcome.

### Adding a sub-issue to a running (or finished) epic

The graph is read **at trigger time**, so a sub-issue created after the epic started is *not* picked up automatically. To fold it in:

1. Create the new sub-issue under the same parent, with its `blocked by` edges to any sub-issues it depends on.
2. **Re-apply the trigger label to the parent** (remove it and add it again, or add it if it was removed).

ABCA diffs the current Linear graph against what it already has, adds only the genuinely-new node(s), and releases any that are immediately runnable (their predecessors already succeeded); the rest wait their turn. Re-applying the label with no new sub-issues is a safe no-op.

> **Why it isn't automatic:** re-applying the label is the explicit "execute this" signal — the same consent model as the initial trigger — so newly-drafted sub-issues don't start running the instant you create them. Automatic pickup on sub-issue creation is a possible future enhancement.

Notes and current limitations:

- The parent issue itself spawns **no task** — a human-authored sub-issue graph is treated as consent to execute.
- **No "cancel the whole epic" button yet.** Cancelling an individual sub-issue's task (`bgagent cancel <task-id>`) stops it and skips its dependents, but there is no single command to cancel a whole in-flight orchestration. Tracked as a follow-up.
- A scheduled backstop (every ~10 min) recovers sub-issues whose terminal events were lost during a transient outage, so a stalled orchestration self-heals rather than hanging.
- Multi-predecessor ("diamond") sub-issues merge their predecessors' branches at start time; if a predecessor is later edited in review, re-integration of the dependent is a tracked follow-up.

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

### Comments render as "interactive agent activity" instead of a comment thread

Symptom: when you `@mention` the bot in Linear it shows up as an interactive agent widget rather than a normal comment, and the agent's replies/reactions don't behave like a comment thread. Cause: the Linear **OAuth app is configured as an agent** — agent-session / app-notification events are enabled on it. ABCA is a comment-based integration and does not use Linear's agent model; agent mode makes Linear render mentions as agent activity, which breaks the comment-thread UX.

Fix: in the Linear OAuth app settings, **turn OFF the agent / app-notification event subscriptions**. Keep only the workspace **webhook** with **Issues** and **Comments** resource types (step 4). No redeploy needed — it's a Linear-side app setting.

To confirm ABCA is seeing agent-mode traffic from a workspace, grep the receiver logs:

```bash
aws logs filter-log-events --log-group-name /aws/lambda/<stack>-LinearIntegrationWebhookFn... \
  --filter-pattern "agent-mode"
```

A `WARN … Ignoring Linear agent-mode webhook …` line (with `linear_workspace_id`) means that workspace's app has agent events on — advise disabling them.

### "Invalid redirect_uri parameter for the application" during step 3

Linear's misleading error for `actor=app` flows where the OAuth app config is incomplete (it reports `Invalid redirect_uri` regardless of which required field is actually missing). In your Linear app settings, confirm:

- **GitHub username** is filled in (Linear's inline help describes the field and the `[bot]` suffix) — a blank value triggers this error.
- **Webhooks** toggle is ON.
- The Callback URL is on a **single line** (line-wrapped URLs become two malformed entries Linear silently rejects).

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
