# ADR-021 P3: intermittent resume-hook connection refusal

Updated 2026-09-16 UTC. This is an investigation record and a prepared report;
it has not been submitted to AWS or published as an issue.

## Observed problem

An automatically suspended worker sometimes terminates immediately after AWS
acknowledges `ResumeMicrovm`. Its final `stateReason` is:

> Resume lifecycle hook connection was refused. Please check your hook endpoint
> and application logs for more details.

The guest previously returned HTTP 200 from `/suspend`. Its retained application
stream has no subsequent `/resume` access log. This does not prove the guest
process stayed healthy: application logs alone cannot distinguish a listener,
process, network-restoration or hook-transport failure.

The coordinator detects termination, marks the task failed and releases its
capacity reservation. Successful failure cleanup does not make the requested
approval workflow successful.

## Recorded failures

All times are UTC, in `us-west-2`, on image `backgroundagent-dev-abca-agent`.
The earlier cases are detailed in the
[durable verification record](./645-p3-durable-live-20260915.md).

| Case | Image | Worker | Termination |
|---|---|---|---|
| Approval | `3.0` | `microvm-c1d17307-e488-3149-b2c9-5d7f25f6278e` | Sep 15, 21:31:46.958 |
| Approval after coordinator process-crash recovery | `3.0` | `microvm-9e6bdb3f-bc10-3921-9c50-287bbe20b574` | Sep 15, 21:56:56.279 |
| Supervisor repair after an injected inline Resume failure | `3.0` | `microvm-dca019ee-7d19-389e-b90b-bde129f77329` | Sep 15, 22:54:45.753 |
| Supervisor wake after an owned approval record was deleted | `4.0` | `microvm-2da070a7-43cf-3bb3-9c5d-69bc106f2cb1` | Sep 16, 00:25:07.524 |

### Image 4.0 request timeline

The last case used source `58ed7bbf`'s image, including the explicit approval
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
  cancellation: the latest failure happened less than a minute after its gate
  was created, with minutes still remaining.
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
in the supervisor. Its correction does not account for these four failures,
whose worker termination reason was the service-reported connection refusal.

The [full-agent observer experiment](./645-p3-process-observer-20260916.md)
adds the independent parent and listener sampling described below. Its completed
fallback and direct API wakes retained a healthy child-owned listener, without
reproducing the refusal. Short full-agent cases reused the same client port for
`/suspend` and `/resume`, unlike the minimal listener's closed connections.
That is an observed transport difference, not an established cause. None of
the four original failures has independent process/listener evidence at restore,
and the guest does not expose the cgroup OOM counters sampled by the observer.

1. Use the recorded worker IDs, region, timestamps and Resume request IDs to
   inspect service-side lifecycle diagnostics. Determine the actual connection
   error and whether the request reached the guest, including any transport retry.
2. Correlate guest process/kernel health and the port-8080 listener at restoration.
   Application access logs do not provide that missing evidence.
   The diagnostic parent now supplies these observations in successful controls;
   a refusal must be captured with those observations to make the comparison.
   Preserve the original image and use fixed, bounded owned cases if further
   testing is justified by a specific transport or process hypothesis.
3. If a transport or application race is identified, make a bounded correction
   and test that trigger specifically. Do not hide a failed wake by silently
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
