# ADR-021 P3: live verification of the approval callback fix

Verified 2026-09-15–16 UTC. This records the deployment and live retest of
[the explicit callback timeout](./645-p3-callback-timeout.md), source `58ed7bbf`.
All nine core callback cases passed, including real credential expiry during
suspension. The separate intermittent wake failure remains unresolved; this is
not a P3 completion record.

## Deployment

The `backgroundagent-dev` stack in `us-west-2` reached `UPDATE_COMPLETE`.
Change set `p3-callback-image-20260915`, executed at 23:39:52.809Z, modified
exactly two resources without replacement: the managed MicroVM image and its
build role's permission to read the new artifact. The image URI and permission
were changed together to the same immutable object:

```text
0585a80606aaa66e9ce4dbff35a093451488f72d5a732c6cce6036b88fbcd4ed
```

Image `backgroundagent-dev-abca-agent`, version `4.0`, became `ACTIVE` with
build state `SUCCESSFUL`. Ready and validate returned HTTP 200. All six hooks
remain on port 8080 with the same protocol and 30-second service budget.
Bootstrap remains `1.8.0`; the root stack still has 475 resources.

The main coordinator's code, published version `3`, and alias are unchanged.
Both production suspension settings remain off. The ECS and AgentCore runtime
images have not received this source update.

The deployment used the exact previously uploaded S3 template, with reviewed
artifact substitutions. It did not use the Unicode-damaged `GetTemplate`
response or an unrelated fresh synthesis.

## Isolated live checks

A temporary Lambda uses the compiled production durable coordinator, its
production lifecycle policy and real approval/cancel APIs. Its wrapper allows
only fixed, owned, repository-free tasks and pins image `4.0`. Tasks may read
`/etc/os-release`; the credential-expiry task first runs a foreground
`sleep 180`. No repository publication or notification is part of these checks.

The fixture has its own IAM role, sleep switch and log group. A separate
temporary Lambda isolates the late-deadline supervisor outage from the long
credential-expiry execution. The long execution stays on fixture version `1`;
new boundary cases use published version `2`.

Acceptance requires final task, approval and tool evidence; stable durable
supervisor clocks; one admission/start/finalization; a terminated worker; empty
payload prefix; and a released slot with counter zero. An empty independent
cleanup record proves the watcher did not repair the result.

| Case | Current result |
|---|---|
| Ordinary task | Passed on image `4.0` |
| Approval after sleep, first attempt | Approval/read passed; cleanup acceptance invalidated by watcher timing |
| Fresh approval after sleep | Passed |
| Denial after sleep | Passed; one authoritative denial, no successful read |
| Cancellation while asleep | Passed; no tool result, task stayed canceled |
| Original approval deadline | Passed; timed out at the original deadline |
| Short approval window | Passed; 30-second timeout without suspension |
| Approval during grace period | Passed; quick approval without suspension |
| Wake after original deadline | Passed after an isolated supervisor outage |
| Credentials expire while frozen | Passed; fresh keys after expiry and timeout at the original deadline |
| Newly written files and two approval gates | Passed |
| Missing approval record during freeze | First attempt intercepted by connection refusal; fresh attempt returned expected HTTP 409 |

### First approval attempt: watcher timing error

Task `01M2KQ4D59154CQ89ZW1VWNXD0`, worker
`microvm-2532572a-6fe0-3a44-b2a7-e6edf3a4a687`, returned HTTP 200 from
`/suspend` at 23:48:19.210Z and `/resume` at 23:48:24.662Z. Approval became
`APPROVED` without changing its original clock, and exactly one Read succeeded
at 23:48:24.909Z.

At 23:48:29.945Z the task was `COMPLETED`, the durable execution `SUCCEEDED`,
and its slot released, but AWS still reported `TERMINATING`. The private
watcher immediately required `TERMINATED` and entered independent cleanup.
That makes this attempt unsuitable as proof of untouched coordinator cleanup.

The watcher now observes `TERMINATING` with read-only polling for up to
60 seconds before deciding whether termination failed. It sends no cleanup
request during that wait. Fresh task `01M2KQV00H6CHJKCC2D184DZBR` passed complete
acceptance, including untouched cleanup; the original evidence is retained.

### Real credential expiry and the original approval deadline

Task `01M2KQ4D590P0GSK2VGWXB2987`, worker
`microvm-39599381-c0f2-3298-b9e2-6fcb561daa6a`, stayed on the same image `4.0`
worker throughout this test. It completed one foreground `sleep 180`, then
requested exactly one Read of `/etc/os-release`.

| UTC time | Evidence |
|---|---|
| Sep 15, 23:51:09 | Initial task-scoped STS credentials issued, expiring Sep 16 at 00:51:09 |
| Sep 15, 23:54:24 | Approval created with a 3,600-second window; original deadline 00:54:24 |
| Sep 15, 23:54:55.242 | Guest `/suspend` returned HTTP 200 |
| Sep 16, 00:51:24.348 | Independent read-only observer confirmed `SUSPENDED`, after actual credential expiry |
| Sep 16, 00:53:25 | Fresh credentials issued for the same role and user/task tags, expiring 01:53:25 |
| Sep 16, 00:53:25.372 | Guest `/resume` returned HTTP 200 |
| Sep 16, 00:54:24.136 | Read returned `User timed_out`; the original approval became `TIMED_OUT` |
| Sep 16, 00:54:29 | A further Bedrock response, persisted task events and S3 trace upload succeeded |
| Sep 16, 00:54:31.065 | Coordinator released the task's capacity reservation |

CloudTrail request `d87e98e4-676f-4640-9ad8-881f7cb79e22` identifies the initial
STS issuance; `bedf0aaa-f2ad-4989-ace5-b421558a188c` identifies renewal after
expiry. The evidence stores timestamps, role/session identity and tags, without
credential values.

