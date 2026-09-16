# ADR-021 P3: wake HTTP connection and event-loop investigation

Comparison completed on September 16, 2026, in `us-west-2`.
A fresh failure now correlates the exact refusal wording with an expired
connection timer and a live listener. Three `Connection: close` cases passed
with actual closure before freeze and fresh resume connections. The normal
deployment was unchanged during this comparison. This record separates
actual AWS wake evidence from local calibration and attempts that failed before
any sleep. Nothing here has been submitted to the service team.

## Question and instrumentation

An HTTP keep-alive connection lets a client reuse an existing connection for its
next request. Uvicorn normally closes an unused connection after five seconds.
If its timer advances while a MicroVM is frozen, closing that connection can
race with the next request when the worker wakes.

The private image was derived from the exact deployed image 5.0 artifact,
SHA-256 `9b3150e9e5991cc9fcc8a4adbb2cfbd8f97399f0c16baa9c2b5fe5b101e7b035`.
It retains the original server command, server as PID 1, default keep-alive
behavior, 8,192 MiB memory and all six hooks. Its additions are:

- HTTP protocol metadata: connection identity, request arrival, response
  completion, idle-timer deadline, and the function that closes a socket.
- A timer on the server's event loop, showing when that loop resumes execution.
- A separate process sampling the server and its listening socket. This observer
  opens no network connections.

The probes do not record request bodies, headers or credentials. The artifact
SHA-256 is `d894f553c1f43983e30591f38a727ce6b9ae7db58dd3f8246feb11415e39f63b`;
109 other ZIP entries are byte-identical to the baseline. The private image is
`backgroundagent-dev-p3-wake-transport-20260916`, version `1.0`.

## Local calibration

A disposable ARM64 Linux container used Uvicorn 0.50.0, Python 3.13.13,
FastAPI 0.139.0 and the asyncio/h11 server. It had no external network.
The controller waited for logged response completion and an armed idle timer
before pausing the server process.

| HTTP response behavior | Process pause | Next request | Separate fresh connection |
|---|---:|---|---|
| Default keep-alive | 0.3 s | 200 | 200 |
| Default keep-alive | 6 s | Old connection failed with `BrokenPipeError` | 200 |
| Explicit `Connection: close` | 0.3 s | 200 | 200 |
| Explicit `Connection: close` | 6 s | 200 | 200 |

The failing old connection was closed by `timeout_keep_alive_handler`; the server
stayed alive. `Connection: close` tells the client to use a new connection. It
is different from setting the server's idle timer to zero.

Two preliminary local attempts are retained and excluded. The first started
the heartbeat during module import, before Uvicorn created its event loop.
The second paused immediately after the client read the response body, before
the server finished its connection bookkeeping. It consequently armed the timer
after continuation. Reading a response body is not proof that the server has
already armed its idle timer.

Pausing a local process does not reproduce AWS snapshot or network restoration.

## Attempts excluded before wake

| Case | Task | Reason | Cleanup |
|---|---|---|---|
| 1 | `01M2NZ3AB465YF8ZN6ED3ERAB4` | Diagnostic IAM policy retained old fixture IDs; initial task read denied | Cancelled; no worker or reservation created |
| 2 | `01M2NZ3AB92EGG6GCSG2XT9DVZ` | AWS durable execution stopped with `Stopped.ByService` | Owned worker cancelled and terminated; reservation released |
| 3 | `01M2NZ3AB9PVXP9QHAB79DMSTB` | Second `Stopped.ByService`, during startup | Owned worker cancelled and terminated; reservation released |

The copied IAM allowlists were corrected and checked against the fresh task
IDs. The two durable service errors contain correlation IDs
`b56d7524-7d7c-49c3-afab-13f343b3ab85` at 20:56:03.507Z and
`75b494cd-f102-4f1d-9a14-02c86533c808` at 20:58:46.239Z. Neither attempted a
Suspend or Resume. They are separate from the MicroVM wake failure.

Subsequent transport tests use the production coordinator body and supervisor
with a local, single-pass step/poll adapter. Workers and lifecycle calls remain
in AWS. This tests real wake behavior; it does not test durable replay or resolve
the separate durable service stops. Each worker has a 1,800-second maximum
lifetime, with a five-minute local coordinator bound and six-minute watcher.

## First actual AWS wake

Task `01M2NZ3ABA61SYKQSRJ9S8ZAZ4` used worker
`microvm-a0df3925-9773-325a-9e64-7ce295f548db`, a 150-second approval window
and a 30-second sleep delay.

