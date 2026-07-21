# Jira integration setup guide

Set up the ABCA Jira Cloud integration so that adding a label to a Jira issue triggers an autonomous task. ABCA posts progress comments back on the issue as it works — a "started" comment from the agent and a final status comment (with cost, turns, and duration) from the platform when the task finishes.

## Prerequisites

- ABCA CDK stack deployed **at a version that includes the Jira integration** ([#302](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/302), merged 2026-06-17) — a stack deployed before that has no Jira resources and needs a sync + redeploy first (see [Developer guide](./DEVELOPER_GUIDE.md))
- A Cognito user account configured (see [User guide](./USER_GUIDE.md))
- A Jira Cloud site where you have **admin** access (to create the OAuth app and the webhook)
- The `bgagent` CLI installed and logged in (`bgagent configure` + `bgagent login`)

> **Jira Cloud only.** Jira Server / Data Center are out of scope. The integration uses Jira REST v3 and Atlassian Cloud webhooks.

## How it works

A Jira-site admin creates an Atlassian OAuth 2.0 (3LO) app and authorizes it on the site. The OAuth token bundle is stored in a per-tenant Secrets Manager secret (`bgagent-jira-oauth-<cloudId>`). When a user adds the trigger label to a Jira issue, Jira fires a webhook to ABCA; the receiver verifies the `X-Hub-Signature` HMAC, dedupes, and async-invokes the processor, which resolves the tenant, looks up the project→repo mapping, enriches the task with the issue's recent comments and screened file attachments (see [Issue context](#issue-context-attachments-and-comments)), and creates a task. Jira-triggered tasks always run the `coding/new-task-v1` workflow (the processor pins `workflow_ref` explicitly, since a label-triggered task always targets a mapped repo). The agent clones the repo, opens a PR, and posts a "started" comment on the Jira issue via the Jira REST v3 API (using the same stored OAuth token). When the task reaches a terminal state, the platform's fan-out plane posts a single final status comment — outcome, cost, turns, duration, and PR link — via the same REST v3 endpoint (see [How it works](#how-it-works) below).

**Tenant key.** Everything is indexed on `cloudId` — the Atlassian tenant UUID, *not* the site domain or name. Webhook payloads and the OAuth flow both surface `cloudId`; it is the join key across the project-mapping, user-mapping, and workspace-registry tables.

Inbound (Jira → ABCA):

```
Jira Cloud webhook
  → POST /v1/jira/webhook  (API GW, no Cognito, HMAC-verified)
  → JiraWebhookFn        (verify X-Hub-Signature, dedup, async invoke)
  → JiraWebhookProcessorFn (resolve tenant OAuth, look up project→repo,
                            build task, call createTaskCore)
  → existing orchestrator pipeline (unchanged)
```

Outbound (Agent → Jira) — REST v3:

```
runner picks task with channel_source="jira"
  → jira_reactions resolves the OAuth access token from
    bgagent-jira-oauth-<cloudId> (JIRA_API_TOKEN)
  → agent posts a "started" comment via
    POST api.atlassian.com/ex/jira/{cloudId}/rest/api/3/issue/{key}/comment
```

Outbound terminal status (Platform → Jira) — REST v3, deterministic:

```
task reaches a terminal event (completed / failed / cancelled /
  stranded / timed out) → TaskEventsTable DynamoDB Stream → fan-out
  Lambda's dispatchToJira resolves the OAuth token and posts ONE
  final-status comment with cost, turns, duration, task id, and the
  PR link, via the same REST v3 comment endpoint
```

Outbound board transitions (Agent → Jira) — REST v3:

```
task starts → agent moves the issue to an In Progress status via
  POST api.atlassian.com/ex/jira/{cloudId}/rest/api/3/issue/{key}/transitions
PR opened → agent moves the issue to an "In Review" status via the same endpoint
```

So the Jira board reflects the task lifecycle at a glance, the agent transitions
the originating issue as it works — the same signal Linear-origin tasks already
give. See [Board transitions](#board-transitions) below for the resolution order
and the permission it requires.

The **start** comment is posted by the agent. The **terminal** comment is
posted by the platform's fan-out plane, not the agent — so it always includes
cost / turns / duration and fires even when the agent crashes before
completing (max-turns, OOM). The final comment frames three outcomes:

- ✅ **Task completed** — with the PR link when one was opened.
- ⚠️ **Shipped a PR but stopped early** — the PR link plus the reason it
  stopped (e.g. "Hit max-turns cap"), so you can review and decide.
- ❌ **Task failed / cancelled / timed out** — with a short classifier reason.

Comments are advisory and best-effort: network/auth failures are logged and
swallowed (the agent path has an auth circuit-breaker; the platform path
classifies transient failures as retryable and retries the record), never
gating the task itself. Jira has no comment-edit API, so the terminal comment
is posted exactly once (a per-task marker guards against duplicate posts on
stream retries).

> **Why REST, not the Atlassian Remote MCP?** The hosted MCP
> (`mcp.atlassian.com`) requires an interactive, browser-based OAuth 2.1 flow
> with dynamic client registration and won't accept the stored REST OAuth
> token as a Bearer header, so it can't connect from a headless agent. The
> REST v3 API accepts the same token (it carries `write:jira-work`). See
> [ADR-015](../decisions/ADR-015-jira-integration.md). A `jira-server` MCP
> entry is still written to `.mcp.json` as a forward-looking placeholder, but
> it is expected to fail to connect today and the outbound path does not
> depend on it.

Inbound admission (webhook → task) is Jira-specific and has no DynamoDB Streams consumer of its own. The **terminal** status comment, however, is delivered by the shared fan-out plane's DynamoDB Streams consumer (`dispatchToJira`) — the same platform-side surface that posts Linear final-status comments — so it behaves identically to Linear for terminal outcomes.

## Setup walkthrough

### 1. Print the OAuth app template

```bash
bgagent jira app-template
```

This prints the exact field values to paste into Atlassian's developer console, including the three required scopes:

- `read:jira-work` — read issues
- `write:jira-work` — post comments, transition issues
- `read:jira-user` — resolve `accountId` → display name during link preview

`offline_access` is requested by the authorize step (so Atlassian returns a `refresh_token`) — **do not** add it as a togglable scope in the dev-console UI; the console doesn't list it and passing it in the authorize request is sufficient.

Open <https://developer.atlassian.com/console/myapps/> → **Create → OAuth 2.0 integration** and fill in the fields exactly as the template lists. Under **Authorization → OAuth 2.0 (3LO)**, set the Callback URL to the value the template prints (defaults to `http://localhost:8080/oauth/callback`). The `redirect_uri` sent during `setup` must byte-match this value.

Click **Save**, then open **Settings** and copy the **Client ID** and **Client Secret**.

### 2. Authorize the app on the tenant

```bash
bgagent jira setup
```

This runs the OAuth 3LO dance:

1. Prompts for the **Client ID** and **Client Secret** (or pass `--client-id` / `--client-secret`; prefer interactive so the secret stays off your shell history).
2. Opens your browser to Atlassian's consent screen. **Make sure your browser is signed into the right Atlassian site** before authorizing. (Use `--no-browser` on a headless/SSH box to print the URL instead.)
3. After you Authorize, the browser redirects to a localhost page — that's expected.
4. If your account can access multiple Atlassian sites, the CLI lists them and asks you to pick one. It records the selected site's `cloud_id` and `site_url`.
5. Stores the OAuth token bundle in `bgagent-jira-oauth-<cloudId>` and records the tenant in the workspace registry.

> **If `setup` hangs at "Waiting for browser callback…"** the consent redirect never reached the CLI's localhost listener. Usual causes: the consent tab was completed in a *different* browser/profile than the one `setup` opened, the tab was closed before clicking Authorize, or something else is bound to port 8080. Ctrl-C and re-run `bgagent jira setup` — re-running is safe and idempotent (it re-mints the token bundle and re-registers the tenant; nothing is half-written by an aborted attempt).

### 3. Configure the Jira webhook

`setup` then prompts for a **webhook signing secret**. Unlike Linear, Atlassian does **not** auto-generate one — the operator chooses it at webhook-create time. In a second terminal, open **Jira → Settings → System → Webhooks → Create a Webhook** and enter:

- **URL** — the `…/jira/webhook` URL that `setup` prints
- **Events** — *Issue: created* and *Issue: updated*
- **Secret** — a strong random value, e.g. `openssl rand -hex 32`

Paste that same secret value back at the `Webhook signing secret:` prompt. ABCA stores it on the per-tenant OAuth bundle (and mirrors it stack-wide), and the receiver looks it up to verify `X-Hub-Signature` on each delivery.

### 4. Map a project to a repository

```bash
bgagent jira map <cloud-id> <PROJECT-KEY> --repo owner/repo
```

- `<cloud-id>` — the tenant UUID. `setup`'s final **Next steps** block prints this exact `map` command with the cloudId pre-filled — paste it and swap in your project key and repo. If that terminal output is gone, recover the cloudId from `https://<your-site>.atlassian.net/_edge/tenant_info` (returns it as JSON) or from the workspace-registry table — it is *not* shown anywhere in the Jira UI
- `<PROJECT-KEY>` — the Jira project key, e.g. `ENG` (uppercase, starts with a letter)
- `--repo owner/repo` — the GitHub repository tasks from this project route to
- `--label <name>` — trigger label (default `bgagent`)
- `--status-on-start <name>` — Jira status to move the issue to when a task starts (overrides the heuristic; see [Board transitions](#board-transitions))
- `--status-on-pr <name>` — Jira status to move the issue to when a PR is opened (overrides the `In Review` default)

This writes an `active` row keyed `<cloudId>#<projectKey>` into the project-mapping table. Requires admin IAM (it writes DynamoDB directly).

### 5. Link your Jira identity

So tasks triggered from Jira attribute to your platform user (concurrency caps, billing, `bgagent list`), link your Atlassian `accountId` to your ABCA account. An admin issues a one-time invite code, then the teammate redeems it.

#### Admin: generate the invite

```bash
bgagent jira invite-user <cloud-id> <account-id-or-email>
```

The command resolves the Jira user through the tenant OAuth token, writes a `pending#<code>` row with a 24-hour TTL, and prints the `bgagent jira link <code>` command to send to the teammate. It requires admin IAM for the stack tables/secrets and a logged-in `bgagent` CLI session for the `invited_by_platform_user_id` audit field.

- `<cloud-id>` — the tenant UUID from `setup` or `https://<your-site>.atlassian.net/_edge/tenant_info`
- `<account-id-or-email>` — the teammate's Atlassian `accountId` or email address. If email search is hidden/ambiguous, use `accountId`; Jira profile URLs end in `/people/<accountId>`.

#### Teammate: redeem the invite

```bash
bgagent jira link <code>
```

The CLI shows the Jira identity (name + email) and the tenant, and asks for confirmation **before** writing the mapping row — so a mis-issued code is caught before it binds.

The teammate needs their own ABCA account first (Cognito user + configured CLI). If they do not have one yet, the admin runs `bgagent admin invite-user teammate@example.com`, then the teammate runs `bgagent configure --from-bundle <bundle>` and `bgagent login --username teammate@example.com` before redeeming the Jira invite.

### 6. Test

Add the trigger label (`bgagent` by default) to a Jira issue in a mapped project. The agent should start within ~30 seconds, comment on the issue as it works, and post a PR link when ready. The issue **summary** plus the **description** (converted from Atlassian Document Format to markdown), the issue's **recent comments**, and any supported **file attachments** become the task context — see [Issue context: attachments and comments](#issue-context-attachments-and-comments).

## How webhook signature verification works

Atlassian signs each delivery with HMAC-SHA256 over the **raw request body**, delivered as `X-Hub-Signature: sha256=<hex>`. The receiver:

1. Computes `HMAC-SHA256(rawBody, secret)` and compares it constant-time against the header value (tolerating a pasted value with or without the `sha256=` prefix).
2. Prefers the **per-tenant** signing secret stored on `bgagent-jira-oauth-<cloudId>`; falls back to the stack-wide `JiraWebhookSecret` for installs that predate per-tenant storage.
3. Rejects with 401 on mismatch.

The body must be verified as the *raw unparsed bytes* — never parsed-and-restringified JSON, which would change the byte sequence and break the HMAC.

## Label-trigger semantics

- **`jira:issue_created`** — triggers if the trigger label is already present on the new issue.
- **`jira:issue_updated`** — triggers only if the label was **newly added** in this update. Jira reports label changes in `changelog.items[]` (`field: "labels"`, with `fromString` / `toString`), *not* by re-sending the full label list. The processor diffs the changelog rather than inspecting `issue.fields.labels`, so re-saving an issue that already has the label does not re-trigger.
- All other event types get a silent `200`.

## Issue context: attachments and comments

Beyond the summary and description, the processor enriches the task with the practical context a Jira ticket usually carries — attached files and recent clarifications — so the agent isn't left guessing at "see the attached log" or an acceptance detail buried in a comment. Both are fetched **authenticated at task-admission time** using the tenant's existing `read:jira-work` scope (**no new OAuth scopes, no re-authorization**), because a headless agent can't fetch them itself.

### File attachments

Jira-hosted `media` attachments are downloaded through the Jira REST API, run through the **same Bedrock Guardrail content screening** as every other ABCA attachment, and stored for the agent — only after they pass.

- **Supported types** — images `image/png`, `image/jpeg`; files `text/plain`, `text/csv`, `text/markdown`, `application/json`, `application/pdf`, `text/x-log`.
- **Limits** — at most **10 attachments per task** (shared with any images embedded in the description), **10 MB per file**, **50 MB total**.
- **Unsupported or oversized attachments are skipped silently** — they simply don't reach the agent; the task still runs with the rest of the context.
- **Fail-closed on unsafe content** — if a *selected* attachment can't be safely downloaded or screened (blocked by the guardrail, a content/type mismatch, a download/auth failure, or missing screening configuration), the task is **rejected** with a ❌ comment on the issue rather than run with missing context. Fix or remove the attachment and re-apply the trigger label.
- Embedded HTTPS image URLs in the description continue to work exactly as before.

### Recent comments

The most recent **human** comments (up to 10, oldest-first) are folded into the task description under a **Recent comments** heading, each attributed to its author. ABCA's own progress/final-status comments and other app/bot comments are excluded (filtered by Atlassian `accountType`). Comment enrichment is **best-effort / fail-open**: if the fetch fails, the task proceeds without comments (a warning is logged) — comments are advisory context, never a gate. Long comment histories are not fetched in full; only the recent window is included.

## Board transitions

As a Jira-triggered task progresses, the agent moves the originating issue across its workflow so the board reflects reality — the same at-a-glance signal Linear-origin tasks already give:

- **Task start** → the issue moves to an **In Progress** status.
- **PR opened** → the issue moves to a **review** status (default **In Review**, falling back to In Progress so a stock board isn't skipped).
- **Task failed or no PR opened** → the status is **left unchanged**; the ❌ final-status comment is the signal, and bouncing a card back and forth is noisier than leaving it where a human sees the failure.
- **Already at or past the target** → the transition is **skipped**, so a re-triggered task never drags a card backward (e.g. from In Review back to In Progress). This mirrors the Linear integration.

Humans still move the card to **Done** after merging the PR — ABCA never closes issues.

**How a target status is resolved** (evaluated per lifecycle point, first match wins — modeled on the Linear integration):

1. **Per-project override** — the `--status-on-start` / `--status-on-pr` names configured on the project mapping. Matched case-insensitively against the destination status name. An override is a deliberate instruction: it's honored regardless of the current status, and if it isn't reachable, ABCA skips (no heuristic fallback).
2. **Name match** (no config needed for standard workflows):
   - On start, a transition whose destination is named **In Progress**.
   - On PR opened, a transition named **In Review**, then common synonyms (`Code Review`, `Review`, `Peer Review`, `Reviewing`), then **In Progress** as a last resort.
3. **Category fallback** — any transition whose destination `statusCategory` is *In Progress* (`indeterminate`), **excluding `Blocked`** (which shares that category but is never what "move to In Progress" means). The name match in step 2 is what keeps the heuristic from landing on `Blocked` when both are available.
4. **Skip with a warning** — nothing matches, the transition requires a screen with required fields, or the authorizing user lacks permission. The task is never affected.

Transitions are **best-effort**, exactly like comments: short timeout, errors logged and swallowed, sharing the same `401`/`403` auth circuit breaker. A transition failure never fails, blocks, or retries the task. Transition IDs are workflow- and current-status-specific, so they are resolved per-issue at call time (by matching destination name / category) — never configured or hard-coded.

> **Permission prerequisite.** The transition uses the existing `read:jira-work` / `write:jira-work` scopes — **no new OAuth scopes and no re-authorization**. OAuth scopes do not, however, override Jira **project permissions**: the authorizing user must have the **Transition Issues** permission in each mapped project. When they don't, Jira's *get transitions* call returns an empty list (not an error), so ABCA simply skips the transition and logs a warning — comments still post as normal.

The feature targets Jira **statuses**, not board columns. Because moving a card between columns *is* a status transition under the hood, no board-configuration API is involved. Multi-hop pathfinding is out of scope: if no single transition reaches the target from the current status, ABCA skips.

## Webhook dedup

The receiver dedupes on `{issueKey}#{webhookEventTimestamp}` with an 8-hour TTL. Using the event timestamp (rather than event type) means two distinct label-adds in quick succession are not collapsed. Jira retries far less aggressively than Linear, so 8 hours is safe parity.

## Usage

- **Trigger a task**: add the trigger label to an issue in a mapped Jira project.
- **Check status**: from the Jira issue (progress comments) or `bgagent list` / `bgagent status <task-id>`.
- **Cancel**: `bgagent cancel <task-id>`. Removing the Jira label does not cancel a running task.

## Troubleshooting

### Webhook doesn't trigger a task

- Is the project mapped? Scan `JiraProjectMappingTable` for `<cloudId>#<projectKey>` with `status = 'active'`.
- Is the tenant registered? Scan `JiraWorkspaceRegistryTable` for the `cloudId` from the webhook payload.
- Is the label spelled exactly as configured? Match is case-insensitive but must be the same word.
- For an `issue_updated` event, confirm the label was *added in this update* — re-saving an issue that already carries the label won't re-trigger by design.
- Check CloudWatch logs for `JiraWebhookFn` and `JiraWebhookProcessorFn`.

### Webhook signature verification fails repeatedly (401)

The signing secret stored for this tenant doesn't match what Jira is sending. Most often the value pasted at the `Webhook signing secret:` prompt differs from the one entered in Jira's webhook config (or the webhook secret was rotated in Jira). Re-run `bgagent jira setup` for the tenant and re-enter matching values. To inspect what's stored:

```bash
aws secretsmanager get-secret-value \
  --secret-id bgagent-jira-oauth-<cloudId> \
  --query SecretString --output text | jq .webhook_signing_secret
```

### `setup` hangs at "Waiting for browser callback…"

The consent redirect never reached the CLI's localhost listener — see the note under [Step 2](#2-authorize-the-app-on-the-tenant). Ctrl-C and re-run `bgagent jira setup`; re-running is safe.

### 401 when calling the Jira API directly after setup

Expected, not a broken install. The stored access token lives ~1 hour and is only refreshed by the **trusted Lambda paths** when they next run — i.e. on the next webhook delivery (see [Limits and quotas](#limits-and-quotas)). If you fetch the token from Secrets Manager right after `setup` to verify it and get a 401, the integration is still fine: add the trigger label to an issue and the processor will refresh the bundle before using it.

**Do not refresh the token manually.** Atlassian rotates the `refresh_token` on every use, and the rotated bundle must be written back to Secrets Manager *preserving every other field* — in particular `webhook_signing_secret`. A manual refresh that drops a field or loses the rotated refresh token bricks the tenant install (the only recovery is re-running `bgagent jira setup`). If you need a live token for debugging, trigger a label event and read the bundle the Lambda just wrote.

### Agent doesn't comment back on Jira

- Verify the per-tenant OAuth secret exists: `aws secretsmanager describe-secret --secret-id bgagent-jira-oauth-<cloudId>`.
- Verify the registry row's `oauth_secret_arn` matches and `status = 'active'`.
- Check the agent container logs for `jira_reactions` lines (`comment_task_started`). Absence means `channel_source` wasn't `jira` on the task, or the tenant OAuth token didn't resolve. (The `jira-server` MCP entry is also written to `.mcp.json`, but it is a non-functional placeholder — its connection failure is expected and is not the cause.)
- A `401`/`403` from Atlassian usually means the token was revoked tenant-side, or the stored access token expired and the agent (which never refreshes) failed closed — re-run `bgagent jira setup` to re-mint, then re-apply the label.

### Jira card doesn't move across the board

Board transitions are best-effort and never block the task, so a card can stay put while comments still post. Common causes:

- **The authorizing user lacks *Transition Issues* permission** in the project. Jira then returns an empty transition list and ABCA skips with a warning. Grant the permission to the account that ran `bgagent jira setup`.
- **No matching destination.** The standard heuristics look for an *In Progress*-category status on start and an `In Review`-named status on PR. Custom workflows may name these differently — configure `bgagent jira map ... --status-on-start "<name>" --status-on-pr "<name>"`.
- **The transition requires a screen** with required fields. ABCA skips these by design (it can't fill required fields) — pick a screen-less transition or remove the required fields from the workflow.
- **No single-hop transition reaches the target** from the issue's current status. ABCA does not chain transitions.
- Check the agent container logs for `jira_reactions: transition …` lines — they name the chosen destination or the skip reason.

## Limits and quotas

Atlassian access tokens are short-lived. The **trusted Lambda paths** (`jira-oauth-resolver.ts` — the webhook processor and orchestrator) auto-refresh via the stored `refresh_token` (which is why `offline_access` is required) and write the rotated bundle back to Secrets Manager. The **agent never refreshes**: Atlassian rotates the `refresh_token` on every use and the agent role has `GetSecretValue` only, so an agent-side refresh would burn the stored token without being able to persist its replacement. The agent uses whatever token the Lambdas most-recently wrote (resolved just before the session starts) and fails closed on an already-expiring token. Jira Cloud REST rate limits are generous relative to a typical task's handful of API calls.

## Removing the integration

Deactivate a project mapping:

```bash
aws dynamodb update-item \
  --table-name <JiraProjectMappingTableName> \
  --key '{"jira_project_identity":{"S":"<cloudId>#<PROJECT-KEY>"}}' \
  --update-expression 'SET #s = :removed' \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":removed":{"S":"removed"}}'
```

Revoke a tenant install:

```bash
aws secretsmanager delete-secret \
  --secret-id bgagent-jira-oauth-<cloudId> --force-delete-without-recovery

aws dynamodb update-item \
  --table-name <JiraWorkspaceRegistryTableName> \
  --key '{"jira_cloud_id":{"S":"<cloudId>"}}' \
  --update-expression 'SET #s = :revoked' \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":revoked":{"S":"revoked"}}'
```

Then delete the webhook from **Jira → Settings → System → Webhooks** and remove the OAuth app from the Atlassian developer console.
