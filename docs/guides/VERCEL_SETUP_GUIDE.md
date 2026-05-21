# Vercel preview screenshots setup guide

This guide walks through wiring a Vercel-connected GitHub repo into ABCA so that every preview deploy gets screenshotted and posted as a comment on both the open GitHub PR **and** the linked Linear issue.

> **Prerequisite phases:** Linear OAuth (Phase 2.0b — see [Linear setup guide](./LINEAR_SETUP_GUIDE.md)) must be installed before this guide is useful, since the screenshot-to-Linear leg reuses the per-workspace OAuth tokens from that path.

## What you get

When ABCA opens a PR for a Linear-driven task, Vercel deploys the preview, posts a `deployment_status` event back to GitHub, and ABCA's webhook receiver:

1. Captures a full-page screenshot of the preview URL via AgentCore Browser
2. Uploads the PNG to a private S3 bucket served via CloudFront
3. Posts a markdown image comment on the open GitHub PR
4. Looks up the Linear issue (by identifier in the PR title/body — e.g. `ABCA-42`) and posts the same screenshot as a Linear comment

End-to-end latency: typically 10–15 seconds after Vercel reports the deploy.

## How it works

```
agent push → Vercel preview build → deployment_status webhook
                                              ↓
                                    POST /v1/github/webhook
                                              ↓
                                  receiver Lambda (HMAC verify, dedup)
                                              ↓
                                    processor Lambda
                                              ↓
                                    AgentCore Browser session
                                              ↓
                                  PNG → private S3 (30-day TTL)
                                              ↓
                              CloudFront-served public URL
                                              ↓
                          GitHub PR comment + Linear issue comment
```

Architecture notes:

- **Lambda-only.** No agent runtime is involved post-PR — the screenshot job is deterministic; an LLM would only add cost without changing behavior.
- **AWS-managed default browser.** AgentCore Browser ships an `aws.browser.v1` session you can attach to without provisioning your own browser resource.
- **Private S3 + CloudFront with OAC.** Screenshot bucket is fully private; CloudFront serves images anonymously over HTTPS so GitHub Markdown and Linear's image previews can render them without auth.
- **WAF exemption.** The `/v1/github/webhook` path is excluded from the AWSManagedRulesCommonRuleSet because Vercel `deployment_status` payloads (which embed absolute deploy URLs) trip `GenericRFI_BODY` otherwise.

## Prerequisites

- ABCA stack deployed (`mise //cdk:deploy` in this branch or later) — confirm `GitHubWebhookUrl` + `GitHubWebhookSecretArn` + `ScreenshotCloudFrontDomain` are listed in the stack outputs
- Linear OAuth installed for at least one workspace (`bgagent linear setup <slug>`)
- A GitHub repo you own AND where you can install the Vercel app
- A Vercel account that can import that repo
- AWS CLI logged in to the same account as the ABCA stack
- The `bgagent` CLI installed (`bgagent configure`, `bgagent login`)

## Step-by-step setup

### Step 1 — Connect Vercel to your GitHub repo

1. Open https://vercel.com/dashboard.
2. **Add New** → **Project**.
3. Find your repo in the list (e.g. `your-org/vercel-abca-linear`). If it's not visible, click "Adjust GitHub App Permissions" and grant access.
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

