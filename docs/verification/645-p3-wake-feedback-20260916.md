# Generic wake-failure feedback deployment — 2026-09-16

The [independent PID 1 diagnostic](./645-p3-pid1-observer-20260916.md) captured
AWS's generic `Resume lifecycle hook failed.` message. The previous classifier
did not recognize that wording and suggested retrying a generic compute failure.
Source commit `35d5515b` now classifies it as `MICROVM_RESUME_HOOK_FAILED`, with
service/admin guidance, the relevant log and request-ID locations, and
`retryable: false`. This fixes the explanation; it does not fix the failed wake.

## Reviewed deployment

The `backgroundagent-dev` stack in account `<account-id>`, `us-west-2`, reached
`UPDATE_COMPLETE`. Change set `p3-wake-feedback-20260916` contained exactly 14
resource changes: 11 Lambda code-object updates, a new coordinator version,
retention of the previous version, and the live alias update. No continuing
resource was replaced; all 475 continuing/new resource entries were accounted
for. No worker image, environment, policy or AgentCore container property changed.
Execution request ID: `170357ab-2b5c-48b0-9a5a-adecd8a15d11`.

The live coordinator is version **9**, with code SHA-256
`zoYSUwO5qeLX0pR78DU8OKmFu6qeU9kes31YRj5up4o=`.
Version **8** remains readable with its original code hash. All 11 deployed ZIPs
were downloaded and their hashes matched Lambda's `CodeSha256`.

Normal MicroVM image **5.0** remains `ACTIVE`/`SUCCESSFUL`, with **8192 MiB** and
the original server process/connection settings. AgentCore remains version
**5**, `READY`. Both automatic-suspension switches remain **false**.

The deployment used the exact prior S3 template bytes, SHA-256
`9741f2d4ea6f43e8dde6deff0cb791780a54efdb933e7046c9851b9e6a2e3f9d`.
The reviewed compact target was 706,153 bytes, SHA-256
`50331a6fe3bcbe5218bfde4cd7c0185f40987c7bc0f3dd95de24de22ffb82d15`.
An explicit `us-west-2` synthesis supplied the new code assets. The default
build's separately generated `us-east-1` assembly was not deployed.

## Validation and limits

The full CDK build passed compilation, lint, synthesis and **5,052 tests in 229
suites**, plus one snapshot. The 56 optional DynamoDB Local tests were skipped
in this build; the previous real-database run passed and this change does not
alter that protocol. The focused classifier/orchestrator run passed 156 tests.

Four owned synthetic terminal records verified the normal deployed GetTask
handler:

| Stored error | Observed response |
|---|---|
| Actual generic AWS wake-failure wording | Service error, specific wake explanation, not retryable |
| Legacy reconciliation message without a stable code | Same specific wake guidance |
| New `MICROVM_RESUME_HOOK_FAILED` code | Same specific wake guidance |
| Previously persisted `MICROVM_SUBSTRATE_TERMINATED` code | Existing generic classification preserved |

Each temporary row was conditionally deleted and its absence verified. No
worker or durable execution was started. Direct handler invocation supplied a
trusted test identity; it does not test API Gateway authentication. Local
orchestrator regression tests cover the newly persisted failure code; these
four live reads do not constitute another end-to-end wake/finalization run.

The actual F08 task's historical error is unchanged. Its already-persisted
generic code continues to take precedence over diagnostic wording. The five
connection-refusal failures and the distinct F08 generic failure remain open
in the [service feedback tracker](./645-lambda-microvm-service-feedback.md).
Neither retained versions nor this code-only deployment constitute a completed
capacity-protocol rollback exercise.

Raw deployment, package and API evidence:
`/tmp/abca-645-p2-clean-20260913/p3-wake-feedback-20260916`.

The permanent private archive is
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/generic-wake-feedback-evidence.tar.gz`
(60 files, 820,897,318 bytes, mode `0600`, SHA-256
`ab24324c8b6b12c3fb8efce4fd6f75a9d6f0ecbd1dae25d4fbfbe260939e79e9`).
All file hashes were verified against its manifest. It retains the exact 11
deployed Lambda ZIPs and source/docs commit `0090a713`.
