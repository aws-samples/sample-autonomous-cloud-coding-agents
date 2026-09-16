# ADR-021 P3: intermittent resume-hook connection refusal

**Latest September 16 follow-up:** the
[HTTP connection investigation](./645-p3-wake-transport-20260916.md#exact-refusal-with-connection-and-listener-evidence)
captured a sixth exact refusal. The old connection's five-second idle timer
expired at restoration; PID 1 still owned its listener, and no fresh HTTP
connection or resume request appeared. Three explicit `Connection: close`
candidate cases passed on a private image, proving closure before freeze and
fresh resume connections. Normal-image rollout and acceptance remain separate
steps; automatic suspension remains disabled.

An earlier
[diagnostic retaining the original PID 1 server](./645-p3-pid1-observer-20260916.md)
captured a separate wake failure with the generic reason
`Resume lifecycle hook failed.` An independent child observed PID 1 owning its
listening socket after restoration, approximately 519 ms before AWS terminated
the worker. No resume hook entry appeared. This adds process/listener evidence
for that new failure; it does not establish the cause of the five exact
connection refusals below. The service question is tracked separately as
[F08](./645-lambda-microvm-service-feedback.md#f08--generic-wake-hook-failure-while-pid-1-owns-its-listener).

Updated 2026-09-16 UTC. This is an investigation record and a prepared report;
it has not been submitted to AWS or published as an issue.
The [service-team feedback tracker](./645-lambda-microvm-service-feedback.md)
keeps this blocker alongside related service questions and earlier P2 findings.

## Observed problem

An automatically suspended worker sometimes terminates immediately after AWS
acknowledges `ResumeMicrovm`. Its final `stateReason` is:

> Resume lifecycle hook connection was refused. Please check your hook endpoint
> and application logs for more details.

The guest previously returned HTTP 200 from `/suspend`. Its retained application
stream has no subsequent `/resume` access log. Application logs alone cannot
distinguish a listener, process, network-restoration or hook-transport failure.
The latest case adds an independent listener sample and exact idle-timer closure;
the first five cases below did not capture those observations.

The coordinator detects termination, marks the task failed and releases its
capacity reservation. Successful failure cleanup does not make the requested
approval workflow successful.

The [lifecycle diagnostics guide](./645-p3-lifecycle-diagnostics.md) documents
the new logging and wake-failure feedback. Three isolated AWS workflows verified
the instrumentation with the original server running as PID 1, including actual
API wake and coordinator recovery. None reproduced refusal. The
[normal-stack rollout](./645-p3-diagnostics-rollout-20260916.md) now runs coordinator
version 9 and image 5.0 after subsequent coordinator fixes. The fifth failure
on image 5.0 includes those application diagnostics, as recorded below.

## Recorded failures

The first five failures below are on image `backgroundagent-dev-abca-agent`.
All times are UTC, in `us-west-2`. The sixth, on an instrumented private image
derived from 5.0, has its [own detailed timeline](./645-p3-wake-transport-20260916.md#exact-refusal-with-connection-and-listener-evidence).
The earlier cases are detailed in the
[durable verification record](./645-p3-durable-live-20260915.md).

| Case | Image | Worker | Termination |
|---|---|---|---|
| Approval | `3.0` | `microvm-c1d17307-e488-3149-b2c9-5d7f25f6278e` | Sep 15, 21:31:46.958 |
| Approval after coordinator process-crash recovery | `3.0` | `microvm-9e6bdb3f-bc10-3921-9c50-287bbe20b574` | Sep 15, 21:56:56.279 |
| Supervisor repair after an injected inline Resume failure | `3.0` | `microvm-dca019ee-7d19-389e-b90b-bde129f77329` | Sep 15, 22:54:45.753 |
| Supervisor wake after an owned approval record was deleted | `4.0` | `microvm-2da070a7-43cf-3bb3-9c5d-69bc106f2cb1` | Sep 16, 00:25:07.524 |
| Supervisor wake before the original approval deadline | `5.0` | `microvm-6ff103ab-a41d-348b-8a56-721c9050b623` | Sep 16, 17:10:40.415 |

### Image 5.0 diagnostic timeline

Task `01M2NHJ8YSRTRY3XPT06SHT9QD` used the normal image and original server
as PID 1, with a 150-second approval window and a custom 30-second sleep delay.
The private coordinator ran source `a81c565d`; this case did not inject a
command or guest failure. The intended check was an approval timeout winning
before a subsequent approval API call. The unexpected refusal prevented that
check from reaching its decision race.

| Time on Sep 16 | Evidence |
|---|---|
| 17:09:09 | Read approval created; original deadline 17:11:39 |
| 17:09:39.879 | Supervisor sends Suspend |
| 17:09:39.940 | AWS accepts; request `98a53cab-7737-4675-944e-7a8202781149` |
| 17:09:39.971 | Guest logs suspend hook entry, PID 1 |
| 17:09:40.185 | Checkpoint transaction and controller finish; hook acknowledges HTTP 200 after 214 ms |
| 17:09:40.186 | HTTP access log records `/suspend` 200 |
| 17:09:41.524 | Observer reads `SUSPENDED` |
| 17:10:39.344 | Supervisor sends its sole Resume, about 60 seconds before the original deadline |
| 17:10:39.404 | AWS accepts; request `d32f9929-e7cb-4603-a6c1-0bd2a801f5b5` |
| 17:10:40.415 | Service records termination with the connection-refused reason |
| 17:10:41.716 | Coordinator writes `FAILED` with `MICROVM_RESUME_HOOK_FAILED` |
| 17:10:41.752 | Coordinator releases the task's reservation |

The fully paginated guest log window contains no resume hook entry, callback
stage, HTTP access record or later application output. Thus the newly
instrumented credential-refresh and identity-reconciliation callbacks did not
leave evidence of starting. This does not establish that the process or
listener survived restoration. The failed harness subsequently called its
idempotent cleanup helpers; the task's recorded failure and reservation release
predate that fallback, but this case is excluded from successful lifecycle
acceptance.

Four preceding settings/decision cases completed: the default sleep request
occurred after 600.385 seconds, an explicit off setting never requested sleep,
a custom delay requested sleep after 30.395 seconds, and an approval committed
after the deadline won its conditional decision race. These passing controls
do not explain or discharge this fifth failure.

### Image 4.0 request timeline

The image 4.0 case used source `58ed7bbf`'s image, including the explicit approval
callback timeout. Task ID: `01M2KRWNPP4BQCJ80SVG6473Z8`.

| Time on Sep 16 | Evidence |
|---|---|
| 00:24:31 | Read approval created with its original 600-second window |
| 00:25:01.476 | Supervisor sends Suspend |
| 00:25:01.534 | Suspend acknowledged; request `e2199854-5ad0-46c9-bc59-248ac68ead82` |
| 00:25:01.657 | Guest `/suspend` returns HTTP 200 |
| 00:25:04.601 | Independent observer sees `SUSPENDED` |
| 00:25:04.767 | Fixture conditionally deletes only its own still-pending approval |
| 00:25:06.696 | Supervisor sends the sole Resume request |
| 00:25:06.766 | Resume acknowledged; request `0acb3fec-8b18-4bed-b457-0271a15ffdd6` |
| 00:25:07.524 | AWS records termination with the connection-refused reason |
| 00:25:11.935 | Coordinator releases the task's reservation |

No decision API was invoked in this case. No Read result was produced. The
coordinator left an empty payload prefix and counter zero without independent
cleanup. The intended missing-approval check still failed acceptance because
the guest's expected HTTP 409/503 response was not observed.

A single fresh control, task `01M2KSTSR1V31NTPQ0CKCJJJMN`, worker
`microvm-a093863f-edf0-39f4-9d79-6893ff08042c`, did reach `/resume`, which returned
HTTP 409 at 00:30:46.418Z after the same owned-approval deletion. AWS reported
the HTTP status explicitly. No tool ran and cleanup passed. Thus the missing
record can produce the expected application error, distinct from the refusal.

## What the comparison establishes

Six fresh approval tasks used identical production coordinator code, five-second
polling, a 600-second gate and one read-only action: three on image `3.0`, then
three on `4.0`. All six completed automatic suspension, HTTP 200 resume, exactly
one approved Read and untouched coordinator cleanup.

The image `4.0` refusal above happened afterward. Therefore:

- The failure is intermittent in the observed runs.
- The explicit callback-timeout fix does not eliminate it.
- Overlapping API/supervisor Resume requests are not required. Both the
  process-crash case and the supervisor-only cases exclude that explanation.
- The observed failure is separate from the old ten-minute Claude callback
  cancellation: the image 4.0 case failed less than a minute after its gate
  was created; the image 5.0 case failed before its original deadline.
- These runs do not establish a failure rate or identify the responsible
  component.

The [guest lifecycle HTTP handler](../../agent/src/microvm_http.py) and
[pause controller](../../agent/src/microvm_lifecycle.py) were reviewed.
Suspend drains tracked work and checkpoints; it does not intentionally close
the HTTP listener. The server's shutdown path is separate. That source review
does not exclude a process crash or a lower-level restore problem.

## Next investigation

The [minimal listener experiment](./645-p3-listener-probe-20260916.md) completed
four full normal cases and recorded 14 guest resume acknowledgments without an
unexpected refusal. Request timeouts interrupted three cases. A fresh deliberate
closed-listener control produced the exact refusal reason while an independent
observer still ran in the guest. This calibrates the diagnostics; it does not
establish why the full agent loses its listener or connection.

That experiment also exposed a separate [pending-wake timer bug](./645-p3-pending-wake.md)
in the supervisor. Its correction does not account for these failures,
whose worker termination reason was the service-reported connection refusal.

The [full-agent observer experiment](./645-p3-process-observer-20260916.md)
adds the independent parent and listener sampling described below. Its completed
fallback and direct API wakes retained a healthy child-owned listener, without
reproducing the refusal. Short full-agent cases reused the same client port for
`/suspend` and `/resume`, unlike the minimal listener's closed connections.
That experiment established a transport difference. None of the first five
recorded failures has independent process/listener evidence at restore; the
sixth now does. The guest does not expose the cgroup OOM counters sampled by
the observer.

The subsequent [local transport control](./645-p3-transport-control-20260916.md)
reproduced a reset on an old connection after a six-second process pause, while
all eight fresh-connection checks succeeded and the servers remained alive.
This is not a reproduction of the AWS refusal. It supplies a specific comparison
for the next cloud investigation without establishing a production fix.

The [AWS connection comparison](./645-p3-diagnostics-rollout-20260916.md) has now
tested normal image 5.0 against a private image with HTTP connection reuse
disabled, keeping the original server as PID 1. Both quick and longer wakes
passed, and both missing-approval controls produced the expected guest HTTP 409
with a failed identity-read stage. The longer normal wake used a fresh client
port; quick normal wakes reused one. No refusal was reproduced. These results
do not identify F01's cause or justify a production connection-setting change.

1. Use the recorded worker IDs, region, timestamps and Resume request IDs to
   inspect service-side lifecycle diagnostics. Determine the actual connection
   error and whether the request reached the guest, including any transport retry.
2. Correlate guest process/kernel health and the port-8080 listener at restoration.
   Application access logs do not provide that missing evidence.
   The latest failure now supplies these observations with the original PID 1.
   Compare its expired connection against the successful fresh-connection wake.
3. Verify the explicit close response on a private candidate image, including
   its actual socket closure before freeze and fresh connection after restore.
   Do not hide a failed wake by silently
   launching another worker: the approved action and workspace may already have
   changed.
4. Repeat approval, denial, original/late deadline, multiple-gate persistence and
   expired-credential cases on the corrected image. Keep the previous failures
   in the evidence record.
5. Leave production automatic suspension off until this gate and the
   [remaining acceptance plan](./645-p3-implementation-plan.md) are satisfied.

The private evidence archive contains full guest streams, redacted control
request telemetry, durable history and task events. It contains no saved AWS
credential values in the report. Temporary verification resources are tracked
separately in the [callback live record](./645-p3-callback-live-20260915.md).
