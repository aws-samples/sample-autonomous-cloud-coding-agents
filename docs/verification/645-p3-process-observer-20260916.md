# ADR-021 P3: full-agent process observer

Date: 2026-09-16. Three fallback-wake cases passed. The direct-wake control and
resource cleanup remain in progress.

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

The private durable fixture uses the current production coordinator compiled
from `c3b5c617`, fixed owned task IDs, one-second polls and a 1,800-second worker
lifetime cap. Its own SSM suspension switch is separate from production.
The fixtures ask only for one approved `Read` of `/etc/os-release`.

Two ordinary approval cases are followed by a case that remains suspended for
six minutes before approval. The latter checks the
[pending-wake timer correction](./645-p3-pending-wake.md). A fourth fixed task ID
is used for the direct-wake, delayed-hook control below. Its results are recorded
separately from the fallback cases.

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

The fourth fixed task uses a private copy of the production approval handler
with a dedicated role restricted to that task and the diagnostic image. Image
version `3.0` adds an explicit five-second delay before entering `/resume`.
This delay exists only in the diagnostic archive, whose SHA-256 is
`295fd2cee914ec56ee0ebef47d44df9fb9fc9f530a3baefc7da64826f791bd85`.
The production image and permissions are unchanged.

The private coordinator's version `3` includes the startup-confirmation
follow-up. Four real initial `PENDING` polls already confirmed the original
startup clock was retained despite the task being `RUNNING`. The direct-wake
result after six minutes remains pending.

## Local checks and evidence

Ruff lint/format and Ty passed. Real subprocess checks preserved exit code 42 and
forwarded SIGTERM to the child, reporting its termination and exiting 143.
Live Linux validation confirmed child/listener visibility. The guest does not
expose `/sys/fs/cgroup/memory.events`, so no OOM-counter evidence is claimed.

Private inputs, ownership ledgers, request IDs and results are recorded under
`/tmp/abca-645-p2-clean-20260913/p3-process-observer-20260916`. Raw evidence stays
private because the surrounding task history may contain signed launch references.
Every owned worker and temporary resource must be accounted for and removed
before closing the experiment. Production automatic suspension remains off.
