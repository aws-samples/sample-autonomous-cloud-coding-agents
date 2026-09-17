# ADR-021 P3: final-image persistence, credential expiry and ECS compatibility

Verification ran September 16–17, 2026, in `us-west-2`, account
`<account-id>`. The normal deployment remains MicroVM image **6.0**,
coordinator **10**, 8,192 MiB, with both automatic-suspension gates **off**.
The [connection-close rollout](./645-p3-connection-close-rollout-20260916.md)
records the preceding four core lifecycle cases.

## Repository state across two sleeps

Task `01M2P84R90WESJH1GPTYKZ20PM` used normal image 6.0, its original server as
PID 1, and the production Durable handler in a private coordinator. It cloned
public repository `isadeks/vercel-abca-linear`, main commit
`f5be1e23a964b661f1bf3d98ead55679d65978c4`, into a temporary directory.

The actual tool sequence was:

1. Clone, verify the commit, run `npm ci`, lint and tests, then write a marker.
2. Request approval to read the marker, sleep, approve through the normal API,
   and read it after waking.
3. Verify the first marker's hash and write a second marker.
4. Request another approval, sleep again, approve and read the second marker.
5. Verify both hashes and the unchanged repository commit, check the tracked
   files are unchanged, and run lint and tests again.

Both lint runs and both Vitest runs passed; the repository has one test.
The marker hashes were:

| Marker | SHA-256 |
|---|---|
| First | `8437311a6e403b723febea0fbae6509e03b48c198b597aab9f04cd2cf7e30d5e` |
| Second | `cb1e409f22270af5 (SHA-256 prefix)` |

Worker `microvm-3a114559-4c86-34a0-af36-0a04e6232a5f` recorded two suspend and
two resume HTTP 200 results from PID 1. Independent normal approval-handler
logs supplied both actual `ResumeMicrovm` request IDs. Each gate kept its
original creation time and 600-second timeout. Finalization passed at
**23:25:41.137 UTC**: task `COMPLETED`, Durable execution `SUCCEEDED`, worker
`TERMINATED`, reservation released, counter zero and payload absent.
The watcher performed no repair.

This verifies repository files and running application state across multiple
sleeps. The task used artifact delivery and explicitly cloned into a temporary
directory. It does **not** exercise the platform's normal repository-bound
clone/PR-delivery workflow. No commit, push, PR or external comment was created.

## Late approval wins its decision race

Task `01M2P84R94PY36ZV5D43RVN7MT`, worker
`microvm-f191abfa-de75-3a89-bb5f-d1b4b9865ce1`, used image 6.0 and a 150-second
approval window. The original deadline was **23:28:44 UTC**.

The private coordinator deliberately withheld its scheduled resume until five
seconds after that deadline. Those omissions were recorded as injected missing
commands, never as successful AWS requests. The normal approval request began
at **23:28:46.349** and returned HTTP 202 at **23:28:47.593**. Its actual resume
request ID was `c3eed6c5-5029-494a-a45b-162de6dfce63`.

The original PID 1 finished the resume hook with HTTP 200, and the permitted
Read completed. The approval remained `APPROVED` with its original clock.
Task completion, successful Durable execution, worker termination, reservation
release and payload cleanup passed at **23:29:01.093**, without watcher repair.

This is the existing decision contract: the first committed decision wins.
The agent writes `TIMED_OUT`; the approval API does not independently reject a
request solely because the clock deadline passed. The preceding image 6.0
acceptance separately verified timeout winning and a later approval returning
HTTP 404.

The independent two-case audit passed at **23:29:55.019**. Its private
coordinator, role, switch, log group and two zero counters were removed, with
absence verified at **23:31:04.765**. All 237 function log events were retained.

## Real credential expiry

The separate task `01M2P7E6SF68775QCBYXS1Z0YP` uses normal image 6.0 and worker
`microvm-ddc38544-f478-3578-a78d-79e1ac7a32fa`. Its initial credentials expire at
**00:07:25 UTC on September 17**, according to the actual STS issuance recorded
in CloudTrail. Its original approval deadline is **00:11:10**.

