# ADR-021 P3: live cancellation, approval and polling-failure races

Six required AWS cases passed on September 16. They cover cancellation around
sleep/wake commands, directly observed `SUSPENDING` and restore `PENDING` states,
approval during an accepted suspension, and three consecutive failed status
reads. Nine workers were used: three harness-invalidated attempts were retained,
excluded and replaced.

**P3 remains incomplete.** These checks do not explain the four original
[resume connection refusals](./645-p3-resume-refusal-investigation.md).
Normal automatic suspension remains disabled.

## Test boundary

- Account `<account-id>`, profile `sphia-dev`, region `us-west-2`.
- Normal worker image `backgroundagent-dev-abca-agent:5.0`, artifact SHA-256
  `9b3150e9e5991cc9fcc8a4adbb2cfbd8f97399f0c16baa9c2b5fe5b101e7b035`.
- Temporary durable coordinator `backgroundagent-dev-p3-races-20260916`,
  with an exact task whitelist, dedicated role and private suspension switch.
- Compiled production handler and supervisor, plus a private wrapper that
  invokes the normal approve/cancel handlers at specific SDK command boundaries
  or deliberately hides selected successful Get responses as `TimeoutError`.
- No guest changes. Observed lifecycle hooks ran as PID 1. Each task allowed
  one harmless `Read` of `/etc/os-release`, six turns and a $1 budget; worker
  and durable execution lifetimes were capped at 1,800 seconds.
- Original approval windows were 600 seconds, except the restore-cancellation
  case's 150 seconds. Its normal pre-deadline wake occurred while approval was
  still pending.
- Decision/GetTask handlers received fixed synthetic owner events through
  direct Lambda invocation. This checks their deployed code and permissions,
  not API Gateway authentication.

The wrapper records the real service receipt and the decision invocation before
returning control to the supervisor. Thus a test proves which command boundary
was crossed. A separate AWS state read records the state actually observed;
an accepted Suspend request alone does not prove `SUSPENDING`.

## Required results

| Case | Task | Observed state at intervention | Result |
|---|---|---|---|
| Cancel after pre-command read, before Suspend submission | `01M2NDHS2AC0569CXMJGA5ZR6Z` | `RUNNING` | Cancel committed; subsequent real Suspend rejected; task stayed canceled |
| Cancel after Suspend acceptance, before supervisor post-command read | `01M2NDHS2BYXTGNKVTW1MMHSRJ` | `RUNNING` | Cancel committed; checkpoint refused the changed task; cleanup passed |
| Cancel after Resume acceptance | `01M2NDHS2B73V9S034FBFFE7RM` | Restore `PENDING` | Task stayed canceled; no tool result |
| Approve after Suspend acceptance | `01M2NE0YFTXKRAVH2XPW702K2N` | `RUNNING`; later observed sleep/restore | Same gate resumed; approved Read succeeded once |
| Cancel during observed suspension | `01M2NE0YG0PT357AS5K2MVD33G` | `SUSPENDING` | Task stayed canceled; no tool result |
| Three failed status reads while asleep | `01M2NENZNP5BE95TCSE96SYCJ3` | `SUSPENDED` for all three hidden responses | Failure count reached three; task failed and cleanup passed |

All six reached terminal worker state, released their saved capacity reservation,
left a zero user counter and removed their launch/payload objects **before any
independent watcher cleanup**. Durable executions succeeded by completing their
expected task finalization; that does not mean the intentionally failed task
became successful.

Strong final reads and logs retain the original approval creation time/window,
coordinator first-observation time and non-increasing worker lifetime deadline.
The approved case has one Read result containing `PRETTY_NAME` and a complete
trace with zero dropped records. Each negative case has one gated Read attempt
and no tool result. Those terminated tasks do not all have a final trajectory;
the retained task events and lifecycle/control evidence establish this narrower
claim.

## Specific race evidence

**Cancellation before submission.** Worker
`microvm-53ec3d4d-d6cc-3542-a910-9d00cc7c4ae0` entered the wrapper's Suspend
boundary at 15:36:35.245 UTC. Cancel returned 200 at 15:36:36.932, before the real
Suspend returned `ValidationException` at 15:36:38.788, receipt
`edccbf8a-436e-4e06-9fec-f3e287db9afa`. The supervisor's post-command read preserved
cancellation despite that service error.

**Cancellation during checkpoint.** Worker
`microvm-dd64aab4-23f6-3714-91d7-25ea3d9d20b4` received Suspend acceptance at
15:37:50.256, receipt `f7d03f96-a405-4c39-a81d-68c97f324361`. Cancellation committed
before its checkpoint transaction failed with `TransactionCanceledException`,
receipt `7B2F9PRFP9JSUS95BPI0LNMPEVVV4KQNSO5AEMVJF66Q9ASUAAJG`.
The hook returned HTTP 503 at 15:37:50.431 and marked suspension ineligible.
No resume hook ran. This is an observed application checkpoint rejection after
cancellation, not an unexplained wake-connection failure.

**Cancellation during restore.** Worker
`microvm-ece908cf-7fd0-385e-aff9-bd3878500bb8` received Resume acceptance at
15:41:51.965, receipt `528dbbed-3b34-43f4-9a9f-08332f78fd0e`. A fresh Get reported
`PENDING` at 15:41:52.245, receipt `3612d0cb-3f28-4676-b171-94849583ffaf`.
Cancel returned 200 at 15:41:52.809, before the wrapper returned at 15:41:52.814.
The 150-second approval remained pending; no approved tool ran.

