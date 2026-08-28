---
title: Deployment guide
---

# Deployment guide

This guide covers deploying ABCA into an AWS account, including compute backend choices, scale-to-zero characteristics, and the complete AWS service inventory. For day-to-day development workflow, see the [Developer guide](/sample-autonomous-cloud-coding-agents/developer-guide/introduction). For a quick first deployment, see the [Quick start](./QUICK_START.mdx). For least-privilege IAM deployment roles, see [DEPLOYMENT_ROLES.md](/sample-autonomous-cloud-coding-agents/architecture/deployment-roles).

## Architecture overview

ABCA deploys as a **single CDK stack** (`backgroundagent-dev`) containing all platform resources. The stack uses a `ComputeStrategy` interface to support three compute backends within the same stack:

| Aspect | AgentCore (default) | ECS Fargate (opt-in) | Lambda MicroVMs (experimental) |
|--------|--------------------|--------------------|--------------------|
| **Compute** | Bedrock AgentCore Runtime (Firecracker MicroVMs) | ECS Fargate containers | AWS Lambda MicroVMs |
| **Resources** | 2 vCPU, 8 GB RAM, 2 GB max image size | 2 vCPU, 4 GB RAM | 8 GB baseline / 32 GB peak memory |
| **Orchestration** | Durable Lambda (checkpoint/replay) | Same durable Lambda via `ComputeStrategy` | Same durable Lambda via `ComputeStrategy` |
| **Agent mode** | FastAPI server (HTTP invocation) | Batch (run-to-completion) | FastAPI server (lifecycle hooks) |
| **Startup** | ~10s (warm MicroVM) | ~60-180s (Fargate cold start) | ~6s to `RUNNING` (live-measured) |
| **Max duration** | 8 hours (AgentCore service limit) | 9 hours (orchestrator `executionTimeout`) | 8 hours (`maximumDurationInSeconds`) |

All backends are orchestrated by the same durable Lambda function. The `ComputeStrategy` interface abstracts `startSession()`, `pollSession()`, and `stopSession()` -- the ECS strategy calls `ecs:RunTask` / `ecs:DescribeTasks` / `ecs:StopTask` directly from the Lambda. No Step Functions are used.

ECS Fargate is currently **opt-in** -- the `EcsAgentCluster` construct is present in the stack code but commented out. To enable it, uncomment the ECS blocks in `cdk/src/stacks/agent.ts`.

### Lambda MicroVMs backend (experimental)

> **Not for production.** `lambda-microvm` carries no smoke-parity guarantee for an unattended deployment. Keep production repositories on `agentcore` or `ecs`. Synth emits an unsuppressible warning to this effect whenever the backend is selected. Design detail: [COMPUTE.md](/sample-autonomous-cloud-coding-agents/architecture/compute) and [ADR-021](/sample-autonomous-cloud-coding-agents/architecture/adr-021-lambda-microvms-compute-backend).

Selecting it is a synth-time context flag:

```bash
mise //cdk:deploy -- --context compute_type=lambda-microvm
```

**You must re-bootstrap first.** This is the single most common way this backend fails, and the failure does not look like a configuration problem:

1. Check the bootstrap policy bundle already deployed in the account:

   ```bash
   aws cloudformation describe-stacks --stack-name CDKToolkit \
     --query "Stacks[0].Outputs[?OutputKey=='BootstrapPolicyVersion'].OutputValue | [0]" --output text
   ```