An independent `GetMicrovm` observed the worker still `SUSPENDED` at
**00:07:40.565**, after that actual expiry. Request ID:
`1761febc-81d7-43d5-97b2-841c8f553f94`.

Both the lifecycle audit and the independent credential audit passed.

| Event | UTC time |
|---|---|
| Initial STS session issued | September 16, 23:07:25 |
| Worker observed suspended | September 16, 23:11:41.565 |
| Initial credentials expired | September 17, 00:07:25 |
| Independent observation still `SUSPENDED` | 00:07:40.565 |
| Actual Resume accepted | 00:10:11.100 |
| New STS session issued | 00:10:12 |
| Original PID 1 finished resume with HTTP 200 | 00:10:12.242 |
| Original approval deadline reached | 00:11:10 |
| Late approval returned HTTP 404 | 00:11:12.097 |
| Finalization verified without watcher repair | 00:11:22.157 |

The new STS session expires at **01:10:12**. CloudTrail request
`e1320fee-c291-44da-8f32-dff210efcd38` records the same session role, session name,
task tag and user tag as the initial request
`85c3d6af-9bf7-4bfc-8555-ab523f28eb64`. CloudTrail timestamps have second
precision. The original PID 1 completed its refresh/reconciliation hook in
132 ms; the actual Resume request ID was
`1a817784-6702-43ed-828e-532a18ec06c4`.

The gate became `TIMED_OUT`, and the unapproved Read did not succeed. The task
then completed its refusal response, the Durable execution succeeded, and the
worker terminated. Its reservation was released, counter was zero and payload
was absent. The retained trace had no dropped events. This distinguishes
completing the task's refusal response from permitting the timed-out tool.

The renewal record became visible in CloudTrail about three minutes after
issuance. The independent audit required every pre-observation session to
have expired, a successful subsequent issuance with unchanged identity tags,
and the successful resume/lifecycle evidence. No credential values were saved.

## ECS approval configuration fix

ECS runs the same agent in a container. Its task definition is the recipe that
tells the container its image, memory, permissions and configuration.

The production ECS recipe omitted `TASK_APPROVALS_TABLE_NAME`. The agent's
approval code therefore raised `ApprovalTablesUnavailable`, even though the
shared session role already had approval-table permissions.

Local commit `c14d2ba0` fixes this in the source:

- Pass the real approval table from `AgentStack` into `EcsAgentCluster`.
- Give both build and planning containers the same approval-table name.
- Prevent deployment-time build settings from erasing that name.
- Preserve session-role ownership of production data permissions. The
  optional path without a session role gets only approval Get/Put/Update.
- Correct nearby comments about task sizing, shared environment and signed
  payload delivery.

Compilation, ESLint and 186 targeted construct/stack tests passed. The full
CDK suite passed **5,057 tests in 229 suites**, with one snapshot; the existing
56 optional DynamoDB tests were skipped. No Python runtime change was needed.

## ECS live approval and cancellation

A separate 23-resource stack used the production `EcsAgentCluster`,
`AgentSessionRole` and `EcsPayloadBucket` constructs in the existing private
subnets. It created its own roles, buckets, cluster, security group, task
definitions, switch and logs. The normal deployment and its roles were not
modified.

The unchanged Dockerfile image was built for ARM64 and published to an
immutable tag in a private verification repository. Its OCI index digest was
`sha256:e892253aaa2565d2064da2fbb13c09f85061cbb5095355b8993fa249fa10c2c0`.
Both workers reported that digest. Production build sizing remained
4 vCPU / 16 GiB / 50 GiB; planning remained 2 vCPU / 8 GiB.

The production Durable handler ran in private coordinator version 2. Approval
used the normal API. Cancellation used the production cancellation handler in
a private function with its own restricted role, because the normal deployment
has no ECS substrate or ECS cancellation grant. A `timeout` wrapper bounded
each test container to 900 seconds; it ran the normal batch bootstrap command
inside that limit. Coordinator polling was shortened to five seconds.

| Case | Task | Result |
|---|---|---|
| Approve while waiting | `01M2PA7M84P99ZDV97920NRSEX` | `COMPLETED`; one successful Read |
| Cancel while waiting | `01M2PA7M891EW8VW3FMW9APFXV` | `CANCELLED`; no successful Read |

