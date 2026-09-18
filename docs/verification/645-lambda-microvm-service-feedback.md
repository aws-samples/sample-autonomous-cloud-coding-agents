# Lambda MicroVM service-team feedback tracker

Updated 2026-09-18. Working notes for the ADR-021 takeover. **Not submitted to the
service team.** Keep each item's evidence, question, service response and next
action here as verification continues.

P3 application acceptance is complete and automatic approval suspension is
enabled in the [normal deployment](./645-p3-normal-closure-20260918.md).
The dated investigations below preserve earlier deployment settings; the
service questions remain open. Account IDs are redacted from this public copy.

In plain language: a MicroVM is the worker's little computer. A lifecycle hook
is the doorbell AWS rings to tell it to start, pause or wake. An AWS request ID
is the receipt that lets the service team find a particular call.

| ID | Priority | Topic | Evidence/status |
|---|---|---|---|
| F01 | High; service diagnosis open | Accepted wake ends in connection refusal | Six recorded failures; pre-freeze connection closure verified; image 6.0 correction deployed and nine Durable workflows passed |
| F02 | High | Supported IAM conditions and misleading permission errors | Reproduced in earlier P2 work; current service behavior needs confirmation |
| F03 | Medium | A service-side hook timeline and structured failure details | Diagnostic improvement request based on F01 |
| F04 | Medium | `PENDING` also means restoring an existing worker | Observed live; our timer bug is fixed |
| F05 | Medium | HTTP connection handling across suspend/resume | Exact refusal correlates with expired idle connection; explicit close header deployed; service dispatch details still needed |
| F06 | Medium | Conditional operator-role requirement for VPC connectors | Earlier deployment failure; application setup fixed |
| F07 | P2/P3 acceptance gap | Run token retention and recovery without a worker ID | Guest-log recovery verified; maximum retention, post-expiry behavior and recovery without identity logs unknown |
| F08 | High; service diagnosis open | Generic wake-hook failure with an observed listener | Historical image 5.0 failure; PID 1 owned its listener after restore, with no resume hook entry; connection-close correction now deployed |
| F09 | Blocks native image refactoring | Image move passes preview but execution rejects tag schema | Exact one-image move rolled back; original image, version, tags and resource identities preserved |

## F01 — Wake request accepted, then the hook connection is refused

**Impact:** the user approves an action, but the worker stops before continuing.
The coordinator releases capacity correctly; the requested coding workflow
failed in these recorded cases. The application correction below passed P3
acceptance before automatic suspension was enabled.

The [September 17 follow-up](./645-p3-final-image-and-ecs-20260917.md) adds two
repository sleep/wake cycles, late approval winning, and wake after actual STS
expiry on normal image 6.0. The long-sleep worker remained suspended after its
old credentials expired, then renewed with identical identity tags and retained
its original approval deadline. All three workflows finalized without repair.
These are additional application acceptance results, not service-side traces
or a measured failure rate.

The [normal repository follow-up](./645-p3-repository-path-20260917.md) also
passes clone/setup, approval sleep/wake, build/lint and existing-PR resolution
on image 6.0, with unchanged GitHub content and verified private cleanup.

**Observed:** five failures on normal images `3.0`, `4.0` and `5.0`, plus a sixth
on a private image retaining 5.0's application and connection behavior with
transport probes, in `us-west-2`, September 15–16. AWS accepted `ResumeMicrovm`,
then reported:

> Resume lifecycle hook connection was refused. Please check your hook endpoint
> and application logs for more details.

The guest had returned HTTP 200 from `/suspend`; retained logs contain no
subsequent `/resume` access entry. Single-issuer cases exclude overlapping API
and coordinator Resume calls as a necessary cause.

**Best starting evidence for the service team:**

- Account `<account-id>`, region `us-west-2`, September 16, 21:14:27–21:15:30 UTC.
- Worker `microvm-bb1bfd4b-9ce3-3691-a60b-88f263081d43`, private image
  `backgroundagent-dev-p3-wake-transport-20260916:1.0`, original server PID 1.
- Resume receipt `74943bd5-cfd1-4781-9f10-9946566089e8`, accepted
  21:15:26.786 UTC. At 21:15:26.948, the restored event loop expired the old
  suspend connection's five-second idle timer. At 21:15:26.950, an independent
  observer saw PID 1 owning the original port-8080 listener. AWS terminated the
  worker at 21:15:27.471 with the exact refusal wording.
- No fresh HTTP connection or resume request appeared in the retained window.
  The [transport investigation](./645-p3-wake-transport-20260916.md)
  contains the full timeline and successful fresh-connection comparison.

