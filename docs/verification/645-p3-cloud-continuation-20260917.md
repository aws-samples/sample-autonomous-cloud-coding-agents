# P3 cloud continuation acceptance — September 17, 2026

The final private MicroVM matrix passes approval, denial, cancellation and explicit
expiry after planned worker retirement, plus approval and denial on the original
sleeping worker. These checks exercise the real guest, model, SDK, lifecycle hooks,
AWS storage, Durable coordinator and API decision handlers.

This record covers the isolated acceptance deployment. Normal nested migration,
activation and the signed-in CLI path have their own completion gates.

## Exact build and fixture boundaries

- Account/Region: `<account-id>` / `us-west-2`.
- Stack: `backgroundagent-dev-p3-recovery-20260917`.
- Image: `abca-645-p3-recovery-20260917`, version `3.0`, 8,192 MiB.
- Guest ZIP SHA-256:
  `a4ab66250ab20aceeefab05d5d13eea8387f7fa4d6a91376bc9265a06cb68013`.
- The ZIP contains 116 files and is 518,981 bytes.
- Coordinator version `4` ran the retirement matrix and wake-deny; version `5`
  refined the private command-specific gate for wake-approve. Both use the same
  image and production lifecycle implementation.

The private wrapper selects dedicated tables/buckets and a repository-free
workflow. It sets the real AWS worker lifetime to 600 seconds so production
retirement is reached in approximately five minutes. It does not mock the clock,
AWS responses, lifecycle transitions, checkpoint transfers or model responses.
The configured sleep delay is 30 seconds; production's default remains 600.

The wrapper invokes the production scheduled manager every 20 seconds to keep the
test short. Production schedules it every five minutes. Approval and denial call
the production handlers with the fixture owner's identity; authenticated HTTP/CLI
acceptance is a separate normal-deployment check.

## Passing cases

| Case | Task ID | Verified outcome |
|---|---|---|
| Approve after retirement | `01M2RHVXTC3VZT63008V2D2BVX` | One replacement; the approved command reads the original marker and its exact SHA-256 from restored disk |
| Deny after retirement | `01M2RHVXTGPRGR01ATR0CEGE0N` | One replacement; the denied command does not execute and the agent acknowledges the saved denial |
| Cancel while parked | `01M2RHVXTGPSSCBRM42GD46ANG` | Request/task cancelled; no replacement or terminal delivery |
| Explicit expiry while parked | `01M2RHVXTGB9H7DFHATTF2VEVJ` | The 480-second deadline closes the request; one replacement acknowledges the timeout without executing the command |
| Approve on the original worker | `01M2RN4WWRK0BHJ0VCWDAAT125` | Same worker wakes, reads the saved marker/checksum and finishes |
| Deny on the original worker | `01M2RH8HN8GPGYW08R4HBXWCB6` | Same worker wakes, respects denial and finishes |

For every retirement case the original worker was observed `SUSPENDED`, then
`TERMINATED` with `stateReason: "Success."`. The coordinator fenced the old worker,
parked the task and released its capacity reservation before the human decision.
An unanswered request had no DynamoDB TTL.

The harness verifies each immutable manifest's object version, byte count and
SHA-256, saved workspace location and positive accumulated model cost. Replacement
tasks keep their original image version and final costs include both worker runs.
Successful cases finish with released reservations, zero user capacity and no
outstanding continuation launch. Duplicate decision submissions return 404.

The agent's normal reasoning decides whether the saved action is still relevant.
The platform checks exact task/request ownership and approved tool inputs; this
does not add an action-relevance rechecking system.

## Findings corrected during integration

The real retirement tests found a workflow boundary missing from the earlier
process-level tests: hydration overwrote the prepared continuation prompt with
the original task prompt. The resumed model therefore never received the saved
human decision. `workflow/runner.py` now fills the user prompt only when it is
empty, matching the existing treatment of a prepared system prompt. Five tests
exercise the real hydration and agent-run handlers; four failed before the fix.

The approved continuation instructions also explicitly preserve every saved tool
input field, including descriptions. The exact-input permission check remains
unchanged. Restored denial feedback reports its original timestamp instead of
incorrectly describing a decision many minutes old as a recent 60-second denial.

Earlier integration corrected retained-request hook checkpoint validation and
AWS's 64-character Durable execution-name limit. Dispatch errors now include the
operation, coordinator version, name length and bounded validation detail.

One first wake-approve fixture paused at an incidental `ls` command before the
intended marker command. That run was cancelled and excluded from marker
acceptance. The reproducible fixture now gates only the exact intended command,
validates the approval's input before answering, and correlates tool results with
their trace/turn. It fails if parallel calls make that correlation ambiguous.

## Cleanup and reproducibility

All 15 task records from final and diagnostic attempts were terminal, all 15
worker leases were closed, reservations were released and continuation launch
records were absent before deletion. The stack and its 40 tracked resources were
removed. Cleanup also removed automatically created Lambda log groups and checked
absence of the exact owned functions, buckets, images and network connectors.

Private scripts and raw evidence are outside the Git worktree:

```text
/Users/sphias/.local/share/abca-verification/645-p3-integration/
```

The final matrix is in `cloud-replacement/results/`; `cleanup.json`,
`cleanup-resources.json` and `terminal-task-and-lease-audit.json` preserve cleanup
proof. Failed and invalidated earlier cases remain archived separately.

`run.py` provides local, SDK, real S3, DynamoDB and coordinator checks; `cloud.py`
creates a fresh isolated stack and image for the real worker matrix. It uses the
selected worktree's production implementations and records the artifact digest.
The scripts deliberately do not belong in the PR.

Full agent verification after these corrections passes **2,159 tests**, with
13 explicitly opt-in cases skipped and **86.34%** coverage. The real SDK suite was
run separately. The full infrastructure suite passed 5,223 tests before the
managed runtime-pin addition; 245 focused infrastructure tests and compilation/
lint subsequently passed for that addition and dispatch diagnostics.

## Corrected-image follow-up — September 18

The later normal-workflow progress/capture race is documented in the
[dedicated record](./645-p3-progress-race-20260918.md). After its correction, a
fresh portable cloud run built image `abca-645-p3-it-09180207b210de:1.0` from
artifact `924a1b51fe6b9aa62f61191a6bde9b10df01d65873181a9385489191492cadbe`.
It passed both same-worker wake/approval and approval after confirmed retirement
and replacement, with real marker/checksum assertions.

- approve: `01M2S4A6MB2CZJQRP0ZYMT7EYZ`.
- wake-approve: `01M2S4A6MB7WH4A781WFFMQCPK`.

The owned stack and all 40 tracked resources were removed; cleanup finished at
`2026-09-18T02:30:30.707Z` with no leaked resources. Source hashes,
image receipt, full timelines and cleanup checks are in the private harness
`runs/20260918-progress-race-cloud`. The full agent suite with this fix passes
2,162 tests, with 13 opt-in skips and 86.37% coverage.
