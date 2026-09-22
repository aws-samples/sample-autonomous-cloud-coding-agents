# ADR-021: AWS Lambda MicroVMs as a third ComputeStrategy backend

> **Implementation status (2026-09-18): P1 and P2 are merged; P3 is in draft review.** Approval sleep/wake, retained requests, conversation/workspace recovery and nested infrastructure have live acceptance evidence. Reusable migration and final integration checks remain open; see [verification status](../verification/README.md). This ADR defines P1–P3, not an official P4.

**Status:** proposed
**Date:** 2026-07-29

## Context

ABCA selects compute per repository through Blueprint `compute_type`. AgentCore Runtime is the default; ECS Fargate supports larger workloads. [#645](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/645) adds Lambda MicroVMs for explicit lifecycle control and reduced compute usage during human approval waits.

Lambda MicroVMs are managed Firecracker virtual machines, separate from ordinary Lambda functions. A MicroVM can preserve memory and disk while suspended and can live for eight hours, including suspended time. The function service’s fifteen-minute limit does not apply.

### Capability comparison (delta rows only — full matrix in COMPUTE.md)

| Capability | AgentCore Runtime | ECS Fargate | Lambda MicroVMs |
|---|---|---|---|
| Packaging | ECR image, 2 GB limit | ECR image | ZIP + Dockerfile in S3 → versioned snapshot |
| Duration | Eight hours | No task duration cap | Eight hours, running + suspended |
| Explicit suspend/resume in ABCA | Unsupported | Unsupported | Control-plane APIs; memory and disk retained |
| Storage | Ephemeral disk plus preview persistent FUSE mount | Configurable ephemeral disk | 32 GB native disk; supports `flock()` |
| Sizing | Service-managed | Configurable; larger sustained workloads | ABCA baseline 8,192 MiB; service guide lists up to 32 GiB / 16 vCPU |
| Invocation/liveness | Invoke API + agent heartbeat | RunTask/DescribeTasks | RunMicrovm/GetMicrovm + agent heartbeat |

See [COMPUTE.md](../design/COMPUTE.md) for the full comparison and costs. Suspending stops compute charges, but snapshot storage and save/restore charges remain. A shorter sleep delay does not guarantee lower total cost.

Recorded P1 probes established a 4,096-byte `runHookPayload` limit, an image-ARN requirement and accepted baseline values of 512, 1,024, 2,048, 4,096 and 8,192 MiB. Those observations override conflicting generated SDK descriptions for the tested account/Region. They do not measure guest-visible launch memory, vertical-scaling latency or sustained workload fit. The service guide’s capacity figures and live observations must remain distinguishable.

### Design tensions the strategy must resolve

1. Traffic-based idle policies observe inbound endpoint traffic. A busy coding agent mostly sends outbound requests, so absence of inbound traffic cannot establish that it is idle.
2. Suspension needs an external controller. The agent can prepare a safe checkpoint, but the coordinator owns the service call.
3. Image snapshots share build-time process state. Credentials, task identity and deployment configuration must arrive after launch.
4. A worker’s eight-hour lifetime is shorter than an unanswered approval may remain useful. Durable task state must outlive the worker.
5. New packaging, IAM and lifecycle behavior need live checks; a successful CDK synth cannot validate service semantics.

## Decision

Add `lambda-microvm` as an opt-in `ComputeStrategy`. AgentCore remains the default.

### 1. Strategy shape: extend the interface with mandatory suspend/resume

All strategies implement `startSession`, `pollSession`, `stopSession`, `suspendSession` and `resumeSession`. The lifecycle methods return an explicit supported/unsupported result. AgentCore and ECS return unsupported without making suspension API calls; MicroVM bounds each control request. An accepted API request does not prove the transition completed.

The MicroVM handle records `microvmId`, `endpoint`, the actual launched `imageArn`/`imageVersion`, and verified `lifecycleProtocol` when available. Lifecycle request fields use `microvmIdentifier`. Save the known handle before optional image discovery so a failed capability check cannot lose cleanup ownership. Current deployment settings cannot establish an older worker’s capabilities.

| Service state | Strategy result | Coordinator responsibility |
|---|---|---|
| RUNNING or starting | `running` | Read task state and applicable heartbeat |
| SUSPENDING / SUSPENDED | `suspended` | Reconcile the approval and lifecycle intent |
| TERMINATING / TERMINATED / not found | `completed` | Re-read task state; distinguish completion, recoverable checkpoint and failure |
| Unknown future state | `running`, with warning | Continue bounded observation |

A strategy result is not a task outcome. A terminal substrate can leave a recoverable pending-approval checkpoint; otherwise a non-terminal task needs failure classification. Capacity release separately requires confirmed physical shutdown, not merely the strategy’s `completed` result.

AgentCore and MicroVM start a heartbeat writer every 45 seconds. Their RUNNING tasks use the same 120-second startup grace and 240-second stale threshold. ECS’s batch entrypoint does not start that writer, so applying this check to ECS would fail healthy tasks. Heartbeats establish writer liveness, not progress of every coding thread. Returning from approval to RUNNING refreshes the heartbeat atomically. Task detail/list APIs and CLI views expose the timestamp.

Normative requirements (EARS):

- When a Blueprint selects `lambda-microvm`, the orchestrator shall use the MicroVM strategy and persist its handle in `compute_metadata`.
- Every launch shall use a full image ARN, `maximumDurationInSeconds=28800`, explicit `NO_INGRESS` and no `idlePolicy`. Invalid image configuration shall fail before launch.
- Before allowing suspension, the coordinator shall verify the actual launched image version and lifecycle protocol.
- When a suspended state conflicts with task state, the coordinator shall record and reconcile the anomaly within bounded recovery windows.
- When the task ends, the coordinator shall actively terminate its MicroVM. The service lifetime is a backstop, not the normal cleanup mechanism.
- Uncertain starts, lost replies and supervisor replay shall preserve the original worker identity, ownership and lifetime rather than launch duplicate workers.

### 2. Lifecycle: suspend/resume reconciled with the agent-owned approval poll

Unanswered approvals have no deadline by default (`approval_timeout_s=0`). Explicit task deadlines range from 30 to 3,600 seconds; a positive policy-rule deadline can also apply. The independent sleep preference defaults to 600 seconds per approval wait. `microvm_sleep_after_s=0` keeps the task awake.

Automatic suspension also requires the deployment’s `microvm_approval_suspend_enabled` opt-in, which defaults false for new deployments. A live Parameter Store switch lets existing durable executions stop initiating new suspensions without changing their pinned Lambda environment. The verified normal deployment has this opt-in enabled. Turning it off does not abandon already-suspended workers.

The coordinator observes the exact pending gate and waits for the sleep delay. It skips sleep when a timed gate has too little time left before its wake margin. The guest holds a coding barrier, drains acknowledged progress and commits a checkpoint before accepting `/suspend`. Lifecycle HTTP responses explicitly close their connections before freeze to avoid reuse of a stale pooled connection; see the [transport evidence summary](../verification/README.md#recorded-acceptance).

Approval and denial handlers commit the decision first. They then read the current handle consistently, persist wake intent and request resume best-effort. A wake failure records diagnostics and does not undo the accepted decision. The durable supervisor retries and observes both service state and guest consumption of the decision; RUNNING alone does not prove the tool was released.

A sleeping worker retains its concurrency reservation. For a longer wait, ABCA verifies a complete, version-pinned conversation/workspace checkpoint, fences the attempt, confirms shutdown and releases the reservation. A later decision can admit one replacement through the original published coordinator. It restores Git state, required workspace files, the actual SDK conversation, exact pending tool inputs and cumulative usage with fresh scoped credentials. See the [continuation protocol](../design/ORCHESTRATOR.md#retained-microvm-approvals).

Normative requirements (EARS):

- While all sleep gates and guest safety checks hold, the coordinator shall suspend after the configured delay; it shall remain the sole initiator of suspension.
- When a decision is committed, the API shall preserve that outcome even if optional wake or replacement dispatch fails.
- A timed request shall retain its original wall-clock deadline and, within the original process, its monotonic cap. The earlier limit wins; wake/replacement shall not restart either decision window.
- Before an unanswered timed gate reaches its deadline, the coordinator shall wake the worker with the configured margin. For a retired attempt, it may resolve expiry atomically while admitting a replacement.
- Before releasing a worker reservation, the coordinator shall verify checkpoint integrity, fence ownership and confirm physical shutdown. An uncertain control request shall not release capacity.
- A replacement shall preserve the task/request/tool identity and usage totals, obtain fresh scoped credentials and use a new authenticated launch reference.
- Pending requests shall have no storage TTL. Cancellation or terminal cleanup shall close unanswered requests and preserve recorded decisions without extending an existing retention TTL.
- The guest shall reseed application PRNG state from OS entropy on `/run` and `/resume`; security-sensitive values shall continue to use cryptographic randomness.

The platform verifies ownership and the exact approved action. It does not implement a separate semantic relevance checker; the agent decides whether the proposed work still makes sense.

### 3. Packaging: same agent image source, new build path

Package the existing ARM64 `agent/Dockerfile` and its local inputs into a deterministic ZIP. Managed builds use `microvm-images/agent-artifact-<sha256>.zip`; deploy the digest with the managed base-image ARN/version. A changed object URI triggers CloudFormation to build a new image version. The first deployment may create only infrastructure so the artifact bucket exists before upload. An external image identifier supports out-of-band builds.

All six hooks share the FastAPI listener on port 8080. AWS hook properties accept `ENABLED`/`DISABLED`, not route paths; the architecture enum is `ARM_64`.

| Hook | Contract |
|---|---|
| `/ready` | Required when runtime hooks are enabled; execute required binary warm-up before snapshot capture |
| `/validate` | Check local readiness, routes and configuration contracts without AWS calls |
| `/run` | Authenticate/install launch configuration and start the pipeline asynchronously |
| `/terminate` | Close the local coding barrier, log and acknowledge any request body; do not join the pipeline or write terminal task status |
| `/suspend` | Drain acknowledged progress and commit the current safe checkpoint within the hook budget |
| `/resume` | Renew credentials and reconcile the original gate before releasing coding |

Warm-up budgets come from `contracts/constants.json`; the total guest budget must remain below the image hook timeout. Cold-binary startup exceeded the hook budget in an earlier image; warm-up moved this work into image preparation. Historical sizes and timings are not sizing guarantees for later builds.

**Authenticated v2 payload transport.** Every ECS and MicroVM task uses S3. The coordinator publishes a deployment manifest, conditionally creates the task payload and sends a short-lived signed URL for that one object. The serialized MicroVM reference must fit 4,096 bytes; payloads are bounded at 8 MiB and manifests at 16 KiB.

| Location | Shape |
|---|---|
| Hook reference / ECS `AGENT_PAYLOAD_REF` | `{version:2, task_id, bootstrap_s3_uri, payload_url, expires_at}` |
| `bootstrap/<sha256>.json` | `{version:2, backend, platform_config}` |
| `<taskId>/payload.json` | `{version:2, task_id, agent_payload, platform_config}` |
| Private `<taskId>/launch.json` | `{fingerprint, reference}` for coordinator replay |

The worker authenticates only its deployment’s `bootstrap/*` using ambient credentials. Other payload-bucket object reads and listing are explicitly denied; signed task downloads carry coordinator authorization. The task ID and configuration must exactly match the reference and authenticated manifest before installation. MicroVM `platform_config` contains allowlisted non-secret identifiers, including role/secret ARNs; it does not contain credentials. ECS already receives its deployment configuration through task settings, so its manifest config is empty.

The coordinator saves the exact reference for idempotent replay. Signed URLs last at most 900 seconds, bounded by known credential expiry, and initial creation requires at least 300 seconds. An expired saved reference fails without re-signing the same launch request. Finalization deletes task payload/launch objects; one-day asynchronous S3 expiry is the backstop.

Normative requirements (EARS):

- Image builds shall not embed credentials, task identity or deployment-specific configuration. Build hooks shall avoid AWS clients and credential caches.
- The worker shall reject legacy envelopes, oversized/malformed data, mismatched provenance and unknown configuration keys before starting a pipeline or installing configuration.
- Before configuration installation, the worker shall make only the bootstrap manifest/payload reads and shall log diagnostics to stdout.
- Signed URLs shall not appear in ordinary logs, agent-readable task rows or repository subprocess environments. Downloads shall use the exact regional S3 HTTPS object without redirects/proxies and with bounded response sizes.
- Producers, images and IAM shall be upgraded together; incompatible workers must be drained before switching transport.

The [payload contract](../verification/645-payload-bootstrap.md) and [live checks](../verification/README.md) record the implementation and validation. This transport does not establish complete hostile-worker isolation: other platform grants remain, and a stolen signed URL is usable until expiry or revocation.

No ABCA endpoint consumer exists in P1–P3. The platform grants no `CreateMicrovmAuthToken` permission and mints no JWE tokens. `NO_INGRESS` can still return an endpoint URL; an unauthenticated 403 verifies the authentication boundary, not valid-token reachability.

### 4. Infra and IAM: conditional resources behind bootstrap `ComputeTypes`

The backend adds build/runtime VPC connectors, build artifacts, launch payloads, logs, roles and a managed or external image. Its bootstrap policy is conditional on `ComputeTypes` including `lambda-microvm`. A VPC egress connector requires an operator role. Build egress permits ports 80/443 for package installation; runtime egress permits 443 through the platform VPC.

**Trust and PassRole limitation.** Recorded live checks rejected `aws:SourceAccount`/`aws:SourceArn` conditions on the MicroVM-facing roles and `iam:PassedToService` on the MicroVM PassRole paths. The working roles trust `lambda.amazonaws.com` without those conditions; build/execution roles also allow `sts:TagSession`. IAM simulation with caller-supplied condition values did not prove that the service supplied those values. Reintroduce a condition only after verifying service support.

| Role/action | Scope and responsibility |
|---|---|
| Coordinator lifecycle APIs | Configured image ARN and its version-qualified sibling; includes actual-version capability lookup |
| Coordinator `iam:PassRole` | Exact execution-role ARN, without `iam:PassedToService` |
| Deployment `iam:PassRole` | Backend-specific build/operator role name patterns; shared infrastructure allowlist remains intact |
| Approval/denial handlers | Observe/resume the configured image after committing a decision; dispatch parked continuations |
| Build role | Selected immutable artifact plus manual-build key; MicroVM log writes |
| Execution role | Bootstrap manifests, startup secrets, allowlisted models, Memory and logs; tenant data through the per-task SessionRole |
| Connector operator | Tested ENI/tag/private-IP permissions plus AWSLambdaVPCAccessExecutionRole |

`lambda:PassNetworkConnector` has no resource-level authorization support and therefore uses `Resource: *`. The operator role also has wildcard ENI permissions; some mutations can be scoped in IAM, so their current tested wildcard is not evidence that narrower permissions are impossible. DescribeAvailabilityZones needs a wildcard for fresh CDK repository lookups. These exceptions and namespace wildcards are documented in the construct’s cdk-nag suppressions.

**Nested infrastructure.** `microvm_nested_stack` defaults to `true`, putting MicroVM resources in a nested stack. The shared execution role stays in the parent to avoid a role-trust dependency cycle. Bootstrap 1.9.0 covers nested deployment roles. Before upgrading an existing flat installation, set and retain `microvm_nested_stack=false` until completing the reviewed overlap/drain migration, explicit image/coordinator pins and rollback checks described in the [migration prerequisites](../verification/645-p3-nested-stack.md). Reusable migration commands are still being completed. Moving construct paths alone is not a safe migration. Preserve `microvm_resource_name_prefix` after a migrated deployment.

#### Security bar vs existing backends ([#645](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/645) acceptance criterion)

| Control | MicroVM posture | Difference to account for |
|---|---|---|
| Runtime egress | Platform VPC, DNS Firewall, HTTPS security group, flow logs | Separate build connector additionally allows HTTP |
| Tenant access | Task-scoped SessionRole | Shared compute-role permissions remain outside that boundary |
| Configuration/secrets | Authenticated runtime identifiers; credentials resolved after launch | Shared snapshot must not capture credentials or task identity |
| Ingress | Explicit NO_INGRESS; no platform token minting | Service defaults would select HTTP_INGRESS if the field were omitted |
| Trust/PassRole | Exact role/image scopes where supported | Source-condition limitations described above |
| Logs | Service image group plus platform APPLICATION_LOGS | Both namespaces need explicit grants |
| Retained work | Versioned, bounded, checksum-verified checkpoint | Protect stored conversation/files and clean terminal state |
| Workload identity | Runtime credentials and task-role refresh | Linear vault identifiers arrive through `platform_config`; the compute execution role mints tokens ([setup](../guides/LINEAR_SETUP_GUIDE.md#using-the-vault-with-lambda-microvms)) |

MicroVM-specific resources carry `abca:compute-backend=lambda-microvm` cost tags. A stack-wide compute tag cannot accurately attribute a mixed-backend deployment by itself.

#### Regional availability enforcement

The launch-region list is us-east-1, us-east-2, us-west-2, eu-west-1 and ap-northeast-1. New Regions can be supported before the static list is updated:

- Synth rejects a concrete unlisted Region unless `microvm_region_override` is set. An unresolved Region defers to live checks.
- CLI onboarding and platform doctor probe `list-managed-microvm-images`.
- Runtime regional failures receive a configuration remedy instead of an opaque SDK error.

### 5. Rollout: phased, default unchanged

| Phase | Delivered behavior |
|---|---|
| P1 | Strategy, infrastructure, bootstrap/types, minimal `/ready` + `/run` serving; merged in [#689](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/689) |
| P2 | Clone → change → PR, progress/logs/Memory, runtime configuration, `/validate` + `/terminate`; merged in [#733](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/733), with takeover follow-up validation |
| P3 | Approval-aware sleep/wake, credential renewal, original deadlines, retained requests, complete checkpoint/replacement recovery, nested deployment and live acceptance |

Activate sleep only after verifying the deployed image and coordinator together. Keep a compatible published coordinator and explicit image pin for rollback. Normal acceptance includes the 600-second default, explicit expiry, new and existing task off-switch behavior, replacement, cleanup and preservation of unrelated infrastructure.

Changing the default backend, GPU support, native Slack approval buttons, approval-by-Linear-reply and operator shell access are outside this ADR. CLI responses remain the supported approval path. Future work needs its own scope; “P4” is not an approved phase here.

## Consequences

- Approval waits can stop consuming compute without discarding the question or the saved work. Snapshot and checkpoint costs still apply.
- Native disk supports build-tool locking, and the service exposes explicit worker state without a cluster to operate.
- ABCA now maintains three backends and an additional artifact/snapshot lifecycle. Failed or unused image versions also need cleanup.
- Eight hours remains a per-worker limit. Retained approvals rely on verified retirement and replacement rather than extending a worker indefinitely.
- Suspended workers retain ABCA capacity until confirmed retirement. The service’s account-quota treatment of suspended memory was not established by the recorded probes.
- Memory baseline validation and published peak capacity are not workload benchmarks. Sustained heavy builds require measured sizing and may fit ECS better.
- A healthy heartbeat does not prove coding progress. Hook failures may cause service termination, but successful hook acceptance does not remove ABCA’s cleanup responsibility.
- Service error wording can hide transport errors. The pooled-hook mitigation has local and live evidence; historical internal dispatch traces remain unavailable.

## Testing

The [verification summary](../verification/README.md) distinguishes recorded live acceptance from open PR checks. Required coverage includes:

- Strategy state mapping, explicit unsupported results, ARN/Region validation, NO_INGRESS, omitted idlePolicy and bounded uncertain-start recovery.
- Hook readiness/warm-up, AWS-silent build hooks, authenticated payload installation, arbitrary terminate bodies and lifecycle connection closure.
- Decision/timeout/cancellation races, image capability, coding/progress barriers, original deadlines, durable replay and exact-attempt capacity ownership.
- Real S3 version/integrity/access checks, real DynamoDB transactions and actual SDK conversation/Git/workspace recovery after process and disk loss.
- Cloud approve/deny/expiry/cancellation, repeated sleep/wake, AWS credential renewal after actual expiry, retirement/replacement and final resource cleanup.
- Nested fresh deployment and overlapping migration, compatible image/coordinator rollback, normal CLI feedback and live off-switch acceptance.

Live evidence must distinguish service acknowledgment from completed guest recovery and synthetic handler checks from actual external-channel submissions.

## References

- [Issue #645](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/645) — originating proposal
- [Issue #491](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/491) — unified liveness model
- [Issue #641](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/641) — substrate-portable tool plane
- [AWS Lambda MicroVMs guide](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html) and [lifecycle APIs/hooks](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [ADR-020](./ADR-020-ears-requirements-syntax.md) — requirement syntax
- [Compute](../design/COMPUTE.md), [orchestrator](../design/ORCHESTRATOR.md), [approval gates](../design/CEDAR_HITL_GATES.md)
