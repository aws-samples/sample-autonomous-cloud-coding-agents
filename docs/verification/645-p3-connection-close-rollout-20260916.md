# ADR-021 P3: connection-close rollout and normal-image acceptance

Verified September 16, 2026, in `us-west-2`, account `<account-id>`.
The normal `backgroundagent-dev` stack now runs MicroVM image **6.0** and
coordinator **10**. Approval, denial, timeout and cancellation while asleep
passed on that image using a private AWS Durable coordinator and normal decision
handlers. Both normal automatic-suspension switches remain **off**.

## What changed and why

An HTTP connection is the channel AWS uses to deliver a lifecycle message.
Keeping it open normally saves the work of opening another one. A frozen worker,
however, can wake with both an old connection and an expired timer that wants
to close it.

The [instrumented investigation](./645-p3-wake-transport-20260916.md) reproduced
the exact refusal while the original server still owned its listening socket.
Its restored event loop closed the old suspend connection; no fresh connection
or resume request appeared. Two unchanged cases sleeping longer than 90 seconds
passed. Three candidate cases directly verified that an explicit
`Connection: close` response closed the suspend connection before freezing and
that resume arrived on a new connection.

Source `ccab2eecbf8aa28d4b9782e003f790f14078c7a5` adds that header to both
suspend and resume JSON responses, including errors. It leaves the original
server command, five-second idle timeout, checkpointing and approval barriers
intact. It also recognizes `Resume lifecycle hook timed out` as
`MICROVM_RESUME_HOOK_FAILED`, with service/admin guidance rather than automatic
retry advice.

These guest observations support a specific connection-lifetime correction.
They do not reveal the service client's failed dispatch, establish a failure
rate, or prove that every historical wake failure had the same cause. The
service-side questions remain in [F01, F03, F05 and F08](./645-lambda-microvm-service-feedback.md).
No report was sent to the service team.

## Reviewed normal deployment

CloudFormation reached `UPDATE_COMPLETE` at **22:22:56.959 UTC**.

| Item | Verified result |
|---|---|
| Source | `ccab2eecbf8aa28d4b9782e003f790f14078c7a5` |
| Root resource count | 475 |
| Coordinator live alias | Version 10; previous version 9 retained |
| Coordinator code SHA-256, base64 | `hrLwpI9HJ15OctduM1tv4VelPBXIRQ2qeGOqdq+zdqw=` |
| Normal image | `backgroundagent-dev-abca-agent:6.0`, `ACTIVE` / `SUCCESSFUL` |
| Previous image | Version 5.0 retained |
| Worker memory | 8,192 MiB |
| AgentCore | Version 5 retained; this rollout did not change its container |
| Bootstrap | 1.8.0 |
| Normal sleep gates | Environment `false`; SSM `false`, parameter version 1 |

The normal image artifact is 486,771 bytes, SHA-256
`191ae368a2a4d28bb8910caabef6a2b99b5521a474cff60ef6542456fb679490`.
Compared with the exact image 5.0 ZIP, 107 entries are identical and four differ:
the lifecycle HTTP module, a runner docstring with an unchanged executable
syntax tree, and the JSON/Markdown copies of the already-established adjustable
sleep contract. The Dockerfile is identical and the image contains no transport
probes. All image properties other than the source artifact match version 5.0.

The reviewed change set, `p3-connection-close-20260916`, contained 16 resource
changes: 11 classifier-consumer function code updates, the coordinator version
and alias transition with retention of the old version, the image artifact, and
the build role's exact artifact digest. No modified resource required
replacement. The executed template is 706,153 bytes, SHA-256
`856bb6aaba07bf2eb1c8d5c0ad874217c6fa7c1f19b84a03b92b0dec14624f51`.
It was prepared from the exact previous S3 template bytes, avoiding the lossy
`GetTemplate` baseline discovered in an earlier rollout.

After deployment, all 11 function code hashes matched the actual reviewed ZIPs
downloaded from S3. The image version, unchanged image configuration, retained
coordinator version and disabled sleep settings were checked separately.

## Four real Durable workflows

The temporary function `backgroundagent-dev-p3-close-acceptance-20260916:1`
ran the production Durable handler with five-second polling. Its wrapper bound
launches and permissions to four fresh fixture identities, the normal image
6.0, and a 1,800-second maximum worker lifetime. Only its private sleep switch
was enabled. Each case had a six-minute watcher, a $1 task budget and a six-turn
limit. No transport failure was injected.

The normal approval, denial, cancellation and read handlers were invoked through
Lambda with the fixture identities. This tests the deployed handlers, not an
additional API Gateway authentication/ingress path. These were repository-free
tasks requesting one guarded Read of `/etc/os-release`; no notifications or
repository publication were requested.

| Case | Task | Worker | Result |
|---|---|---|---|
| Approve after sleep | `01M2P4WX07MY6AP3VAJ1X5BQXX` | `microvm-2e038148-adce-37eb-8e83-629ef9c16eda` | Approved; exactly one successful Read; task `COMPLETED` |
| Deny after sleep | `01M2P4WX086HH030697Z4XK8W8` | `microvm-4149fb1d-42ba-3fdc-b509-a548bba70627` | Denied; Read blocked; task `COMPLETED` |
| Timeout wins | `01M2P4WX08SKVPCA55E4AX0W7T` | `microvm-92ff298a-dc28-3e59-9994-1375f79a43a7` | Original approval `TIMED_OUT`; late approve returned HTTP 404; Read blocked |
| Cancel while asleep | `01M2P4WX08WQZH86E72YQGSDNA` | `microvm-b8414dd8-6e85-35c1-b32c-a496a4c553c2` | Task `CANCELLED`; worker terminated without a Resume request |