**Cancellation during suspension.** Worker
`microvm-1f1f49e0-217e-3c65-a44b-45ffe9fe3fd9` received Suspend acceptance at
15:56:03.561, receipt `4e767b18-89d1-4557-ab76-4437b51ab69f`. Get reported
`SUSPENDING` at 15:56:03.744, receipt `e5ca583d-7ab4-4c4b-aed1-ec114ebe5e81`.
Cancel returned 200 at 15:56:05.344, before the supervisor regained control.

**Repeated polling failure.** Worker
`microvm-ad53c767-8fae-3f61-8b94-eb6ee0202e57` remained genuinely suspended while
the wrapper deliberately hid three real Get responses. Across consecutive
durable cycles, logs recorded `stage=substrate-read`, `error_type=TimeoutError`
and failure counts 1, 2 and 3. The final reason was
`MicroVM supervisor: substrate-read-failed`. The coordinator sent Terminate;
a fresh worker read confirmed `TERMINATED` at 15:54:25.536. There was no watcher
repair.

## Rejected attempts and harness corrections

These attempts are not included in the six-case acceptance count:

1. Approval task `01M2NDHS2B6087T1925SRRPDSX` completed its Read, but the watcher
   demanded `TERMINATED` while AWS still reported `TERMINATING`. Its fallback
   cleanup ran. A fresh approval task supplied clean acceptance.
2. Poll task `01M2NDHS2BZYNEMHAQ7JDY41ZP` never received its intended faults:
   esbuild renamed `GetMicrovmCommand` to `GetMicrovmCommand2`, defeating a
   `constructor.name` comparison. It was explicitly canceled. The injector now
   checks SDK command classes with `instanceof`.
3. Poll task `01M2NEBTY1CVS4B56ZJDVKS8CE` received all three intended faults and
   the coordinator sent Terminate, but the watcher compared a `SUSPENDED`
   sample taken **before** it read the completed durable execution. Fallback
   cleanup invalidated that acceptance attempt.

The final watcher observes a fresh terminal worker state for at most 30 seconds
after durable finalization. Task, worker and execution reads are separate calls,
so their values are not one atomic snapshot. This observation window sends no
repair commands. Original sources, logs, failures and replacement identities
remain in the private evidence.

## Feedback correction and validation

The polling test exposed an application feedback gap: the persisted supervisor
reason was classified as `unknown` / `user`, with the title “Unexpected error.”
Commit `d150991715c27dafecbe1eb4ab7ce44e98e02bff` gives those exact known reasons a
compute/platform classification and the title “The MicroVM status could not be
checked.” Guidance names `microvm_supervisor_request_failed`, the task/worker
IDs, stage, error type and AWS receipt, and requires checking termination and
saved progress before replacement.

The same commit corrects two stale cancel-handler comments: the coordinator
saves the runtime ARN, and sleeping-worker AWS memory-quota consumption remains
unverified. The cancel handler's commentless TypeScript output is unchanged.

Validation passed: 134 focused classifier tests and the full repository build,
including 5,025 CDK, 928 CLI and 1,947 Python tests; Python coverage was 86.43%.
The optional DynamoDB Local suites were skipped (56 CDK and 11 Python cases);
earlier transaction evidence remains separate.

## Normal deployment of the feedback fix

At 16:13:15.851 UTC, `backgroundagent-dev` was verified `UPDATE_COMPLETE`,
running coordinator alias `live → 7`, code SHA-256
`/JcZuu12fMVSOoO4NwxsLGlLIJ5w9XYjAyx7cuBRA+I=`. Version 6 remains available,
and its environment matches version 7 exactly. Image 5.0, Cedar layer version 2
and both disabled suspension settings were preserved.

The reviewed change set contained 29 Lambda `Code` updates plus the retained
old/new coordinator version and alias changes: 32 changes, no replacements.
All 29 deployed code hashes matched the actual reviewed S3 ZIP contents
(409,965,183 bytes hashed).

A direct invocation of the normal GetTask handler for the real failed poll
task returned the new title, compute/service classification, nonretryable flag
and specific supervisor-log/termination guidance. Existing saved task errors
therefore receive the corrected explanation without rewriting their records.

One preview was rejected before execution. In this environment, the SDK's
`GetTemplate` result replaced every non-ASCII character with `?`, including `§`
and dash characters in descriptions. Reusing that result would have changed
unrelated descriptions/dashboard text and replaced the Cedar layer. The
replacement preview used the exact previously deployed S3 template, verified
against SHA-256
`e9e58901d4fef62a9b9a07b24068b61cc2cf51849847c261df1f6ab7597b8698`.
AWS then reported only the intended 32 changes. The rejected preview and the
character-for-character loss comparison remain evidence; the underlying cause
within the retrieval path was not isolated.

Deployment proof is under
`/tmp/abca-645-p2-clean-20260913/p3-race-feedback-rollout-20260916`.

## Cleanup, evidence and remaining scope

Cleanup was verified at 16:04:09.508 UTC. All nine workers were terminated.
The private function and its four versions, role/policies, suspension parameter
and log group were deleted; 1,236 function log records were archived first.
Nine zero counters were removed with revision checks. Task/event/trace audit
records remain. Immediate function-deletion observation lagged; subsequent
read-only checks confirmed all temporary resources absent.

Private evidence is under
`/tmp/abca-645-p2-clean-20260913/p3-command-races-20260916`, including four exact
function bundles, the task whitelist/policies, run histories, hook/API logs,
strict audit, excluded attempts and cleanup proof.

Still open: late approval versus timeout races, credential-refresh failure
injection, remaining durable registration/unknown-worker recovery, other-backend
permissions/networking, a final cloned-repository workflow, capacity migration
and compatible rollout checks. The [implementation plan](./645-p3-implementation-plan.md)
tracks their order. No original connection refusal occurred in this matrix;
that does not close its separate investigation.
