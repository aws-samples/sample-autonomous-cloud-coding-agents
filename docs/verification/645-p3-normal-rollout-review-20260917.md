# P3 normal deployment rollout review — September 17, 2026

This was a read-only review of `backgroundagent-dev` in account `<account-id>`,
Region `us-west-2`. No admission settings, aliases, roles or task records were
changed. It identifies the remaining operational work; it is not a completed
normal deployment drain or rollback rehearsal.

## Observed installation

At **01:27:41.617 UTC**:

- Normal coordinator versions **2–10** had no running Durable executions.
- All **112 task rows** were terminal; none held a capacity reservation.
- All **36 counter rows** had `active_count: 0`.
- Nine deployed functions referenced the normal coordinator's `live` alias.
- None of those nine had a configured dead-letter queue or asynchronous
  on-failure destination.
- The normal coordinator alias remained on version **10**. Automatic MicroVM
  suspension remained disabled.

The initial clean-deployment source, `29dcaa74`, already contained
`acquireTaskSlot`, `reservation_version` and task-owned release markers.
This installation does not require conversion from the older counter protocol.
The [isolated legacy/current rehearsal](./645-p3-capacity-upgrade-20260916.md)
remains evidence for installations that do need that migration.
The [600-user scan check](./645-p3-capacity-scan-20260916.md) exceeds this
installation's observed table volume, without establishing arbitrary scale.

An idle snapshot is not a fence: new work could arrive immediately afterward.

## Actual admission producers

Source callers and deployed `ORCHESTRATOR_FUNCTION_ARN` configuration identify
these nine entry points:

| Producer | Work it can start |
|---|---|
| TaskApi CreateTask | Direct submissions |
| TaskApi WebhookCreateTask | Webhook submissions |
| TaskApi ConfirmUploads | Tasks whose uploads become ready |
| AdmissionQueuePickup | Previously queued tasks |
| Slack CommandProcessor | Slack submissions |
| Linear WebhookProcessor | Linear submissions and follow-ups |
| Jira WebhookProcessor | Jira submissions and follow-ups |
| OrchestrationReconciler | Released dependent/child tasks |
| StrandedOrchestrationReconciler | Recovery that can release child tasks |

Stopping only the public create-task route does not stop the other eight.
Stopping the coordinator itself would also prevent existing Durable executions
from continuing through cleanup, so that is not a suitable drain mechanism.

## Two unsafe shortcuts

Slack, Linear and Jira use asynchronous Lambda processor invocation.
[AWS documents](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html)
that setting reserved concurrency to zero sends new asynchronous events
directly to a configured dead-letter queue or failure destination **without
retries**. The observed functions have neither configured. The zero-concurrency
method used on private fixture functions must not be copied blindly to these
normal processors.

Denying the producers' coordinator-invocation permission is also insufficient.
`createTaskCore` and upload confirmation persist `SUBMITTED` before invoking
the coordinator. A denied or uncertain invocation can leave a submitted task
without a running execution. The stranded-task reconciler eventually marks
stuck tasks failed; it does not start them.

The upload-confirmation log and user warning previously promised automatic
pickup. The local source now explains that startup could not be confirmed,
advises checking status before retrying, and describes failed cleanup of stuck
tasks. The existing 13 upload-confirmation tests, compilation and lint pass.
This text correction has not been deployed.

## Image rollback is separate from coordinator rollback

Normal coordinator versions 9 and 10 both name the image
`backgroundagent-dev-abca-agent` without `MICROVM_IMAGE_VERSION`.
The managed-image construct deliberately selects the latest active version:
the latest-active attribute can be empty during the initial image build.

Consequently, moving the coordinator alias from 10 to 9 does **not** restore an
older MicroVM image. Once a worker starts, its saved handle records the actual
returned image version, but that does not select the version for future starts.

Before rehearsing rollback, make image selection explicit in the reviewed
rollout procedure. The existing external-image path supports a version pin,
but switching an existing managed image resource to that path is an
infrastructure migration and must be reviewed for deletion/replacement.
Do not remove a managed image merely to obtain a pin.

## Remaining execution sequence

1. Prepare an admission pause that retains asynchronous input and has a tested
   replay procedure. Inventory the receivers and scheduled/stream triggers
   feeding all nine producers. Verify retention and restoration before relying
   on a pause. Keep coordinator continuations, approvals, cancellation and
   task finalization available.
2. Choose and record compatible coordinator **and image** rollback targets.
   Preserve the current exact template, code hashes, image identity, role
   policies, live switch and original producer/trigger settings.
3. Exercise the pause, then wait for already-running producer invocations and
   previously accepted dispatches to settle. Repeatedly inventory all retained
   coordinator versions, task states, compute handles and reservations.
   Account explicitly for queued tasks, pending uploads and dependent tasks.
4. With admission fenced and the drain verified, run reconciliation and compare
   held reservations with counters. This installation uses the current protocol;
   do not introduce old writers merely to simulate a legacy migration.
5. Exercise the reviewed compatible rollout/rollback/restore sequence. Verify
   actual returned worker image versions, completion and task-owned release.
   Restore input delivery, replay retained input through its normal deduplication
   path, and verify that no accepted work was lost.
6. Include the upload-feedback correction in the controlled deployment. Keep
   automatic suspension disabled until the remaining applicable rollout and
   service-contract gates in the [P3 plan](./645-p3-implementation-plan.md) close.

Raw read-only evidence is in
`/tmp/abca-645-p2-clean-20260913/p3-normal-drain-20260917`.
It contains exact function names/hashes, asynchronous settings, version
inventories, table scans and the AWS documentation used for this review.

Permanent private archive:
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/normal-rollout-review-evidence.tar.gz`.
It contains nine files, 34,608 bytes, mode `0600`; every member was checked
against its hash manifest. Archive SHA-256:
`4a1e4dfd93b78c85463fdad590fe8cf93547cb01733d190080e5b8153ec65b54`.
