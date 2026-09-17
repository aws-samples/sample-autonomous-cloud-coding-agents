# Capacity reservation verification for #645

The replay regression starts with two occupied seats, finalizes one task, then repeats that finalizer as if its checkpoint were lost. The old implementation reduced the counter to zero. The new implementation keeps the other task's reservation and a count of one.

## Local transaction tests

`cdk/test/handlers/shared/task-concurrency-local.test.ts` uses real DynamoDB Local transactions and conditional expressions. It replaces client construction only to select an explicit loopback endpoint and dummy credentials. Fault hooks can discard a response after the database commits.

The suite covers repeated finalization, concurrent admission/cap enforcement, lost acquisition/release responses, competing cleaners, failure replay, cancellation before admission, approval occupancy, unadmitted/queued tasks, wrong owners, empty counters with a racing admission, periodic terminal cleanup, ambiguous legacy rows and stale repair after a revision change.

Run an isolated in-memory instance:

```sh
docker run --rm -d --name abca645-capacity-ddb \
  --memory 512m --cpus 1 -p 127.0.0.1::8000 \
  amazon/dynamodb-local@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab \
  -jar DynamoDBLocal.jar -inMemory -sharedDb
docker port abca645-capacity-ddb 8000/tcp
```

From `cdk/`, use the printed port:

```sh
ABCA_DDB_LOCAL_ENDPOINT=http://127.0.0.1:<port> mise run testf -- task-concurrency-local
```

The test rejects non-loopback endpoints. It creates uniquely named temporary tables, deletes them after the suite and closes its clients. Without the environment variable, this optional integration suite is skipped; ordinary helper/handler tests still run. Stop the temporary database after verification:

```sh
docker stop abca645-capacity-ddb
```

## Upgrade and live verification

1. Pause new submissions and allow old coordinator executions to finish, or terminate them through normal task cancellation/cleanup. Drain pending uploads/queue pickups as appropriate to prevent old code from starting work during the update.
2. Deploy all changed writers together: orchestrator, upload confirmation, stranded cleaner, counter reconciler and queue pickup. The counter reconciler now needs task-table `UpdateItem`; upload confirmation only needs counter reads. These changes use existing tables and roles.
3. Let older unmarked active tasks settle. The new helper does not guess their reservation ownership, and repair skips a user with ambiguous active rows. Inspect `CONCURRENCY_RESERVATION_UNKNOWN`; verify actual task/compute state before manual corrections.
4. Run reconciliation with admissions paused, check task reservations against counters, then reopen admission. For rollback, drain tasks using the new protocol before returning to old counter writers.
5. Verify one normal completion, start failure, cancellation, stranded task, approval wait, queued pickup and interrupted finalization against the deployed policies. Check that one task's cleanup preserves other tasks' seats.
6. Measure the two strongly consistent base-table scans at realistic retention volume. The function has a five-minute timeout; interrupted scans must not install partial counts. Monitor scan duration/read capacity and failures.

`CONCURRENCY_EMPTY_COUNTER` means a held reservation was found without a positive counter. The fallback closes its marker without subtracting from later admissions. Concurrent repair can leave an overcount for the next sweep to correct.

## Limits of this evidence

The [September 16 AWS follow-up](./645-p3-capacity-scan-20260916.md) now verifies
600 users across real multi-page task/counter scans, an exact deployed reconciler
artifact with equivalent permissions on isolated tables, interrupted scans with
zero writes, and conservative handling of an older unmarked task. A separate
[normal-role check](./645-p3-user-sleep-20260916.md) repaired an overcount and
terminal reservation while preserving a real waiting worker. The bounded
volume and role checks do not complete the old-writer drain/upgrade/rollback
procedure or establish arbitrary production scale.

The subsequent [isolated upgrade/rollback rehearsal](./645-p3-capacity-upgrade-20260916.md)
passed admission fences, legacy/current writer drains, lost-finalization replay,
drained rollback and re-upgrade using real AWS functions and restricted table
permissions. All temporary resources were removed. It exercised the table
protocol with fixture-managed task statuses; the normal deployment's complete
admission-route and durable-execution drain remains a separate operational gate.

A subsequent read-only deployment audit checked upload confirmation, coordinator
version 8, counter reconciliation, queue pickup and stranded-task reconciliation.
All five referenced the same code assets as the `a81c565d` assembly, and each
downloaded S3 ZIP matched its deployed Lambda `CodeSha256`. At that observation,
none of the normal coordinator's retained versions 2–8 had a running durable
execution. This establishes artifact alignment and a point-in-time execution
inventory; it does not prove admissions were paused or the upgrade/rollback
sequence was rehearsed. Evidence is in
`/tmp/abca-645-p2-clean-20260913/p3-capacity-writer-inventory-20260916`.
The [PID 1 evidence record](./645-p3-pid1-observer-20260916.md) links its
permanent archive, which also contains this writer inventory. The subsequent
[feedback-only rollout](./645-p3-wake-feedback-20260916.md) advanced the normal
coordinator to version 9; it did not change the capacity protocol.

The [September 17 normal-rollout review](./645-p3-normal-rollout-review-20260917.md)
extends the inventory through coordinator version 10 and identifies all nine
actual admission producers. The installation was idle at observation and already
used task-owned reservations in its clean-deployment baseline. A live admission
fence was not applied. Its asynchronous processors have no failure-retention
destination; setting their reserved concurrency to zero can discard input
instead of holding it for later. Follow the retained-input and image-rollback
steps in that review before a normal rollout rehearsal.

Local tests prove the application requests and DynamoDB Local's transaction behavior. They do not establish deployed IAM, AWS scaling, successful rollout or MicroVM sleep/wake behavior. Terminal events may repeat or be lost independently of the atomic seat update.

The reservation/start markers share the task row. Subsequent prerequisite work restricts agent updates to reporting/approval attributes and removes whole-row replacement/deletion plus direct worker access to the counter. Public-API omission alone was not protection. See [coordinator metadata verification](./645-coordinator-metadata.md) for the writer inventory, actual policy boundary, remaining status/tag trust limits and required AWS authorization checks. These local transaction tests do not prove that security boundary.
