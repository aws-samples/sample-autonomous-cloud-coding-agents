---
title: Deployment guide
---

# Deployment guide

This guide covers deploying ABCA into an AWS account, including compute backend choices, scale-to-zero characteristics, and the complete AWS service inventory. For day-to-day development workflow, see the [Developer guide](/developer-guide/introduction). For a quick first deployment, see the [Quick start](/getting-started/quick-start). For least-privilege IAM deployment roles, see [DEPLOYMENT_ROLES.md](/architecture/deployment-roles).

## Architecture overview

ABCA deploys as a **single CDK stack** (`backgroundagent-dev`) containing all platform resources. The stack uses a `ComputeStrategy` interface to support two compute backends within the same stack:

| Aspect | AgentCore (default) | ECS Fargate (opt-in) |
|--------|--------------------|--------------------|
| **Compute** | Bedrock AgentCore Runtime (Firecracker MicroVMs) | ECS Fargate containers |
| **Resources** | 2 vCPU, 8 GB RAM, 2 GB max image size | 2 vCPU, 4 GB RAM |
| **Orchestration** | Durable Lambda (checkpoint/replay) | Same durable Lambda via `ComputeStrategy` |
| **Agent mode** | FastAPI server (HTTP invocation) | Batch (run-to-completion) |
| **Startup** | ~10s (warm MicroVM) | ~60-180s (Fargate cold start) |
| **Max duration** | 8 hours (AgentCore service limit) | 9 hours (orchestrator `executionTimeout`) |

Both backends are orchestrated by the same durable Lambda function. The `ComputeStrategy` interface abstracts `startSession()`, `pollSession()`, and `stopSession()` -- the ECS strategy calls `ecs:RunTask` / `ecs:DescribeTasks` / `ecs:StopTask` directly from the Lambda. No Step Functions are used.

ECS Fargate is currently **opt-in** -- the `EcsAgentCluster` construct is present in the stack code but commented out. To enable it, uncomment the ECS blocks in `cdk/src/stacks/agent.ts`.

## Scale-to-zero analysis

### Components that scale to zero (pay-per-use)

| Component | Billing Model | Idle Cost |
|-----------|--------------|-----------|
| DynamoDB (6 tables) | PAY_PER_REQUEST | $0 |
| Lambda (all functions) | Per invocation | $0 |
| API Gateway REST | Per request | $0 |
| ECS Fargate tasks (when enabled) | Per running task | $0 (cluster is free) |
| AgentCore Runtime | Per session | $0 |
| Bedrock inference | Per token | $0 |
| AgentCore Memory | Proportional to usage | ~$0 |
| Cognito | Free tier (50K MAU) | $0 |

### Components that do not scale to zero (always-on)

| Component | Est. Monthly Idle Cost | Why |
|-----------|----------------------|-----|
| NAT Gateway (1x) | ~$32 | $0.045/hr fixed charge |
| VPC Interface Endpoints (7x, 2 AZs) | ~$102 | $0.01/hr × 7 endpoints × 2 AZs × 730 hrs |
| WAF v2 Web ACL | ~$5 | Base monthly charge |
| CloudWatch Dashboard | ~$3 | Per-dashboard charge |
| Secrets Manager (1+ secrets) | ~$0.40/secret | Per-secret monthly |
| CloudWatch Alarms | ~$0.10/alarm | Per standard alarm |
| CloudWatch Logs retention | ~$1-5 | Storage for retained logs |
| **Total always-on baseline** | **~$140-150/month** | |

The dominant idle cost is VPC networking: 7 interface endpoints across 2 AZs (~$102/month) plus the NAT Gateway (~$32/month).

For the full cost model including per-task costs, see [COST_MODEL.md](/architecture/cost-model).

## AWS services inventory

### Compute

| Service | Used By | Scales to Zero |
|---------|---------|---------------|
| Bedrock AgentCore Runtime (MicroVMs) | Agent sessions (default) | Yes |
| ECS Fargate (when enabled) | Agent sessions (opt-in) | Yes |
| Lambda (Node.js 24, ARM64) | Orchestrator, API handlers, fanout consumer, reconcilers, custom resources | Yes |

### AI/ML

| Service | Used By | Scales to Zero |
|---------|---------|---------------|
| Bedrock (Claude Sonnet 4.6, Opus 4, Haiku 4.5) | Agent reasoning, cross-region inference profiles | Yes |
| Bedrock Guardrails | Prompt injection detection on task input | Yes |
| Bedrock AgentCore Memory | Semantic + episodic extraction strategies | Yes |

### Networking

| Service | Used By | Scales to Zero |
|---------|---------|---------------|
| VPC (public + private subnets, 2 AZs) | All compute | N/A (no direct cost) |
| NAT Gateway (1x) | Private subnet internet egress | **No** (~$32/mo) |
| VPC Interface Endpoints (7x, 2 AZs) | AWS service connectivity from private subnets | **No** (~$102/mo) |
| VPC Gateway Endpoints (2x: S3, DynamoDB) | S3 and DynamoDB connectivity | Yes (free) |
| Security Groups | HTTPS-only egress | N/A |
| Route 53 Resolver DNS Firewall | Domain allowlisting for agent egress | Minimal |