**Earlier unmodified image 5.0 evidence:**

- Account `<account-id>`, region `us-west-2`, September 16, 17:09:39–17:10:42 UTC.
- Worker `microvm-6ff103ab-a41d-348b-8a56-721c9050b623`, image
  `backgroundagent-dev-abca-agent:5.0`, original server PID 1.
- Suspend receipt `98a53cab-7737-4675-944e-7a8202781149`; guest checkpoint
  succeeded and `/suspend` returned HTTP 200 at 17:09:40.186 UTC.
- Resume receipt `d32f9929-e7cb-4603-a6c1-0bd2a801f5b5`, acknowledged
  17:10:39.404 UTC; service termination timestamp 17:10:40.415 UTC.
- The instrumented guest logged no resume hook entry or subsequent callback
  stage. This case used a single supervisor wake before the original deadline,
  with no injected failure.
- [Prepared investigation report](./645-p3-resume-refusal-investigation.md)
  contains all five worker IDs, comparison runs and the complete example timelines.

**Ask:** inspect the service's restore and hook-transport records for these
receipts. Was this a TCP refusal from the guest listener, a stale connection,
a process exit, or a networking/restore failure? At what point did the service
consider the guest network and listener ready, and what underlying error did it
map to this reason?

**Limits:** the latest guest trace supports an old-connection race but cannot
show the service's actual dispatch error or socket choice. The Mac was the test
controller; the failing connection was inside AWS. Passing controls do not
establish a failure rate or discharge the earlier failures.

**Application correction:** the [normal rollout](./645-p3-connection-close-rollout-20260916.md)
deployed explicit close headers in image 6.0, with coordinator 10 and both sleep
switches off. Approval, denial, timeout and cancellation while asleep passed on
that image through a private real Durable coordinator and normal decision APIs.
Two unchanged sleeps longer than 90 seconds and three candidate cases passed;
the candidate trace verifies actual connection closure before freeze.

**Next:** obtain service-side dispatch details for the retained failures and
confirm supported connection handling across suspension. The application
evidence does not establish the exact service error in every historical case.
Service response: pending. F08 records an independently observed failed wake
with different wording; a shared cause remains unconfirmed.

## F02 — IAM conditions and errors make correct setup difficult

IAM roles are permission sets. A trust condition adds a rule about who may use
one. `PassRole` is permission to hand a role to a service.

**Earlier evidence:** the [ADR infrastructure decision](../decisions/ADR-021-lambda-microvms-compute-backend.md)
records August 6–7 tests in which:

- Trust policies using `aws:SourceAccount` / `aws:SourceArn` prevented the
  MicroVM-facing roles from being assumed. Removing those conditions restored
  the tested operations.
- A role-assumption problem surfaced as a caller-side `iam:PassRole` denial,
  despite an existing grant and an `allowed` policy simulation.
- A separate clean comparison found exact-role `iam:PassRole` with
  `iam:PassedToService: lambda.amazonaws.com` denied, while the same exact-role
  grant without that condition succeeded. The earlier contaminated comparison
  is explicitly corrected in the ADR.

**Impact:** a normal attempt to tighten permissions breaks deployment or launch,
and the error sends the operator to the wrong policy. Our integration contains
the verified setup and exact-resource restrictions.

**Ask:** publish the supported condition keys and values for build, execution,
connector-role assumption and both PassRole paths. Can the usual source/service
conditions be supported? Can errors distinguish missing caller permission from
failed target-role assumption? Is this behavior different in the current service?

**Limits:** these are earlier reproduced integration findings, not a fresh
September 16 comparison or a demonstrated security exploit. Service response:
pending; recheck the recommended recipe before changing our working policies.

## F03 — Expose the hook attempt that follows an accepted API request

**Observed:** a successful Resume response provides an API receipt, but does not
establish that the guest received or completed its hook. In F01, the remaining
service explanation is a human-readable `stateReason`. A hook that is never
reached cannot write its own application diagnostic.

**Our improvement:** [correlated lifecycle diagnostics](./645-p3-lifecycle-diagnostics.md)
now record hook entry/stage/result, PID, AWS receipts and coordinator state
changes. These passed isolated AWS verification and are
[deployed in coordinator 6 / image 5.0](./645-p3-diagnostics-rollout-20260916.md).
Two subsequent controlled missing-approval failures reached the guest, logged
the failed identity-read stage, returned HTTP 409 and surfaced specific failure
guidance through the deployed task API. This distinguishes an application
rejection from F01's missing hook-entry evidence.

