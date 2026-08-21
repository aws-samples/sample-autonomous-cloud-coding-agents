# Cost model

This document provides an order-of-magnitude cost model for the platform. Cost efficiency is a first-class design principle (see [ARCHITECTURE.md](./ARCHITECTURE.md)). The model covers infrastructure baseline costs, per-task variable costs, and cost attribution guidance.

Monthly user/team USD budgets and AWS-native cost attribution build on this baseline analysis and focus controls on the dominant cost drivers.

## Infrastructure baseline (monthly, idle)

These costs are incurred regardless of task volume:

| Component | Estimated cost | Notes |
|---|---|---|
| NAT Gateway (1×) | ~$32/month | Fixed hourly cost + data processing. Single AZ (see [COMPUTE.md  - Network architecture](./COMPUTE.md)). |
| VPC Interface Endpoints (7×, 2 AZs) | ~$102/month | $0.01/hr × 7 endpoints × 2 AZs × 730 hrs. |
| VPC Flow Logs | ~$3/month | CloudWatch ingestion. |
| DynamoDB (on-demand, idle) | ~$0/month | Pay-per-request; 8 core tables (Tasks, Events, Nudges, Approvals, UserConcurrency, Budgets, Webhooks, Repo). Integration tables add more when enabled. No cost when idle. |
| S3 Trace Artifacts bucket (idle) | ~$0/month | 7-day lifecycle auto-expires objects; no cost when no traces are stored. |
| EventBridge reconciler rule | <$0.01/month | Invokes Lambda every 5 min (288/day). Rule itself is free; Lambda invocation is the cost (see below). |
| Stranded task reconciler Lambda (idle) | <$0.01/month | 288 invocations/day × 256 MB × ~100 ms avg (early exit when no stranded tasks). ~$0.005/month total (requests + duration). |
| CloudWatch Logs retention | ~$1–5/month | Depends on log volume. 90-day retention. |
| API Gateway (idle) | ~$0/month | Pay-per-request. |
| **Total baseline** | **~$140–150/month** | Reconciler adds negligible cost; VPC networking remains dominant. |

### Scale-to-zero characteristics

Most platform components are fully serverless and incur zero cost when idle: DynamoDB (PAY_PER_REQUEST, 8 core tables plus integration tables), Lambda, API Gateway, S3 (trace artifacts auto-expire in 7 days), SQS, ECS Fargate (cluster is free, when enabled), AgentCore Runtime (per-session), Bedrock (per-token), and Cognito (free tier). The stranded task reconciler adds <$0.01/month even when idle (288 Lambda invocations/day, early-exit). The always-on cost floor (~$140–150/month) is dominated by VPC networking infrastructure (NAT Gateway + 7 interface endpoints across 2 AZs) which is required for private subnet connectivity to AWS services and GitHub. See the [Deployment guide](../guides/DEPLOYMENT_GUIDE.md) for the full scale-to-zero breakdown.

## Per-task variable costs

Each task incurs costs proportional to its duration, token consumption, and compute usage. The dominant cost driver is **Bedrock model invocation** (token cost), not infrastructure.

### Cost breakdown per task (order of magnitude)

Assuming a typical task: 1–2 hours, Claude Sonnet, ~100K input tokens, ~20K output tokens per turn, ~50 turns:

| Component | Estimated cost per task | Calculation basis |
|---|---|---|
| **Bedrock tokens (dominant)** | $2–15 | Varies widely by model, task complexity, and turn count. Claude Sonnet: ~$3/M input tokens, ~$15/M output tokens. A 50-turn task with 100K input + 20K output per turn ≈ 5M input + 1M output ≈ $15 + $15 = $30 at list price. Prompt caching reduces this significantly (up to 90% for cache hits). Typical range: $2–15 after caching. |
| AgentCore Runtime compute | $0.10–0.50 | 2 vCPU / 8 GB for 1–2 hours. Pricing model is per-session based on vCPU-hours and GB-hours. |
| Lambda orchestrator | <$0.01 | ~10 invocations per task (admission, hydration, polling, finalization). Negligible. |
| Lambda fanout consumer | <$0.01 | Triggered per batch of task events (batch size 100, 5 s window). Typically 5–20 invocations per task at 256 MB. Negligible. |
| Lambda nudge / trace / events | <$0.01 | On-demand per user request. Negligible unless heavily polled. |
| DynamoDB reads/writes | <$0.01 | ~30–80 operations per task (task CRUD, events, nudges, counter updates). Negligible. |
| DynamoDB Streams (fanout and budget rollup) | <$0.01 | Stream reads charged per 25 KB. Event fanout processes progress records; budget rollup processes terminal TaskTable records. Negligible. |
| S3 trace upload (if `--trace`) | <$0.01 | One PUT per task + storage (gzipped NDJSON, typically 50–500 KB, auto-expires in 7 days). |
| NAT Gateway data | <$0.01 | GitHub API traffic: clone + push. Small repos: <10 MB. |
| Custom step Lambdas | $0–0.05 | Only if configured. Per-invocation: ~$0.01 per step. |
| **Total per task** | **$2–15** | Bedrock tokens dominate (>90% of per-task cost). New interactive features add <$0.01 per task. |

### Optional: deploy-preview screenshots

The screenshot pipeline (see [Deploy preview screenshots guide](../guides/DEPLOY_PREVIEW_SCREENSHOTS_GUIDE.md)) is opt-in per repo and deterministic — no LLM, no agent runtime. Only fires when a connected deploy provider posts `deployment_status: success`.

| Component | Estimated cost per screenshot | Notes |
|---|---|---|
| AgentCore Browser session | $0.005–0.015 | ~30–60 s of `aws.browser.v1` for navigate + capture. Per-second billing. |
| Lambda processor | <$0.001 | 512 MB, ~10–20 s wall time per invocation. |
| S3 PutObject + storage | <$0.001 | One PNG (~200 KB–2 MB), 30-day TTL via lifecycle. |
| CloudFront request + bytes-out | <$0.001 | First-render fetch from GitHub markdown image proxy + a small number of viewer fetches. |
| **Total per screenshot** | **~$0.01** | Dominated by AgentCore Browser session time. |

Baseline overhead (CloudFront distribution + S3 bucket idle) is <$1/month and absorbed into the existing infrastructure baseline above. CloudFront has no per-distribution monthly fee; you pay only per-request and per-byte-out.

A high-volume team with ~500 preview deploys per month would add ~$5/month to the per-task variable line, which is rounding error compared to Bedrock token costs.

### Cost sensitivity analysis

| Factor | Impact on cost | Mitigation |
|---|---|---|
| Model choice | 5–10× between Haiku and Opus | Default to Claude Sonnet; allow per-repo override. |
| Turn count | Linear with turns | `max_turns` cap (default 100, configurable 1–500). |
| Cost budget | Hard stop at budget | `max_budget_usd` cap (configurable $0.01–$100). Agent stops when budget is reached regardless of remaining turns. |
| Task duration | Sub-linear (compute is cheap; tokens dominate) | AgentCore: 8-hour service limit; orchestrator: 9-hour `executionTimeout`. |
| Prompt caching | 50–90% token cost reduction | Enable by default; cache system prompts and repo context. |
| Concurrency | Linear with parallel tasks | Per-user and system-wide concurrency limits. |

## Cost at scale

| Scale | Tasks/month | Estimated monthly cost (infra + tasks) |
|---|---|---|
| Low (1 developer) | 30–60 | $200–550 |
| Medium (small team) | 200–500 | $550–3,000 |
| High (org-wide) | 2,000–5,000 | $5,000–30,000 |

These estimates assume Claude Sonnet with prompt caching enabled and average task complexity.

## Cost attribution

For multi-user deployments, cost should be attributable to individual users and repositories:

