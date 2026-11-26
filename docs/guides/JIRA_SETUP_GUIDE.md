# Jira integration setup guide

Set up the ABCA Jira Cloud integration so that adding a label to a Jira issue triggers an autonomous task. After ABCA opens a pull request, reviewers can comment `@bgagent <instruction>` on the same Jira issue to request another iteration. A dedicated Forge app named `bgagent` writes progress comments and workflow transitions. The human who triggered the task remains its platform owner.

## Prerequisites

- An ABCA CDK stack deployed **at a version that includes the Jira integration** ([#302](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/302), merged 2026-06-17), with the `jira` feature enabled in its [deployment profile](./DEPLOYMENT_GUIDE.md#deployment-profiles). A stack deployed before that version has no Jira resources and needs a sync and a redeploy first (see the [Developer guide](./DEVELOPER_GUIDE.md)).
- A Cognito user account configured (see [User guide](./USER_GUIDE.md))
- A Jira Cloud site where you have **admin** access (to create the OAuth app, install the Forge app, and create the webhook)
- The `bgagent` CLI installed and logged in (`bgagent configure` and `bgagent login`)
- Node.js 22 and the [Atlassian Forge CLI](https://developer.atlassian.com/platform/forge/getting-started/#install-the-forge-cli) for the dedicated outbound app identity
- An Atlassian [Forge CLI scoped token](https://go.atlassian.com/forge-cli-api-token). This token is separate from the Jira OAuth token that you create below.
- AWS operator credentials that can read the target stack outputs and update its Jira registry and per-tenant secret

> **Jira Cloud only.** Jira Server and Jira Data Center are out of scope. The integration uses Jira REST v3 and Atlassian Cloud webhooks.

The examples use explicit stack and region variables because Jira admin commands default to `backgroundagent-dev`. Set these variables once, so that a custom deployment is not configured accidentally:

```bash
REGION=us-east-1
STACK_NAME=backgroundagent-dev
```

## How it works

A Jira-site admin configures two Atlassian identities with distinct responsibilities:

- An **OAuth 2.0 (3LO) integration** reads inbound issue context and resolves human users. Atlassian 3LO acts on behalf of the person who authorized it, so it cannot provide a bot author for outbound writes.
- A **Forge app** handles outbound comments and transitions through `api.asApp().requestJira(...)`. Jira attributes those actions to the app account named `bgagent`.

The per-tenant Secrets Manager secret (`bgagent-jira-oauth-<cloudId>`) stores the OAuth bundle and the signed Forge proxy configuration together. When a user adds the trigger label, Jira sends a webhook to ABCA. The receiver verifies the `X-Hub-Signature` HMAC, deduplicates the delivery, resolves the human task owner through `JiraUserMappingTable`, enriches the task with issue context, and creates a task. A later `@bgagent` comment runs `coding/pr-iteration-v1` against the issue's latest ABCA pull request. The outbound app identity does not change the human trigger attribution.

**Tenant key.** Everything is indexed on `cloudId`, the Atlassian tenant UUID, *not* the site domain or name. Webhook payloads and the OAuth flow both provide `cloudId`. It is the join key across the project-mapping, user-mapping, and workspace-registry tables.

Inbound, from Jira to ABCA:

```
Jira Cloud webhook
  → POST /v1/jira/webhook  (API GW, no Cognito, HMAC-verified)
  → JiraWebhookFn        (verify X-Hub-Signature, dedup, async invoke)
  → JiraWebhookProcessorFn (resolve tenant OAuth, look up project→repo,
                            build task, call createTaskCore)
  → existing orchestrator pipeline (unchanged)
```

Outbound, from the agent to Jira, as the Forge app actor:

```
runner picks task with channel_source="jira"
  → jira_reactions resolves the signed Forge proxy configuration from
    bgagent-jira-oauth-<cloudId>
  → agent sends an HMAC-authenticated, operation-allowlisted request
  → Forge calls api.asApp().requestJira(...)
```

Outbound terminal status, from the platform to Jira, as the Forge app actor, deterministic:

```
ordinary task reaches a terminal event (completed / failed / cancelled /
  stranded / timed out) → TaskEventsTable DynamoDB Stream → fan-out
  Lambda's dispatchToJira resolves the same Forge proxy and posts ONE
  app-authored final-status comment with cost, turns, duration, task id,
  and the PR link

@bgagent iteration is admitted → JiraWebhookProcessor posts ONE
  app-authored status comment and stores its comment id
  → heartbeat edits that comment with elapsed time while the task runs
  → fan-out (standalone) or reconciler (orchestrated child) edits that
  same comment with the terminal outcome and metrics
```

Outbound board transitions, from the agent to Jira, as the Forge app actor:

```
task starts → signed proxy → Forge app moves the issue to In Progress
PR opened → signed proxy → Forge app moves the issue to In Review
```

The agent transitions the originating issue as it works, so that the Jira
board shows the task lifecycle. Linear-origin tasks already give the same
signal. See [Board transitions](#board-transitions) below for the resolution
order and the permission that a transition requires.

For an ordinary task, the agent posts the **start** comment and the platform's
fan-out plane posts the **terminal** comment. For an `@bgagent` iteration, the
processor immediately posts one status comment. The heartbeat and the terminal
owner edit that same comment in place. Terminal feedback therefore includes
cost, turns, and duration even when the agent crashes before it completes
(max-turns, OOM). The final state is one of four outcomes:

- ✅ **Task completed.** The comment has the PR link when one was opened and,
  for an `@bgagent` question that needed no change, the agent's answer.
- ⚠️ **Shipped a PR but stopped early.** The comment has the PR link plus the
  reason the task stopped (for example, "Hit max-turns cap"), so that you can
  review and decide.
- ❌ **Task failed / cancelled / timed out.** The comment has a short
  classifier reason.
- 🤖 **ABCA has a question before it starts.** A task started by the trigger
  label stopped to ask instead of changing anything and opened no PR. The
  comment carries the question. Add the details to the issue, then re-apply
  the trigger label to run it again.

Comments are advisory and best-effort. Network and auth failures are logged and swallowed, and never gate the task itself. The agent path has an auth circuit-breaker. The platform path classifies transient failures as retryable and retries the record. Ordinary terminal comments use a per-task post-once marker. Iteration terminal writers use a per-task claim before they update the stored comment ID, and the heartbeat checks that claim before it writes, so retries do not duplicate the comment or return a terminal outcome to running.

**Identity selection rule.** A complete Forge app configuration always takes precedence for every outbound path. If that configured proxy, signature, permission, or Jira API call fails, ABCA logs the failure and skips the advisory write. It does **not** retry as the 3LO user. Tenants with no Forge configuration retain the old 3LO writer as an explicit migration fallback, with a warning.

> **Why Forge app-auth, not 3LO or the Atlassian Remote MCP?** Atlassian 3LO
> authorizes calls on behalf of the consenting user, so renaming that OAuth
> integration cannot make Jira history show a bot actor. The hosted MCP
> (`mcp.atlassian.com`) requires an interactive, browser-based OAuth 2.1 flow
> and cannot connect from a headless agent. Forge provides the supported app
> actor through `api.asApp().requestJira(...)`. See
> [ADR-015](../decisions/ADR-015-jira-integration.md).

Inbound admission, from webhook to task, is Jira-specific and has no DynamoDB Streams consumer of its own. The shared fan-out plane's DynamoDB Streams consumer (`dispatchToJira`) delivers ordinary **terminal** status comments. For comment-triggered iterations, fan-out matures standalone status comments, and the orchestration reconciler matures child-iteration comments before it restacks dependents.

## Setup walkthrough

### 1. Print the Atlassian app template

```bash
bgagent jira app-template
```

The command prints the OAuth fields and the Forge app-actor workflow. The 3LO integration needs these scopes:

- `read:jira-work`. Read issues.
- `write:jira-work`. Post comments and transition issues.
- `read:jira-user`. Resolve an `accountId` to a display name during link preview.

The authorize step requests `offline_access`, so that Atlassian returns a `refresh_token`. **Do not** add it as a togglable scope in the dev-console UI. The console doesn't list it, and passing it in the authorize request is sufficient.

Open <https://developer.atlassian.com/console/myapps/>, select **Create → OAuth 2.0 integration**, and fill in the fields exactly as the template lists them. Under **Authorization → OAuth 2.0 (3LO)**, set the Callback URL to the value that the template prints. The default is `http://localhost:8080/oauth/callback`. The `redirect_uri` sent during `setup` must match this value byte for byte.

Click **Save**, then open **Settings** and copy the **Client ID** and **Client Secret**.

### 2. Authorize the app on the tenant

```bash
bgagent jira setup \
  --region "$REGION" \
  --stack-name "$STACK_NAME"
```

The command runs the OAuth 3LO flow:

1. The CLI prompts for the **Client ID** and **Client Secret**. You can pass `--client-id` and `--client-secret` instead, but prefer the prompt so that the secret stays out of your shell history.
2. The CLI opens your browser at Atlassian's consent screen. Before you authorize, **make sure your browser is signed into the right Atlassian site**. On a headless or SSH machine, use `--no-browser` to print the URL instead.
3. After you click **Authorize**, the browser redirects to a localhost page. That redirect is expected.
4. If your account can access multiple Atlassian sites, the CLI lists them and asks you to pick one. It records the selected site's `cloud_id` and `site_url`.
5. The CLI stores the OAuth token bundle in `bgagent-jira-oauth-<cloudId>` and records the tenant in the workspace registry.

> **If `setup` hangs at "Waiting for browser callback…"**, the consent redirect never reached the CLI's localhost listener. The usual causes are these: the consent tab was completed in a *different* browser or profile than the one that `setup` opened, the tab was closed before **Authorize** was clicked, or something else is bound to port 8080. Press Ctrl-C and re-run `bgagent jira setup`. A re-run is safe and idempotent. It mints the token bundle again and registers the tenant again, and an aborted attempt leaves nothing half-written.

### 3. Configure the Jira webhook

`setup` then prompts for a **webhook signing secret**. Unlike Linear, Atlassian does **not** generate one. The operator chooses it when creating the webhook. In a second terminal, open **Jira → Settings → System → Webhooks → Create a Webhook** and enter:

- **URL.** The `…/jira/webhook` URL that `setup` prints.
- **Events.** *Issue: created*, *Issue: updated*, and *Comment: created*.
- **Secret.** A strong random value, for example the output of `openssl rand -hex 32`.

Paste that same secret value at the `Webhook signing secret:` prompt. ABCA stores it on the per-tenant OAuth bundle and synchronizes the stack-wide verifier. The receiver looks up that value to verify `X-Hub-Signature` on each delivery.

> **One active tenant for Jira admin-console webhooks.** Webhooks created under **Settings → System → Webhooks** do not include `cloudId` in their payload, so the receiver cannot select among multiple tenant secrets. `jira setup` therefore refuses to configure a second active Jira tenant through this flow. For the sole active tenant it always synchronizes the tenant bundle and stack-wide verifier, including on setup reruns.

When you recreate the webhook or rotate its secret later, update the secret in Jira and then run:

```bash
bgagent jira update-webhook-secret <cloud-id>
```

The command prompts for the new value and updates both required Secrets Manager values without repeating OAuth. Keep the Jira webhook disabled until the command succeeds.

The operator role that runs this command needs these permissions:

- `cloudformation:DescribeStacks`
- `dynamodb:GetItem` and `dynamodb:Scan` on `JiraWorkspaceRegistryTable`
- `secretsmanager:GetSecretValue` and `secretsmanager:PutSecretValue` on the tenant's `bgagent-jira-oauth-<cloudId>` secret
- `secretsmanager:PutSecretValue` on the stack-wide ARN from `JiraWebhookSecretArn`

### 4. Install the dedicated outbound app

The repository includes a narrow Forge app under `integrations/jira-forge-app`. Its web trigger accepts only five signed operations: identity probe, create comment, update comment, read transitions, and perform transition. It does not expose a general Jira REST proxy.

Run the login in an interactive terminal. Forge asks for your Atlassian email and the Forge CLI scoped token from the prerequisites. The Jira 3LO access token is not a Forge CLI credential. On the first registration, Forge also asks you to create or select a **Developer Space**.

```bash
cd integrations/jira-forge-app
npm ci
forge login
forge register bgagent --accept-terms
```

`forge register bgagent` replaces the placeholder `app.id` in `manifest.yml` with an app ID that your Atlassian Developer Space owns. That ID is not a secret, but it is operator-specific. Keep it in the deployment checkout for future Forge commands, and do not commit it to the sample repository or to a contribution branch. If you restore the placeholder to keep a worktree clean, record the existing app ID and put it back before a future deploy. Do not register a second app.

Generate a shared secret and store it in the Forge **production** environment:

```bash
BGAGENT_PROXY_SECRET="$(openssl rand -hex 32)"
forge variables set --encrypt BGAGENT_PROXY_SECRET "$BGAGENT_PROXY_SECRET" \
  --environment production
```

The current shell holds the value, and the value is not written to shell history. Keep that terminal open for the final `bgagent` command. Never commit or print the value. Forge variables apply only after a deployment, so set or rotate the variable **before** `forge deploy`.

Deploy and install the same production environment on the Jira site, then create the URL for the allowlisted `bgagent-outbound` trigger:

```bash
forge deploy --environment production
forge install \
  --product Jira \
  --site <your-site>.atlassian.net \
  --environment production \
  --confirm-scopes
forge webtrigger create \
  --functionKey bgagent-outbound \
  --product Jira \
  --site <your-site>.atlassian.net \
  --environment production
```

Forge prints a v2 installation URL of this form:

```text
https://<installation-id>.webtrigger.atlassian.app/public/<trigger-id>
```

The URL is specific to the installation and to the environment. Register the URL and the same shared secret with the intended ABCA stack:

```bash
bgagent jira app-setup <cloud-id> \
  --proxy-url https://<installation-id>.webtrigger.atlassian.app/public/<trigger-id> \
  --region "$REGION" \
  --stack-name "$STACK_NAME"
```

Paste `BGAGENT_PROXY_SECRET` into the hidden prompt. The CLI sends an HMAC-signed identity probe and refuses to save unless Jira reports `accountType=app` and `/rest/api/3/serverInfo` identifies the selected tenant. It stores the proxy URL and secret on `bgagent-jira-oauth-<cloudId>` and non-secret identity metadata in `JiraWorkspaceRegistryTable`. Run `unset BGAGENT_PROXY_SECRET` after setup. The `--shared-secret` option is available for non-interactive automation, but it exposes the value to local process inspection while the command runs.

The Forge app scopes authorize API families, but Jira project permissions still apply. Make sure that the installed app has **Browse Projects**, **Add Comments**, and **Transition Issues** access in each mapped project.

Confirm the installation and ABCA registration before triggering a task:

```bash
forge install list --environment production

JIRA_REGISTRY_TABLE=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`JiraWorkspaceRegistryTableName`].OutputValue' \
  --output text)

aws dynamodb get-item \
  --region "$REGION" \
  --table-name "$JIRA_REGISTRY_TABLE" \
  --key '{"jira_cloud_id":{"S":"<cloud-id>"}}' \
  --projection-expression 'jira_cloud_id,outbound_identity,app_actor_display_name,app_actor_configured_at'
```

The Forge installation should be `Up-to-date`. The registry row should contain `outbound_identity = app` and `app_actor_display_name = bgagent`. Do not print the tenant secret to verify it. `app-setup` has already proved that the URL and the HMAC secret work together.

Run the platform diagnostic after registration:

```bash
bgagent platform doctor \
  --region "$REGION" \
  --stack-name "$STACK_NAME"
```

`Jira outbound app identity` should pass. A warning means that at least one active Jira tenant still writes as the OAuth setup user or has incomplete Forge metadata. Re-run `bgagent jira app-setup` for the listed cloud ID.

### 5. Map a project to a repository

```bash
bgagent jira map <cloud-id> <PROJECT-KEY> \
  --repo owner/repo \
  --region "$REGION" \
  --stack-name "$STACK_NAME"
```

- `<cloud-id>`. The tenant UUID. The final **Next steps** block of `setup` prints this exact `map` command with the cloudId filled in. Paste it and replace the project key and the repo with yours. If that terminal output is gone, recover the cloudId from `https://<your-site>.atlassian.net/_edge/tenant_info`, which returns it as JSON, or from the workspace-registry table. The Jira UI does *not* show it anywhere.
- `<PROJECT-KEY>`. The Jira project key, for example `ENG` (uppercase, starts with a letter).
- `--repo owner/repo`. The GitHub repository that tasks from this project route to.
- `--label <name>`. The trigger label (default `bgagent`).
- `--status-on-start <name>`. The Jira status to move the issue to when a task starts. It overrides the heuristic (see [Board transitions](#board-transitions)).
- `--status-on-pr <name>`. The Jira status to move the issue to when a PR is opened. It overrides the `In Review` default.

The command writes an `active` row keyed `<cloudId>#<projectKey>` into the project-mapping table. It requires admin IAM, because it reads and writes DynamoDB directly.

### 6. Link your Jira identity

Link your Atlassian `accountId` to your ABCA account, so that tasks triggered from Jira are attributed to your platform user (concurrency caps, billing, `bgagent list`). An admin issues a one-time invite code, then the teammate redeems it.

#### Admin: generate the invite

```bash
bgagent jira invite-user <cloud-id> <account-id-or-email> \
  --region "$REGION" \
  --stack-name "$STACK_NAME"
```

The command resolves the Jira user through the tenant OAuth token, writes a `pending#<code>` row with a 24-hour TTL, and prints the `bgagent jira link <code>` command to send to the teammate. It requires admin IAM for the stack tables and secrets, and a logged-in `bgagent` CLI session for the `invited_by_platform_user_id` audit field.

- `<cloud-id>`. The tenant UUID from `setup` or from `https://<your-site>.atlassian.net/_edge/tenant_info`.
- `<account-id-or-email>`. The teammate's Atlassian `accountId` or email address. If email search is hidden or ambiguous, use the `accountId`. Jira profile URLs end in `/people/<accountId>`.

#### Teammate: redeem the invite

```bash
bgagent jira link <code>
```

The CLI shows the Jira identity (name and email) and the tenant, and asks for confirmation **before** it writes the mapping row, so that you catch a mis-issued code before it binds.

The teammate needs their own ABCA account first (a Cognito user and a configured CLI). If they do not have one yet, the admin runs `bgagent admin invite-user teammate@example.com`, then the teammate runs `bgagent configure --from-bundle <bundle>` and `bgagent login --username teammate@example.com` before redeeming the Jira invite.

### 7. Test

Add the trigger label (`bgagent` by default) to a Jira issue in a mapped project. The agent should start within about 30 seconds, comment on the issue as it works, and post a PR link when ready. The issue **summary** plus the **description** (converted from Atlassian Document Format to markdown), the issue's **recent comments**, and any supported **file attachments** become the task context. See [Issue context: attachments and comments](#issue-context-attachments-and-comments).

After the PR exists, add a Jira comment such as `@bgagent update the README too`. ABCA should create one acknowledgement status comment, update it with elapsed time during a long run, update the existing PR, and finally:

1. Replace the progress text with a short `Finished — result posted below` pointer.
2. Add a separate terminal comment containing the outcome, metrics, and a clickable PR link.

When a successful GitHub preview deployment is captured, ABCA also adds **Open screenshot** and **Open live preview** links to the originating Jira issue. Configure the GitHub deployment-status webhook described in the [deploy-preview screenshots guide](DEPLOY_PREVIEW_SCREENSHOTS_GUIDE.md). Jira uses explicit ADF links because these externally hosted screenshots do not have Atlassian media IDs.

For AWS Amplify Hosting, enable PR previews and select **Check runs** on that GitHub webhook. Amplify's successful preview check triggers capture and Jira delivery automatically. A subscription to Deployment statuses alone does not capture Amplify previews. Existing operators can keep their branch-name `SCREENSHOT_TARGET_ENVIRONMENT` setting, because validated PR checks bypass it. After you redeploy ABCA and update the subscription, rebuild a PR preview. The screenshot and Jira task lookup follow the PR validated against the preview URL and head SHA, including when multiple PRs share a commit. Rejected checks log `screenshot.amplify_check_rejected` with a reason in the receiver logs. See the screenshots guide for diagnostics.

For an iteration, the links appear in its existing status comment and survive later heartbeat and terminal edits. A fan-out orchestration's combined preview appears in the parent rollup. Delivery targets the task encoded in the deploy branch and then routes through that task's stored Jira tenant and issue metadata. ABCA never parses the Jira issue from branch or PR text. Cross-repository delivery is rejected, and an iteration must match the deployment SHA. Duplicate deployment events update the existing preview comment or block.

Preview feedback is best effort. Jira authentication, API, or persistence failures are logged as `screenshot.jira_delivery_failed` or `jira.preview.status_failed` and do not fail the deployment or task. A standalone comment creation is claimed before posting. ABCA does not repeat an uncertain or failed POST automatically, so that no duplicate appears if Jira accepted the POST before a network timeout. Check `screenshot.jira_delivery_claimed` when a claim has no saved comment ID. `jira.preview.convergence_failed` means that successful updates reached the repair limit. It does not retry terminal delivery. `jira.preview.task_missing` means the task record no longer exists. `screenshot.jira_missing_registry` identifies missing Jira registry configuration. Delivery stops within the screenshot processor deadline and caps lookup at 10 pages and 25 candidate reads. `screenshot.jira_budget_exhausted` and `screenshot.jira_lookup_limited` identify those limits.

The progress comment author and transition actor should be the `bgagent` app. The task owner shown by `bgagent list`, audit records, concurrency accounting, and cost attribution should remain the linked human who triggered the Jira event.

Comments created before `app-setup` remain attributed to the 3LO setup user. Only new outbound writes use the Forge app. A successful end-to-end test therefore produces a new start or terminal comment whose Jira author is `bgagent` with `accountType=app`.

## Migrating an existing Jira tenant

Existing installs continue to work before Forge is configured, but their outbound comments and transitions still use the 3LO credential and therefore appear as the user who ran `bgagent jira setup`. Complete [Step 4](#4-install-the-dedicated-outbound-app) for each tenant that you migrate.

Re-running `bgagent jira setup` preserves an existing app-actor configuration. Once any app-actor configuration is present, ABCA never silently falls back to the 3LO writer. ABCA logs a malformed secret, a bad signature, a missing app permission, or a proxy or API failure, and skips the advisory Jira write. The underlying coding task continues.

## How webhook signature verification works

Atlassian signs each delivery with HMAC-SHA256 over the **raw request body**, and sends the signature as `X-Hub-Signature: sha256=<hex>`. The receiver does the following:

1. Computes `HMAC-SHA256(rawBody, secret)` and compares it in constant time against the header value. The comparison accepts a pasted value with or without the `sha256=` prefix.
2. Uses the per-tenant signing secret when the payload carries `cloudId`. Admin-console payloads omit it, so they use the synchronized stack-wide `JiraWebhookSecret` and bind to the sole active tenant.
3. Rejects with 401 on mismatch.

The receiver must verify the body as the *raw unparsed bytes*, never as JSON that was parsed and serialized again. A second serialization would change the byte sequence and break the HMAC.

## Label-trigger semantics

- **`jira:issue_created`.** Triggers if the trigger label is already present on the new issue.
- **`jira:issue_updated`.** Triggers only if the label was **newly added** in this update. Jira reports label changes in `changelog.items[]` (`field: "labels"`, with `fromString` and `toString`), *not* by re-sending the full label list. The processor diffs the changelog and does not inspect `issue.fields.labels`, so re-saving an issue that already has the label does not re-trigger.
- **`comment_created`.** Triggers only when the new comment contains a token-bounded `@bgagent` mention and the issue has a prior ABCA pull request.
- All other event types get a silent `200`.
- Issues outside active project mappings are always silent, even if they use the same label. This rule includes explicit `@bgagent` follow-ups after a project mapping is removed. Offboarding ends all ABCA interaction for that project. Site-wide Jira activity must not cause ABCA comments in projects that were never onboarded or are no longer connected.

## Comment-triggered PR iteration

A `comment_created` webhook starts a PR iteration only when the comment contains the token-bounded mention `@bgagent` (case-insensitive). The remaining comment text becomes the `coding/pr-iteration-v1` instruction. A bare `@bgagent` asks the agent to address the latest PR review feedback.

ABCA resolves the Jira tenant and issue key to the newest prior task that opened a PR. Newer attempts without a PR do not hide an older valid PR target. If no ABCA PR exists, ABCA posts a comment that says so and creates no task.

When the comment author has linked their Jira and ABCA accounts, the iteration is attributed to that user. Otherwise, ABCA falls back to the original task owner, so that a useful reviewer request is not dropped. Comments without the mention, app-authored comments, and ABCA's own generated status comments are no-ops.

ABCA posts the acknowledgement immediately after task admission and stores its Jira comment ID on the iteration task. Eligible long-running iterations edit that comment with elapsed time. They do not add heartbeat comments. When the iteration finishes, fan-out owns the terminal edit for a standalone iteration, and the orchestration reconciler owns it for a child iteration so that dependent restacking remains ordered. Both replace the same comment with the outcome, cost, turns, duration, task ID, and PR link when available.

Comment redelivery is idempotent. The webhook receiver deduplicates by Jira comment ID, task creation uses a deterministic idempotency key as a second guard, and terminal writers claim the stored status comment before they edit it. A heartbeat checks the terminal claim immediately before its cosmetic edit, so an overlapping sweep cannot replace a completed outcome with a running message.

## Authored subtask orchestration

When you apply the trigger label to a parent that already has Jira subtasks, ABCA runs those subtasks as one orchestration and does not create a separate coding task for the parent. Each subtask becomes an ordinary ABCA task. Standard Jira `blocks` and `is blocked by` links between those subtasks determine release order. Roots start immediately, and blocked work starts only after all predecessors succeed.

All executable subtasks must belong to active Jira project mappings that resolve to the same repository as the parent. Cross-project subtasks are supported when their mappings name that same repository. ABCA rejects cross-repository graphs, unmapped projects, cycles, and blocker links to issues outside the parent's executable subtask set before it writes any orchestration rows. Jira API or authentication failures are reported on the parent and never silently degrade to a single parent task.

The parent receives orchestration progress and the terminal rollup. Parallel leaves converge through an internal integration task, so that the orchestration produces one combined pull request. That internal task does not address a nonexistent Jira issue. An `@bgagent` comment on a real child updates that child's pull request and restacks dependent pull requests through the shared orchestration reconciler.

To extend an existing orchestration, add Jira subtasks and re-apply the trigger label. ABCA appends only new issue keys, and preserves existing tasks, branches, statuses, and dependencies. A new child starts immediately when all of its declared predecessors have already succeeded. Otherwise it remains blocked for the reconciler. A new child with no explicit blocker stacks on the existing epic tip, not on bare `main`. A subtask that failed or was skipped is not part of that tip, and neither is work that still waits behind it. After a failure, the new child builds on what is left, or starts from the repository's default branch when nothing is left to build on.

Re-applying the label without adding a child starts nothing and changes no status, branch or dependency. It does read again the summary and description of the subtasks that are not running and have not succeeded. So does an `@bgagent retry` comment by a linked user on the parent, which then retries the subtasks that failed or were skipped. A reworded subtask starts with its new text. Changes only to blocker links between existing children are also ignored. Dependency edits do not rewrite work that may already be running or complete. Extending a terminal orchestration reopens the parent progress panel and settles it again when the added work finishes.

## Issue context: attachments and comments

Beyond the summary and description, the processor adds the context that a Jira ticket usually carries: attached files and recent clarifications. With that context, the agent does not have to guess at "see the attached log" or at an acceptance detail in a comment. The processor fetches both **authenticated at task-admission time** with the tenant's existing `read:jira-work` scope (**no new OAuth scopes, no re-authorization**), because a headless agent can't fetch them itself.

### File attachments

ABCA downloads Jira-hosted `media` attachments through the Jira REST API, screens them with the **same Bedrock Guardrail content screening** as every other ABCA attachment, and stores them for the agent only after they pass.

- **Supported types.** Images `image/png`, `image/jpeg`. Files `text/plain`, `text/csv`, `text/markdown`, `application/json`, `application/pdf`, `text/x-log`.
- **Limits.** At most **10 attachments per task** (shared with any images embedded in the description), **10 MB per file**, **50 MB total**.
- **Unsupported or oversized attachments are skipped silently.** They don't reach the agent. The task still runs with the rest of the context.
- **Fail-closed on unsafe content.** If a *selected* attachment can't be safely downloaded or screened (blocked by the guardrail, a content/type mismatch, a download or auth failure, or missing screening configuration), the task is **rejected** with a ❌ comment on the issue and does not run with missing context. Fix or remove the attachment and re-apply the trigger label.
- Embedded HTTPS image URLs in the description continue to work as before.

### Recent comments

The processor adds the most recent **human** comments (up to 10, oldest first) to the task description under a **Recent comments** heading, each attributed to its author. It excludes ABCA's own progress and final-status comments and other app or bot comments. The filter uses the Atlassian `accountType` and the marker that ABCA's own comments start with, so a human comment that starts with one of those emoji is left out as well. Comment enrichment is **best-effort and fail-open**. If the fetch fails, the task proceeds without comments and a warning is logged. Comments are advisory context, never a gate. Long comment histories are not fetched in full. Only the 100 newest comments are read.

## Board transitions

As a Jira-triggered task progresses, the agent moves the originating issue through its workflow, so that the board shows the real state of the task. Linear-origin tasks already give the same signal. The agent moves the issue as follows:

- **Task start.** The issue moves to an **In Progress** status.
- **PR opened.** The issue moves to a **review** status. The default is **In Review**, with a fallback to In Progress so that a stock board isn't skipped.
- **Task failed or no PR opened.** The status is **left unchanged**. The ❌ final-status comment is the signal, and moving a card back and forth is noisier than leaving it where a human sees the failure.
- **Already at or past the target.** The transition is **skipped**, so a re-triggered task does not move a card backward (for example, from In Review back to In Progress). The Linear integration behaves the same way. A per-project override changes this behavior (see step 1 below).
- **Already on one of the names of step 2 below.** The issue moves only to a name listed before it, and the category fallback (step 3) is not used for it. A card that is In Progress on a board that has none of the review names of step 2 therefore stays In Progress when the PR opens. If the board calls its review status something else, set `--status-on-pr`.

Humans still move the card to **Done** after they merge the PR. ABCA never closes issues.

**How a target status is resolved.** ABCA evaluates these steps at each lifecycle point, and the first match wins. The resolution is modeled on the Linear integration:

1. **Per-project override.** The `--status-on-start` and `--status-on-pr` names configured on the project mapping. ABCA matches them case-insensitively against the destination status name. An override is a deliberate instruction. ABCA honors it regardless of the current status, and if it isn't reachable, ABCA skips the transition with no heuristic fallback. There is one exception. When an `@bgagent` iteration starts, an issue that is already In Progress or later stays where it is, so that a comment does not pull a card that the earlier task left In Review back to the `--status-on-start` status.
2. **Name match** (no config needed for standard workflows):
   - On start, a transition whose destination is named **In Progress**.
   - On PR opened, a transition named **In Review**, then common synonyms (`Code Review`, `Review`, `Peer Review`, `Reviewing`), then **In Progress** as a last resort.
3. **Category fallback.** Any transition whose destination `statusCategory` is *In Progress* (`indeterminate`), **excluding `Blocked`**. `Blocked` shares that category but is never what "move to In Progress" means. The name match in step 2 keeps the heuristic from choosing `Blocked` when both are available.
4. **Skip with a warning.** Nothing matches, the transition requires a screen with required fields, or the selected outbound identity lacks permission. The task is never affected.

Transitions are **best-effort**, like comments. They have a short timeout, their errors are logged and swallowed, and they share the same auth circuit breaker for `401` and `403`. A transition failure never fails, blocks, or retries the task. Transition IDs are specific to the workflow and to the current status, so ABCA resolves them per issue at call time, by matching the destination name or category. They are never configured or hard-coded.

> **Permission prerequisite.** The Forge manifest declares `read:jira-work` and `write:jira-work`, but scopes do not override Jira **project permissions**. The installed `bgagent` app needs **Transition Issues** in each mapped project. Jira returns an empty transition list when the app lacks that permission, so ABCA skips with a warning and the task continues. An unmigrated tenant using the OAuth fallback instead depends on the 3LO authorizing user's project permissions.

The feature targets Jira **statuses**, not board columns. Because moving a card between columns *is* a status transition, no board-configuration API is involved. Multi-hop pathfinding is out of scope. If no single transition reaches the target from the current status, ABCA skips the transition.

## Webhook dedup

The receiver dedupes issue events on `{issueKey}#{webhookEvent}#{timestamp}` and comment-created events on `{issueKey}#comment_created#{commentId}`, with an 8-hour TTL. The timestamp keeps distinct label additions separate. The stable comment ID collapses redelivery without merging separate comments. Jira retries far less aggressively than Linear, so 8 hours is safe parity.

## Usage

- **Trigger a task.** Add the trigger label to an issue in a mapped Jira project.
- **Iterate on its PR.** Comment `@bgagent <change>` on the Jira issue after ABCA has opened a PR.
- **Check status.** Read the progress comments on the Jira issue, or run `bgagent list` or `bgagent status <task-id>`.
- **Cancel.** Run `bgagent cancel <task-id>`. Removing the Jira label does not cancel a running task.

## Troubleshooting

### Webhook doesn't trigger a task

- Is the project mapped? Scan `JiraProjectMappingTable` for `<cloudId>#<projectKey>` with `status = 'active'`.
- Is the tenant registered? Scan `JiraWorkspaceRegistryTable` for the `cloudId` from the webhook payload.
- Is the label spelled exactly as configured? The match is case-insensitive, but the word must be the same.
- For an `issue_updated` event, confirm that the label was *added in this update*. By design, re-saving an issue that already carries the label won't re-trigger.
- Check CloudWatch logs for `JiraWebhookFn` and `JiraWebhookProcessorFn`.
- In the `JiraWebhookProcessorFn` log, `Jira tenant not onboarded: no usable workspace registry row` means the registry was read and holds no usable row for the `cloudId`. Run `bgagent jira setup`. `Jira workspace registry unreadable` means the read of `JiraWorkspaceRegistryTable` itself failed (throttling, or a missing IAM permission on the processor's role). That read failure fails the invocation on purpose, and Lambda retries the invocation twice, about one and three minutes after the first attempt. If the retries fail as well, the event is discarded. Fix the cause, then remove and re-add the trigger label, or post the `@bgagent` comment again.

### Webhook signature verification fails repeatedly (401)

The signing secret stored for this tenant doesn't match what Jira is sending. Most often the value entered in Jira differs from ABCA's copy, or the webhook was recreated with a new secret. Run `bgagent jira update-webhook-secret <cloud-id>` and enter the exact value configured in Jira. The command synchronizes both locations that admin-console webhooks require. To inspect what's stored:

```bash
aws secretsmanager get-secret-value \
  --secret-id bgagent-jira-oauth-<cloudId> \
  --query SecretString --output text | jq .webhook_signing_secret
```

### Linking succeeds but a trigger says the Jira user is unlinked

Jira attributes a trigger to the account in the webhook's `user.accountId`. That may differ from the issue reporter, creator, or the OAuth account ABCA uses to post comments. The name shown above an ABCA comment is therefore not proof that the same account triggered the event.

Check the webhook-processor warning for `jira_account_id`, `jira_account_source`, and `jira_identity_lookup_key`. The failure comment on an onboarded, explicitly triggered issue also prints the selected account ID. Invite and link that exact account:

```bash
bgagent jira invite-user <cloud-id> <jira-account-id-from-the-log>
bgagent jira link <generated-code>
```

### `setup` hangs at "Waiting for browser callback…"

The consent redirect never reached the CLI's localhost listener. See the note under [Step 2](#2-authorize-the-app-on-the-tenant). Press Ctrl-C and re-run `bgagent jira setup`. A re-run is safe.

### 401 when calling the Jira API directly after setup

This 401 is expected and does not mean a broken install. The stored access token lasts about 1 hour. Only the **trusted Lambda paths** refresh it, when they next run, that is, on the next webhook delivery (see [Limits and quotas](#limits-and-quotas)). If you fetch the token from Secrets Manager right after `setup` to verify it and get a 401, the integration still works. Add the trigger label to an issue, and the processor refreshes the bundle before it uses the token.

**Do not refresh the token manually.** Atlassian rotates the `refresh_token` on every use, and the rotated bundle must be written back to Secrets Manager *preserving every other field*, in particular `webhook_signing_secret`. A manual refresh that drops a field or loses the rotated refresh token breaks the tenant install. The only recovery is to re-run `bgagent jira setup`. If you need a live token for debugging, trigger a label event and read the bundle that the Lambda just wrote.

### Agent doesn't comment back on Jira

- Verify the per-tenant OAuth secret exists: `aws secretsmanager describe-secret --secret-id bgagent-jira-oauth-<cloudId>`.
- Verify the registry row's `oauth_secret_arn` matches and `status = 'active'`.
- Confirm `outbound_identity = app` and `app_actor_display_name = bgagent` on the registry row.
- Check the tenant secret for `app_actor_proxy_url`, `app_actor_shared_secret`, and `app_actor_configured_at` without printing the secret value.
- Check the agent logs for `jira_reactions: comment_task_started`. `proxy_error=invalid_signature` means Forge and ABCA have different `BGAGENT_PROXY_SECRET` values or the signed request is stale. `proxy_error=proxy_not_configured` means that the production Forge variable is missing or too short, or was set after the last deploy. A Jira `403` without a proxy error code means the app lacks a required scope or project permission.
- Re-run `bgagent jira app-setup <cloud-id> --proxy-url <url> --region "$REGION" --stack-name "$STACK_NAME"` after rotating the Forge secret or recreating the web-trigger URL. The identity probe catches a wrong secret, dead URL, wrong actor type, wrong Jira tenant, and missing app access before saving.
- If no app-actor fields exist, ABCA logs that it is using the OAuth migration fallback. A fallback `401` or `403` usually means that the 3LO token was revoked. Re-run `bgagent jira setup`.

### Forge login or registration fails

- **`Prompts can not be meaningfully rendered in non-TTY environments`.** Run `forge login` in an interactive terminal, not in a non-interactive CI or shell-command runner.
- **Token rejected.** Create a Forge CLI scoped token at <https://go.atlassian.com/forge-cli-api-token>. Do not use the Jira OAuth access token, OAuth client secret, or account password.
- **Not a member of a Developer Space.** Let the first `forge register` prompt create one, or ask an existing Developer Space admin to add your Atlassian account.
- **Wrong app or a second app was registered.** Restore the original operator-owned `app.id` in `manifest.yml` and redeploy. Do not run `forge register` again for routine deployments.

### Rotate the Forge proxy secret

Keep Forge and ABCA on the same value:

```bash
BGAGENT_PROXY_SECRET="$(openssl rand -hex 32)"
forge variables set --encrypt BGAGENT_PROXY_SECRET "$BGAGENT_PROXY_SECRET" \
  --environment production
forge deploy --environment production

bgagent jira app-setup <cloud-id> \
  --proxy-url <existing-forge-v2-url> \
  --region "$REGION" \
  --stack-name "$STACK_NAME"

unset BGAGENT_PROXY_SECRET
```

Paste the new value at the hidden prompt. Until both sides are updated, signed writes fail closed and do not fall back to the human 3LO identity.

### Jira card doesn't move across the board

Board transitions are best-effort and never block the task, so a card can stay where it is while comments still post. Common causes:

- **The selected writer lacks *Transition Issues*.** For migrated tenants, grant the installed `bgagent` Forge app access to transition issues in the project. For OAuth-fallback tenants, grant it to the user who ran `bgagent jira setup`.
- **No matching destination.** The standard heuristics look for an *In Progress*-category status on start and an `In Review`-named status on PR. Custom workflows may name these statuses differently. In that case, configure `bgagent jira map ... --status-on-start "<name>" --status-on-pr "<name>"`.
- **The transition requires a screen** with required fields. ABCA skips these transitions by design, because it can't fill required fields. Pick a transition without a screen, or remove the required fields from the workflow.
- **No single-hop transition reaches the target** from the issue's current status. ABCA does not chain transitions.
- Check the agent container logs for `jira_reactions: transition …` lines. They name the chosen destination or the skip reason.

## Limits and quotas

Atlassian 3LO access tokens are short-lived. The **trusted Lambda paths** auto-refresh them for inbound reads and write the rotated bundle back to Secrets Manager. The **agent never refreshes** because Atlassian rotates refresh tokens and the agent has read-only secret access. Forge app-actor writes do not depend on the 3LO token lifetime. The agent can still post through the signed proxy when the stored OAuth access token is expiring. Forge invocation limits and Jira REST rate limits apply, but each task makes only a few outbound calls.

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

Also uninstall the Forge production app, then remove or revoke it in the Atlassian developer console:

```bash
forge uninstall \
  --product Jira \
  --site <your-site>.atlassian.net \
  --environment production
```

The local manifest must contain the registered app ID when you run Forge lifecycle commands. Deleting the tenant secret removes both OAuth and app-actor proxy configuration.