### Storage / Database

| Service | Used By | Scales to Zero |
|---------|---------|---------------|
| DynamoDB (6 tables, PAY_PER_REQUEST) | Task state, events, nudges, concurrency, webhooks, repo config | Yes |
| DynamoDB Streams | TaskEventsTable → FanOut Consumer Lambda | Yes |
| S3 | CDK asset bucket, ECR image layers, FUSE session storage, trace artifacts (7-day lifecycle) | Minimal |
| SQS (DLQ) | FanOut Consumer dead-letter queue | Yes |
| Secrets Manager | GitHub PAT, webhook HMAC secrets | **No** (~$0.40/secret/mo) |

### API / Auth

| Service | Used By | Scales to Zero |
|---------|---------|---------------|
| API Gateway (REST) | Task REST API | Yes |
| Cognito User Pool | CLI/API authentication | Yes (free tier) |
| WAF v2 | API Gateway protection (managed rules + rate limiting) | **No** (~$5/mo base) |

### Scheduling

| Service | Used By | Scales to Zero |
|---------|---------|---------------|
| EventBridge (scheduled rule) | Stranded task reconciler (every 5 min) | Yes (rule is free; Lambda invocation is the cost) |

### Observability

| Service | Used By | Scales to Zero |
|---------|---------|---------------|
| CloudWatch Logs (multiple log groups) | Application, usage, model invocation, VPC flow, DNS query logs | **No** (storage) |
| CloudWatch Dashboard | Operational metrics visualization | **No** (~$3/mo) |
| CloudWatch Alarms | Orchestrator error alerting | **No** (~$0.10/alarm) |
| X-Ray | AgentCore Runtime tracing | Yes |

### Infrastructure / Deployment

| Service | Used By | Scales to Zero |
|---------|---------|---------------|
| CloudFormation | Stack deployment, custom resources | N/A |
| ECR | Container image storage | Minimal |
| IAM | Roles and policies for all components | N/A |

## Reference

## CI/CD pipeline (`deploy.yml`)

The repository includes a two-stage CI/CD pipeline:

### Stage 1: Build (`build.yml`)

Triggers on every PR and push to main. Runs `mise run build` (compile, test, lint, synth) and uploads the synthesized `cdk.out/` as a `deploy-intent` artifact. The intent file declares whether a deploy should happen and for which compute types.

### Stage 2: Deploy (`deploy.yml`)

Triggers via `workflow_run` when `build.yml` completes successfully. The pipeline:

1. **Skips fork PRs** — `head_repository.full_name == github.repository` prevents forks from entering the deploy flow. This is a security measure: an untrusted fork could modify `build.yml` to produce a deploy-intent artifact, which would otherwise prompt maintainers for approval unnecessarily.
2. **Downloads `deploy-intent.json`** from the triggering build run.
3. **Resolves targets** — Determines which compute types to deploy:
   - `intent: "-"` → no-op (most PRs)
   - `intent: "labels"` → reads PR labels against an allowlist
   - `intent: "<type>"` → deploys the specified type (e.g., `agentcore`)
4. **Requires approval** — The `deploy` job uses a GitHub Environment with required reviewers. Approvals are logged and the self-review rule prevents unilateral deploys.
5. **Deploys via OIDC** — Assumes an IAM role via GitHub OIDC federation (no long-lived credentials). The role is scoped to the `cdk deploy` action with least-privilege policies per [DEPLOYMENT_ROLES.md](/architecture/deployment-roles).

### Security controls

| Control | Purpose |
|---------|---------|
| Fork exclusion (`head_repository` check) | Prevents fork PRs from triggering deploy approval prompts |
| Environment approval | Human gate before any deploy reaches AWS |
| OIDC federation | No stored AWS credentials; tokens are request-scoped |
| Compute type allowlist | Only pre-approved types can be deployed |
| Non-cancellable concurrency | Deploy can't be interrupted mid-flight |

### For administrators

- **Enable deploys**: Set the `deploy` Environment in repo settings with required reviewers.
- **Configure OIDC**: Set `AWS_ROLE_TO_ASSUME` secret and `AWS_REGION` variable.
- **Allowlist compute types**: Edit `ALLOWED_COMPUTE_TYPES` in `deploy.yml`.
- **Deploy via PR label**: Add the `deploy:<type>` label to a PR (e.g., `deploy:agentcore`).

## Related docs

- [Quick start](/getting-started/quick-start) -- Zero-to-first-PR in 6 steps.
- [Developer guide](/developer-guide/introduction) -- Local development, testing, repository onboarding.
- [User guide](/using/overview) -- API reference, CLI usage, task management.
- [DEPLOYMENT_ROLES.md](/architecture/deployment-roles) -- Least-privilege IAM policies for CloudFormation execution.
- [COST_MODEL.md](/architecture/cost-model) -- Per-task costs, cost guardrails, cost at scale.
- [COMPUTE.md](/architecture/compute) -- Compute backend architecture and trade-offs.
