# Capacity protocol upgrade and rollback rehearsal — 2026-09-16

The isolated AWS rehearsal passed: old counter writers can lose another task's
seat when cleanup repeats; the current reservation protocol preserves it.
Pausing admissions, draining tasks, switching protocols, rolling back after
another drain, and upgrading again all worked in the bounded fixture.

This is a table-protocol rehearsal. It does not claim that the normal
deployment's admission routes were paused or that its durable executions were
drained.

## Exact scope

The fixture ran in account `<account-id>`, `us-west-2`, from **19:39:32 to
19:39:57 UTC**. It used two private DynamoDB tables, two restricted Lambda roles
and five Lambda functions under
`backgroundagent-dev-p3-capacity-upgrade-20260916`:

- Separate old admission and release entry points.
- Separate current admission and release entry points.
- The exact deployed concurrency-reconciler ZIP, with only environment table
  names redirected to the private tables.

The old `admissionControl` and `decrementConcurrency` function bodies were
extracted unchanged from
`0f4545c77f01c5d905d9e32b8b375d9910e18324`. The current
`task-concurrency.ts` module was bundled unchanged from source `35d5515b`.
The wrapper admitted only nine fixed task IDs with one fixed owner. Its role
allowed `GetItem`/`UpdateItem` only on the two private tables. The reconciler
used the previously reviewed equivalent table permissions, redirected to those
tables.

The writer ZIP SHA-256 was
`485093d998cc9c11576f08306b5fbb8e3696c0defabe45650ccd19fad4210261`.
The reconciler's Lambda code hash was
`ZbDOQoSBUD3t4e0efIyopTKifQwKkQBBF8IA2wBLMRw=`, matching the normal deployment.
Source-function hashes, bundle inputs, deployed configurations and role policies
are retained with the evidence.

## Observed checks

All **12 checks** passed, using 27 completed Lambda invocations and seven actual
invocation rejections while reserved concurrency was zero.

| Check | Evidence |
|---|---|
| Enforced admission pause | AWS rejected invocation of the paused old/current admission functions |
| Old replay defect | Two active old tasks gave count 2; cleaning one twice produced 0 while the other remained active |
| Ambiguous legacy task | The current reconciler left the unmarked active task and its counter untouched; the fixture's drain check prevented progression |
| Approval occupancy | A current task awaiting approval retained its reservation; early release returned false |
| Capacity limit | A third admission at limit 2 was rejected without a reservation |
| Lost finalization reply | The wrapper deliberately threw after the real release committed; a repeated release preserved the other task's count of 1 |
| Cancellation | A terminal cancelled task released its own slot |
| Completion | A completed task released its own slot |
| Queue boundary | `QUEUED` could not acquire; changing to `SUBMITTED` permitted acquisition |
| Rollback with active work | Admissions remained paused and the fixture's drain check detected an active held reservation |
| Drained rollback | After all current reservations were released, a fresh old-protocol task admitted and finished with count 0 |
| Re-upgrade | After draining the old protocol again, a fresh current-protocol task admitted and released successfully |

The fixture's runner explicitly changed task statuses to represent work,
approval, failure and cancellation. It did not start a coding worker, run the
production queue-pickup handler, or reproduce a durable execution's entire
finalization path. The deliberately lost reply occurred after the release helper
returned, before its caller received a successful Lambda result. It establishes
safe repeated release after a committed transaction, not an AWS service outage.

The drain check is part of this operator rehearsal, **not a newly implemented
production deployment interlock**. Separate admission/release functions let the
fixture stop admissions while allowing cleanup. A normal rollout must identify
and stop every actual admission route without disabling cleanup for old work.

## Cleanup and remaining gate

At the final strong reads, all nine owned task records were terminal, no held
reservation remained and the single counter was zero. All five functions were
paused before cleanup. Their 120 log events, final table rows and invocation
receipts were saved.

All five functions, two roles, two tables and five log groups were deleted.
Ownership checks and **14 absence checks** passed at
**19:42:37.730 UTC**. No normal task record, counter or deployment setting changed.

The [capacity runbook](./645-capacity-reservations.md) still requires a deployment
specific inventory and drain of all old admission/cleanup writers, including
pending uploads, queue pickups and retained durable executions. The
[600-user scan test](./645-p3-capacity-scan-20260916.md) supplies separate bounded
volume evidence. Together these checks narrow the remaining rollout work; they
do not establish arbitrary retention scale or an already-executed normal-fleet
migration.

Raw evidence:
`/tmp/abca-645-p2-clean-20260913/p3-capacity-upgrade-20260916`.

Permanent private archive:
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/capacity-upgrade-evidence.tar.gz`
(56 files, 9,265,702 bytes, mode `0600`, SHA-256
`e1499cdde2ad8573996365b09553f4a62fc7ec790a932c0054370b5ded03784e`).
Every file was checked against its hash manifest. It includes source
`2b12ce88`, both exact function ZIPs, the legacy function bodies, all receipts,
logs and cleanup evidence, plus the subsequent ECS sizing-comment check.
