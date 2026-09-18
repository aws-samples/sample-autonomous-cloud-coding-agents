# ADR-021 P3 development deployment and guest checks

Date: 2026-09-15. The development stack is deployed with the P3 supervisor and
six-hook image. Automatic suspension remains disabled. Six isolated guest
cases pass; suspended cancellation exposed a stop-path bug that was repaired,
deployed and verified with a stronger probe below.
The full [P3 acceptance matrix](./645-p3-implementation-plan.md#acceptance-matrix-and-completion-gates)
is not complete.

## Deployed configuration

| Item | Verified value |
|---|---|
| Stack | `backgroundagent-dev`, account `<account-id>`, `us-west-2` |
| Source | `9a5f4606` on `fix/645-microvm-readiness` |
| Cancellation follow-up | `aff5e637`; cancellation Lambda code updated separately |
| Bootstrap | `1.8.0` |
| Stack status | `UPDATE_COMPLETE` |
| Root resources | 475 |
| MicroVM image | `backgroundagent-dev-abca-agent`, version `3.0`, `ACTIVE` / `SUCCESSFUL` |
| Guest protocol | `ABCA_MICROVM_LIFECYCLE_PROTOCOL=1` |
| Coordinator `live` alias | Lambda version `3` |
| Static suspension flag | `false` |
| Live SSM parameter | `/backgroundagent-dev/microvm-approval-suspend-enabled`, String `false`, version 1 |

The Lambda version identifies the supervisor's saved code. The MicroVM image
version identifies the worker's saved starting computer. They are separate
version sequences.

The image has ready, validate, run, suspend, resume and terminate hooks. Suspend
and resume each have a 30-second hook timeout. The verified image artifact is:

```text
SHA256: 6c695b782f108064c9d5ad461e67f2071d15d1cae71e7aef47afb6dfaba7f3c3
110 files; 483188 bytes
```

The coordinator's deployed code SHA256 is
`r9JIjsu84GQOfFYAepGVHKZrdps4q/bd2PeOEMCS8PY=`.

## Rollout review and retention repair

The initial application change set exposed a missing prerequisite: it removed
the previous coordinator and guardrail versions without retaining them. A
durable execution keeps its original Lambda version and environment, including
its guardrail version. Deleting either dependency can break later recovery.

The fix in `9a5f4606` retains both kinds of version across updates. It passed
192 focused infrastructure tests and the full root build in 657.59 seconds:
5,030 CDK tests, one snapshot, 1,951 Python tests, 928 CLI tests and the other
configured build checks. The 56 DynamoDB Local lifecycle/capacity cases ran.

Before replacing the existing unretained versions, a separate update adopted
retention for them. Its resource properties were identical to the previous
deployment. The only direct changes were `DeletionPolicy` and
`UpdateReplacePolicy` on those two versions; CloudFormation also listed
dependent references for reevaluation. Both live policies were verified as
`Retain` after that update.

The final application change set contained 164 modifications, three additions
and two removals. Both removals had `PolicyAction: Retain`. There were no
table, bucket, user-pool or secret changes, no required resource replacements,
and the coordinator alias and MicroVM image retained their identities.
The stack update started at 19:11:06 UTC and was observed complete at 19:19:02 UTC.

The combined coordinator policy comparison found no removed permissions. Added
permissions were image-scoped GetMicrovmImageVersion/Suspend/Resume, approval
GetItem/ConditionCheckItem, and exact-parameter GetParameter. Template/policy
comparison is distinct from exercising every permission against the service.

The IAM simulator evaluated the deployed coordinator, API and worker roles
against the configured image and an unrelated image. The coordinator's tested
lifecycle actions were allowed only on the configured image; approve/deny had
Get/Resume, cancellation had Terminate, and the execution role had none of those
actions. The coordinator could read its exact live-switch parameter and could
not read the unrelated test parameter. No unrelated-image action was allowed.
The tenant-session simulation also had no allowed lifecycle action, but reported
missing DynamoDB/tag context; it is not the broader cross-task IAM acceptance
test. Actual approve/deny calls separately verified the positive Resume path.

### Preserve the original deployment template

In this environment, CloudFormation `GetTemplate` returned question marks in
place of Unicode characters through both the CLI and JavaScript SDK. Reusing
that response produced unrelated changes, including a Cedar layer replacement.
That change set was discarded without execution.

The original template downloaded from the deployment's S3 asset matched the
saved assembly and preserved those characters. The retention adoption used that
artifact. Minifying the JSON also kept it within the 1,000,000-byte S3-template
limit; pretty-printing it exceeded that limit.

## Isolated guest acceptance

The private probe creates one owned task with no repository or notification
destination. It uses the production launch strategy, image-capability checks and
local production supervisor. For long waits it saves and rechecks a valid
suspend intent before manually requesting Suspend. Decisions invoke the
deployed approve/deny/cancel handlers with the fixture's owner identity.

This covers actual guest hooks and decision-handler IAM. It does not exercise
API Gateway authentication, admission/capacity reservation or the deployed
durable coordinator entrypoint. The global suspension settings remain false.

Each task asks for exactly one `Read` of `/etc/os-release`. Tool-result events
distinguish a successful read from a denied attempt. Cleanup confirms worker
termination before deleting launch payloads, then verifies the task's S3 prefix
is empty. The strengthened cancellation check requires API-driven termination
before this independent cleanup runs.

| Case | Observed result |
|---|---|
| Ordinary, no gate | `COMPLETED`; one Read call and successful result; 17 watcher cycles, no scheduling gaps or recovery failures; service lifetime verified; VM terminated and payload deletion requested |
| Long gate + approve | Observed `SUSPENDED`; deployed approve returned 202; same task completed; one successful Read; one approval gate; original approval clock unchanged; VM terminated and payload deletion requested |
| Long gate + deny | Frozen worker woke; deployed deny returned 202; one Read attempt returned an authoritative denial, with no retry; task completed and VM terminated |
| Original-deadline timeout | Worker was RUNNING about 54 seconds before expiry; original request became TIMED_OUT; tool error arrived 140 ms after the original deadline; no retry; task completed and VM terminated |
| Decision during grace | Enabled pure policy returned `wait` / `suspend-grace`; deployed approval committed within seven seconds of gate creation; no Suspend request; one successful Read; task completed |
| Suspended cancellation | After repairing the first run's stop omission, the API logged TerminateMicrovm and AWS reported TERMINATED before fixture cleanup; task stayed CANCELLED; one gated Read attempt and no tool result |

Ordinary task: `01M2K9H3J4V23EST0SWNE228WR`, worker
`microvm-a724cc8d-f31e-3e2d-8866-3b1ef47beaab`.

Approve task: `01M2K9QKBSP5NQ3Q8BNNB058MH`, worker
`microvm-2f927077-c8fb-3ae5-a177-e92818409da2`. Its request
`01M2K9SMP624BEKKN4ME2K3P6R` was created at 19:48:10 UTC with a 300-second timeout.
Suspend was requested at 19:48:44.782; AWS reported SUSPENDED at 19:48:50.056.
Approval committed at 19:48:50.782 and returned 202 at 19:48:52.035. Completion
was observed at 19:48:57.119. The request's creation time and timeout were
unchanged. The worker completed between polls, so AWS RUNNING after wake was not
separately sampled.

Deny task: `01M2KA3MFW5RAX7TT9GRHPN2WQ`, worker
`microvm-59ae9e19-4722-3143-97a9-725af4381a64`. The request was created at
19:54:23 UTC with a 300-second timeout. AWS reported SUSPENDED at 19:55:03.289;
the denial committed at 19:55:03.941 and returned 202 at 19:55:05.267.
RUNNING was observed at 19:55:10.465 and completion at 19:55:15.549.
The single Read result had `is_error=true` and an authoritative human denial.
The approval row retained its original creation time and timeout.

Timeout task: `01M2KA8QAVWAZ61VQH12KAZS0X`, worker
`microvm-b669614a-3613-3e1f-9747-91c0c83d2f42`. Request
`01M2KAACH57GRDTMNK3M1Z5W6F` was created at 19:57:19 UTC with a 180-second timeout.
The worker was observed SUSPENDED at 19:57:55.132, gained a resume intent at
19:59:20.009 and was RUNNING at 19:59:25.281 while the approval remained pending.
Its one Read attempt returned `User timed_out` at 20:00:19.140, 140 ms after the
original 20:00:19 deadline. Completion was observed at 20:00:23.076. The original
approval row became TIMED_OUT without changing its creation time or timeout.

Short-gate task: `01M2KAPN555FJJ0C5779GQT1RA`, worker
`microvm-9d71d590-524d-33a3-85c4-ab64e27f74f3`. Its request was created at
20:04:43 UTC with a 300-second timeout. At 20:04:48.970 the policy still required
the grace period. Approval committed at 20:04:49.706, the one Read succeeded at
20:04:52.118, and completion was observed at 20:04:55.835. The original clock
was unchanged. No Suspend request was issued.

Read-only S3 checks confirmed zero objects under all eight completed task
prefixes, including the initial ordinary attempt below. Shared bootstrap
manifests retain their normal lifecycle policy. Task/trace evidence is retained.

An earlier ordinary probe's guest also completed, but the local Mac entered
Maintenance Sleep for 900 seconds immediately after the first poll. The watcher
then exceeded its own deadline. `pmset` timestamps confirmed the cause. That run
does not establish supervisor timing; subsequent probes use command-scoped
`caffeinate -is` and record scheduling gaps.

### Cancellation defect found by the audit

The first suspended-cancellation task was `01M2KB0SX2M4JW413E8BWN4ZY2`, worker
`microvm-b7cd04f8-ee57-3341-b5ec-9f607570e310`. AWS reported SUSPENDED at
20:10:54.053; the deployed cancel handler returned 200 at 20:10:55.759.
The task became CANCELLED and the pending Read produced no tool result.

However, the handler logged no TerminateMicrovm call. Source review confirmed
that its `status === RUNNING` guard excluded AWAITING_APPROVAL, the state used
by a sleeping approval worker. The fixture's independent cleanup subsequently
terminated the VM, masking the API's omission in the original exit-code check.
This run does **not** pass API-termination acceptance.

The repair attempts to stop a saved session during HYDRATING, RUNNING,
AWAITING_APPROVAL or FINALIZING across all three compute substrates. It still
commits cancellation first, preserves a successful response if stopping fails,
and makes no stop call when the conditional cancellation loses a terminal race.
Pre-session states continue to skip stopping compute.

Ten new regression assertions failed before the fix; all 34 cancellation tests
passed afterward. The related approval/supervisor/cancellation run passed 149
tests in five suites, and compilation/lint passed. The strengthened live probe
polls for TERMINATED/not-found with a 60-second deadline after calling the API,
before any independent cleanup.

The repair is committed as `aff5e637`. Fresh full synthesis also changed
unrelated runtime asset references and guardrail version IDs. The Bedrock alpha
construct derives the inner version ID from an unresolved UpdatedAt token;
identical guardrail settings did not produce identical version IDs in these
syntheses. Investigating that churn remains a follow-up.

The repair's cloud assembly therefore uses the exact previously deployed
template with only the cancellation Lambda's Code/Metadata replaced by the
new CDK bundle. It publishes two file assets and no Docker assets. AWS's reviewed
change set contained that one direct modification and two unchanged API ARN
references for reevaluation. There were no image, guardrail, coordinator, IAM or
suspension-setting changes. The update was executed at 20:28:39 UTC and reached
UPDATE_COMPLETE. The live function checksum matches the published ZIP:
`L1sQUO2flAB3sO2nA+7xcuR058eJH2haBUIvhgyvhPg=`.

The strict retry task was `01M2KC7632R97JN3YZ17RSN9GT`, worker
`microvm-0641d6d3-afd4-3d73-88a2-06a0d304c86e`. AWS reported SUSPENDED at
20:31:46.938. The deployed API logged TerminateMicrovm at 20:31:48.532 and
returned 200 at 20:31:48.576. AWS reported TERMINATED at 20:31:51.047, before
fixture cleanup. The task stayed CANCELLED, the one gated Read had no tool
result, and its payload prefix was empty. The original approval clock stayed
unchanged; cancellation leaves the approval row PENDING under a terminal task.
This passes API-driven suspended termination, but does not establish slot
accounting or cancellation races during suspend/resume transitions.

## Evidence and remaining gates

Private evidence directory: `/tmp/abca-645-p2-clean-20260913/`.

- `p3-retention-root-build-20260915.log`: final full validation.
- `p3-retention-adoption-verified-20260915.json`: existing version protection.
- `p3-supervisor-reviewed-changeset-r2-20260915.json`: executed application review.
- `p3-live-configuration-verified-20260915.json`: live image, alias and flags.
- `p3-live-iam-simulation-summary-20260915.json`: per-resource lifecycle evaluations.
- `p3-live-ssm-iam-simulation-20260915.json`: exact switch versus unrelated setting.
- `p3-guest-ordinary-r2-20260915/acceptance-review.json`: ordinary task and tool evidence.
- `p3-guest-approve-20260915/acceptance-review.json`: freeze, decision, tool and cleanup evidence.
- `p3-guest-deny-20260915/acceptance-review.json`: denial prevented execution.
- `p3-guest-timeout-20260915/acceptance-review.json`: original-deadline comparison.
- `p3-guest-short-20260915/acceptance-review.json`: early decision and successful read.
- `p3-guest-cancel-suspended-20260915/acceptance-review.json`: original cancellation defect.
- `p3-guest-cancel-suspended-r2-20260915/acceptance-review.json`: API termination before cleanup.
- `p3-cancel-regression-before-20260915.log`: ten failing assertions before repair.
- `p3-cancel-regression-after-20260915.log`: all 34 cancellation tests pass after repair.
- `p3-cancel-related-tests-20260915.log`: 149 related tests pass.
- `p3-cancel-reviewed-changeset-20260915.json`: narrow CloudFormation repair.
- `p3-cancel-deployment-verified-20260915.json`: deployed code checksum.
- `p3-guest-payload-cleanup-verified-20260915.json`: empty task-owned S3 prefixes.

The subsequent [AWS durable record](./645-p3-durable-live-20260915.md) adds
automatic suspension, timeout, rollback, crash/cancellation recovery and cleanup
evidence, plus an unresolved intermittent approval-wake failure.
The [effective IAM record](./645-effective-iam-20260915.md) adds actual metadata
and S3 permission checks plus real signer-credential expiry. The long durable
case also proves scoped credential renewal after expiry, but exposes an
[approval callback timeout](./645-p3-callback-timeout.md). Image `4.0` now carries
the correction; the [fresh live record](./645-p3-callback-live-20260915.md)
verifies nine core callback cases, including real expired-key renewal with the
original approval deadline preserved. A fourth
[connection refusal](./645-p3-resume-refusal-investigation.md) occurred on that
image. Remaining lifecycle faults/deadline races, network and
capacity/migration checks remain tracked in the
[implementation plan](./645-p3-implementation-plan.md).
