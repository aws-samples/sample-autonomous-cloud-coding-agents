# ADR-021 P3: full-agent process observer

Date: 2026-09-16. Six task cases passed, including the exact API-first pending-wake
check. One test-role configuration failure is preserved separately. Temporary
resource cleanup and private evidence archiving are complete.

## Question and scope

The [four intermittent wake failures](./645-p3-resume-refusal-investigation.md)
have a successful `/suspend` response followed by an AWS report that the
`/resume` connection was refused. The
[minimal listener control](./645-p3-listener-probe-20260916.md) reproduced that
message by deliberately closing its listener, but did not establish what happened
inside the full agent.

This experiment runs the full image-4 agent under an independent parent observer.
The parent records child exit status, received signals, port-8080 listener
inodes/ownership, selected process-state fields and cgroup memory counters.
It samples `/proc` without opening connections. It records no environment,
command arguments, task payloads or credentials.

The observer changes the process tree: the server becomes a child of the
diagnostic parent. That can affect signal handling and timing. Results narrow
the investigation; they do not prove an unmodified image is reliable.

## Artifact and isolation

The source archive is the exact production image-4 artifact,
SHA-256 `0585a80606aaa66e9ce4dbff35a093451488f72d5a732c6cce6036b88fbcd4ed`.
The diagnostic archive changes only the Dockerfile startup wrapper and adds
`agent/scripts/microvm_process_observer.py`; 109 other entries are byte-identical.
The child still runs the original `opentelemetry-instrument uvicorn server:app`
command with its original arguments.

Diagnostic artifact SHA-256:
`fd0875173bc9f0cc7ec7b321923e355d6d5022e4eae6ea7b958f5e7e0f92bd57`.

The first diagnostic build failed before any task launch: the added ZIP entry
defaulted to mode `0600`, so the non-root agent could not read the root-owned
observer script. Both validation processes reported `Permission denied`;
the image eventually failed its five-minute readiness timeout. The corrected
archive explicitly uses regular-file mode `100644`. Failed image version `1.0`
and its logs remain part of the evidence; the corrected build is version `2.0`.

The temporary image is `backgroundagent-dev-p3-observer-20260916`, in account
`<account-id>`, `us-west-2`. It uses the same managed base, architecture, memory,
six hooks and restricted network connectors. It has its own build role, artifact
and log group, with ownership tag `abca:verification=645-p3-observer-20260916`.
It reuses the existing worker execution role. No public ingress is added.

The initial private durable fixture used production coordinator source
`c3b5c617`; private versions `3` through `6` use the startup-confirmation fix
in `27521f85`. All use fixed owned task IDs, one-second polls and a 1,800-second
worker lifetime cap. The fixture's SSM suspension switch is separate from production.
The fixtures ask only for one approved `Read` of `/etc/os-release`.

Two ordinary approval cases are followed by a case that remains suspended for
six minutes before approval. The latter checks the
[pending-wake timer correction](./645-p3-pending-wake.md). Four further fixed task
IDs cover direct wake, a corrected test-role policy, and API-first timing below.
Their results are recorded separately from the fallback cases.

## Observed results and direct-wake control

The first three cases completed with the original worker and deadlines,
one successful `Read`, released capacity, zero user counters, empty launch
prefixes and observed worker termination. Independent parent observations
confirmed the child owned its listening socket; no child exit was logged.

| Case | Worker | Durable polls | Owned-listener observations |
|---|---|---|---|
| Short approval A | `microvm-7897f87c-c612-3b0f-9958-3f49f9c1f0f2` | 59 | 41 |
| Short approval B | `microvm-af89965a-5607-3550-980d-900bd36c4a87` | 62 | 41 |
| Six-minute suspension | `microvm-e487702f-48d8-3a7a-93e0-93ba4ea573c9` | 363 | 24 |

These are **fallback-wake** results. The production approval handler's intended
image-scoped permissions reject `GetMicrovm` on the separate diagnostic image.
It committed the approval and wake intent, returned 202, and the private
coordinator performed Resume. The short cases reused the same client port across
`/suspend` and `/resume`; this is a transport difference from the minimal probe.
Neither result establishes a cause for the four original failures.

The direct-wake control uses a private copy of the production approval handler
with a dedicated role restricted to that task and the diagnostic image. Image
version `3.0` adds an explicit five-second delay before entering `/resume`.
This delay exists only in the diagnostic archive, whose SHA-256 is
`295fd2cee914ec56ee0ebef47d44df9fb9fc9f530a3baefc7da64826f791bd85`.
The production image and permissions are unchanged.

The private coordinator's version `3` includes the startup-confirmation
follow-up. Four real initial `PENDING` polls already confirmed the original
startup clock was retained despite the task being `RUNNING`.

The fourth task, `01M2N176C2X2M85VMAA415P4JX`, failed before approval: the private
API role lacked access to its user's synthetic rate-limit counter. It returned
500, and the watcher stopped the execution, cancelled the task, terminated
`microvm-625dca00-bc29-36c6-9a63-d3f348accfcb`, deleted launch files and released
capacity. This is a test-role configuration failure, not another resume refusal.

