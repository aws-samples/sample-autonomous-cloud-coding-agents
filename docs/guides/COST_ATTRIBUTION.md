# Cost attribution (operator guide)

This guide shows how to attribute **Amazon Bedrock model-inference spend** to individual users and repositories in a multi-user ABCA deployment. It is the operator's companion to the platform design in [BEDROCK_COST_ATTRIBUTION.md](../design/BEDROCK_COST_ATTRIBUTION.md) and the cost model in [COST_MODEL.md](../design/COST_MODEL.md#cost-attribution).

> [!WARNING]
> **The in-app `cost_usd` is a client-side estimate, not authoritative billing data.** It is the Claude Agent SDK's `total_cost_usd` (`agent/src/runner.py`), which the SDK computes locally from a price table bundled into the SDK at build time. The estimate can drift from your actual AWS bill when Bedrock pricing changes, when the SDK version does not recognize a model, when prompt-cache read or write rates apply, or when AWS discounts, commitments, or free-tier allowances apply that the client cannot model. Use it for per-task budget guardrails and approximate insight. **Do not bill end users or trigger financial decisions from it.** For authoritative cost, use **AWS Cost Explorer or CUR 2.0** (the session-tag chargeback meter below), which reflects your actual invoice. ABCA runs on Bedrock, so the authoritative source is your AWS bill, not the Claude Console.

## Three meters, three questions

ABCA gives you three independent views of cost. They answer different questions, so use them together.

| Meter | Granularity | Source of truth for | Where |
|---|---|---|---|
| **In-app `cost_usd`** | Per task, with monthly rollups by user and by team | Per-task and fleet admission guardrails | Task metadata, `bgagent budget` |
| **CUR session-tag chargeback** | Per user or per repo, aggregated per usage type per day | AWS-native FinOps chargeback | Cost Explorer, CUR 2.0 |
| **Invocation-log metadata** | Per Bedrock call | Per-call forensics, reconciliation | `/aws/bedrock/model-invocation-logs/<stack>` |

Why all three: the in-app meter is an estimate that the platform computes, and it does not reflect AWS discounts or commitments. IAM session tags reach your **bill**, but only as aggregated billing data. They are *not* written to invocation logs. Request metadata gives **per-call** detail in logs, but it is *not* a cost-allocation tag and never appears in Cost Explorer. According to the [AWS docs](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal-tracking.html), session tags and request metadata are complementary mechanisms.

## What the platform does automatically

After deployment, each agent task makes its Bedrock calls under **session-tagged, refreshable credentials** that carry `{user_id, repo, task_id}`. The task also attaches the same values as **request metadata** to every call. You do **not** need to change any code. What remains is **operator setup in the AWS Billing console**. AWS does not show tag-based cost data until you activate it, and you can activate it only *after* the platform has run tagged tasks (see the ordering note below).

## ABCA monthly budget guardrails

