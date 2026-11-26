---
title: "Linear integration setup guide"
---

Set up the ABCA Linear integration so that applying a label to a Linear issue triggers an autonomous task. The agent posts progress comments back on the issue as it works, and opens a pull request.

## Prerequisites

- ABCA CDK stack deployed (see [Developer guide](/sample-autonomous-cloud-coding-agents/developer-guide/introduction)) with the `linear` feature enabled in its [deployment profile](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#deployment-profiles)
- A Cognito user account configured (see [User guide](/sample-autonomous-cloud-coding-agents/using/overview))
- A Linear workspace where you have **admin** access. `actor=app` installs are workspace-wide, and Linear requires an admin to approve them.
- The `bgagent` CLI installed and logged in (`bgagent configure` and `bgagent login`)

## How it works

You create a Linear OAuth app and authorize it on your workspace. When someone adds the trigger label to an issue in a mapped project, Linear sends a webhook to ABCA. The receiver verifies the HMAC signature, looks up the workspace, resolves a Linear API token, and creates a task. The agent clones the repo, makes the change, opens a PR, and comments back on the issue.

The app is installed with `actor=app`, so everything ABCA writes is attributed to the app, not to the person who clicked Authorize.

### Where the Linear credential lives

The credential lives in one of two places. Setup chooses one automatically:

| | When it's used | What's stored |
|---|---|---|
| **AgentCore Identity vault** | The stack was deployed with `--context enableLinearIdentityVault=true` | Nothing long-lived. AgentCore holds the refresh token and mints short-lived access tokens on demand. |
| **Secrets Manager** | Otherwise, including in regions where AgentCore Identity isn't available | An OAuth token bundle in `bgagent-linear-oauth-<slug>`. ABCA refreshes and rotates it. |

You can configure the vault with any selected backend. Lambda MicroVMs remains experimental. Its image must include the current shared configuration contract.

`bgagent linear setup` picks the one that the deployment supports and tells you which one it used. There is no flag. If the vault isn't available, setup prints one line and continues on Secrets Manager:

```
AgentCore Identity not available in us-east-1 — using Secrets Manager.
```

A workspace that started on Secrets Manager and later moves to the vault **keeps** its Secrets Manager token as a fallback. A workspace onboarded straight onto the vault has no such token by design, so it needs the vault to be reachable.

When a workspace loses its authorization, ABCA records the loss on the registry row and publishes to the `OperationalAlerts` topic. That topic has **no subscribers unless you deployed with `alertEmail`**. Set `alertEmail` if you want to be told about a workspace that lost its authorization instead of finding it with `bgagent platform doctor`.

A vault call that fails is not a lost authorization. When the vault answers with an error (a throttle, a missing permission, a deleted credential provider) instead of saying that a new consent is needed, ABCA records nothing and publishes nothing. That event uses the Secrets Manager token if the workspace has a usable one. Otherwise ABCA drops the event and writes `Vault token resolution failed` to the function's log. The next event asks the vault again.

#### Using the vault with Lambda MicroVMs

Use split networking when the full MicroVM-plus-vault configuration exceeds the 490-resource budget. `compute_types` can include MicroVM alongside AgentCore or ECS, or select MicroVM alone. An unchanged legacy `compute_type=lambda-microvm` keeps AgentCore. The guest execution role receives the mint grant, and the `/run` configuration carries `LINEAR_VAULT_ENABLED` and `LINEAR_WORKLOAD_IDENTITY_NAME`. Rebuild the MicroVM image from this checkout before you enable the vault. Verify consent and token minting in a live rehearsal. Synthesis alone does not qualify this experimental backend.

#### One workload identity per stack

The vault mints tokens under an AgentCore workload identity named after the stack (for example `abca_linear_oauth_AbcaAgentStack`). The stack publishes that name as the `LinearVaultWorkloadName` output. These names are unique per account **and region**, so two vault-enabled stacks must not share one. The second stack to deploy would overwrite the consent-callback allowlist of the first.

A grant is bound to that name, so **renaming it orphans every consent already given**. If you deployed the vault before the name was stack-scoped, pin the old name instead of re-authorizing every workspace:

```bash
--context linearVaultWorkloadName=abca_linear_oauth
```

### Multi-workspace

One ABCA deployment can serve several Linear workspaces. Each workspace gets its own registry row and its own `bgagent-linear-oauth-<slug>` secret, keyed by Linear's `organizationId`. Run setup once per workspace.

## Setup

### 1. Find the workspace slug

The slug is the URL key in `https://linear.app/<slug>/…`. Find it in Linear under Settings, then Workspace, then URL key, or read it from any URL while you are signed into the workspace.

### 2. Create the Linear OAuth app

```bash
bgagent linear app-template
```

The command prints the exact field values to paste, with the URLs already resolved from your stack, so you shouldn't need to look anything up. Open [New application in Linear's API settings](https://linear.app/settings/api/applications/new) while **signed into the workspace you're onboarding** (use Linear's sidebar switcher if needed), and fill in what the command prints.

Two fields need care:

- **Redirect URIs.** Paste exactly what the template prints, one per line. Linear compares these as exact strings, and reports any mismatch as a cryptic `Invalid redirect_uri parameter for the application`. Don't retype them, don't add variants, and don't let a line wrap into two entries. On a stack with the Identity vault, a **first** run has nothing to paste yet. The URI that Linear needs is the vault's callback. `bgagent linear setup` creates it, prints it, and asks you to add it before you re-run. If setup falls back to Secrets Manager instead, it tells you to register the hosted consent page. The template lists that page separately for this reason.
- **Webhooks.** Turn this ON and fill in the URL that the template prints. Tick both **Issues** and **Comments** under *Data change events*. Leave every **App events** checkbox off (see the warning below). Then copy the **Webhook signing secret** (`lin_wh_…`). Setup asks for it.

Click **Create** and copy the **Client ID** and **Client Secret**.

> **Don't enable Linear's agent or app-notification events** unless you opted into [native agent sessions](#native-agent-sessions-opt-in). By default ABCA is a **comment-based** integration. It posts a maturing threaded reply and reacts with 👀 and then ✅ on ordinary comments. With agent-session events on, Linear renders an `@mention` of the app as its interactive agent-activity widget instead of a comment thread. That rendering breaks the reply and reaction UX. A stack without the opt-in ignores agent-session events and logs a WARN that names the workspace. If comments start to behave "interactively", this toggle is the cause.

> **One webhook, not two.** The app's own webhook is all ABCA needs. A separate workspace webhook (in Linear under Settings, then API, then Webhooks) works equally well as an *alternative*. But if you point both at ABCA, every event is delivered twice under two different signing secrets, and only one of them can verify. Pick one.

### 3. Authorize the app

```bash
bgagent linear setup <slug>
```

The command prompts for the three values from step 2: **Client ID**, **Client Secret**, and the **webhook signing secret**. It then prints one URL to open and waits. Authorize in the browser, then paste back the value that the page shows. Setup takes one command and one consent. The consent happens in a browser that never needs to reach your machine, so setup works from a cloud desktop, an SSH session, or a container.

**On the vault, the first run stops early.** The vault redirects Linear through a callback URL that AgentCore mints while registering your app, so the URL cannot exist before that first run. Setup prints the URL and stops:

```
  → Registering the Linear app with the Identity vault... ✓

  One more Redirect URI to add to the Linear app.
  Copy the whole line below — leading spaces make it invalid:

https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/<id>

  Then re-run:  bgagent linear setup <slug>
```

Add that URI to the app and re-run the same command. Setup then proceeds to consent. This stop happens once per workspace. (`bgagent linear app-template --slug <slug>` will include the URI once the provider exists, if you'd rather regenerate the whole template.)

The signing secret is **required** the first time a workspace is onboarded. There is nothing to fall back to, and a workspace without its own secret fails every signature check while it looks correctly installed. On later runs the prompt offers to keep the stored secret, so a re-run (for example, to re-authorize after a revocation) doesn't send you back to the Linear app page.

You can also pass all three values as flags (`--client-id`, `--client-secret`, `--webhook-secret`) for non-interactive use. Prefer the interactive prompts, so that secrets stay out of shell history.

Finally, setup offers a picker so that you can map your own Linear identity to your ABCA account. Pick yourself. ([Why a picker is needed.](#why-the-two-step-handshake))

### 4. Create the trigger labels in Linear

ABCA matches labels **by name**, so you create them yourself. Create them in Linear under Settings, then Labels, or inline on any issue.

| Label | Give it this description |
|---|---|
| `bgagent` | Hand this issue to ABCA — makes the change and opens a PR |
| `bgagent:help` | ABCA explains what its labels do |

Add the descriptions. Linear shows them on hover in the label picker, and a first-time teammate gets no other hint. A shared label group keeps both labels together in the picker.

### 5. Map a Linear project to a GitHub repo

```bash
bgagent linear list-projects --slug <slug>          # find the project UUID
bgagent linear onboard-project <project-uuid> --repo owner/repo
```

Pass `--label <name>` to use a trigger label other than `bgagent`. The command also accepts `--team-id` (debug only), `--region`, and `--stack-name`.

`onboard-project` asks Linear which workspace owns the project and records the owner on the mapping. A later webhook that names that project can then be checked against the workspace whose signature it arrived with. Narrow the search with `--slug <slug>` when you know the workspace. If the Linear API is unreachable, `--workspace-id <uuid>` records an owner without verifying it. A wrong value routes the project's tasks nowhere.

Mappings created before the owner was recorded have no owning workspace. `bgagent platform doctor` reports them. A mapping without an owner is harmless while a stack has one workspace, since there is no other tenant that a project could be steered at. Before you onboard a second workspace, re-run `onboard-project` for each of those mappings, with the same `--repo` and the same `--label`. The command rewrites the whole mapping, and without `--label` the trigger label goes back to `bgagent`.

### Signing secrets in a multi-workspace install

Every workspace must have its own webhook signing secret, read from its own Linear app. `setup` asks for the secret and refuses to continue without one. It records on the workspace's registry row that the secret is that workspace's own.

A workspace onboarded by an older release may instead hold a copy of the first workspace's secret. When two workspaces share one secret, either can produce a delivery that the other's signature check accepts. So **on a stack with more than one active workspace, those deliveries are rejected with a 401** until each workspace has its own secret. Fix each workspace with `bgagent linear update-webhook-secret <slug>`, which also records that the secret is that workspace's own. Pass `--stack-name` if you are not using the default.

On an existing multi-workspace stack, run `bgagent linear backfill-secret-provenance --dry-run` before you deploy this change. The command records ownership automatically for every workspace whose stored secret differs from the stack-wide value. The difference proves that the secret was never copied from the stack-wide value, since copying is the only way a workspace ends up with someone else's secret. The command also names the workspaces that still need `update-webhook-secret`. `bgagent platform doctor` reports the same thing. It stays quiet on a single-workspace stack, where a shared secret cannot reach another tenant.

For the same reason, the stack-wide back-compat secret is accepted only on a single-workspace stack. That secret cannot say which workspace sent a delivery, and with two or more tenants there is no safe way to guess, so a delivery signed with it is rejected instead. Single-workspace installs are unaffected. Every check here first compares against the number of active workspaces, and with one tenant none of the checks changes behaviour.

### 6. Test

Apply the trigger label to an issue in that project. Within about 30 seconds the agent posts `🤖 Starting on this issue…`, then a PR link when it's done.

## Using it

- **Trigger a task.** Apply the trigger label to an issue in a mapped project. The title and description become the task.
- **Iterate.** Reply to ABCA's comment with `@bgagent <what you want>`. The trigger phrase is always `@bgagent`, whatever you named the app.
- **Check status.** Read the issue's progress comments, or run `bgagent list` or `bgagent status <task-id>`.
- **Cancel.** Run `bgagent cancel <task-id>`. Removing the label does *not* cancel a running task.

### Trigger labels

| Label | What it does | Use it when |
|-------|--------------|-------------|
| `bgagent` | **Do it.** Reads the issue, makes the change, opens a PR. If the issue already has sub-issues, runs those in dependency order instead (see [orchestration](#parentsub-issue-orchestration)). | The issue is a single well-defined piece of work, or a parent whose sub-issues you've already written. |
| `bgagent:help` | **Explain the labels.** Posts a one-time comment that describes each label, and creates no task. Remove it afterward. | You want a reminder of the options. |

**You decide the breakdown.** ABCA runs the graph that you declare. It does not split an issue for you. For multi-part work, create the sub-issues and their `Blocks` and `Blocked by` links yourself, then label the parent. A plain label on a multi-part issue runs it as ONE task.

### Parent/sub-issue orchestration

When you apply the trigger label to a **parent issue that has sub-issues**, ABCA orchestrates the epic instead of creating one task:

1. **Discovery.** ABCA reads the sub-issues and their `blocked by` and `blocking` relations, builds a DAG, and rejects cycles with a terminal comment on the parent.
2. **Dependency-ordered execution.** Root sub-issues start immediately. A blocked sub-issue waits until **all** its blockers reach terminal success. A blocker that completes but fails its build does **not** release its dependents. Independent sub-issues run in parallel.
3. **Stacked PRs.** A sub-issue with one predecessor branches from that predecessor's branch. A sub-issue with several predecessors branches from the default branch and merges all predecessors in. Review the stack from the bottom up.
4. **Rollup.** When every sub-issue is terminal, ABCA posts an aggregate comment on the parent (succeeded, failed, and skipped, plus per-child status). Each sub-issue also gets its own final comment.
5. **Failure handling.** A failed or cancelled sub-issue causes its transitive dependents to be **skipped**. Independent siblings still finish.

The parent issue itself spawns no task. ABCA treats a human-authored sub-issue graph as consent to execute.

#### Adding a sub-issue to a running epic

ABCA reads the graph **at trigger time**, so it does not pick up a sub-issue created afterward automatically. Create the sub-issue (with its `blocked by` edges), then **re-apply the trigger label to the parent**. ABCA diffs the current graph against what it has, adds only the new nodes, and releases any that are immediately runnable. Re-applying with no new sub-issues is safe. ABCA leaves alone the sub-issues that are running or have succeeded. It retries the ones that failed or were skipped. It also reads again the title and description of every sub-issue that is not running and has not succeeded, so a reworded sub-issue starts with its new text.

Re-applying the label is deliberately the explicit "execute this" signal, the same consent model as the initial trigger. Newly drafted sub-issues therefore don't start the instant you create them.

Current limitations:

- **No "cancel the whole epic" command.** Cancelling one sub-issue's task stops it and skips its dependents, but there's no single command for an in-flight orchestration.
- A scheduled backstop (about 10 minutes) recovers sub-issues whose terminal events were lost to a transient outage, so a stalled orchestration recovers on its own.
- Multi-predecessor ("diamond") sub-issues merge their predecessors' branches at start time. Re-integrating a dependent after a predecessor is edited in review is a tracked follow-up.

### Attachments and documents

The platform pre-hydrates context and hands it to the agent at task-creation time. The agent has **no Linear tools** and fetches nothing at runtime. It works from that snapshot.

On **every** trigger path (labelled issue, orchestration, `@bgagent` comment), the platform gathers the issue title and description, recent human comments, the reporter's uploaded files (inline images and paperclip attachments), and any project wiki documents.

- **Bedrock Guardrails** screens every attachment before it enters the agent's context.
- **Supported.** Images (PNG, JPEG) and text-family files (PDF, plain text, CSV, Markdown, JSON, log).
- **Rejected.** Everything else, such as `.docx` and `.zip`. The reporter gets a comment that asks them to remove or convert the file and re-trigger.

This needs no extra setup. It is automatic once the workspace and project are onboarded.

## Native agent sessions (opt-in)

Linear's [Agents API](https://linear.app/developers/agents) gives an installed app its own agent UI. People **@-mention the app or delegate an issue** to it, follow up **inside the session**, and watch typed progress (thoughts, actions, a final response) instead of a comment thread. ABCA can answer through that API instead of the `@bgagent` comment protocol. The channel is additive and flag-gated ([ADR-018](/sample-autonomous-cloud-coding-agents/decisions/adr-018-linear-agent-session-interaction) Phase 2). The label triggers, the epic orchestration and the AWS compute are unchanged. Only how a standalone issue is triggered and how its progress is shown changes.

> **Developer Preview.** Linear marks the Agents API as subject to change before GA. Keep the flag off on stacks where a Preview-API change would hurt.

**Enable it.** Turn on both halves together, in this order:

1. Deploy the stack with the flag:

   ```bash
   mise //cdk:deploy -- --context enableLinearAgentSessions=true
   ```

2. In the Linear app (under *Settings*, then *API*, then *Applications*, then your app, then *Webhooks*), tick **Agent session events** under *App events*. Leave **Issues** and **Comments** ticked. Inbox notifications and permission changes stay off.

If you do these the other way round, every mention in the meantime opens a session that nothing answers, and Linear shows "did not respond". To turn the channel off, reverse the order. Untick **Agent session events** first, then redeploy without the flag.

3. Delegate one issue to bgagent in each workspace you enabled. ABCA switches a workspace's standalone `@bgagent` mentions over to sessions once it has received a session event from that workspace, and this is the first one. If you skip this step, both the session and the comment flow may answer the first mention.

**Step 2 is per workspace.** The flag is stack-wide, but the toggle belongs to each workspace's Linear app. A workspace whose app lacks the toggle isn't affected by the flag: its `@bgagent` comments, label triggers and epics keep working as before.

> **@-mentions need the WAF fix.** A session opened by an @-mention carries XML-like context that the API's web application firewall has been seen to reject. Deploy a version that includes the signed-webhook WAF rule ([#1065](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/1065)) before you turn the flag on. Without it, once a workspace has delivered its first session, a standalone `@bgagent` mention there gets no session and no comment reply. Delegating an issue works either way.

**Turning it off for one workspace.** Untick **Agent session events** in that workspace's Linear app. Linear doesn't tell ABCA about this, so ABCA goes back to answering that workspace's `@bgagent` comments once it has seen no session event from it for 14 days. To switch back immediately, remove the `agent_sessions_seen_at` attribute from the workspace's row in the Linear workspace registry table.

**What changes once it's on**

| You do in Linear | ABCA does |
|---|---|
| @-mention bgagent on an issue, or delegate the issue to it | Acknowledges within seconds with a *thought*, then starts a coding task on the project's mapped repo. If the issue already has an ABCA pull request and your mention carries an instruction, it iterates on that PR instead. The session shows **Started coding task** or **Iterating on pull request**. |
| When the agent opens a PR | Attaches the pull request to the session header and posts an **Opened pull request** action. |
| While a long run is in progress | Posts a short-lived "Still working" thought at most every 10 minutes, so the session never goes stale (Linear's idle limit is 30 minutes). |
| When the task finishes | Posts one final activity that carries the same outcome, cost, turns and duration as the comment channel: a *response* on success, an *elicitation* if the run stopped to ask you a question, an *error* on failure. Linear turns it into the thread comment. |
| When you're at your concurrency limit | Posts a "Queued" thought in the session. The task starts on its own when a slot frees up. |
| Reply inside the session while the task runs | Your message goes to the running agent as a nudge (the same guardrail screening, 2,000-character cap and per-minute limit as `bgagent nudge`). The agent picks it up at its next step. Only the task's owner can steer it. |
| Reply after the task has finished | Starts a follow-up task. If the run stopped to ask a question, your reply resumes the original request with the answer. Otherwise it's a PR iteration if a PR exists, or new work from your message plus the issue. |
| Click **Stop** in the session | Cancels the running task and shuts its agent down, like `bgagent cancel`, then confirms with a final response. Only the task's owner can stop it. |

**What stays on the comment path.** Linear sessions are per-issue and can't roll up across issues. So mentions on an **epic** or on a **started sub-issue of an orchestration** are still handled by the `@bgagent` comment flow and its epic panel. The session for those mentions replies with a pointer and closes. Label triggers (`bgagent`, `bgagent:help`) are unchanged. In a workspace that delivers session events, ABCA no longer acts on standalone `@bgagent` comments, because the session answers that same mention and acting on both would start two tasks.

**Re-delegating a finished issue does nothing.** Linear opens no new session and sends ABCA nothing when you delegate an issue whose session is already complete. To restart work, reply inside the existing session.

**Who can act.** Every session request, `stop` included, needs a linked ABCA user ([Inviting teammates](#inviting-teammates)). An unlinked user is told to link their account and nothing runs. A refusal closes the session it was made in, unless that is the session a running task reports into. There the refusal is a note, so someone else's run isn't marked finished or failed. A new task is attributed to whoever asked for it. Steering or stopping a *running* task follows the API's rule: only its owner can do it.

**Reactions.** A session task gets no 👀, ✅ or ❌ reactions on the issue, since the session shows that state. The issue still moves to *In Progress* and *In Review*.

**Not yet supported in sessions:** image and file attachments from the issue description (use a label trigger for those), and Linear's *plan* checklist.

## Adding another workspace

Run `bgagent linear setup <slug>` again for the new workspace. It's the only command that supports the Identity vault, and it runs the same one-consent flow.

You need a new OAuth app only if you want per-workspace isolation. To reuse one app across workspaces, edit it and toggle **Public: ON** so that it can be authorized from any workspace. The trade-off is that a shared app revokes everywhere at once, while per-workspace apps fail independently.

`bgagent linear add-workspace <slug>` is an older, Secrets-Manager-only path that defaults the Client ID to your existing workspace's value (press Enter to reuse). It does not use the vault. Prefer `setup` unless you specifically want the Secrets-Manager-only path.

## Inviting teammates

Setup links **your** Linear identity to your ABCA account. Teammates need their own binding so that their triggers run under their own account, with their concurrency, cost attribution, and notifications.

### Admin: generate the invite

```bash
bgagent linear invite-user <slug>
```

Pick the teammate from the list of human members. You get a one-time code (24-hour TTL) and a command to send them.

### Teammate: redeem it

The teammate needs an ABCA account first. If they don't have one:

1. **Admin** runs `bgagent admin invite-user teammate@example.com` to create their Cognito user (see [Joining an existing deployment in the User guide](/sample-autonomous-cloud-coding-agents/using/authentication#joining-an-existing-deployment) for the full Cognito-side flow).
2. **Teammate** pastes the bundle and the temporary password from the admin into:

   ```bash
   bgagent configure --from-bundle <bundle>
   bgagent login --username teammate@example.com
   # first login prompts you to set a permanent password (temp password is one-time)
   ```

3. **Teammate** runs `bgagent linear link <code>`.

The CLI shows them the Linear name and email and asks for confirmation **before** writing the mapping. If the admin picked the wrong person, the teammate sees it and aborts.

### Why the two-step handshake

`actor=app` installs the app under a synthetic bot user (`<uuid>@oauthapp.linear.app`). Linear's `viewer` query during setup returns that bot user, not the human who clicked Authorize. Self-linking therefore needs the picker.

The admin can't authenticate as a teammate, so the binding has two steps. The admin asserts the Linear identity, and the teammate confirms it from their own authenticated session. No API keys change hands, and no admin can silently misattribute a teammate.

## Reference

### How webhook signature verification works

Linear generates a fresh signing secret per webhook subscription. ABCA stores each workspace's secret on its OAuth bundle (`bgagent-linear-oauth-<slug>`). On each event, ABCA does the following:

1. Parses the body for `organizationId`. The value is untrusted at this point and is used only to select the secret to verify against.
2. Looks up that workspace's registry row. If `status='active'` and the bundle has a `webhook_signing_secret`, verifies the HMAC. On a match, it dispatches the event. **On a mismatch, it returns 401 with no fallback**, since a fallback to the stack-wide secret would let an attacker bypass the per-workspace one.
3. If there's no row, or no per-workspace secret (a pre-migration single-workspace install), falls back to the stack-wide `LinearWebhookSecret`. On a match, the event is trusted. Otherwise it returns 401.

**Trust model.** `organizationId` is attacker-controlled but only *selects* the secret. Forging a signature still requires the secret itself. The no-fallback-on-mismatch rule prevents cross-workspace impersonation.

### Limits and quotas

Linear's rate limits per installed app, per workspace, are **5,000 requests per hour** and **3,000,000 complexity points per hour**. A typical task makes about 10 calls.

Linear access tokens expire in 24 hours. On the Secrets Manager path, ABCA refreshes with the stored `refresh_token` and writes the rotated token back. If Linear returns `invalid_grant` because a concurrent caller already refreshed, the resolver re-reads the secret and uses the fresh token. On the vault path, AgentCore owns the refresh entirely.

## Troubleshooting

### "Invalid redirect_uri parameter for the application"

The URI you're being redirected to isn't registered on the app. Linear reports this at authorize time and the error names the *application*, not the URI, so compare carefully:

- **Is every URI the template printed actually listed?** On the vault, that includes the AgentCore callback that the first `setup` run prints. A missing callback fails here, mid-consent.
- **Was the save accepted?** Reload the app page and confirm that the field still holds the value. Linear validates the whole field at once, so one bad line loses the good ones. The error then looks like it's about the line you just added.
- **Any leading or trailing whitespace?** A copied line can carry indentation. Linear rejects that URI as invalid.
- **One URI per line, no wildcards, no line wrapping.** A wrapped URI becomes two malformed entries.

If the app has been edited repeatedly through failed saves, creating a fresh app with the correct URIs from the start is faster than auditing it.

### Webhook doesn't trigger a task

- Is the project mapped? `aws dynamodb scan --table-name <LinearProjectMappingTableName>`
- Is the workspace registered? Scan `LinearWorkspaceRegistryTable` for the payload's `organizationId`.
- Is **Comments** ticked on the webhook as well as **Issues**? Without it, labels still work but `@bgagent` replies silently never arrive.
- Is the label spelled as configured? Matching is case-insensitive but must be the same word.
- Check CloudWatch for `WebhookFn` and `WebhookProcessorFn`. Common messages: `Invalid Linear webhook signature`, `Linear workspace is not onboarded`, `Linear project is not onboarded`, `Linear actor has no linked platform user`.

### Webhook signature verification fails repeatedly

The stored signing secret doesn't match the subscription that Linear is sending from. Usually the webhook was configured in Linear without telling ABCA, or the secret was rotated:

```bash
bgagent linear update-webhook-secret <slug>
```

To see what's stored:

```bash
aws secretsmanager get-secret-value --secret-id bgagent-linear-oauth-<slug> \
  --query SecretString --output text | jq .webhook_signing_secret
```

If the failing event's `organizationId` matches no registered workspace and the stack-wide secret doesn't match either, a Linear workspace you haven't onboarded has a webhook pointed here. Onboard that workspace or remove the webhook.

### Comments render as "interactive agent activity"

An `@mention` shows up as an interactive agent widget rather than a comment, and replies and reactions don't behave like a thread. The OAuth app is configured as a Linear **agent**.

To fix it, untick the app's **App events** checkboxes (agent session events, inbox notifications, permission changes). Keep the webhook enabled with the **Issues** and **Comments** data-change events. No redeploy is needed. If you want the interactive widget, enable [native agent sessions](#native-agent-sessions-opt-in) instead. With the flag on, ABCA answers in the session.

To confirm ABCA is seeing agent-mode traffic:

```bash
aws logs filter-log-events --log-group-name /aws/lambda/<stack>-LinearIntegrationWebhookFn... \
  --filter-pattern "agent-mode"
```

A `WARN … Ignoring Linear agent-mode webhook …` line names the offending workspace.

### Agent doesn't post comments to Linear

- Does the secret exist? `aws secretsmanager describe-secret --secret-id bgagent-linear-oauth-<slug>`
- Does the registry row's `oauth_secret_arn` match it, with `status='active'`?
- Check the webhook-processor logs, not the agent container. Token resolution and attachment screening happen in the webhook processor, before the task is dispatched.
- `WARN linear_reactions: HTTP 401 from Linear` means that the refresh token was revoked on the Linear side. Re-run `bgagent linear setup <slug>`.
- `resolve_linear_api_token: stored token is expiring and the agent does not refresh` (agent log) means that the agent read the stored token in its last minute or after it expired. The agent never renews the token itself. The next Lambda that needs a token renews it. Until then that task posts no reactions and does not move the issue's state.
- On the vault path, a "consent required" outcome means the grant is gone. Re-run setup.

## Removing a workspace

Deregister a workspace with a single command, the inverse of `setup` or `add-workspace`:

```bash
bgagent linear remove-workspace <slug>
```

The command runs server-side, through an authenticated `DELETE /v1/linear/workspaces/{slug}` call, so the DynamoDB and Secrets Manager permissions stay on the API role, not on your local IAM identity. By default the command does the following:

- Marks the registry row `status=revoked` with `revoked_reason=admin_removed`, which preserves the audit trail. Because the row is revoked, the workspace stops resolving tokens and routing webhooks the instant the command returns. The OAuth resolver refuses every non-`active` row except the one kind that it re-probes, a `revoked` row whose reason is `vault_consent_required`. `admin_removed` is deliberately not that reason, so an admin removal is terminal and a later vault probe cannot clear it.
- Deletes the per-workspace `bgagent-linear-oauth-<slug>` secret from Secrets Manager, and reports which of three things happened: `deleted` (a live secret was destroyed), `absent` (already gone, after a re-run or a prior partial teardown), or `not_applicable` (this workspace is vault-managed and has no Secrets Manager secret of its own).

Only the workspace **admin** may remove it. The admin is the platform user who ran `setup` or `add-workspace` for the slug. The command prompts you to re-type the slug before it tears anything down.

> **Vault-managed workspaces are not fully torn down by this command.** If the registry row has a `provider_name`, the workspace's credential lives in an AgentCore OAuth2 credential provider created outside CloudFormation. This command does not delete the provider. It names the provider. The CLI prints the exact `delete-oauth2-credential-provider` follow-up. See [Vault-managed workspaces: the credential provider outlives the stack](#vault-managed-workspaces-the-credential-provider-outlives-the-stack) below.

Flags:

- `--purge` deletes the registry row entirely instead of keeping it with `status=revoked`. Deleting the row drops the audit trail. The row is still revoked first (fail-closed) and is hard-deleted only after the OAuth secret is confirmed gone.
- `--yes` skips the slug-confirmation prompt (for scripted use).

> **Project-to-repo mappings are not removed by this command.** Mapping rows carry no workspace identifier, so they cannot be attributed to a workspace. Remove a workspace's mappings by project id (see below).

Then, on the Linear side, delete the Linear webhook from [Linear's API settings](https://linear.app/settings/api) and uninstall the OAuth app from [the Integrations page of the workspace settings](https://linear.app/settings/integrations).

### Deactivating a single project mapping

To remove one project-to-repo mapping, use this command. It is the only supported way to tear a mapping down:

```bash
aws dynamodb update-item \
  --table-name <LinearProjectMappingTableName> \
  --key '{"linear_project_id":{"S":"<uuid>"}}' \
  --update-expression 'SET #s = :removed' \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":removed":{"S":"removed"}}'
```

### Manual fallback

If `remove-workspace` returns the `SECRET_DELETE_FAILED` error code, the workspace is already revoked (fail-closed, so it no longer resolves tokens or routes webhooks), but its OAuth secret was orphaned. The handler records this durably on the registry row: `secret_deletion_failed = true`, `secret_deletion_error` (the failing error name), and `orphaned_oauth_secret_arn` (the exact secret ARN to purge). When you see that marker or the error code, run the `delete-secret` step below against `orphaned_oauth_secret_arn` to finish teardown.

If `remove-workspace` returns the `WORKSPACE_SLUG_AMBIGUOUS` error code (HTTP 409), more than one `active` registry row carries the slug, and the command changed nothing. The message names the `linear_workspace_id` of each of those rows. On a row, `team_keys` (the workspace's Linear team keys, such as the `ENG` of `ENG-42`, when recorded), `installed_at` and `installed_by_platform_user_id` tell them apart.

1. Use the `update-item` command below to revoke each workspace that should go, by its id. Leave out the `delete-secret` step and the credential-provider step as long as another `active` row carries the slug. The rows share the secret and the provider, both named after the slug.
2. Run `bgagent linear setup` again for each workspace that stays, under its own URL key if that differs from the slug. `setup` prints the workspace it authorized, which has to be that one.

Once a single `active` row is left for the slug, `remove-workspace <slug>` works again. Run it if that workspace should go too, and it deletes the secret and names the provider as usual.

If no `active` row is left for the slug, because each one was revoked by hand or set up again under another URL key, finish teardown by hand. Run the `delete-secret` step for the slug and, if the workspaces were vault-managed, the credential-provider step.

If the CLI is unavailable, you can revoke a workspace directly. The result is equivalent to the default `remove-workspace` flow. **Run the registry revoke first, then delete the secret**, the same order that the handler uses. If you delete the secret first, an `active` registry row is left with no credential behind it. Token resolution then fails on every event without latching the row, because the resolver deliberately declines to infer a revocation from a missing secret. The workspace therefore keeps presenting itself as active. Webhook signature verification lets Secrets Manager errors propagate, so that a transient failure can't silently downgrade to the stack-wide secret. The receiver therefore returns 500 and Linear retries the delivery. Revoking first shuts the workspace off deterministically at the registry, and the secret delete is then only cleanup.

```bash
aws dynamodb update-item \
  --table-name <LinearWorkspaceRegistryTableName> \
  --key '{"linear_workspace_id":{"S":"<linear-org-uuid>"}}' \
  --update-expression 'SET #s = :revoked, revoked_reason = :reason' \
  --condition-expression '#s = :active' \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":revoked":{"S":"revoked"},":active":{"S":"active"},":reason":{"S":"admin_removed"}}'

aws secretsmanager delete-secret --secret-id bgagent-linear-oauth-<slug> --force-delete-without-recovery
```

The `--condition-expression` makes a second run against an already-revoked row fail with `ConditionalCheckFailedException` instead of silently re-revoking. `remove-workspace` behaves the same way for a workspace that it has removed. It leaves out rows revoked with `admin_removed`, so **re-running it on an already-removed workspace returns 404**, not a second success. That 404 does not distinguish "removed" from "never existed". A workspace that the platform itself marked `revoked` because it lost its Linear grant (`revoked_reason` `refresh_token_rejected` or `vault_consent_required`) is not removed yet. That mark deleted nothing, so whatever secret the workspace has is still in Secrets Manager, and `remove-workspace` removes that workspace like an active one. The command also accepts a row revoked by hand without a `revoked_reason`. If that row's secret is already gone, the command reports `absent`.

Vault-managed workspaces need one more step after these two. See [the credential-provider section](#vault-managed-workspaces-the-credential-provider-outlives-the-stack).

### Vault-managed workspaces: the credential provider outlives the stack

If the workspace was onboarded with the Identity vault (its registry row has a
`provider_name`), `setup` created an **AgentCore credential provider** outside
CloudFormation. `cdk destroy` removes the workload identity but leaves the provider
behind. The provider still holds your Linear Client ID, your Client Secret, and a live
grant that keeps refreshing. The provider does not appear in `cdk diff` or drift detection.

List the providers and delete them explicitly:

```bash
aws bedrock-agentcore-control list-oauth2-credential-providers --region <region>
aws bedrock-agentcore-control delete-oauth2-credential-provider \
  --name bgagent-linear-oauth-<slug> --region <region>
```

Do this **before** `cdk destroy` if you can. Afterwards you have to know the provider
names, since nothing left in the account references them.
