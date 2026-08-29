---
title: Linear setup guide
---

# Linear integration setup guide

Set up the ABCA Linear integration so that applying a label to a Linear issue triggers an autonomous task. The agent posts progress comments back on the issue as it works, and opens a pull request.

## Prerequisites

- ABCA CDK stack deployed (see [Developer guide](/sample-autonomous-cloud-coding-agents/developer-guide/introduction))
- A Cognito user account configured (see [User guide](/sample-autonomous-cloud-coding-agents/using/overview))
- A Linear workspace where you have **admin** access — `actor=app` installs are workspace-wide and Linear requires an admin to approve them
- The `bgagent` CLI installed and logged in (`bgagent configure` + `bgagent login`)

## How it works

You create a Linear OAuth app and authorize it on your workspace. When someone adds the trigger label to an issue in a mapped project, Linear fires a webhook at ABCA; the receiver verifies the HMAC signature, looks up the workspace, resolves a Linear API token, and creates a task. The agent clones the repo, makes the change, opens a PR, and comments back on the issue.

The app is installed with `actor=app`, so everything ABCA writes is attributed to the app rather than to whoever clicked Authorize.

### Where the Linear credential lives

One of two places, chosen automatically at setup time:

| | When it's used | What's stored |
|---|---|---|
| **AgentCore Identity vault** | The stack was deployed with `--context enableLinearIdentityVault=true` | Nothing long-lived. AgentCore holds the refresh token and mints short-lived access tokens on demand. |
| **Secrets Manager** | Otherwise — including regions where AgentCore Identity isn't available | An OAuth token bundle in `bgagent-linear-oauth-<slug>`, refreshed and rotated by ABCA. |

`bgagent linear setup` picks whichever the deployment supports and tells you which one it used. There is no flag. If the vault isn't available it prints one line and continues on Secrets Manager:

```
AgentCore Identity not available in us-east-1 — using Secrets Manager.
```

A workspace that started on Secrets Manager and later moves to the vault **keeps** its Secrets Manager token as a fallback. A workspace onboarded straight onto the vault has no such token by design — it needs the vault to be reachable.

### Multi-workspace

One ABCA deployment can serve several Linear workspaces. Each gets its own registry row and its own `bgagent-linear-oauth-<slug>` secret, keyed by Linear's `organizationId`. Run setup once per workspace.

## Setup

### 1. Find the workspace slug

The slug is the URL key in `https://linear.app/<slug>/…`. Linear → Settings → Workspace → URL key, or read it off any URL while signed into the workspace.

### 2. Create the Linear OAuth app

```bash
bgagent linear app-template
```

