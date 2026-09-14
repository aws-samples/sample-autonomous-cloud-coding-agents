# #645: trusted task delivery for ECS and MicroVM

Implementation date: 2026-09-13. Tracks the prerequisites in #817 and #700. **Deployed for MicroVM; 11 live transport/failure cases passed on 2026-09-14.** The [live evidence](./645-p2-payload-live-20260914.md) covers real worker reads/rejections, URL expiry/revocation, operator-side conditional preparation and immediate Run replay. The broader authorization/recovery matrix and ECS rollout below remain open. This does not implement P3 sleep/wake.

## What changed, in plain language

Think of S3 as a locked filing cabinet. A **bucket** is one cabinet and an **object** is one file. The **coordinator** is the supervisor that starts tasks. A **worker** is the ECS container or MicroVM that runs the coding agent.

Previously, each worker's permission badge could read other tasks' instruction files. Also, checking that two AWS addresses named the same account did not prove either address belonged to this deployment.

The new protocol gives the worker:

1. A small **manifest**: a list of the deployment's non-secret settings. The worker reads this with its own AWS permission badge. Only this deployment's bootstrap directory is allowed.
2. A **presigned URL**: a temporary download ticket, created by the coordinator, for exactly one task's instruction file. AWS checks its signature. Possessing the ticket permits the read, so the complete URL must be treated like a password.

The downloaded task must name the expected task ID and contain exactly the settings in the authenticated manifest. Changing a secret's address to another workspace in the same AWS account now fails this comparison.

This bootstrap means “load the information needed to start a task.” It is distinct from the infrastructure bootstrap that installs deployment permissions.

## Storage and wire contract

Both backends use `contracts/constants.json` → `payload_bootstrap`, version 2. All task payloads use this path, including small tasks.

| Location | Content / owner |
|---|---|
| `bootstrap/<sha256>.json` | `{version:2, backend, platform_config}`. Coordinator writes; worker reads. The filename contains a SHA-256 digest: a fingerprint of the exact JSON bytes. |
| `<taskId>/payload.json` | `{version:2, task_id, agent_payload, platform_config}`. Coordinator writes; worker downloads using the signed URL. |
| `<taskId>/launch.json` | `{fingerprint, reference}`. Private coordinator replay record containing the signed URL. No worker read. |
| MicroVM `runHookPayload` / ECS `AGENT_PAYLOAD_REF` | JSON string containing the reference below. Never log it. |

```json
{
  "version": 2,
  "task_id": "TASK001",
  "bootstrap_s3_uri": "s3://deployment-bucket/bootstrap/<sha256>.json",
  "payload_url": "<redacted single-object HTTPS URL>",
  "expires_at": 1789312500000
}
```

The example is descriptive; the manifest digest and signed URL must be produced by the coordinator. `expires_at` is milliseconds since the Unix epoch.

MicroVM manifests contain the allowlisted environment identifiers built from the coordinator's deployment environment. ECS manifests contain `{}` for `platform_config`: its platform settings already arrive through the trusted task definition and coordinator overrides. Task-specific fields remain in `agent_payload`.

Manifest and payload limits are **16 KiB** and **8 MiB**, respectively. The serialized MicroVM reference must fit **4,096 bytes**. The entire ECS overrides object must fit **8,192 UTF-8 bytes**; the prompt is no longer duplicated in `TASK_DESCRIPTION`.

The image rejects the old unsigned inline/S3 envelopes. There is no compatibility branch that accepts settings merely because an image already contains the required environment variables.

## Permission boundary

| Principal | Allowed | Denied / not granted |
|---|---|---|
| Worker ambient role | Exact `s3:GetObject` on its bucket's `bootstrap/*` | Explicit `Deny s3:GetObject*` outside that prefix, including other/public buckets; explicit `Deny s3:List*` on its payload bucket. No payload write/delete grant. |
| Trusted coordinator | `PutObject` on manifests and `*/payload.json`, `*/launch.json`; `GetObject`/`DeleteObject` on the two task paths; `ListBucket` on its payload bucket | No task-object version deletion or manifest deletion grant added by this helper. |

The explicit denial outside `bootstrap/*` is essential. An allow-only policy would not authenticate configuration: an attacker-controlled public bucket could grant the worker access to a fake manifest. A successful read with the deployed deny policy establishes its permitted origin; the hash only detects different bytes, not authorship.

The coordinator needs `ListBucket` because S3 returns **403 AccessDenied**, rather than **404 NoSuchKey**, for a missing object when the caller cannot list the bucket. The first launch probes for its saved record. Workers do not get this permission.

