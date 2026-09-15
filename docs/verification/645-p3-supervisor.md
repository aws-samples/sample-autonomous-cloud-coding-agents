# ADR-021 P3: supervisor and approval wake

Status (2026-09-15): production integration and full repository validation pass
locally. This milestone has not been deployed. Automatic suspension defaults
off. The [P3 plan](./645-p3-implementation-plan.md) retains the live acceptance
gates and remaining P2 checks.

## What this does

The supervisor is the part of ABCA that watches the rented computer. It now
remembers both its instructions and its deadlines when the supervising Lambda
restarts. “AWS accepted my wake request” and “the agent continued its work” are
different observations.

For a long approval wait, the supervisor checks the live suspension setting,
saves an instruction to sleep, rereads the setting, checks
the same approval again, requests suspension, and checks again afterward. The
guest's checkpoint hook must complete before AWS freezes it. New sleep requires
verified support from the worker's actual image version.

An approval can arrive while suspension is still happening. Both the decision
API and supervisor save “wake” immediately. They request Resume only after AWS
reports SUSPENDED. That instruction remains even after an acknowledgment or a
RUNNING observation, so a delayed suspension cannot silently strand the worker.
When the task leaves its gate, the supervisor can re-scope wake to the new
no-gate identity before ending recovery on the following observation.

AWS RUNNING alone cannot hide an agent stuck on an already decided or expired
gate. Recovery remains bounded until the agent moves forward. An intentional
early wake may remain AWAITING_APPROVAL while its original decision is pending.
An ordinary RUNNING worker still gets the shared heartbeat checks.

## Bounds and state

These are application choices requiring live timing verification, except the
configured eight-hour service maximum.

| Bound | Value |
|---|---|
| Entire supervisor cycle | 45 seconds |
| Individual control request, including Get/Terminate | At most 10 seconds, shortened by caller deadline |
| Lifecycle database read sequence/write | At most 5 seconds, shortened by caller deadline |
| Live suspension setting read | At most 3 seconds, shortened by caller deadline; failure disables new sleep |
| Transition poll | At most 5 seconds |
| Suspend/wake/unknown recovery | 120 seconds; repeated polls do not reset it |
| Startup/HYDRATING recovery | 300 seconds |
| Consecutive failed cycles or Resume requests | 3; permanent control denials can fail earlier |
| Session deadline | Earlier saved deadline or AWS start time + service duration, capped at 28,800 seconds |
| API work after a committed decision | At most 8 seconds, retaining 1 second of remaining Lambda time for the response |
| Each API audit attempt | At most 2 seconds inside that shared budget |
| Final cleanup | At most 25 seconds, with at most two termination attempts |

The durable poll state contains only JSON values: VM identity, original
observation/deadline, failure counters, recovery kind/start time, anomaly state
and next delay. Before verified service timing is available, a fixed deadline
from the first durable observation bounds supervision and new sleep is disabled.
Faster polls do not consume the older 1,020-attempt limit used by other backends.

Control calls and database recovery reads share the caller's AbortSignal, a
cancellation notice. An expired operation cannot start another request with a
fresh independent budget.

## Decisions, failures and cleanup

Approve/deny keep the existing authorization and conditional transaction.
Optional wake runs only after commit. A failed read, Resume or audit cannot undo
the decision or turn the accepted response into HTTP 500. The guest still owns
approval expiry; this change adds no independent API expiry rule.

Before a supervisor failure becomes a task outcome, finalization strongly reads
the task and preserves a committed completion/cancellation. Conditional failure
writes also check the original worker ID. A replacement worker is not followed.
Normal capacity release remains task-owned and happens once.

Infrastructure exhaustion during AWAITING_APPROVAL/HYDRATING uses FAILED, since
those statuses do not allow TIMED_OUT. RUNNING/FINALIZING session expiry uses
TIMED_OUT. The approval row's decision is not rewritten. This also fixes the old
approval-wait finalizer's forbidden AWAITING_APPROVAL → TIMED_OUT transition.

Termination is attempted even if database finalization fails. Its result
distinguishes requested, not-found and unconfirmed. ConflictException is
unconfirmed: a conflicting lifecycle operation does not prove termination.
An acknowledgment is not reported as observed teardown.

Diagnostics:

- `microvm_suspend_anomaly`: once per unexpected suspension episode; a new
  episode can be reported after recovery.
- `microvm_supervisor_request_failed` and command-failure events: safe error
  identifiers and the stage that failed.
- `microvm_resume_orphan`: an inline wake failed or became ineligible; includes
  task/gate, VM when known, stage, reason and validated AWS request ID when
  available. A recoverable race is not proof of a permanent orphan.
- `microvm_cleanup_unconfirmed`: bounded cleanup could not establish even a
  successful termination request; retain the original handle for recovery.

Audit writes are best-effort within the existing budget. Structured logs remain
the fallback when that budget is exhausted or the event store fails. No SDK
message, credential or signed payload URL is copied into these diagnostics.

## Deployment configuration and permissions

`microvm_approval_suspend_enabled` accepts true/false and defaults false.
It sets both `MICROVM_APPROVAL_SUSPEND_ENABLED` on a configured coordinator and
the String parameter `/<stack-name>/microvm-approval-suspend-enabled`.
The stable parameter name is passed as `MICROVM_APPROVAL_SUSPEND_PARAMETER_NAME`.
Both must allow sleep. Compatible per-worker image evidence remains an
independent admission check.

