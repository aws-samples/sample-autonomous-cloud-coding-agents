# #645 P3: worker suspend/resume hooks

**Follow-up (2026-09-15):** [per-worker image capability](./645-p3-image-capability.md) now declares the served hooks and verifies the actual launched image version locally. The milestone below records its original scope; supervisor integration and live sleep/wake acceptance remain open.

Date: 2026-09-14. Local implementation and DynamoDB Local verification.
Nothing in this milestone was deployed. Managed image **2.0** and automatic
suspension remain unchanged. P3 still requires image capability, supervisor
integration and the live acceptance matrix in the [plan](./645-p3-implementation-plan.md).

## Behavior

Think of a checkpoint as a signed-off bookmark: “this worker stopped here, waiting
for this answer.” It is saved outside the worker so the supervisor can inspect it.
It does not prove that AWS put the worker to sleep.

`server.py` serves POST `/suspend` and `/resume` under
`/aws/lambda-microvms/runtime/v1`. They use the sole context registered by `/run`.
An absent/empty body, `{}`, or empty `microvmId` uses that context; a supplied
nonempty ID must match. Actual AWS suspend/resume body behavior still needs live
verification. This tolerance comes from observed empty-ID terminate requests,
not a claim about a verified sleep/wake service payload.

The handler shares a **20-second total limit** across reading the body, draining
activity and AWS work. Bodies over 4,096 bytes are rejected. The shared contract
reserves a **30-second service timeout** for the later image hook declaration.
Invalid bodies return 400/413, unavailable or conflicting local state returns
409, and failed/uncertain work returns 503. Error responses contain a code and,
for unexpected failures, the exception type; they never echo AWS exception text.

## Before sleep

1. The controller requires the original approval park and exactly its blocked
   tool. Parallel or unaccounted background work prevents admission.
2. It blocks new activity and waits for already-running approval reads,
   credential requests, progress writes and heartbeat calls to drain.
   Any previously lost progress acknowledgment keeps suspension disabled.
3. The checkpoint callback strongly reads the task and approval. It verifies
   task/user/repository/VM/gate identity, the original creation time and timeout,
   task status `AWAITING_APPROVAL`, a matching coordinator `suspend` intent and
   approval status `PENDING`. The original deadline must still have time left.
4. One DynamoDB transaction checks both records again and writes a TaskEvents
   `agent_milestone` with `milestone: microvm_suspend_checkpoint`. Metadata records
   the VM, request, intent generation and original deadline. A change between the
   reads and transaction aborts the whole save.
5. Only an acknowledged transaction can produce HTTP 200. The controller checks
   the deadline and acknowledgment latch again before returning success.

The strict `_ProgressWriter.write_microvm_checkpoint` path raises on missing
storage, disabled progress or failed/uncertain writes. Ordinary progress remains
best effort. Existing task-scoped IAM permissions already permit the event Put
and task/approval ConditionChecks; this milestone adds no grants or task metadata
writes. Real deployed permission validation remains a P2/P3 acceptance gate.

A lost transaction reply can leave a bookmark in DynamoDB while the HTTP hook
fails. That bookmark alone never authorizes the supervisor to assume suspension.
There is no transaction token reused across separate HTTP attempts: DynamoDB's
cached success must not bypass a later changed approval or cancellation.

## After wake

The coding barrier stays closed while the callback forces renewal of the retained
ambient providers, then the same tenant credential object with the original
task/user/repository tags. Only then does it read AWS state. The
[credential milestone](./645-p3-credentials.md) covers the Claude subprocess
provider and actual pinned-CLI renewal/failure probes.

The callback requires the current task and original gate plus a matching
coordinator `resume` intent. A transaction containing only two ConditionChecks
rechecks task and approval together. It changes neither record. A concurrent
valid approval/denial is allowed; cancellation or a changed identity, intent or
original deadline fails reconciliation.

Successful resume releases the **same** approval loop with the **same** deadline
object. Waking grants no extra time. If the window expired, that loop applies its
existing conditional timeout and late-decision rules, including honoring a timely
decision already saved. Rejecting every expired wake would strand those decisions.

## Retries and teardown

