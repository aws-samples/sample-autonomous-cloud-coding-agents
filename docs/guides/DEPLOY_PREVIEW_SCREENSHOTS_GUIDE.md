# Deploy preview screenshots setup guide

Connect your repo to ABCA so that ABCA takes a screenshot of every preview deploy and posts it as a comment on the open GitHub PR. For Jira-origin tasks, the originating issue receives screenshot and live-preview links. Linked Linear issues also receive preview feedback when configured.

> The pipeline needs only GitHub. Linear posting is opt-in. It is present if and only if `LinearWorkspaceRegistryTable` has at least one active row (configured with the [Linear setup guide](./LINEAR_SETUP_GUIDE.md)). Without Linear, the GitHub-side screenshot still works, and the Linear side does nothing, silently.

## Supported preview events

The pipeline accepts GitHub `deployment_status` events and successful AWS Amplify PR preview `check_run` events. Providers that call the [GitHub Deployments API](https://docs.github.com/en/rest/deployments/deployments) work through the deployment-status path:

| Provider | Out of the box? | Notes |
|---|---|---|
| **Vercel** (managed hosting and GitHub app) | ✅ | The worked example below uses Vercel. Default `environment` is `Preview`. |
| **AWS Amplify Hosting** (Connected to GitHub) | ✅ | Enable PR previews and subscribe the ABCA webhook to **Check runs**. Successful `AWS Amplify Console Web Preview` checks bypass the deployment environment filter. |
| **Netlify** (managed hosting and GitHub app) | ⚠ | `environment` is `Deploy Preview <PR#>`, which the current single-string `SCREENSHOT_TARGET_ENVIRONMENT` filter does not match across all PRs. It works today only if you pick one specific PR's environment string. Broader pattern matching is not shipped. |
| **GitHub Actions** that calls `POST /repos/.../deployments` (typical for hosts such as ECS/Fargate, Cloud Run, Fly.io, Railway, and Cloudflare Pages) | ✅ | Your workflow controls the `environment` field. Pass any value and set `SCREENSHOT_TARGET_ENVIRONMENT` to match. |
| **External CI** (CircleCI, GitLab, ArgoCD) that does not call GitHub Deployments | ❌ | Add a final job that calls the GitHub Deployments API after the deploy succeeds. See [GitHub's example](https://docs.github.com/en/rest/deployments/deployments#create-a-deployment). |

For a deployment-status event, ABCA needs two conditions:

1. The `deployment_status` event has reached `state: success`.
2. `deployment_status.environment_url` is populated with the live preview URL.

If your provider meets both conditions, it works with the pipeline. The example below uses Vercel because the smoke test ran on Vercel. The pipeline does not otherwise prefer one provider over another.

For Amplify, enable **Hosting → Previews** on the PR's target branch and add **Check runs** to the repository's ABCA webhook events. Amplify publishes the URL in the completed check's `details_url`. A green GitHub check alone does not trigger capture if the webhook subscribes only to Deployment statuses. ABCA accepts successful preview checks from the `aws-amplify-console` app owner with a matching PR number, head SHA, and HTTPS `pr-<number>.<app-id>.amplifyapp.com` URL. No manual deployment event or extra GitHub Actions workflow is needed. The processor fetches that exact PR and confirms that it is still open with the same head SHA before capture, so two PRs that share a commit cannot redirect the screenshot or the Jira or Linear feedback.

**Existing Amplify operators.** Redeploy ABCA to pick up this receiver and processor. Then add **Check runs** to your existing webhook and keep **Deployment statuses** selected. Keep any branch-name `SCREENSHOT_TARGET_ENVIRONMENT` value (for example, `main`). Deployment statuses still use it, while validated Amplify PR checks bypass it. After the redeploy, a webhook that is already subscribed to **Check runs** starts to capture and publish Amplify PR previews that a branch-name filter previously excluded, with no further configuration change. Screenshots are publicly readable through CloudFront and may contain customer data rendered by the preview. To keep Amplify check-triggered capture disabled, deselect **Check runs** on the ABCA webhook. You do not need to change the environment filter to `Preview`. Subscriptions affect future events only, so rebuild an existing PR preview to verify the change. If an earlier receiver already accepted and deduplicated a completion, a replay of that same check within the one-hour dedup window does not capture again.

## What you get

When you (or the agent) push to a branch that triggers a preview deploy, your provider deploys the preview and posts a deployment status or Amplify preview check back to GitHub. ABCA's webhook receiver then:

1. Captures a full-page screenshot of the preview URL with AgentCore Browser.
2. Uploads the PNG to a private S3 bucket served through CloudFront.
3. Posts a markdown image comment on the open GitHub PR.
4. Posts explicit screenshot and live-preview links to the originating Jira issue, or delivers the preview to Linear when configured. Iterations preserve the preview in their existing status comment.

End-to-end latency is typically 10 to 15 seconds after your provider reports the deploy.

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

- **Lambda-only.** No agent runtime is involved after the PR is opened. The screenshot job is deterministic, so an LLM would only add cost without changing behavior.
- **AWS-managed default browser.** AgentCore Browser provides an `aws.browser.v1` session that you can attach to without provisioning your own browser resource.
- **Private S3 and CloudFront with OAC.** The screenshot bucket is fully private. CloudFront serves images anonymously over HTTPS so that GitHub markdown image embeds (and Linear's, when configured) can render them without auth.
- **WAF exemption.** On the signed webhook routes (`/v1/github/webhook`, `/v1/linear/webhook`, `/v1/jira/webhook`) the WAF rule `AWSManagedRulesCommonRuleSet-SignedWebhooks` counts rather than blocks two rules of the common rule set. The first is `SizeRestrictions_BODY`, because the full `deployment_status` payload (workflow run history, deploy URLs, and deployment metadata) exceeds the 8 KB body-size limit. The second is `CrossSiteScripting_BODY`, because PR and issue text can contain HTML (#1063). Every other rule of the set, such as LFI, RFI, and SQLi, still blocks. Each receiver verifies the signature over the raw body before it dispatches the event. Linear and Jira first read the tenant ID from the body to choose the signing secret. XSS matches on these routes are counted under the `SignedWebhookXssCounted` metric and alarmed.
- **Skips non-2xx pages.** The processor enables CDP's `Network` domain and captures the main-document HTTP status. If the preview URL returns 4xx or 5xx (404, 503, or a 3xx that does not redirect cleanly), the processor logs `Preview URL returned HTTP <status>; skipping screenshot` and posts no PR or Linear comment. The skip prevents a screenshot of a 404 page from being posted as if it were the deploy. Auth walls that return HTTP 200 (for example Vercel deployment protection) are out of scope. Disable deployment protection or use a public preview. See the Vercel setup section below.

## Prerequisites

- An ABCA stack deployed with the `deployPreviewScreenshots` feature enabled in its [deployment profile](./DEPLOYMENT_GUIDE.md#deployment-profiles). Confirm that `GitHubWebhookUrl`, `GitHubWebhookSecretArn`, and `ScreenshotCloudFrontDomain` are listed in the stack outputs.
- (Optional) Linear OAuth installed for at least one workspace (`bgagent linear setup <slug>`). It is required only if you want screenshots posted to Linear issues in addition to the GitHub PR. The `linear` feature must also be enabled.
- A GitHub repo that you own.
- Your deploy provider connected to that repo (the example uses Vercel).
- The AWS CLI logged in to the same account as the ABCA stack.
- The `bgagent` CLI installed (`bgagent configure`, `bgagent login`).

## Step-by-step setup (Vercel example)

### Step 1 — Connect Vercel to your GitHub repo

1. Open https://vercel.com/dashboard.
2. Click **Add New**, then **Project**.
3. Find your repo in the list. If it's not visible, click "Adjust GitHub App Permissions" and grant access.
4. Click **Import**.
5. Accept the framework defaults. Vercel auto-detects most stacks.
6. Click **Deploy**. Wait for the first deploy to finish.

### Step 2 — Vercel project settings

Go to **your-project → Settings** in the Vercel dashboard.

#### Settings → Git
- **Connected Git Repository**: confirm that the repo is listed.
- **`deployment_status` Events**: toggle **Enabled**. This setting tells Vercel to post the webhook to GitHub when each deploy finishes.
- **Pull Request Comments**: optional. This is Vercel's own comment with the preview URL. It does not affect ABCA either way.

#### Settings → Deployment Protection
- **Vercel Authentication**: set to **Disabled** (or "Only Production Deployments") for the demo. Otherwise AgentCore Browser reaches a Vercel auth wall and takes a screenshot of the login page instead of your app.

> **Production hardening.** Real deployments should keep Vercel Authentication on **Standard Protection** and use a [signed bypass token](https://vercel.com/docs/security/deployment-protection/methods-to-bypass-deployment-protection#protection-bypass-for-automation). The screenshot processor would need to inject the bypass token as a query parameter on the preview URL that it navigates to. That injection is currently not implemented.

> **Using Amplify?** Enable PR previews under **Hosting → Previews**, then follow Step 3 and include **Check runs** in the webhook events. For other providers, publish successful `deployment_status` events to GitHub. For self-hosted CI, add a GitHub Deployments API call at the end of your deploy job.

### Step 3 — Configure the GitHub webhook

This step connects deploys back to ABCA's screenshot pipeline.

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
   - **Secret**: generate any random string. Paste it both here AND into the next step
   - **SSL verification**: leave enabled
   - **Which events?**: choose "Let me select individual events", uncheck Pushes, check **Deployment statuses**, and also check **Check runs** for AWS Amplify PR previews
   - **Active**: ✓
4. Click **Add webhook**. GitHub sends a `ping` event immediately. Under "Recent Deliveries" you should see ✅ within seconds.

#### 3c. Mirror the signing secret into AWS

```bash
bgagent github set-webhook-secret
```

Paste the same secret you generated in 3b. The CLI writes it to the stack's `GitHubWebhookSecret` Secrets Manager entry, where the receiver Lambda reads it for HMAC verification.

### Step 4 — Smoke test

Open any PR on the configured repo. Push a commit and open the PR however you normally do, for example with the GitHub UI, `gh pr create`, GitHub Actions, or the agent. Wait 2 to 5 minutes for your provider to build the preview. The screenshot should appear on the PR as a markdown image comment.

**If you also have Linear configured**, create a Linear issue in a mapped project (for example "Update homepage heading"), apply the trigger label, and watch the agent open a PR. The same screenshot appears on both the GitHub PR and the Linear issue. If the GitHub comment appears but the Linear one does not, see Troubleshooting.

## Configuring for non-Vercel providers

The pipeline filters `deployment_status` webhooks against `SCREENSHOT_TARGET_ENVIRONMENT` (default `Preview`, which matches Vercel's per-PR environment label). To use a different value, pass `screenshotTargetEnvironment` to the `GitHubScreenshotIntegration` construct in your CDK app and redeploy.

| Provider | Typical `environment` value | What to set |
|---|---|---|
| Vercel | `Preview` | leave default |
| Amplify Hosting PR check | not used for filtering | keep existing value; subscribe to Check runs |
| Amplify branch deployment status | branch name | match the branch name exactly |
| Netlify | `Deploy Preview <PR#>` | currently not directly matchable across all PRs (single fixed-string filter only) |
| GitHub Actions custom | whatever your workflow passes | match it exactly |

## Troubleshooting

### GitHub webhook deliveries return 401 / 403

- **401 "Missing signature"**: the request did not reach the Lambda. Check that you saved the webhook with the right signing secret.
- **401 "Invalid signature"**: the secret you pasted into GitHub does not match the secret stored in AWS. Run `bgagent github set-webhook-secret` again with the value from the GitHub webhook page.
- **403 "Forbidden" with `X-Amzn-Errortype: ForbiddenException`**: WAF rejected the body. This should be rare on the `/v1/github/webhook` path, where body size and XSS matches are counted rather than blocked. If you see it, check the `BlockedRequests` metric on the `TaskApiWebAcl` regional WebACL in CloudWatch.

### Webhook delivers 200 but no screenshot lands

For Amplify, confirm that **Check runs** is selected on the ABCA webhook, that the `AWS Amplify Console Web Preview` check completed successfully, and that its details link opens the PR preview. `skipped_check` means that the event was not an eligible successful Amplify PR preview. The receiver also logs its `reason` as `screenshot.amplify_check_rejected`, without the raw payload or URL. A valid `X-GitHub-Delivery` UUID is logged as `delivery_id` so that you can locate the event in GitHub. Expected incomplete or unrelated checks retain info-level reason logs because every rejected check must be diagnosable. Adding the subscription affects future events only. Rebuild an existing preview to exercise the automatic path.

Inspect the receiver logs for rejected checks:

| Reason | What to check |
|---|---|
| `action_not_completed`, `check_not_completed`, `check_not_successful` | Wait for a successful completed check. |
| `unexpected_check_name`, `unexpected_app_owner`, `unexpected_app_slug` | The check must be `AWS Amplify Console Web Preview`, owned by `aws-amplify-console`, with an `aws-amplify-*` app slug. Other CI checks are ignored. |
| `invalid_details_url`, `untrusted_preview_url`, `invalid_pr_number` | The details link must be a trusted HTTPS `pr-N.<app-id>.amplifyapp.com` preview URL with a positive PR number, no credentials, and no non-default port. |
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

- `skipped_state`. The delivery was for a non-`success` status (for example `pending`, `in_progress`). Ignore it.
- `skipped_environment` (deployment statuses only). The deploy's `environment` field does not match `SCREENSHOT_TARGET_ENVIRONMENT`. This is a common cause for non-Vercel providers. See "Configuring for non-Vercel providers" above.
- `skipped_no_url`. The `success` status did not include `environment_url`. Some providers post success events without a URL. The next push usually carries the URL.
- `screenshot.amplify_pr_rejected`. Invalid forwarded PR metadata or a terminal rejection of the live PR response, logged once at warn level. Capture stops immediately. It does not retry, fall back to another PR, or emit `SCREENSHOT_PR_LOOKUP_EXHAUSTED`. See the reasons below.
- `screenshot.pr_lookup_rejected` / `SCREENSHOT_PR_LOOKUP_REJECTED`. GitHub rejected the validated PR lookup with a permanent HTTP failure, logged once at ERROR with `status`. Check token access and permissions, including for 404 responses that can conceal inaccessible repositories. Capture stops without retrying.
- `screenshot.pr_lookup_exhausted` / `SCREENSHOT_PR_LOOKUP_EXHAUSTED`. Retries or the lookup budget ran out. Check GitHub availability, token permissions, rate limits, or whether a deployment completed before the PR was created.
- `screenshot.preview_url_rejected`. URL validation stopped capture. `untrusted_preview_url` logs at WARN with `preview_host` and `url_parsed`. `preview_pr_number_mismatch` logs at ERROR with `SCREENSHOT_PREVIEW_PR_MISMATCH` when the preview hostname disagrees with the forwarded PR number.

Processor-side Amplify reasons:

| Reason | What to check |
|---|---|
| `invalid_forwarded_pr_number` | The forwarded PR number must be a positive safe integer. Deploy the receiver and processor together. |
| `pr_not_found` | GitHub returned 404 for the validated PR. Confirm the PR exists and the GitHub token can access it; GitHub also uses 404 to conceal inaccessible resources. |
| `pr_request_rejected` | GitHub rejected the PR lookup with a non-retryable 4xx response. Inspect the logged `status`, token permissions, and request. |
| `pr_number_mismatch` | GitHub returned a different PR number than the validated preview. Inspect the PR lookup response. |
| `pr_not_open` | The PR closed or merged while Amplify built the preview. No capture is needed. |
| `live_pr_head_sha_mismatch` | The live PR head changed after the check started. Rebuild the current preview. Receiver code `head_sha_mismatch` instead compares the check's embedded PR head with its own SHA. |
| `missing_head_ref` | GitHub returned the expected PR and SHA without a usable branch name. Inspect the PR response. |
| `malformed_pr_response` | GitHub returned a null, array, or non-object PR body. Inspect the API response. |

The processor rechecks the Amplify URL's HTTPS origin, credentials, port, and PR number before it requests a token or captures. URL rejection logs include only the hostname, never credentials, paths, or queries. A mismatch between the hostname and the forwarded number indicates an inconsistent invocation. Inspect the receiver and processor deployment versions.

Fetch failures, timeouts, non-JSON bodies, 5xx responses, HTTP 408 and 429, and all 403 responses retain bounded retries. Secondary rate limits can omit rate-limit headers, so even an ambiguous 403 retries. Persistent permission failures then emit `SCREENSHOT_PR_LOOKUP_EXHAUSTED`. HTTP failures of the deployment-status commit-pulls lookup, including 404, also remain retryable. Exhaustion records the final reason:

| Reason | What to check |
|---|---|
| `fetch_failed` | GitHub network reachability or per-request timeout. |
| `http_error` | GitHub returned non-2xx responses; inspect the preceding logged HTTP statuses, token permissions, and rate limits. |
| `non_json_response` | GitHub's response could not be parsed as JSON. |
| `malformed_pr_response` | The deployment-status commit-pulls endpoint returned a non-array body. |
| `pr_not_linked` | No open PR of this repository is associated with the deployment SHA yet. A pull request that lives in another repository and was opened from a branch of this one does not count. |
| `budget_exhausted` | Earlier processing consumed the PR lookup budget before the first request. |

After you resolve a failure, rebuild the preview, or wait for the one-hour dedup window before you replay the same check.

### No screenshots at all: check the processor alarms and DLQ

The receiver Lambda async-invokes the processor (`InvocationType: Event`) and returns `200` to GitHub as soon as that invoke is accepted, so a *processor*-side fault never propagates back. GitHub sees success and never redelivers. Only a failure to enqueue the invoke returns `500`. Two operator-visible signals catch a hard processor fault that would otherwise stop screenshots silently.

**Important.** The processor handler is best-effort by design. It catches its own per-step operational failures (a bad token, or AgentCore, S3, or comment-post errors) and returns success, so those failures appear as tagged log events (see the section above), **not** as Lambda `Errors`. Both alarms below fire only on faults that *escape* the handler: an init-time crash (missing env at cold start, bundling defect), an unhandled throw in an unguarded path, or the 120s hard timeout. For an operational failure that the handler caught (for example a revoked S3 or AgentCore permission), watch the processor **logs**, not these alarms.

- **`WebhookProcessorErrorAlarm`.** Fires on the processor's Lambda `Errors` metric. **Any** 5-minute period with `>= 1` error puts it in alarm (evaluation range 2 periods, 1 datapoint to alarm). It is the early signal that an invocation is faulting *now*.
- **`WebhookProcessorDlqDepthAlarm`.** Fires when such a failed invocation has exhausted Lambda's built-in async retries and landed on the DLQ (construct id `WebhookProcessorDlq`, 14-day retention, SSL-enforced). It is the backstop signal that a payload is now parked undelivered. The queue also gets SSE through SQS's service-side default. The construct does not set an explicit `encryption`.

Both alarms notify the `OperationalAlerts` topic (stack output `OperationalAlertsTopicArn`) when they go into `ALARM`. A fault that also exhausts the retries therefore sends two notifications, one per alarm. The topic has no subscriber until you add one. See [Alarm notifications](../design/OBSERVABILITY.md#alarm-notifications).

The two alarms catch the same failure class, but the `Errors` alarm fires no later than the DLQ-depth alarm. When the retries cross a period boundary, the `Errors` alarm fires one window earlier. The `Errors` metric is recorded at invocation time, before the retries are exhausted and the event lands on the DLQ. Find and inspect the DLQ. The construct sets no explicit queue name, so its physical name is CloudFormation-generated and *contains* the `WebhookProcessorDlq` construct id:

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

The message body is the original async-invoke event. The `RequestContext` and error attributes show why Lambda stopped retrying. Fix the root cause: check again the processor's IAM grants, the AgentCore Browser quota, and the GitHub and Linear token secrets. The event source is GitHub, not the DLQ, so to recover, **redeliver the webhook from GitHub's UI**. A Lambda async-invoke DLQ has no automatic re-invoke path, and the parked messages are event copies for diagnosis. Purge the queue (`aws sqs purge-queue`) once the alarm has cleared and you no longer need the payloads.

### Screenshot lands on GitHub PR but not on Linear

The GitHub-side post is the primary path. Linear is opt-in and best-effort. A skipped Linear post is normal if you do not have Linear configured. If you do, a pull request opened by a Linear task needs no identifier, because its issue comes from the task record. For a pull request that was not opened by a Linear task, the branch name, the title and the body are searched, in that order, for a Linear-style identifier (for example `ABCA-42`). A later identifier is used only when no workspace has the earlier one. If none of them names the issue, nothing is posted. Look for the processor log line `Linear identifier did not resolve to an issue`, whose field `identifiers` lists the identifiers that were tried. The line usually has one of these causes:

- No workspace has an issue under any of the identifiers that were found. Any word followed by a number in the branch name reads as one (`feature/upgrade-node-22` gives `NODE-22`), so check that the title or the body names the issue.
- The identifier's workspace isn't OAuth-installed. Run `bgagent linear list-projects` to confirm the issue's project is in the registry.
- The identifier exists in two workspaces (warning `Linear issue lookup: identifier exists in more than one workspace`). Nothing says which of the two is meant, so nothing is posted.
- A workspace could not be asked (its token did not resolve, or warnings `Linear issue lookup: graphql ...`). The search ends there: an identifier further down is not taken in place of one that could not be checked.

A pull request whose branch has the form `bgagent/<id>/...` but names a task of another repository gets the screenshot comment on GitHub only. The processor logs `Failed to persist screenshot_url` with the error `The branch names no task of this repository`. A task counts as one of another repository when its blueprint is registered under another name than the one GitHub reports (letter case aside), for example the old name of a repository that was renamed. In that case, register the blueprint under the current name.

### CloudFront serves a 403

Visit the public URL directly:

```
https://<ScreenshotCloudFrontDomain>/screenshots/<owner>_<repo>/<sha>-<deploymentId>-<16hex>.png
```

Copy the exact URL from the PR comment. The `<16hex>` suffix is random per capture, so you cannot construct the URL by hand.

If the URL returns 403, check that the bucket policy includes the OAC service principal. CDK should generate this automatically. Redeploy if it does not.

### Screenshot shows a login page (Vercel only)

Step 2's "Vercel Authentication: Disabled" toggle was not applied. Turn Vercel Authentication off, push another commit, and confirm that the next screenshot renders the actual app.

## Production hardening considerations

Consider these points before you use this pipeline on a real product:

- **Deploy protection.** This guide turns Vercel Authentication off so that the headless browser can render the preview. For real use, you will want it back on with a signed bypass token (or your provider's equivalent), and the bypass injected onto the preview URL that the screenshot processor navigates to.
- **IAM scope.** The screenshot processor's IAM is scoped to the three AgentCore Browser actions that the handler calls: `StartBrowserSession`, `StopBrowserSession`, and `ConnectBrowserAutomationStream`. It also has standard Lambda, S3, and Secrets Manager grants. The first two actions are control-plane writes. The third is the data-plane SigV4-presigned WSS handshake. It is published in the [AWS Service Authorization Reference for `bedrock-agentcore`](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrockagentcore.html), which also notes that it takes no resource types or condition keys. The resource is `*` because Browser sessions are ephemeral and the data-plane stream actions do not support resource-level scoping. A cdk-nag IAM5 suppression annotates the resource wildcard.
- **SSRF exposure.** The processor navigates AgentCore Browser to `deployment_status.environment_url` from the verified webhook payload. The handler validates the URL first (https only, no literal IP, no localhost, link-local, or loopback address) so that a forged payload cannot point the browser at private hosts. AgentCore Browser also runs outside the customer VPC, so pivots to IMDS and private subnets are blocked regardless. Operators who want a stricter check can add an explicit hostname allowlist by editing `isAllowedScreenshotUrl` in `cdk/src/handlers/shared/screenshot-url.ts`.
- **Screenshot URL enumerability.** The bucket is private, but CloudFront serves anonymously and the path follows `screenshots/<owner>_<repo>/<sha>-<8-byte-random>.png`. The 64-bit random suffix makes URLs unguessable for an outside reader. The prefix is enumerable from the public PR, and the suffix is not. If your previews regularly render PII or other regulated content, consider also enabling CloudFront access logs and a WAF in front of the CDN, and shortening screenshot retention below the 30-day default (a constant in `cdk/src/constructs/screenshot-bucket.ts`).
