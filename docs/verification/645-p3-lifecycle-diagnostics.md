# MicroVM lifecycle diagnostics

An approval being saved, AWS accepting Resume, and the guest resuming work are
three different events. Diagnose each independently; an accepted API response
is not a completed wake.

## Correlate coordinator and guest logs

Search coordinator/approval Lambda logs and the MicroVM image log group using
`task_id` and `microvm_id`. `request_id` identifies the approval gate;
`aws_request_id` identifies an AWS call; `hook_id` identifies one guest HTTP hook.

| Coordinator record | Meaning |
|---|---|
| `MicroVM observed after approval decision` | State and saved lifecycle intent observed after the decision. |
| `MicroVM wake request started/requested after approval decision` | Wake dispatch and acknowledgment, including receipt and elapsed time when available. |
| `MicroVM lifecycle request started/acknowledged/failed` | Suspend/Resume operation and result. |
| `MicroVM supervisor observation changed` | Task/worker/gate state, recovery timing, failure counters and outcome. |
| `MicroVM reached a terminal state with a substrate reason` | Service reason and worker/image identity. |
| `Lambda MicroVM termination requested` | Cleanup request and receipt. |

Unchanged supervisor observations are deduplicated across durable replay.
Recovery timeouts retain their original start; investigating or retrying must
not reset them.

For guest logs, select the deployed image's `/aws/lambda-microvms/<image-name>`
log group and run a CloudWatch Logs Insights query such as:

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
| `microvm_hook_started` | Handler entry, before body reading. |
| `microvm_hook_stage` | The next potentially blocking operation. |
| `microvm_hook_stage_finished` / `microvm_hook_stage_failed` | Operation completion or safe error metadata. |
| `microvm_hook_finished` | Selected handler status/code; not proof of service receipt. |

`stage` records the last entered operation, such as credential refresh or approval
identity reconciliation. `late: true` means a callback finished after the handler
had already returned; it cannot turn a timed-out wake into success. The coding
barrier remains responsible for preventing tools after an uncertain wake.

## Checkpoint failure codes

The checkpoint diagnostic `code` narrows the failing operation; it does not
prove that saved data is corrupt.

| Code | Meaning |
|---|---|
| `checkpoint_failed` | No narrower classification; inspect the accompanying stage and message. |
| `checkpoint_invalid_json` | Checkpoint JSON could not be encoded or decoded. |
| `checkpoint_sdk_unverified` | SDK version or required accounting interface is not verified. |
| `checkpoint_sdk_timeout` | SDK transcript acknowledgment or accounting request timed out. |
| `checkpoint_storage_unverified` | A save could not be verified by reading back the exact data; keep the source worker. |
| `checkpoint_storage_unavailable` | Storage configuration is unavailable or the saved version could not be read. |

Workspace capture and restore can also report specific codes such as
`disk_pressure` or `git_timeout`. Preserve the reported code and stage when
escalating; do not replace them with a generic checkpoint label.

## Diagnose a failed wake

1. Locate the saved decision/intent and actual Resume acknowledgment or failure.
   Retain the original generation, deadlines and API request ID.
2. Find guest hook entry. If absent, account for log delivery and retention before
   inferring anything about the listener or process.
3. If entered, inspect the final stage/code. Credential-refresh `AccessDenied`
   points to renewal permissions; identity-read failures point to task/gate
   reconciliation. A timeout identifies the outstanding operation.
4. Check subsequent guest progress, coordinator outcome, worker termination and
   capacity release. A saved approval or successful cleanup does not establish
   that the approved tool ran.
5. Retain UTC timestamps, task/worker identifiers, exact image/coordinator
   versions, service state reason, AWS receipts and relevant sanitized logs.

`MICROVM_RESUME_HOOK_FAILED` identifies recognized service resume-hook failures.
Preserve the raw service reason for diagnosis. The wording “connection was
refused” alone does not prove a closed listener: historical guest observations
support a stale pooled-connection race, while service-side dispatch traces remain
unavailable. Lifecycle responses explicitly close connections before freeze.

Diagnostics omit hook bodies, tool arguments, approval contents, credentials,
raw exception messages and SDK response bodies. Do not attach signed payload
URLs or conversation/workspace checkpoints when escalating an incident.
