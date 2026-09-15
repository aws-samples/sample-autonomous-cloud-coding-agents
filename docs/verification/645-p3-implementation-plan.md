# ADR-021 P3 implementation and completion plan

Prepared 2026-09-13 from `main` `5e10038c7e28179b302ac4de78b709795aeba3ce`. Read the [review](./645-p3-readiness-review.md) for evidence and the beginner introduction. This document tracks implementation and validation; local completion does not mark P3 live acceptance complete.

## Implementation progress

Prerequisite work is tracked here on `fix/645-microvm-readiness`. “Completed” means implemented and checked locally; AWS deployment and live verification have separate completion gates below.

**Guest hook milestone (2026-09-14):** production
[worker suspend/resume hooks](./645-p3-lifecycle-hooks.md) now connect the guest
barrier to atomic checkpoint writes and retained-credential refresh followed by
task/gate reconciliation. Duplicate acknowledgments stay within one approval
generation; a new gate cannot reuse an old wake result. Shared handler/service
budgets are 20/30 seconds. At this milestone, image capability and supervisor
integration remained open.
No deployment or automatic suspension was enabled in this milestone.

**Image milestone (2026-09-15):** [per-worker image capability](./645-p3-image-capability.md)
now declares all six hooks and the shared protocol marker. The coordinator saves
the worker handle first, verifies the exact returned image ARN/version, then
conditionally records support in both start receipt and compute metadata. Missing
or unreadable support permits normal coding and disables new suspension. Database
race tests reject changed identities and recover a committed capability after a
lost reply. No deployment or automatic sleep was enabled in that milestone.

**Supervisor milestone (2026-09-15):** [production supervision and approval wake](./645-p3-supervisor.md) connect the policy/store to durable polling and post-commit approve/deny handlers. Recovery clocks and the original service lifetime survive replay; failed wake and cleanup remain visible. The rollout flag defaults off and uses a live Parameter Store switch for existing durable executions. That milestone passed full repository validation (5,028 CDK, 1,951 Python and 928 CLI tests).

**P3 deployment follow-up (2026-09-15):** the [live record](./645-p3-live-deployment-20260915.md)
verifies bootstrap `1.8.0`, source `9a5f4606`, six-hook image `3.0`, 475 root resources
and both suspension settings off. Rollout review exposed missing retention for
pinned coordinator/guardrail versions; the fix passed another full build
(5,030 CDK tests), and existing versions were protected before replacement.
Initial isolated guest cases pass. These use a local production
supervisor and manual guarded Suspend; deployed durable entrypoint, automatic
suspension admission and the rest of the acceptance matrix remain open.

**Live infrastructure and image deployed (2026-09-14):** the
[clean P2 deployment record](./645-p2-clean-deployment-20260913.md) tracks the new
Oregon environment, four deployment fixes and actual verification results.
The clean deployment used bootstrap 1.7.0 and application source `29dcaa74`.
CloudFormation reached `UPDATE_COMPLETE`; managed image version `1.0` became active, its ready and
validate hooks passed, and authenticated API reads passed after the update.
The subsequent [image rebuild fix](./645-microvm-image-rebuild-20260914.md)
deployed `e1d5debe` through a normal reviewed update and activated version `2.0`.
Its ready/validate hooks passed; repeated packaging reused the artifact, and
redeploying the same cloud assembly reported no changes. The root had
474 resources at that milestone.
The [live task verification](./645-p2-live-task-20260914.md) on image `1.0` passed
normal coding, PR iteration and cancellation on `isadeks/vercel-abca-linear`,
including heartbeat, npm checks, Memory writes and automatic cleanup. The
repository's [temporary verification configuration](./645-p2-repository-config-20260914.md)
passed all four pre/post npm commands live, and a worker-reported failure was
cleaned up. The user subsequently requested removal of the CLI addition; its
live overrides were also removed. Repository mise tasks are still needed for
the restored default commands.
The [image 2.0 payload verification](./645-p2-payload-live-20260914.md) passed
11 transport/failure cases, including URL expiry/revocation, a foreign-manifest
denial and a payload over 1 MiB. Concurrent/repeated preparation and immediate
identical Run replay passed; all 12 disposable workers and 29 synthetic object
locations were cleaned up. These direct probes use operator credentials for
preparation and bypass coordinator admission/finalization.
The [start/recovery follow-up](./645-p2-start-recovery-live-20260914.md)
passed simultaneous/changed-request service checks, terminated-worker replay
through roughly five minutes, and 13 production-code cases against AWS storage
with local process/reply faults. Saved-handle recovery, changed-input refusal,
cancellation and the actual 120-second cutoff passed. These tests use operator
credentials and do not interrupt the deployed durable Lambda.
Deployed-coordinator recovery and the wider IAM/network matrix still remain.
Full P2 acceptance and the remaining P3 live gates remain open. The batch notes below
record what was verified at their original completion; their deployment status
is superseded by these records.

