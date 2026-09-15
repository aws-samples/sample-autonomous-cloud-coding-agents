# #645 P3 guest pause controller

**Follow-up (2026-09-15):** [per-worker image capability](./645-p3-image-capability.md) now declares the served hooks and verifies the actual launched image version locally. The milestone below records its original scope; supervisor integration and live sleep/wake acceptance remain open.

Date: 2026-09-14. Local implementation; deployed image `2.0` still has only
ready, validate, run and terminate hooks. Automatic sleeping remains disabled.

## What is implemented

`agent/src/microvm_lifecycle.py` owns the local pause boundary. It does not call
AWS, authorize a human decision or extend an approval's deadline.

- The MicroVM pipeline registers task and VM identity, then removes the context
  on completion or failure. Hook closures retain that closed controller and
  recheck it before allowing a tool, so registry removal cannot release late
  callbacks. AgentCore/ECS do not register a MicroVM context.
- SDK pre/post/failure hooks track parallel tool calls. Suspension requires
  exactly the tool currently parked for approval. Missing/duplicate identities
  and known background work conservatively disable suspension.
- The approval hook registers the same `_ApprovalDeadline` created before its
  database transaction. Before leaving the approval wait, it must pass the
  barrier and remove the safe point. Approval/cancellation still use the existing
  conditional task-state transition.
- Approval reads and heartbeat writes already in progress drain before the
  checkpoint callback. New approval reads wait; heartbeat ticks skip while
  paused.
- All progress writer instances report their actual write acknowledgments to
  the same context. Missing tables, open circuit breakers and uncertain/failed
  writes prevent suspension. A later event cannot repair a previously dropped
  event, so this latch is separate from the transient failure counter.
- Suspend/resume callbacks run within a caller-supplied budget. Locks protect
  local state only. Generation checks prevent a callback from committing a
  transition after teardown or a superseding operation.
- A failed pre-suspend checkpoint leaves the unfrozen waiter able to proceed
  and disables further suspension. An acknowledged suspend keeps the gate
  closed until successful resume. Failed/timed-out/cancelled resume closes the
  barrier; a late callback cannot release coding.
- `/run` and successful controller resume reseed Python's application PRNG with
  `os.urandom(32)`. This does not make `random` suitable for secrets.

Concurrent lifecycle requests receive a controlled rejection without holding a
lock across network work. The later [HTTP hook milestone](./645-p3-lifecycle-hooks.md)
adds cached successful acknowledgments and clears an old wake result for each new gate.

## Why the image is not eligible for sleep yet

The later [HTTP hook milestone](./645-p3-lifecycle-hooks.md) supplies production
callbacks for atomic checkpoint writes, credential renewal and gate reconciliation.
Image capability, supervisor integration and live service verification remain open.

The worker has several independent credential consumers:

| Consumer | Current owner | Required wake work |
|---|---|---|
| Task/approval/events/nudges and tenant S3 | `aws_session` tenant session; existing clients retain its credential object | Refresh without losing tags or leaving existing clients attached to stale credentials |
| Memory, Logs, trajectory and platform secrets | Ambient `platform_client` factory, including cached clients | Refresh the actual provider used by those clients |
| Claude Bedrock requests | Separate Claude subprocess and `awsCredentialExport` cache | Prove a blocking refresh path before its first request after sleep |
| Gateway request signing | Fresh botocore session per signing operation | Verify runtime-provider renewal and signing after wake |

Inspection of the installed SDK `0.2.110`'s bundled Claude `2.1.191` found that
its helper cache uses wall-clock expiry but returns the previous value while
refreshing in the background. It also falls back to a one-hour cache lifetime
when the helper expiration is missing or six minutes or less away. Therefore:

- Refreshing Python does not clear Claude's cache.
- Returning a very short helper expiration does not force a safe refresh.
- Current documentation for newer Claude default-chain caching is not evidence
  that the pinned helper path has those semantics.

**Follow-up implemented locally:** the [credential verification](./645-p3-credentials.md)
now exercises that actual CLI. `credential_process` renewed successfully but
fell through to ambient credentials on failure. The chosen MicroVM path uses a
single authenticated, scoped container provider; renewal waits before signing,
and failure sends no model request. Python refresh updates retained credential
objects with the original identity. The HTTP resume callback now invokes this
operation; live runtime provider/snapshot verification remains open.
No minified CLI internals were patched.

Known background tool flags are tracked, but arbitrary shell/MCP subprocesses
may also detach work. Their safe-point behavior still requires a conservative
policy or process-level proof. Tool completion tracking alone must not be
advertised as proof that every process in the VM is idle.

## Verification

The agent quality gate passes: Ruff lint/format, type checking and **1,857 Python
tests** (34 added for this milestone; total branch coverage **85.02%**). The
configured Bandit high-severity gate and Vulture dead-code gate pass. A pre-existing
Vulture false positive for urllib's required `newurl` callback argument was
documented in the existing narrow allowlist; redirect behavior is unchanged.
New regressions exercise:

- Parallel tools, original gate/deadline identity and an approval arriving during
  the pause boundary.
- Cancellation winning the existing conditional resume transition.
- In-flight progress drain, failed/missing acknowledgments shared across
  writers, and heartbeat/read suppression while paused.
- Credential callback failure, cancellation, timeout and late completion;
  teardown during refresh; competing lifecycle requests.
- Frozen monotonic time with elapsed UTC approval deadline, fresh OS entropy and
  pipeline registration/cleanup.

These are local synchronization and existing-hook integration tests.
They do not prove actual AWS freeze/resume, credential renewal, hook HTTP
budgets, durable supervisor recovery or complete P3 acceptance.

## Remaining integration order

1. **Local credential implementation complete:** retained-client refresh is now
   connected to resume; verify the deployed runtime provider and snapshot behavior.
2. **Local HTTP integration complete:** acknowledged production checkpoints,
   shared budgets, duplicate handling and teardown are covered in the
   [hook verification](./645-p3-lifecycle-hooks.md).
3. Bind lifecycle capability to the image/version that launched each worker;
   declare compatible hooks, initially leaving automatic suspension disabled.
4. Wire persistent intent/policy into durable supervisor polling with bounded
   failure/wake recovery. Wake after committed approve/deny decisions.
5. Deploy through the normal CDK/bootstrap path and complete the P3 live matrix,
   including delayed suspend, expiry, cancellation, refresh failure and rollback.

The [implementation plan](./645-p3-implementation-plan.md) remains the complete
task list, including unfinished P2 live gates.
