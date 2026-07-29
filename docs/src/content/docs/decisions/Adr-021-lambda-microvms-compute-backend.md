---
title: Adr 021 lambda microvms compute backend
---

# ADR-021: AWS Lambda MicroVMs as a third ComputeStrategy backend

> Number: candidate ADR-021 (ADR-020 is the highest accepted on `main`; ADR-018 is claimed by open PR [#548](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/548), ADR-019 by open PR [#663](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/663)). Numbers are never reused. If a lower number frees before merge, renumber and coordinate with those PRs.

**Status:** proposed
**Date:** 2026-07-29

## Context

ABCA selects a per-repo compute backend through the Blueprint's `compute_type` field (`cdk/src/handlers/shared/repo-config.ts`). Two backends exist today, resolved by `resolveComputeStrategy` (`cdk/src/handlers/shared/compute-strategy.ts`) behind a uniform `ComputeStrategy` interface (`startSession` / `pollSession` / `stopSession`):

- **AgentCore Runtime** (`agentcore`, default) — managed Firecracker MicroVM per session. Invoked via `InvokeAgentRuntime`; liveness is inferred from agent heartbeats in DynamoDB plus the FastAPI `/ping` endpoint (`agent/src/server.py`) — the strategy's `pollSession` is a stub that always reports `running`. Constraints: 2 GB image limit, no substrate-level suspend API exposed to the orchestrator.
- **ECS on Fargate** (`ecs`) — always-on Fargate task (16 vCPU / 120 GB, ARM64) for repos that exceed AgentCore's limits ([#596](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/596)). Invoked via `RunTask` in batch mode (bypassing the HTTP server); liveness via `DescribeTasks`. No suspend — an idle task blocked on an approval wait burns full compute the whole time.

**AWS Lambda MicroVMs** (launched 2026-06-22) is a serverless Firecracker sandbox primitive that AWS positions explicitly for AI coding agents: VM-level isolation, snapshot-based near-instant launch, **suspend/resume with full memory + disk state preserved** (compute charges stop while suspended), a dedicated JWE-authenticated HTTPS endpoint per instance, lifecycle hooks (`/run`, `/suspend`, `/resume`, `/terminate`), and up to 8 hours per session. It is **not** classic Lambda: the 15-minute function cap does not apply, and [COMPUTE.md](/sample-autonomous-cloud-coding-agents/architecture/compute)'s "Lambda: poor fit" verdict refers to functions, not MicroVMs.

[#645](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/645) proposes adding Lambda MicroVMs as a third `ComputeStrategy`. The fit is strong but not free — pre-implementation review of the service's lifecycle model surfaced real design tensions this ADR resolves:

### Capability comparison (delta rows only — full matrix in COMPUTE.md)

| | AgentCore Runtime | ECS on Fargate | **Lambda MicroVMs** |
|---|---|---|---|
| Isolation | MicroVM (managed) | Task-level (Firecracker) | MicroVM (Firecracker) |
| Max duration | 8 h | No cap | 8 h (running + suspended) |
| Suspend/resume | No orchestrator-visible API | No | **Yes** — explicit API + idle policy, state preserved, no compute charge while suspended |
| Resources | AgentCore-managed | 16 vCPU / 120 GB / 20–200 GB disk | **16 vCPU / 32 GB RAM / 32 GB disk (hard ceiling)** |
| Packaging | ECR image ≤ 2 GB | ECR image, no hard cap | **Zip + Dockerfile in S3 → service-built snapshot image** (versioned, storage billed) |
| Invocation | `InvokeAgentRuntime` (SigV4) | `RunTask` + container overrides | `RunMicrovm` → dedicated HTTPS endpoint + JWE token (`CreateMicrovmAuthToken`, ≤ 60 min TTL) |
| Liveness | Agent heartbeat + `/ping` | `DescribeTasks` | MicroVM state (RUNNING / SUSPENDED / TERMINATED) via control-plane API |
| Session storage | `/mnt/workspace` FUSE (no `flock()`) | Ephemeral disk | Native disk in snapshot — **survives suspend/resume, `flock()` works** |
| Architecture | ARM64 | ARM64 | ARM64 (Graviton) |
| Regions (launch) | Broad | Broad | 5 (us-east-1/2, us-west-2, eu-west-1, ap-northeast-1) |

### Design tensions the strategy must resolve

1. **Idle detection is inbound-traffic-based; the ABCA agent is outbound-only.** MicroVM idle policies suspend when no traffic arrives at the *endpoint*. A busy agent running a 40-minute build receives no inbound traffic and would be suspended mid-work by a naive idle policy. Conversely, "no inbound traffic" is the agent's *normal* state.
2. **No self-suspend.** The agent cannot suspend its own MicroVM from inside; only an external `SuspendMicrovm` call can. Suspend decisions must be owned by the orchestrator — which aligns with the unified liveness model proposed in [#491](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/491).
3. **Snapshots bake state.** The image snapshot is captured once at build time; every MicroVM resumes from it. Secrets, tokens, and per-task identity must arrive at run time (`runHookPayload`, ≤ 16 KB, or fetched in the `/run` hook), never at image build. CSPRNGs must be reseeded on `/run` and `/resume`.
4. **Auth tokens are short-lived.** JWE tokens max out at 60 minutes; any orchestrator→agent HTTP interaction over the endpoint needs token refresh, unlike AgentCore's SigV4 invoke or ECS's no-endpoint model.
5. **Identity delta — narrower than it looks.** Most AgentCore services ABCA uses are standalone and substrate-portable: Memory is already consumed from ECS via an IAM grant plus `MEMORY_ID` (`EcsAgentCluster`), and Gateway (ADR-019) is portable by design (SigV4 inbound). The genuinely Runtime-coupled piece is the workload-access-token **delivery mechanism** (`runtimeUserId` → `WorkloadAccessToken` request header → `BedrockAgentCoreContext`, used by `resolve_linear_api_token()`), which has no MicroVM equivalent. The ECS backend already lives with this delta (env-var token delivery); MicroVMs inherit the same posture until the pluggable identity work ([#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249), ADR-016) redesigns the seam.

## Decision

Adopt **AWS Lambda MicroVMs as a third, opt-in `ComputeStrategy` backend** named `lambda-microvm`, selected per repo via Blueprint `compute_type`. AgentCore remains the default. Five sub-decisions:

### 1. Strategy shape: extend the interface with mandatory suspend/resume

`ComputeType` widens to `'agentcore' | 'ecs' | 'lambda-microvm'` (mirrored in `cli/src/types.ts` and the CLI's inline unions). `SessionHandle` gains a `{ strategyType: 'lambda-microvm', microvmId, endpoint }` variant — `microvmId` because every lifecycle API (`suspend-microvm`, `resume-microvm`, `terminate-microvm`, `create-microvm-auth-token`) takes only the MicroVM identifier, and `endpoint` because it is per-session (minted by `RunMicrovm`) and required for any orchestrator→agent HTTP interaction. The image ARN is deliberately **not** in the handle: like the ECS task definition ARN, it is deployment-time configuration consumed by `startSession` (from construct-injected environment) and recorded in the session-start log entry for diagnostics, not per-session lifecycle state.

The `ComputeStrategy` interface gains **mandatory** `suspendSession(handle)` / `resumeSession(handle)` methods returning a typed result (`{ supported: false } | { supported: true }`-shaped, exact type at implementation time); the widening lands in P3 (see sub-decision 5), in one commit across all three strategies. Mandatory-with-explicit-stub is the codebase idiom, not optional methods: no behavioral interface in the codebase has an optional method, `AgentCoreComputeStrategy.pollSession` is already a mandatory explicit stub rather than an optional member, and the exhaustive-`never` switch culture means a fourth backend must make a compile-checked decision about its suspend semantics instead of silently falling through a `strategy.suspendSession?.()` feature-detection. The agentcore and ecs strategies return `unsupported` (not a silent success — a suspend that silently no-ops would let the orchestrator believe compute billing stopped when it did not); the orchestrator gates its suspend policy on the typed response, consistent with how `pollTaskStatus` already branches explicitly on `computeType`. `pollSession` maps MicroVM control-plane state: `RUNNING`/`SUSPENDED` → `running`, `TERMINATED` without a terminal DynamoDB status → `failed` (same crash-detection pattern the ECS backend uses in `finalPollState`).

Normative requirements (EARS, per [ADR-020](/sample-autonomous-cloud-coding-agents/architecture/adr-020-ears-requirements-syntax)):

- When a task's Blueprint sets `compute_type: 'lambda-microvm'`, the orchestrator shall resolve the `LambdaMicrovmComputeStrategy` via `resolveComputeStrategy`.
- When `startSession` is invoked, the strategy shall call `RunMicrovm` with an explicit `maximumDurationInSeconds` derived from the task budget and shall deliver per-task parameters via `runHookPayload` (inline) or an S3 pointer when the payload exceeds 16 KB.
- If the MicroVM control-plane state is `TERMINATED` while the task's DynamoDB status is non-terminal, then the orchestrator shall classify the task as failed with a substrate-failure remedy.
- The strategy shall configure the MicroVM idle policy with auto-suspend **disabled**; suspend decisions shall be made only by the orchestrator via `suspendSession`.
- If `suspendSession` or `resumeSession` is invoked on a strategy that does not support suspension, then the strategy shall return an explicit unsupported result and shall not report success.
- If the agent process inside the MicroVM reaches a terminal state, then the agent shall exit and the orchestrator shall call `terminate-microvm` during finalization (termination shall not rely on idle timeout).

### 2. Lifecycle: orchestrator-owned suspend/resume around approval waits

The headline economic win is suspend during **HITL approval waits** (Cedar approval gates, [CEDAR_HITL_GATES.md](/sample-autonomous-cloud-coding-agents/architecture/cedar-hitl-gates)): when a task blocks on an approval, the orchestrator suspends the MicroVM (compute charges stop, memory/disk state — including the cloned repo and warm build caches — is preserved); on approval it resumes and the agent continues in place. This is impossible on both existing backends. The agent's `/suspend` hook flushes progress events; `/resume` reseeds CSPRNGs and refreshes any cached credentials.

- While a task is waiting on a HITL approval and the backend is `lambda-microvm`, the orchestrator shall call `suspendSession` after a configurable grace period.
- When the approval resolves, the orchestrator shall call `resumeSession` before delivering the approval outcome.

### 3. Packaging: same agent image source, new build path

The existing agent container (`agent/` Dockerfile, already ARM64) is repackaged as a zip + Dockerfile artifact in S3 and built into a versioned `MicrovmImage` via `CreateMicrovmImage` (with `/ready` and `/validate` build hooks for snapshot quality). The agent runs its existing FastAPI server (`agent/src/server.py`) — the MicroVM path uses the HTTP entrypoint like AgentCore, not ECS's batch bypass — plus the four runtime lifecycle hooks on a sidecar port. Task payload delivery reuses the ECS strategy's S3-pointer pattern. **Constraint accepted:** 32 GB RAM / 32 GB disk means repos that motivated the 120 GB ECS sizing stay on `ecs`; MicroVMs target the default-sized workload with suspend economics, not the heavy-build niche.

- The image build shall not embed secrets, tokens, or per-task identity in the snapshot; the agent shall resolve credentials at `/run` time.

### 4. Infra and IAM: conditional resources behind bootstrap `ComputeTypes`

Mirroring the ECS pattern: a `compute-lambda-microvm` bootstrap policy (`cdk/src/bootstrap/policies/`) gated on the `ComputeTypes` CFN parameter; a CDK construct provisioning the build role, execution role (admitted to the per-session role via `AgentSessionRole.admitComputeRole`, which was designed for exactly this), the S3 artifact bucket wiring, and image build automation. Egress uses the platform VPC via an egress network connector so the DNS Firewall / security-group / flow-log stack in [COMPUTE.md](/sample-autonomous-cloud-coding-agents/architecture/compute) applies unchanged; ingress is restricted to the JWE-authenticated endpoint (no `SHELL_INGRESS` by default — it is noted as a candidate for [#391](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/391), operator session access, as a separate decision).

- Where the bootstrap `ComputeTypes` parameter includes `lambda-microvm`, the generated template shall attach the `IaCRole-ABCA-Compute-LambdaMicrovms` policy to the CloudFormation execution role.
- The orchestrator role shall receive only the MicroVM lifecycle actions it calls (`lambda:RunMicrovm`, `lambda:SuspendMicrovm`, `lambda:ResumeMicrovm`, `lambda:TerminateMicrovm`, `lambda:CreateMicrovmAuthToken`, read/describe), scoped to platform-created images.

#### Regional availability enforcement

Lambda MicroVMs launched in 5 regions (us-east-1/2, us-west-2, eu-west-1, ap-northeast-1) and will expand. ABCA is a single-region deployment, so the constraint is binary per stack: either the stack region supports the backend or the backend does not exist there. Enforcement is layered — one static check where offline determinism is required, live probes everywhere else so the platform self-heals as AWS adds regions (`list-managed-microvm-images` is the documented read-only availability probe):

| Stage | Mechanism | Check |
|---|---|---|
| CDK synth/deploy | Static region constant (single exported list, documented update path) | Synth fails when `ComputeTypes` includes `lambda-microvm` in an unlisted region; context-flag escape hatch for newly launched regions ahead of the constant update |
| Repo onboarding | Live probe from the CLI | `bgagent repo onboard --compute-type lambda-microvm` calls `list-managed-microvm-images` in the stack region and rejects with a remedy (supported-region list + suggest `agentcore`/`ecs`) |
| `bgagent platform doctor` | Live probe (precedent: `checkBedrockModel`) | Reports backend availability for the stack region whenever any active blueprint selects `lambda-microvm` |
| Orchestration (defense in depth) | Error classification | `startSession` failures from a missing regional endpoint classify to a typed remedy in `error-classifier.ts`, never a cryptic SDK error on the task |

- If an operator onboards a repo with `compute_type: 'lambda-microvm'` and the availability probe fails for the stack region, then the CLI shall reject the onboarding with the supported-region list and alternative backends as the remedy.
- If `startSession` fails because the MicroVM service is unavailable in the stack region, then the orchestrator shall classify the failure with a configuration remedy and shall not retry.
- When the platform doctor runs in a deployment where any active blueprint selects `lambda-microvm`, the doctor shall probe MicroVM availability in the stack region and report the result.

### 5. Rollout: phased, default unchanged

- **P1 — strategy + infra:** `LambdaMicrovmComputeStrategy` (start/poll/stop), CDK construct, bootstrap policy, types sync, unit + CDK assertion tests. No suspend yet.
- **P2 — smoke parity:** agent completes clone → change → PR on the backend with progress visible to `bgagent watch`; failure classification entries in `error-classifier.ts`; **AgentCore Memory parity** (IAM grant + `MEMORY_ID` delivery, following the `EcsAgentCluster` pattern — Memory is a standalone service already consumed cross-substrate, and omitting the grant silently no-ops cross-session learning).
- **P3 — suspend/resume:** the interface widening from sub-decision 1 (mandatory methods, all three strategies in one commit), HITL-wait suspend policy, resume-on-approval; coordinate with [#491](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/491)'s unified liveness model.
- **Out of scope:** replacing AgentCore as default; classic Lambda functions as a runtime; GPU; the Runtime-coupled workload-access-token injection path (delivery mechanism exists only on AgentCore Runtime; MicroVMs adopt the ECS env-var posture until [#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249)/ADR-016 redesign the seam). Gateway integration is orthogonal: ADR-019/[#641](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/641) is substrate-portable by design and applies to this backend when it lands.

## Consequences

- (+) **Suspend/resume economics.** Tasks idling on approvals or long waits stop billing compute while preserving full state — the first backend where a blocked task costs snapshot storage instead of vCPU-hours.
- (+) **VM-level isolation without cluster ops.** Firecracker isolation with no ECS cluster, task definition, or capacity management; one-session-per-MicroVM maps 1:1 onto ABCA's task model.
- (+) **Escapes AgentCore's 2 GB image limit and FUSE `flock()` workaround** — native disk in the snapshot supports `uv`/`mise` without the split-storage scheme.
- (+) **Liveness becomes explicit.** Unlike AgentCore's stub `pollSession`, the strategy can report real substrate state, strengthening the [#491](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/491) unification.
- (−) **32 GB RAM / 32 GB disk hard ceiling** — not a successor to the ECS backend for heavy CI-parity builds; the platform now maintains three backends.
- (−) **New packaging pipeline.** Zip + Dockerfile + service-side image builds with versioned snapshots (storage billed per version) alongside the existing ECR flow; image versions need lifecycle cleanup.
- (−) **8-hour hard cap includes suspended time** — a task suspended across a weekend approval wait is terminated; the orchestrator must checkpoint-and-restart (push branch, new session) beyond the cap.
- (!) **Idle-policy foot-gun.** Traffic-based auto-suspend would freeze a busy outbound-only agent; the decision to disable auto-suspend must be enforced in code and covered by tests, not left to configuration discipline.
- (!) **Snapshot uniqueness.** Shared memory snapshots require CSPRNG reseeding and credential refresh in `/run` / `/resume` hooks; missing this is a silent security defect.
- (!) **Regional availability (5 regions at launch, expanding)** — enforced in layers (synth-time static check, onboarding + doctor live probes, orchestration-time classification; see sub-decision 4). The static CDK constant is the one piece that rots as AWS expands; its update path and context-flag escape hatch are deliberate.
- (!) **Workload-token injection delta persists** (shared with the ECS backend) until [#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249)/ADR-016 land; document it in the security bar comparison rather than blocking on it. Memory and Gateway are explicitly *not* deltas — both are standalone services consumed via IAM from any substrate.

## Testing

- Unit tests for the strategy: start/poll/stop/suspend/resume mapping, payload-size branching (inline vs S3 pointer), error classification (`ServiceQuotaExceededException`, `ThrottlingException`, `ResourceNotFoundException`, regional-unavailability), and the disabled-auto-suspend invariant.
- CDK assertions: MicroVM resources present only when `ComputeTypes` includes the backend; synth failure for unsupported regions (plus the context-flag escape hatch); IAM actions scoped as specified; types-sync check covers the widened `ComputeType`.
- CLI tests: onboarding rejection with remedy when the availability probe fails; doctor check present when a blueprint selects the backend.
- Smoke (gated like the ECS backend): clone → change → PR with `bgagent watch` progress; suspend/resume across a simulated approval wait preserving workspace state.
- Docs sync for [COMPUTE.md](/sample-autonomous-cloud-coding-agents/architecture/compute) (new column distinguishing MicroVMs from classic Lambda) and [ORCHESTRATOR.md](/sample-autonomous-cloud-coding-agents/architecture/orchestrator) (liveness + suspend lifecycle).

## References

- Issue [#645](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/645) — originating RFC proposal
- Issue [#491](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/491) — unified liveness decision model (soft dependency, P3)
- Issue [#641](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/641) / ADR-019 (PR [#663](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/663)) — substrate-portable tool plane
- PR [#596](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/596) — ECS Fargate backend (pattern source for conditional wiring)
- [AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html) — developer guide; [Running and using MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html) — lifecycle APIs and hooks
- [Agent Toolkit for AWS — aws-lambda-microvms skill](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/specialized-skills/serverless-skills/aws-lambda-microvms/SKILL.md) — operational constraints (no self-suspend, idle-policy semantics, snapshot uniqueness, size limits)
- [ADR-020](/sample-autonomous-cloud-coding-agents/architecture/adr-020-ears-requirements-syntax) — EARS syntax used for the normative requirements above
- [COMPUTE.md](/sample-autonomous-cloud-coding-agents/architecture/compute), [ORCHESTRATOR.md](/sample-autonomous-cloud-coding-agents/architecture/orchestrator) — design docs to be updated by the implementing PRs
