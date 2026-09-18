# Retained approval continuation — September 17, 2026

The local implementation and isolated persistence checks are complete. Full
replacement-worker execution and the normal nested deployment remain open.
This record does not claim P3 deployment acceptance.

An unanswered request now has no automatic deadline by default
(`approval_timeout_s: 0`). A positive, explicitly selected timeout remains
available. Pending requests have no DynamoDB deletion timer; closing their task
cancels unanswered requests and retains the decision history for 90 days.
The agent decides how to continue after an answer. There is no new system that
tries to determine whether the proposed action is still relevant.

## Worker and task lifetimes

At an approval boundary the worker saves the conversation, pending proposal,
workflow context, exact accumulated usage, and full Git/workspace archive.
Objects are versioned and checksummed. New tool execution stays blocked while
the checkpoint is ready.

The coordinator verifies all saved versions before fencing the old worker.
Its authority is a separate, coordinator-owned `worker-lease#<task>` record:
the worker can read and condition-check that record, but cannot change it.
After confirmed shutdown, the task becomes `PARKED` and returns its capacity
reservation while the approval stays available.

An answer triggers admission of one replacement attempt when capacity permits.
Admission, its new lease and capacity reservation form one DynamoDB transaction.
A deterministic Durable execution name deduplicates invocations. The replacement
uses the original published coordinator version and exact source image version,
then restores the saved files/conversation and consumes the recorded answer.
Its budget is the original allowance minus the accumulated cost and turns.

Repository-free MicroVM tasks use a private directory per task, with a local Git
baseline for the same archive format. Recovery preserves those scratch files
without creating a remote or installing a GitHub credential helper. A closed
worker cannot proceed to the workflow's artifact or PR delivery steps.

The scheduled continuation manager retries unfinished retirement, missed
dispatches and terminal cleanup. Its persistent scan cursor advances across
invocations. It does not have permission to launch, suspend or resume workers;
launching remains with the pinned coordinator.

A failed start request does not prove that AWS failed to create a worker.
Terminal saved tasks keep their capacity until the manager confirms shutdown,
or until the full service lifetime has elapsed for an unknown handle. The
coordinator records `CLOSED` in the exact-attempt lease before the atomic release.
`TERMINATING` alone is insufficient.

## Verification

- TypeScript compilation and ESLint passed.
- Focused coordinator/cleanup checks: **107 passed, 15 skipped**, 11 suites.
- Python recovery entry point and runner checks: **69 passed**. These include
  actual Git/archive restoration through `restore_for_task`, registration races,
  approve/deny/timeout handling, identity rejection and cumulative budget limits.
- Private real-SDK approve/deny recovery: **2 passed** using the pinned SDK/CLI.
- Full agent quality after repository-free recovery: **2,139 passed, 13 skipped**,
  with 86.21% coverage. CLI compilation and **943 tests** passed.
- Private AWS coordinator suite: **12 passed**, including six competing
  admissions, deliberately lost successful fence/park/admission replies, a
  day-old unanswered request, repository-free admission, opt-in expiry, capacity
  ownership and cleanup.
  All three temporary tables and the temporary versioned bucket were deleted;
  absence was verified. This suite launched no MicroVM worker.

The standalone integration runner, README, source hashes and raw evidence are
outside Git at
`/Users/sphias/.local/share/abca-verification/645-p3-integration`.
The coordinator run is `runs/20260917T191209Z-6beab7bb`; the SDK run after the
retained-request default is `runs/20260917T184225Z-f4ac16e3`.

The requested
[microvms-agentd reference](https://github.com/laithalsaadoon/microvms-agentd/tree/78304e361fbbe62e3a6b255b43c6f6c372b47510)
informed bounded transfers, disk-reserve checks, artifact assertions and cleanup
receipts. No reference executable was run and no source was copied. ABCA keeps
its task-scoped credential broker and complete Git/workspace preservation.
