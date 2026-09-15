# ADR-021: effective AWS metadata and payload permissions

Date: 2026-09-15. These checks complement the
[metadata contract](./645-coordinator-metadata.md),
[payload bootstrap](./645-payload-bootstrap.md), and
[durable lifecycle checks](./645-p3-durable-live-20260915.md).

## Scope

Temporary Lambda functions used the unchanged deployed MicroVM execution role
in `backgroundagent-dev`, `us-west-2`. Its existing trust permits Lambda. Their
code was limited to fixed disposable records and objects. They assumed real
task-tagged STS sessions. No existing role or bucket policy was modified.

This tests actual effective AWS authorization. It does not test the MicroVM
network connector, other backends' ambient roles, or ECS rollout. Compute roles
still choose their session tags; hostile-worker identity binding remains a limit.

## Metadata: 37 checks passed

Two disposable terminal task rows carried protected owner, worker, start-receipt
and reservation fields. No worker or capacity reservation was acquired for them.

| Requests | Observed result |
|---|---|
| Each tagged session reads its own task | Allowed |
| Cross-task reads and reads without a task tag | `AccessDeniedException` |
| Own heartbeat and complete reporting attribute set | Allowed |
| Foreign/missing-task-tag updates | `AccessDeniedException` |
| Owner, TTL, session ID, compute type and compute metadata changes | `AccessDeniedException` |
| Aliased/nested start/reservation updates and removals | `AccessDeniedException` |
| ADD to protected TTL; DELETE from a protected set | `AccessDeniedException` |
| Put, Delete, BatchWrite put/delete and PartiQL insert/update/delete | `AccessDeniedException` |
| Approval Put plus reporting Update transaction | Allowed |
| Forbidden task Update/Put/Delete plus valid approval Put | Entire transaction denied; no approval created |
| Ambient worker task/counter reads and updates | `AccessDeniedException` |
| Scoped task session counter reads and updates | `AccessDeniedException` |

The entire task record was unchanged afterward. False conditions protected
negative single-item writes where supported. Only disposable rows could be
affected if deletion unexpectedly succeeded. These are authorization checks of
request shapes, not a normal approval workflow on the synthetic terminal rows.

Verifier `backgroundagent-dev-p3-iam-20260915` version 2 had ZIP SHA-256
`IzStMi0xeUIUNRQGhvNwrhGy5gs2XFGClArQc4U79f4=`. Version 1 passed a 31-case subset.
All versions, both task rows and the owned approval were removed; cleanup was
verified at 22:20:28.279Z. Existing roles and shared logs were retained.

## S3: 10 checks and public control passed

Three harmless owned markers occupied a bootstrap manifest key, task payload key
and private launch key. They contained no credentials or real task instructions.

| Request | Observed result |
|---|---|
| Ambient worker reads its own bootstrap prefix | Allowed |
| Ambient worker reads payload/private launch or lists payload bucket | `AccessDenied` |
| Ambient worker replaces/deletes manifest | `AccessDenied` |
| Scoped session SDK reads payload, launch or manifest | `AccessDenied` |
| Worker-signed SDK read of a public NOAA object | `AccessDenied` |

From the same Lambda invocation, an anonymous one-byte request to
`https://noaa-goes16.s3.amazonaws.com/index.html` returned HTTP 206, while the
worker-signed request to the same object was denied. No public resources or
public-access settings were created or changed.

The deployed worker policy explicitly denies `s3:GetObject*` outside its own
`bootstrap/*` prefix and denies `s3:List*` on the payload bucket. This public
control uses an existing NOAA object, not a crafted public manifest. Earlier
guest probes separately verified private foreign-manifest rejection.

Version 1 incorrectly required the public error text to name an explicit deny.
AWS provides enhanced reasons mainly for
[same-account/organization requests](https://docs.aws.amazon.com/AmazonS3/latest/userguide/troubleshoot-403-errors.html).
Version 2 pairs same-function anonymous success with signed denial and retains
the deployed policy separately.

Verifier `backgroundagent-dev-p3-s3-20260915` version 2 had ZIP SHA-256
`ZN6YKfbf5XqqYiTQ/3BtdyOYSvBl3LuFNHsP3Tfem8g=`. All versions were deleted and
absence verified at 22:31:12.242Z. The three object bodies remained unchanged.

## Signing credentials expire: passed

A temporary signer role trusts only the operator's existing IAM principal and
can read exactly the harmless owned payload. Its STS session lasts 900 seconds;
the download URL has a nominal 3,600-second lifetime. Initial HTTP 200 returned
the expected body.

The credentials expired at 22:41:22Z. At 22:41:27.332Z, the same URL returned
HTTP 400 `ExpiredToken`, with about 45 minutes of nominal URL lifetime remaining.
S3's response date was 22:41:27Z, request ID `30CHHS5HK249BHPF`. Neither the object
nor the role policy changed during the test. A signed link therefore cannot
outlive the temporary credentials that signed it.

Cleanup was verified at 22:42:55.386Z: all three owned objects were deleted,
the payload prefix was empty, manifest HEAD returned 404, and the temporary
signer role and inline policy were absent. The private mode-0600 URL file was
deleted. No signing keys or URL appear in logs or this record.

## Evidence and remaining gates

Private code, policies, per-operation results, hashes and cleanup ledgers:

- `/tmp/abca-645-p2-clean-20260913/p3-effective-iam-20260915`
- `/tmp/abca-645-p2-clean-20260913/p3-effective-s3-20260915`

Migration/drain, reconciler scale, other ambient roles, runtime network negatives
and coordinated ECS rollout remain separate gates. No credential values appear
in the result documents.
