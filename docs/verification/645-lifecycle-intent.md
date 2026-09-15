# MicroVM lifecycle intent: local implementation and verification

Status: foundation implemented locally on 2026-09-13; [production supervisor/API integration](./645-p3-supervisor.md) added on 2026-09-15. **Not deployed; new suspension defaults off.** This is the next foundation after `f3e684d4`. The [P3 checklist](./645-p3-implementation-plan.md) tracks the remaining integration and live gates.

## In plain language

The supervisor needs a saved instruction that says “this particular task's computer should sleep” or “it must wake up.” Saving it in the database lets a replacement supervisor continue after a restart.

Each instruction has a unique revision stamp. A supervisor holding an older stamp cannot overwrite a newer instruction. Once “wake up” is saved for an approval request, that same request cannot become “sleep” again. The record stays until the task expires; deleting it would let an old supervisor mistake the empty space for permission to save its old sleep request.

## What the code does

- `cdk/src/handlers/shared/microvm-lifecycle.ts` reads the task and its current approval consistently, validates identity, and saves intent with database conditions.
- `cdk/src/handlers/shared/microvm-lifecycle-policy.ts` chooses an action from observations. It makes no AWS calls or human decisions. Its returned action is reconciled by the durable supervisor.
- `SessionStatus.microvmState` carries explicit MicroVM state alongside the existing coarse status. Known SDK states are preserved; absent/future states become local `UNKNOWN`, and a not-found response becomes local `NOT_FOUND`. These last two are observations defined by this application, not service states. Existing status/reason behavior is preserved.

The internal `microvm_lifecycle` task attribute contains:

| Field | Meaning |
|---|---|
| `version` | Record format, currently `1` |
| `generation` | Unique revision stamp; replaced when the gate/action changes |
| `microvm_id` | The computer this instruction belongs to |
| `request_id` | The approval request, or null when recovering a working task |
| `action` | `suspend` or `resume` |
| `requested_at_ms` | Original request time, milliseconds since the Unix epoch |
| `deadline_ms` | Original approval expiry, or null if no valid deadline is available for conservative wake |

Repeated saves of the same action for the same VM/gate retain their generation and request time. This keeps retries from resetting the future recovery budget. Each database transaction gets its own AWS request token; reusing the persistent generation as that token would conflict when the transaction's conditions change on replay.

This is coordinator data, with no public task-type or agent contract change. The existing worker attribute allowlist excludes it; the session-role regression now names it explicitly. Real AWS permission verification remains pending.

## Conditions and races

Every write checks the current task owner, status, session ID, VM ID, endpoint, approval-request identity and previous instruction generation. A first write requires the attribute to be absent. A suspend also condition-checks the **same approval row** in the transaction: still PENDING, same owner, original creation time and timeout. A concurrent decision, changed gate or cancellation rolls back the whole write.

Resume does not require a readable approval row. If that row is missing, malformed or temporarily unreadable, waking an already-sleeping task allows the existing agent decision loop to recover or expire it. Approval-read failures are explicit observations, including a safe error class; integration must report and count them.

A lost database reply triggers readback. Only the exact saved generation with still-eligible task/gate identity is returned as saved. A known committed write followed by cancellation or a decision returns stale. An unresolved outcome remains an error. Cancelled/closed tasks may retain their old approval pointer; reads preserve it for diagnosis without reading the approval again, and writes cannot revive those tasks.

**Saving intent does not lock AWS.** There remains a gap between a database write and a compute command. The future caller must reread identity/intent/deadline before suspend, persist wake requests even when the VM still looks awake, and reconcile after both acknowledgements and uncertain outcomes. Guest hooks must also validate the live task/gate before allowing a freeze or resumed work.

## Initial policy

These are local policy choices to validate with live measurements:

| Setting | Initial value |
|---|---|
| Wait before considering sleep | 30 seconds from gate creation |
| Wake before approval/session deadline | 60 seconds |
| Minimum useful sleep interval | 30 seconds |
| Poll during a transition/unconfirmed observation | At most 5 seconds |
| Database request/read-sequence budget | 5 seconds; write plus recovery can use two budgets |