| UTC time | Observation |
|---|---|
| 21:03:48.732 | Suspend response finishes on connection 3; five-second deadline armed |
| 21:03:50.039 | Watcher observes `SUSPENDED` |
| 21:04:46.524 | Sole Resume request starts |
| 21:04:46.779 | AWS accepts, receipt `da6f3495-c60b-44c6-a6ab-542533e43f20` |
| 21:04:46.979 | Server event loop resumes after a 58.306-second gap |
| 21:04:46.979 | Expired idle timer closes connection 3 |
| 21:04:46.981 | Server accepts fresh connection 4 |
| 21:04:46.983 | Resume request arrives on connection 4 |
| 21:04:47.428 | Resume response completes with HTTP 200 |
| 21:05:46.693 | Original approval timeout observed; subsequent approve API returns 404 |
| 21:05:57.960 | Task and cleanup checks pass without watcher repair |

The independent observer saw the original server still owning its listener.
The original approval became `TIMED_OUT`; the Read did not execute. The task
completed, its worker terminated, its reservation was released, its counter was
zero and its payload absent. The complete trace contained no dropped records.

This directly shows an idle timer expiring after an AWS freeze. It also shows
a successful fresh connection afterward. Timer expiry alone therefore does not
establish the cause of the intermittent failure.

## Exact refusal with connection and listener evidence

A second unchanged-image round completed one more successful wake, then
reproduced the exact refusal. Its third planned case was not started.
The failing task was `01M2P0QTA9M6D2J6B5RM42KDNH`, worker
`microvm-bb1bfd4b-9ce3-3691-a60b-88f263081d43`, on private image `1.0`.
No command or guest failure was injected.

| UTC time | Observation |
|---|---|
| 21:14:27.502 | Suspend accepted, receipt `26d37f89-141a-4938-ba07-904c3edaf6b9` |
| 21:14:27.565 | Suspend HTTP 200 finishes on connection 3, peer port 55068; idle deadline 157.88734039 on the monotonic clock |
| 21:15:26.540 | Sole Resume request starts |
| 21:15:26.786 | Resume accepted, receipt `74943bd5-cfd1-4781-9f10-9946566089e8` |
| 21:15:26.947 | Event loop resumes after a 59.451-second gap, at monotonic time 212.277492979 |
| 21:15:26.948 | `timeout_keep_alive_handler` closes connection 3 |
| 21:15:26.949 | Connection 3 reports `connection_lost` |
| 21:15:26.950 | Independent observer sees PID 1 running and owning the original port-8080 listener, inode 13544 |
| 21:15:27.471 | AWS terminates the worker with `Resume lifecycle hook connection was refused` |

The retained window has no fresh HTTP connection, resume request bytes, resume
hook entry or resume access log. The observer is a sample, not continuous proof
of health; its process/socket reads are not atomic. The 271 raw guest events and
immediate service response are retained.

The coordinator recorded `FAILED` and released the reservation before the
runner's idempotent fallback cleanup. This is a failed wake, not a passing
approval test. Together with the successful fresh-connection control, it
supports an old-connection race. The service's actual dispatch error and
connection choice remain unavailable from customer-visible telemetry.

## Explicit connection-close candidate

The candidate adds `Connection: close` to suspend and resume JSON responses,
including error responses. Status codes, response bodies, checkpointing and
approval barriers remain the same. This makes the HTTP response end the
connection before a freeze instead of leaving closure to an idle timer.

The private image's version `2.0` differs from diagnostic `1.0` only in
`agent/src/microvm_http.py`; 112 other archive entries are byte-identical.
Candidate artifact SHA-256:
`6eeddb08a4314d939e87a4bcc3a517319e107d1bcc3a5eda71d814346f60fbeb`.
The original server remains PID 1 with 8,192 MiB.

Agent quality checks passed: lint, formatting, type checking, and 1,955 tests
with 11 opt-in DynamoDB Local tests skipped. Eight new route cases verify that
both hooks return the close header for HTTP 200, 400, 409 and 503, even when the
client requests keep-alive.

The live comparison first ran two unchanged-image cases with a 210-second
approval window and a 30-second sleep delay, checking an actual suspended hold
longer than 90 seconds. These cases used a seven-minute local coordinator bound
and eight-minute watcher. It then ran three candidate-image cases with the
original 150-second approval window and approximately 60-second freeze.
Each phase was configured to stop at its first failure.

| Case | Image | Observed suspended hold | Result |
|---|---|---:|---|
| `over-90s-1` | Unchanged `1.0` | 117.829 s | Passed |
| `over-90s-2` | Unchanged `1.0` | 117.935 s | Passed |
| `close-1` | Candidate `2.0` | About 58 s | Passed |
| `close-2` | Candidate `2.0` | About 59 s | Passed |
| `close-3` | Candidate `2.0` | About 58 s | Passed |

