# ADR-021 P3: actual AgentCore permission checks

Verified September 17, 2026, in account `<account-id>`, `us-west-2`.
The normal AgentCore runtime's `DEFAULT` endpoint remained **READY**, version
**5**. This extends the earlier
[AgentCore approval/cancellation checks](./645-p3-agentcore-20260916.md)
with real permission requests from that runtime.

## Test and results

Task `01M2PDAMMMMH8GMSS0YJP2J9R6` ran one exact Python diagnostic through
the agent's Bash tool. It had no repository or notification destination,
a four-turn/$1 limit, and an eight-minute watcher limit. A private Lambda
ran the production Durable handler. Its code SHA-256 was
`T4bq5saVKeGxQd0yUHN3TRCPKTrqUNH+TJHVT2YyVtc=`.

The diagnostic removed inherited static credential overrides in its child
process before loading the production `aws_session` providers. This made
the ambient checks use AgentCore's container credential provider. Actual STS
identity requests verified the normal runtime role and the task session role.
No credential values were printed or saved.

The independent audit passed at **00:55:43.375 UTC**:

| Requests | Count | Result |
|---|---:|---|
| Ambient and scoped STS identities | 2 | Expected roles |
| Ambient task/counter reads | 2 | Denied |
| Ambient artifact read/list | 2 | Denied |
| Scoped own task / other owned task / counter reads | 3 | Allowed / denied / denied |
| Scoped reporting update with deliberately false condition | 1 | Authorized shape; condition rejected |
| Scoped writes to owner, compute handle, start receipt, reservation and lifecycle fields | 5 | Denied |
| Scoped own artifact write/read | 2 | Allowed / denied |
| Scoped write under another owned task's artifact prefix | 1 | Denied |
| Scoped MicroVM bootstrap-object read | 1 | Denied |

All **19** checks retained actual AWS request IDs. Artifact access is
deliberately write-only in the deployed session role; the read denial is
expected. Every DynamoDB update used a false condition, so even unexpected
authorization could not change an existing task row. The other owned task's
complete record was unchanged.

The audit verified exactly one Bash call matching the prepared command, one
successful tool result, zero approval records and zero dropped trace events.
The task completed, and its Durable execution succeeded. No MicroVM SDK call,
start receipt or lifecycle state appeared.

Permission-result SHA-256:
`07237297d088b12743b5237a8655bfd5fca0cc072f84bddbdec3d15fa1913fdc`.
Trace SHA-256:
`9dc90a5df6077b2d27ef777d88400c505cb6c5e75dd2d634a12cb9599a50b377`.

These checks establish the observed grants for the issued credentials.
They do not prove isolation against a compromised worker choosing different
tags when assuming the session role.

## Watcher timing error

The original watcher failed after the diagnostic had completed. It read
the task while its slot was still held, then read the newer Durable status
`SUCCEEDED`, and incorrectly asserted against the older task snapshot.

| Evidence | UTC time |
|---|---|
| Actual reservation release | 00:53:28.261 |
| Durable `finalize` step succeeded | 00:53:28.301 |
| Durable execution succeeded | 00:53:28.318 |
| Watcher's stale-snapshot assertion failed | 00:53:28.391 |

The fallback invoked the idempotent release helper after release had already
completed. It also explicitly stopped the owned AgentCore session. The
independent audit records this watcher failure and verifies the original
permission results separately; it does not relabel the watcher as passing.

The original script is retained as `run-executed.cjs`. The corrected watcher
rereads the task after observing Durable completion. That corrected script
was syntax-checked but was not used to rerun the already completed AWS checks.

## Cleanup and retained evidence

Session `adbb6743-2a03-4161-9f87-f206aa738088` was stopped at
**00:53:40.358**, request ID `9077a23c-f13b-47ca-883f-26dac1c066c9`,
and subsequently returned `ResourceNotFoundException`.

Private infrastructure cleanup was verified at **00:58:36.593**. The
coordinator and all versions, role, switch, log group and zero counter were
removed. Both harmless probe objects were archived and removed; the negative
write created no object. All 32 private function log events were retained.
Normal task/trace records follow their existing retention policy.

The initial immediate absence check briefly still saw the deleted Lambda.
A subsequent bounded, read-only check verified absence. The original cleanup
script and failure, the follow-up verification, and the corrected future
cleanup script are retained.

The normal runtime endpoint's full before/after snapshots and ambient-role
policies were identical. Normal MicroVM automatic sleep stayed off.
Evidence directory:
`/tmp/abca-645-p2-clean-20260913/p3-agentcore-permissions-20260917`.

The permanent private archive is
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/agentcore-permissions-evidence.tar.gz`.
It contains **45 files**, **14,912,232 bytes**, with mode `0600`; every member's
hash was checked against the manifest. Archive SHA-256:
`34123cd0d4599598a0489d9716d34ab86ccb97c0c5944b53072dbf33f21aa2fc`.

Runtime ingress, remote MCP connectivity and the remaining deployment/service
gates remain in the [implementation plan](./645-p3-implementation-plan.md).
