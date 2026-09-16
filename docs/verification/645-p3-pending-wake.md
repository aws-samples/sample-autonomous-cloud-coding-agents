# ADR-021 P3: distinguish a pending wake from initial startup

Date: 2026-09-16. The correction is deployed in coordinator version 4; live
coordinator acceptance remains pending.

## Trigger

The [minimal listener experiment](./645-p3-listener-probe-20260916.md) observed
this real AWS sequence for worker
`microvm-47df351d-efe7-33f9-bf86-1892b66dc203`:

| UTC time | Observation |
|---|---|
| 03:09:26.768 | `SUSPENDED` |
| 03:09:27.054 | `PENDING`, after Resume was requested |
| 03:09:27.684 | `RUNNING` |

The service has no separate `RESUMING` enum, but `PENDING` can appear during
restoration. It does not always mean a worker's first startup.

## Bug and correction

When a worker is stably asleep, the supervisor has no active recovery timer.
The approval API can save a wake instruction and request Resume between
supervisor polls. If the next poll sees `PENDING`, the old supervisor starts a
startup timer using the worker's original first-observed time.

For a worker older than five minutes, that timer is already expired. The
supervisor can fail an otherwise healthy wake immediately.

A regression reproduced this with the production supervisor function: after
six minutes asleep, a committed approval and wake instruction followed by
`PENDING` returned `failure` with recovery kind `starting`. This is a local
reproduction of the coordinator bug, informed by a real AWS state sequence;
the minimal experiment itself does not run the durable coordinator.

The supervisor now handles `PENDING` and unknown observations as follows:

- A wake instruction matching the same worker and approval uses its saved
  request time for bounded wake recovery.
- In deployed version 4, a worker still in `HYDRATING` may use the original
  initial-startup timer. The follow-up below also covers the coordinator's
  transition to `RUNNING` before AWS startup completes.
- An unexpected pending state after coding began receives one bounded
  uncertainty window.

Existing recovery timers retain their start time across replay. The original
worker lifetime and first-observed time do not change. An already-expired wake
instruction still fails, and a future instruction timestamp cannot extend the
window. The version-4 correction added no durable-state field, IAM permission
or image hook.

## Follow-up: task RUNNING does not establish worker readiness

The [full-agent observer experiment](./645-p3-process-observer-20260916.md)
found another startup case. Task `01M2N176C2WQ21PJ92FMTSZA9A` was already
`RUNNING` while AWS still reported its new worker as `PENDING`. Its actual first
supervisor result at 12:09:28.207 UTC used `unconfirmed`, a two-minute allowance,
instead of the intended five-minute startup allowance.

The coordinator deliberately transitions the task before observing worker
readiness. The follow-up therefore records an optional internal
`startupConfirmed` flag, initially false and set true after AWS reports
`RUNNING`, `SUSPENDING` or `SUSPENDED`. Initial `PENDING` observations can then
use the original startup clock regardless of task status. Failed initial reads
retain that phase across replay. An older saved state without the flag does not
receive a new startup phase. Wake instructions and existing recovery clocks keep
their previous behavior.

Two regressions failed before this follow-up and passed after it; current and
legacy confirmed-worker cases also retain bounded uncertainty recovery.
All 154 focused tests passed. The full build passed 4,995 CDK tests but hit eight
disk-space failures in one stack suite. After removing obsolete generated
assemblies, that entire suite passed all 138 tests, covering all eight failures.
Python, CLI, lint, types, contracts, documentation and synthesis passed. The
successful west-region synthesis was repeated after the same disk-space issue.

Four real first-start `PENDING` polls in the private coordinator also retained
the original startup clock. Production deployment of this follow-up is pending;
it changes no IAM permission or agent hook.

## Validation and remaining scope

The regression failed before the correction. All 150 tests in the supervisor,
MicroVM orchestrator and lifecycle suites passed afterward. Coverage includes
replay, stale wake instructions, pending/unknown observations, initial startup,
and completion after the guest consumes the decision and reports liveness.

The full repository build passed in 488.56 seconds: 4,999 CDK tests passed with
56 optional DynamoDB Local tests skipped; 1,942 Python tests passed with 11
skipped; all 928 CLI tests passed. Compilation, lint, type checks, contract/drift
checks, synthesis and the 77-page documentation build also passed.

The narrow deployment completed at 11:48:07 UTC in `sphia-dev`, `us-west-2`.
The live alias now selects coordinator version 4, with code SHA-256
`1aITI4Dx3HdUMuAn9DnVLphZTpX6s4jyn+Odoz/N1Rs=`. Version 3 remains retained.
The reviewed change set modified only coordinator code/version/alias resources.
Resolved environment values, guardrail version 3 and agent image 4.0 are unchanged.
Both the environment and SSM automatic-suspension switches remain `false`.

The exact published coordinator ZIP and deployment evidence are preserved in
the private persistent archive
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/listener-pending-evidence.tar.gz`
(SHA-256 `221dffad6be148b296e95d89b501f6489db9038416d482cb0753c78465d59994`).

A live check of the updated coordinator remains pending. This correction does
not explain or resolve the four separate
[resume-hook connection refusals](./645-p3-resume-refusal-investigation.md).
Production automatic suspension remains off.