The [command-race follow-up](./645-p3-command-races-20260916.md) additionally
records a checkpoint transaction rejected after cancellation, cancellation during
observed `SUSPENDING` / restore `PENDING`, and three consecutive status-read
failures. The latter now has specific platform-error guidance deployed in
coordinator 7 and verified through the normal task API. These controlled failures
and passing race cases do not explain F01.

F08 exposed another service message, `Resume lifecycle hook failed.`, without
an HTTP status or underlying connection error. The
[classifier correction deployed in coordinator 9](./645-p3-wake-feedback-20260916.md)
recognizes that observed wording and prevents misleading retry advice for newly
classified failures. Previously persisted stable error codes remain unchanged.
This does not establish why the service failed to complete the hook.

The subsequent image 6.0 / coordinator 10 rollout also classifies
`Resume lifecycle hook timed out` as a nonretryable service failure. Six normal
task-handler checks cover raw/legacy/stable timeout forms, refusal, generic
failure and preservation of an older stable code. They use synthetic terminal
records and verify feedback, not a new service failure.

**Ask:** provide a service-side lifecycle attempt timeline or equivalent
structured fields: originating API receipt, hook kind/attempt ID, start/end
times, connection versus HTTP failure, HTTP status, underlying error code and
whether a retry occurred. Link the attempt to worker/image identity and document
where customers can retrieve it after termination.

**Impact:** this would show whether the doorbell failed or the worker received it
and failed while getting ready. It would also reduce dependence on parsing
human-readable failure strings. Service response: pending.

## F04 — Document `PENDING` during restore

**Observed:** a real worker went `SUSPENDED → PENDING → RUNNING` after Resume.
The installed SDK has no separate `RESUMING` state. The
[pending-wake record](./645-p3-pending-wake.md) includes timestamps and a verified
older-worker case with an API-issued wake.

**Impact:** a client that treats every `PENDING` as first startup can use the
wrong timer. That was **our coordinator bug**; it is fixed and deployed in
coordinator version 5. It is separate from F01.

**Ask:** publish a complete lifecycle transition table, including observable
restore states, and consider an explicit restoring state or transition
kind/start timestamp. Clarify which timestamps retain the original worker
lifetime and which describe the current transition.

Service response: pending. Our next action is documentation/contract alignment,
not reopening the corrected timer bug.

## F05 — Clarify hook HTTP connections across a freeze

