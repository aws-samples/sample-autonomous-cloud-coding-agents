---
title: Cost attribution
---

# Cost attribution (operator guide)

How to attribute **Amazon Bedrock model-inference spend** to individual users and repositories in a multi-user ABCA deployment. This is the operator-facing companion to the platform design in [BEDROCK_COST_ATTRIBUTION.md](/sample-autonomous-cloud-coding-agents/architecture/bedrock-cost-attribution) and the cost model in [COST_MODEL.md](/sample-autonomous-cloud-coding-agents/architecture/cost-model#cost-attribution).

> [!WARNING]
> **The in-app `cost_usd` is a client-side estimate, not authoritative billing data.** It is the Claude Agent SDK's `total_cost_usd` (`agent/src/runner.py`), computed locally from a price table bundled into the SDK at build time. It can drift from your actual AWS bill when Bedrock pricing changes, the SDK version does not recognize a model, prompt-cache read/write rates apply, or AWS discounts/commitments/free-tier apply that the client cannot model. Use it for per-task budget guardrails and approximate insight — **do not bill end users or trigger financial decisions from it.** For authoritative cost, use **AWS Cost Explorer / CUR 2.0** (the session-tag chargeback meter below), which reflects your actual invoice. (ABCA runs on Bedrock, so the authoritative source is your AWS bill — not the Claude Console.)

## Three meters, three questions

ABCA gives you three independent views of cost. They answer different questions; use them together.

| Meter | Granularity | Source of truth for | Where |
|---|---|---|---|
| **In-app `cost_usd`** | Per task; monthly rollups by user/team | Per-task and fleet admission guardrails | Task metadata / `bgagent budget` |
| **CUR session-tag chargeback** | Per user / per repo, aggregated per usage-type per day | AWS-native FinOps chargeback | Cost Explorer / CUR 2.0 |
| **Invocation-log metadata** | Per Bedrock call | Per-call forensics, reconciliation | `/aws/bedrock/model-invocation-logs/<stack>` |

Why all three: the in-app meter is an estimate the platform computes; it does not reflect AWS discounts/commitments. IAM session tags flow to your **bill** but only as aggregated billing data (they are *not* written to invocation logs). Request metadata gives **per-call** detail in logs but is *not* a cost-allocation tag and never appears in Cost Explorer. Per [AWS docs](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal-tracking.html), session tags and request metadata are complementary mechanisms.

## What the platform does automatically

Once deployed, each agent task makes its Bedrock calls under **session-tagged, refreshable credentials** carrying `{user_id, repo, task_id}`, and stamps the same values as **request metadata** on every call. You do **not** need to change any code. What remains is **operator setup in the AWS Billing console** — AWS does not surface tag-based cost data until you activate it, and (see the ordering note below) you can only activate *after* the platform has run tagged tasks.

## ABCA monthly budget guardrails

ABCA can aggregate terminal task `cost_usd` by Cognito user and Cognito-group team, alert at 80%/100%, and optionally reject new tasks at 100%. Configure it with `bgagent budget set` and inspect the current UTC month with `bgagent budget status`; see [Monthly user and team budgets](/sample-autonomous-cloud-coding-agents/using/overview#monthly-user-and-team-budgets).

This is an operational guardrail, not invoice reconciliation. It inherits every limitation of the SDK estimate, counts a task only when it reaches a terminal state, and can overshoot while tasks run concurrently. Use AWS Budgets over activated cost-allocation tags for authoritative billing alerts.

### Setting up cost controls

1. **Choose scopes.** Use one Cognito group such as `Everyone` for a shared organization pool. Add department/project groups or personal limits only when they represent a real independent control.
2. **Create and populate groups.** Cognito group membership is the team mapping. `bgagent budget` validates groups but does not create them or add users. For an organization pool, bulk-add existing users once and add group assignment to the invitation/onboarding process.

   Get `UserPoolId` from `bgagent platform outputs`, then create the shared group and add each existing user in the Cognito console or AWS CLI:

   ```bash
   aws cognito-idp create-group \
     --user-pool-id <user-pool-id> \
     --group-name Everyone

   aws cognito-idp admin-add-user-to-group \
     --user-pool-id <user-pool-id> \
     --username <cognito-username> \
     --group-name Everyone
   ```

   Repeat `admin-add-user-to-group` during each new-user onboarding. A logged-in user should run `bgagent login` again after a membership change so interactive API requests carry current group claims; linked headless integrations resolve current groups server-side.
3. **Set recurring limits.**

   ```bash
   # Shared organization pool with admission stopped at 100%.
   bgagent budget set --team Everyone --monthly-usd 10000 --hard-stop

   # Optional personal alerts-only limit.
   bgagent budget set --user alice@example.com --monthly-usd 100
   ```

4. **Connect notifications.** Confirm the deployment's `alertEmail` subscription or subscribe an operations destination to the exported `OperationalAlertsTopicArn`.
5. **Verify both views.** Operators run `bgagent budget status`; users run `bgagent budget status --me` after `bgagent login`. Users see only their personal scope and cannot change it.
6. **Test enforcement.** Use a non-production user/group and a small limit. Let a task finish so its estimated cost rolls up, then verify the 80%/100% notification and a `429 BUDGET_EXCEEDED` response for a hard-stop scope.

The recurring configuration survives month boundaries; spend automatically starts from zero at the next UTC month. Changing a limit or toggling hard stop is one `budget set` command. There is currently no `budget unset` command and no automatic default-group assignment.

### Cost of the controls

There are two kinds of cost:

- **Administrative effort:** one initial group-creation/bulk-membership pass, one budget command per user/team scope, and one group assignment per new user. A single `Everyone` scope has no recurring monthly configuration work.
- **AWS charges:** one on-demand DynamoDB table with point-in-time recovery, two standard CloudWatch alarms, up to two custom metric time series (`Threshold=80` and `Threshold=100`), and small usage-based DynamoDB/API Gateway/Lambda/SNS charges. The implementation reuses the existing task-list Lambda for `--me` and the existing TaskTable stream reconciler for rollups, so it adds no continuously running compute.

At the public US East (N. Virginia) first-tier list rates verified in August 2026, the two standard alarms are about **$0.20/month** total. If both custom threshold metric series are active, their list-rate equivalent is up to about **$0.60/month**, making the CloudWatch portion approximately **$0.80/month** before free-tier allowance. The [CloudWatch free tier](https://aws.amazon.com/cloudwatch/pricing/) includes 10 custom metrics and 10 alarm metrics per month, shared with the rest of the account, so a lightly used account may pay $0 for that portion.

DynamoDB is `PAY_PER_REQUEST`; costs scale with task volume, group count, retained deduplication markers, table storage, and PITR backup storage. Each task admission strongly reads its user/team scopes, and each terminal task transactionally writes one deduplication marker plus one spend increment per applicable scope. See [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/) and use the [AWS Pricing Calculator](https://calculator.aws/) for the deployment Region and expected task volume. API Gateway, Lambda, and SNS are request-based and normally negligible compared with agent inference for this low-frequency control plane.

## FinOps checklist

These steps are a one-time operator responsibility (CDK does not automate org-level billing — see [Out of scope](/sample-autonomous-cloud-coding-agents/architecture/bedrock-cost-attribution#out-of-scope-unchanged-from-issue)).

> **Ordering matters — the tags can't be pre-activated.** IAM-principal cost-allocation tag *keys* (`user_id`, `repo`) do not exist in the Billing console until the deployed platform has actually made tagged Bedrock calls. So the sequence is: **deploy → run at least one task → wait up to 24 h → then activate** (step 1). You cannot activate them before the first tagged call exists.
>
> **Use the Billing console, not Tag Editor / Resource Groups.** Cost-allocation tags live at **Billing and Cost Management → Cost allocation tags** (left nav). The *Tag Editor* (Resource Groups) is a different tool — it lists taggable *resource types* (`AWS::IAM::InstanceProfile`, etc.) and is **not** where you activate these.

1. **Activate IAM-principal cost-allocation tags.** Billing and Cost Management console → **Cost allocation tags** (left nav) → the **User-defined cost allocation tags** tab → the `user_id` and `repo` keys appear with tag type **IAM principal** → select them → **Activate**. (`task_id` is high-cardinality — keep it for logs, not Cost Explorer.)
   - Keys appear only **after** the first Bedrock call carrying them, and can take **up to 24 h** to show.
   - Activation is **not retroactive** — only spend incurred after activation is tagged.
   - IAM-principal cost-allocation tags are a recent Bedrock capability. If the keys never appear a day after running tagged tasks, your account/region may not have it enabled yet — the invocation-log path (below) attributes per call regardless.
2. **Create a CUR 2.0 export with caller identity.** Billing console → **Data Exports** → create a CUR 2.0 export and select the option to include the **caller-identity ARN**.
   - If you already have a CUR 2.0 export, you must create a **new** one — existing exports do not backfill identity data.
3. **Set budgets / alerts** per `user_id` or `repo` tag as needed (AWS Budgets), independent of the in-app `max_budget_usd` per-task guardrail.

## Querying per-call detail (invocation logs)

> **Model-invocation logging must be ON in the agent's Region, or there is no `requestMetadata` to query.** Bedrock records request metadata **only** when account-level model-invocation logging is enabled in the Region where the call is made. The stack provisions this automatically (a custom resource pointing at the `/aws/bedrock/model-invocation-logs/<stack>` log group), but it is **account- and Region-scoped**, so confirm it after deploy — especially if logging was previously disabled, or the stack Region differs from where you expect calls.
>
> Verify it is on:
> ```
> aws bedrock get-model-invocation-logging-configuration --region <stack-region>
> ```
> An empty result means logging is **off** and no metadata is being captured. Re-enable it (pointing at the stack's own log group + `BedrockLoggingRole`):
> ```
> aws bedrock put-model-invocation-logging-configuration --region <stack-region> \
>   --logging-config '{"cloudWatchConfig":{"logGroupName":"/aws/bedrock/model-invocation-logs/<stack>","roleArn":"<BedrockLoggingRole ARN>"},"textDataDeliveryEnabled":true,"imageDataDeliveryEnabled":false,"embeddingDataDeliveryEnabled":false}'
> ```
> Do **not** include `largeDataDeliveryS3Config` with an empty bucket name — Bedrock rejects it (`min length: 3`) and the call fails. Only calls made *after* logging is enabled are recorded; re-run a task to populate logs.

Request metadata lands under the top-level `requestMetadata` field of each log record. Example CloudWatch Logs Insights query (tokens per user + model):

```
fields requestMetadata.user_id as user, modelId,
       input.inputTokenCount as inTokens,
       output.outputTokenCount as outTokens
| stats sum(inTokens) as totalInput, sum(outTokens) as totalOutput, count() as calls
        by user, modelId
| sort totalInput desc
```

To turn tokens into cost, multiply by the current [Bedrock per-token rates](https://aws.amazon.com/bedrock/pricing/), or join logs to CUR on `requestId` for invoice-accurate reconciliation at the model + usage-type grain.

## Caveats

- **Request-metadata header is best-effort.** It depends on Claude Code signing the `X-Amzn-Bedrock-Request-Metadata` header into the SigV4 request; if a Claude Code release does not, the header is rejected and per-call metadata is absent. Per-user/repo chargeback (the session-tag track) is unaffected — it does not rely on the header. See the [validation note](/sample-autonomous-cloud-coding-agents/architecture/bedrock-cost-attribution#track-2--per-request-metadata).
- **Attribution fails open.** If the per-task credential helper cannot assume the SessionRole, Bedrock still works under the shared compute role — spend for that task is simply untagged, not blocked.
- **No PII in tags/metadata.** `user_id` and `repo` are recorded in your bill and logs; do not map them to anything sensitive.
