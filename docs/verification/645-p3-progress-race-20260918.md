# P3 progress during checkpoint capture — September 18, 2026

The normal repository workflow exposed a progress-write race while saving a
continuation. This is separate from the earlier pooled HTTP connection problem.

Task `01M2S3QH4RA02SMV7GKP0PSKR1` captured its conversation and workspace on
`backgroundagent-dev-p3-abca-agent:1.0`. An SDK progress event arrived during
the upload, while the lifecycle phase was `checkpointing`. The progress writer
treated the closed activity barrier as a lost write and permanently set
`progress_failed`. Capture nevertheless completed. Thirty seconds after the
approval request, the suspend hook correctly rejected this unsafe state with
HTTP 409; AWS terminated worker
`microvm-bfb43f74-bc32-37e5-860f-c0359bb6d94d`.

The saved request and checkpoint survived. The coordinator confirmed termination,
parked the task and released capacity. A subsequent signed-in CLI approval
launched a replacement, which read the intended README and reached `COMPLETED`.
That recovery does not make the rejected suspend acceptable: the race is fixed
before final activation.

## Correction and regression

Progress events can write during continuation upload because these writes do not
modify the saved workspace. This exception applies only to the progress writer;
general activity and new tools remain paused. Capture drains progress a second
time after upload and refuses publication if a write failed or remains uncertain.
Actual suspension and credential renewal still close the activity barrier.

The progress rejection log now includes task ID, event type and lifecycle phase.
It omits message contents and tool arguments.

Two new regression tests failed before the correction. The corrected focused
suite passes 150 tests, including:

- A progress event arriving during capture is acknowledged and permits suspend.
- A write started during upload must finish before capture is published.
- A real failed write prevents checkpoint publication and suspension.
- General activity remains blocked during upload; progress remains blocked during
  actual suspension.

The corrected guest artifact is 519,287 bytes with 116 files:

`924a1b51fe6b9aa62f61191a6bde9b10df01d65873181a9385489191492cadbe`

The normal deployment was returned to compatible coordinator 11 and the disabled
live sleep switch while rebuilding. Corrected image 2.0 is now active with
coordinator 14. Normal ten-minute sleep, explicit expiry, new and existing
sleep-off tasks, and compatible coordinator-13 rollback/restore all passed.
The [normal acceptance record](./645-p3-normal-closure-20260918.md) contains that
deployment evidence separately from the local regression results.

## Independent evidence recovered after a watcher interruption

The local watcher disconnected and later exceeded its deadline. The cloud task
continued without it. Full guest logs for retained request
`01M2RX085T9T5865XX1TBEVTYE` record a successful suspend acknowledgment
**601.45 seconds** after its creation. Its worker retired successfully after
about an hour, leaving the request pending without a TTL.

The real CLI recorded approval at `2026-09-18T02:02:07.439Z`, more than two hours
after the request. A replacement worker consumed that decision and completed
the README task. This is cloud evidence recovered after the interruption, not
a passing result from the original local watcher.

Private logs, task snapshots, exact approval receipts and regression results are
under `~/.local/share/abca-verification/645-p3-integration/normal-acceptance`.
