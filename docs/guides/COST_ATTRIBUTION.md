# Cost attribution (operator guide)

How to attribute **Amazon Bedrock model-inference spend** to individual users and repositories in a multi-user ABCA deployment. This is the operator-facing companion to the platform design in [BEDROCK_COST_ATTRIBUTION.md](../design/BEDROCK_COST_ATTRIBUTION.md) and the cost model in [COST_MODEL.md](../design/COST_MODEL.md#cost-attribution).

> [!WARNING]
> **The in-app `cost_usd` is a client-side estimate, not authoritative billing data.** It is the Claude Agent SDK's `total_cost_usd` (`agent/src/runner.py`), computed locally from a price table bundled into the SDK at build time. It can drift from your actual AWS bill when Bedrock pricing changes, the SDK version does not recognize a model, prompt-cache read/write rates apply, or AWS discounts/commitments/free-tier apply that the client cannot model. Use it for per-task budget guardrails and approximate insight — **do not bill end users or trigger financial decisions from it.** For authoritative cost, use **AWS Cost Explorer / CUR 2.0** (the session-tag chargeback meter below), which reflects your actual invoice. (ABCA runs on Bedrock, so the authoritative source is your AWS bill — not the Claude Console.)

## Three meters, three questions

ABCA gives you three independent views of cost. They answer different questions; use them together.

| Meter | Granularity | Source of truth for | Where |
|---|---|---|---|
| **In-app `cost_usd`** | Per task | Per-task budget guardrails (`max_budget_usd`) | Task metadata / control panel |
| **CUR session-tag chargeback** | Per user / per repo, aggregated per usage-type per day | AWS-native FinOps chargeback | Cost Explorer / CUR 2.0 |
| **Invocation-log metadata** | Per Bedrock call | Per-call forensics, reconciliation | `/aws/bedrock/model-invocation-logs/<stack>` |

Why all three: the in-app meter is an estimate the platform computes; it does not reflect AWS discounts/commitments. IAM session tags flow to your **bill** but only as aggregated billing data (they are *not* written to invocation logs). Request metadata gives **per-call** detail in logs but is *not* a cost-allocation tag and never appears in Cost Explorer. Per [AWS docs](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal-tracking.html), session tags and request metadata are complementary mechanisms.

## What the platform does automatically

Once deployed, each agent task makes its Bedrock calls under **session-tagged, refreshable credentials** carrying `{user_id, repo, task_id}`, and stamps the same values as **request metadata** on every call. You do **not** need to change any code. What remains is **operator setup in the AWS Billing console** — AWS does not surface tag-based cost data until you activate it, and (see the ordering note below) you can only activate *after* the platform has run tagged tasks.

## FinOps checklist

These steps are a one-time operator responsibility (CDK does not automate org-level billing — see [Out of scope](../design/BEDROCK_COST_ATTRIBUTION.md#out-of-scope-unchanged-from-issue)).

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

- **Request-metadata header is best-effort.** It depends on Claude Code signing the `X-Amzn-Bedrock-Request-Metadata` header into the SigV4 request; if a Claude Code release does not, the header is rejected and per-call metadata is absent. Per-user/repo chargeback (the session-tag track) is unaffected — it does not rely on the header. See the [validation note](../design/BEDROCK_COST_ATTRIBUTION.md#track-2--per-request-metadata).
- **Attribution fails open.** If the per-task credential helper cannot assume the SessionRole, Bedrock still works under the shared compute role — spend for that task is simply untagged, not blocked.
- **No PII in tags/metadata.** `user_id` and `repo` are recorded in your bill and logs; do not map them to anything sensitive.