This prints the exact field values to paste, with the URLs already resolved from your stack — you shouldn't need to look anything up. Open [Linear Settings → API → New application](https://linear.app/settings/api/applications/new), **signed into the workspace you're onboarding** (use Linear's sidebar switcher if needed), and fill in what it prints.

Two fields deserve attention:

- **Redirect URIs** — paste exactly what the template prints, one per line. Linear compares these as exact strings, and reports any mismatch as a cryptic `Invalid redirect_uri parameter for the application`. Don't retype them, don't add variants, and don't let a line wrap into two entries.
- **Webhooks** — turn this ON and fill in the URL the template prints, with **Issues** and **Comments** both ticked under *Data change events*. Leave every **App events** checkbox off (see the warning below). Then copy the **Webhook signing secret** (`lin_wh_…`); setup asks for it.

Click **Create** and copy the **Client ID** and **Client Secret**.

> **Don't enable Linear's agent / app-notification events.** ABCA is a **comment-based** integration: it posts a maturing threaded reply and reacts 👀→✅ on ordinary comments. With agent-session events on, Linear renders an `@mention` of the app as its interactive agent-activity surface instead of a comment thread, which breaks the reply/reaction UX. ABCA ignores agent-session events and logs a WARN naming the workspace. If comments start behaving "interactively", this toggle is why.

> **One webhook, not two.** The app's own webhook is all ABCA needs. A separate workspace webhook (Linear → Settings → API → Webhooks) works equally well as an *alternative* — but pointing both at ABCA delivers every event twice under two different signing secrets, and only one of them can verify. Pick one.

### 3. Authorize the app

```bash
bgagent linear setup <slug>
```

It prompts for the three values from step 2 — **Client ID**, **Client Secret**, and the **webhook signing secret** — then prints one URL to open and waits. Authorize in the browser, then paste back the value the page shows. One command, one consent — and because consent happens in a browser that never needs to reach your machine, this works from a cloud desktop, an SSH session, or a container.

**On the vault, the first run stops early.** The vault redirects Linear through a callback URL that AgentCore mints while registering your app, so it cannot exist before that first run. Setup prints it and stops:

```
  → Registering the Linear app with the Identity vault... ✓

  One more Redirect URI to add to the Linear app.
  Copy the whole line below — leading spaces make it invalid:

https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/<id>

  Then re-run:  bgagent linear setup <slug>
```

Add that URI to the app, re-run the same command, and it proceeds to consent. This happens once per workspace. (`bgagent linear app-template --slug <slug>` will include the URI once the provider exists, if you'd rather regenerate the whole template.)

Press Enter to skip the signing secret if you don't have it yet and set it later with `bgagent linear update-webhook-secret <slug>`. If you skip it on a **second or later** workspace, setup falls back to the stack-wide value — which belongs to whichever workspace was installed first, so every delivery from this one fails signature verification with a 401 and no task is ever created. Setup warns when that happens, and warns again on later runs.

All three values can also be passed as flags (`--client-id`, `--client-secret`, `--webhook-secret`) for non-interactive use; interactive is preferred so secrets stay out of shell history.

Finally it offers a picker so you can map your own Linear identity to your ABCA account — pick yourself. ([Why a picker is needed.](#why-the-two-step-handshake))

### 4. Create the trigger labels in Linear

ABCA matches labels **by name**, so you create them yourself: Linear → Settings → Labels, or inline on any issue.

| Label | Give it this description |
|---|---|
| `bgagent` | Hand this issue to ABCA — makes the change and opens a PR |
| `bgagent:help` | ABCA explains what its labels do |

Add the descriptions. Linear shows them on hover in the label picker, which is the only hint a first-time teammate gets. Grouping both under a shared label group keeps them together in the picker.

### 5. Map a Linear project to a GitHub repo

```bash
bgagent linear list-projects --slug <slug>          # find the project UUID
bgagent linear onboard-project <project-uuid> --repo owner/repo
```

Pass `--label <name>` to use a trigger label other than `bgagent`. Also available: `--team-id` (debug only), `--region`, `--stack-name`.

### 6. Test

Apply the trigger label to an issue in that project. Within ~30 seconds the agent posts `🤖 Starting on this issue…`, then a PR link when it's done.

## Using it

- **Trigger a task** — apply the trigger label to an issue in a mapped project. The title and description become the task.
- **Iterate** — reply to ABCA's comment with `@bgagent <what you want>`. The trigger phrase is always `@bgagent`, whatever you named the app.
- **Check status** — the issue's progress comments, or `bgagent list` / `bgagent status <task-id>`.
- **Cancel** — `bgagent cancel <task-id>`. Removing the label does *not* cancel a running task.

### Trigger labels

| Label | What it does | Use it when |
|-------|--------------|-------------|
| `bgagent` | **Do it.** Reads the issue, makes the change, opens a PR. If the issue already has sub-issues, runs those in dependency order instead (see [orchestration](#parentsub-issue-orchestration)). | The issue is a single well-defined piece of work, or a parent whose sub-issues you've already written. |
| `bgagent:help` | **Explain the labels.** Posts a one-time comment describing each label, creates no task. Remove it afterward. | You want a reminder of the options. |

**You decide the breakdown.** ABCA runs the graph you declare — it does not split an issue for you. For multi-part work, create the sub-issues and their `Blocks` / `Blocked by` links yourself, then label the parent. A plain label on a multi-part issue runs it as ONE task.

### Parent/sub-issue orchestration

Apply the trigger label to a **parent issue that has sub-issues** and ABCA orchestrates the epic instead of creating one task:

1. **Discovery** — reads the sub-issues and their `blocked by` / `blocking` relations, builds a DAG, and rejects cycles with a terminal comment on the parent.
2. **Dependency-ordered execution** — root sub-issues start immediately; a blocked sub-issue waits until **all** its blockers reach terminal success (one that completes but fails its build does **not** release its dependents). Independent sub-issues run in parallel.
3. **Stacked PRs** — a sub-issue with one predecessor branches from that predecessor's branch; with several, it branches from the default branch and merges all predecessors in. Review the stack bottom-up.
4. **Rollup** — when every sub-issue is terminal, ABCA posts an aggregate comment on the parent (succeeded / failed / skipped, plus per-child status). Each sub-issue also gets its own final comment.
5. **Failure handling** — a failed or cancelled sub-issue causes its transitive dependents to be **skipped**; independent siblings still finish.

The parent issue itself spawns no task — a human-authored sub-issue graph is treated as consent to execute.

#### Adding a sub-issue to a running epic

The graph is read **at trigger time**, so a sub-issue created afterward isn't picked up automatically. Create it (with its `blocked by` edges), then **re-apply the trigger label to the parent**. ABCA diffs the current graph against what it has, adds only the new nodes, and releases any that are immediately runnable. Re-applying with no new sub-issues is a safe no-op.

Re-applying the label is deliberately the explicit "execute this" signal — the same consent model as the initial trigger — so newly drafted sub-issues don't start the instant you create them.

Current limitations:

- **No "cancel the whole epic" command.** Cancelling one sub-issue's task stops it and skips its dependents, but there's no single command for an in-flight orchestration.
- A scheduled backstop (~10 min) recovers sub-issues whose terminal events were lost to a transient outage, so a stalled orchestration self-heals.
- Multi-predecessor ("diamond") sub-issues merge their predecessors' branches at start time; re-integrating a dependent after a predecessor is edited in review is a tracked follow-up.

### Attachments and documents

The platform pre-hydrates context and hands it to the agent at task-creation time. The agent has **no Linear tools** and fetches nothing at runtime — it works from that snapshot.

Gathered on **every** trigger path (labelled issue, orchestration, `@bgagent` comment): the issue title and description, recent human comments, the reporter's uploaded files (inline images and paperclip attachments), and any project wiki documents.

- Every attachment is screened through **Bedrock Guardrails** before entering the agent's context.
- **Supported**: images (PNG, JPEG) and text-family files (PDF, plain text, CSV, Markdown, JSON, log).
- **Rejected**: everything else (`.docx`, `.zip`, …). The reporter gets a comment asking them to remove or convert the file and re-trigger.

No extra setup — this is automatic once the workspace and project are onboarded.

## Adding another workspace

Run `bgagent linear setup <slug>` again for the new workspace. It's the only command that supports the Identity vault, and it will walk the same one-consent flow.

You need a new OAuth app only if you want per-workspace isolation. To reuse one app across workspaces, edit it and toggle **Public: ON** so it can be authorized from any workspace. Trade-off: a shared app revokes everywhere at once; per-workspace apps fail independently.

`bgagent linear add-workspace <slug>` is an older, Secrets-Manager-only path that defaults the Client ID to your existing workspace's value (press Enter to reuse). It does not use the vault; prefer `setup` unless you specifically want that.

## Inviting teammates

Setup links **your** Linear identity to your ABCA account. Teammates need their own binding so their triggers run under their account — their concurrency, cost attribution, and notifications.

### Admin: generate the invite

```bash
bgagent linear invite-user <slug>
```

Pick the teammate from the list of human members. You get a one-time code (24h TTL) and a command to send them.

### Teammate: redeem it

They need an ABCA account first. If they don't have one:

1. **Admin**: `bgagent admin invite-user teammate@example.com` creates their Cognito user (see [User guide → Joining an existing deployment](/sample-autonomous-cloud-coding-agents/using/overview#joining-an-existing-deployment)).
2. **Teammate**:

   ```bash
   bgagent configure --from-bundle <bundle>
   bgagent login --username teammate@example.com
   ```

3. **Teammate**: `bgagent linear link <code>`

The CLI shows them the Linear name and email and asks for confirmation **before** writing the mapping. If the admin picked the wrong person, the teammate sees it and aborts.

### Why the two-step handshake

`actor=app` installs the app under a synthetic bot user (`<uuid>@oauthapp.linear.app`). Linear's `viewer` query during setup returns that bot user, not the human who clicked Authorize — hence the picker for self-linking.

For teammates, the admin can't authenticate as them, so the binding splits in two: the admin asserts the Linear identity, the teammate confirms from their own authenticated session. No API keys change hands, and no admin can silently misattribute.

## Reference

### How webhook signature verification works

Linear generates a fresh signing secret per webhook subscription. ABCA stores each workspace's secret on its OAuth bundle (`bgagent-linear-oauth-<slug>`) and, on each event:

1. Parses the body for `organizationId` — untrusted at this point, used only to select which secret to verify against.
2. Looks up that workspace's registry row. If `status='active'` and the bundle has a `webhook_signing_secret`, verifies the HMAC. Match → dispatch. **Mismatch → 401 with no fallback**, since falling back to the stack-wide secret would let an attacker bypass the per-workspace one.
3. If there's no row, or no per-workspace secret (a pre-migration single-workspace install), falls back to the stack-wide `LinearWebhookSecret`. Match → trusted, otherwise 401.

**Trust model.** `organizationId` is attacker-controlled but only *selects* the secret; forging a signature still requires the secret itself. The no-fallback-on-mismatch rule is what prevents cross-workspace impersonation.

### Limits and quotas

Linear's rate limits per installed app, per workspace: **5,000 requests/hour** and **3,000,000 complexity points/hour**. A typical task makes ~10 calls.

Linear access tokens expire in 24h. On the Secrets Manager path ABCA refreshes via the stored `refresh_token` and writes the rotated token back; if Linear returns `invalid_grant` because a concurrent caller already refreshed, the resolver re-reads the secret and uses the fresh token. On the vault path AgentCore owns refresh entirely.

## Troubleshooting

### "Invalid redirect_uri parameter for the application"

The URI you're being redirected to isn't registered on the app. Linear reports this at authorize time and the error names the *application*, not the URI, so compare carefully:

- **Is every URI the template printed actually listed?** On the vault, that includes the AgentCore callback that the first `setup` run prints — a missing one fails here, mid-consent.
- **Did the save take?** Reload the app page and confirm the field still holds the value. Linear validates the whole field at once, so one bad line loses the good ones — and the error then looks like it's about the line you just added.
- **Any leading or trailing whitespace?** A copied line can carry indentation. Linear rejects that URI as invalid.
- **One URI per line, no wildcards, no line wrapping.** A wrapped URI becomes two malformed entries.

If the app has been edited repeatedly through failed saves, creating a fresh app with the correct URIs from the start is faster than auditing it.

### Webhook doesn't trigger a task

- Is the project mapped? `aws dynamodb scan --table-name <LinearProjectMappingTableName>`
- Is the workspace registered? Scan `LinearWorkspaceRegistryTable` for the payload's `organizationId`.
- Is **Comments** ticked on the webhook as well as **Issues**? Without it, labels still work but `@bgagent` replies silently never arrive.
- Is the label spelled as configured? Matching is case-insensitive but must be the same word.
- Check CloudWatch for `WebhookFn` and `WebhookProcessorFn`. Common: `Invalid Linear webhook signature`, `Linear workspace is not onboarded`, `Linear project is not onboarded`, `Linear actor has no linked platform user`.

### Webhook signature verification fails repeatedly

The stored signing secret doesn't match the subscription Linear is sending from — usually because the webhook was configured in Linear without telling ABCA, or the secret was rotated:

```bash
bgagent linear update-webhook-secret <slug>
```

To see what's stored:

```bash
aws secretsmanager get-secret-value --secret-id bgagent-linear-oauth-<slug> \
  --query SecretString --output text | jq .webhook_signing_secret
```

If the failing event's `organizationId` matches no registered workspace and the stack-wide secret doesn't match either, a Linear workspace you haven't onboarded has a webhook pointed here — onboard it or remove the webhook.

### Comments render as "interactive agent activity"

An `@mention` shows up as an interactive agent widget rather than a comment, and replies/reactions don't behave like a thread. The OAuth app is configured as a Linear **agent**.

Fix: untick the app's **App events** checkboxes (agent session events, inbox notifications, permission changes). Keep the webhook enabled with the **Issues** and **Comments** data-change events. No redeploy needed.

To confirm ABCA is seeing agent-mode traffic:

```bash
aws logs filter-log-events --log-group-name /aws/lambda/<stack>-LinearIntegrationWebhookFn... \
  --filter-pattern "agent-mode"
```

A `WARN … Ignoring Linear agent-mode webhook …` line names the offending workspace.

### Agent doesn't post comments to Linear

- Does the secret exist? `aws secretsmanager describe-secret --secret-id bgagent-linear-oauth-<slug>`
- Does the registry row's `oauth_secret_arn` match it, with `status='active'`?
- Check the webhook-processor logs, not the agent container — token resolution and attachment screening happen there, before the task is dispatched.
- `WARN linear_reactions: HTTP 401 from Linear` — the refresh token was revoked Linear-side. Re-run `bgagent linear setup <slug>`.
- `resolve_linear_api_token: invalid_grant` — Linear permanently rejected the refresh token. Re-run setup to issue a new one.
- On the vault path, a "consent required" outcome means the grant is gone; re-run setup.

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

Then delete the webhook from [Linear Settings → API](https://linear.app/settings/api) and uninstall the app from [Workspace Settings → Integrations](https://linear.app/settings/integrations).