All 744 durable invocations/poll callbacks preserved one first-observed time and
one session deadline. The task finished `COMPLETED`, its durable execution
`SUCCEEDED`, and the worker `TERMINATED` with reason `Success.` Its payload prefix
was empty, counter zero and independent cleanup record empty. A task completing
after correctly reporting a denied/timed-out tool is expected; the Read itself
did not succeed.

Unlike the previous long test, the approval callback remained alive until the
original deadline. This passes both real credential renewal and callback
semantics; the earlier failed evidence remains in the historical record.

### Repeated wakes, file persistence and missing approval

Six further approval cases passed, three each on images `3.0` and `4.0`.
They used the same coordinator bundle, with the image version pinned separately.
Each retained its worker identity and supervisor clocks, ran one approved Read
and completed cleanup without watcher repair. These successful repeats do not
resolve the intermittent refusal.

Task `01M2KRWNPPRV7CGJQSRFYY3375`, worker
`microvm-09ebf679-e78c-398d-8023-f1a176d5fb51`, wrote two new marker files in an
owned temporary directory. Its first gate was created at 00:21:33Z on Sep 16,
and its second at 00:22:12Z. Both independently suspended and resumed with HTTP
200, retaining distinct approval IDs and their original 600-second windows.
The two successful Reads returned the original marker bytes after their
respective freezes. The full recorded Bash and Read inputs match the intended
commands and paths.

The pre-freeze SHA-256 values were:

```text
b81be383132e7a49275fcf91cb22b0f4b015aa7b26387a3f300f7bc6ed395781
ba01a509d1b49275a6b7c4a936172e507e51debea893b9b4a34e7e02e532e4af
```

All 21 durable invocations retained one pair of supervisor clocks. This proves
mutable temporary-filesystem persistence across two approval generations; it
does not replace a full P3 run against a cloned repository.

The first missing-approval case, task `01M2KRWNPP4BQCJ80SVG6473Z8`, reproduced
the [connection refusal](./645-p3-resume-refusal-investigation.md) on image `4.0`.
The task failed and cleanup passed, but the expected guest response was absent.
Its acceptance record remains failed.

One fresh attempt, task `01M2KSTSR1V31NTPQ0CKCJJJMN`, worker
`microvm-a093863f-edf0-39f4-9d79-6893ff08042c`, reached the intended failure:
after conditional deletion of its own pending approval, `/resume` returned HTTP
409 at 00:30:46.418Z. The service reported that HTTP status explicitly. No Read
result was produced; the task was `FAILED`, the worker terminated, its slot
released and payload removed without independent cleanup. This is a passing
negative test: the missing gate never allowed the tool to run.

## Database checks and comment review

The optional database suites skipped by the full build were run separately
against the documented pinned DynamoDB Local image, using a loopback endpoint
and dummy credentials. All 56 CDK lifecycle/capacity cases and all 47 Python
checkpoint cases passed. The temporary in-memory container was removed and
its absence verified.

The subsequent source-comment edits passed TypeScript compilation and focused
ESLint. Python type checking also passed, covering the probe's final output
redirection change.

Source comments now distinguish asynchronous `TERMINATING` from finished
shutdown, describe bounded recovery for unknown/suspending states, and specify
which roles receive lifecycle permissions.

### Runtime logging inventory

At 00:13:54.991Z on 2026-09-16, worker
`microvm-82e58ec5-ee2a-399b-aa8b-38a8469ac4a7` on image `3.0` was `RUNNING`
both before and after enumerating `/aws/lambda-microvms/` log groups. The only
group was `/aws/lambda-microvms/backgroundagent-dev-abca-agent`, with 90-day
retention. CloudFormation confirms that
`LambdaMicrovmComputeMicrovmLogGroup46EC26A7` owns that group. Image `4.0`
runtime and build records also arrived there.

The deployed execution role has one inline policy and no attached managed
policies. Its logging grants allow `CreateLogStream` and `PutLogEvents`, with
no `CreateLogGroup` permission. No permission changes were needed for these
runs. This replaces the old comment's pending during-run inventory check;
it does not guarantee that future service versions will never need another
group.

## Final cleanup

Before infrastructure removal, all 18 main-function durable executions were
terminal; the separate late-deadline execution had already finished. All 19 owned
tasks had terminated workers, released reservations, zero counters and empty
task-payload prefixes. Task statuses were 16 `COMPLETED`, one `CANCELLED` and two
`FAILED`. Those counts include the retained failed/mis-measured attempts and must
not be read as 19 passing acceptance cases.

The main function's six published versions, the separate late-deadline function,
their two log groups, the shared verification-only role and its policies, and
the private suspension switch were removed. Read-only checks at
2026-09-16T00:59:28.099Z confirmed both functions, the role, parameter and log
groups were absent. The in-memory DynamoDB Local container was also removed.

Full guest streams, 4,028 main-function log events, durable histories, task events,
redacted credential issuance and resource checks are retained in the private
verification archive. Task/event/trace audit records and shared immutable image
artifacts retain their normal lifecycle; they were not deleted as test payloads.
Production suspension settings remain off.

## Remaining scope

The three original image `3.0` resume-hook connection refusals and the new image
`4.0` refusal remain unresolved. The
[investigation record](./645-p3-resume-refusal-investigation.md) contains all
four timelines and the next diagnostic steps. The callback fix changes how long
Claude waits for Python; it does not resolve the separate connection failure.
Successful later wakes do not discharge those failures.

The [implementation plan](./645-p3-implementation-plan.md) retains the wider
P2/P3 acceptance gates. This completed callback retest and cleanup do not close
the separate wake-failure, full-repository, other-backend or migration gates.
