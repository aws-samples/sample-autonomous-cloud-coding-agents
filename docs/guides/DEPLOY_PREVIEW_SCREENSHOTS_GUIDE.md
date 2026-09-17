# Deploy preview screenshots setup guide

Wire your repo into ABCA so that every preview deploy gets screenshotted and posted as a comment on the open GitHub PR. For Jira-origin tasks, the originating issue receives screenshot and live-preview links. Linked Linear issues also receive preview feedback when configured.

> The pipeline only needs GitHub. Linear posting is opt-in: present iff `LinearWorkspaceRegistryTable` has at least one active row (configured via [Linear setup guide](./LINEAR_SETUP_GUIDE.md)). Without Linear, the GitHub-side screenshot still works; the Linear-side just no-ops silently.

## Supported preview events

The pipeline accepts GitHub `deployment_status` events and successful AWS Amplify PR preview `check_run` events. Providers that call the [GitHub Deployments API](https://docs.github.com/en/rest/deployments/deployments) work through the deployment-status path:

| Provider | Out of the box? | Notes |
|---|---|---|
| **Vercel** (managed hosting + GitHub app) | ✅ | The worked example below uses this. Default `environment` is `Preview`. |
| **AWS Amplify Hosting** (Connected to GitHub) | ✅ | Enable PR previews and subscribe the ABCA webhook to **Check runs**. Successful `AWS Amplify Console Web Preview` checks bypass the deployment environment filter. |
| **Netlify** (managed hosting + GitHub app) | ⚠ | `environment` is `Deploy Preview <PR#>`, which the current single-string `SCREENSHOT_TARGET_ENVIRONMENT` filter doesn't match across all PRs. Workable today only by picking one specific PR's environment string; broader pattern matching isn't shipped. |
| **GitHub Actions** that calls `POST /repos/.../deployments` (typical for ECS/Fargate, Cloud Run, Fly.io, Railway, Cloudflare Pages, etc.) | ✅ | Your workflow controls the `environment` field; pass whatever you want and set `SCREENSHOT_TARGET_ENVIRONMENT` to match. |
| **External CI** (CircleCI, GitLab, ArgoCD) that doesn't touch GitHub Deployments | ❌ | Add a final job that calls the GitHub Deployments API after the deploy succeeds — see [GitHub's example](https://docs.github.com/en/rest/deployments/deployments#create-a-deployment). |

For a deployment-status event, ABCA needs:

1. The `deployment_status` event has reached `state: success`.
2. `deployment_status.environment_url` is populated with the live preview URL.

If your provider gives you that, you're done. The example below is Vercel because that's what we smoke-tested on; the pipeline doesn't otherwise prefer one provider over another.

For Amplify, enable **Hosting → Previews** on the PR's target branch and add **Check runs** to the repository's ABCA webhook events. Amplify publishes the URL in the completed check's `details_url`; a green GitHub check alone will not trigger capture if the webhook only subscribes to Deployment statuses. ABCA accepts successful preview checks from the `aws-amplify-console` app owner with a matching PR number, head SHA, and HTTPS `pr-<number>.<app-id>.amplifyapp.com` URL. No manual deployment event or extra GitHub Actions workflow is needed. The processor fetches that exact PR and confirms it is still open with the same head SHA before capture, so two PRs sharing a commit cannot redirect the screenshot or Jira/Linear feedback.

**Existing Amplify operators:** redeploy ABCA to pick up this receiver and processor, then add **Check runs** to your existing webhook while keeping **Deployment statuses** selected. Keep any branch-name `SCREENSHOT_TARGET_ENVIRONMENT` value (for example, `main`): deployment statuses still use it, while validated Amplify PR checks bypass it. You do not need to change it to `Preview`. Subscriptions affect future events only; rebuild an existing PR preview to verify the change. If an earlier receiver already accepted and deduplicated a completion, replaying that same check within the one-hour dedup window will not capture again.

## What you get

When you (or the agent) push to a branch that triggers a preview deploy, your provider deploys the preview, posts a deployment status or Amplify preview check back to GitHub, and ABCA's webhook receiver:

1. Captures a full-page screenshot of the preview URL via AgentCore Browser
2. Uploads the PNG to a private S3 bucket served via CloudFront
3. Posts a markdown image comment on the open GitHub PR
4. Posts explicit screenshot/live-preview links to the originating Jira issue, or delivers the preview to Linear when configured. Iterations preserve the preview in their existing status comment.

End-to-end latency: typically 10–15 seconds after your provider reports the deploy.

## How it works

```
agent push → provider preview build → deployment_status / Amplify check_run
                                              ↓
                                    POST /v1/github/webhook
                                              ↓
                                  receiver Lambda (HMAC verify, dedup,
                                                  successful deploy/check +
                                                  provider validation)
                                              ↓
                                    processor Lambda
                                              ↓
                                    AgentCore Browser session
                                              ↓
                                  PNG → private S3 (30-day TTL)
                                              ↓
                              CloudFront-served public URL
                                              ↓
                          GitHub PR comment (+ Jira/Linear feedback if linked)
```

Architecture notes:

- **Lambda-only.** No agent runtime is involved post-PR — the screenshot job is deterministic; an LLM would only add cost without changing behavior.
- **AWS-managed default browser.** AgentCore Browser ships an `aws.browser.v1` session you can attach to without provisioning your own browser resource.
- **Private S3 + CloudFront with OAC.** Screenshot bucket is fully private; CloudFront serves images anonymously over HTTPS so GitHub markdown image embeds (and Linear's, when configured) can render them without auth.
- **WAF exemption.** The `/v1/github/webhook` path is exempted from the `SizeRestrictions_BODY` rule in `AWSManagedRulesCommonRuleSet` because the full `deployment_status` payload (workflow run history + deploy URLs + deployment metadata) exceeds the 8 KB body-size limit. All other CRS rules (LFI, RFI, XSS, SQLi, …) still evaluate against the path; HMAC verification in Lambda authenticates the body.
- **Skips non-2xx pages.** The processor enables CDP's `Network` domain and captures the main-document HTTP status. If the preview URL returns 4xx/5xx (404 / 503 / a 3xx that doesn't redirect cleanly), the processor logs `Preview URL returned HTTP <status>; skipping screenshot` and posts no PR/Linear comment. This avoids posting a confidently-wrong screenshot of a 404 page as if it were the deploy. Auth walls that return HTTP 200 (e.g. Vercel deployment protection) are out of scope — disable deployment protection or use a public preview, see the Vercel setup section below.

## Prerequisites

- ABCA stack deployed (`mise //cdk:deploy`) — confirm `GitHubWebhookUrl` + `GitHubWebhookSecretArn` + `ScreenshotCloudFrontDomain` are listed in the stack outputs
- (Optional) Linear OAuth installed for at least one workspace (`bgagent linear setup <slug>`) — only required if you want screenshots posted to Linear issues in addition to the GitHub PR
- A GitHub repo you own
- Your deploy provider connected to that repo (the example uses Vercel)
- AWS CLI logged in to the same account as the ABCA stack
- The `bgagent` CLI installed (`bgagent configure`, `bgagent login`)

## Step-by-step setup (Vercel example)

### Step 1 — Connect Vercel to your GitHub repo

1. Open https://vercel.com/dashboard.
2. **Add New** → **Project**.
3. Find your repo in the list. If it's not visible, click "Adjust GitHub App Permissions" and grant access.
4. Click **Import**.
5. Accept the framework defaults — Vercel auto-detects most stacks.
6. Click **Deploy**. Wait for the first deploy to finish.

### Step 2 — Vercel project settings

Go to **your-project → Settings** in the Vercel dashboard.

#### Settings → Git
- **Connected Git Repository**: confirm the repo is listed.
- **`deployment_status` Events**: toggle **Enabled** (this is what tells Vercel to post the webhook to GitHub when each deploy finishes).
- **Pull Request Comments**: optional — Vercel's own comment with the preview URL. Doesn't affect ABCA either way.

#### Settings → Deployment Protection
- **Vercel Authentication**: set to **Disabled** (or "Only Production Deployments") for the demo. Otherwise AgentCore Browser will hit a Vercel auth wall and screenshot the login page instead of your app.

> **Production hardening.** Real deployments should keep Vercel Authentication on **Standard Protection** and use a [signed bypass token](https://vercel.com/docs/security/deployment-protection/methods-to-bypass-deployment-protection#protection-bypass-for-automation). The screenshot processor would need to inject the bypass token as a query parameter on the preview URL it navigates to — currently not implemented.

> **Using Amplify?** Enable PR previews under **Hosting → Previews**, then follow Step 3 and include **Check runs** in the webhook events. For other providers, publish successful `deployment_status` events to GitHub. For self-hosted CI, add a GitHub Deployments API call at the end of your deploy job.

### Step 3 — Configure the GitHub webhook

This wires deploys back to ABCA's screenshot pipeline.

#### 3a. Get the webhook config

```bash
bgagent github webhook-info
```

The CLI prints the webhook URL and the values to paste into GitHub.

#### 3b. Add the webhook on the GitHub repo

1. Open `https://github.com/<your-org>/<your-repo>/settings/hooks`.
2. Click **Add webhook**.
3. Fill in the values printed by `webhook-info`:
   - **Payload URL**: the URL it printed
   - **Content type**: `application/json`
   - **Secret**: generate any random string — paste it both here AND into the next step
   - **SSL verification**: leave enabled
   - **Which events?**: choose "Let me select individual events", uncheck Pushes, check **Deployment statuses**, and also check **Check runs** for AWS Amplify PR previews
   - **Active**: ✓
4. **Add webhook**. GitHub fires a `ping` event right away — under "Recent Deliveries" you should see ✅ within seconds.

#### 3c. Mirror the signing secret into AWS

```bash
bgagent github set-webhook-secret
```

Paste the same secret you generated in 3b. The CLI writes it to the stack's `GitHubWebhookSecret` Secrets Manager entry, where the receiver Lambda reads it for HMAC verification.

### Step 4 — Smoke test

Open any PR on the configured repo (push a commit, open a PR however you normally do — GitHub UI, `gh pr create`, GitHub Actions, agent, etc.) Wait 2–5 minutes for your provider to build the preview. The screenshot should land on the PR as a markdown image comment.

**If you also have Linear configured:** create a Linear issue in a mapped project (e.g. "Update homepage heading"), apply the trigger label, and watch the agent open a PR. The same screenshot lands on both the GitHub PR and the Linear issue. If the GitHub comment shows but Linear doesn't, see Troubleshooting.

## Configuring for non-Vercel providers

The pipeline filters `deployment_status` webhooks against `SCREENSHOT_TARGET_ENVIRONMENT` (default `Preview`, matches Vercel's per-PR environment label). To use a different value, pass `screenshotTargetEnvironment` to the `GitHubScreenshotIntegration` construct in your CDK app and redeploy.

| Provider | Typical `environment` value | What to set |
|---|---|---|
| Vercel | `Preview` | leave default |
| Amplify Hosting PR check | not used for filtering | keep existing value; subscribe to Check runs |
| Amplify branch deployment status | branch name | match the branch name exactly |
| Netlify | `Deploy Preview <PR#>` | currently not directly matchable across all PRs (single fixed-string filter only) |
| GitHub Actions custom | whatever your workflow passes | match it exactly |

## Troubleshooting

### GitHub webhook deliveries return 401 / 403

- **401 "Missing signature"**: the request didn't reach our Lambda — check that you saved the webhook with the right signing secret.
- **401 "Invalid signature"**: the secret you pasted into GitHub doesn't match what's stored in AWS. Re-run `bgagent github set-webhook-secret` with the value from the GitHub webhook page.
- **403 "Forbidden" with `X-Amzn-Errortype: ForbiddenException`**: WAF rejected the body. Should not happen on the `/v1/github/webhook` path because that path is exempted from the CommonRuleSet, but if you see it, check the `BlockedRequests` metric on the `TaskApiWebAcl` regional WebACL in CloudWatch.

### Webhook delivers 200 but no screenshot lands

For Amplify, confirm **Check runs** is selected on the ABCA webhook, the `AWS Amplify Console Web Preview` check completed successfully, and its details link opens the PR preview. `skipped_check` means the event was not an eligible successful Amplify PR preview. Its `reason` is also logged by the receiver as `screenshot.amplify_check_rejected`, without the raw payload or URL. Adding the subscription only affects future events; rebuild an existing preview to exercise the automatic path.

Inspect the receiver logs for rejected checks:

| Reason | What to check |
|---|---|
| `action_not_completed`, `check_not_completed`, `check_not_successful` | Wait for a successful completed check. |
| `unexpected_check_name`, `unexpected_app_owner`, `unexpected_app_slug` | The check must be `AWS Amplify Console Web Preview`, owned by `aws-amplify-console`, with an `aws-amplify-*` app slug. Other CI checks are ignored. |
| `invalid_details_url`, `untrusted_preview_url`, `invalid_preview_pr_number` | The details link must be a trusted HTTPS `pr-N.<app-id>.amplifyapp.com` preview URL with a positive PR number, no credentials, and no non-default port. |
| `invalid_pull_requests`, `preview_pr_not_found`, `head_sha_mismatch` | The check must list the preview PR with the same head SHA as the check. |
| `invalid_payload`, `invalid_check_id`, `invalid_head_sha`, `invalid_repository` | The webhook payload is malformed; inspect the delivery in GitHub. |

Malformed JSON returns 400 and logs `screenshot.webhook_rejected` with `reason: invalid_json`. Invalid signatures return 401 before normalization. Valid checks use a separate `amplify#` dedup namespace, so a deployment-status event with identical IDs does not suppress the check. Duplicate checks return `deduped` without dispatching another capture.

Check the screenshot processor logs:

```bash
aws lambda list-functions --region us-east-1 \
  --query "Functions[?contains(FunctionName, 'GitHubScreenshot') && contains(FunctionName, 'Processor')].FunctionName" \
  --output text
```

Then tail the function's CloudWatch log group. Common silent skips:

- `skipped_state` — the delivery was for a non-`success` status (e.g. `pending`, `in_progress`); ignore.
- `skipped_environment` (deployment statuses only) — the deploy's `environment` field doesn't match `SCREENSHOT_TARGET_ENVIRONMENT`. Common cause for non-Vercel providers; see "Configuring for non-Vercel providers" above.
- `skipped_no_url` — the `success` status didn't include `environment_url`. Some providers post URL-less success events; the next push usually carries the URL.
- `screenshot.amplify_pr_rejected` — the validated PR is closed, its head SHA changed, or GitHub returned mismatched/malformed PR data. Capture stops without falling back to another PR. Rebuild the current PR preview after a new push.
- `No open PR found for SHA after retries` — the deploy provider built and reported faster than the agent could `gh pr create` (race window > 35s). Rare; redeliver the webhook from GitHub's UI to retry.

### No screenshots at all: check the processor alarms and DLQ

The receiver Lambda async-invokes the processor (`InvocationType: Event`) and returns `200` to GitHub as soon as that invoke is accepted, so a *processor*-side fault never propagates back — GitHub sees success and never redelivers. (Only a failure to even enqueue the invoke returns `500`.) Two operator-visible signals catch a hard processor fault that would otherwise stop screenshots silently.

**Important:** the processor handler is best-effort by design — it catches its own per-step operational failures (bad token, AgentCore/S3/comment-post errors) and returns success, so those show up as tagged log events (see the section above), **not** as Lambda `Errors`. Both alarms below fire only on faults that *escape* the handler: an init-time crash (missing env at cold start, bundling defect), an unhandled throw in an unguarded path, or the 120s hard timeout. For a swallowed operational failure (e.g. a revoked S3/AgentCore permission), watch the processor **logs**, not these alarms.

- **`WebhookProcessorErrorAlarm`** — fires on the processor's Lambda `Errors` metric: **any** 5-minute period with `>= 1` error alarms (evaluation range 2 periods, 1 datapoint to alarm). Early signal: an invocation is faulting *now*.
- **`WebhookProcessorDlqDepthAlarm`** — fires when such a failed invocation has survived Lambda's built-in async retries and landed on the DLQ (construct id `WebhookProcessorDlq`; 14-day retention, SSL-enforced). Backstop: a payload is now parked undelivered. (The queue also gets SSE via SQS's service-side default; the construct doesn't set an explicit `encryption`.)

The two catch the same failure class, but the `Errors` alarm fires no later than — and, when the retry ladder straddles a period boundary, one window before — the DLQ-depth alarm (the `Errors` metric is stamped at invocation time, before retries exhaust onto the DLQ). Find and inspect the DLQ — the construct sets no explicit queue name, so its physical name is CloudFormation-generated and *contains* the `WebhookProcessorDlq` construct id:

```bash
# Find the DLQ URL (physical name contains the construct id)
aws sqs list-queues --region us-east-1 \
  --query "QueueUrls[?contains(@, 'WebhookProcessorDlq')]" --output text

# How many failed invocations are parked?
aws sqs get-queue-attributes --region us-east-1 \
  --queue-url <DLQ_URL> \
  --attribute-names ApproximateNumberOfMessages

# Peek at a parked event (the original async-invoke payload + Lambda error context)
aws sqs receive-message --region us-east-1 \
  --queue-url <DLQ_URL> --max-number-of-messages 1 \
  --visibility-timeout 0
```

The message body is the original async-invoke event; the `RequestContext`/error attributes show why Lambda gave up. Fix the root cause (re-check the processor's IAM grants, AgentCore Browser quota, and the GitHub/Linear token secrets). The event source is GitHub, not the DLQ, so recovery is to **redeliver the webhook from GitHub's UI** (a Lambda async-invoke DLQ has no automatic re-invoke path — the parked messages are event copies for diagnosis). Purge the queue (`aws sqs purge-queue`) once the alarm has cleared and you no longer need the payloads.

### Screenshot lands on GitHub PR but not on Linear

The GitHub-side post is the primary path; Linear is opt-in and best-effort. Skipping the Linear post is normal if you don't have Linear configured. If you do, look for the processor log line `Linear identifier did not resolve to an issue` — usually means:

- The PR title and body don't contain a Linear-style identifier (e.g. `ABCA-42`). The agent's task description includes the identifier by default; if you opened the PR manually it might not.
- The identifier's workspace isn't OAuth-installed. Run `bgagent linear list-projects` to confirm the issue's project is in the registry.

### CloudFront serves a 403

Visit the public URL directly:

```
https://<ScreenshotCloudFrontDomain>/screenshots/<owner>_<repo>/<sha>-<deploymentId>-<16hex>.png
```

(Copy the exact URL from the PR comment — the `<16hex>` suffix is random per capture, so you can't hand-construct it.)

If it 403s, check that the bucket policy includes the OAC service principal (CDK should generate this automatically — re-deploy if it doesn't).

### Screenshot shows a login page (Vercel only)

You forgot Step 2's "Vercel Authentication: Disabled" toggle. Toggle it off, push another commit, and confirm the next screenshot renders the actual app.

## Production hardening considerations

Things to think about before using this on a real product:

- **Deploy protection.** This guide turns Vercel Authentication off so the headless browser can render the preview. For real use, you'll want it back on with a signed bypass token (or your provider's equivalent) and the bypass injected onto the preview URL the screenshot processor navigates to.
- **IAM scope.** The screenshot processor's IAM is scoped to the three AgentCore Browser actions the handler calls — `StartBrowserSession`, `StopBrowserSession`, `ConnectBrowserAutomationStream` — plus standard Lambda + S3 + Secrets Manager grants. The first two are control-plane writes; the third is the data-plane SigV4-presigned WSS handshake (it's published in the [AWS Service Authorization Reference for `bedrock-agentcore`](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrockagentcore.html), which also notes it takes no resource types or condition keys). Resource is `*` because Browser sessions are ephemeral and the data-plane stream actions don't support resource-level scoping. A cdk-nag IAM5 suppression annotates the resource wildcard.
- **SSRF surface.** The processor navigates AgentCore Browser to `deployment_status.environment_url` from the verified webhook payload. The handler validates the URL up front (https only, no literal-IP, no localhost / link-local / loopback) so a forged payload can't pivot the browser at private hosts. AgentCore Browser also runs outside the customer VPC, so IMDS and private-subnet pivots are neutralized regardless. Stricter operators can add an explicit hostname allowlist by editing `isAllowedScreenshotUrl` in `cdk/src/handlers/shared/screenshot-url.ts`.
- **Screenshot URL enumerability.** The bucket is private, but CloudFront serves anonymously and the path follows `screenshots/<owner>_<repo>/<sha>-<8-byte-random>.png`. The 64-bit random suffix makes URLs unguessable for an outside reader (the prefix is enumerable from the public PR; the suffix is not). If your previews regularly render PII or other regulated content, consider also enabling CloudFront access logs + a WAF in front of the CDN and shortening screenshot retention below the 30-day default (constant in `cdk/src/constructs/screenshot-bucket.ts`).