All four AWS Durable executions ended `SUCCEEDED`. Each worker terminated,
each reservation was released, each counter reached zero, and each launch
payload prefix was empty before fixture cleanup. No watcher repair was needed.
The three non-cancelled tasks retained complete traces with one Read intent
each and zero dropped records. The denied Read returned `AUTHORITATIVE DENY`;
it did not execute. The cancelled task was not required to produce a completed
agent trace after termination.

### Actual wake delivery

The normal sleep switch prevents new automatic suspension. It intentionally
does not prevent a decision handler from waking an already-suspended worker.
Approve and deny therefore used the normal API's immediate wake path; timeout
used the private coordinator's production supervisor.

| Case | Resume accepted, UTC | AWS Resume request ID | Original PID 1 resume hook |
|---|---|---|---|
| Approve | 22:35:14.410 | `04923c77-f85c-4274-85ee-ebbdc92b2935` | HTTP 200 at 22:35:14.832 |
| Deny | 22:37:32.764 | `5110864c-a2b1-4141-99ef-5d1d7e374e14` | HTTP 200 at 22:37:33.259 |
| Timeout | 22:40:07.397 | `154a247f-2c0e-4e0a-9221-31f8da62c76e` | HTTP 200 at 22:40:07.760 |

Approve was delivered after more than 60 seconds of observed suspension. The
timeout case woke before its original 150-second approval deadline, then let
that deadline expire; wake did not grant a new window. Its later approval
received HTTP 404 `REQUEST_NOT_FOUND`.

The cancel case was observed `SUSPENDED` at 22:42:45.314. The normal cancellation
handler returned HTTP 200 at 22:42:56.987, Lambda invocation receipt
`34e57a5e-eba9-459f-aee5-cb7a0c5d7503`. The worker terminated, the approval
remained pending, and no Resume command or successful Read appeared.

An accepted API call alone was never the pass condition. The audit required
the guest's hook results where applicable, original decision/deadline outcomes,
tool evidence, final Durable/task state and resource cleanup.

## Error feedback and local checks

Six synthetic terminal records exercised the normal deployed GetTask handler:
raw, legacy and stable-code timeout forms; raw refusal; raw generic wake
failure; and preservation of an older stable classification code. All passed,
and all six synthetic rows were deleted. Recognized new wake failures receive
nonretryable service/admin guidance explaining that a refused-connection message
alone does not establish a closed listener. Existing stable classifications
keep their precedence.

The source passed agent lint, formatting and type checks, **1,955 agent tests**,
TypeScript compilation, ESLint, and **5,053 CDK tests** across 229 suites.
The 11 agent and 56 CDK opt-in DynamoDB Local cases were skipped in these runs;
this change did not alter their transaction conditions. Eight new route cases
cover both lifecycle endpoints with HTTP 200/400/409/503 despite an incoming
keep-alive request. The classifier suite covers timeout classification and
resulting retry guidance.

These four acceptance executions used real AWS Durable execution. Earlier
transport comparisons used a local step adapter after two separate AWS
`Stopped.ByService` errors during startup. Passing this round does not identify
the cause of those earlier service stops.

## Cleanup and evidence

The four-case audit passed with zero errors. Scoped cleanup completed at
**22:49:26.544 UTC**. It removed the private coordinator and versions, its role,
private SSM parameter, private function log group and four zero-valued fixture
counters. Ownership tags, terminal executions and task/counter versions were
checked before deletion; absence was verified afterward. All 331 private
function log events were archived. Normal image versions, shared logs and
ordinary task records retain their existing retention policy.

A fresh normal-state check at **22:49:27.184 UTC** confirmed coordinator 10,
image 6.0 `ACTIVE` / `SUCCESSFUL`, 8,192 MiB, stack `UPDATE_COMPLETE`, and the
normal SSM switch still `false` at version 1.

Private working evidence is under:

- `/tmp/abca-645-p2-clean-20260913/p3-connection-close-rollout-20260916`
- `/tmp/abca-645-p2-clean-20260913/p3-close-acceptance-20260916`

The permanent archive is
`~/.local/share/abca-verification/645-p3-20260916/connection-close-rollout-evidence.tar.gz`.
It contains 122 files, occupies 827,593,551 bytes, and has SHA-256
`92aaa3c29a6ff5dbc1cf7acf81d7fe354b7aed4fdbcf774359e793ad466ce237`.
Every member's size and hash were verified against the manifest; permissions
are `0600`. It includes the exact rollout templates/artifacts, deployed function
ZIPs, source comparison, fixture code, API receipts, guest logs, Durable history,
task/tool evidence and cleanup proofs. The decisive earlier refusal and
instrumented comparison have their separate archive in the transport report.

## Remaining completion gates

The application correction and these four normal-image workflows are complete.
The broader [P3 plan](./645-p3-implementation-plan.md#remaining-work-in-execution-order)
still requires the wider final-image workspace/credential/decision matrix,
other-backend permission and network checks, and the normal deployment's
coordinated capacity upgrade/drain and rollback validation. Service token
retention and recovery without guest identity logs also remain open.

Automatic suspension stays disabled while those gates are open. The user sleep
setting retains its 600-second default and zero-to-stay-awake option. Service
trace requests remain separate from the verified application change; finite
passing runs cannot certify every future wake.
