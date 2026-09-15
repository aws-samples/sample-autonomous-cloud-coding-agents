# Coordinator metadata write protection (#645)

The coordinator is the platform code that assigns capacity and starts/stops a task's computer. The agent reports what happened inside that computer. Both use the task record, but the agent must not rewrite the coordinator's saved machine identity or capacity reservation.

## Implemented boundary

`AgentSessionRole` now treats the main task table separately from events, approvals and nudges:

- Main task reads remain scoped to the session's `task_id`. These fields are not secrets.
- Main task writes allow only `UpdateItem`, with `dynamodb:Attributes` restricted to the reviewed list in `cdk/src/constructs/agent-task-write-attributes.json`. Both the attribute context and the scoped leading key must be present; `ForAllValues` alone accepts an absent context key.
- No main-table `PutItem`, `DeleteItem`, `BatchWriteItem` or PartiQL write permission is granted. A replacement could erase a protected field without mentioning its name, so attribute filtering alone would not make replacement safe.
- Supporting table access remains scoped to the tagged task. Approval transactions still use `PutItem` on the approval table and restricted `UpdateItem` on the main task table.
- The main table cannot also be supplied as a supporting table: the construct rejects that bypass at synthesis.
- AgentCore and configured ECS/MicroVM workers have no direct DynamoDB access; they assume the session role. ECS's legacy configuration without a session role uses the same attribute restriction, but its reads/updates are not task-scoped. None of the compute roles has the old shared-capacity-counter grant.

This is an allowlist: a new coordinator field is protected without adding its name to a denylist. New agent reporting fields require a deliberate contract update.

AWS documents [`dynamodb:Attributes`](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html) as the top-level attributes referenced in a request, including the parent of a nested path. For example, `SET #receipt.#handle = :value` with aliases resolving to `microvm_start.handle` references `microvm_start` and is outside the allowed set. Read responses remain unrestricted within the tagged task; this change does not claim attribute confidentiality.

## Writer inventory

| Agent writer | Main-task fields |
| --- | --- |
| `write_running` | `status`, `status_created_at`, `started_at`, optional `logs_url` |
| `write_heartbeat` | `agent_heartbeat_at`; condition reads `status` |
| `write_terminal` | Status/completion time, cost/turns, verification results, PR/answer and trace/artifact references |
| `write_trace_uri_conditional` | `trace_s3_uri`; condition reads terminal `status` |
| `transact_write_approval_request` | `status`, `awaiting_approval_request_id`; also creates the supporting approval row |
| `transact_resume_from_approval` | `status`, refreshed heartbeat, removes approval request ID |
| `increment_approval_gate_count_in_ddb` | `approval_gate_count` |

`progress_writer.py` writes only the supporting events table. `nudge_reader.py` updates only the supporting nudges table. Approval decisions/timeouts use the supporting approvals table.

The unused `write_submitted` and `write_session_info` Python helpers were removed. Neither had a production caller; their comments incorrectly attributed task creation/session registration to the agent. The TypeScript coordinator already owns those operations.

## Local checks and their limits

The regression first failed against the old policy because the main-table grant included `PutItem`. Construct tests now check the restricted main-task statements, missing-context guards, duplicate-table rejection, unchanged session tags and absence of direct worker counter access. Stack tests check actual AgentCore and MicroVM wiring; ECS tests cover both configured and legacy direct access.

Python contract tests run the real task writers against recording clients, including all terminal-result fields and both approval transactions. They compare the requested attributes against the same JSON list used by CDK and require review when a new writer is added.

These local checks inspect generated policies and request compatibility; they do
not execute AWS authorization. DynamoDB Local also does not implement IAM.
The subsequent [37-case AWS matrix](./645-effective-iam-20260915.md) passed using
the unchanged deployed MicroVM role and real tagged sessions from a temporary
Lambda. Other backend ambient roles and migration/scale remain open.

## AWS acceptance and rollout gate

Use an isolated deployment and disposable task rows with known initial `microvm_start`, `concurrency_slot`, owner and compute metadata. Record the deployed commit, image version and effective role policies. Use task-scoped credentials for two different tasks and separately check the ambient compute roles.

| Request | Required result |
| --- | --- |
| Own-task heartbeat, full terminal result and trace repair | Allowed; protected fields unchanged |
| Approval request and resume transactions | Allowed; both records consistent and heartbeat refreshed |
| Update of another task or a session with no task tag | Denied |
| Put/replacement, Delete, BatchWrite put/delete on own task | Denied; original row unchanged |
| SET/REMOVE/ADD/DELETE involving `concurrency_slot` or `microvm_start`, including aliases/nested paths | Denied |
| Change `user_id`, TTL, session ID, compute type or compute metadata | Denied |
| Transaction containing a forbidden main-task update/put/delete plus an otherwise valid approval write | Entire transaction denied; neither record changes |
| PartiQL update/delete/insert against the task table | Denied |
| Direct task-table or capacity-counter operations using any configured worker's ambient credentials | Denied |
| Coordinator start, cancellation, finalization and counter repair | Allowed; replay retains exactly-once reservation accounting |

Drain old executions according to the [capacity rollout procedure](./645-capacity-reservations.md#upgrade-and-live-verification). Review effective policies for additional grants or resource policies that could bypass this allowlist. Deploy the code/policies together and publish the matching agent image. Existing agent writers already fit the list, but an external or old custom caller of the removed helpers must be migrated. Wait for IAM propagation and verify newly assumed and existing sessions before reopening admissions. No bootstrap policy change is required by this patch; it changes application-role permissions.

Do not roll back to unrestricted worker writes while relying on protected reservation/start metadata. Drain first and explicitly review the security consequence of a rollback.

## Remaining trust limits

The agent can still report status and results. This patch does not authenticate whether its reported success/failure is truthful or constrain status values/transitions at IAM level. Supporting approval/event/nudge rows retain their prior permissions.

The compute role chooses `{user_id, repo, task_id}` session tags. Current trust policies do not independently prove that the chosen task belongs to that worker. A compromised whole worker with ambient credentials can therefore try to assume a differently tagged session. The attribute restriction applies to that session too, but this is not complete tenant isolation. Trusted task/deployment identity and task-scoped payload reads remain separate prerequisites in the [P3 plan](./645-p3-implementation-plan.md).

## Payload capability storage

The subsequent [v2 payload bootstrap](./645-payload-bootstrap.md) stores signed download URLs only in coordinator-owned S3 launch records. They are not added to `microvm_start` or other TaskTable attributes: own-task reads still include internal metadata, so API omission and attribute write restrictions cannot provide confidentiality for a bearer URL.