The candidate audit additionally checked the actual HTTP transport:

| Case | Suspend connection closed | First observed `SUSPENDED` | Fresh resume connection |
|---|---|---|---|
| `close-1` | 21:42:17.331 | 21:42:18.562 | 21:43:16.699 |
| `close-2` | 21:46:26.263 | 21:46:27.040 | 21:47:26.058 |
| `close-3` | 21:50:09.743 | 21:50:10.231 | 21:51:08.939 |

In every candidate, connection 3 closed from Uvicorn's response-send path before
the freeze; no idle deadline was armed and no idle-expiry callback ran on that
connection. Resume arrived on new connection 4. The internal `keep_alive`
boolean remained true even though h11 closed the transport, so that boolean
alone would be an incorrect verification criterion.

All five comparison tasks preserved their original approval deadline, applied
the timeout, rejected a subsequent approval with HTTP 404 `REQUEST_NOT_FOUND`,
and completed without executing the unapproved Read. Complete traces contained
one Read intent each and no dropped records. Every worker terminated, every
reservation was released, counters reached zero, and payload prefixes were
empty without watcher repair. All four phase audits had zero errors.

A longer-sleep pass or a finite series of successful resumes alone cannot
establish the service-side cause or eliminate an intermittent failure. The
candidate's direct transport evidence establishes removal of the retained
suspend connection in these tests. It does not reveal the service's failed
dispatch error or prove that every historical wake failure had this cause.

## Error feedback correction

Review also found that the timeout wording `Resume lifecycle hook timed out`
fell into the generic retryable substrate category. It now maps to
`MICROVM_RESUME_HOOK_FAILED`, preserving the raw reason and requiring the same
service/admin diagnosis as the other recognized wake failures. The regression
checks current, legacy and raw error forms and the resulting retry guidance.
All 136 focused classifier tests passed, followed by the complete CDK suite:
5,053 passed and 56 opt-in DynamoDB Local tests skipped. TypeScript compilation
and ESLint passed. The remedy explicitly avoids treating the service's refused
wording as proof of a closed listener.

## Historical timing correction

The first four refusal records had short intervals measured from an observed
`SUSPENDED` state. Their archived HTTP access timestamps are earlier:

| Earlier case | Suspend HTTP 200 access log | AWS termination | Access-to-termination interval | Observed `SUSPENDED`-to-termination interval |
|---|---|---|---:|---:|
| Approval, Sep 15 | 21:31:41.279 | 21:31:46.958 | 5.679 s | 2.834 s |
| Start-crash recovery, Sep 15 | 21:56:48.531 | 21:56:56.279 | 7.748 s | 3.006 s |
| Inline Resume failure recovery, Sep 15 | 22:54:39.936 | 22:54:45.753 | 5.817 s | 4.759 s |
| Missing approval, Sep 16 | 00:25:01.657 | 00:25:07.524 | 5.867 s | 2.923 s |

An access log precedes final response completion and timer arming. AWS's
termination timestamp is not the exact time its failed hook request was sent.
The old records do not contain those precise events. These intervals cannot
prove idle expiry caused a refusal, but a short interval measured from
`SUSPENDED` does not rule it out.

## Evidence and remaining work

Raw scripts, exact artifacts, command receipts, paginated guest logs, original
failure timing extracts and audit results are retained privately under:

- `/tmp/abca-645-p2-clean-20260913/p3-wake-transport-20260916`
- `/tmp/abca-645-p2-clean-20260913/p3-wake-transport-round2-20260916`
- `/tmp/abca-645-p2-clean-20260913/p3-wake-pool-window-20260916`
- `/tmp/abca-645-p2-clean-20260913/p3-wake-connection-close-20260916`

Cleanup finished at 21:58:39.471Z. All ten created workers were terminated.
The private image and its versions, function and versions, two roles, parameter,
two log groups, two exact artifact objects and ten zero-valued fixture counters
were removed and their absence checked. Ordinary task records remain under
their existing retention policy. The archive retains 6,636 guest log records
and 73 coordinator log records.

An initial cleanup preflight rejected `/tmp` versus `/private/tmp` spellings of
the same directory before any resource deletion. It was corrected by comparing
resolved paths; that failed preflight and the successful cleanup are both retained.

The evidence is being preserved in the private permanent archive
`~/.local/share/abca-verification/645-p3-20260916/wake-transport-evidence.tar.gz`.
At comparison cleanup, the normal deployment remained coordinator 9 / image
5.0, 8,192 MiB, with automatic suspension disabled. Normal rollout is a separate
verification step.