Each task requested a five-second MicroVM sleep delay but remained ECS
`RUNNING` throughout an approval wait longer than 20 seconds. Neither acquired
MicroVM lifecycle/start metadata. Both retained their original approval clocks,
finished their actual Durable executions successfully, reached ECS `STOPPED`,
released their reservations and deleted their payloads without watcher repair.
The independent audit passed at **00:01:21.042 UTC**.

The first deployment attempt used an incorrect managed-policy name in the
scratch cancellation role and rolled back before any task ran. A subsequent
watcher incorrectly treated the JSON-text approval preview as an object; that
task was stopped and repaired, retained as excluded evidence, and replaced with
fresh IDs. The final audit also corrected its event-name lookup to the actual
`agent_tool_result` schema. These verification errors are not counted as product
failures or successful unattended acceptance.

## Actual ECS permissions and network ports

A separate planning container used the real ECS task role and the production
scoped-session provider. It passed **19 checks**, exited zero, and reached
`STOPPED`:

| Check | Result |
|---|---|
| Ambient task/counter reads | Denied |
| Ambient own bootstrap marker read | Allowed |
| Ambient payload read and payload-bucket listing | Denied |
| Scoped own task read | Allowed |
| Scoped other-task and counter reads | Denied |
| Scoped reporting update shape | Authorized; deliberately false condition prevented mutation |
| Scoped owner, compute handle, start receipt, reservation and lifecycle updates | Denied |
| Scoped bootstrap read | Denied |
| Scoped own artifact write / other-task artifact write | Allowed / denied |
| TCP 443 / TCP 80 to the same address | Connected in 8 ms / timed out after 5 seconds |

Both task records were unchanged afterward. The operator could reach both ports
on that same external address before and after the guest probe. The deployed
security group has no ingress and permits only outbound TCP 443; public IP
assignment was disabled. The network probe verifies this egress restriction,
not remote-MCP behavior or a live public-ingress negative test.

The session role limits an existing tagged session to its task. The compute role
chooses the tags when assuming it; these checks do not establish protection
against a compromised worker minting a different session identity.

## Cleanup, evidence and remaining scope

The long-expiry coordinator, role, private switch, log group and zero counter
were removed with absence verified at **00:15:38.640 UTC**. All 1,524 private
function log events were retained. Together with the earlier two-case cleanup,
all three verification deployments in this record have been removed.

ECS teardown was verified at **00:07:31.420 UTC**. The private stack, both
functions and all versions, five roles, three buckets, registry and private
logs were removed. All four ECS workers were stopped, and the three owned
zero counters were deleted. The automatically created Container Insights
performance log was archived and removed separately from CloudFormation.

The image is an OCI index referencing an ARM64 manifest and a build-attestation
manifest. Cleanup first stopped on an incorrect one-record assumption, then
verified and removed the exact three-digest set. The exact image is retained
locally as a Docker archive. Both inactive task definitions were submitted for
deletion and reported `DELETE_IN_PROGRESS`; these are service records, not
running containers.

Private evidence directories:

- `/tmp/abca-645-p2-clean-20260913/p3-image6-matrix-20260916`
- `/tmp/abca-645-p2-clean-20260913/p3-image6-expiry-20260916`
- `/tmp/abca-645-p2-clean-20260913/p3-ecs-compatibility-20260916`

Permanent private archive:
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/final-image-and-ecs-evidence.tar.gz`.
It contains 188 files, including the exact Docker image, and is 701,261,332 bytes
with mode `0600`. SHA-256:
`576a9d5171fc6b97562310d5f12809e601a88d73e30ac6a3c500d8d9d9bb093f`.
Every archived file hash was checked against the retained manifest.

The normal automatic-suspension switches stay off. Service-side wake traces,
Run-token retention and recovery without guest identity logs, the remaining
backend/network/MCP checks, normal repository-bound delivery, and the applicable
deployment/drain/rollback procedure remain separately tracked in the
[implementation plan](./645-p3-implementation-plan.md).
