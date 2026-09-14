# Managed MicroVM image rebuild verification

## Purpose and status

The original managed image referenced `microvm-images/agent-artifact.zip`.
Uploading new bytes to that filename did not change the CloudFormation
template, so an ordinary deployment could leave the old agent image active.

The fix is committed as `e1d5debe`. The full build passed, the normal
CloudFormation update built and activated image version `2.0`, and a repeat
deployment reported no changes. This work
does not complete the remaining P2 acceptance matrix or enable P3 suspension.

## Deployment workflow

1. Run the full root `mise run build` before deployment.
2. Use the intended AWS profile and Region, then run
   `cdk/scripts/package-microvm-artifact.sh --stack-name <stack>`.
   An initial deployment without an image must create the artifact bucket first.
3. The script packages the Dockerfile's local inputs and prints their ZIP's
   SHA-256 digest. It uploads
   `microvm-images/agent-artifact-<digest>.zip`, verifying the checksum with S3.
   Repeating the upload reuses the object only after verifying its checksum.
   It refuses to overwrite an existing object with a different checksum.
4. Synthesize and review the deployment using `compute_type=lambda-microvm`,
   the existing `microvm_base_image_arn` and `microvm_base_image_version`, and
   the printed `microvm_artifact_sha256`. Execute the reviewed change set.
5. Verify both CloudFormation completion and the actual image build/version.
   Retain these context inputs for future deployments, including unrelated
   infrastructure changes. After changing agent source, package again and use
   the newly printed digest.

The digest is a fingerprint of the ZIP bytes. Source file timestamps, checkout
paths and caches do not affect it. Changed runtime inputs change the filename,
which changes `CodeArtifact.Uri` and requests an update to the existing image.
The packaging step remains explicit; CDK does not upload this artifact itself.
Base-image changes can also request a rebuild while using the same artifact.

The build role reads the selected immutable object and the legacy base object
only. The script's explicit `--create-image` mode keeps using the base object
and directly requests an out-of-band build. The new
`MicrovmArtifactBaseObjectKey` output prevents repeated managed packaging from
adding a second digest onto the previous filename. Older stack outputs work
for the first upgrade because their object key is the unsuffixed base.

For an artifact rollback, retain the previous ZIP and deploy its digest after
reviewing the change set. This requests another build; it does not promise that
AWS retains or instantly reactivates a previous image version. Artifact objects
have no automatic expiration. Missing or malformed managed-image digests fail
synthesis with packaging instructions.

## Local verification

- The pre-fix regression reproduced identical image URIs for two artifact
  revisions and acceptance of missing/invalid digests.
- Four targeted suites passed 229 tests: the real shell/Python packagers with
  an isolated fake AWS CLI, construct image/IAM assertions, stack wiring and
  the production CDK-nag path.
- Packaging cases cover byte-for-byte reuse despite changed timestamps/caches,
  a changed runtime source, checksum mismatch, authorization failure,
  symlink rejection, custom base keys and manual image creation. A guard
  compares the packager's input manifest against every local Dockerfile COPY.
- Image assertions keep the logical ID and name stable while changing the URI.
  Build-role reads remain exact object ARNs.
- Shell and Python syntax checks pass.
- Full root build: passed, exit 0 in 897.66 seconds. CDK: 223 suites /
  4,797 tests; CLI: 62 suites / 928 tests; Python: 1,823 tests. Compilation,
  lint, formatting, types, drift checks, the 77-page docs build and links pass.
  Two existing DynamoDB Local suites / 38 cases were skipped because that
  service was not running; this change does not modify the capacity protocol.
  The first full run caught an omitted hook list in the revised warning; the
  final run includes the corrected warning and its passing regression.

## Live verification

Target: existing `backgroundagent-dev`, account `<account-id>`, `us-west-2`,
profile `sphia-dev`, bootstrap policy bundle `1.7.0`.

Before this update, CloudFormation was `UPDATE_COMPLETE`, the managed image
`backgroundagent-dev-abca-agent` had latest active version `1.0`, and all four
listed task MicroVMs were terminated. AWS's resource schema marks only `Name`
as create-only; `CodeArtifact.Uri` supports an in-place update.

- [x] Upload and checksum-verify the immutable artifact in S3.
- [x] Review a change set preserving image identity and existing infrastructure.
- [x] Execute the normal update and verify a successful new active image version.
- [x] Verify repeating the same artifact digest requests no further image change.

The uploaded ZIP contains **106 files / 467,322 bytes**. Every archived file
matches its source bytes; ZIP integrity checks pass. S3 reports the matching
SHA-256 checksum and AES256 encryption. The artifact digest is
`86219317d92fc501b58d21df02dcb298955576c28751703f0753cc655c1c0a21`.

CDK prepared change set `abca-645-image-rebuild-20260914`. AWS reported ten
modifications and no additions/removals: the image URI and build-role policy,
six metadata-only changes, the AgentCore container reference and the existing
`awslabs/agent-plugins` blueprint timestamp refresh. The image has
`Replacement: False`. The blueprint's custom-resource physical ID is stable;
its update refreshes active status/time for that blueprint. No target-repository
verification overrides were restored.

The incidental AgentCore update comes from its existing repository-root asset
fingerprint; `agent/` and `contracts/` source still match the earlier deployed
`29dcaa74`. A textual `GetTemplate` comparison also showed Unicode characters
as question marks, including a layer description, although the original
synthesized template contains Unicode. The actual AWS change set excludes
those apparent description changes and does not replace that layer.

The build-role policy completed its update at **16:08:15 UTC**, before the image
update started at **16:08:17 UTC**. Version `2.0` used the hash-suffixed URI;
`/ready` and `/validate` returned HTTP 200 in its version-specific log streams.
Validation reported zero warnings. The version reached `SUCCESSFUL` / `ACTIVE`,
and the image's `latestActiveImageVersion` became `2.0` under its original ARN:
`arn:aws:lambda:us-west-2:<account-id>:microvm-image:backgroundagent-dev-abca-agent`.
CloudFormation reached `UPDATE_COMPLETE`, retaining **474 root resources**.
No manual IAM changes or image API updates were needed.

Running the packager again against the upgraded stack outputs reused the same
checksum-verified object and printed the same digest. A normal CDK deployment
of the identical reviewed cloud assembly exited 0 with **`(no changes)`** and
zero deployment time. The subsequent version list contains `1.0` and `2.0`;
no `3.0` was created. Fresh synthesis can still refresh the unrelated blueprint
timestamps described above, while unchanged artifact input preserves the image URI.

All four listed task MicroVMs remain terminated. This verification covers image
rebuild and activation; no new coding task was launched. The earlier coding,
iteration and cancellation evidence remains in the
[version 1.0 live task record](./645-p2-live-task-20260914.md).
P3 `/suspend` and `/resume` hooks remain undeclared.

Private command output and AWS responses are retained under
`/tmp/abca-645-p2-clean-20260913/image-rebuild-*`.
The [P3 implementation plan](./645-p3-implementation-plan.md) tracks the
remaining failure/recovery, permission/network and sleep/wake work.
