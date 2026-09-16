# ADR-021 P3: distinguish a pending wake from initial startup

Date: 2026-09-16. The correction is local; deployment and live coordinator
verification are pending.

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
- A worker still in `HYDRATING` may use the original initial-startup timer.
- An unexpected pending state after coding began receives one bounded
  uncertainty window.

Existing recovery timers retain their start time across replay. The original
worker lifetime and first-observed time do not change. An already-expired wake
instruction still fails, and a future instruction timestamp cannot extend the
window. The change adds no durable-state field, IAM permission or image hook.

## Validation and remaining scope

The regression failed before the correction. All 150 tests in the supervisor,
MicroVM orchestrator and lifecycle suites passed afterward. Coverage includes
replay, stale wake instructions, pending/unknown observations, initial startup,
and completion after the guest consumes the decision and reports liveness.

The full repository build passed in 488.56 seconds: 4,999 CDK tests passed with
56 optional DynamoDB Local tests skipped; 1,942 Python tests passed with 11
skipped; all 928 CLI tests passed. Compilation, lint, type checks, contract/drift
checks, synthesis and the 77-page documentation build also passed.

A live check of the updated coordinator remains pending. This correction does
not explain or resolve the four separate
[resume-hook connection refusals](./645-p3-resume-refusal-investigation.md).
Production automatic suspension remains off.