The corrected policy grants `UpdateItem` on the exact owned
`RATE#<test-user>#APPROVE` partition. A preflight against a nonexistent approval
returned the expected 404 and verified counter value 1, without creating a task
or approval. A fresh fifth task, `01M2N3H3JVAFCK8JXGN44H6KVA`, uses private
coordinator version `4` and private approval-handler version `2`, with the same
diagnostic image `3.0`.

The fifth case completed successfully on
`microvm-d996d527-64b5-3cb1-9f88-0a143fac9f05`. The private API acknowledged its
single Resume at 12:46:29.760Z, request
`eb6ea613-7cb6-4b62-8e84-d53828a32a31`. The coordinator first observed `SUSPENDED`
with the resume intent and initialized recovery at 12:46:24.145Z; five subsequent
real `PENDING` observations preserved that recovery clock. The task completed,
the worker terminated, and normal coordinator cleanup passed.

This verifies direct API wake with an already-started recovery timer. The
stricter check for first observing `PENDING` with **no prior recovery** failed,
so that original failed audit remains in the evidence. Private API logs use
Lambda's text prefix; the audit was corrected to decode that prefix before
counting the actual Resume acknowledgment.

The sixth task, `01M2N4DVR9VPEARNP0DK85PZZY`, used private coordinator version `5`
and approval-handler version `3`. It delayed completion of lifecycle snapshot
reads for at most three seconds after a matching resume intent existed with no
prior recovery. This still allowed the coordinator to win the intent write
before the delay began. The API correctly deferred with `wake-intent/intent-stale`;
the coordinator resumed the worker and completed normal cleanup. Worker
`microvm-a9d311ac-6f2b-3801-a579-71388cf3a7be` terminated at 13:01:31.203Z.
The audit recorded 382 supervisor polls and 32 owned-listener observations.
This is a successful stale-intent fallback, with the failed exact-branch audit
preserved separately.

A seventh task, `01M2N507M71T8F18ETT32Q51M2`, uses private coordinator version `6`
and approval-handler version `4`. Its wrapper delays only the first lifecycle
snapshot read per supervisor poll when the real approval is already `APPROVED`
or a matching resume intent exists, with no prior recovery. This places the
delay before the coordinator can write a competing intent. It polls actual
`GetMicrovm` for at most three seconds until `PENDING`, then returns a fresh
database snapshot to the production supervisor. Stored states and clocks are
unchanged. The diagnostic guest still delays `/resume` entry for five seconds.
The seventh case passed the exact branch at 13:11:01.153Z: actual `PENDING`,
no prior recovery, and worker age 418,860 ms, beyond the 300-second startup
allowance. Recovery began at `1789564260293`, exactly the saved API wake-request
time. The sole private API Resume acknowledgment was at 13:11:00.823Z, request
`635ac95d-7e3e-49cf-a5b9-25566f45c3eb`. The guest's real delay lasted just over
five seconds.

Worker `microvm-75c3deba-6819-35ec-8f33-a3b98f1f05ad` completed the single Read
and terminated at 13:11:13.063Z. The audit counted 381 supervisor polls and
32 owned-listener observations. The initial observation time and original
service deadline remained unchanged through durable replay; capacity was
released, the user counter reached zero, and launch files were absent without
watcher repair. This closes the deployed timer correction's live branch check.
It does not resolve the four original connection refusals.

## Local checks and evidence

Ruff lint/format and Ty passed. Real subprocess checks preserved exit code 42 and
forwarded SIGTERM to the child, reporting its termination and exiting 143.
Live Linux validation confirmed child/listener visibility. The guest does not
expose `/sys/fs/cgroup/memory.events`, so no OOM-counter evidence is claimed.

Cleanup was verified at 13:12:44 UTC. All seven workers were terminated;
six tasks completed and the test-role failure was cancelled. All reservations
were released and launch prefixes were empty. The private coordinator and
approval function, every published version, all three diagnostic image versions,
three roles, three log groups, the private suspension parameter and three
diagnostic artifact objects were removed, with absence checks.

The seven fake users' zero-valued capacity counters had no TTL. Their snapshots
were archived, then each row was deleted conditionally on its unchanged
reservation version and zero count; subsequent reads confirmed absence.
Task history, rate-limit rows and traces retain their normal retention policies.

Private inputs, ownership ledgers, request IDs and results originated under
`/tmp/abca-645-p2-clean-20260913/p3-process-observer-20260916`. The persistent
archive is
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/observer-startup-evidence.tar.gz`:
172,444,846 bytes, 222 entries, SHA-256
`d5103c683c16fdc8f63504c2cded5ccec5dc435ed2bf8a8d8d5b37bbdc8be7ec`.
It includes the failed cases, 5,144 image-log events, 8,775 coordinator-log events,
39 private-API log events, durable histories and the exact deployed coordinator
ZIP. Extracting that ZIP reproduced its published code hash. The archive and its
directory are owner-only because raw histories may contain signed launch references.

The final production check confirmed `UPDATE_COMPLETE`, coordinator version `5`,
active agent image `4.0`, guardrail version `3` and both suspension switches off.
The original resume refusals and the wider P3 acceptance gates remain open.
