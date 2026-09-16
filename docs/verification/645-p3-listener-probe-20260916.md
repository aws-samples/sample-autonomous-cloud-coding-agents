# ADR-021 P3: isolate the resume connection failure

Verified 2026-09-16 UTC. This diagnostic experiment follows the four
[resume-hook connection refusals](./645-p3-resume-refusal-investigation.md).
The original refusal did not recur in this bounded sample. The deliberate
closed-listener control produced the expected refusal. All temporary resources
were removed; the production image and both suspension switches are unchanged.

## Question and scope

Can a small HTTP listener reproduce the refusal without the coding agent?
The [probe](../../agent/scripts/microvm_lifecycle_listener_probe.py) uses Python's
standard library to serve the six lifecycle hooks. It makes no AWS SDK calls,
runs no coding task, and receives no repository or tenant configuration.

The owned image uses the same managed base `al2023-1`, base version `1.0`,
ARM64 architecture, 8,192 MiB memory and hook budgets as production image `4.0`.
Its Dockerfile uses the same pinned Python base:

```text
python:3.13-slim@sha256:dc1546eefcbe8caaa1f004f16ab76b204b5e1dbd58ff81b899f21cd40541232f
```

It has its own build/runtime roles and log group. The build role can read only
the diagnostic artifact; both roles can write only diagnostic logs. Each worker
uses the existing restricted runtime connector, explicit `NO_INGRESS` and a
300-second maximum lifetime. A standalone operator runner controls only workers
belonging to this uniquely named image.

This is not the production ASGI server, approval controller or durable
coordinator. Responses explicitly close each accepted HTTP connection so the next
hook must contact the listener again. Success here would not prove the full
application or its keep-alive behavior correct.

## Evidence collected

The probe writes structured stdout records for request entry, acknowledgment,
listener health, process signals and clock gaps across suspension. `/run` creates
a random disposable marker; each `/resume` checks its original hash and records
the retained suspend/resume counts.

The failure control deliberately stops and closes the listening socket during
`/suspend`, then sends HTTP 200 on the already accepted connection. The process
remains alive, and its observer can report that the listener is closed. That
case must not be counted as an unexpected platform failure.

Locally, three normal cycles retained the same marker. The failure control
acknowledged suspension and a new connection then failed with `ECONNREFUSED`.
The two subprocesses were terminated after verification. Ruff, formatting and
type checks passed.

## Fixed live matrix

| Cases | Time from observing `SUSPENDED` to requesting Resume | Cycles per worker |
|---|---|---|
| `delay-0-a`, `delay-0-b` | No additional delay | 3 |
| `delay-2-a`, `delay-2-b` | 2 seconds | 3 |
| `delay-10-a`, `delay-10-b` | 10 seconds | 3 |
| `closed-listener` | 2 seconds; deliberate refusal control | 1 |

The six normal cases target 18 wakes. Failed workers are not replaced or retried
until a case passes. Request IDs, actual state observations, guest records and
termination evidence are retained for each case. A launch whose response is lost
is recovered by enumerating this owned image's workers for cleanup.

Before these cases, the private runner incorrectly sent runtime image version
`1`; AWS rejected all seven requests without creating a worker. Their records
are retained separately. The corrected request uses `1.0`, matching the image's
published version. This differs from `CreateMicrovmImage.baseImageVersion`,
which requires the major version string `1` despite returning `1.0` in reads.

## Interpretation and cleanup

The completed matrix produced four fully passing normal cases, 13 cycles with
all runner checks, and 14 successful resume acknowledgments in guest logs.
Three cases were interrupted by 15-second AWS request timeouts:

| Case | Fully checked cycles | Result |
|---|---|---|
| `delay-0-a` | 3 | Passed |
| `delay-0-b` | 0 | Read-side timeout; one successful guest resume is recorded |
| `delay-2-a` | 3 | Passed |
| `delay-2-b` | 3 | Passed |
| `delay-10-a` | 3 | Passed |
| `delay-10-b` | 1 | Second Suspend request timed out; guest logs prove it nevertheless acknowledged suspension |
| `closed-listener` | 0 | Timeout before the runner requested suspension |

These interruptions remain incomplete tests. An API timeout is not proof that
the operation never occurred. The runner terminated the owned workers without
issuing replacement runs for these cases.

One fresh control, `closed-listener-r2`, used a bounded 45-second request timeout.
Worker `microvm-2167fc9d-21bf-35f3-a3fc-f340813f03a8` deliberately closed its
listener at 03:16:07.093Z and acknowledged `/suspend` on the existing connection.
Resume request `96147502-07f3-4512-9397-0cf1063cca67` was acknowledged at
03:16:10.143Z. At 03:16:10.420Z the observer still ran as PID 1, reporting a
closed listener. AWS recorded termination at 03:16:10.811Z with exactly the
original connection-refused reason. No `/resume` request entered the handler.
This passes the intentional failure control; it is not a fifth unexplained
refusal.

The normal cases show non-reproduction in a small, different application.
They do not clear the four original failures or identify their cause. The next
useful evidence is listener/process health in the full agent image.

The experiment also observed `PENDING` during real restoration. That exposed a
separate [supervisor timer bug](./645-p3-pending-wake.md), reproduced and corrected
locally.

All eight actual workers were verified `TERMINATED`. The owned image, its build
and runtime roles, exact S3 artifact and log group were removed. Read-only checks
at 03:21:47.813Z verified their absence. The archive retains all per-case records,
208 log events, image settings, request IDs and cleanup evidence.