- A completed duplicate suspend acknowledges the same parked checkpoint while it
  remains safe; it does not write a second event. A completed duplicate resume
  returns its cached result without rerunning credential refresh on active coding.
- Concurrent lifecycle requests receive 409 while the first owns the transition.
  Each new approval gate clears the old wake acknowledgment. One gate can sleep
  only once after a successful wake.
- After admission, failed suspend leaves the unfrozen approval waiter able to
  continue and disables another suspend. Failed/timed-out resume closes the
  barrier permanently. A rejected body or mismatched VM does not begin a transition.
- A thread can finish a network call after its handler times out. The controller's
  generation check prevents that late completion from releasing work. `/terminate`
  closes the controller before processing its body and retains its best-effort
  200 cleanup response. Its optional body read now has a one-second limit inside
  the existing 15-second service timeout; a stalled stream cannot hold teardown
  indefinitely. A regression reproduced the unbounded wait before this fix.
- There is no timer that opens an acknowledged suspend barrier. The supervisor
  must repair or terminate an ambiguous lifecycle transition within a bound.

Build hooks remain AWS-silent. `/validate` checks all six served routes. Direct
FastAPI route registration keeps this check valid with the installed FastAPI
version, whose included routers are lazy objects without a top-level `path`.
Image declaration remains a separate rollout gate.

## Verification

The focused Python tests exercise real HTTP dispatch and controller state,
duplicate/concurrent requests, slow bodies, timed-out threads, failed refresh,
termination during refresh, identity/deadline mismatch and expired wake.

Opt-in DynamoDB Local cases execute the actual condition expressions and
transactions. They inject cancellation, approval, deadline changes and replacement
intent after strong reads. Additional cases connect HTTP → controller → production
callbacks → local database for approval, expiry, cancellation and changed intent.
They assert that wake leaves task and approval records untouched and duplicate
suspend creates only one checkpoint.

Run from `agent/`, with your own DynamoDB Local container listening on a loopback
port:

```bash
ABCA_DDB_LOCAL_ENDPOINT=http://127.0.0.1:8000 \
  .venv/bin/pytest tests/test_microvm_checkpoint.py tests/test_microvm_http.py \
  tests/test_microvm_lifecycle.py tests/test_server.py tests/test_hooks.py \
  tests/test_progress_writer.py -q --no-cov
```

The fixture accepts only `http://127.0.0.1`, supplies synthetic credentials and
creates/deletes uniquely named temporary tables. Without the opt-in endpoint,
local database cases skip. This verifies DynamoDB expression semantics, not AWS
IAM enforcement, service hook ordering, snapshot clocks or actual frozen threads.

The CLI already renders arbitrary `agent_milestone` metadata through its generic
milestone path; the new checkpoint needs no CLI configuration changes.

The initial full agent quality run passed **1,946 tests**, including all **11**
DynamoDB Local cases. After the additional teardown-timeout regression, the final
run passed **1,936 tests** with those 11 opt-in cases skipped because the database
container had been removed. There are **66 new tests** in total; total coverage
including branches is **86.28%**. Ruff lint/format, type checking, Vulture and the
configured Bandit high-severity gate pass. Local tables were verified empty and
the dedicated container was stopped. Evidence is retained privately as
`p3-http-agent-quality-20260914.log` and `p3-http-final-agent-quality-20260914.log`.

The full monorepo build passed in about 13 minutes: **4,801 CDK tests** (38
existing optional skips), **928 CLI tests**, **11 Forge tests**, infrastructure
compile/lint/synthesis, documentation build/links and contract drift checks.
The final targeted constants suite passed **37 tests** after making its negative
budget cases independent of the configured service timeout. Its lint check passed.
Evidence: `p3-http-build-20260914.log`, `p3-http-constants-final-20260914.log` and
`p3-http-final-eslint-20260914.log`. The final Python run above includes the
teardown regression added during the build.

## Next integration

Bind capability to the actual image/version used by each worker and declare the
matching hooks, initially with automatic sleep disabled. Wire persistent intent
and policy into supervisor polling with bounded retries/recovery, and request
wake after an approval/denial transaction commits. Then deploy and verify real
hook bodies, runtime credential renewal, managed Claude settings, Gateway signing,
long sleep, delayed transitions, cancellation, expiry and rollback.
