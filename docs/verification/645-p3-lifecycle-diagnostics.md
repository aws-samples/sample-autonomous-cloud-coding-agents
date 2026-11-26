# MicroVM lifecycle diagnostics

An approval being saved, AWS accepting Resume, and the guest resuming work are
three different events. Diagnose each event independently. An accepted API
response is not a completed wake.

## Correlate coordinator and guest logs

Search the coordinator and approval Lambda logs and the MicroVM image log group
for `task_id` and `microvm_id`. `request_id` identifies the approval gate.
`aws_request_id` identifies an AWS call. `hook_id` identifies one guest HTTP hook.

| Coordinator record | Meaning |
|---|---|
| `MicroVM observed after approval decision` | State and saved lifecycle intent observed after the decision. |
| `MicroVM wake request started/requested after approval decision` | Wake dispatch and acknowledgment, including receipt and elapsed time when available. |
| `MicroVM lifecycle request started/acknowledged/failed` | Suspend or Resume operation and its result. |
| `MicroVM supervisor observation changed` | Task, worker and gate state, recovery timing, failure counters and outcome. |
| `MicroVM reached a terminal state with a substrate reason` | Service reason, and worker and image identity. |
| `Lambda MicroVM termination requested` | Cleanup request and receipt. |

Unchanged supervisor observations are deduplicated across durable replay.
Recovery timeouts retain their original start. Investigating or retrying must
not reset them.

For guest logs, select the `/aws/lambda-microvms/<image-name>` log group of the
deployed image and run a CloudWatch Logs Insights query such as this one:

```text
fields @timestamp, event, action, stage, callback_stage, code, http_status,
       hook_id, request_id, pid, phase, elapsed_ms, late,
       error_type, aws_error_code, aws_request_id
| filter microvm_id = "REPLACE_WITH_WORKER_ID"
| sort @timestamp asc
| limit 500
```

| Guest event | Meaning |
|---|---|
| `microvm_hook_started` | Handler entry, before the body is read. |
| `microvm_hook_stage` | The next potentially blocking operation. |
| `microvm_hook_stage_finished` / `microvm_hook_stage_failed` | Operation completion or safe error metadata. |
| `microvm_hook_finished` | Selected handler status and code. Not proof of service receipt. |

`stage` records the last operation entered, such as credential refresh or approval
identity reconciliation. `late: true` means that a callback finished after the
handler had already returned. A late callback cannot turn a timed-out wake into
success. The coding barrier remains responsible for preventing tools after an
uncertain wake.

## Diagnose a failed wake

1. Locate the saved decision and intent, and the actual Resume acknowledgment or
   failure. Retain the original generation, deadlines and API request ID.
2. Find the guest hook entry. If the entry is absent, account for log delivery
   and retention before you infer anything about the listener or process.
3. If the hook was entered, inspect the final stage and code. A credential-refresh
   `AccessDenied` points to renewal permissions. Identity-read failures point to
   task and gate reconciliation. A timeout identifies the outstanding operation.
4. Check the subsequent guest progress, the coordinator outcome and the worker
   termination. A saved approval or a successful cleanup does not establish that
   the approved tool ran.
5. Retain the UTC timestamps, the task and worker identifiers, the exact image
   and coordinator versions, the service state reason, the AWS receipts and the
   relevant sanitized logs.

A guest that cannot safely sleep answers `/suspend` with HTTP 200 and status
`declined`. The hook log keeps the reason in `code`, for example
`MICROVM_LIFECYCLE_UNAVAILABLE` or `MICROVM_LIFECYCLE_TIMEOUT`, with
`http_status` 200. The following `/resume` answers `not-suspended`. A non-200
suspend response terminates the VM. A state reason that names a suspend-hook
status therefore means that the guest had no registered task or a permanently
closed barrier.

`MICROVM_RESUME_HOOK_FAILED` identifies recognized service resume-hook failures.
Preserve the raw service reason for diagnosis. The wording "connection was
refused" alone does not prove a closed listener. Historical guest observations
support a stale pooled-connection race, but service-side dispatch traces remain
unavailable. Lifecycle responses explicitly close connections before freeze.

Diagnostics omit hook bodies, tool arguments, approval contents, credentials,
raw exception messages and SDK response bodies. When you escalate an incident,
do not attach signed payload URLs or task payloads.
