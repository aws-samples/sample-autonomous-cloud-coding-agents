# ADR-021 P3: AWS capacity scan and interrupted-read checks

Verified September 16, 2026, in account `<account-id>`, `us-west-2`.
All checks passed and all temporary resources were removed. This is bounded
pagination and reconciliation evidence; it does not establish an arbitrary
production retention volume or complete the coordinated writer upgrade/rollback.

## Deployment and data

The temporary Lambda used the exact deployed ConcurrencyReconciler artifact,
SHA-256 `ZbDOQoSBUD3t4e0efIyopTKifQwKkQBBF8IA2wBLMRw=`, with the same Node.js 24,
ARM64, 256 MB memory and 300-second timeout. Its DynamoDB action sets matched the
normal reconciler's policy, with resource ARNs substituted to two owned tables.
It had no normal-table access, event schedule or coding workers.

Each table contained 600 records, with 5,000 bytes of padding per record to
exercise real AWS pagination. Task records covered active held reservations,
one terminal held reservation and an older active task without a reservation
marker. Three counters were deliberately too high or too low.

| Strongly consistent scan | Rows | Observed pages | Consumed read capacity units |
|---|---|---|---|
| Tasks | 600 | 4 | 779 |
| Counters | 600 | 3 | 761 |

These page and capacity measurements come from separate observer scans of the
same tables. The deployed handler uses projections and does not itself request
consumed-capacity telemetry. Its successful results required accounting for
all 600 users.

## Results

The first deployed invocation:

- Repaired counters from 3, 0 and 7 to their actual one held reservation.
- Released the terminal task's reservation, changing its counter from 1 to 0.
- Preserved the other 598 active held reservations.
- Left the ambiguous older task's counter at 2 and logged
  `CONCURRENCY_RESERVATION_UNKNOWN`.
- Logged `scanned=600`, `corrected=3`, `errors=0`.

Lambda reported **1,475.42 ms** duration and **112 MB** maximum memory.
The invocation receipt is `2c55ca9e-9d47-4b06-947c-56d4f665e455`.
These numbers describe this fixture, not a throughput or maximum-size guarantee.

Two interrupted-read cases ran the production handler locally against the
real AWS tables. The SDK boundary discarded the next read by throwing an
explicit fixture error before the second page of either the counter scan or
the task scan. Actual earlier AWS pages and their receipts were retained.
In both cases the handler failed with **zero update/transaction requests**, and
all 600 counters remained unchanged. A deliberate overcount was left in place
before these checks so that a premature repair would have been visible.
These were injected interruptions, not observed AWS outages.

After the older unmarked task became terminal, a second deployed invocation
repaired its counter from 2 to 0. It also repaired the deliberate overcount
from 9 to 1. It logged `scanned=600`, `corrected=2`, `errors=0`, with
**343.39 ms** duration and **113 MB** maximum memory.
Receipt: `5bba4ca9-014e-47de-abbf-e0d4be98c9ab`.

The earlier [normal-role live repair](./645-p3-user-sleep-20260916.md) separately
verified correction and terminal release while a real MicroVM waited for
approval. Together, these results add actual deployed writer permissions,
multiple scan pages, partial-read safety and conservative legacy handling to
the existing [transaction evidence and upgrade procedure](./645-capacity-reservations.md).

## Cleanup and limits

The private `backgroundagent-dev-p3-capacity-20260916` function, role, log group
and both 600-row tables were deleted after ownership-tag checks. Seventeen
function log events and final task/counter snapshots were saved first.
Read-only absence checks completed at **17:35:25.915 UTC**. The normal
reconciler's artifact and environment remained unchanged.

Evidence is retained in
`/tmp/abca-645-p2-clean-20260913/p3-capacity-scan-20260916`.
The full old-writer drain/upgrade/rollback procedure and production retention
volume remain separate gates. No workload-based memory change is proposed.