AWS documents this in [GetObject permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html). Its [conditional-write guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) specifies that the first completed conditional write wins and later writes receive 412; a concurrent delete can produce 409. The [presigned-URL guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) confirms that temporary credential expiry can end a URL's validity before its requested expiry. These documents were checked during this review; deployed behavior remains a separate gate.

The worker reads the manifest through the attributed `platform_client("s3")` before installing configuration. It then downloads the payload over HTTPS without adding worker credentials. Only the exact bucket/task key on a regional S3 host is accepted; redirects, environment proxies, alternate hosts, credentials in URLs, custom ports, duplicate query parameters and non-HTTPS URLs are rejected. AWS validates the actual signature and expiry; local URL checks are not a cryptographic verifier.

The runtime needs HTTPS/443 and DNS access to the selected S3 region. The live MicroVM probes verified manifest and signed-task downloads through the deployed runtime connector, including a payload over 1 MiB. Other connectors, ECS and remote-tool connectivity still need their own evidence. Build hooks remain AWS-silent; before configuration installation, runtime bootstrap uses manifest-read and payload-download operations, and diagnostics go to stdout.

## Retry, expiry and cleanup

- The coordinator serializes JSON consistently and conditionally creates task objects with `IfNoneMatch: '*'`. A second writer cannot overwrite existing instructions. Read-back handles a write that committed but lost its reply.
- The saved launch record returns the **same URL** after a retry or coordinator restart. Generating a new URL would change the MicroVM Run request while reusing its client token. The private record is deliberately outside TaskTable because the agent can read its own task row.
- A URL is requested for at most **900 seconds**. If the SDK exposes an earlier credential expiry, that shortens the requested lifetime. Initial creation refuses a lifetime under **300 seconds**. AWS can still reject credentials earlier; the provider's actual expiration behavior needs live evidence.
- An expired saved reference fails explicitly; it is not silently re-signed. Recover any existing compute handle before deciding what to do. A timeout or expired ticket does not prove no worker started. MicroVM's saved-start receipt still governs its 120-second application replay window.
- The coordinator refreshes identical manifest bytes at each preparation so the bucket's one-day lifecycle does not remove an old manifest just before a new task reads it. Historical authorized manifests can coexist until lifecycle deletion; this is provenance authentication, not a “latest configuration only” policy.
- Finalization best-effort deletes both `payload.json` and `launch.json`. Deleting the current payload revokes its unversioned download link. Lifecycle deletion remains a backstop and is asynchronous, not an exact one-day alarm.
- ECS removes `AGENT_PAYLOAD_REF` from its environment before importing the pipeline or starting repository subprocesses. Errors redact signed URLs; Python exception chains must not reintroduce them. Control-plane request metadata and the coordinator's private record still contain the capability and require trusted access.

No new KMS key, SSM parameter, table or bootstrap bundle version is needed. Application IAM policies, coordinator code and worker images all change.

For P3, `/resume` must continue the restored task, not re-run bootstrap or reuse its expired launch ticket. The task context/workspace and durable approval records supply the information needed after sleep; credential refresh remains a separate resume barrier.

## Local verification

Tests exercise real producer/consumer code with fake services. The Python tests use real streaming bodies for truncation/closure cases. The MicroVM recovery tests use the shared transport while simulating lost Run replies and coordinator restart.

Coverage includes immutable/replayed/conflicting writes, competing launch preparation, committed writes with lost responses, expiry/short-lived credentials, wrong task/configuration, same-account workspace substitution, public-bucket denial before download, cross-region secret preservation, malformed/oversized bytes, redirect/host rejection, ECS environment removal and both cleanup keys.

A regression reproduced a signed-URL leak through a chained Python traceback. Route logging and sanitized exceptions now prevent that leak. Separate tests cover coordinator-side error redaction and oversized ECS/MicroVM references.

Permission tests inspect synthesized IAM policies, including the `NotResource` explicit deny and the coordinator's missing-object permission. The constants-checker subprocess rejects invalid bounds/paths and consumers that stop importing the contract.

An offline compatibility probe generated a URL using the actual JavaScript AWS SDK with dummy credentials and passed it through the Python URL parser. That proves the observed SDK URL shape is supported; it makes no AWS authorization claim. An offline esbuild check using the coordinator's external-module settings also includes the matching S3 client, presigner and constants in the JavaScript bundle. It excludes the separately packaged `pdf-parse` dependency and does not replace full CDK packaging or deployment verification.

