# ADR-021 P3: lifecycle diagnostics

Updated 2026-09-16. The logging changes passed local checks and three isolated
AWS workflows. The [normal-stack rollout](./645-p3-diagnostics-rollout-20260916.md)
first deployed coordinator version 6 and image 5.0. The latest
[connection-close rollout](./645-p3-connection-close-rollout-20260916.md) runs
coordinator 10 and image 6.0, adds specific timeout feedback, and passed four
real Durable workflows. Automatic suspension remains disabled. The six
[recorded wake refusals](./645-p3-resume-refusal-investigation.md) are retained
for service-side diagnosis.

## What the records tell us

Think of waking a worker as delivering a message, then waiting for it to finish
getting ready. These are separate checkpoints:

1. The approval API saves the decision and a wake intent. That saved decision can
   succeed even if the immediate wake request fails.
2. AWS accepts `ResumeMicrovm`. Its request ID is a receipt for that API call;
   it does not prove that the guest received `/resume` or resumed execution.
3. The guest receives `/resume`, refreshes credentials, checks the original task
   and approval, and returns its HTTP response.
4. The coordinator observes the resulting worker/task state. It retains the
   original wake and approval deadlines across retries.

## Cloud logs

Search the deployed coordinator and approval API Lambda log groups by `task_id`
and `microvm_id`. The approval gate is `request_id`; an AWS service receipt is
`aws_request_id`. These identifiers have different meanings.

| Record/message | Useful fields |
|---|---|
| `MicroVM observed after approval decision` | Observed state, saved intent generation/time, Get request ID |
| `MicroVM wake request started after approval decision` | Task, gate, worker, image, saved generation/time |
| `MicroVM wake requested after approval decision` | Same correlation plus Resume request ID and elapsed milliseconds |
| `MicroVM lifecycle request started/acknowledged/failed` | Suspend or Resume operation, worker/image, elapsed time; AWS request ID when supplied |
| `MicroVM supervisor observation changed` | Task/worker/approval state, intent generation, recovery kind/original start, failure counters, outcome/reason, original deadlines |
| `MicroVM reached a terminal state with a substrate reason` | AWS state reason, worker/image, Get request ID |
| `Lambda MicroVM termination requested` | Worker, cleanup reason, Terminate request ID and elapsed time |

The supervisor saves its last diagnostic signature in durable state, so an
unchanged poll after replay does not repeat the same record. A state change,
recovery change, failure-count change or terminal outcome does. Timestamps and
elapsed time are not part of that signature. Old saved states without a signature
remain usable and log their first new observation.

## Guest logs

Select `/aws/lambda-microvms/<image-name>`. A typical CloudWatch Logs Insights
query is:

```text
fields @timestamp, event, action, stage, callback_stage, code, http_status,
       hook_id, request_id, pid, phase, elapsed_ms, late,
       error_type, aws_error_code, aws_request_id
| filter microvm_id = "REPLACE_WITH_WORKER_ID"
| sort @timestamp asc
| limit 500
```

Each HTTP invocation generates a fresh `hook_id`. All its callback-thread
records share that ID. The registered task, worker and gate identify the work;
the request body cannot override those diagnostic identities.

| Event | Meaning |
|---|---|
| `microvm_hook_started` | The HTTP handler was entered, before reading its body |
| `microvm_hook_stage` | About to perform `callback_stage`; emitted before potentially blocking work |
| `microvm_hook_stage_finished` | That piece of work returned; this alone is not a hook acknowledgment |
| `microvm_hook_stage_failed` | That piece of work failed; includes exception type and safe AWS code/request ID when available |
| `microvm_hook_finished` | Handler result: HTTP status and stable diagnostic code; cancellation has no HTTP status |

Stages include body reading, local identity checks, the controller, draining
active writes/reads, checkpoint reads/transaction, credential refresh, and resume
identity reads/transaction. `stage` retains the last entered operation, including
when a callback is still blocked at timeout. Nested stage records also identify
their enclosing operation in `callback_stage`.

Records include the server PID, local phase/generation, active tool/activity
counts and whether earlier progress failure disabled suspension. These are local
observations; they do not prove the listener remained healthy during a freeze.
`microvm_hook_finished` records the response the handler selected; the service's
state and HTTP access logs establish what AWS subsequently observed.

`late: true` means a callback logged after the handler had already finished.
It cannot turn a timed-out wake into success. The existing controller still owns
the barrier that prevents tools from continuing after an uncertain wake.
Logging failure is best effort and cannot change the hook result.

The new diagnostics omit bodies, tool arguments, approval contents, credentials,
SDK response bodies, raw exception messages and tracebacks. AWS error codes and
request IDs are bounded identifiers. Existing terminal `state_reason` retention
continues independently for service diagnosis.

## Reading a failed wake

1. Find the saved intent and the actual Resume acknowledgment or failure. Check
   its generation and original request time; do not restart the timer while
   investigating.
