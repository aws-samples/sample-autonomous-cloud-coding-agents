# Lambda MicroVM service-team feedback

These questions come from the P1–P3 integration, most recently checked in
September 2026. They are not confirmed service defects in every Region/build.
Detailed worker timelines and receipts are archived privately for escalation.
No service-side trace confirmation has been obtained for the historical wakes.

## Hook transport and diagnostics (F01, F03, F05, F08)

**Observed:** some Resume API calls succeeded, then workers terminated with
“Resume lifecycle hook connection was refused” or the generic hook-failed reason.
In instrumented cases, the guest listener remained present and no new resume
handler entry was logged. Local paused-process controls reproduced failure when
reusing an old HTTP connection; a fresh connection succeeded. Longer-sleep
controls and explicit connection-close responses passed live checks.

**Application correction:** lifecycle responses send `Connection: close` before
freeze. Approve/deny/expiry/cancellation and repeated wakes passed with that
correction. Passing controls do not prove the exact service error for each
historical worker.

**Ask:** confirm the deployed hook client's pooling/retry behavior, whether stale
connections can survive suspend, and supported clock/timer semantics on restore.
Consider retiring pooled connections at suspend or retrying a failed dispatch on
a fresh connection. Distinguish refused connections, resets, incomplete responses
and timeouts in customer-visible errors. Expose hook-attempt timestamps, error
classification and correlation to the originating API receipt. A failed hook
that never reaches the guest cannot emit its own application log.

## IAM setup (F02)

**Observed:** tested source-conditioned role trust and `iam:PassedToService`
conditions rejected operations that worked without those conditions. A target-role
assumption problem also appeared as a caller-side PassRole denial. These are
historical integration findings, not a fresh comparison of every service build.

**Ask:** document supported keys/values for build, execution and connector-role
assumption and both PassRole paths. Distinguish caller authorization failures
from target-role trust failures. Recheck service support before tightening the
working exact-role grants; IAM simulation alone does not establish which
condition values the service sends.

## Restore state and connector schema (F04, F06)

A worker was observed going `SUSPENDED → PENDING → RUNNING`. ABCA now distinguishes
restore from first startup using saved lifecycle intent. Publish the complete
transition/timestamp contract or expose a restoring state.

A `VPC_EGRESS` connector required an operator role despite the generated property
being optional. Add conditional validation and a complete role/permission example;
this does not imply other connector types need the same role.

## Lost Run response and idempotency (F07)

ABCA preserves the exact Run request/token and bounds automatic replay. A lost
successful response can still leave a running worker with no saved handle.
Matching an image, role and start window is not a unique task identity. Accepted
guest identity logs allowed manual recovery in a tested case.

**Ask:** specify token retention, behavior after expiry/termination/image changes,
and a supported token or request-ID lookup that returns the original worker.
Clarify required CloudTrail event configuration and retention. ABCA's 120-second
replay policy and observed successful replays are not service guarantees.

## CloudFormation refactoring (F09)

An image refactor preview succeeded, but execution rejected
`AWS::Lambda::MicrovmImage` because of an unsupported tag schema. Rollback
preserved the original image/resources.

**Ask:** support image ownership refactoring or reject unsupported moves during
preview; publish a supported migration procedure. Until verified otherwise, use
the [overlap migration prerequisites](./645-p3-nested-stack.md), not a direct
flat-to-nested template switch.