2. If it is **below 1.4.0**, re-bootstrap with the backend included in `ComputeTypes`. `cdk bootstrap` cannot pass template parameters, so the parameter goes on the `CDKToolkit` stack directly:

   ```bash
   aws cloudformation deploy \
     --template-file cdk/bootstrap/bootstrap-template.yaml \
     --stack-name CDKToolkit --capabilities CAPABILITY_NAMED_IAM \
     --parameters ParameterKey=ComputeTypes,ParameterValue=agentcore\,lambda-microvm
   ```

   Bundle 1.4.0 adds the `MicrovmPassRoles` statement, without which the CDK-managed MicroVM image deploy fails with an `iam:PassRole` **AccessDenied on the build role** -- an IAM error that reads like a code bug. Rationale and the live evidence for the missing `iam:PassedToService` condition: [DEPLOYMENT_ROLES.md](/sample-autonomous-cloud-coding-agents/architecture/deployment-roles#iacrole-abca-compute-lambdamicrovms).

3. Regional availability is limited (5 Regions at launch). Synth fails fast with the supported list if the stack's Region is not among them; `bgagent doctor` probes it live.

Operational notes specific to this backend:

- **Nothing self-terminates.** A MicroVM whose task finished, crashed, or hung stays `RUNNING` and billing until the 8-hour cap. The orchestrator calls `TerminateMicrovm` on finalize, and the heartbeat-staleness check catches a hung guest inside a healthy VM -- but a leaked handle is a cost incident. The one exception: the service reaps a VM whose `/run` hook returns 4xx (~12s).
- **Logs** land in `/aws/lambda-microvms/<image-name>`. Guest stdout goes there too, which is the fallback path when the agent cannot reach the application log group.
- **Deployment identifiers are not baked into the image.** The snapshot carries no configuration; table names, secret ARNs, and the per-task session-role ARN arrive in the `/run` payload as a `platform_config` block. A version-skewed orchestrator that does not send it is refused rather than run with tenant scoping disabled.

## Scale-to-zero analysis

### Components that scale to zero (pay-per-use)

| Component | Billing Model | Idle Cost |
|-----------|--------------|-----------|
| DynamoDB (7 core tables; integrations add more) | PAY_PER_REQUEST | $0 |
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

For the full cost model including per-task costs, see [COST_MODEL.md](/sample-autonomous-cloud-coding-agents/architecture/cost-model).

## AWS services inventory

### Compute

| Service | Used By | Scales to Zero |
|---------|---------|---------------|
| Bedrock AgentCore Runtime (MicroVMs) | Agent sessions (default) | Yes |
| ECS Fargate (when enabled) | Agent sessions (opt-in) | Yes |
| AWS Lambda MicroVMs (when enabled) | Agent sessions (experimental, `--context compute_type=lambda-microvm`) | Yes |
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
| DynamoDB (7 core tables, PAY_PER_REQUEST) | Task state, events, nudges, concurrency, webhooks, repo config, approvals. Enabling the Slack integration adds 2 tables (installation, user-mapping) and Linear adds 4 (project-mapping, user-mapping, workspace-registry, webhook-dedup) | Yes |
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
5. **Deploys via OIDC** — Assumes an IAM role via GitHub OIDC federation (no long-lived credentials). The role is scoped to the `cdk deploy` action with least-privilege policies per [DEPLOYMENT_ROLES.md](/sample-autonomous-cloud-coding-agents/architecture/deployment-roles).

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

## Known deployment issues

### DNS Query Log Config replacement cascade (upgrading from pre-v0.5)

**Affects:** Stacks deployed *before* the tag-exclusion fix ([#222](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/222)). Stacks created after this fix are not affected.

**Symptom:** `UPDATE_FAILED` on `AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation` with error `InvalidRequest: Cannot create association — one already exists for this VPC`.

**Root cause:** The `ResolverQueryLoggingConfig` resource is *create-only* in CloudFormation — any property change (including Tags) triggers a full replacement. Pre-fix stacks have `github:sha` and other tags on this resource. Although the new code excludes it from future tag applications, CloudFormation still attempts to *remove* the now-excluded tags from the existing resource during the update, triggering the replacement cascade:

1. Config is replaced → new physical resource ID
2. Association detects `ResolverQueryLogConfigId` changed → triggers its own replacement
3. CloudFormation attempts Create-before-Delete on the association → Route53 Resolver rejects (one association per VPC) → `InvalidRequest`

**Resolution — choose one:**

#### Option A: AWS CLI disassociation (recommended)

Fastest, scriptable, no console access required. Replace `<vpc-id>` with the agent VPC ID and `<region>` with your stack's region.

1. List the association for your VPC to get the `ResolverQueryLogConfigId`:
   ```bash
   aws route53resolver list-resolver-query-log-config-associations \
     --region <region> \
     --query "ResolverQueryLogConfigAssociations[?ResourceId=='<vpc-id>']"
   ```
2. Disassociate using the `Id` from step 1:
   ```bash
   aws route53resolver disassociate-resolver-query-log-config \
     --resolver-query-log-config-id <rqlc-id> \
     --resource-id <vpc-id> \
     --region <region>
   ```
3. Run `mise //cdk:deploy` — CloudFormation recreates both the config and association without the orphan tags. The pre-existing `ResolverQueryLoggingConfig` is replaced as part of the same update, so an explicit `delete-resolver-query-log-config` is not required.

#### Option B: Two-phase deploy (comment-out / re-add)

1. In `cdk/src/stacks/agent.ts`, comment out the `DnsFirewall` construct instantiation (~line 197):
   ```typescript
   // new DnsFirewall(this, 'DnsFirewall', {
   //   vpc: agentVpc.vpc,
   //   additionalAllowedDomains: additionalDomains,
   //   observationMode: true,
   // });
   ```
2. Deploy: `mise //cdk:deploy` — this deletes the query log config, association, firewall rules, and related resources
3. Uncomment the `DnsFirewall` block
4. Deploy again: `mise //cdk:deploy` — resources are recreated cleanly without tags

Option B is more disruptive (two deploys, brief DNS logging gap) but requires no AWS API access beyond `cdk deploy`.

#### Option C: Manual disassociation via AWS Console

For users without AWS CLI access.

1. Open the [Route 53 Resolver console](https://console.aws.amazon.com/route53resolver/home#/query-logging)
2. Select the query logging configuration named `agent-dns-query-log`
3. Under **Associated VPCs**, disassociate the VPC
4. Delete the query logging configuration
5. Run `mise //cdk:deploy` (or `cdk deploy`) — CloudFormation will recreate both resources without tags

## Related docs

- [Quick start](./QUICK_START.mdx) -- Zero-to-first-PR in 6 steps.
- [Developer guide](/sample-autonomous-cloud-coding-agents/developer-guide/introduction) -- Local development, testing, repository onboarding.
- [User guide](/sample-autonomous-cloud-coding-agents/using/overview) -- API reference, CLI usage, task management.
- [DEPLOYMENT_ROLES.md](/sample-autonomous-cloud-coding-agents/architecture/deployment-roles) -- Least-privilege IAM policies for CloudFormation execution.
- [COST_MODEL.md](/sample-autonomous-cloud-coding-agents/architecture/cost-model) -- Per-task costs, cost guardrails, cost at scale.
- [COST_ATTRIBUTION.md](/sample-autonomous-cloud-coding-agents/architecture/cost-attribution) -- Operator FinOps setup for per-user/per-repo Bedrock chargeback (Cost Explorer / CUR 2.0, invocation-log forensics).
- [COMPUTE.md](/sample-autonomous-cloud-coding-agents/architecture/compute) -- Compute backend architecture and trade-offs.
- [ADR-021](/sample-autonomous-cloud-coding-agents/architecture/adr-021-lambda-microvms-compute-backend) -- Lambda MicroVMs backend decision, phased rollout, and live-verification evidence.
