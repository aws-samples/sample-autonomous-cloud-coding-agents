# Cost model

This document provides an order-of-magnitude cost model for the platform. Cost efficiency is a first-class design principle (see [ARCHITECTURE.md](./ARCHITECTURE.md)). The model covers infrastructure baseline costs, per-task variable costs, and cost attribution guidance.

Detailed cost management (per-user budgets, cost attribution dashboards, token budget enforcement) builds on this baseline analysis and focuses on the dominant cost drivers.

## Infrastructure baseline (monthly, idle)

These costs are incurred regardless of task volume:

| Component | Estimated cost | Notes |
|---|---|---|
| NAT Gateway (1×) | ~$32/month | Fixed hourly cost + data processing. Single AZ (see [COMPUTE.md  - Network architecture](./COMPUTE.md)). |
| VPC Interface Endpoints (7×) | ~$50/month | $0.01/hr per endpoint per AZ. |
| VPC Flow Logs | ~$3/month | CloudWatch ingestion. |
| DynamoDB (on-demand, idle) | ~$0/month | Pay-per-request; no cost when idle. |
| CloudWatch Logs retention | ~$1–5/month | Depends on log volume. 90-day retention. |
| API Gateway (idle) | ~$0/month | Pay-per-request. |
| **Total baseline** | **~$85–95/month** | |

### Scale-to-zero characteristics

Most platform components are fully serverless and incur zero cost when idle: DynamoDB (PAY_PER_REQUEST), Lambda, API Gateway, ECS Fargate (cluster is free, when enabled), AgentCore Runtime (per-session), Bedrock (per-token), and Cognito (free tier). The always-on cost floor (~$85–95/month) is dominated by VPC networking infrastructure (NAT Gateway + 7 interface endpoints) which is required for private subnet connectivity to AWS services and GitHub. See the [Deployment guide](../guides/DEPLOYMENT_GUIDE.md) for the full scale-to-zero breakdown.

## Per-task variable costs

Each task incurs costs proportional to its duration, token consumption, and compute usage. The dominant cost driver is **Bedrock model invocation** (token cost), not infrastructure.

### Cost breakdown per task (order of magnitude)

Assuming a typical task: 1–2 hours, Claude Sonnet, ~100K input tokens, ~20K output tokens per turn, ~50 turns:

| Component | Estimated cost per task | Calculation basis |
|---|---|---|
| **Bedrock tokens (dominant)** | $2–15 | Varies widely by model, task complexity, and turn count. Claude Sonnet: ~$3/M input tokens, ~$15/M output tokens. A 50-turn task with 100K input + 20K output per turn ≈ 5M input + 1M output ≈ $15 + $15 = $30 at list price. Prompt caching reduces this significantly (up to 90% for cache hits). Typical range: $2–15 after caching. |
| AgentCore Runtime compute | $0.10–0.50 | 2 vCPU / 8 GB for 1–2 hours. Pricing model is per-session based on vCPU-hours and GB-hours. |
| Lambda orchestrator | <$0.01 | ~10 invocations per task (admission, hydration, polling, finalization). Negligible. |
| DynamoDB reads/writes | <$0.01 | ~20–50 operations per task (task CRUD, events, counter updates). Negligible. |
| NAT Gateway data | <$0.01 | GitHub API traffic: clone + push. Small repos: <10 MB. |
| Custom step Lambdas | $0–0.05 | Only if configured. Per-invocation: ~$0.01 per step. |
| **Total per task** | **$2–15** | Bedrock tokens dominate (>90% of per-task cost). |

### Cost sensitivity analysis

| Factor | Impact on cost | Mitigation |
|---|---|---|
| Model choice | 5–10× between Haiku and Opus | Default to Claude Sonnet; allow per-repo override. |
| Turn count | Linear with turns | `max_turns` cap (default 100, configurable 1–500). |
| Cost budget | Hard stop at budget | `max_budget_usd` cap (configurable $0.01–$100). Agent stops when budget is reached regardless of remaining turns. |
| Task duration | Sub-linear (compute is cheap; tokens dominate) | 8-hour max session timeout. |
| Prompt caching | 50–90% token cost reduction | Enable by default; cache system prompts and repo context. |
| Concurrency | Linear with parallel tasks | Per-user and system-wide concurrency limits. |

## Cost at scale

| Scale | Tasks/month | Estimated monthly cost (infra + tasks) |
|---|---|---|
| Low (1 developer) | 30–60 | $150–500 |
| Medium (small team) | 200–500 | $500–3,000 |
| High (org-wide) | 2,000–5,000 | $5,000–30,000 |

These estimates assume Claude Sonnet with prompt caching enabled and average task complexity.

## Cost attribution

For multi-user deployments, cost should be attributable to individual users and repositories:

- **Per-task:** Token usage and compute duration are captured in task metadata (`agent.cost_usd`, `agent.turns`  - see [OBSERVABILITY.md](./OBSERVABILITY.md)).
- **Per-user:** Aggregate task costs by `user_id`.
- **Per-repo:** Aggregate task costs by `repo`.
- **Dashboard:** Cost attribution dashboards should be built from the same task-level metrics.

## Cost guardrails (current)

| Guardrail | Mechanism | Default |
|---|---|---|
| Turn limit | `max_turns` per task | 100 |
| Cost budget | `max_budget_usd` per task | None (unlimited) |
| Session timeout | Orchestrator timeout | 8 hours |
| Concurrency limit | Per-user atomic counter | 2 concurrent tasks |
| System concurrency | System-wide counter | Account-level AgentCore quota |

## Additional guardrails

- Per-user monthly token budgets with alerts at 80% and hard stop at 100%.
- Per-team monthly cost budgets.
- Cost attribution dashboard in the control panel.
- Automated model downgrade (e.g. Sonnet -> Haiku) when approaching budget limits.

## Reference

- [Deployment guide](../guides/DEPLOYMENT_GUIDE.md) -- Deployment choices, scale-to-zero analysis, AWS services inventory.
- [DEPLOYMENT_ROLES.md](./DEPLOYMENT_ROLES.md) -- Least-privilege IAM policies for deployment.
- [COMPUTE.md](./COMPUTE.md) -- VPC infrastructure cost breakdown, compute option billing models.
- [ORCHESTRATOR.md](./ORCHESTRATOR.md) -- Polling cost analysis.
- [OBSERVABILITY.md](./OBSERVABILITY.md) -- Cost-related metrics (`agent.cost_usd`, token usage).
