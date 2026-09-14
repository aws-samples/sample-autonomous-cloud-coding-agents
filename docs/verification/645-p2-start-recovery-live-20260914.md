# P2 live MicroVM start and recovery verification

## Result

On 2026-09-14, the AWS service replay checks and **13 application start/recovery
cases passed** against the existing `backgroundagent-dev` deployment in
`us-west-2`, account `<account-id>`, profile `sphia-dev`, image `2.0`.
The deployed source remains `e1d5debe`, with bootstrap policy bundle `1.7.0`.

This extends the [payload verification](./645-p2-payload-live-20260914.md).
It does not complete the full P2 matrix or implement P3 sleep/wake.
The [implementation checklist](./645-p3-implementation-plan.md) tracks those gates.

## What “recovery” means here

The coordinator starts a task's worker. Before asking AWS, it saves a
**receipt** in DynamoDB, the task database. The receipt contains a stable
request number, called the **client token**, and a fingerprint of the request.
Once AWS returns the worker ID, that ID is saved too.

If a reply gets lost, retrying with the same receipt should find the same
worker. It should not change the instructions or buy another computer.
If the application no longer has enough information to retry safely, it must
stop and report uncertainty.

These checks use two separate runners:

- [Service replay](../../cdk/test/live/verify-microvm-replay.live.ts) calls
  `RunMicrovm` directly and measures AWS's actual token behavior.
- [Application recovery](../../cdk/test/live/verify-microvm-start.live.ts) runs
  the production strategy, S3 producer and DynamoDB receipt code in fresh local
  child processes against real AWS. Its
  [fault injector](../../cdk/test/live/microvm-start-child.ts) discards successful
  replies or exits the child after an acknowledged operation. The next child
  receives only the original task/settings, and recovers through AWS storage.

The fault injector retains worker IDs separately for the test's cleanup audit.
The recovering application does not read that observer trace. This tests a lost
reply/process boundary, but it does not prove recovery when neither the
application nor an operator has any record of the worker ID.

## AWS service observations

The test uses an invalid startup reference, so the real guest rejects it before
S3 reads, configuration installation or pipeline startup.

| Request | Observed result |
|---|---|
| Two simultaneous identical starts | Both returned the same worker ID |
| Immediate identical replay | Same ID and original response |
| Same token, duration changed from 180 to 181 seconds | `ValidationException`: “The provided clientToken was used with different request parameters.” |
| Replay after `GetMicrovm` reported termination | Same ID; no replacement worker |
| Replay at elapsed 30.194, 144.855 and 305.207 seconds | Same ID and request fingerprint |

The worker was `microvm-c87a143e-1132-36ee-987f-ea778e23f955`.
The last replay's AWS request ID was
`1cc4e9be-b3c9-492d-95e4-e92a30cef006`.

The replay response kept saying **`PENDING`**, even after termination.
An independent `GetMicrovm` read confirmed the original start time
`17:25:58.707Z`, termination time `17:26:04.155Z`, and state `TERMINATED`.
The replay returns the original response; callers must poll current state
separately. These observations through roughly five minutes do not establish
AWS's maximum token-retention period or its behavior after that period expires.
The application's 120-second cutoff remains a separate conservative limit.

## Application observations

Each task uses synthetic configuration with a deliberately malformed
`agent_session_role_arn`. The producer accepts the nonempty identifier, but the
guest rejects its shape before installing configuration, fetching secrets or
starting a pipeline. The control verifies this barrier through real worker logs.

The operator runs the control-plane code. The guest uses the unchanged deployed
MicroVM execution role and runtime egress connector, with explicit `NO_INGRESS`.
The test changes two outgoing Run fields consistently: it caps worker lifetime
at **180 seconds** instead of the production eight hours, and sets the existing
MicroVM log group. Receipt hashing, payload preparation and application retry
logic remain unchanged. No deployed Lambda is killed or modified.

| Case | Verified behavior |
|---|---|
| Control | Real S3 files, start receipt and worker-ID registration completed |
| Successful Run reply discarded | Production automatic retry recovered the same ID; `autoRetried` was true |
| Process exits after Run success, before receiving its result | Fresh process reused the saved token and exact signed request; same worker ID |
| Process exits after task-file write | Fresh process reused the immutable task bytes and completed the launch |
| Process exits after private launch-record write | Fresh process recovered the saved launch reference and completed the launch |
| Task-file write reply discarded | Producer read back the committed object and continued |
| Launch-record write reply discarded | Producer recovered the committed reference and continued |
| Worker-ID database write reply discarded | Strategy read back the committed handle and succeeded |
| Process exits after worker-ID write | Fresh process returned the saved handle without another Run request |
| Worker-ID write deliberately rejected before submission | Strategy stopped the known worker and reported `MICROVM_START_RECEIPT_SAVE_FAILED` |
| Changed instructions after interrupted start | `MICROVM_START_INPUT_CHANGED`; no Run call and no overwrite; original request could still recover |
| Cancellation with a saved handle | `MICROVM_START_TASK_CLOSED`; no new Run request; worker stopped |
| Actual receipt deadline passes after interrupted start | `MICROVM_START_OUTCOME_UNKNOWN`; no further Run request |

Each case that reached AWS used exactly one worker ID. Repeated Run requests
had identical fingerprints, including the signed URL. Successful registration
saved matching `microvm_start.handle`, `session_id` and task-stable client token.
No capacity reservation or production channel/repository operation was created.