> **Production hardening.** When you graduate the demo to a real production setup, switch Vercel Authentication back to **Standard Protection** and configure a [signed bypass token](https://vercel.com/docs/security/deployment-protection/methods-to-bypass-deployment-protection#protection-bypass-for-automation). The screenshot processor will need to inject the bypass token as a query parameter on the preview URL — this is tracked as a followup.

### Step 3 — Onboard the repo to ABCA

ABCA needs to know the repo is allowed to receive tasks. Two writes:

#### 3a. Register the repo in `RepoTable`

There's no CLI helper today; do a direct DDB put. Replace the table name with your stack's value (`aws cloudformation describe-stacks ... RepoTableName`):

```bash
aws dynamodb put-item --region us-east-1 \
  --table-name <RepoTableName> \
  --item '{
    "repo": {"S": "your-org/your-vercel-repo"},
    "status": {"S": "active"},
    "onboarded_at": {"S": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"},
    "updated_at": {"S": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}
  }'
```

#### 3b. Map a Linear project → this repo

```bash
# Find the Linear project UUID
bgagent linear list-projects

# Map it to the repo
bgagent linear onboard-project <linear-project-uuid> \
  --repo your-org/your-vercel-repo \
  --label abca
```

The `--label` controls which Linear label triggers a task. Defaults to `bgagent`; the demo uses `abca`. You can use any label you like, but it has to match what users will apply on Linear issues.

### Step 4 — Configure the GitHub webhook

This is what wires Vercel deploys back to ABCA's screenshot pipeline.

#### 4a. Get the webhook URL

```bash
aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name <YOUR_STACK_NAME> \
  --query 'Stacks[0].Outputs[?OutputKey==`GitHubWebhookUrl`].OutputValue' \
  --output text
# → https://<api-id>.execute-api.us-east-1.amazonaws.com/v1/github/webhook
```

#### 4b. Get the signing secret

```bash
SECRET_ARN=$(aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name <YOUR_STACK_NAME> \
  --query 'Stacks[0].Outputs[?OutputKey==`GitHubWebhookSecretArn`].OutputValue' \
  --output text)

aws secretsmanager get-secret-value \
  --region us-east-1 \
  --secret-id "$SECRET_ARN" \
  --query SecretString --output text
```

#### 4c. Add the webhook on the GitHub repo

1. Open `https://github.com/<your-org>/<your-vercel-repo>/settings/hooks`.
2. Click **Add webhook**.
3. Fill in:
   - **Payload URL**: the URL from 4a
   - **Content type**: `application/json`
   - **Secret**: the value from 4b
   - **SSL verification**: leave enabled
   - **Which events?**: choose "Let me select individual events", uncheck Pushes, check **Deployment statuses** only
   - **Active**: ✓
4. **Add webhook**. GitHub fires a `ping` event right away — under "Recent Deliveries" you should see ✅ within seconds.

### Step 5 — Smoke test

1. Open a Linear issue in your mapped project (e.g. "Update homepage heading"). It will get a Linear identifier like `ABCA-42`.
2. Add the `abca` label.
3. Wait 2-5 minutes:
   - Agent reacts 👀 on the Linear issue (within ~10s)
   - Agent does the work, opens a PR
   - Vercel builds the preview (~30-60s)
   - **Screenshot lands on the GitHub PR** as a comment
   - **Same screenshot lands on the Linear issue** as a comment

If the GitHub comment shows up but Linear doesn't (or vice versa), see Troubleshooting below.

## Troubleshooting

### GitHub webhook deliveries return 401 / 403

- **401 "Missing signature"**: the request didn't reach our Lambda — check that you saved the webhook with the right signing secret.
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
- `skipped_environment` — Vercel reported the deploy as something other than `Preview`. The processor only screenshots Preview deploys by default; production hardening is a followup.
- `skipped_no_url` — the `success` status didn't include `environment_url`. Vercel does sometimes post URL-less success events; the next push usually carries the URL.
- `No open PR found for SHA after retries` — Vercel built and reported faster than the agent could `gh pr create` (race window > 35s). Rare; redeliver the webhook from GitHub's UI to retry.

### Screenshot lands on GitHub PR but not on Linear

The GitHub comment is the load-bearing path; Linear is best-effort. Look for the processor log line `Linear identifier did not resolve to an issue` — usually means:

- The PR title and body don't contain a Linear-style identifier (e.g. `ABCA-42`). The agent's task description includes the identifier by default; if you opened the PR manually it might not.
- The identifier's workspace isn't OAuth-installed. Run `bgagent linear list-projects` to confirm the issue's project is in the registry.

### CloudFront serves a 403

Visit the public URL directly:

```
https://<ScreenshotCloudFrontDomain>/screenshots/<repo>/<sha>.png
```

If it 403s, check that the bucket policy includes the OAC service principal (CDK should generate this automatically — re-deploy if it doesn't).

### Vercel screenshots show a login page

You forgot Step 2's "Vercel Authentication: Disabled" toggle. Toggle it off, push another commit, and confirm the next screenshot renders the actual app.

## Production hardening (followups)

The demo configuration optimizes for "look, it works" rather than security posture. Before using this on a real product:

1. **Re-enable Vercel Standard Protection** + signed bypass token; teach the screenshot processor to inject `?x-vercel-protection-bypass=<token>` on preview URLs (followup).
2. **Scope IAM down from `bedrock-agentcore:*`** to the specific Browser action set (followup, tracked).
3. **Add CloudFront access logs + WAF** if screenshots ever contain sensitive content.
4. **Tighten the screenshot retention** below 30 days if your privacy review requires it (constant in `cdk/src/constructs/screenshot-bucket.ts`).