2. Find the corresponding guest hook start. If absent, account for log delivery
   delay and retention. Absence alone cannot distinguish a dead process, missing
   listener, service transport failure or missing logs.
3. If the hook started, inspect the last stage and final code. For example,
   `credential-refresh` plus `AccessDenied` points to credential renewal, while
   `resume-identity-read` plus `MICROVM_LIFECYCLE_UNAVAILABLE` points to task/gate
   reconciliation. A timeout names the operation that was still outstanding.
4. Check the coordinator's outcome, task progress, worker cleanup and capacity
   release. A saved approval and successful cleanup do not mean coding resumed.
5. Retain the task/worker IDs, exact image and coordinator versions, UTC window,
   AWS request IDs, service state reason and relevant logs. For connection
   refusal before hook entry, independent listener/process or service-side
   evidence is still required.

Known Resume generic failures, connection-refused, timeout and HTTP 4xx/5xx
reasons produce the stable
`MICROVM_RESUME_HOOK_FAILED` task error. It asks an admin to inspect this evidence
and saved progress before starting a replacement. It does not promise that
retrying repairs the fault. Persisted classification codes take priority over
diagnostic words; unrecognized AWS wording keeps the generic terminal code.

The service's connection-refused wording alone does not establish that the
listener was closed. The [instrumented transport failure](./645-p3-wake-transport-20260916.md#exact-refusal-with-connection-and-listener-evidence)
recorded that wording while the original listener was still observed, after an
expired idle timer closed the old HTTP connection. Preserve the raw reason and
receipts; distinguish the guest observations from the service's unavailable
dispatch details.

## Verification and deployment

Local regressions cover hook correlation, sensitive-text exclusion, safe AWS
identifiers, logging-sink failure, callback timeout/late completion, durable
observation deduplication without moving deadlines, and wake error feedback.
The root `mise run build` exited **0**: **5,019 CDK tests** and **928 CLI tests**
passed, along with lint, types, contracts, synthesis and documentation checks.
After the final concurrent-output/cancellation coverage and guide edits, agent
quality and documentation checks passed again: **1,947 Python tests**, **86.43%**
coverage. **56 CDK** and **11 Python** optional DynamoDB Local cases were skipped;
the database transaction conditions were unchanged.

The private image `backgroundagent-dev-p3-diagnostics-20260916:1.0` was derived
from the exact image `4.0` source artifact. It replaced three lifecycle Python
modules and added `microvm_diagnostics.py`; the Dockerfile, original server
command, dependencies and hook configuration were unchanged. Its artifact SHA-256
was `15b8867dfe7f45270246695d9c87d2f1ef42d0b338fd331a88fbe5bfc26d7733`.
Private coordinator and approval Lambda versions 1 and 2 used the checked
production code with fixed verification task identities.

The strict log audit passed at **2026-09-16 14:21:03 UTC**:

| Case | Actual wake path | Resume AWS request ID |
|---|---|---|
| `approve-a` | Coordinator won the race; API observed restore `PENDING` and retained its successful approval response | `c6ba7eea-5f18-4ccf-b032-b0aeb0cce15a` |
| `approve-b` | Verification wrapper omitted immediate API wake; coordinator issued the sole Resume | `29ebc13a-cf70-4ed9-84b2-a0f31533406c` |
| `approve-inline` | API issued the sole Resume during a verification-only 8-second coordinator polling delay | `4b7d0ba8-3106-4126-bbaa-7ad89df9fc72` |

The first case was originally intended to exercise the API's Resume call. Its
strict assertion failed, and the new logs showed the actual successful fallback.
That evidence was retained; the fresh third case established the missing API
path. The timing delay affected only the private test wrapper, after suspend
intent. It changed neither production supervisor logic nor original deadlines.

Every worker produced **32 guest diagnostic records**, one successful suspend
and resume hook pair, and the expected checkpoint/refresh/reconciliation stage
records. The original server remained **PID 1** across each wake. The coordinator
recorded **9, 8 and 5** meaningful observations respectively. AWS receipts were
present for suspend, the actual resume issuer, and cleanup. No guest failure or
late-callback record appeared in these successful workflows.

All three tasks completed with their original approval deadlines, released
capacity, zero counters, terminated workers and empty launch-payload prefixes.
Complete retained traces each contain exactly one approved `Read` of
`/etc/os-release`. These short successful wakes establish working diagnostics;
failure/redaction paths were verified by local fault injection. The original
connection-refused defect was not reproduced.

Raw logs, traces, durable histories, artifacts, source digests, original failed
assertions and corrected audit scripts are retained in private verification
evidence. Cleanup verified removal of both private functions (all versions),
the diagnostic image, three roles, the private SSM switch, three log groups,
the artifact object and three owned zero-valued counters. Task/approval history
and trace objects retain their normal retention.
The subsequent [normal-stack rollout](./645-p3-diagnostics-rollout-20260916.md)
deployed coordinator **6** and image **5.0**, including this instrumentation.
Automatic suspension remains disabled until the remaining P3 gates pass.
