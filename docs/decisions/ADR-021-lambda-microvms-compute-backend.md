# ADR-021: AWS Lambda MicroVMs as a third ComputeStrategy backend

> Number: candidate ADR-021 (ADR-020 is the highest accepted on `main`; ADR-018 is claimed by open PR [#548](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/548), ADR-019 by open PR [#663](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/663)). Numbers are never reused. If a lower number frees before merge, renumber and coordinate with those PRs.

**Status:** proposed
**Date:** 2026-07-29

## Context

ABCA selects a per-repo compute backend through the Blueprint's `compute_type` field (`cdk/src/handlers/shared/repo-config.ts`). Two backends exist today, resolved by `resolveComputeStrategy` (`cdk/src/handlers/shared/compute-strategy.ts`) behind a uniform `ComputeStrategy` interface (`startSession` / `pollSession` / `stopSession`):

- **AgentCore Runtime** (`agentcore`, default) — managed Firecracker MicroVM per session. Invoked via `InvokeAgentRuntime`; liveness is inferred from agent heartbeats in DynamoDB plus the FastAPI `/ping` endpoint (`agent/src/server.py`) — the strategy's `pollSession` is a stub that always reports `running`. Constraints: 2 GB image limit, no substrate-level suspend API exposed to the orchestrator.
- **ECS on Fargate** (`ecs`) — always-on Fargate task (16 vCPU / 120 GB, ARM64) for repos that exceed AgentCore's limits ([#596](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/596)). Invoked via `RunTask` in batch mode (bypassing the HTTP server); liveness via `DescribeTasks`. No suspend — an idle task blocked on an approval wait burns full compute the whole time.

**AWS Lambda MicroVMs** (launched 2026-06-22) is a serverless Firecracker sandbox primitive that AWS positions explicitly for AI coding agents: VM-level isolation, snapshot-based near-instant launch, **suspend/resume with full memory + disk state preserved** (compute charges stop while suspended), a dedicated JWE-authenticated HTTPS endpoint per instance, lifecycle hooks (`/run`, `/suspend`, `/resume`, `/terminate`), and up to 8 hours per session. It is **not** classic Lambda: the 15-minute function cap does not apply, and [COMPUTE.md](../design/COMPUTE.md)'s "Lambda: poor fit" verdict refers to functions, not MicroVMs.

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

> Service facts in the Lambda MicroVMs column (APIs, limits, quota semantics, regions) are externally sourced from the AWS developer guide and the Agent Toolkit skill (see References) and cannot be corroborated from this repository; P1 re-verifies the load-bearing ones empirically (see Testing).

### Design tensions the strategy must resolve

1. **Idle detection is inbound-traffic-based; the ABCA agent is outbound-only.** MicroVM idle policies suspend when no traffic arrives at the *endpoint*. A busy agent running a 40-minute build receives no inbound traffic and would be suspended mid-work by a naive idle policy. Conversely, "no inbound traffic" is the agent's *normal* state.
2. **No self-suspend.** The agent cannot suspend its own MicroVM from inside; only an external `SuspendMicrovm` call can. Suspend decisions must be owned by the orchestrator — which aligns with the unified liveness model proposed in [#491](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/491).
3. **Snapshots bake state.** The image snapshot is captured once at build time; every MicroVM resumes from it. Secrets, tokens, and per-task identity must arrive at run time (`runHookPayload`, ≤ 16 KB, or fetched in the `/run` hook), never at image build. CSPRNGs must be reseeded on `/run` and `/resume`.
4. **Auth tokens are short-lived.** JWE tokens max out at 60 minutes; any orchestrator→agent HTTP interaction over the endpoint needs token refresh, unlike AgentCore's SigV4 invoke or ECS's no-endpoint model.
5. **Identity delta — narrower than it looks.** Most AgentCore services ABCA uses are standalone and substrate-portable: Memory is already consumed from ECS via an IAM grant plus `MEMORY_ID` (`EcsAgentCluster`), and Gateway (ADR-019) is portable by design (SigV4 inbound). The genuinely Runtime-coupled piece is the workload-access-token **delivery mechanism** (`runtimeUserId` → `WorkloadAccessToken` request header → `BedrockAgentCoreContext`, used by `resolve_linear_api_token()`), which has no MicroVM equivalent. The ECS backend already lives with this delta (env-var token delivery); MicroVMs inherit the same posture until the pluggable identity work ([#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249), ADR-016) redesigns the seam.

## Decision

Adopt **AWS Lambda MicroVMs as a third, opt-in `ComputeStrategy` backend** named `lambda-microvm`, selected per repo via Blueprint `compute_type`. AgentCore remains the default. Five sub-decisions:

### 1. Strategy shape: extend the interface with mandatory suspend/resume

`ComputeType` widens to `'agentcore' | 'ecs' | 'lambda-microvm'` (mirrored in `cli/src/types.ts` and the CLI's inline unions). `SessionHandle` gains a `{ strategyType: 'lambda-microvm', microvmId, endpoint }` variant — `microvmId` because every lifecycle API (`suspend-microvm`, `resume-microvm`, `terminate-microvm`, `get-microvm`, and `create-microvm-auth-token` — the latter not called in P1–P3, see sub-decision 3) takes only the MicroVM identifier, and `endpoint` because it is per-session (minted by `RunMicrovm`) and required for any orchestrator→agent HTTP interaction. Note the naming seam: the handle field is `microvmId` (matching `RunMicrovmResponse.microvmId`), while the request key on every lifecycle command is `microvmIdentifier` — the strategy is the only place that translates between the two. The image ARN is deliberately **not** in the handle: like the ECS task definition ARN, it is deployment-time configuration consumed by `startSession` (from construct-injected environment) and recorded in the session-start log entry for diagnostics, not per-session lifecycle state.

The `ComputeStrategy` interface gains **mandatory** `suspendSession(handle)` / `resumeSession(handle)` methods returning a typed result (`{ supported: false } | { supported: true }`-shaped, exact type at implementation time); the widening lands in P3 (see sub-decision 5), in one commit across all three strategies. Mandatory-with-explicit-stub is the codebase idiom, not optional methods: no behavioral interface in the codebase has an optional method, `AgentCoreComputeStrategy.pollSession` is already a mandatory explicit stub rather than an optional member, and the exhaustive-`never` switch culture means a fourth backend must make a compile-checked decision about its suspend semantics instead of silently falling through a `strategy.suspendSession?.()` feature-detection. The agentcore and ecs strategies return `unsupported` (not a silent success — a suspend that silently no-ops would let the orchestrator believe compute billing stopped when it did not); the orchestrator gates its suspend policy on the typed response, consistent with how `pollTaskStatus` already branches explicitly on `computeType`.

**Poll semantics — the strategy reports, the orchestrator interprets.** `pollSession(handle)` receives only the session handle and cannot see task state, so the health rules must live where the DynamoDB status lives. `SessionStatus` gains a `'suspended'` variant; the strategy maps `GetMicrovm` state mechanically and the **orchestrator** cross-references against the task row — the same division of labor `finalPollState` already uses for ECS (substrate stopped + non-terminal DynamoDB status → failed) and `pollTaskStatus` uses for agentcore heartbeats: substrate `suspended` + task `AWAITING_APPROVAL` is healthy (orchestrator-intended suspend); `suspended` with any other task status is an anomaly to surface, not fail-fast; substrate terminal + non-terminal task status → classify failed.

The service's `MicrovmState` enum has **six** members, not three, so the mapping is stated exhaustively (one line of rationale each, mirrored in the strategy's doc comment):

| `MicrovmState` | `SessionStatus` | Why |
|---|---|---|
| `PENDING` | `running` | Still booting; the same way ECS's `PENDING`/`PROVISIONING` map to `running`. |
| `RUNNING` | `running` | — |
| `SUSPENDING` | `suspended` | Already on its way to frozen; reporting `running` would tell the orchestrator compute is still progressing when it is not. Both suspend states land on a report the orchestrator treats as benign-or-anomalous depending on task status, never as failure. |
| `SUSPENDED` | `suspended` | — |
| `TERMINATING` | `completed` | Terminal-bound and carries no exit code, so "the substrate is gone" is all the strategy can honestly say. |
| `TERMINATED` | `completed` | Success vs failure is the orchestrator's call — it cross-references the DynamoDB status. |
| *unrecognized* | `running` | A future service enum addition must never fail a healthy task; the strategy warns and keeps polling. |

**`GetMicrovm` `ResourceNotFoundException` → `completed`.** This deliberately diverges from `ecs-strategy`, where `DescribeTasks` returning no task maps to `failed`. ECS keeps stopped tasks describable for roughly an hour, so a missing task there really is anomalous; a terminated MicroVM is reaped from the control plane **by design**, so `failed` would fail every task that finished cleanly. The divergence is safe because it does not weaken detection: the orchestrator still fails the task when a terminal report lands while the DynamoDB status is non-terminal, so a genuine mid-run disappearance is caught — it simply receives the substrate-failure classification instead of a misleading poll error. Because that cross-check acts on a status read earlier in the same poll cycle, the orchestrator **re-reads the task row before failing** (the normal shutdown order is "agent writes terminal status → agent exits → VM terminates", which a stale read would otherwise turn into a spurious failure); ECS buys the same protection with a five-consecutive-poll patience counter instead.

Neither the mapping nor the NotFound rule is a health decision: both are mechanical restatements of substrate state, which is what keeps the "strategy reports, orchestrator interprets" split intact.

Normative requirements (EARS, per [ADR-020](./ADR-020-ears-requirements-syntax.md)):

- When a task's Blueprint sets `compute_type: 'lambda-microvm'`, the orchestrator shall resolve the `LambdaMicrovmComputeStrategy` via `resolveComputeStrategy`.
- When `startSession` is invoked, the strategy shall call `RunMicrovm` with `maximumDurationInSeconds` set to 28 800 (the service maximum, matching AgentCore's 8-hour session cap and sitting inside the orchestrator's ~8.5 h safety-net poll window).
- When `startSession` returns, the orchestrator shall persist the MicroVM handle (`microvmId`, `endpoint`) in the task row's `compute_metadata` (the field `cancel-task.ts` already reads ECS handles from).
- The strategy shall omit `idlePolicy` on every `RunMicrovm` call, in every phase.
- The orchestrator shall be the sole initiator of suspension, via `suspendSession`.
- When `pollSession` observes MicroVM state `SUSPENDED` or `SUSPENDING`, the strategy shall report `suspended` without interpreting task state.
- When `pollSession` observes a MicroVM state it does not recognize, the strategy shall report `running`.
- If `GetMicrovm` reports that the MicroVM does not exist, then the strategy shall report `completed`.
- If the strategy reports a terminal substrate state while the task's DynamoDB status is non-terminal, then the orchestrator shall re-read the task row and, if it is still non-terminal, classify the task as failed with a substrate-failure remedy.
- If the strategy reports `suspended` while the task's DynamoDB status is not `AWAITING_APPROVAL`, then the orchestrator shall surface an anomaly event and shall not fail-fast the task.
- If `suspendSession` or `resumeSession` is invoked on a strategy that does not support suspension, then the strategy shall return an explicit unsupported result.
- When the agent process reaches a terminal state, the agent shall exit.
- When the orchestrator finalizes a `lambda-microvm` task, the orchestrator shall call `terminate-microvm` (termination shall not rely on any substrate timeout).

*On the omitted `idlePolicy`:* if the block is present all three fields are required, so omission is the unambiguous disabled state the invariant test asserts. This deliberately forgoes `suspendedDurationSeconds` — it lives *inside* `idlePolicy` and cannot be set without re-enabling the traffic-idle machinery — so the suspended-state bound is `maximumDurationInSeconds` plus orchestrator termination and the stranded-approval reconciler (see sub-decision 2). A tighter substrate-level suspended-TTL remains available later as an additive `idlePolicy` change if operators want it. *On the fixed `maximumDurationInSeconds`:* no wall-clock task budget exists in the platform (budgets are `max_turns` / `max_budget_usd`), so the value is parity with AgentCore's 8 h cap rather than derived policy; a Blueprint override can be added later if a real need appears.

### 2. Lifecycle: suspend/resume reconciled with the agent-owned approval poll

The headline economic win is suspend during **HITL approval waits** (Cedar approval gates, [CEDAR_HITL_GATES.md](../design/CEDAR_HITL_GATES.md)): while a task waits on a human decision, the MicroVM is suspended (compute charges stop; memory/disk state — cloned repo, warm build caches — is preserved) and resumed when the decision lands. Under Cedar decision #6 the approval window is bounded (default 300 s, ceiling 1 h, timeout → deny), so the saving per gate is bounded at ~1 h of compute — real at 16 vCPU, and it makes any future extension of gate ceilings (the off-hours posture §14.8 deliberately defers) cheap on this backend.

The handshake must respect the existing approval mechanics: the agent **discovers decisions itself** by polling DynamoDB (`_poll_for_decision`, monotonic timeout), the approve/deny Lambda writes only the decision rows, and `AWAITING_APPROVAL` holds the concurrency slot (Cedar decision #7). Nothing "delivers" an approval to the agent, and suspension freezes the agent's monotonic clock — so the design is:

- **Suspend — orchestrator-owned.** The orchestrator's durable poll observes `AWAITING_APPROVAL` on a `lambda-microvm` task and calls `suspendSession` after a grace period, and only when the gate's remaining window exceeds grace + resume overhead (suspending a 30 s gate is pure loss). Suspend is a policy decision on a poll observation, not a user action.
- **Resume — inline in the approve/deny Lambdas, orchestrator poll as backstop.** After the transactional decision write commits, `ApproveTaskFn`/`DenyTaskFn` load the MicroVM handle from the task row's `compute_metadata` (persisted at session start — the same field `cancel-task.ts` reads ECS handles from) via a post-commit strongly-consistent `GetItem`, then call `resumeSession` **best-effort**: on failure they log a warning and write a resume-orphan task event; the decision response never fails on a compute error (the decision row is already durable). The orchestrator poll reconciles: decision row present + MicroVM still `SUSPENDED` → retry resume (idempotent).

  *Why inline rather than poll-only — codebase precedent:* resume-on-approve is structurally identical to task cancellation — a user-initiated, latency-sensitive action whose purpose is an immediate compute-lifecycle side effect. `cancel-task.ts` already resolves this exact tension: the API-plane handler invokes ECS `StopTask` / AgentCore `StopRuntimeSession` inline, best-effort (a failed stop logs a warning and the state transition stands; a `task_cancel_compute_orphan` event is written when no stoppable compute handle exists, `reason: missing_runtime_handle`) — with the conditional IAM wired in `task-api.ts`. The resume path goes one step further than the precedent by also writing the orphan event on *failed* resume calls, because a failed resume strands a suspended VM awaiting a decision — a stronger liveness consequence than a failed stop of an already-cancelled task. The alternative (orchestrator-poll-only resume) preserves single-owner lifecycle purity but pays up to a full poll interval (~30 s) of latency on every approval, and the purity argument was already litigated and declined for cancel. `approve-task.ts` is deliberately minimal today (security-critical ownership comparison, Cedar finding #6); the resume call is therefore added *after* the transaction commits, cannot alter the decision outcome, and carries one conditional `lambda:ResumeMicrovm` grant — the same blast-radius trade the cancel handler accepted in review.
- **Timeout under freeze — the agent re-bases on the wall clock it already owns.** The agent's monotonic gate timer freezes while suspended, so resuming near the deadline is not enough: the frozen timer would still hold its remaining budget and fire the deny minutes *after* the user-visible window — colliding with the approval row's TTL (`created_at + timeout_s + 120s`) and triggering the "row reaped → stranded" fallback on a healthy gate. Instead, the gate expires at **`min(monotonic budget, created_at + timeout_s)`**, evaluated on each poll iteration and on `/resume`. This is not a new principle: Cedar decision #6 is already "min wins" for timeouts, the wall-clock deadline is already durable in the approval row the agent itself writes (`created_at` is in the agent's own clock domain — no skew), and §13.12's late-approval race fix already establishes that the durable row is authoritative over the agent's local timer. Deny authority stays agent-side (the conditional `TIMED_OUT` write + ConsistentRead re-read race protection is untouched); the orchestrator's resume at `deadline − margin` is purely the wake-up mechanism, with no correctness role.
- **Backstops, not mechanisms.** `maximumDurationInSeconds` (mandatory on every `RunMicrovm`, pinned at 28 800 s — see sub-decision 1) is the substrate kill switch bounding running **and** suspended time; the orchestrator's finalization `terminate-microvm` is the active cleanup path; the stranded-approval reconciler retains its role for orphaned waits. No `idlePolicy`-based bound is used in any phase — see sub-decision 1's omit-`idlePolicy` invariant.
- **Concurrency slot stays held** during suspend. Cedar decision #7's rationale ("container alive, consuming memory") weakens under suspend, but the conclusion survives for a harder reason: AWS counts `SUSPENDED` MicroVMs toward the account memory quota, so releasing ABCA's slot would not free real capacity — it would only invite admission of tasks the substrate cannot start.

The agent's `/suspend` hook flushes progress events (durable writes before returning 200, within the 60 s hook budget); `/resume` reseeds CSPRNGs and refreshes cached credentials.

Normative requirements (EARS):

- While a `lambda-microvm` task is in `AWAITING_APPROVAL` and the gate's remaining window exceeds the configured grace period plus resume overhead, the orchestrator shall call `suspendSession` after the grace period.
- When the approve or deny Lambda commits a decision for a `lambda-microvm` task, the Lambda shall load the MicroVM handle from `compute_metadata` and call `resumeSession` best-effort.
- If the inline resume fails, then the Lambda shall record a resume-orphan task event and shall still return the decision outcome.
- While a decision row exists and the MicroVM remains `SUSPENDED`, the orchestrator shall retry `resumeSession`.
- While a `lambda-microvm` task waits on an approval gate, the agent shall evaluate gate expiry as the earlier of its monotonic budget and the row's wall-clock deadline (`created_at + timeout_s`), on each poll iteration and on `/resume`.
- If gate expiry is reached without a decision, then the agent shall deny.
- If no decision arrives by the gate's wall-clock deadline minus the resume margin, then the orchestrator shall resume the MicroVM so the agent can evaluate expiry and fire the deny agent-side.

### 3. Packaging: same agent image source, new build path

The existing agent container (`agent/` Dockerfile, already ARM64) is repackaged as a zip + Dockerfile artifact in S3 and built into a versioned `MicrovmImage` via `CreateMicrovmImage`. The agent runs its existing FastAPI server (`agent/src/server.py`) — the MicroVM path uses the HTTP entrypoint like AgentCore, not ECS's batch bypass — plus the four runtime lifecycle hooks (`/run`, `/suspend`, `/resume`, `/terminate`) on a sidecar port, and the `/ready` + `/validate` build hooks for snapshot quality. Runtime hooks are fast-notification only (1–60 s): `/run` validates the payload and starts the pipeline **asynchronously**, mirroring how the agent loop already runs in a background thread behind `/ping` on AgentCore.

**Hook phasing — P1 provisions the packaging plane, P2 makes it runnable.** Serving the hooks is agent-side work, so the hooks land in a different phase from the infrastructure that declares them:

| Hook | Declared by | Served by the agent | Notes |
|---|---|---|---|
| `/run` | P1 (construct sets `hooks.microvmHooks.run`) | **P2** | The payload-delivery channel; declared in P1 so the image shape and IAM are reviewed once, but nothing answers it until P2. |
| `/ready`, `/validate` | **P2** | **P2** | Build-time snapshot-quality hooks. Deliberately NOT declared in P1: a `/validate` endpoint that 404s fails every image build. |
| `/suspend`, `/resume`, `/terminate` | **P3** (suspend/resume), P2 (`/terminate`) | P3 / P2 | Declaring a runtime hook the agent does not serve fails the corresponding lifecycle transition, so each is declared only in the phase that implements it. P1 termination is the orchestrator's `TerminateMicrovm`, which needs no in-guest cooperation. |

Consequence to state plainly: **a P1-built MicroVM image is not runnable end to end.** P1 delivers the strategy, the construct, the roles/buckets/connector, the image resource, and the packaging script — an image built from a P1 deployment boots the existing FastAPI server but does not answer `/run`, so a `lambda-microvm` task started against it will not progress. P2 ("smoke parity") is the phase that makes clone → change → PR work on this backend. The construct and the packaging script both surface this at synth/run time so an operator cannot mistake a provisioned substrate for a working one.

**Payload delivery** reuses the ECS strategy's S3-pointer pattern, adapted to `runHookPayload` (≤ 16 KB): small payloads inline; larger ones uploaded by the strategy to a platform payload bucket (the ECS payload bucket pattern in `ecs-agent-cluster.ts`: orchestrator write access, compute-role read-only scoped to the bucket, lifecycle expiry on objects) with only the S3 URI in `runHookPayload` — the MicroVM **execution role** holds the read grant, exactly as the ECS task role does today.

**No orchestrator→agent HTTP path exists in P1–P3**: payload arrives through the `/run` hook, all agent work is outbound, and therefore **no JWE auth tokens are minted at all** — token minting (and its ≤ 60 min TTL refresh problem) is deferred until a real consumer exists (e.g. operator shell access, [#391](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/391)). The `endpoint` stays in the `SessionHandle` because it is genuinely per-session state that becomes load-bearing the day such a consumer appears. **Constraint accepted:** 32 GB RAM / 32 GB disk (disk quota to be confirmed against current service quotas when COMPUTE.md is updated) means repos that motivated the 120 GB ECS sizing stay on `ecs`; MicroVMs target the default-sized workload with suspend economics, not the heavy-build niche.

Normative requirements (EARS). The requirements that constrain what the *strategy* and the *image build* do are P1; the ones that require the *agent* to serve a hook are P2, per the phasing table above:

- (P1) The image build shall not embed secrets, tokens, or per-task identity in the snapshot.
- (P1) If the task payload exceeds the 16 KB `runHookPayload` limit, then the strategy shall upload the payload to the platform payload bucket and pass only its S3 URI in `runHookPayload`.
- (P1) The MicroVM execution role shall hold read-only access to the payload bucket, scoped to that bucket.
- (P1) Where a deployment configures a MicroVM image before the agent serves the runtime hooks, the platform shall warn that the image is not yet runnable end to end.
- (P2) The agent shall resolve credentials at `/run` time.
- (P2) When the `/run` hook receives the task payload, the agent shall validate it, start the pipeline asynchronously, and return HTTP 200 within the hook budget.
- (P2) The agent shall not execute the clone→verify→PR pipeline on the hook path.
- (P2) Where the image declares the `/ready` and `/validate` build hooks, the agent shall serve them.

### 4. Infra and IAM: conditional resources behind bootstrap `ComputeTypes`

Mirroring the ECS pattern: a `compute-lambda-microvm` bootstrap policy (`cdk/src/bootstrap/policies/`) gated on the `ComputeTypes` CFN parameter; a CDK construct provisioning the build role, execution role (admitted to the per-session role via `AgentSessionRole.admitComputeRole`, which was designed for exactly this), the S3 artifact bucket wiring, and image build automation. Egress uses the platform VPC via an egress network connector so the DNS Firewall / security-group / flow-log stack in [COMPUTE.md](../design/COMPUTE.md) applies unchanged; ingress is restricted to the JWE-authenticated endpoint (no `SHELL_INGRESS` by default — it is noted as a candidate for [#391](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/391), operator session access, as a separate decision).

- Where the bootstrap `ComputeTypes` parameter includes `lambda-microvm`, the generated template shall attach the `IaCRole-ABCA-Compute-LambdaMicrovms` policy to the CloudFormation execution role.
- The orchestrator role shall receive only the MicroVM lifecycle actions it calls (`lambda:RunMicrovm`, `lambda:SuspendMicrovm`, `lambda:ResumeMicrovm`, `lambda:TerminateMicrovm`, `lambda:GetMicrovm` for `pollSession`, and `lambda:PassNetworkConnector`, which is required even for the default connectors), scoped to platform-created images.
- Where the `lambda-microvm` backend is enabled, the approve and deny Lambdas shall receive `lambda:ResumeMicrovm` and `lambda:GetMicrovm` — conditionally, mirroring the cancel handler's conditional `RUNTIME_ARN` wiring in `task-api.ts`.

`lambda:CreateMicrovmAuthToken` is granted to no role in P1–P3 (no JWE consumer exists; see sub-decision 3).

**Cost attribution.** `cdk/src/main.ts` currently tags the whole stack with a single `compute_type` context value (default `agentcore`) — already imprecise with two backends, wrong with three. P1 must add backend-identifying cost-allocation tags on the MicroVM-specific resources (images, payload/artifact bucket wiring, log groups) and revisit the stack-level tag semantics (e.g. a `compute_types` list), keeping attribution consistent with [#645](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/645)'s cost/attribution acceptance criterion.

- Where a deployment enables the `lambda-microvm` backend, MicroVM-specific resources shall carry backend-identifying cost-allocation tags.

#### Security bar vs existing backends ([#645](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/645) acceptance criterion)

| Control | AgentCore | ECS | Lambda MicroVMs | Delta |
|---|---|---|---|---|
| Egress (DNS Firewall, TCP 443 SG, flow logs) | Platform VPC | Platform VPC | Platform VPC via egress network connector | None |
| Tenant-data scoping | Per-session role (`admitComputeRole`) | Per-session role | Per-session role, execution role admitted identically | None |
| Secrets delivery | Runtime env + Identity injection | Task env vars | Fetched at `/run`; never in snapshot | New surface: snapshot must stay secret-free (EARS req., sub-decision 3) |
| Inbound exposure | None (SigV4 invoke only) | None (no endpoint) | **Public HTTPS endpoint, JWE-gated, no unauthenticated access; no tokens minted in P1–P3** | New surface: endpoint exists but is unreachable without a minted token |
| Session isolation | MicroVM | Task-level | MicroVM (Firecracker) | None (≥ ECS) |
| State reuse | None | None | Snapshot shared across MicroVMs | New surface: CSPRNG reseed + credential refresh on `/run`/`/resume` (EARS req.) |
| Workload-token injection | Yes (Runtime-coupled) | No (env-var posture) | No (env-var posture) | Shared with ECS; deferred to [#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249)/ADR-016 |
| Operator shell access | No | No | Not enabled (`SHELL_INGRESS` omitted; candidate for [#391](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/391)) | None by default |

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

- **P1 — strategy + infra:** `LambdaMicrovmComputeStrategy` (start/poll/stop), CDK construct, bootstrap policy, types sync, unit + CDK assertion tests. No suspend yet, and **no runnable image yet** — the construct declares the `/run` hook but the agent does not serve it until P2 (sub-decision 3's phasing table).
- **P2 — smoke parity:** the agent serves the runtime and build hooks (`/run`, `/terminate`, `/ready`, `/validate`), making a MicroVM image runnable end to end; agent completes clone → change → PR on the backend with progress visible to `bgagent watch`; failure classification entries in `error-classifier.ts`; **AgentCore Memory parity** (IAM grant + `MEMORY_ID` delivery, following the `EcsAgentCluster` pattern — Memory is a standalone service already consumed cross-substrate, and omitting the grant silently no-ops cross-session learning).
- **P3 — suspend/resume:** the interface widening from sub-decision 1 (mandatory methods, all three strategies in one commit), HITL-wait suspend policy, inline resume in the approve/deny Lambda with orchestrator-poll reconciliation (sub-decision 2), timeout-under-freeze wall-clock handling; coordinate with [#491](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/491)'s unified liveness model and update Cedar decision #7's rationale note.
- **Out of scope:** replacing AgentCore as default; classic Lambda functions as a runtime; GPU; the Runtime-coupled workload-access-token injection path (delivery mechanism exists only on AgentCore Runtime; MicroVMs adopt the ECS env-var posture until [#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249)/ADR-016 redesign the seam). Gateway integration is orthogonal: ADR-019/[#641](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/641) is substrate-portable by design and applies to this backend when it lands.

## Consequences

- (+) **Suspend/resume economics.** Tasks idling on approval waits stop billing compute while preserving full state — bounded at ~1 h per gate under the current Cedar ceiling (decision #6), and the enabler for cheap off-hours gate-ceiling extensions later (§14.8).
- (+) **VM-level isolation without cluster ops.** Firecracker isolation with no ECS cluster, task definition, or capacity management; one-session-per-MicroVM maps 1:1 onto ABCA's task model.
- (+) **Escapes AgentCore's 2 GB image limit and FUSE `flock()` workaround** — native disk in the snapshot supports `uv`/`mise` without the split-storage scheme.
- (+) **Liveness becomes explicit.** Unlike AgentCore's stub `pollSession`, the strategy can report real substrate state, strengthening the [#491](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/491) unification.
- (−) **32 GB RAM / 32 GB disk hard ceiling** — not a successor to the ECS backend for heavy CI-parity builds; the platform now maintains three backends.
- (−) **New packaging pipeline.** Zip + Dockerfile + service-side image builds with versioned snapshots (storage billed per version) alongside the existing ECR flow; image versions need lifecycle cleanup.
- (−) **8-hour hard cap includes suspended time**, and with `idlePolicy` omitted there is no tighter substrate-level suspended-TTL — the suspended-state bound is `maximumDurationInSeconds` plus orchestrator termination and the stranded reconciler. Under today's 1 h gate ceiling this is comfortably sufficient, but any future extension of gate ceilings must revisit the bound (an additive `idlePolicy` change) and give the orchestrator a checkpoint-and-restart path (push branch, new session) beyond the cap.
- (!) **Idle-policy foot-gun.** Traffic-based auto-suspend would freeze a busy outbound-only agent; the decision to disable auto-suspend must be enforced in code and covered by tests, not left to configuration discipline.
- (!) **Snapshot uniqueness.** Shared memory snapshots require CSPRNG reseeding and credential refresh in `/run` / `/resume` hooks; missing this is a silent security defect.
- (!) **Regional availability (5 regions at launch, expanding)** — enforced in layers (synth-time static check, onboarding + doctor live probes, orchestration-time classification; see sub-decision 4). The static CDK constant is the one piece that rots as AWS expands; its update path and context-flag escape hatch are deliberate.
- (!) **Workload-token injection delta persists** (shared with the ECS backend) until [#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249)/ADR-016 land; document it in the security bar comparison rather than blocking on it. Memory and Gateway are explicitly *not* deltas — both are standalone services consumed via IAM from any substrate.

## Testing

**P1 (start/poll/stop — no suspend):**

- Unit tests for the strategy: start/poll/stop mapping (including `SessionStatus` `'suspended'` reported mechanically, without task-state interpretation), payload-size branching (inline vs S3 pointer), error classification (`ServiceQuotaExceededException`, `ThrottlingException`, `ResourceNotFoundException`, regional-unavailability), the omit-`idlePolicy` invariant, and `maximumDurationInSeconds` fixed at 28 800.
- Orchestrator tests: substrate-terminal + non-terminal task status → failed classification; `suspended` + non-`AWAITING_APPROVAL` status → anomaly event, no fail-fast; `compute_metadata` persisted with `microvmId`/`endpoint` after `startSession`.
- CDK assertions: MicroVM resources present only when `ComputeTypes` includes the backend; synth failure for unsupported regions (plus the context-flag escape hatch); IAM actions scoped as specified (orchestrator lifecycle set; no `CreateMicrovmAuthToken` anywhere); payload-bucket grants (execution role read-only); backend cost-allocation tags; types-sync check covers the widened `ComputeType`.
- CLI tests: onboarding rejection with remedy when the availability probe fails; doctor check present when a blueprint selects the backend.
- P1 verification items (external service facts): manual-suspend default TTL without `idlePolicy`; disk quota; `runHookPayload` 16 KB limit; IAM action names; region probe behavior; account-quota treatment of `SUSPENDED` MicroVMs — record answers in COMPUTE.md (`maximumDurationInSeconds` bounds the worst case either way).

**P2 (smoke parity):**

- Smoke (gated like the ECS backend): clone → change → PR with `bgagent watch` progress; Memory write parity (no AccessDenied no-op).

**P3 (suspend/resume):**

- Unit tests: suspend/resume mapping; agentcore/ecs `unsupported` stubs; approve/deny inline resume with handle loaded from `compute_metadata`.
- HITL lifecycle tests: inline resume failure leaves the decision outcome intact and records the orphan event; orchestrator backstop retries resume; gate expiry fires at `min(monotonic budget, created_at + timeout_s)` — including the suspend/resume case where the monotonic budget exceeds the wall-clock remainder — without disturbing the §13.12 late-approval race protection.
- Smoke: suspend/resume across a simulated approval wait preserving workspace state.

**All phases:** docs sync for [COMPUTE.md](../design/COMPUTE.md) (new column distinguishing MicroVMs from classic Lambda) and [ORCHESTRATOR.md](../design/ORCHESTRATOR.md) (liveness + suspend lifecycle).

## References

- Issue [#645](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/645) — originating RFC proposal
- Issue [#491](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/491) — unified liveness decision model (soft dependency, P3)
- Issue [#641](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/641) / ADR-019 (PR [#663](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/663)) — substrate-portable tool plane
- PR [#596](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/596) — ECS Fargate backend (pattern source for conditional wiring)
- [AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html) — developer guide; [Running and using MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html) — lifecycle APIs and hooks
- [Agent Toolkit for AWS — aws-lambda-microvms skill](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/specialized-skills/serverless-skills/aws-lambda-microvms/SKILL.md) — operational constraints (no self-suspend, idle-policy semantics, snapshot uniqueness, size limits)
- [ADR-020](./ADR-020-ears-requirements-syntax.md) — EARS syntax used for the normative requirements above
- [CEDAR_HITL_GATES.md](../design/CEDAR_HITL_GATES.md) — approval-gate mechanics (decisions #6, #7) the suspend/resume handshake preserves; `cancel-task.ts` / `task-api.ts` — the inline best-effort + reconciler-backstop pattern the resume path mirrors
- [COMPUTE.md](../design/COMPUTE.md), [ORCHESTRATOR.md](../design/ORCHESTRATOR.md) — design docs to be updated by the implementing PRs
