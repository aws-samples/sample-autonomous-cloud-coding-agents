# ADR-021 P3: diagnostics rollout and connection comparison

Updated 2026-09-16 UTC. The normal development stack now runs the
[lifecycle diagnostics and wake feedback](./645-p3-lifecycle-diagnostics.md).
Automatic suspension remains disabled. The four earlier
[wake refusals](./645-p3-resume-refusal-investigation.md) remain open.

## Normal deployment

| Item | Verified value |
|---|---|
| Account / region | `<account-id>` / `us-west-2` |
| Stack | `backgroundagent-dev`, `UPDATE_COMPLETE` |
| Source | `dff860c63a7e8c211d493d3630c38907497c157a` |
| Coordinator `live` version | `6`; version `5` remains available |
| Coordinator code SHA-256 | `4EJoQ2SGpuPv/vlT7Za3peYIrL3DBKznzK6IyA+9EiU=` |
| Managed worker image | `backgroundagent-dev-abca-agent:5.0`, `SUCCESSFUL` / `ACTIVE` |
| Worker artifact SHA-256 | `9b3150e9e5991cc9fcc8a4adbb2cfbd8f97399f0c16baa9c2b5fe5b101e7b035` |
| Bootstrap / guardrail version | `1.8.0` / `3` |
| Root resources | 475 |
| Static suspension setting / live SSM switch | Both `false` |

The deployment was verified at **14:54:31 UTC**. Coordinator versions 5 and 6
have identical environments. An older durable execution can continue to use its
original retained coordinator version.

The new worker artifact has 111 files and is 486,428 bytes. Relative to image
4.0, it adds `microvm_diagnostics.py` and changes only the three lifecycle
modules. The Dockerfile, startup command, dependencies and hook settings are
unchanged.

The reviewed CloudFormation change set had 34 changes:

- 29 Lambda code updates for consumers of the shared diagnostics/classifier.
- The image artifact URI and its build role's exact artifact permission.
- A new coordinator version, alias update and retained previous version.

No existing resource required replacement. Function environments, database,
network, guardrail and suspension settings were unchanged. Each of the 29
deployed functions was `Active` / `Successful`, and its `CodeSha256` matched
the reviewed S3 ZIP bytes.

The assembly preserves the exact previous S3 deployment template and substitutes
the reviewed code/image changes. This avoids the previously recorded unrelated
asset and guardrail-version churn during full synthesis. The full synthesis,
restricted assembly, AWS change set and per-function hash audit are retained in
private evidence.

## Controlled connection comparison

An HTTP connection is a communication line. Uvicorn normally keeps that line
open briefly so the next request can reuse it. The private comparison image adds
`--timeout-keep-alive 0`, which closes it after the response. This tests one
possible explanation for the earlier failures; it is not a production fix.

The private image is `backgroundagent-dev-p3-no-keepalive-20260916:1.0`.
Its artifact SHA-256 is
`0fb02e8cf6935d62abd4622b22791a0213fbf1cb24c31f209fcef67dffd98922`.
All 111 filenames and every file except that one Dockerfile command match the
normal image artifact. The original server command remains PID 1 in both.

Six fixed, owned tasks compare an immediate wake, a wake after at least eight
seconds observed suspended, and a missing-approval rejection on each image.
Each task requests one read of `/etc/os-release`, with a $1 / six-turn limit,
600-second original approval window and 1,800-second worker ceiling.
Two fresh replacement tasks were needed after the watcher failed to apply the
longer hold to the original pair; eight workers actually ran. The original
mistitled results and watcher are retained.

The private durable coordinator uses the compiled production implementation.
Version 1 pins normal image 5.0; version 2 changes only its image identifier and
version to the comparison image. Both have code SHA-256
`v3IUVmZa7U1gAj4l8ytBhfJlL19hbimNOYisgh7rB/Q=`.
Versions 3 and 4 expand the fixed task whitelist for the two replacements,
with code SHA-256 `E+I/xFbrwlnu1U7tOkfyK0spJRW7WtMl4SjrDhkgg+I=`;
they pin the comparison and normal images respectively. The production
supervisor implementation is identical between these private versions.
One-second verification polling and fixed task/configuration wrappers are
explicit test differences from normal task routing.

