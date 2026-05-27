# Deploy preview screenshots setup guide

Wire your repo into ABCA so that every preview deploy gets screenshotted and posted as a comment on the open GitHub PR. If you also have Linear configured, the same screenshot is posted to the linked Linear issue as a bonus.

> The pipeline only needs GitHub. Linear posting is opt-in: present iff `LinearWorkspaceRegistryTable` has at least one active row (configured via [Linear setup guide](./LINEAR_SETUP_GUIDE.md)). Without Linear, the GitHub-side screenshot still works; the Linear-side just no-ops silently.

## Works with any provider that posts `deployment_status`

The pipeline doesn't care who built the deploy — it only listens for GitHub `deployment_status` events. Any provider that calls the [GitHub Deployments API](https://docs.github.com/en/rest/deployments/deployments) works:

| Provider | Out of the box? | Notes |
|---|---|---|
| **Vercel** (managed hosting + GitHub app) | ✅ | The worked example below uses this. Default `environment` is `Preview`. |
| **AWS Amplify Hosting** (Connected to GitHub) | ✅ | Posts deployment_status for each branch deploy. `environment` is the branch name — set `SCREENSHOT_TARGET_ENVIRONMENT` to your preview branch (or use the same value on every branch via the `BackgroundAgentStack` construct prop). |
| **Netlify** (managed hosting + GitHub app) | ⚠ | `environment` is `Deploy Preview <PR#>`, which the current single-string `SCREENSHOT_TARGET_ENVIRONMENT` filter doesn't match across all PRs. Workable today only by picking one specific PR's environment string; broader pattern matching isn't shipped. |
| **GitHub Actions** that calls `POST /repos/.../deployments` (typical for ECS/Fargate, Cloud Run, Fly.io, Railway, Cloudflare Pages, etc.) | ✅ | Your workflow controls the `environment` field; pass whatever you want and set `SCREENSHOT_TARGET_ENVIRONMENT` to match. |
| **External CI** (CircleCI, GitLab, ArgoCD) that doesn't touch GitHub Deployments | ❌ | Add a final job that calls the GitHub Deployments API after the deploy succeeds — see [GitHub's example](https://docs.github.com/en/rest/deployments/deployments#create-a-deployment). |

ABCA needs only two things from a deploy:

1. The `deployment_status` event has reached `state: success`.
2. `deployment_status.environment_url` is populated with the live preview URL.

If your provider gives you that, you're done. The example below is Vercel because that's what we smoke-tested on; the pipeline doesn't otherwise prefer one provider over another.

## What you get

When you (or the agent) push to a branch that triggers a preview deploy, your provider deploys the preview, posts a `deployment_status` event back to GitHub, and ABCA's webhook receiver:

1. Captures a full-page screenshot of the preview URL via AgentCore Browser
2. Uploads the PNG to a private S3 bucket served via CloudFront
3. Posts a markdown image comment on the open GitHub PR
4. **(Optional)** If Linear is wired: looks up the Linear issue by identifier in the PR title/body (e.g. `ABCA-42`) and posts the same screenshot as a Linear comment. Skipped silently if Linear isn't configured or no identifier is present.

End-to-end latency: typically 10–15 seconds after your provider reports the deploy.

## How it works

```
agent push → provider preview build → deployment_status webhook
                                              ↓
                                    POST /v1/github/webhook
                                              ↓
                                  receiver Lambda (HMAC verify, dedup,
                                                  state=success +
                                                  environment filter)
                                              ↓
                                    processor Lambda
                                              ↓
                                    AgentCore Browser session
                                              ↓
                                  PNG → private S3 (30-day TTL)
                                              ↓
                              CloudFront-served public URL
                                              ↓
                          GitHub PR comment (+ Linear issue comment if linked)
```

Architecture notes:

- **Lambda-only.** No agent runtime is involved post-PR — the screenshot job is deterministic; an LLM would only add cost without changing behavior.
- **AWS-managed default browser.** AgentCore Browser ships an `aws.browser.v1` session you can attach to without provisioning your own browser resource.
- **Private S3 + CloudFront with OAC.** Screenshot bucket is fully private; CloudFront serves images anonymously over HTTPS so GitHub markdown image embeds (and Linear's, when configured) can render them without auth.
- **WAF exemption.** The `/v1/github/webhook` path is excluded from the AWSManagedRulesCommonRuleSet because deployment_status payloads (which embed absolute deploy URLs) trip `GenericRFI_BODY` otherwise.

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

> **Using a different provider?** Skip Steps 1–2 and follow your provider's instructions to publish `deployment_status` events to GitHub. For Amplify Hosting, that's automatic when the app is connected via GitHub. For self-hosted CI, add a `gh api repos/.../deployments` step at the end of your deploy job. Then continue with Step 3.

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
   - **Which events?**: choose "Let me select individual events", uncheck Pushes, check **Deployment statuses** only
   - **Active**: ✓
4. **Add webhook**. GitHub fires a `ping` event right away — under "Recent Deliveries" you should see ✅ within seconds.

#### 3c. Mirror the signing secret into AWS

```bash
bgagent github set-webhook-secret
```

Paste the same secret you used in 4b. The CLI writes it to the stack's `GitHubWebhookSecret` Secrets Manager entry, where the receiver Lambda reads it for HMAC verification.

### Step 4 — Smoke test

Open any PR on the configured repo (push a commit, open a PR however you normally do — GitHub UI, `gh pr create`, GitHub Actions, agent, etc.) Wait 2–5 minutes for your provider to build the preview. The screenshot should land on the PR as a markdown image comment.

**If you also have Linear configured:** create a Linear issue in a mapped project (e.g. "Update homepage heading"), apply the trigger label, and watch the agent open a PR. The same screenshot lands on both the GitHub PR and the Linear issue. If the GitHub comment shows but Linear doesn't, see Troubleshooting.

## Configuring for non-Vercel providers

The pipeline filters incoming webhooks against `SCREENSHOT_TARGET_ENVIRONMENT` (default `Preview`, matches Vercel's per-PR environment label). To use a different value, pass `screenshotTargetEnvironment` to the `GitHubScreenshotIntegration` construct in your CDK app and redeploy.

| Provider | Typical `environment` value | What to set |
|---|---|---|
| Vercel | `Preview` | leave default |
| Amplify Hosting | branch name (e.g. `main`, `staging`) | the branch you treat as preview |
| Netlify | `Deploy Preview <PR#>` | currently not directly matchable across all PRs (single fixed-string filter only) |
| GitHub Actions custom | whatever your workflow passes | match it exactly |

## Troubleshooting

### GitHub webhook deliveries return 401 / 403

- **401 "Missing signature"**: the request didn't reach our Lambda — check that you saved the webhook with the right signing secret.
- **401 "Invalid signature"**: the secret you pasted into GitHub doesn't match what's stored in AWS. Re-run `bgagent github set-webhook-secret` with the value from the GitHub webhook page.
- **403 "Forbidden" with `X-Amzn-Errortype: ForbiddenException`**: WAF rejected the body. Should not happen on the `/v1/github/webhook` path because that path is exempted from the CommonRuleSet, but if you see it, check the `BlockedRequests` metric on the `TaskApiWebAcl` regional WebACL in CloudWatch.

### Webhook delivers 200 but no screenshot lands

Check the screenshot processor logs:

```bash
aws lambda list-functions --region us-east-1 \
  --query "Functions[?contains(FunctionName, 'GitHubScreenshot') && contains(FunctionName, 'Processor')].FunctionName" \
  --output text
```

Then tail the function's CloudWatch log group. Common silent skips:

- `skipped_state` — the delivery was for a non-`success` status (e.g. `pending`, `in_progress`); ignore.
- `skipped_environment` — the deploy's `environment` field doesn't match `SCREENSHOT_TARGET_ENVIRONMENT`. Common cause for non-Vercel providers; see "Configuring for non-Vercel providers" above.
- `skipped_no_url` — the `success` status didn't include `environment_url`. Some providers post URL-less success events; the next push usually carries the URL.
- `No open PR found for SHA after retries` — the deploy provider built and reported faster than the agent could `gh pr create` (race window > 35s). Rare; redeliver the webhook from GitHub's UI to retry.

### Screenshot lands on GitHub PR but not on Linear

The GitHub-side post is the primary path; Linear is opt-in and best-effort. Skipping the Linear post is normal if you don't have Linear configured. If you do, look for the processor log line `Linear identifier did not resolve to an issue` — usually means:

- The PR title and body don't contain a Linear-style identifier (e.g. `ABCA-42`). The agent's task description includes the identifier by default; if you opened the PR manually it might not.
- The identifier's workspace isn't OAuth-installed. Run `bgagent linear list-projects` to confirm the issue's project is in the registry.

### CloudFront serves a 403

Visit the public URL directly:

```
https://<ScreenshotCloudFrontDomain>/screenshots/<repo>/<sha>.png
```

If it 403s, check that the bucket policy includes the OAC service principal (CDK should generate this automatically — re-deploy if it doesn't).

### Screenshot shows a login page (Vercel only)

You forgot Step 2's "Vercel Authentication: Disabled" toggle. Toggle it off, push another commit, and confirm the next screenshot renders the actual app.

## Production hardening considerations

Things to think about before using this on a real product:

- **Deploy protection.** This guide turns Vercel Authentication off so the headless browser can render the preview. For real use, you'll want it back on with a signed bypass token (or your provider's equivalent) and the bypass injected onto the preview URL the screenshot processor navigates to.
- **IAM scope.** The screenshot processor's IAM grants `bedrock-agentcore:*`; tightening to the specific Browser action set is preferable.
- **Sensitive content.** If your previews include PII or other regulated content, consider CloudFront access logs + a WAF in front of the public CDN, and shorten screenshot retention below the 30-day default (constant in `cdk/src/constructs/screenshot-bucket.ts`).