The denied-write case injects an exception locally; it is not a test of an
actual IAM denial. Cancellation is observed through a fresh strategy invocation,
not a deployed approval/cancel handler racing a durable checkpoint.

## Cleanup, logs and test corrections

Independent reads confirmed **17 owned workers terminated**, all **36 planned
S3 object locations absent**, and all **16 planned task IDs absent**, including
setup failures and cases skipped when an earlier assertion stopped a batch.
Those counts include three service-probe workers and fourteen application-probe
workers across the control, fault batch and corrected cancellation rerun.
They are cleanup coordinates, not counts of distinct passing test cases.

The final log audit found no signed-URL credential/signature markers and no
configuration-installed or pipeline-accepted messages. Four workers stopped
before emitting guest logs; the other thirteen had three events each. The test
does not use an empty log stream alone to prove a successful rejection.

The runner calls the production task-file deletion helper, verifies both
files are absent, deletes only its own synthetic task rows, and removes its
unique manifest. This is operator cleanup; it does not replace the remaining
deployed-coordinator finalization checks.

The stack remains `UPDATE_COMPLETE`, with last update
`2026-09-14T16:07:52.421Z`. No image, role policy or network configuration changed.

Several harness expectations were corrected during calibration:

- `ListMicrovms` permits at most 50 results per page.
- Parameter mismatch uses `ValidationException`; the state reason says
  `HTTP status 400`.
- Child processes must reuse the parent's resolved `tsx` loader, since `npx`
  can supply it from its cache.
- The task status is `TaskStatus.CANCELLED`. The misspelled fixture `CANCELED`
  correctly failed as an unknown state. The corrected cancellation test passed.

All affected fixtures were cleaned, and the corrected cases were rerun.
The production behavior required no fix in this batch. Comment cleanup in
`agent/src/server.py` and the MicroVM strategy removes stale claims about P1
envelope compatibility, logged payloads and absence of automatic termination.
The helper's direct `None` no-op is not a legacy v2 startup path; the eight-hour
service lifetime is a backstop, not prompt cleanup.

## Reproduce and validate

Run from `cdk/` with the installed repository dependencies, Node 22 and AWS CLI.
Both scripts make no AWS calls without `--execute`. Output directories must
not already exist.

```bash
mise exec -- npx tsx test/live/verify-microvm-replay.live.ts
mise exec -- npx tsx test/live/verify-microvm-start.live.ts

AWS_PROFILE=sphia-dev mise exec -- npx tsx test/live/verify-microvm-replay.live.ts \
  --execute --account <account-id> --region us-west-2 \
  --stack backgroundagent-dev --image-version 2.0 \
  --output /tmp/abca-p2-replay-new-run

AWS_PROFILE=sphia-dev mise exec -- npx tsx test/live/verify-microvm-start.live.ts \
  --execute --account <account-id> --region us-west-2 \
  --stack backgroundagent-dev --image-version 2.0 \
  --output /tmp/abca-p2-start-new-run
```

The application runner supports a comma-separated `--cases` selection.
Do not run independent worker-creating probes concurrently: each checks its
before/after inventory for unaccounted workers and reports them without deleting
them. If interrupted, use the private context, task plans and observer traces
for exact cleanup. The 180-second worker cap does not delete database/S3 files.
Context and traces contain identifiers and fingerprints, not signed URLs or
credentials. Both runners are outside the normal Jest test pattern.

Validation: three existing CDK suites passed **134 tests**, and the selected
Python platform-config tests passed **5 tests**. Focused strict TypeScript,
ESLint and both dry runs passed. Documentation sync and changed-file link
checks accompany this record. No full application redeployment was needed.

## Evidence and remaining gates

Private evidence root: `/tmp/abca-645-p2-clean-20260913`.

- `start-service-replay-v4-20260914`: successful service probe; earlier
  `start-service-replay*` records retain calibration and cleanup.
- `start-recovery-control-v2-20260914`: successful application control.
- `start-recovery-faults-20260914`: ten passing fault cases and the misspelled
  cancellation fixture; cleanup confirmed.
- `start-recovery-final-20260914`: corrected cancellation and real expiry passed.
- `start-recovery-final-audit.json`, `start-recovery-final-log-audit.json`,
  `start-recovery-stack-status.json`: independent final audits.

Per-run `results.json` links cases to task/worker IDs and AWS Run request IDs;
child traces record committed effects, injected faults and request fingerprints.
The five-minute service probe and the 120-second application cutoff are measured
separately.

Still required: deployed durable-Lambda interruption/checkpoint recovery,
registration/cancellation races, automatic finalization after rejected hooks,
injected cleanup failures, and an operator recovery procedure for a genuinely
unknown worker ID. A CloudTrail Event History lookup for `RunMicrovm` during
this test interval returned no events; it did not establish such a procedure.
`ListMicrovms`/`GetMicrovm` expose no task token in the installed SDK shapes.

The wider effective-role/session/transaction matrix, expired signer credentials,
ECS, public-bucket policy grants, network negatives, capacity migration and P3
sleep/wake also remain open. Read-only trust inspection confirmed the session
role accepts the exact worker roles and the MicroVM execution role trusts
`lambda.amazonaws.com`; an isolated Lambda using that unchanged role is a
possible follow-up for actual IAM requests. No such function was created.
