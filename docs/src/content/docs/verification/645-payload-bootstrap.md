---
title: 645 payload bootstrap
---

# Trusted task delivery for ECS and MicroVM

The coordinator delivers each task through an IAM-authenticated deployment
manifest and a signed URL for one task object. This is application startup
configuration, distinct from the CDK infrastructure bootstrap.

## Contract and permissions

Version 2 is defined in `contracts/constants.json` under `payload_bootstrap`.
The [ADR wire contract](/sample-autonomous-cloud-coding-agents/decisions/adr-021-lambda-microvms-compute-backend#3-packaging-same-agent-image-source-new-build-path)
and [security design](/sample-autonomous-cloud-coding-agents/architecture/security) describe its trust boundary.

| Object | Purpose |
|---|---|
| `bootstrap/<sha256>.json` | Non-secret backend/platform configuration; coordinator writes, worker reads with its ambient role. |
| `<taskId>/payload.json` | Task instructions/configuration; downloaded only through the signed capability. |
| `<taskId>/launch.json` | Private coordinator replay record containing the exact saved reference. |

The worker's explicit S3 deny outside its own `bootstrap/*` prevents a foreign
public bucket from supplying fake configuration. A content hash alone does not
establish authorship. Workers cannot list their payload bucket or use ambient
credentials to read task objects. The coordinator needs `ListBucket` to distinguish
missing launch records from access denial.

Downloaded task identity and configuration must match the authenticated manifest.
Old unsigned envelopes are rejected. All payload sizes use S3; the serialized
MicroVM reference must fit 4,096 bytes. Manifest/payload limits are 16 KiB/8 MiB.
MicroVM receives the reference through `runHookPayload`; ECS uses
`AGENT_PAYLOAD_REF` and removes it before repository subprocesses start.

A signed URL is a bearer credential. Never log it or store it in a worker-readable
task row. HTTPS downloads reject redirects, environment proxies, alternate hosts
and invalid task paths. The runtime needs regional S3 HTTPS and DNS connectivity.

## Retry and cleanup

- Conditional writes keep task instructions immutable. Read-back reconciles a
  write that succeeded but lost its response.
- Retries reuse the exact saved URL and Run client token. Re-signing would change
  the request under the same token. An expired record fails explicitly.
- Signed lifetime is at most 900 seconds and can end earlier when temporary
  credentials expire. Initial creation refuses a known lifetime under 300 seconds.
- A timeout does not prove no worker started. Reconcile the existing handle or
  uncertain start before considering replacement; the application replay window
  is not a service idempotency-retention guarantee.
- Finalization deletes payload and launch objects on a best-effort basis; bucket
  lifecycle deletion is an asynchronous backstop. The coordinator refreshes
  identical manifest bytes on preparation so old deployment settings remain usable.
- Resume continues saved task state with refreshed credentials; it does not
  download the task again using an expired launch URL.

## Coordinated upgrades

Coordinator code, worker images/task definitions and IAM must implement the same
contract. Keep the previous deployable artifacts and inspect the change set.
For an upgrade that cannot support overlapping versions, pause actual admission
sources and drain tasks, approvals and uncertain starts before switching these
components together. A concurrency counter alone does not pause webhook/queue
admission. Do not delete and recreate storage to perform an upgrade.

For overlapping flat-to-nested migration, preserve old-worker permissions until
those workers drain; follow the [migration prerequisites](/sample-autonomous-cloud-coding-agents/verification/645-p3-nested-stack).
Rollback also requires compatible code, images and IAM. Never reuse a task ID
with conflicting or expired stored launch instructions.

## Verification

Local producer/consumer tests cover conflicts, lost committed replies, malformed
or oversized input, wrong task/configuration, URL redaction and cleanup. These
cannot prove effective AWS permissions. In a representative deployment, verify:

- Own manifest and signed payload succeed; foreign manifests, ambient payload
  reads, bucket listing and worker mutations are denied.
- Modified signatures/paths, expired credentials/URLs and revoked objects fail
  without starting the pipeline or exposing a capability in logs.
- Competing preparation and lost S3/Run replies preserve one exact launch request.
- Finalization removes both task objects and releases only confirmed capacity.

See [recorded acceptance and remaining checks](/sample-autonomous-cloud-coding-agents/verification/readme).
