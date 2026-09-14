# Managed MicroVM image rebuild verification

## Purpose and status

The original managed image referenced `microvm-images/agent-artifact.zip`.
Uploading new bytes to that filename did not change the CloudFormation
template, so an ordinary deployment could leave the old agent image active.

The source fix is implemented and four targeted suites pass 229 tests.
Full-build and live-update results are recorded separately below. This work
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

- [ ] Upload and checksum-verify the immutable artifact in S3.
- [ ] Review a change set preserving image identity and existing infrastructure.
- [ ] Execute the normal update and verify a successful new active image version.
- [ ] Verify repeating the same artifact digest requests no further image change.

Private command output and AWS responses are retained under
`/tmp/abca-645-p2-clean-20260913/image-rebuild-*`.
The [P3 implementation plan](./645-p3-implementation-plan.md) tracks the
remaining failure/recovery, permission/network and sleep/wake work.