The private approval handler commits the real production decision but omits its
immediate wake call identically for both images. The coordinator therefore issues
the sole Resume. Its role is restricted to the eight task/rate keys and its own
logs; it has no MicroVM API permission. Missing-approval cases conditionally
delete only their own still-pending approval after checking task ownership and
the original gate. They do not call the approval API.

## Results and limits

The strict lifecycle audit passed at **15:12:51 UTC**. The independent tool and
deployed API feedback audit also passed.

| Required case | Measured hold after observing suspended | Suspend / resume client ports | Resume HTTP | AWS Resume request ID |
|---|---:|---|---|---|
| Normal, quick | 1.527 s | 54904 / 54904 | 200 | `0dfd1993-5fba-4758-8d58-16ee6aa52e20` |
| Close connections, quick | 0.554 s | 60656 / 60664 | 200 | `b3581707-7432-46af-80d5-8c1f3597d2b0` |
| Normal, longer pause | 10.205 s | 58984 / 56118 | 200 | `c7e545d9-0342-4805-97e1-3c7eb4c4475f` |
| Close connections, longer pause | 8.697 s | 58984 / 56118 | 200 | `32df71a5-f150-40e0-81a6-69c1466f8a54` |
| Normal, missing approval | 0.236 s | 37364 / 37364 | 409 | `d102840b-2d38-49a7-a448-01d1808dc505` |
| Close connections, missing approval | 0.227 s | 58984 / 56118 | 409 | `424ce2c0-0dbb-4a4b-b5ec-f7948041a75c` |

These holds measure from the watcher's first suspended observation to the
decision/deletion receipt. They are not exact service freeze durations.
Canonical lifecycle access logs supplied the client ports. The normal quick
cases reused the same port; the longer normal case and all close-connection
cases used different ports.

Every worker retained server PID 1 and had exactly one coordinator-issued
Suspend and Resume acknowledgment with an AWS request ID. Successful workflows
produced 32 guest diagnostic records. Each missing-approval case produced 30:
credential refresh succeeded, `resume-identity-read` failed with
`LifecycleUnavailable`, and the hook returned HTTP 409 with
`MICROVM_LIFECYCLE_UNAVAILABLE`. AWS independently reported the HTTP 409;
neither rejection was a connection refusal.

Both failed tasks returned `MICROVM_RESUME_HOOK_FAILED` through the normal
deployed GetTask handler, with the specific wake-failure title, diagnostic steps
and `retryable: false`. This used direct Lambda invocation with the fixture's
identity, not API Gateway authentication.

All eight tasks released their capacity reservation, returned their counter to
zero, terminated their worker and emptied their launch prefix before independent
cleanup. Six tasks completed, each with exactly one successful Read result in
task events and one Read call in a complete retained trace with zero dropped
records. The two rejected tasks have one gated attempt and no tool-result event.
They did not publish a final trajectory before service termination; their event
records and failed guest barrier are the available evidence.

The original `default-long` and `closed-long` attempts actually waited only
0.361 and 0.474 seconds. The audit rejected their intended hold requirement.
The watcher was corrected before the missing-approval tests and two fresh
long-pause tasks were run. Both original attempts remain documented successful
quick wakes and **do not count as long-pause acceptance**.

No unexpected connection refusal or reset was reproduced. These controls show
that both connection settings can work; they do not establish a failure rate,
identify the cause of the four original failures, or justify changing production
connection handling. Service-side restore/transport evidence or a fresh failure
with independent process/listener evidence remains necessary.

## Cleanup and retained evidence

Cleanup completed at **15:15:37 UTC** after confirming all eight owned workers
were terminated, reservations released, counters zero, payload prefixes empty
and private durable executions finished. It archived all three private log
groups before removing both private functions and every version, the comparison
image, three roles, private SSM switch, artifact and log groups. The eight
synthetic counters were removed only while their count and reservation version
still matched. Explicit absence checks passed.

Task/approval history, task events and trace objects retain their normal
retention. Private evidence also contains the exact source/artifacts, original
failed audit, corrected watcher, all task histories, six complete traces, guest
logs, service receipts and cleanup proof.

The normal image, artifact and log group were excluded from cleanup. A final
read confirmed `UPDATE_COMPLETE`, coordinator `live:6`, image `5.0` active and
the suspension switch still false. These results complete the diagnostic
rollout and bounded comparison, not the remaining P3 acceptance matrix.