A caller supplies valid times, session expiry, its normal poll interval and an enable switch. New suspension also requires compatible-image evidence from the snapshot's saved worker handle. The [image capability implementation](./645-p3-image-capability.md) verifies the actual launched image ARN/version and persists the supported protocol in coordinator-owned metadata. Both policy and store reject unknown/legacy capability; the suspend transaction rejects image metadata changes after the read. Current deployment settings cannot authenticate an older worker. Disabling new suspends still permits wake and termination. Long poll intervals are shortened to the next grace/wake/session deadline.

A PENDING approval alone is not a wake condition. An intended suspended VM can wait while there is sufficient time. APPROVED, DENIED, TIMED_OUT, STRANDED, deadline proximity, missing/invalid data or unintended suspension require wake/recovery. While the service reports SUSPENDING, save desired resume but return `requestReady: false`; issue ResumeMicrovm only after observing SUSPENDED. A wake acknowledgement followed by a delayed old suspend remains repairable because wake intent is retained.

Terminal/cancelled/finalizing tasks cannot resume. Terminal VM observations go through existing task reconciliation. PENDING/UNKNOWN or a legacy coarse `running` result cannot authorize suspend or confirm wake. The supervisor now bounds persistent failures and unconfirmed recovery across serialized polls.

## Verification and deployment gates

The unit suite checks the policy and store contract. The opt-in DynamoDB Local suite checks actual transaction expressions, cross-table rollback, competing/stale writers, changed task/approval identities, later gates, lost committed replies, cancellation during recovery and a fresh module/client reading the saved intent.

Recorded local results (2026-09-13): CDK lint/compilation passed; **158 suites / 3,738 tests** passed in the broad handler/session-role run, including **23 lifecycle** and **15 existing capacity** database tests. Five relevant suites passed **218 overlapping tests** and exited normally. The broad run exited successfully after a delay without an open-handle trace; the cause is unconfirmed. Documentation sync/build/link checks passed, and the temporary database container was removed.

Run locally from `cdk/` with a loopback DynamoDB Local instance:

```sh
ABCA_DDB_LOCAL_ENDPOINT=http://127.0.0.1:<port> mise run testf -- test/handlers/shared/microvm-lifecycle-local.test.ts
```

The tests use dummy credentials, create uniquely named tables and delete them afterward. They do not prove AWS IAM or MicroVM behavior.

Before enabling automatic sleep:

1. Complete a clean P2 deployment/rerun, including the earlier bootstrap, metadata, capacity and managed-image gates. Follow the coordinated v2 drain/rollout procedure.
2. Implement guest lifecycle context, acknowledged progress durability, credential refresh preserving task identity, resume barriers and snapshot randomness handling. Reuse the original approval deadline.
3. **Implemented locally:** policy/store are connected to durable supervisor polling, preserving counters, next-poll delay, anomaly episodes and a bounded wake-recovery clock. Handle stale results by observing again. Never reset the recovery clock on repeated saves.
4. Connect approve/deny after the decision commits, with bounded best-effort wake and repair diagnostics. Preserve current decision responses on wake failure.
5. Add and verify the coordinator's required task/approval transaction permissions and scoped MicroVM lifecycle grants. Grant no lifecycle action or intent-write permission to workers. Check the total handler time budget, not only each individual call.
6. Deploy compatible hooks/image and coordinator together with automatic suspension initially disabled. Validate actual transition/conflict/timeout behavior and then the full P3 acceptance matrix in an isolated development deployment.
7. Exercise disable/rollback with sleeping tasks: stop new suspends, continue wake/expiry/termination, and drain before removing compatible code. Do not delete intent records to “reset” recovery.

The existing approval API uses the PENDING/task/gate transaction conditions; it has no independent wall-clock expiry check. The agent owns the conditional TIMED_OUT write, and the first committed decision wins. This implementation preserves that behavior. Strict API deadline rejection would be a separate behavior change.