- [x] Review current implementation, clean up verified stale comments, and prototype nesting.
- [x] Fix server-test thread isolation (#841).
- [x] Grant scoped coordinator payload deletion (#817).
- [x] Refresh heartbeat atomically after approval.
- [x] Stabilize terminal failure classification and user retry guidance (#817).
- [x] Exercise real S3 bad-byte paths and fix closed-stream error classification (#817).
- [x] Require new ARN fields to participate in validation; pin contract fields and anchor (#817).
- [x] Bind configuration to IAM-authenticated deployment manifests and use single-object payload links for ECS/MicroVM (#817 / #700).
- [x] Verify MicroVM manifest/download transport, malformed or mismatched inputs, URL expiry/revocation, a foreign private-bucket denial and >1 MiB transport in AWS; verify concurrent/repeated/conflicting S3 preparation with operator credentials.
- [ ] Complete v2 effective-role/public-bucket tests, expired signer credentials, coordinator recovery and the ECS/coordinated-rollout matrix in AWS.
- [x] Implement saved MicroVM start receipts, stable tokens, input fingerprints and handle recovery.
- [x] Verify immediate identical `RunMicrovm` replay returns the same worker ID in the live payload probes.
- [x] Verify simultaneous identical Run calls, changed-parameter rejection, and replay after termination through roughly five minutes against AWS; distinguish cached Run responses from fresh VM state.
- [x] Verify production start/receipt/payload code against AWS with lost replies and local process death, saved-handle recovery, changed-input/cancellation refusal and actual receipt expiry.
- [ ] Verify deployed durable-Lambda checkpoint/registration recovery and races, AWS behavior after token retention expires, and operator cleanup of genuinely unknown worker IDs.
- [x] Make capacity acquisition/release atomic per task across crash replay; unify counter writers and repair.
- [ ] Verify the capacity protocol's upgrade/drain procedure, deployed IAM and scan scale in AWS.
- [x] Restrict agent task updates to reporting fields; remove replacement/deletion and worker counter grants.
- [ ] Verify metadata restrictions with real AWS sessions/transactions; retain status/tag trust limits.
- [x] Replace unused logging-failure bookkeeping with structured stdout diagnostics (#810); document shared runtime networking and verify large registry payload delivery (#818).
- [x] Deploy a fresh bootstrap, application and managed image from current source; verify build hooks and API reads.
- [x] Verify normal coding, PR iteration, Memory writes, live logging and successful/canceled-task cleanup in AWS; observe cancellation preserve another task's capacity.
- [x] Verify automatic pre/post npm checks under temporary overrides and worker-reported failure cleanup in AWS.
- [x] Give managed image builds immutable, checksum-verified artifacts and require their digest in deployment context; packaging, construct, stack and CDK-nag regressions and the full build pass.
- [x] Verify a normal CloudFormation update builds and activates image `2.0` from the changed artifact URI; repeat packaging reuses the verified object and a same-assembly redeploy reports no changes.
- Deferred at user request: publish mise tasks in the target repository and verify its default commands. The CLI addition and temporary overrides were withdrawn; this repository configuration work is outside the current P3 implementation.
- Optional: production nesting remains unimplemented; the P3 deployment uses 475 of the root stack's 500 resource slots. P3 does not inherently require nesting. Recheck the count for supported feature combinations and validate the split/migration if adopted.
- [x] Add mandatory pause/wake command methods across all three compute strategies, with explicit unsupported results and bounded MicroVM requests.
- [x] Keep the original approval deadline through database writes and polling, including frozen/backward clocks; preserve decision races and cancellation.
- [x] Save gate/VM-bound lifecycle intent with stale-writer protection; add explicit VM observations and a tested policy helper.
- [x] Add the guest pause controller, original-gate registration, parallel-tool tracking, progress acknowledgment tracking, heartbeat/read drain and generation-guarded wake completion; reseed the application PRNG at run and controller resume.
- [x] Add production agent hooks with acknowledged checkpoints, retained ambient/tenant credential renewal, a sole scoped Claude provider and atomic task/gate reconciliation; verify duplicates, original deadlines, timeout and teardown behavior locally.
- [x] Declare compatible image hooks using shared budgets and bind lifecycle capability to the actual image/version used by each worker; keep automatic sleep disabled until integration/live acceptance.
- [x] Persist bounded poll/recovery counters and connect lifecycle policy to the supervisor.
- [x] Connect post-commit approval wake, bounded diagnostics/cleanup, the default-off rollout flag and scoped IAM.
- [x] Complete full repository validation with the P3 supervisor and live switch.
- [x] Deploy the supervisor and six-hook image with suspension disabled; verify six isolated guest cases, repair the discovered cancellation stop omission, and prove API termination before test cleanup.
- [ ] Deploy and verify the complete P3 sleep/wake lifecycle in AWS.

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

First P3 foundation batch completed locally (2026-09-13):

- The shared strategy contract now requires `suspendSession` and `resumeSession`. AgentCore/ECS return `{supported:false}` without calling AWS. MicroVM sends the exact identifier with a 10-second request bound, returns `{supported:true}` only on acknowledgement, and surfaces sanitized errors. Conflicts, missing VMs and uncertain timeouts still require state reconciliation; they are not treated as success.
- An immutable approval deadline is captured with the original row, before database writes/notifications. Polling uses the smaller UTC/monotonic remainder. Regressions reproduced a frozen-clock gate that waited after ten minutes and a 30-second window stretched to 42 seconds by a slow write. The fix also preserves late committed decisions, missing-row handling and cancellation.
- CDK lint/compilation and **5 suites / 169 tests** pass. Full agent quality passes **1,823 tests / 84.53% coverage**, including **12 new clock/race/cancellation cases**. Counts overlap earlier runs.
- No callers, IAM grants or image hooks enable automatic suspension yet. The same deadline must still be registered in the future lifecycle context and checked immediately by `/resume`. Durable intent, policy, credential refresh, acknowledged progress durability and live validation remain open.

Second P3 foundation batch implemented locally (2026-09-13):

- Added `microvm_lifecycle` coordinator records with unique generations, VM/gate identity, desired action, original request time and deadline. Writes check the current task/handle/gate/generation; suspend also transaction-checks the exact PENDING approval. Wake remains sticky within one gate, records are retained, and repeated saves preserve the recovery age.
- Added explicit `microvmState` observations without changing existing coarse status/reason semantics, plus a policy helper for grace, useful sleep, pre-deadline wake, image/enable guards, missing/unreadable data, cancellation and delayed suspend-after-wake races.
- DynamoDB Local verifies actual transaction conditions, rollback, competing writers, changed identities, lost committed replies, cancellation/decision during recovery and a fresh module/client loading saved intent. See the [lifecycle runbook](./645-lifecycle-intent.md) for protocol and remaining integration/deployment gates.
- CDK lint/compilation passed. The broad handler/session-role run passed **158 suites / 3,738 tests**, including **23 lifecycle** and **15 existing capacity** DynamoDB Local tests. Five relevant suites passed **218 overlapping tests** and exited normally. The broad run exited successfully after a delay (about 72 seconds total versus 17.5 seconds reported test execution), with no open-handle trace; its cause is not established. Documentation sync, the **77-page** build and link checks pass. No Python source changed. The temporary local database was removed.
- At that foundation milestone, no production caller used this policy/store. No IAM grants, image hooks or automatic suspension were enabled. Durable poll failure/recovery tracking, guest barriers, supervisor/decision-handler wiring and live AWS gates remain unfinished.

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

**Live subset completed:** [image 2.0 probes](./645-p2-payload-live-20260914.md)
verify MicroVM manifest/download access through the runtime connector, invalid
task/config/path/bytes/signature rejection, URL expiry/revocation, foreign
private-bucket denial and >1 MiB transport. Concurrent/repeated preparation and
changed-input conflicts exercise real S3 with operator credentials.
The [start/recovery follow-up](./645-p2-start-recovery-live-20260914.md)
also verifies recovery after committed S3 replies are lost or the local process
exits after payload/launch writes.

**Still required:** effective-role cross-task/list/write/public-bucket negatives,
expired signer credentials, recovery under the deployed coordinator role and
durable execution, and equivalent ECS/upgrade evidence. The role/tag and other
platform-grant limits in 1G remain; this boot-path fix does not establish complete
hostile-worker isolation.

### 1C. Fix approval/heartbeat ordering

**Completed locally:** `task_state.transact_resume_from_approval` refreshes `agent_heartbeat_at` in the **same conditional update** that restores RUNNING. The expected status and `awaiting_approval_request_id` conditions remain in place.

Regression coverage includes a task that waits over 240 seconds and resumes before the next heartbeat tick; immediate polling remains healthy for AgentCore and MicroVM. Existing cancellation/wrong-request conditions and ECS behavior are preserved. This is approval-state coverage, not yet a live frozen-MicroVM test.

### 1D. Make session-start retries honest

**Implemented locally:** `microvm-start.ts` conditionally records one start per task, using the task ID as its stable token. The internal `microvm_start` attribute stores the request fingerprint, creation time, a 120-second local replay deadline and any recovered handle. The fingerprint includes the full S3 payload, so a changed retry cannot overwrite the first task's instructions. It is checked before uploads and again before `RunMicrovm`. A new attempt requires a new task ID.

The receipt works like an order number: when the reply gets lost, the next call asks about the same order.

Fault tests exercise a successful simulated service creation followed by a lost response, a second application call with the same token, a fresh strategy instance, saved-handle replay, changed input, expired recovery, confirmed rejection, cancellation before/during/after creation, and lost DynamoDB responses. The handler recovers committed registration, treats start-audit failures as non-fatal, and routes start failures through one finalization path. Finalization reads the latest committed task, avoiding a stale cancellation/failure report. An unknown first outcome stays unknown even when the second call gets a definite rejection; HTTP 408 and named service timeouts remain uncertain even with a 4xx status.

**Live subset completed:** [service and application recovery probes](./645-p2-start-recovery-live-20260914.md)
extend immediate replay with simultaneous identical requests, changed-parameter
rejection and terminated-worker replay through roughly five minutes. Production
strategy/storage code recovered lost successful replies and local process death
using real AWS; it also reused saved handles without Run, refused changed input
and cancellation, and stopped replay after its actual 120-second deadline.
These use operator credentials and do not kill the deployed durable Lambda.

**Still required:** the installed SDK documents `clientToken` idempotency but gives no retention period. Public AWS API documentation URLs did not provide a usable RunMicrovm reference during this review. The local 120-second limit is a conservative application cutoff; roughly five minutes of observed AWS replay does not establish maximum retention or post-expiry behavior. Verify deployed durable-Lambda interruption, registration/cancellation races and operator recovery of an unknown worker ID before accepting this prerequisite. Cached `RunMicrovm` replay responses can still say `PENDING` after the worker terminated; use `GetMicrovm` for current state.

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

Use a supported Region and an isolated development repository/account deployment. Record the actual deployed bootstrap bundle (at least 1.8.0 for this source, including exact-self CloudFormation PassRole and the scoped live-suspension parameter permissions, or a newer required bundle). Compare effective policies as well as the displayed version. Update bootstrap deliberately when required; a command that skips an already bootstrapped stack is not evidence of refresh.

The [2026-09-13–14 clean deployment](./645-p2-clean-deployment-20260913.md)
completed the infrastructure, managed-image creation and build-hook checks in
steps 1–2 below. The [live task follow-up](./645-p2-live-task-20260914.md)
provides positive runtime evidence for steps 3–5 and success/cancellation cleanup
in step 6. The [configuration follow-up](./645-p2-repository-config-20260914.md)
also verifies automatic pre/post npm checks and cleanup after a worker-reported
delivery failure. The [image 2.0 payload follow-up](./645-p2-payload-live-20260914.md)
verifies direct startup-hook transport/rejections, immediate Run replay and
operator cleanup. The [recovery follow-up](./645-p2-start-recovery-live-20260914.md)
adds service replay through five minutes and real-storage application tests with
local process/reply faults. Deployed coordinator classification/finalization
after rejected hooks, durable restart/cleanup-error paths and the wider IAM/network matrix
remain unverified.
`isadeks/vercel-abca-linear` explicitly selects `lambda-microvm`; the original
seeded repository retains AgentCore.

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

**Implemented locally:** mandatory `suspendSession(handle)` and `resumeSession(handle)` were added to `ComputeStrategy` together with all three implementations. `SessionLifecycleResult` is `{ supported: false } | { supported: true }`; true means the command was acknowledged, not that the VM reached its final state. Operational failures throw.

AgentCore and ECS return explicit unsupported results without an AWS request. MicroVM issues `SuspendMicrovm`/`ResumeMicrovm` with `microvmIdentifier: handle.microvmId` and a 10-second abort bound. Local tests cover wrong/empty handles, repeated requests, simulated conflicts/not-found and retriable/permanent errors. **Still required:** verify actual AWS behavior for already-target-state/terminated VMs and races before normalizing any conflict into success.

The installed SDK returns empty suspend/resume responses. Its observed states are `PENDING`, `RUNNING`, `SUSPENDING`, `SUSPENDED`, `TERMINATING` and `TERMINATED`; there is no `RESUMING` value. The coarse poll mapping groups PENDING/unknown with running and SUSPENDING with suspended. **Implemented locally:** `SessionStatus.microvmState` carries explicit state, including local `UNKNOWN`/`NOT_FOUND` observations, while preserving existing coarse status/reason semantics. The policy uses this field; the coarse `running` result alone cannot prove wake completion. `reason` remains diagnostic.

### Durable intent and policy

**Implemented locally:** `microvm-lifecycle.ts` stores a typed optional record on the existing task row, separate from `compute_metadata`. It includes format version, generation, VM/gate identity, desired action, original timestamp and deadline. Conditions guard owner/status/gate/handle/generation; suspend atomically checks the same PENDING approval row and unchanged deadline inputs. A wake cannot become a sleep for that gate, and retaining the record prevents an older absent-record snapshot from recreating a sleep intent. A new gate may establish a new generation. No credentials or bearer URLs are stored.

**Implemented locally:** the durable supervisor persists failure counters, anomaly episodes, next-poll delay and fixed recovery/session deadlines. Lambda replay does not reset them. Repeated intent saves already retain the original timestamp/generation. The record is internal and has no public task API field. Database success is not a lock over a later AWS command: reread before suspend and reconcile after every command outcome.

**Connected to the durable supervisor:** the policy combines task status, the **specific current approval row's status**, desired action, explicit VM state and current time. PENDING alone is not a reason to resume. All terminal approval states, deadline proximity, missing/unreadable data or unintended suspension can require wake. SUSPENDING records desired wake but returns `requestReady: false` until SUSPENDED is observed.

Initial local policy values: 30-second suspend grace, 60-second pre-deadline wake margin, 30-second minimum useful sleep and at most 5-second transition polling. Long intervals are clamped to the relevant grace/wake/session deadline. These are tunable choices requiring live measurement, not AWS facts. The supervisor now escalates after three consecutive failed cycles and bounds the entire cycle to 45 seconds, including the store's 5-second request/read-sequence budgets and lost-reply recovery. Wake/unknown recovery is bounded to 120 seconds and startup to 300 seconds; see the supervisor runbook for the complete budgets.

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

**Guest controller implemented locally (2026-09-14):** `microvm_lifecycle.py`
now registers the MicroVM task, tracks SDK tool completion (including failures),
parks the exact approval and original deadline, and drains approval reads,
heartbeat calls and progress writes before a supplied checkpoint callback.
Every progress writer shares the task's acknowledgment history; a dropped event
keeps suspension disabled even after later successful writes. Failed or timed-out
wake callbacks cannot release coding through a late thread completion. The
controller and `/run` reseed `random` using fresh OS entropy.

The [guest barrier review](./645-p3-guest-barrier.md) records that controller
milestone. The subsequent [HTTP hook implementation](./645-p3-lifecycle-hooks.md)
now supplies production checkpoint and refresh/reconciliation callbacks. No image
capability, new IAM grants or automatic sleep have been enabled.

**Credential implementation added locally (2026-09-14):** the
[credential verification](./645-p3-credentials.md) records actual pinned-CLI
expiry/failure probes, the MicroVM-only scoped loopback provider, retained
ambient/tenant refresh and SDK/broker teardown. Static/unknown runtime providers
fail closed; their real renewal path must be verified before enabling suspension.
The production HTTP resume callback now invokes this refresh before any AWS reads.

1. **Implemented locally:** a per-task context holds task/VM identity, active approval and the original deadline. MicroVM background startup registers it; pipeline exit/crash unregisters it. The SDK hook removes the approval safe point before changing task state or returning a permission result. HTTP handlers use this context, cache completed acknowledgments and reject conflicting transitions. A new gate clears the previous wake result.
2. **Implemented locally:** `/suspend` drains tracked activity, strongly reads the task/gate and atomically checks current coordinator intent plus the original PENDING approval while writing an acknowledged TaskEvents checkpoint. Failed/uncertain writes never acknowledge suspension. Real DynamoDB Local transactions cover approval, cancellation, deadline and intent changes between reads and commit. Existing best-effort event methods are not used for this barrier.
3. **Implemented/tested locally:** `/resume` invokes `refresh_microvm_credentials` behind the closed barrier, forcing ambient renewal before renewing the same tenant credential object **with the same task/user/repo tags**. Existing DynamoDB/S3/platform clients retain their references; session identity cannot change after construction. The Claude child uses only the scoped container provider and its managed export helper returns no cached keys. Actual pinned CLI probes establish first-request renewal and failure without fallback. **Remaining:** verify actual runtime provider, long sleep, Gateway signing and managed image behavior in AWS. Never use test-only `reset_session_cache()` to simulate renewal.
4. **Implemented locally:** coding remains blocked until refresh and atomic task/gate reconciliation finish. Completed duplicates acknowledge cached results; concurrent requests receive 409. The 20-second handler budget includes body reads and all lifecycle work. A timed-out or terminated callback cannot release work through a late thread completion.
5. **Implemented locally:** `/run` and successful HTTP/controller resume reseed the application PRNG from fresh OS entropy. Do not seed it with task IDs, timestamps or an image-fixed value. Continue using cryptographic randomness for secrets. Test resumed/sibling snapshot uniqueness where meaningful; do not claim that `random` becomes cryptographically safe.
6. **Implemented locally:** `_ApprovalDeadline` captures the original recorded UTC expiry and a monotonic cap before database writes. Remaining time is `min(monotonic_deadline - monotonic_now, created_at + timeout_s - wall_now)`, clamped at zero, including each sleep bound. Resume verifies the original recorded creation time/timeout and coordinator deadline, then releases the same approval loop with this exact object. Expired wake enters the existing timeout/late-decision path; it never creates a fresh window.
7. **Preserved/tested locally:** conditional TIMED_OUT write, strongly consistent reread when that write loses, and late-decision winner behavior. Forward/backward clocks, frozen monotonic time, slow writes/reads, missing rows and cancellation have regression coverage. **Still required:** exercise these through the actual resume barrier and live AWS lifecycle. TTL is asynchronous garbage collection, not a precise alarm clock.
8. **Implemented locally:** managed images and the packaging helper declare all six served hooks with shared budgets and the source's non-secret protocol marker. `/ready` and `/validate` remain AWS-silent; validation rejects a supplied incompatible marker. The coordinator first saves the known worker handle, then verifies the exact Run-returned image ARN/version and conditionally persists support. Both policy and store require this evidence for new suspend; unknown/legacy workers keep new suspends off. See [image capability verification](./645-p3-image-capability.md). Matching artifact/coordinator deployment and live acceptance remain required.

## 6. Wire the supervisor and human decisions

### Orchestrator

**Implemented locally; live acceptance pending.** The production path implements the state/action table in a small testable policy/reconciliation helper called by the durable poll loop. Read current gate identity/status/deadline consistently. Record intent before requesting suspension; reread after uncertain outcomes and after suspend success to catch an approval that won concurrently. API acknowledgement is not final VM state: poll it.

An approval can arrive before a pending suspend finishes. Even if an inline resume sees “already running,” the orchestrator must later notice that the machine became suspended and wake it. Do not clear durable wake intent merely because one API call appeared successful.

When `ResumeMicrovm` is acknowledged but a subsequent observation does not yet confirm `RUNNING`, keep reconciling within a bounded recovery interval. Do not invent a `RESUMING` service state or treat an unknown/coarse state as confirmation. Defer the pre-suspend stale-heartbeat check only within that bound. When the agent restores task RUNNING, use the fresh timestamp from prerequisite 1C. Never exempt genuine crashed RUNNING tasks indefinitely.

Consecutive MicroVM poll-error tracking resets after a complete successful observation cycle; classify permanent failures separately from transient ones. At the chosen threshold, perform a final consistent task read, record an explicit infrastructure failure and finalize/terminate through the existing single-owner path. Emit recovery/orphan diagnostics when termination itself fails; do not silently lose the handle. Keep suspend failures distinguishable from lost compute: failure to save money can leave a task safely awake, whereas failure to wake threatens correctness and needs bounded escalation.

### Approve and deny handlers

**Implemented locally; live acceptance pending.** After the existing authorization checks and decision transaction **commit**, use a shared helper to load `compute_metadata` with a strongly consistent task read. Validate compute type, complete handle and current task/gate identity. For MicroVM, request resume with a short bound. No HTTP call to the guest is necessary.

Missing handle, read failure, wrong/terminal state or resume failure must produce a warning and a structured resume-orphan event (include task ID, gate ID, VM ID when known, stage, reason and safe AWS request ID). Audit-event failure is also best-effort. **None of these post-commit failures may turn a successful decision into a 500 or undo the transaction.** Preserve the current response/status and ownership/already-decided/wrong-gate protections. The poll loop is the repair path. The current API has no independent wall-clock expiry check: the agent owns TIMED_OUT, and the first committed decision wins. Strict API expiry would be a separate behavior change.

### IAM and deployment

**Implemented in CDK; effective AWS permissions pending.** Grant orchestrator SuspendMicrovm/ResumeMicrovm on the exact configured image ARN and required version suffix, alongside its existing lifecycle actions. Grant approve/deny ResumeMicrovm, and GetMicrovm only if the shared wake helper uses it, with the same image scope. Do not grant these actions to the agent execution role. Add no token-minting, broad role-passing or network ingress permission.

Verify the lifecycle store's DynamoDB permissions too: task GetItem/UpdateItem and approval GetItem/ConditionCheckItem for the supervisor's cross-table suspend transaction. Confirm environment wiring for both table names and test effective permissions. Worker writes to `microvm_lifecycle` must remain excluded.

Check `task-api.ts`'s lazy image-ARN wiring and no-image branch, bootstrap deployment-role coverage, tests/suppressions and CloudFormation resource counts. Image-hook changes and runtime hook serving must deploy together; automatic suspension remains off until the compatible image is ready. The `microvm_approval_suspend_enabled` context defaults false and sets both the static opt-in and a live SSM parameter. Durable executions pin their original environment, so rollback must verify the live parameter is false to stop new suspends in existing executions. Resume, timeout handling and termination remain available. See the [supervisor runbook](./645-p3-supervisor.md#deployment-configuration-and-permissions) for drift/rollback details. Deploy matching source/image with false before controlled opt-in.

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