Durable executions retain their original Lambda version and environment.
An environment-only redeploy therefore cannot disable an existing execution.
The stack retains published coordinator versions and their immutable guardrail
versions across updates. Otherwise, a rollout could delete the code or guardrail
that an older execution still references. The live alias advances to the new
coordinator version. Retained versions require operator cleanup only after no
execution can resume or retry them; changing the live alias is not that proof.
For the first upgrade from an unretained deployment, drain existing executions
before removing the old versions, or retain those existing resources in a
separate update before replacing them.

The supervisor rereads Parameter Store without caching before saving new
suspend intent and again before the pre-command gate read. Missing, invalid or
unavailable values disable new sleep without counting as compute failure.
Disable after intent commit records compensating wake and skips Suspend.
Waking, timeout and cleanup never depend on reading this setting.

| Role | Added permissions |
|---|---|
| Coordinator | SuspendMicrovm/ResumeMicrovm on the configured image ARN and its version suffix |
| Coordinator | GetItem/ConditionCheckItem on the existing approvals table |
| Coordinator | GetParameter on this deployment's exact suspension parameter |
| Approve/deny API | GetMicrovm/ResumeMicrovm on that same image scope |
| CloudFormation execution role | Parameter lifecycle/tagging only under `backgroundagent-*/microvm-approval-suspend-enabled`, in the conditional MicroVM bootstrap policy |

Cancel retains its Terminate-only grant. Worker roles gain no lifecycle actions
or approval-control authority. No token minting or ingress permissions are added.
The table supplied in `microvmConfig` is the source for both the coordinator's
approval-table environment variable and its read/condition-check grant.

Refresh bootstrap to **1.8.0** before deploying the parameter. The old
`/cdk-bootstrap/*` SSM grant does not cover application settings.
Deploy the matching coordinator, API roles and six-hook image with the flag
false first. Verify the actual image version/capability and effective role
permissions. Then enable it for controlled development acceptance cases.

For operational rollback, set the live parameter to `false` and verify its
stored value. Also deploy context `false` so the declared configuration agrees.
A direct Parameter Store update is immediate configuration drift until the
declaration is reconciled. CloudFormation need not rewrite a parameter whose
declared value has not changed, so always verify the live value. A suspension
already dispatched can still finish; existing sleepers retain normal wake and
deadline recovery. Do not remove Resume/Terminate permissions while workers can
still be suspended. A function version originally deployed with static false
stays opted out even if the live parameter is later enabled.

## Validation record

The initial combined run passed 673 tests across 15 suites, including 41 real
DynamoDB Local cases. Two new database cases exercise approval during Suspend
and approval just after the intent transaction. They use the real supervisor,
store and conditional expressions, with mocked compute only.

The configured full-stack fixture initially passed 17 MicroVM checks. After the
live switch was added, 340 tests across 13 suites passed, covering uncached reads,
disable after intent commit, real handler/config composition, exact IAM and the
bootstrap policy/golden/size checks. The final root run includes all stack fixtures.

Full root `mise run build` passed, exit 0 in 640.39 seconds:

- CDK: 230 suites, 5,028 tests and one snapshot.
- Agent: 1,951 Python tests.
- CLI: 62 suites and 928 tests; Forge: 11 tests.
- Compilation, lint, formatting, types/drift checks, bundled synthesis,
  documentation build and links all pass.
- DynamoDB Local was enabled: 41 lifecycle and 15 capacity cases ran.

The full run caught two old start-recovery assertions omitting the newly bounded
Terminate request's AbortSignal; they now assert it. A subsequent comment lint
failure was corrected before the final passing run. Final evidence:
`p3-supervisor-root-build-r4-20260915.log`.

The deployment change-set review then exposed missing retention for published
coordinator and guardrail versions. The fix passed 192 focused infrastructure
tests and another complete root build in 657.59 seconds: 5,030 CDK tests,
1,951 Python tests, 928 CLI tests and all other configured checks. DynamoDB Local
remained enabled. Evidence: `p3-retention-root-build-20260915.log`.

Local evidence does not establish AWS timing, IAM effectiveness, actual frozen
credential renewal or deployed durable replay.

Evidence directory: `/tmp/abca-645-p2-clean-20260913/`.

## Relevant code

- `cdk/src/handlers/shared/microvm-supervisor.ts`: durable reconciliation and
  bounded cleanup diagnostics.
- `cdk/src/handlers/shared/microvm-approval-wake.ts`: bounded post-commit wake.
- `cdk/src/handlers/shared/microvm-lifecycle.ts`: strong snapshots and conditional intent.
- `cdk/src/handlers/shared/agent-heartbeat.ts`: shared liveness thresholds.
- `cdk/src/handlers/shared/microvm-control.ts`: safe diagnostic identifiers.
- `cdk/src/handlers/shared/microvm-suspend-config.ts`: uncached bounded live switch.
- `cdk/src/handlers/orchestrate-task.ts` and `shared/orchestrator.ts`: poll/finalize ownership.
- `cdk/src/handlers/approve-task.ts` and `deny-task.ts`: accepted decisions and
  best-effort wake/event callbacks.
- `cdk/src/constructs/task-orchestrator.ts`, `task-api.ts` and `stacks/agent.ts`:
  flag, table and scoped IAM wiring.