- **Per-task:** Token usage and compute duration are captured in task metadata (`agent.cost_usd`, `agent.turns`  - see [OBSERVABILITY.md](./OBSERVABILITY.md)). Note: `agent.cost_usd` is the Claude Agent SDK's **client-side estimate** (a build-time price table), not authoritative billing — use it for guardrails, and AWS Cost Explorer / CUR 2.0 for the real bill (see [COST_ATTRIBUTION.md](../guides/COST_ATTRIBUTION.md)).
- **Per-user:** Aggregate task costs by `user_id`.
- **Per-team:** Attribute a task to the Cognito groups captured at task creation.
- **Per-repo:** Aggregate task costs by `repo`.
- **Dashboard:** Cost attribution dashboards should be built from the same task-level metrics.

For **AWS-native** chargeback of Bedrock spend (Cost Explorer / CUR 2.0 by `user_id` / `repo`, plus per-call invocation-log forensics) — beyond the in-app `cost_usd` meter above — see the operator guide [COST_ATTRIBUTION.md](../guides/COST_ATTRIBUTION.md) and the platform design [BEDROCK_COST_ATTRIBUTION.md](./BEDROCK_COST_ATTRIBUTION.md).

## Cost guardrails (current)

| Guardrail | Mechanism | Default |
|---|---|---|
| Turn limit | `max_turns` per task | 100 |
| Cost budget | `max_budget_usd` per task | None (unlimited) |
| Monthly user/team warning | Estimated terminal-task cost rollup | CloudWatch/SNS at 80% and 100% |
| Monthly user/team hard stop | Admission check at 100% | Disabled per scope unless `--hard-stop` is set |
| Session timeout | Orchestrator timeout | 9 hours |
| Concurrency limit | Per-user atomic counter | 3 concurrent tasks |
| System concurrency | System-wide counter | Account-level AgentCore quota |

Monthly budgets use UTC calendar months and the same estimated `cost_usd` stored on terminal tasks. The TaskTable stream consumer transactionally increments the user and captured Cognito-team rollups and writes a task marker so duplicate stream delivery cannot double count. Admission checks every configured applicable scope; any scope at 100% with hard stop enabled rejects a new task. In-flight tasks continue and can overshoot because their final cost is unknown until termination.

The 80% and 100% crossings emit claimed, per-scope `ABCA/Budgets` CloudWatch metrics. Aggregate threshold alarms notify the shared `OperationalAlerts` SNS topic; simultaneous crossings can be coalesced, while the reconciler logs retain exact scope details. Metric claims normally limit each crossing to one emission per scope/month. Emission happens before the claim is persisted so a crash cannot permanently suppress an alert; a concurrent or crash retry can therefore emit a harmless duplicate. Operators configure and inspect limits with `bgagent budget set|status`.

Authenticated users can inspect their personal scope with `bgagent budget status --me` (`GET /v1/tasks?view=budget`). The response includes estimated spend even when no personal limit is configured. It does not expose team scopes or permit mutation; administrators remain the only actors who set user/team limits.

The controls add one on-demand DynamoDB table with PITR, two standard CloudWatch alarms, and up to two custom metric time series. Admission, terminal rollup, and user-status requests incur usage-based DynamoDB/API Gateway/Lambda/SNS charges; no dedicated continuously running compute is added. See the operator guide's [cost-control setup and cost breakdown](../guides/COST_ATTRIBUTION.md#setting-up-cost-controls).

## Additional guardrails

- Token-denominated monthly budgets (the shipped fleet budget is USD-denominated).
- Cost attribution dashboard in the control panel.
- Automated model downgrade (e.g. Sonnet -> Haiku) when approaching budget limits.

## Reference

- [COMPUTE.md](./COMPUTE.md) -- Compute option billing models and network architecture.
- [ORCHESTRATOR.md](./ORCHESTRATOR.md) -- Polling cost analysis.
- [OBSERVABILITY.md](./OBSERVABILITY.md) -- Cost-related metrics (`agent.cost_usd`, token usage).
- [Deployment guide](../guides/DEPLOYMENT_GUIDE.md) -- Deployment choices, scale-to-zero analysis, AWS services inventory.
- [DEPLOYMENT_ROLES.md](./DEPLOYMENT_ROLES.md) -- Least-privilege IAM policies for deployment.
