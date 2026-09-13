# ADR-021 P3 implementation and completion plan

Prepared 2026-09-13 from `main` `5e10038c7e28179b302ac4de78b709795aeba3ce`. Read the [review](./645-p3-readiness-review.md) for evidence and the beginner introduction. This document proposes work; it does not mark P3 as implemented.

## Implementation progress

Prerequisite work is tracked here on `fix/645-microvm-readiness`. “Completed” means implemented and checked locally; AWS deployment and live verification have separate completion gates below.

- [x] Review current implementation, clean up verified stale comments, and prototype nesting.
- [x] Fix server-test thread isolation (#841).
- [x] Grant scoped coordinator payload deletion (#817).
- [x] Refresh heartbeat atomically after approval.
- [x] Stabilize terminal failure classification and user retry guidance (#817).
- [x] Exercise real S3 bad-byte paths and fix closed-stream error classification (#817).
- [x] Require new ARN fields to participate in validation; pin contract fields and anchor (#817).
- [x] Bind configuration to IAM-authenticated deployment manifests and use single-object payload links for ECS/MicroVM (#817 / #700).
- [ ] Verify v2 bootstrap policies, S3 conditional writes, expiry, networking and coordinated rollout in AWS.
- [x] Implement saved MicroVM start receipts, stable tokens, input fingerprints and handle recovery.
- [ ] Verify AWS token retention/conflicts and unknown-start cleanup on a live deployment.
- [x] Make capacity acquisition/release atomic per task across crash replay; unify counter writers and repair.
- [ ] Verify the capacity protocol's upgrade/drain procedure, deployed IAM and scan scale in AWS.
- [x] Restrict agent task updates to reporting fields; remove replacement/deletion and worker counter grants.
- [ ] Verify metadata restrictions with real AWS sessions/transactions; retain status/tag trust limits.
- [x] Replace unused logging-failure bookkeeping with structured stdout diagnostics (#810); document shared runtime networking and verify large registry payload delivery (#818).
- [ ] Implement production nesting if included, then verify a clean P2 deployment.
- [ ] Implement and verify the P3 sleep/wake lifecycle described below.

First prerequisite batch completed locally on 2026-09-13:

| Commit | Completed work | Proof |
|---|---|---|
| `b5155928` | #841: join test pipeline threads before restoring mocks/environment; retain and report timed-out handles; distinct task IDs | A deterministic two-test subprocess regression failed on the old fixture and now passes. All 234 server/isolation tests pass. |
| `564ccc19` | #817 deletion IAM: exact `s3:DeleteObject` on `*/payload.json` in the dedicated bucket, on the coordinator only | The IAM regression failed before the grant; construct and full-stack assertions now verify the action and resource scope. Worker read-only permissions are unchanged. |
| `5490d645` | Approval resume: refresh heartbeat in the same conditional write that restores RUNNING | Atomic-write regression failed before the change; immediate post-wait polling is tested for AgentCore and MicroVM. Cancellation/wrong-gate conditions remain intact. |

Validation for this batch: `mise run quality` in `agent/` passed lint, formatting, type checks and **1,785 tests**, with **83.75%** coverage. Six relevant CDK suites passed **509 tests** via `mise run testf`; CDK ESLint and TypeScript compilation also passed. The original review/cleanup is commit `19904775`.

These are source changes, not changes to deployed AWS resources. The IAM fix needs a normal stack deployment; the heartbeat fix needs an updated agent image. No bootstrap-policy change is required by this batch. The historical validation section at the end describes the earlier review commit only.

Second prerequisite batch completed locally on 2026-09-13:

| Commit | Completed work | Proof |
|---|---|---|
| `8c04dd34` | #817: exercise real S3 body failures; classify a closed stream as unreadable payload | Five route cases cover bad JSON/encoding, incomplete/closed streams and a non-object body. The closed-stream case failed with HTTP 400 before the fix and now returns structured HTTP 500 without installing config or starting work. |
| `2e20d54a` | #817: stable terminal failure codes, precise region/auth/config guidance and consistent task/reply classification | New regressions reproduced the prior misclassification. Tests assert saved message → task API → channel/panel guidance, legacy records, hook 4xx/5xx and start-retry decisions. |
| `cfe95c5e` | #817: exact contract assertions and reverse ARN-validation guards | Negative mutations failed in both Python and the real constants-checker subprocess before the fix. New ARN fields pass only when added to the validation set. |

Final checks for the second batch: `mise run quality` passed **1,797 Python tests**, lint, formatting and type checks (**83.87%** coverage). Eight relevant CDK suites passed **476 tests**; CDK ESLint, TypeScript compilation, constants-sync and Markdown link checks passed. These counts describe the selected suites for each batch, not additional disjoint tests. No cloud resources were changed. Deploy the orchestrator update and an updated agent image to use these fixes. At the close of that batch, trusted configuration provenance, task-scoped payload reads, uncertain-start retries and P3 remained open.

Third prerequisite batch completed locally on 2026-09-13:

| Commit | Completed work | Proof |
|---|---|---|
| `e9944475` | Saved MicroVM start receipts, stable request tokens, immutable payload fingerprints, bounded replay and handle recovery; cancellation/registration reconciliation; one start-failure finalization path; consistent initial finalizer reads | Fault injection covers a lost successful response, process restart, saved-handle reuse, changed/expired requests, cancellation and failed/lost database writes. Three HTTP-timeout cases and two stale-finalization cases reproduced incorrect outcomes before their fixes. |

Final checks for the third batch: CDK ESLint and TypeScript compilation passed. `mise run testf -- test/handlers/ --detectOpenHandles` passed **151 suites / 3,557 tests** and exited successfully. An earlier ordinary broad run reported a delayed-exit warning; the diagnostic run produced no open-handle trace, so its cause remains unidentified. The changed start/recovery integration suites also exited cleanly in isolation. Documentation sync, the **77-page** Astro build and Markdown link checks passed. No Python source changed in this batch.

Deploy the orchestrator update to activate these changes. This batch needs no additional IAM/bootstrap change or agent-image update. The receipt is internal task-table data, not a new public task field. The service emulator proves our retry behavior; AWS token retention/conflicts and unknown-ID cleanup still need live evidence. At the close of the third batch, atomic capacity-slot release and the remaining P2/P3 work were still open.

Fourth prerequisite batch completed locally on 2026-09-13:

| Commit | Completed work | Proof |
|---|---|---|
| `0bb95243` | Task-owned atomic capacity reservations; one admission owner; shared finalizer/stranded release; guarded queue restoration; revision-checked repair including approval waits; scoped IAM and stale counter-doc cleanup | The old replay regression reduced two seats to zero. Fifteen tests against DynamoDB Local now verify real transaction conditions, competing writers, lost committed replies, empty-counter races and stale-revision rejection. Unit and construct tests cover handler wiring and permission scope. |

Final checks for the fourth batch: CDK ESLint and compilation passed. **153 handler suites / 3,600 tests** passed with the local integration suite enabled; **15** of those tests used DynamoDB Local. The focused run passed **323 tests**, including the two relevant IAM construct suites; those counts overlap. Documentation sync, the **77-page** Astro build and Markdown link checks passed. The broad handler run exited successfully after the previously observed delayed-exit warning; the focused run exited normally. The temporary database container was stopped and removed.

No AWS resources changed. Activating this batch requires the coordinated deployment/drain procedure in [capacity verification](./645-capacity-reservations.md), including the reconciler's task-update permission and upload confirmation's narrowed counter access. No agent source/image or bootstrap bundle changed. Coordinator metadata protection is newly tracked in 1G; internal reservation fields currently share an agent-writable row.

Fifth prerequisite batch completed locally on 2026-09-13:

- Main-task agent writes now use a reviewed attribute allowlist; whole-row replacement/deletion and coordinator field updates are excluded. Missing session/attribute context fails closed. ECS's legacy direct path shares the restriction.
- Removed unused AgentCore/ECS capacity-table grants and the uncalled Python submission/session-registration helpers. Corrected comments that overstated tenant isolation or described approval writes as best-effort.
- The old-policy regression failed on `PutItem`. **1,795 Python tests** pass with **84.47%** coverage, including actual writer-request/permission-contract checks; **268 CDK tests** pass across session-role, ECS, MicroVM and full-stack suites. Python quality, CDK lint/compilation and documentation checks pass. These counts overlap earlier batches; four obsolete helper tests were removed and two contract tests added.
- [Metadata verification](./645-coordinator-metadata.md) records the effective source-policy boundary, writer inventory, rollback constraints and pending real-AWS allowed/denied transaction matrix. No table migration or bootstrap-policy update is required. Application-role deployment and a matching agent image remain necessary; nothing was deployed.

Sixth prerequisite batch completed locally (2026-09-13), commit `82a9df80`:

- v2 payload bootstrap for #817/#700 now covers both ECS and MicroVM: IAM-authenticated deployment manifests, one-object signed downloads, immutable private retry references, bounded bytes/expiry and coordinator cleanup of both task objects. Worker reads outside the manifest prefix and payload-bucket listing are explicitly denied.
- Regressions reproduced and fixed bearer-URL leaks through Python and JavaScript exception chains. Removed the old unsigned transports, stale permission/compatibility comments and unused per-backend key helpers.
- Python quality passed **1,806 tests / 84.51% coverage**. The broad CDK run passed **159 suites / 3,935 tests** with `--detectOpenHandles` and exited normally; **15 existing DynamoDB Local tests were skipped** because this batch did not start that service or change its transaction protocol. The final five transport/strategy suites passed **187 tests** after the last cleanup (overlapping the broad run); CDK lint/compilation, Python lint/type checks, constants-sync, the **77-page** docs build and link checks also pass.
- The [bootstrap runbook](./645-payload-bootstrap.md) records the design, AWS documentation evidence, remaining trust boundaries, live allowed/denied matrix and coordinated deployment/rollback procedure. Nothing was deployed; effective IAM, conditional S3 writes, expiry, DNS/HTTPS, ingress negatives and clean launches remain gates.

Seventh prerequisite batch completed locally (2026-09-13):

- #810: removed the unread CloudWatch failure counter, lock and unused threshold. Debug/warn failures emit structured stdout records with writer, task ID and exception class; no AWS retry or failed-message contents. Six client/stream/event failure cases reproduced the old unstructured output and now pass. There is no metric or configured alarm; stdout collection remains a live gate.
- #818: documented that remote non-443 endpoints are unsupported under all three shipped runtime policies, with no new connectivity validator or port grants. A real-hydration test resolves a large MCP asset, checks its durable audit record and v2 S3 bytes, and verifies that the Run reference stays within 4,096 bytes. Python separately verifies the real download, hook mapping and `.mcp.json` loader. Live remote-tool connectivity is still unproven.
- Full agent quality passed **1,811 tests / 84.51% coverage**. CDK lint/compilation and **38 tests** in the two relevant orchestrator/registry suites passed. These counts overlap previous runs; no CDK runtime code or IAM changed in this batch.
- Source/generated registry/compute/deployment documentation, the **77-page** build and link checks pass. An offline coordinator bundle check includes the S3 client, presigner and shared constants; it does not replace a full deployed packaging check. Nothing was deployed or posted to the issue trackers. Package 3's clean P2 rerun and package 7's live P3 matrix remain required.

## The result we want

When the coding agent asks a human for permission, its computer may go to sleep. The human can approve or deny while it sleeps. The computer wakes, reads the saved answer, and continues or refuses the action. If nobody answers, it wakes before the deadline and applies the existing timeout-as-denial rule. Its files, task identity, permissions, progress and deadline remain correct.

**HITL** means “human in the loop.” **Cedar** is the policy system that decides which actions need permission. **DynamoDB** is where ABCA stores task and approval records. A **transaction** changes/checks related records together so competing actions cannot half-win. A **strongly consistent read** asks DynamoDB for the latest committed value. **Idempotent** means repeating an operation has the same intended effect as doing it once. A **reconciler** repeatedly compares what should be happening with what is actually happening and repairs differences.

P3 coordinates the supervisor, approval records and the sleeping computer.

For example, with a five-minute approval window and the suggested settings below: the question appears at **12:00**; after **12:00:30** the VM can sleep. If approval arrives at **12:02**, ABCA wakes it and it reads the saved answer. If nobody answers, ABCA wakes it around **12:04** so the agent can deny at **12:05**. Waking must not start a new five-minute timer.

A few implementation words used below:

| Term | Meaning here |
|---|---|
| API / SDK | An API is a service's set of commands; an SDK is a library for sending them from code. |
| Bootstrap | Install the deployment's foundation permissions and storage before deploying the application. |
| ARN | An AWS resource's full address, such as the address of one permission role or image. |
| Monotonic clock / wall clock | A stopwatch measuring elapsed time versus a clock showing the date/time. Sleep can affect them differently, so the saved deadline must still count. |
| Durable | Saved outside the VM, so putting the VM to sleep does not lose it. A failed save is not durable. |
| Barrier | A controlled door: coding cannot proceed until the required saves or credential refresh have succeeded. |
| Orphan | A VM that still exists but whose normal supervisor/wake-up path has lost track of it. |
| Replay / race | Replay repeats earlier work after recovery. A race happens when two actions, such as approval and cancellation, arrive almost together. |
| Regression test / fault injection | A test that prevents a known bug returning / a test that deliberately simulates a failure. |
| Change set / rollback | AWS's preview of deployment changes / the procedure to restore the previous working deployment. |

## Fixed boundaries

- Keep the eight-hour `maximumDurationInSeconds = 28800`, including suspended time.
- Keep `idlePolicy` absent. Traffic-based idleness would mistake outbound-only coding work for inactivity.
- Keep explicit `NO_INGRESS` and no `CreateMicrovmAuthToken` grant. No public agent-control endpoint or JWE token refresh system is needed for P3.
- Keep the 4,096-byte serialized hook-reference boundary and v2 S3 transport for every task, including registry-resolved assets.
- Resume the restored task context; do not repeat bootstrap or reuse its short-lived launch URL after sleep.
- Only the orchestrator initiates suspension. Approval handlers may request resume after committing a decision; the orchestrator repairs missed resumes.
- The agent remains the authority that consumes a decision or times out a gate. Approval HTTP handlers must not simply mark the coding task RUNNING.
- Preserve tenant-scoped credentials, task/user/repository tags and fail-closed behavior. “Fail closed” means refusing an action when safe authorization cannot be established.
- Keep the ABCA concurrency slot while suspended; release it exactly once on terminal finalization. Suspended AWS memory-quota consumption remains unverified, not the justification for a new claim.
- General progress-based hang detection (#491), operator shell access and extended/off-hours approval windows are outside P3. Coordinate compatible seams without making those projects hard dependencies.

## Delivery order

| Work package | Depends on | Exit condition |
|---|---|---|
| 0. Freeze evidence and establish test baseline | Current review | Known baseline, reproducible checks and issue-to-test map |
| 1. Repair P2 correctness/security prerequisites | 0 | Critical defects have regression tests and are fixed |
| 2. Optional infrastructure nesting | 0; finish before final deployment validation if chosen | Safe boundary, current feature matrix, bootstrap/migration verified |
| 3. Prove clean P2 deployment | 1 and any chosen nesting changes | Managed image and task complete with no manual IAM workaround |
| 4. Define lifecycle contract and widen all strategies | 0; can develop alongside 1–3 | Typed interface, state/race contract and focused tests |
| 5. Implement safe agent hooks and clocks | 1's test/liveness fixes, 4 | Hooks, refresh barrier, deadlines and failure paths tested |
| 6. Add orchestrator and approval wake-up | 4–5 | Race-safe integration, bounded recovery, scoped grants |
| 7. Live P3 verification and completion | 3, 5–6 | Full acceptance matrix passes with retained evidence |

Keep nesting in a separate change from lifecycle logic. Developing P3 locally need not wait for every live prerequisite, but claiming it complete does.

## 0. Establish the baseline

1. Record the source commit, dependency lockfiles, bootstrap bundle version, image version and enabled context flags. Track #645, #817, #700, #818, #841 and #857 with concrete remaining checkboxes. Do not reopen consolidated #813–816 as if they represented four separate finished fixes.
2. Land/review this comment cleanup independently. It deliberately does not repair runtime behavior.
3. **Completed locally — #841:** every tracked pipeline thread is joined before mocks/environment are restored; teardown reports surviving threads without discarding their handles. A deterministic subprocess regression verifies isolation across successive tests.
4. Run focused baseline suites for server hooks, task-state approvals, credentials, strategy, orchestrator, approval handlers, construct IAM and bootstrap coverage. Record existing unrelated failures rather than quietly weakening assertions or thresholds.
5. Make the phase vocabulary explicit: this is P3 of ADR-021. Use different names for PR/work-package sequencing so “P1 priority” on an issue is not confused with phase P1.

## 1. Repair the prerequisites

### 1A. Finish #817

- [x] **Deletion IAM:** the coordinator has exact `s3:DeleteObject` on `*/payload.json` and `*/launch.json` in the dedicated bucket. Construct and stack tests pin that scope. Worker ambient reads are now restricted to bootstrap manifests; deletion failure does not hide the task outcome.
- [x] **Classifier:** reconciliation persists `MICROVM_SUBSTRATE_TERMINATED` or `MICROVM_RUN_HOOK_REJECTED` separately from the descriptive AWS reason. The known leading run-hook 4xx response selects the latter; arbitrary appended text cannot override the code. Legacy task records remain readable. Tests cover task API classification, channel/panel retry guidance, host/capacity failures, regional faults, authorization/configuration, concurrency words, hook 400/500 and other backends.
- [x] **Trusted configuration (local):** v2 reads a deployment manifest with ambient IAM credentials restricted by an explicit deny outside that deployment's bootstrap prefix, then verifies downloaded task/config equality. Another workspace's secret in the same account is rejected; an exact trusted cross-region secret is preserved. Both languages share the version/caps. Live effective-IAM, public-bucket and ingress negatives remain open.
- [x] **Contract guards:** pin exact contract fields, ARN fields and the account anchor in both languages. Python import-time validation and the constants checker reject newly added `*_arn` / `*_ARN` fields omitted from `arn_keys`. This prevents accidental validation gaps; it does not establish deployment identity.
- [x] **S3 bad bytes:** real `StreamingBody` tests cover truncated JSON, invalid encoding, short and closed streams, and non-object JSON through fetch/decode/envelope/route. They assert a structured unreadable response, no configuration installation/environment mutation, and no pipeline thread. A closed-stream `ValueError` now reaches the unreadable-payload 500 branch. Malformed hook envelopes retain the separate 400 response. S3 writes are atomic; invalid stored bytes need replacement, not an assumption that another identical read repairs them.
- **Documentation:** verify all remaining contract/status changes update source docs and their generated copies through the sync script.

### 1B. Narrow payload reads (#700)

**Completed locally for ECS and MicroVM:** every task uses an IAM-authenticated deployment manifest plus a short-lived, single-object signed URL. Worker ambient roles explicitly deny other object reads and payload-bucket listing. The coordinator stores the exact URL privately in S3 for replay, conditionally creates task objects, rejects changed/expired launches, and deletes payload plus launch record at finalization. ECS consumes/removes its capability before the pipeline; errors and Python exception chains must not expose it.

The [bootstrap runbook](./645-payload-bootstrap.md) records wire/storage shapes, caps, credential lifetime, the coordinator's `ListBucket` requirement for missing-object detection, coordinated drain/image/controller/policy upgrade and rollback, and the real AWS allow/deny matrix. Old unsigned envelopes are intentionally rejected; this is a coordinated contract change, not a rolling mixed-version deployment.

**Still required:** effective-role cross-task/public-bucket negatives, actual S3 conditional writes and missing-object behavior, signer/URL expiry, runtime DNS/HTTPS and clean launches for both backends. The role/tag and other platform-grant limits in 1G remain; this boot-path fix does not establish complete hostile-worker isolation.

### 1C. Fix approval/heartbeat ordering

**Completed locally:** `task_state.transact_resume_from_approval` refreshes `agent_heartbeat_at` in the **same conditional update** that restores RUNNING. The expected status and `awaiting_approval_request_id` conditions remain in place.

Regression coverage includes a task that waits over 240 seconds and resumes before the next heartbeat tick; immediate polling remains healthy for AgentCore and MicroVM. Existing cancellation/wrong-request conditions and ECS behavior are preserved. This is approval-state coverage, not yet a live frozen-MicroVM test.

### 1D. Make session-start retries honest

**Implemented locally:** `microvm-start.ts` conditionally records one start per task, using the task ID as its stable token. The internal `microvm_start` attribute stores the request fingerprint, creation time, a 120-second local replay deadline and any recovered handle. The fingerprint includes the full S3 payload, so a changed retry cannot overwrite the first task's instructions. It is checked before uploads and again before `RunMicrovm`. A new attempt requires a new task ID.

The receipt works like an order number: when the reply gets lost, the next call asks about the same order.

Fault tests exercise a successful simulated service creation followed by a lost response, a second application call with the same token, a fresh strategy instance, saved-handle replay, changed input, expired recovery, confirmed rejection, cancellation before/during/after creation, and lost DynamoDB responses. The handler recovers committed registration, treats start-audit failures as non-fatal, and routes start failures through one finalization path. Finalization reads the latest committed task, avoiding a stale cancellation/failure report. An unknown first outcome stays unknown even when the second call gets a definite rejection; HTTP 408 and named service timeouts remain uncertain even with a 4xx status.

**Still required:** the installed SDK documents `clientToken` idempotency but gives no retention period. Public AWS API documentation URLs did not provide a usable RunMicrovm reference during this review. The local 120-second limit is a conservative application cutoff, not evidence of AWS's retention window. Verify same-token replay, changed parameters, simultaneous requests/conflicts, token expiry and returned handles after termination against AWS before accepting this prerequisite. The service emulator proves client behavior only.

For an unknown outcome with no returned ID, the task error or cancellation event identifies the saved token for investigation. Do not automatically submit a replacement task. Verify how operators find and terminate that VM in the deployed service; if they cannot recover an ID, the eight-hour lifetime cap is the remaining bound. Keep this limitation explicit in live evidence.

### 1E. Make verification observable

**Completed locally:** #810 uses the removal option. Both CloudWatch writers emit `cloudwatch_write_failed` to stdout with `writer`, `task_id` and `error_type`; the unused counter and threshold are gone. Six injected failures cover client creation, stream creation and event submission without recursive logging or sensitive error contents. This is a structured log, not an alarm or metric. Verify guest stdout ingestion while the VM is running; AgentCore APPLICATION_LOGS does not automatically collect it.

For #818, documentation explicitly limits remote MCP endpoints to reachable HTTPS/443 on all shipped backends. No synth/onboarding connectivity probe is added, and no ports are widened. Registry-specific integration tests exercise real resolution/hydration, audit writes, >4,096-byte asset data in S3, the bounded v2 reference, Python hook mapping and the real local loader. The retired inline branch is no longer the acceptance target. Successful config delivery does not prove remote-tool connectivity; test DNS/routing/TLS/auth live.

### 1F. Make concurrency release safe across replay

**Implemented locally:** `task-concurrency.ts` saves a per-task reservation together with the user counter change in one transaction. Repeated acquisition reuses the held reservation; release requires a terminal task and changes `held → released` atomically with the decrement. Missing/released markers never decrement another task's count. This covers cooperating platform writers and crash replay.

The regression reproduced two finalizer executions reducing two occupied seats to zero, instead of leaving the other task's seat occupied. DynamoDB Local tests now exercise real transaction conditions for that replay, concurrent admissions/finalizers, lost committed responses, early failure, cancellation, approval waits, empty counters and a racing new admission. The normal finalizer, early failure path and stranded cleaner share release. Upload confirmation only submits and reads capacity; the orchestrator reserves once. Queue restoration cannot requeue a task that acquired a reservation after an uncertain invoke.

Every counter change carries a fresh revision. Scheduled repair strongly scans the base counter/task tables, compares the saved revision before replacing a count, and completes abandoned terminal releases. It includes approval waits. An increment/decrement with no net count change still invalidates an old scan. Incomplete scans install no partial result. Ambiguous older active tasks prevent guessing a replacement count.

**Deployment gate:** pause admissions and drain old executions, update all counter writers and the reconciler's scoped task-update permission, reconcile after legacy tasks settle, then reopen admissions. Rollback also requires draining. Verify scan duration/read capacity at deployment scale and the mixed-version/drain procedure in AWS. The local simulator does not prove deployed IAM or cloud-scale behavior. See [capacity verification](./645-capacity-reservations.md).

### 1G. Protect coordinator-owned metadata

**Implemented locally:** the main task table now permits own-task reads and only `UpdateItem` on an explicit reporting/approval attribute list. Replacement/deletion, start receipts, capacity markers, owner identity and compute handles are excluded. Supporting tables retain their task-scoped access. Missing IAM context keys fail closed. ECS's legacy direct-grant path uses the same attribute restriction; AgentCore/ECS no longer receive the unused shared-counter grant, and MicroVM never had it.

The writer inventory found no production callers of Python `write_submitted` or `write_session_info`; those unused helpers and stale comments are removed. Contract tests exercise every current main-task writer, including complete terminal results and approval transactions, against the JSON attribute list used by CDK. Construct/stack tests inspect the actual grants across all three backends and prevent the main table from being supplied as an unrestricted supporting table.

**Deployment gate:** run the allowed/denied request matrix in [metadata verification](./645-coordinator-metadata.md) using real scoped and ambient credentials, including aliased/nested updates, replacement/deletion and transactions that mix forbidden task writes with valid approval writes. Inspect effective policies and preserve coordinator start/finalize/cancel behavior. This requires no new table or bootstrap policy change, but it does require application-role deployment and matching image verification.

**Remaining trust limits:** agent status/results remain reports from the agent. Compute roles choose their session tags; existing trust does not independently bind those choices to a task. This patch protects coordinator attributes from the resulting session permissions; it does not establish complete hostile-worker tenant isolation. The replay tests in 1D/1F also do not prove AWS authorization.

## 2. Nest infrastructure if adopting the split

1. Introduce `LambdaMicrovmStack` as a `NestedStack` wrapper and an explicit way to supply the MicroVM execution role from the parent. Keep shared session-role trust and runtime-role ownership in the parent. Preserve exact grant behavior.
2. Pass a stable deployment name for image and both connector names. Never sanitize unresolved CDK tokens. Preserve name/ARN resolution for imported images as well as managed images.
3. Return artifact/payload bucket, image, connector and build-role identifiers to existing parent consumers. Keep parent `Microvm*` outputs unchanged so packaging/CLI discovery still works. Check no-image bootstrap state and imported-image state, not just the managed-image case.
4. Inspect all generated role names against bootstrap allowlists. If permissions/names require a bundle update, regenerate artifacts, apply the repository's version rule, and run policy/golden/artifact-sync tests. Keep `PassRole` exact or narrowly prefixed; no broad all-roles shortcut or resurrected broken service condition.
5. Update assertions to inspect every child template. Assert no cycles with `Template.fromStack`, correct tags and solution user-agent propagation, supported region checks, hook values and runtime/build network separation.
6. Synthesize real bundled configurations: default, ECS, MicroVM without image, imported image and managed image; cross the relevant gateway/vault flags; validate the heaviest configuration and custom naming paths. Enforce each stack's resource/byte limits, parameter/output limits and the deployment's nested-operation limits. Do not require the numbers in this review to stay constant forever.
7. Remove or replace the #857 guard only when the supported combination actually passes the current matrix. Keep a size regression test; do not retain “505 resources” as a permanent error message.
8. Review the CloudFormation change set for replacement/deletion. For the first experimental rollout, prefer a dedicated test deployment. For migration of an existing one, stop new admissions, drain/terminate existing tasks, preserve required artifacts/state and use a service-supported migration procedure. Define rollback before applying the change set. Do not let `autoDeleteObjects` silently erase an active payload/artifact bucket.

**Done:** cycle-free bundled templates, least-privilege bootstrap coverage, preserved outputs, safe migration/change-set evidence and a clean deployed image build. The local prototype alone meets none of the live gates.

## 3. Re-prove P2 on the final infrastructure

Use a supported Region and an isolated development repository/account deployment. Record the actual deployed bootstrap bundle (at least 1.6.0, or the newer bundle produced by nesting). Compare effective policies as well as the displayed version. Update bootstrap deliberately when required; a command that skips an already bootstrapped stack is not evidence of refresh.

Follow `cdk/scripts/package-microvm-artifact.sh` and the P1/P2 runbooks:

1. Deploy the no-image infrastructure if its artifact bucket does not exist. Package/upload the current source; create the managed image through CloudFormation with a pinned base image/version. Check `ARM_64`, hook `ENABLED` values and separate build/runtime connectors. Do not substitute the manual image path when validating the formerly broken managed path.
2. Verify `/ready` local warm-up and `/validate` self-check; no AWS credential initialization from build hooks. Review credential warnings without recording secret values.
3. Run a normal task through clone → change → tests → commit/push → PR. Observe `bgagent watch`, task details/list heartbeat, structured application logs and final task outcome.
4. Exercise the Memory path and any features claimed as parity. Absence of an error log alone is not proof a Memory write happened.
5. While the VM is **RUNNING**, verify logging with the narrowed runtime role, including whether removing CreateLogGroup still permits all required streams. Checking after teardown is not equivalent.
6. Verify payload deletion and active termination after success, failure and cancellation. Record service states, request IDs and timing. Negative-test public ingress and runtime port restrictions from suitable test locations.
7. No ad hoc IAM edits, console workarounds or privileged fallback. If one is needed, fix source/bootstrap and repeat the affected acceptance case on that final version.

**Done:** the remaining P2 warning conditions are discharged by a dated runbook. Update warning text only to match the evidence; do not imply that P3 is finished.

## 4. Define the P3 contract before wiring consumers

### Strategy methods

Add mandatory `suspendSession(handle)` and `resumeSession(handle)` to `ComputeStrategy` in the **same commit as all three implementations**. Use an explicit result such as `{ supported: false } | { supported: true }`; supported means the capability/request is supported, not that the VM is already in its final state. Operational failures must remain distinguishable from unsupported capability.

AgentCore and ECS return explicit unsupported results. MicroVM issues `SuspendMicrovm`/`ResumeMicrovm` with `microvmIdentifier: handle.microvmId`. Test wrong handle variants, already-target-state requests, state-conflict races, missing/terminated VMs and retriable/permanent API errors. Verify actual AWS behavior before normalizing a conflict into success. Preserve the strategy's existing state mapping; keep `reason` diagnostic.

### Durable intent and policy

Store a small typed optional lifecycle record on the task row, separate from the existing string-only `compute_metadata` handle: active `request_id`, desired action (`suspend` or `resume`), request timestamp and gate deadline. Guard writes by task status, matching gate ID and matching MicroVM handle; do not overwrite another gate's intent. Add a generation/version condition if needed to prevent an older request from undoing a newer one. Reuse the task table, not a new coordination service.

Persist failure counters/backoff and anomaly episode tracking in durable poll-loop state so Lambda replay does not reset them. Update shared/public types and sync guards only where that record is actually exposed. Store no credentials or bearer URLs in the lifecycle record.

The policy combines task status, the **specific current approval row's status**, desired action, VM state and current time. A PENDING row already exists throughout every wait: “approval row exists” is not a reason to resume. Check APPROVED/DENIED, deadline proximity, missing-row recovery or other explicit wake conditions.

Proposed initial tuning for the implementation: 30-second suspend grace, 60-second pre-deadline wake margin, and three consecutive poll failures before escalation. Treat these as measured/tunable policy values, not AWS facts. Only suspend after grace when enough time remains to pay for resume overhead and a useful sleep. Clamp polling/backoff to the next wake deadline and session lifetime; do not let a user-configured long poll interval oversleep it.

### State/action table

| Task and gate | Observed VM | Action |
|---|---|---|
| RUNNING, doing work | RUNNING | Check liveness; never suspend based on lack of inbound traffic |
| AWAITING_APPROVAL, current gate PENDING, before grace or too near deadline | RUNNING | Keep awake |
| Same, grace passed and sufficient remaining time | RUNNING | Conditionally record suspend intent, recheck gate, request suspend |
| PENDING, intentionally suspended, ample time remains | SUSPENDING/SUSPENDED | Wait; do not mark the stopped heartbeat as a crash |
| Current gate APPROVED/DENIED | SUSPENDING/SUSPENDED | Request/reschedule resume; let agent consume the committed answer |
| PENDING at deadline minus margin | SUSPENDING/SUSPENDED | Resume for agent-side expiry evaluation |
| RUNNING or a different gate, unexpectedly suspended | SUSPENDING/SUSPENDED | Emit one anomaly per episode and perform bounded recovery; do not label suspension itself a crash |
| Task terminal/cancelled | Any live or suspended state | Terminate; never resurrect task state |
| VM terminal, task nonterminal | Terminal/not found | Re-read task consistently, apply substrate-failure reconciliation, finalize once |
| Gate row missing or unreadable while asleep | SUSPENDED | Wake conservatively when possible; preserve existing missing-row/timeout safeguards and bounded API-error handling |

## 5. Implement the agent's suspend/resume safety

Files: `agent/src/server.py`, `hooks.py`, `task_state.py`, `aws_session.py`, `progress_writer.py`, credential-helper/cache owners, `contracts/constants.json`, and focused tests.

1. Create a per-task lifecycle context holding task/VM identity, active approval gate, durable deadline and synchronization primitives. The current server does not hand `/resume` a live gate object automatically. Register/unregister this context with the pipeline and approval hook, including failures and teardown.
2. `/suspend` validates that the task is still parked on the intended gate. Wait for lifecycle/progress work already in progress to finish, establish an acknowledged durability barrier, and return success only within the hook budget. Existing best-effort event methods cannot establish that barrier. On timeout/write failure, report a hook failure so the coordinator keeps/reconciles the running VM. Test approval or cancellation arriving during this boundary.
3. `/resume` refreshes ambient/runtime credential providers as necessary, then ensures tenant-scoped assumed credentials are usable **with the same task/user/repo tags**. Inventory cached DynamoDB/S3/Memory/Logs clients and the Claude Bedrock credential helper; replacing one global session does not replace every already-created client or subprocess cache. Do not call the test-only `reset_session_cache()` and lose identity. Fail closed on refresh failure.
4. Keep the coding action blocked behind the resume barrier until refresh and gate reconciliation finish. Handle duplicate hook calls and concurrent lifecycle requests without deadlocks. Expired credentials or a slow AWS call must not hold the hook beyond its service budget.
5. Reseed the application PRNG from fresh OS entropy on **both `/run` and `/resume`**. Do not seed it with task IDs, timestamps or an image-fixed value. Continue using cryptographic randomness for secrets. Test resumed/sibling snapshot uniqueness where meaningful; do not claim that `random` becomes cryptographically safe.
6. Compute approval remaining time as `min(monotonic_deadline - monotonic_now, created_at + timeout_s - wall_now)`, clamped at zero. Pass the original recorded `created_at` into the gate context; do not create a fresh timeout on resume. Check it on every poll and at resume, then wake the existing agent-owned decision loop to apply its transaction rules.
7. Preserve the conditional TIMED_OUT write, strongly consistent reread when that write loses, and the late-approval winner behavior. A decision committed before timeout must not be overwritten because the VM woke late. Test forward/backward clock changes, frozen monotonic time, missing/TTL-reaped row, approval at the boundary and cancellation. TTL is asynchronous garbage collection, not a precise alarm clock.
8. Declare `/suspend` and `/resume` as enabled image hooks only when the same source version serves them. Add shared hook-budget constants and route/contract assertions. Keep `/ready` and `/validate` AWS-silent. An old image without the new hooks must not be eligible for automatic suspension; enable policy only after deploying a compatible pinned image, with explicit capability/version gating if mixed versions can coexist.

## 6. Wire the supervisor and human decisions

### Orchestrator

Implement the state/action table in a small testable policy/reconciliation helper called by the durable poll loop. Read current gate identity/status/deadline consistently. Record intent before requesting suspension; reread after uncertain outcomes and after suspend success to catch an approval that won concurrently. API acknowledgement is not final VM state: poll it.

An approval can arrive before a pending suspend finishes. Even if an inline resume sees “already running,” the orchestrator must later notice that the machine became suspended and wake it. Do not clear durable wake intent merely because one API call appeared successful.

When `ResumeMicrovm` succeeds but the VM is still RESUMING, keep reconciling; grant a bounded recovery interval rather than immediately applying a pre-suspend stale heartbeat. When the agent restores task RUNNING, use the fresh timestamp from prerequisite 1C. Never exempt genuine crashed RUNNING tasks indefinitely.

Add consecutive MicroVM poll-error tracking. Reset on successful observations; classify permanent failures separately from transient ones. At the chosen threshold, perform a final consistent task read, record an explicit infrastructure failure and finalize/terminate through the existing single-owner path. Emit recovery/orphan diagnostics when termination itself fails; do not silently lose the handle. Keep suspend failures distinguishable from lost compute: failure to save money can leave a task safely awake, whereas failure to wake threatens correctness and needs bounded escalation.

### Approve and deny handlers

After the existing authorization checks and decision transaction **commit**, use a shared helper to load `compute_metadata` with a strongly consistent task read. Validate compute type, complete handle and current task/gate identity. For MicroVM, request resume with a short bound. No HTTP call to the guest is necessary.

Missing handle, read failure, wrong/terminal state or resume failure must produce a warning and a structured resume-orphan event (include task ID, gate ID, VM ID when known, stage, reason and safe AWS request ID). Audit-event failure is also best-effort. **None of these post-commit failures may turn a successful decision into a 500 or undo the transaction.** Preserve the current response/status and cross-tenant/expired/wrong-gate protections. The poll loop is the repair path.

### IAM and deployment

Grant orchestrator SuspendMicrovm/ResumeMicrovm on the exact configured image ARN and required version suffix, alongside its existing lifecycle actions. Grant approve/deny ResumeMicrovm, and GetMicrovm only if the shared wake helper uses it, with the same image scope. Do not grant these actions to the agent execution role. Add no token-minting, broad role-passing or network ingress permission.

Check `task-api.ts`'s lazy image-ARN wiring and no-image branch, bootstrap deployment-role coverage, tests/suppressions and CloudFormation resource counts. Image-hook changes and runtime hook serving must deploy together; automatic suspension remains off until the compatible image is ready. Provide an operational disable switch that stops **new suspends while still allowing resume, timeout handling and termination** for already-sleeping tasks.

## 7. Acceptance matrix and completion gates

| Case | Required result |
|---|---|
| Ordinary task, no approval | Same successful workflow as clean P2; no suspend calls |
| Short gate or decision during grace | No unnecessary freeze |
| Long gate + approve | VM sleeps, decision commits, same workspace and identity resume, allowed action runs once |
| Long gate + deny | VM wakes, denied action does not execute |
| No decision | Wake before deadline; agent-owned timeout/deny occurs on the original deadline |
| Deadline already passed while frozen | No restarted timeout; conditional late-decision race remains correct |
| Inline resume read/API/event failure | Decision API still reports its committed success; orphan signal and orchestrator repair |
| Approval races with suspend | No permanently stranded approved/denied task |
| Cancel during suspend/resume | Terminal task never becomes RUNNING again; VM terminated; slot released once |
| Duplicate/replayed lifecycle calls | No duplicate task/action and no changed approval deadline |
| Credentials expire during sleep | Resume refreshes all relevant credential consumers without losing tenant tags |
| Resume refresh/durability failure | Fail closed or remain safely awake; no unbounded hidden wait |
| VM dies or API polling repeatedly fails | Specific failure, bounded recovery, finalization/cleanup with retained handle |
| Unexpected suspension during RUNNING | Anomaly emitted once per episode; bounded wake/recovery rather than immediate false failure |
| Payload/network negatives | Wrong-task reads denied, truncated bytes rejected, no public ingress, documented port behavior |
| Other backends | AgentCore/ECS explicit unsupported responses; normal tasks/cancellation unchanged |
| Deploy/migrate/rollback | Compatible pinned image, valid bootstrap grants, every stack within limits, no accidental data deletion |

Use unit tests for timers/state transitions and fault injection, integration tests for cross-record races and credential/client ownership, and real AWS runs for hook ordering, snapshot behavior, networking and permissions. Do not use a real hour-long sleep as the only clock test: simulate expired credentials locally, then run a controlled live long-suspend case when the service/session limits permit it. Record what was actually verified.

For live evidence, retain redacted task IDs, commit/image/bootstrap versions, context flags, timeline, VM state transitions, approval timestamps, CloudWatch/progress evidence, workspace checksums or sentinel files, and proof of final termination/payload cleanup. Measure resume latency to tune grace/wake margin. Never include tokens, signed URLs or secret values in runbooks.

**P3 is complete only when:** the full strategy interface and agent hooks ship; approval/deadline races and credential refresh pass; clean P2 and live P3 gates pass on the final deployment; behavior-changing follow-ups have passing regressions; generated docs, bootstrap artifacts and compatibility controls match; no test VM is left running/suspended; and #645/ADR/runbook status is updated with the actual evidence. An unverified gate must be called out explicitly, not converted to a checked box because unit tests passed.

## Validation of the original review commit

Completed locally on 2026-09-13. These checks concern this cleanup/review branch, not the future P3 acceptance tests.

- **246 CDK tests passed** across `lambda-microvm-compute`, `task-orchestrator`, `orchestrate-task-microvm` and `lambda-microvm-strategy` suites (`npx jest --runInBand --coverage=false` with those four paths).
- **104 Python MicroVM server tests passed** (`pytest tests/test_server.py -k microvm --no-cov`); passing this focused run does not resolve #841's fixture isolation issue.
- **The vault/MicroVM guard regression passed** in `stacks/agent.test.ts`; only its wording changed, and it still rejects the same combination.
- **Code comparison passed:** TypeScript output with comments removed is unchanged after accounting for the cdk-nag explanation and guard error-text corrections. Python syntax trees are identical after removing docstrings. No lifecycle logic, IAM grants or deployment topology changed.
- **Python formatting, Markdown source link checks, new artifact relative links and `git diff --check` passed.**
- **Documentation sync and build passed: 77 pages.** The installed mise version could not expand the build task's `:sync` dependency (`':task' pattern should be expanded before matching`), so the declared steps were executed in order with `mise run sync` followed by `mise exec -- ./node_modules/.bin/astro build`. Existing Astro/Cedar highlighting/deprecation warnings remain; they did not fail the build.
- **Offline nesting probe:** measured five configurations in current, naive-nested and parent-role/stable-name modes. The naive mode failed cycle validation; the corrected prototype passed. Probe output is linked in the review. No AWS resources were created or modified.

The live P2 rerun, production nested-stack migration and P3 implementation/acceptance matrix remain future work. This original review commit supplies the cleanup, evidence and plan; subsequent prerequisite fixes are tracked at the top of this document.