See the [implementation checklist](./645-p3-implementation-plan.md#implementation-progress) for final suite counts. Mock authorization failures are not proof of effective AWS IAM. Conditional S3 writes and the missing-object behavior must also be checked live.

## Coordinated deployment and rollback

1. Record the source commit, existing coordinator version, ECS task definitions, MicroVM image/version and effective application policies. Retain the previous deployable artifacts and inspect the CloudFormation change set. Do not delete/recreate storage as an upgrade mechanism.
2. Pause new admissions and scheduled/queue submissions for both affected backends. Drain existing tasks, approvals and pending/retry launches; reconcile uncertain starts and terminate any live test compute. Do not upgrade beneath a running old coordinator.
3. Build the new ECS image and a MicroVM image from the same source/contract. Validate build hooks without task secrets. Retain the old image definitions for rollback. Building the new image before the switch is safe; starting production tasks against mixed versions is not.
4. With admissions paused, deploy the matching coordinator, image/task-definition references and IAM changes. Wait for all resources and permissions to settle. Old producer + new image and new producer + old image both fail the version contract; old workers with new policies cannot use the former broad S3 fetch.
5. Verify effective policies and image identifiers, then perform the live matrix below in the test deployment. Inspect sanitized logs, cleanup and retry records. Resume admissions only after these gates pass.
6. On failure, keep admissions paused. Drain/terminate new-version workers and reconcile unknown launches. Restore the previous code, images/task definitions and application policies together. Old permissions restore the old security exposure; rollback is an availability recovery, not a security fix. Do not reuse a task ID with a conflicting or expired launch record; inspect it and use a fresh task submission once the old compute is accounted for.

The normal stack already creates distinct payload buckets for the selected backend. Check each backend in its own representative deployment. This runbook does not authorize or perform a deployment.

## Required AWS evidence

For **both ECS and MicroVM**, retain source/image identifiers, relevant policy snippets, sanitized error codes, AWS request IDs and timing. Never retain signed URLs, credentials or downloaded customer prompts in evidence.

**Partial completion, 2026-09-14:** [11 live MicroVM cases](./645-p2-payload-live-20260914.md)
verify own-manifest/download access, task/config/path checks, bad bytes and
signature, URL expiry/revocation, another private bucket's manifest denial,
manifest digest validation and large-file transport. Every passing case also
checks concurrent/repeated producer preparation, changed-input conflict and
immediate identical Run replay. Producer calls use operator credentials;
direct Runs bypass coordinator admission/finalization. The table remains the
full acceptance target, including combinations those probes do not cover.

The [start/recovery follow-up](./645-p2-start-recovery-live-20260914.md) also
verifies real S3 recovery after committed payload/launch replies are lost or a
local process exits between writes. Production start code preserves the saved
capability through a lost Run reply and a fresh process. These use operator
credentials; deployed durable-Lambda recovery and effective-role tests remain.

| Check | Expected result |
|---|---|
| New task with no stored launch | Coordinator gets `NoSuchKey`, creates immutable payload/reference, worker starts successfully. |
| Worker reads own deployment manifest | Allowed; hash/backend/config validation passes. |
| Worker lists its payload bucket | Explicitly denied. |
| Worker reads own or another task's payload/launch with ambient credentials | Explicitly denied, including guessed keys. |
| Worker reads a valid-looking manifest in another deployment/public bucket | Explicitly denied before configuration installation or payload download. |
| Worker puts/deletes a manifest, payload or launch record | Denied by effective policies; no alternate grant should permit mutation. |
| Correct signed URL versus modified task path/signature | Own URL succeeds; modified request fails. |
| Expired URL / expired signer credentials | S3 rejects; no configuration or pipeline starts; diagnostic has no bearer URL. |
| Same-account other-workspace secret substitution | Reject; cross-region secret explicitly present in the trusted manifest still works. |
| Two preparations / lost committed S3 reply | Same saved reference or explicit conflict, no overwrite of task instructions. |
| Lost MicroVM Run reply / coordinator restart | Same client token and exact request; existing VM recovered, no replacement. Record actual AWS retention/conflict behavior. |
| Typical/large registry-hydrated task | Manifest and exact S3 download work over runtime DNS/HTTPS; hook/override limits hold. #818 now has local resolution/hydration/storage and hook-to-loader cases; live tool connectivity remains required. |
| Success, failure, cancellation | Expected terminal status; compute terminated; both private task objects deleted or cleanup failure visibly recorded. |
| Attempted public MicroVM ingress | No usable public control path with explicit `NO_INGRESS`. Test while the VM is running. |
| Environment/log inspection | Repository subprocesses do not inherit `AGENT_PAYLOAD_REF`; normal/error logs contain no signed URL. |

This boundary authenticates the boot path under the deployed policy. It does **not** prove complete isolation from a fully compromised worker: compute roles still select session tags and retain other platform permissions, and a stolen bearer link can be used until it expires or is revoked. See [coordinator metadata verification](./645-coordinator-metadata.md) for the remaining task-reporting and session-tag trust limits.