**Evidence:** some successful full-agent suspend/resume access logs used the
same peer port. An isolated Linux paused-process experiment reproduced a reset
of an old HTTP connection after a six-second pause, while every fresh connection
still succeeded. It did **not** reproduce an AWS connection refusal.
The interval from an observer's `SUSPENDED` sample is not the server's idle
connection age. The [timing correction](./645-p3-wake-transport-20260916.md#historical-timing-correction)
removes the earlier inference that short observed sleeps ruled out idle expiry.

See the [transport control](./645-p3-transport-control-20260916.md) and
[process-observer record](./645-p3-process-observer-20260916.md).

The [September 16 AWS comparison](./645-p3-diagnostics-rollout-20260916.md)
kept the original server as PID 1 and compared normal image 5.0 with a private
image differing only by `--timeout-keep-alive 0`. Quick approval wakes and
measured 10.205 / 8.697-second suspended holds passed on the respective images.
Both missing-approval controls reached the expected HTTP 409. Normal quick
cases reused the same client port; the longer normal wake and the connection-close
cases used fresh ports. No unexpected refusal or reset appeared.
Two original mistitled long-hold attempts are retained and excluded from that
acceptance; fresh corrected cases supplied the stated durations.

The later [instrumented transport investigation](./645-p3-wake-transport-20260916.md)
captured a 59.451-second event-loop gap, closure of the old suspend connection
by `timeout_keep_alive_handler`, a live PID 1 listener, and the exact F01 refusal
without a new HTTP connection. Its passing control closed the old socket and
accepted a fresh resume connection about two milliseconds later. The candidate
uses an explicit response header, not the earlier timer flag. All three candidate
cases verified response-driven closure before freeze, no armed idle timer on the
suspend connection, and a fresh resume connection.

That correction is now deployed in normal image 6.0. Four real Durable
approval/denial/timeout/cancellation workflows passed on the normal image;
the [rollout record](./645-p3-connection-close-rollout-20260916.md) includes
actual wake receipts, guest acknowledgments and final task/tool evidence.

**Ask:** does the service reuse hook TCP connections across suspend/resume,
honor `Connection: close`, and retry a failed reused connection on a fresh socket?
How are reset, refused and timeout errors classified? What ordering is guaranteed
between guest unfreeze, network restoration and hook delivery? Which clock
semantics should guest timeout/keep-alive timers expect across suspension?

**Limits:** the guest now records exact connection identity and timer closure,
but it cannot expose the service client's pool or failed dispatch. A paused
Linux process is not an AWS MicroVM restore, and the earlier timer-flag comparison
did not reproduce F01. The normal image now sends explicit close headers; these
passing cases do not reveal the service's earlier dispatch error.
Service response: pending; retain the service contract questions above.

## F06 — Make the VPC connector role requirement obvious before deployment

**Earlier evidence:** the generated CloudFormation/CDK property allowed omitting
`operatorRole`, but a `VPC_EGRESS` connector failed with:

> NetworkConnectorOperatorRole is required for VPC_EGRESS connector type

The [P1 live runbook](./645-p1-lambda-microvm-runbook.md) records the July 31
failure and successful operator-role setup. Our construct now supplies that role.

**Ask:** document or validate this conditional requirement in the schema/CDK
surface, with a complete example of the trust and ENI/tag/private-IP permissions.
Clarify whether a service-linked role is ever an alternative for this connector.

**Limits:** an optional property can be correct for other connector types. This
is a request for clearer conditional validation and setup guidance, not a claim
that every connector requires the same role. Service response: pending.

## F07 — Specify Run token retention and recovery after a lost reply

A client token is an order number: repeating the same launch request with that
number should recover the original worker instead of ordering another one.

**Evidence:** the [start/recovery probes](./645-p2-start-recovery-live-20260914.md)
verified simultaneous identical calls, changed-request rejection and replay of a
terminated worker through roughly five minutes. A replayed Run response could
still report `PENDING`; a separate Get correctly reported the worker's current
state. The installed SDK documents idempotency but gives no token-retention
duration. ABCA therefore stops automatic recovery without a saved handle after
its own conservative 120-second deadline.

**Public documentation recheck (September 17):** the
[RunMicrovm API reference](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html)
is now reachable. It describes `clientToken` as “A unique, case-sensitive
identifier you provide to ensure the idempotency of the request,” with a
1–128-character limit. It still gives no retention duration or post-expiry
behavior. Its request schema has no per-worker tags field. This resolves the
earlier documentation-access problem, not the missing service contract.

The same recheck of [ListMicrovms](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_ListMicrovms.html)
and [GetMicrovm](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_GetMicrovm.html)
found no returned client token, task identity, environment or per-worker tags.
List supports image/version filtering and returns the worker ID, image,
start time and state. Get adds the endpoint, execution role, connectors,
duration/idle settings and termination details. These fields can narrow an
operator's search, but shared image/role/time matches do not uniquely identify
the worker for a lost launch response.

**Impact:** if AWS created a worker but its response was lost, an operator needs
to find that exact worker. An undocumented retention boundary prevents proving
that a late retry cannot create another one. ABCA must not invent a new token
or automatically submit a replacement task to hide the uncertainty.

**Ask:** what is the guaranteed token-retention period, including after worker
termination or image-version changes? After expiry, is the same token rejected
or treated as a new launch? Which supported API, event or audit field maps the
original token/API receipt to the worker ID when the client never received it?
How long does that mapping remain available?

**CloudTrail check:** at 17:36 UTC on September 16, event-history lookup for the
known image 5.0 launch at 17:08:54 UTC found no `RunMicrovm` event. The complete
17:08:45–17:09:05 window contained 74 events, including `GetMicrovm`,
`ListMicrovms` and `GetMicrovmImageVersion` from `lambda.amazonaws.com`.
Only event names, sources and window metadata were retained. This observation
does not establish the logging contract or exclude later delivery. Is Run a
management or data event, and what audit configuration is required to retain
the launch token-to-worker mapping?

**Recovery follow-up:** the [September 16 durable check](./645-p3-registration-20260916.md)
discarded both accepted Run responses without saving their worker IDs. After the
task failed, the operator recovered the still-running worker from an exact
task/worker pair in its accepted `/run` guest log, checked its service identity
and terminated it. No Read result occurred and no replacement worker was
launched. This is a verified operator path when identity logs exist; it is not
a service token lookup or automatic recovery.

**Limits:** five minutes of successful replay does not establish the maximum
retention period. The 120-second limit is ABCA policy, not an AWS guarantee.
Post-expiry behavior and recovery without unambiguous guest identity logs remain
unverified. Service response: pending.

## F08 — Generic wake-hook failure while PID 1 owns its listener

**Observed:** September 16, 18:55:13–18:56:16 UTC, account `<account-id>`,
region `us-west-2`. A diagnostic image kept the original server as PID 1 and
added a separate observer child. Application code, connection keepalive,
8,192 MiB and lifecycle hooks matched normal image 5.0.

- Worker: `microvm-da3668f9-04a6-393c-939a-33c059e4b2a0`.
- Image: `backgroundagent-dev-p3-pid1-observer-20260916:1.0`.
- Task: `01M2NRA1BNVMXGD5YDVYD4XH4T`.
- Suspend receipt: `802e1264-4569-49ef-aada-70be7c26e71b`; guest checkpoint
  and suspend HTTP 200 completed at 18:55:14.013.
- Resume receipt: `11bc8d9b-ada5-440e-aef3-034d8ac04848`, accepted at
  18:56:13.121.
- At 18:56:13.350, observer PID 7 saw PID 1 running and owning its port-8080
  listening socket, inode `481`, which also existed before the freeze.
- AWS terminated the worker at 18:56:13.869 with
  `Resume lifecycle hook failed. Please check your hook endpoint and application logs for more details.`
  The retained log contains no resume hook entry, stage or access line.

**Ask:** what exact connection/HTTP error maps to this generic reason? For this
receipt, was the hook attempted on a fresh or reused socket, what bytes/status
were received, and was another connection attempted before termination?
Does the service retain the hook-attempt timeline separately from the API
receipt? Compare it with the six exact connection refusals in F01.

**Limits:** the observed process and listener existed 519 ms before termination.
This does not prove continuous health or event-loop responsiveness, and it does
not establish whether this failure shares F01's cause. The diagnostic process
can affect scheduling. The [full record](./645-p3-pid1-observer-20260916.md)
retains the passing comparison, excluded fixture assertion, sampled state,
timestamps and failure. Service response: pending.

## F09 — Image refactor preview passes but execution rejects the tag schema

**Observed:** September 17, 13:52–13:54 UTC, account `<account-id>`,
region `us-west-2`. A freshly built isolated nested deployment used the production
MicroVM construct and image artifact. The test attempted to move only the image's
CloudFormation ownership from child to parent; no worker was running.

- Image: `abca-645-refactor-probe-20260917:1.0`.
- Parent stack: `backgroundagent-dev-p3-refactor-20260917`, ID suffix
  `434bf610-b29c-11f1-8640-0624a84210c3`.
- Child stack ID suffix: `44ff4b60-b29c-11f1-8386-06d8ca482b91`.
- Refactor: `b439bca8-a95f-4716-970d-dfad7c5b30d7`.
- Create request: `12b4130e-07ec-4540-aa80-81be74899243`.
- Execute request: `6f195c46-c1a5-4f40-912c-9fdc362eeac6`,
  accepted at `2026-09-17T13:52:48.582Z`.
- Preview: `CREATE_COMPLETE` / `AVAILABLE`, one `MOVE`, with
  `No configuration changes detected.` Both user tags would be preserved.
- Execution: `ROLLBACK_COMPLETE`, with:
  `Stack Refactor does not support AWS::Lambda::MicrovmImage because the resource type defines an unsupported tag schema.`

**Impact:** existing images cannot use this native stack-refactor path to move
into the requested nested layout. The successful preview does not expose the
failure before execution. The normal deployment was not modified. Independent
rollback checks confirmed the image's original ARN, only version 1.0, settings,
tags and all 21 resource identities.

**Schema evidence:** `DescribeType` reports `FULLY_MUTABLE` and updatable tags.
`Tags` is an array of objects whose `required` list contains only `Key`; `Value`
is optional. `AWS::Lambda::NetworkConnector` has the same shape. By comparison,
S3 requires both `Key` and `Value`. The exact internal rejection condition and
connector behavior have not been established.

**Ask:** can the MicroVM image provider support CloudFormation stack refactoring,
or document a supported image-preserving retain/import procedure? Is the
optional tag `Value` causing the schema rejection, and does the connector need
the same correction? Can the preview perform this validation before making the
operation executable? Please also confirm how refactoring preserves an explicit
resource tag that overlaps a source-stack tag.

The [nested-stack record](./645-p3-nested-stack.md#image-ownership-refactor-execution-rejected-rollback-verified)
contains the preparation controls, exact receipts and rollback evidence.
Service response: pending. This feedback has not been submitted.

## Updating this tracker

For each new finding, add the actual trigger, UTC window, region, worker/image
versions, AWS receipt IDs, impact, smallest supported conclusion and a concrete
service question. Link raw evidence through the verification report. Retain
unsuccessful controls and distinguish application fixes from service findings.
Record any service answer and the verification needed before closing the item.
