# Lambda MicroVM service-team feedback tracker

Updated 2026-09-16. Working notes for the ADR-021 takeover. **Not submitted to the
service team.** Keep each item's evidence, question, service response and next
action here as verification continues.

In plain language: a MicroVM is the worker's little computer. A lifecycle hook
is the doorbell AWS rings to tell it to start, pause or wake. An AWS request ID
is the receipt that lets the service team find a particular call.

| ID | Priority | Topic | Evidence/status |
|---|---|---|---|
| F01 | P3 blocker | Accepted wake ends in connection refusal | Four recorded failures; responsible component unknown |
| F02 | High | Supported IAM conditions and misleading permission errors | Reproduced in earlier P2 work; current service behavior needs confirmation |
| F03 | Medium | A service-side hook timeline and structured failure details | Diagnostic improvement request based on F01 |
| F04 | Medium | `PENDING` also means restoring an existing worker | Observed live; our timer bug is fixed |
| F05 | Medium | HTTP connection handling across suspend/resume | Contract question; no established cause of F01 |
| F06 | Medium | Conditional operator-role requirement for VPC connectors | Earlier deployment failure; application setup fixed |

## F01 — Wake request accepted, then the hook connection is refused

**Impact:** the user approves an action, but the worker stops before continuing.
The coordinator releases capacity correctly; the requested coding workflow
still fails. This prevents enabling automatic suspension for normal tasks.

**Observed:** four failures on images `3.0` and `4.0` in `us-west-2`, September
15–16. AWS accepted `ResumeMicrovm`, then reported:

> Resume lifecycle hook connection was refused. Please check your hook endpoint
> and application logs for more details.

The guest had returned HTTP 200 from `/suspend`; retained logs contain no
subsequent `/resume` access entry. Single-issuer cases exclude overlapping API
and coordinator Resume calls as a necessary cause.

**Best starting evidence for the service team:**

- Account `<account-id>`, region `us-west-2`, September 16, 00:25:01–00:25:12 UTC.
- Worker `microvm-2da070a7-43cf-3bb3-9c5d-69bc106f2cb1`, image
  `backgroundagent-dev-abca-agent:4.0`.
- Suspend receipt `e2199854-5ad0-46c9-bc59-248ac68ead82`.
- Resume receipt `0acb3fec-8b18-4bed-b457-0271a15ffdd6`, acknowledged
  00:25:06.766 UTC; terminal refusal observed 00:25:07.524 UTC.
- [Prepared investigation report](./645-p3-resume-refusal-investigation.md)
  contains all four worker IDs, comparison runs and the complete example timeline.

**Ask:** inspect the service's restore and hook-transport records for these
receipts. Was this a TCP refusal from the guest listener, a stale connection,
a process exit, or a networking/restore failure? At what point did the service
consider the guest network and listener ready, and what underlying error did it
map to this reason?

**Limits:** no root cause is established. The Mac was the test controller; the
failing connection was between AWS and the guest inside AWS. Later successful
controls, including three with the original server as PID 1, do not prove this
defect fixed or establish a failure rate.

**Next:** retain a fresh failure with independent process/listener evidence,
or obtain the service-side evidence above. Service response: pending.

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
changes. These passed isolated AWS verification. Normal-stack rollout is pending.

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
still succeeded. It did **not** reproduce an AWS connection refusal. Some F01
failures followed suspension by less than five seconds.

See the [transport control](./645-p3-transport-control-20260916.md) and
[process-observer record](./645-p3-process-observer-20260916.md).

**Ask:** does the service reuse hook TCP connections across suspend/resume,
honor `Connection: close`, and retry a failed reused connection on a fresh socket?
How are reset, refused and timeout errors classified? What ordering is guaranteed
between guest unfreeze, network restoration and hook delivery? Which clock
semantics should guest timeout/keep-alive timers expect across suspension?

**Limits:** matching peer ports suggest reuse but do not establish all transport
behavior. A paused Linux process is not an AWS MicroVM restore. Connection-close
behavior is a proposed comparison, not an established fix. Service response:
pending.

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

## Updating this tracker

For each new finding, add the actual trigger, UTC window, region, worker/image
versions, AWS receipt IDs, impact, smallest supported conclusion and a concrete
service question. Link raw evidence through the verification report. Retain
unsuccessful controls and distinguish application fixes from service findings.
Record any service answer and the verification needed before closing the item.
