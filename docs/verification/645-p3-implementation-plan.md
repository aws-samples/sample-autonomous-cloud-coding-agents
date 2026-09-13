# ADR-021 P3 implementation and completion plan

Prepared 2026-09-13 from `main` `5e10038c7e28179b302ac4de78b709795aeba3ce`. Read the [review](./645-p3-readiness-review.md) for evidence and the beginner introduction. This document proposes work; it does not mark P3 as implemented.

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
- Keep the 4,096-byte hook-payload boundary and S3 fallback, including registry-resolved assets.
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
3. Fix the #841 test fixture: every spawned pipeline thread must finish or be stopped/joined before mocks/environment are restored. Synchronize with events, not arbitrary sleeps; fail teardown if a thread remains alive. Keep test state isolated without discarding references to live threads.
4. Run focused baseline suites for server hooks, task-state approvals, credentials, strategy, orchestrator, approval handlers, construct IAM and bootstrap coverage. Record existing unrelated failures rather than quietly weakening assertions or thresholds.
5. Make the phase vocabulary explicit: this is P3 of ADR-021. Use different names for PR/work-package sequencing so “P1 priority” on an issue is not confused with phase P1.

## 1. Repair the prerequisites

### 1A. Finish #817

- **Deletion IAM:** grant the coordinator `s3:DeleteObject` on the dedicated MicroVM payload bucket's task-object prefix. The worker gets no delete permission. Update `task-orchestrator.test.ts` and `stacks/agent.test.ts`, which currently assert the wrong absence. Exercise upload → start → finalize → delete, failed deletion logging and lifecycle fallback. Keep deletion best-effort so it does not hide the task's real outcome.
- **Classifier:** separate a stable MicroVM failure category from untrusted/free-form AWS `stateReason`. Test host unavailable, capacity unavailable, true unsupported region, authorization/configuration, concurrency and hook HTTP 400 cases. Check both stored task classification and user-facing retry advice. Preserve raw reason text for diagnosis without letting it redefine the category.
- **Trusted configuration:** decide which data is trusted at `/run`. A same-payload account anchor cannot authenticate its siblings. Bind accepted deployment identifiers to trusted deployment configuration or an authenticated payload reference; preserve legitimate cross-region secrets. Reject another workspace's secret even when it has the same account number. Add exact contract key/ARN-key/anchor assertions plus the reverse assertion that newly introduced ARN fields cannot bypass validation.
- **S3 bad bytes:** feed truncated and invalid-encoding bytes through the real fetch/decode/envelope/route path. Expect a structured unreadable-payload response, no partially installed environment and no pipeline thread. Keep producer-schema mistakes distinguishable from transport failures.
- **Documentation:** verify all remaining contract/status changes update source docs and their generated copies through the sync script.

### 1B. Narrow payload reads (#700)

Choose task-scoped transport before describing the backend as suitable for untrusted multi-tenant tasks. The current role reads the payload **before** it establishes task-scoped identity, so merely moving an existing S3 grant onto the session role is not enough.

Evaluate a short-lived, single-object signed URL or a trusted bootstrap envelope that safely establishes task identity first. For a signed URL, check whether the guest's network/DNS policy permits its host and whether retry duration fits the URL lifetime; keep the bearer URL out of logs. For role-based fetching, prove how the role/session tags are trusted before the object is read. Test wrong task, guessed key, expired reference, retries and maximum payload size. Preserve the ECS contract or document a deliberate staged rollout. Finalize-time deletion complements this fix; it does not prevent reads of other active tasks.

### 1C. Fix approval/heartbeat ordering

Change `task_state.transact_resume_from_approval` to refresh `agent_heartbeat_at` in the **same conditional update** that restores RUNNING. Keep the existing expected status and `awaiting_approval_request_id` conditions.

Regression: task starts, waits over 240 seconds, then resumes. Force the orchestrator to poll after the transaction but before the heartbeat thread's next tick. It must remain healthy. Also test cancellation winning the race, wrong request ID, and ECS behavior; do not enable server-thread heartbeat enforcement on ECS.

### 1D. Make session-start retries honest

Fault-inject a successful service-side creation followed by a lost response. Observe a second application start attempt, not just retries inside one SDK command. Define a persisted logical start-attempt identity and stable client token for retries of an uncertain attempt. Mint a new attempt only when the old session is known terminal or the service's idempotency semantics require it. Test same-request replay, confirmed failed start, durable Lambda replay, cancellation and orphan cleanup. Check AWS token retention/conflict semantics before finalizing the policy; ECS's existing `clientToken: taskId` is useful precedent, not proof that MicroVM has identical semantics.

### 1E. Make verification observable

Resolve #810 by exposing a useful structured failure signal for CloudWatch writers or removing the dead counter and using another observable signal. Test failure of the logging system itself. For #818, document the shared runtime 443-only rule and test registry payload overflow; do not expand network ports just to satisfy an incorrect issue premise.

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

## Validation of this review branch

Completed locally on 2026-09-13. These checks concern this cleanup/review branch, not the future P3 acceptance tests.

- **246 CDK tests passed** across `lambda-microvm-compute`, `task-orchestrator`, `orchestrate-task-microvm` and `lambda-microvm-strategy` suites (`npx jest --runInBand --coverage=false` with those four paths).
- **104 Python MicroVM server tests passed** (`pytest tests/test_server.py -k microvm --no-cov`); passing this focused run does not resolve #841's fixture isolation issue.
- **The vault/MicroVM guard regression passed** in `stacks/agent.test.ts`; only its wording changed, and it still rejects the same combination.
- **Code comparison passed:** TypeScript output with comments removed is unchanged after accounting for the cdk-nag explanation and guard error-text corrections. Python syntax trees are identical after removing docstrings. No lifecycle logic, IAM grants or deployment topology changed.
- **Python formatting, Markdown source link checks, new artifact relative links and `git diff --check` passed.**
- **Documentation sync and build passed: 77 pages.** The installed mise version could not expand the build task's `:sync` dependency (`':task' pattern should be expanded before matching`), so the declared steps were executed in order with `mise run sync` followed by `mise exec -- ./node_modules/.bin/astro build`. Existing Astro/Cedar highlighting/deprecation warnings remain; they did not fail the build.
- **Offline nesting probe:** measured five configurations in current, naive-nested and parent-role/stable-name modes. The naive mode failed cycle validation; the corrected prototype passed. Probe output is linked in the review. No AWS resources were created or modified.

The live P2 rerun, production nested-stack migration and P3 implementation/acceptance matrix remain future work. This branch supplies the cleanup, evidence and plan.