ABCA can aggregate terminal task `cost_usd` by Cognito user and by Cognito-group team, alert at 80% and 100%, and optionally reject new tasks at 100%. The default is alerts only. Admission remains open unless the operator passes `--hard-stop` for that scope. Configure the budgets with `bgagent budget set` and inspect the current UTC month with `bgagent budget status`. See [Monthly user and team budgets](./USER_GUIDE.md#monthly-user-and-team-budgets).

The monthly budget is an operational guardrail, not invoice reconciliation. It has every limitation of the SDK estimate, counts a task only when the task reaches a terminal state, and can overshoot while tasks run concurrently. For authoritative billing alerts, use AWS Budgets over activated cost-allocation tags.

### Setting up cost controls

1. **Choose scopes.** Use one Cognito group such as `Everyone` for a shared organization pool. Add department groups, project groups, or personal limits only when they represent a real independent control. Avoid whitespace and commas in the names of budget-team groups. API Gateway can expose the Cognito group claim as a delimited string, in which those characters are treated as separators.
2. **Create and populate groups.** Cognito group membership is the team mapping. `bgagent budget` validates groups but does not create them or add users. For an organization pool, bulk-add existing users once and add group assignment to the invitation or onboarding process.

   Get `UserPoolId` from `bgagent platform outputs`. Then create the shared group and add each existing user, in the Cognito console or with the AWS CLI:

   ```bash
   aws cognito-idp create-group \
     --user-pool-id <user-pool-id> \
     --group-name Everyone

   aws cognito-idp admin-add-user-to-group \
     --user-pool-id <user-pool-id> \
     --username <cognito-username> \
     --group-name Everyone
   ```

   Repeat `admin-add-user-to-group` each time you onboard a new user. After a membership change, a logged-in user should run `bgagent login` again so that interactive API requests carry current group claims. Linked headless integrations resolve current groups server-side.
3. **Set recurring limits.**

   ```bash
   # Shared organization pool with admission stopped at 100%.
   bgagent budget set --team Everyone --monthly-usd 10000 --hard-stop

   # Optional personal alerts-only limit.
   bgagent budget set --user alice@example.com --monthly-usd 100
   ```

4. **Connect notifications.** Confirm the deployment's `alertEmail` subscription or subscribe an operations destination to the exported `OperationalAlertsTopicArn`. The alarm tells you that a threshold was crossed. To identify the scope and spend, inspect the `OrchestrationReconciler` Lambda logs.
5. **Verify both views.** Operators run `bgagent budget status`. Users run `bgagent budget status --me` after `bgagent login`. Users see only their personal scope and cannot change it.
6. **Test enforcement.** Use a non-production user or group and a small limit. Let a task finish so that its estimated cost rolls up. Then verify the 80% and 100% notifications and a `429 BUDGET_EXCEEDED` response for a hard-stop scope.

The recurring configuration survives month boundaries. Spend automatically starts from zero at the next UTC month. To change a limit or toggle hard stop, run one `budget set` command. There is currently no `budget unset` command and no automatic default-group assignment.

### Troubleshooting missing alarm notifications

If a budget or DLQ alarm enters `ALARM` but no notification arrives, inspect that alarm's **History** in CloudWatch, including its action results. `CloudWatch Alarms is not authorized to perform: SNS:Publish` indicates a topic-policy problem. Earlier deployments created the `OperationalAlerts` topic with only `DenyInsecureTransport`. [#925](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/925) adds the missing CloudWatch publish permission, restricted to the deployment account and Region.

Deploy a revision that contains this fix with your normal stack deployment procedure, and preserve the deployment's configuration. Verify that the topic identified by `OperationalAlertsTopicArn` has `AllowCloudWatchAlarmsPublish` in its access policy. Keep the topic's customer-managed encryption key and CloudWatch KMS permissions, because SNS publishing and key access are both required.

To validate delivery:

1. Confirm that the email subscription on this topic is **Confirmed**, not `PendingConfirmation`, and that the alarm's actions are enabled.
2. In a test deployment, trigger a fresh CloudWatch alarm transition to `ALARM` targeting this topic. For a budget test, either use a non-production user whose monthly threshold has not already emitted or re-arm an existing test scope with `bgagent budget set` as described below. Let a task finish so that its cost rolls up with spend at or above the threshold. Wait for the aggregate alarm to return to `OK` before another threshold test.
3. Verify a successful SNS action in the alarm's History and receipt at the subscribed destination. If the action succeeds but email is absent, inspect distribution-list restrictions and mail filtering.

A direct SNS test publish uses the operator's credentials, so it does not verify CloudWatch's publish permission. Deployment does not replay historical failed actions. ABCA records each user or team threshold as alerted for the UTC month when it emits the metric, before SNS delivery.

Running `bgagent budget set` for a scope clears that scope's 80% and 100% alert markers for the current UTC month, even if the limit is unchanged. Run the command again to re-arm the thresholds for a repeat test. Pass the scope's current `--monthly-usd` and, if the scope uses one, `--hard-stop`. If you omit `--hard-stop`, the scope becomes alerts-only. The command preserves accumulated spend and does not immediately publish an alert. A later eligible task-cost rollup evaluates the thresholds again. If spend is already at 100%, use an alerts-only test scope, because a hard-stop scope still rejects new tasks. Without re-arming, a threshold that was already emitted in the same month may produce no new metric or notification.

### Cost of the controls

There are two kinds of cost:

- **Administrative effort.** One initial pass that creates groups and bulk-adds members, one budget command per user or team scope, and one group assignment per new user. A single `Everyone` scope has no recurring monthly configuration work.
- **AWS charges.** One on-demand DynamoDB table with point-in-time recovery, three standard CloudWatch alarms, up to three custom metric time series (`BudgetThresholdCrossed` with `Threshold=80` and `Threshold=100`, plus dimensionless `BudgetTeamMembershipUnresolved`), and small usage-based DynamoDB, API Gateway, Lambda, and SNS charges. The implementation reuses the existing task-list Lambda for `--me` and the existing TaskTable stream reconciler for rollups, so it adds no continuously running compute.

At the public US East (N. Virginia) first-tier list rates verified in August 2026, the three standard alarms are about **$0.30/month** total. If all three custom metric series are active, their list-rate equivalent is up to about **$0.90/month**. The CloudWatch portion is then approximately **$1.20/month** before free-tier allowance. The [CloudWatch free tier](https://aws.amazon.com/cloudwatch/pricing/) includes 10 custom metrics and 10 alarm metrics per month, shared with the rest of the account, so a lightly used account may pay $0 for that portion.

The [factory scoreboard](../design/OBSERVABILITY.md#factory-scoreboard) is not a budget control, but its metrics are priced the same way. Its `ABCA/Factory` namespace holds up to 17 custom metric time series: `TasksFinished` for each of six outcomes, `HumanTouchpoints` and `CostUsd` for each of two kinds of work, `PullRequestsResolved` for each of two final states of a pull request, and five metrics without dimensions. If all 17 series are active, their list-rate equivalent at the same rates is up to about **$5.10/month** before free-tier allowance. The scoreboard adds no alarm and no table. Each finished task costs one conditional DynamoDB write, one log line, and one more TaskTable stream record, on which the existing reconciler repeats its idempotent orchestration and budget steps. Following the pull requests adds one function that runs once an hour, about 720 runs a month. Each run reads every completed task in retention from an index that holds whole records, so its read is billed on the bytes of all of them, whatever the number of open pull requests. The rate is about half a read unit for every 4 KB. The run then sends GitHub at most 250 requests. A pull request costs at most two more conditional writes, each with its stream record, and one task event when its merge or close is recorded.

DynamoDB is `PAY_PER_REQUEST`. Costs scale with task volume, group count, retained deduplication markers, table storage, and PITR backup storage. Each task admission makes a strongly consistent read of its user and team scopes, and each terminal task writes one deduplication marker plus one spend increment per applicable scope in a transaction. See [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/) and use the [AWS Pricing Calculator](https://calculator.aws/) for the deployment Region and expected task volume. API Gateway, Lambda, and SNS are request-based and normally negligible compared with agent inference for this low-frequency control plane.

## FinOps checklist

The operator does these steps once. CDK does not automate org-level billing (see [Out of scope](../design/BEDROCK_COST_ATTRIBUTION.md#out-of-scope-unchanged-from-issue)).

> **Ordering matters. The tags cannot be activated in advance.** IAM-principal cost-allocation tag *keys* (`user_id`, `repo`) do not exist in the Billing console until the deployed platform has made tagged Bedrock calls. The sequence is therefore: **deploy, run at least one task, wait up to 24 h, then activate** (step 1).
>
> **Use the Billing console, not the Tag Editor (Resource Groups).** Cost-allocation tags are at **Billing and Cost Management → Cost allocation tags** (left nav). The *Tag Editor* (Resource Groups) is a different tool. It lists taggable *resource types* such as `AWS::IAM::InstanceProfile`, and it is **not** where you activate these tags.

1. **Activate IAM-principal cost-allocation tags.** In the Billing and Cost Management console, open **Cost allocation tags** (left nav) and select the **User-defined cost allocation tags** tab. The `user_id` and `repo` keys appear with tag type **IAM principal**. Select them and choose **Activate**. `task_id` is high-cardinality, so keep it for logs, not for Cost Explorer.
   - Keys appear only **after** the first Bedrock call that carries them, and can take **up to 24 h** to show.
   - Activation is **not retroactive**. Only spend incurred after activation is tagged.
   - IAM-principal cost-allocation tags are a recent Bedrock capability. If the keys have not appeared a day after you ran tagged tasks, your account or Region may not have the capability enabled yet. The invocation-log path (below) attributes per call regardless.
2. **Create a CUR 2.0 export with caller identity.** In the Billing console, open **Data Exports**. Create a CUR 2.0 export and select the option to include the **caller-identity ARN**.
   - If you already have a CUR 2.0 export, you must create a **new** one. Existing exports do not backfill identity data.
3. **Set budgets and alerts** per `user_id` or `repo` tag as needed, with AWS Budgets. They are independent of the in-app `max_budget_usd` per-task guardrail.

## Querying per-call detail (invocation logs)

> **Model-invocation logging must be ON in the agent's Region, or there is no `requestMetadata` to query.** Bedrock records request metadata **only** when account-level model-invocation logging is enabled in the Region where the call is made. The stack enables this logging automatically, with a custom resource that points at the `/aws/bedrock/model-invocation-logs/<stack>` log group. The setting is **account- and Region-scoped**, so confirm it after deploy, especially if logging was previously disabled or the stack Region differs from the Region where you expect calls.
>
> Verify it is on:
> ```
> aws bedrock get-model-invocation-logging-configuration --region <stack-region>
> ```
> An empty result means that logging is **off** and no metadata is captured. Re-enable it, pointing at the stack's own log group and `BedrockLoggingRole`:
> ```
> aws bedrock put-model-invocation-logging-configuration --region <stack-region> \
>   --logging-config '{"cloudWatchConfig":{"logGroupName":"/aws/bedrock/model-invocation-logs/<stack>","roleArn":"<BedrockLoggingRole ARN>"},"textDataDeliveryEnabled":true,"imageDataDeliveryEnabled":false,"embeddingDataDeliveryEnabled":false}'
> ```
> Do **not** include `largeDataDeliveryS3Config` with an empty bucket name. Bedrock rejects it (`min length: 3`) and the call fails. Only calls made *after* logging is enabled are recorded, so run a task again to populate the logs.

Request metadata is in the top-level `requestMetadata` field of each log record. This example CloudWatch Logs Insights query totals tokens per user and model:

```
fields requestMetadata.user_id as user, modelId,
       input.inputTokenCount as inTokens,
       output.outputTokenCount as outTokens
| stats sum(inTokens) as totalInput, sum(outTokens) as totalOutput, count() as calls
        by user, modelId
| sort totalInput desc
```

To turn tokens into cost, multiply by the current [Bedrock per-token rates](https://aws.amazon.com/bedrock/pricing/), or join logs to CUR on `requestId` for invoice-accurate reconciliation at the grain of model and usage type.

## Caveats

- **The request-metadata header is best-effort.** It depends on Claude Code signing the `X-Amzn-Bedrock-Request-Metadata` header into the SigV4 request. If a Claude Code release does not sign it, the header is rejected and per-call metadata is absent. Chargeback per user and per repo (the session-tag track) is unaffected, because it does not rely on the header. See the [validation note](../design/BEDROCK_COST_ATTRIBUTION.md#track-2--per-request-metadata).
- **Attribution fails open.** If the per-task credential helper cannot assume the SessionRole, Bedrock still works under the shared compute role. Spend for that task is untagged, not blocked.
- **No PII in tags or metadata.** `user_id` and `repo` are recorded in your bill and logs. Do not map them to anything sensitive.
