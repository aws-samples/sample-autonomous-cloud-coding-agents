# ADR-021 P3: durable registration and unknown-worker recovery

Verified September 16, 2026, in account `<account-id>`, `us-west-2`.
All three cases passed on normal image 5.0 with sleep disabled. They used the
production durable coordinator from source `a81c565d` with explicit SDK-boundary
faults in a private wrapper. Normal coordinator version 8 was unchanged.

## What was verified

| Case | Task | Worker | Result |
|---|---|---|---|
| Reply lost after registration commits | `01M2NMZS79FGKJVA3EP10AZB2W` | `microvm-ca2ceb94-be3f-3bec-a02a-9d4bb4396ee0` | Recovered saved identity; one Run, one approved Read, normal cleanup |
| Cancellation during registration | `01M2NMZS7F6JPKPBF9YVDJBY3J` | `microvm-162d5f5c-ed2c-3a3e-b066-af2685ea199d` | Cancellation committed first; identity retained for automatic termination; zero tools |
| All launch replies lost | `01M2NMZS7FARVEH9VE1ES3DGZB` | `microvm-3e8f25f0-0d9d-34fe-84e4-b27bcfa5e4f9` | Task reported uncertain start; operator recovered and stopped the live worker from an exact guest-log identity match |

Each repository-free fixture permitted at most one attempted Read of
`/etc/os-release`, with a six-turn/$1 model budget and 1,800-second worker and
durable execution ceilings. No publication or notification was requested.

### Lost registration reply

The actual DynamoDB handle-registration write committed at 17:48:07.652 UTC,
request `I5PMH0TGHU49H2U0GSBL82FGQFVV4KQNSO5AEMVJF66Q9ASUAAJG`.
The wrapper then threw a timeout instead of delivering the successful reply.
The production code read the saved identity and continued with that worker.

Only one Run call occurred, receipt `47b3b36e-1da7-423f-b170-ca9c0ec737d0`.
The task completed after one approved Read. Its complete trace contains exactly
that tool call and no dropped events. The coordinator terminated the worker,
released its reservation and removed payloads without observer repair.

### Cancellation before identity registration

The normal cancellation API returned HTTP 200 at 17:48:37.385 UTC, receipt
`aabf2ae3-feaa-4bd5-9070-3bf5e89e1649`. The subsequent identity write committed
at 17:48:37.406 with the task already `CANCELLED`.

Saving the known worker ID after cancellation is intentional: it gives cleanup
a computer to stop. It does not restore the task to running. The coordinator
observed cancellation and terminated the same worker. No tool call or result
occurred. Reservation release and payload deletion completed automatically.

### Worker ID absent from coordinator state

The first Run response was held until the owned guest reached its approval
wait, then discarded. This ensures a live worker exists for the intended
recovery check. The wrapper discarded the retry's response too; neither
returned worker ID nor endpoint was written to the task, wrapper steps or
coordinator logs before operator recovery.

| Time UTC | Evidence |
|---|---|
| 17:48:42.835 | First Run request uses the task ID as its stable token |
| 17:48:44.867 | Guest logs the accepted `/run` with both task ID and worker ID |
| 17:48:50.039 | Owned task observed waiting for approval, without a saved worker ID |
| 17:48:50.045 | First accepted reply discarded; receipt `60a86e07-2eb9-4fdb-ad66-92f04a4a6529` |
| 17:48:50.258 | Retry reply discarded; receipt `b3d0ab9c-f3e3-4210-b65a-a6c36a0e9433` |
| 17:48:51.604 | Observer reads failed task and completed durable execution |
| 17:48:55.814 | Operator recovers the exact worker from the guest log and verifies it is `RUNNING` |
| 17:48:55.983 | Operator requests termination; receipt `a8f66ec1-d23c-4ae3-b085-ca2bb5a08b94` |
| 17:48:57.662 | Worker observed `TERMINATED` |

Both Run attempts used the same token. The task and normal task API reported
`MICROVM_START_OUTCOME_UNKNOWN`. A snapshot taken before operator recovery
contains no session ID, saved start handle or compute worker ID. The pending
Read never produced a result.

The coordinator released capacity and removed payloads. The operator explicitly
terminated the recovered computer; this case does **not** claim automatic
cleanup of an unknown ID. The final inventory contained exactly the three new
workers and no active worker. This check exhausted the normal two start attempts
within seconds; it does not retest the separate 120-second receipt cutoff.

## Operator procedure when the start result is uncertain

1. Read the task consistently and inspect its saved start receipt and compute
   metadata. If an ID is already saved, use that identity and normal cleanup.
   Preserve the original task ID, client token, timestamp and error evidence.
2. If the ID is absent, inspect the configured MicroVM guest log group in the
   original region and launch window. In this deployment it is
   `/aws/lambda-microvms/backgroundagent-dev-abca-agent`. Require an explicit
   accepted `/run` entry containing **both** the exact task ID and worker ID.
   A nearby timestamp or membership in the same shared image is insufficient.
3. Require one unambiguous identity. Read `GetMicrovm` and check its image
   ARN/version, execution role, start time and current state against the original
   launch. Confirm the task is terminal or has been canceled before stopping
   a worker that may still be active.
4. Terminate that exact worker, verify its terminal state, and verify task
   reservation/counter and payload cleanup. Retain the operation receipt and
   identity evidence privately. Do not start another worker to mask the unknown
   result.

This procedure requires retained guest identity logs. A bootstrap failure before
that log entry, missing logs or multiple candidates requires further
investigation; do not guess which shared worker to terminate. The
[service feedback F07](./645-lambda-microvm-service-feedback.md) still asks for a
supported token/receipt-to-worker mapping and guaranteed token-retention behavior.

## Evidence and cleanup

The private function was `backgroundagent-dev-p3-registration-20260916`,
version 2, code SHA-256
`khdHcavtr07wQQDqzWowtMNo/q5XZak+2JodEMhmtXk=`.
Unused version 1 and its original artifacts were retained in the evidence; no
task used it. Version 2's wrapper bundle SHA-256 is
`cc058531418d339cb295817b153353ab0c8e68b7a9ee231def58c533f671d5e6`.

Evidence under `/tmp/abca-645-p2-clean-20260913/p3-registration-20260916`
includes durable histories, all task events/approvals, complete diagnostic
windows, the pre-recovery task snapshot, exact guest identity entry, inventory,
trace and guarded cleanup ledger. All worker instances are terminated; the
cleanup ledger records removal and absence checks for the private function
versions, role, parameter, log group and zero counters.
