#!/usr/bin/env bash

set -euo pipefail

# A caller's `script 2>&1 | tee log` reports tee's exit status, not this script's.
# shellcheck disable=SC2154 # $? inside the trap string is evaluated at trap time
trap 'rc=$?; [[ $rc -ne 0 ]] && echo "!! package-microvm-artifact.sh FAILED (exit ${rc}) !!" >&2; exit $rc' ERR

STACK_NAME="${STACK_NAME:-backgroundagent-dev}"
CREATE_IMAGE=0
BASE_IMAGE_ARN="${MICROVM_BASE_IMAGE_ARN:-}"
BASE_IMAGE_VERSION="${MICROVM_BASE_IMAGE_VERSION:-}"
IMAGE_NAME="${MICROVM_IMAGE_NAME:-}"
KEEP_STAGE=0

SUPPORTED_MEMORY_MIB="512 1024 2048 4096 8192"
MEMORY_MIB="${MICROVM_MEMORY_MIB:-8192}"

usage() {
  cat <<'USAGE'
Usage: package-microvm-artifact.sh [options]

  --stack-name NAME        ABCA stack to read outputs from (default: backgroundagent-dev,
                           or $STACK_NAME)
  --create-image           After uploading, call `aws lambda-microvms create-microvm-image`
                           using the CDK-created build role / BUILD connector / log group
  --base-image-arn ARN     Managed base image ARN (required with --create-image)
  --base-image-version V   Managed base image version (required with --create-image)
  --image-name NAME        Image name for --create-image (default: <stackName>-abca-agent)
  --memory-mib MIB         BASELINE memory for the image; one of 512 1024 2048 4096 8192
                           (default: 8192 — the largest accepted baseline, or
                           $MICROVM_MEMORY_MIB). The service scales a running MicroVM
                           vertically to a 32 GiB / 16 vCPU peak on its own, so this sets
                           the starting size, not a ceiling.
  --keep-stage             Leave the staging directory in place for inspection
  -h, --help               This message
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    --create-image) CREATE_IMAGE=1; shift ;;
    --base-image-arn) BASE_IMAGE_ARN="$2"; shift 2 ;;
    --base-image-version) BASE_IMAGE_VERSION="$2"; shift 2 ;;
    --image-name) IMAGE_NAME="$2"; shift 2 ;;
    --memory-mib) MEMORY_MIB="$2"; shift 2 ;;
    --keep-stage) KEEP_STAGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case " ${SUPPORTED_MEMORY_MIB} " in
  *" ${MEMORY_MIB} "*) ;;
  *)
    echo "error: --memory-mib ${MEMORY_MIB} is not a baseline Lambda MicroVMs accepts." >&2
    echo "       Supported baselines (MiB): ${SUPPORTED_MEMORY_MIB}" >&2
    echo "       (This is a BASELINE, not a cap - the service bursts to 32 GiB / 16 vCPU.)" >&2
    exit 2
    ;;
esac

for tool in aws python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' is required but not on PATH" >&2; exit 1; }
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REQUIRED_BOOTSTRAP_VERSION="$(tr -d '[:space:]' < "${REPO_ROOT}/cdk/bootstrap/BOOTSTRAP_VERSION")"

echo "==> Reading outputs from stack '${STACK_NAME}'"
STACK_JSON="$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" --output json)"

stack_output() {
  STACK_JSON="${STACK_JSON}" python3 -c '
import json, os, sys
key = sys.argv[1]
stacks = json.loads(os.environ["STACK_JSON"])["Stacks"]
for output in stacks[0].get("Outputs", []):
    if output["OutputKey"] == key:
        print(output["OutputValue"])
        break
' "$1"
}

ARTIFACT_BUCKET="$(stack_output MicrovmArtifactBucketName)"
ARTIFACT_KEY="$(stack_output MicrovmArtifactObjectKey)"
ARTIFACT_BASE_KEY="$(stack_output MicrovmArtifactBaseObjectKey)"
ARTIFACT_BASE_KEY="${ARTIFACT_BASE_KEY:-${ARTIFACT_KEY}}"
BUILD_ROLE_ARN="$(stack_output MicrovmBuildRoleArn)"
EGRESS_CONNECTORS="$(stack_output MicrovmEgressConnectorArns)"
BUILD_EGRESS_CONNECTORS="$(stack_output MicrovmBuildEgressConnectorArns)"
if [[ -z "${BUILD_EGRESS_CONNECTORS}" ]]; then
  BUILD_EGRESS_CONNECTORS="${EGRESS_CONNECTORS}"
  echo "    WARNING: stack has no MicrovmBuildEgressConnectorArns output; falling back to the" >&2
  echo "             443-only runtime connector. apt-get needs port 80 — the snapshot build will" >&2
  echo "             FAIL. Redeploy the stack to create the build-time egress connector." >&2
fi
LOG_GROUP="$(stack_output MicrovmLogGroupName)"

if [[ -z "${ARTIFACT_BUCKET}" || -z "${ARTIFACT_KEY}" ]]; then
  cat >&2 <<EOF
error: stack '${STACK_NAME}' has no MicrovmArtifactBucketName/MicrovmArtifactObjectKey output.

That means this stack was not deployed with the lambda-microvm compute backend.
Deploy it first:

  mise //cdk:deploy -- --context compute_type=lambda-microvm --context microvm_nested_stack=REPLACE_WITH_TRUE_OR_FALSE
EOF
  exit 1
fi

echo "    artifact bucket : ${ARTIFACT_BUCKET}"
echo "    artifact key    : ${ARTIFACT_KEY}"
echo "    build role      : ${BUILD_ROLE_ARN}"
echo "    egress (runtime): ${EGRESS_CONNECTORS}"
echo "    egress (build)  : ${BUILD_EGRESS_CONNECTORS}"
echo "    log group       : ${LOG_GROUP}"

print_p1_reminder() {
  cat <<EOF

REMINDER (ADR-021): verify the deployed image and coordinator together before
   enabling automatic suspension. Managed images declare all six hooks;
   compatible coordinator, IAM and image configuration are required.
   Deployments require bootstrap bundle ${REQUIRED_BOOTSTRAP_VERSION}. Existing flat
   deployments need the staged migration in docs/verification/645-p3-nested-stack.md.
   Acceptance criteria and remaining PR checks: docs/verification/README.md.
   Preserve a compatible published coordinator and explicit image pin for rollback.
   CDK retains warning ID abca:microvm-image-p1-smoke-unverified for compatibility.
EOF
}

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/abca-microvm-artifact.XXXXXX")"
cleanup() {
  if [[ "${KEEP_STAGE}" -eq 0 ]]; then
    rm -rf "${STAGE_DIR}"
  else
    echo "==> Staging directory kept at ${STAGE_DIR}"
  fi
}
trap cleanup EXIT

ARTIFACT_ZIP="${STAGE_DIR}/agent-artifact.zip"
echo "==> Packaging reproducible build inputs to ${ARTIFACT_ZIP}"
ARTIFACT_INFO="$(python3 "${REPO_ROOT}/cdk/scripts/build-microvm-artifact.py" \
  --repo-root "${REPO_ROOT}" --output "${ARTIFACT_ZIP}")"
ARTIFACT_SHA256="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["sha256"])' <<<"${ARTIFACT_INFO}")"
ARTIFACT_CHECKSUM="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["checksum_sha256"])' <<<"${ARTIFACT_INFO}")"
echo "    ${ARTIFACT_INFO}"

if [[ "${CREATE_IMAGE}" -eq 0 ]]; then
  # CloudFormation builds a new image version only when CodeArtifact.Uri changes:
  # overwriting a fixed key signals no update.
  ARTIFACT_KEY="${ARTIFACT_BASE_KEY%.zip}-${ARTIFACT_SHA256}.zip"
else
  ARTIFACT_KEY="${ARTIFACT_BASE_KEY}"
fi
echo "==> Uploading to s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}"
if [[ "${CREATE_IMAGE}" -eq 0 ]]; then
  if aws s3api put-object --bucket "${ARTIFACT_BUCKET}" --key "${ARTIFACT_KEY}" \
    --body "${ARTIFACT_ZIP}" --if-none-match '*' \
    --checksum-algorithm SHA256 --checksum-sha256 "${ARTIFACT_CHECKSUM}" \
    >"${STAGE_DIR}/upload.json" 2>"${STAGE_DIR}/upload.err"; then
    echo "    Created immutable artifact"
  else
    UPLOAD_STATUS=$?
    case "$(cat "${STAGE_DIR}/upload.err")" in
      *"(PreconditionFailed)"*)
        EXISTING_CHECKSUM="$(aws s3api head-object --bucket "${ARTIFACT_BUCKET}" \
          --key "${ARTIFACT_KEY}" --checksum-mode ENABLED \
          --query ChecksumSHA256 --output text)"
        if [[ "${EXISTING_CHECKSUM}" != "${ARTIFACT_CHECKSUM}" ]]; then
          echo "error: existing artifact checksum does not match; refusing to overwrite ${ARTIFACT_KEY}" >&2
          exit 1
        fi
        echo "    Reusing checksum-verified existing artifact"
        ;;
      *)
        cat "${STAGE_DIR}/upload.err" >&2
        exit "${UPLOAD_STATUS}"
        ;;
    esac
  fi
else
  aws s3api put-object --bucket "${ARTIFACT_BUCKET}" --key "${ARTIFACT_KEY}" \
    --body "${ARTIFACT_ZIP}" \
    --checksum-algorithm SHA256 --checksum-sha256 "${ARTIFACT_CHECKSUM}"
fi

if [[ "${CREATE_IMAGE}" -eq 0 ]]; then
  cat <<EOF

==> Artifact uploaded. Next: create (or update) the image.

  CDK-managed (recommended) — redeploy with the base image and artifact pinned.
  Keep this digest with the deployment's context; it identifies these exact ZIP bytes.

  Both layouts require bootstrap policy bundle ${REQUIRED_BOOTSTRAP_VERSION}, the version
  \`mise //cdk:preflight\` checks. Check the installed bundle:

    aws cloudformation describe-stacks --stack-name CDKToolkit \\
      --query 'Stacks[0].Outputs[?OutputKey==\`BootstrapPolicyVersion\`].OutputValue' --output text
    mise //cdk:bootstrap   # ComputeTypes must include lambda-microvm

  An older bundle may deny iam:PassRole for the image's build role. Updating the
  source bundle alone does not update the account's installed policies.

  Existing flat stacks: set --context microvm_nested_stack=false before upgrading
  and retain it until the resource migration is complete. Changing the layout directly
  can replace resources or delete bucket contents. See:
    docs/verification/645-p3-nested-stack.md

  For a new nested deployment (or a completed migration):

    aws lambda-microvms list-managed-microvm-images
    mise //cdk:deploy -- \\
      --context compute_type=lambda-microvm --context microvm_nested_stack=REPLACE_WITH_TRUE_OR_FALSE \\
      --context microvm_base_image_arn=<baseImageArn> \\
      --context microvm_base_image_version=<version> \\
      --context microvm_artifact_sha256=${ARTIFACT_SHA256}

  Out of band — re-run this script with:

    --create-image --base-image-arn <arn> --base-image-version <version>
EOF
  print_p1_reminder
  exit 0
fi

if [[ -z "${BASE_IMAGE_ARN}" || -z "${BASE_IMAGE_VERSION}" ]]; then
  echo "error: --create-image requires --base-image-arn and --base-image-version." >&2
  echo "       Discover them with: aws lambda-microvms list-managed-microvm-images" >&2
  echo "       NOTE: list-managed-microvm-image-versions returns NEWEST FIRST, so the latest" >&2
  echo "             version is items[0].imageVersion — items[-1] picks the OLDEST." >&2
  exit 2
fi

IMAGE_NAME="${IMAGE_NAME:-${STACK_NAME}-abca-agent}"

print_p1_reminder

echo "==> Creating MicroVM image '${IMAGE_NAME}' (${MEMORY_MIB} MiB baseline)"
# CreateMicrovmImage rejects a lifecycle hook (run, resume, suspend, terminate) unless the ready hook is enabled.
CREATE_RESPONSE="$(aws lambda-microvms create-microvm-image \
  --name "${IMAGE_NAME}" \
  --description "ABCA agent snapshot for ${STACK_NAME} (ADR-021, out-of-band build)" \
  --base-image-arn "${BASE_IMAGE_ARN}" \
  --base-image-version "${BASE_IMAGE_VERSION}" \
  --build-role-arn "${BUILD_ROLE_ARN}" \
  --code-artifact "{\"uri\":\"s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}\"}" \
  --cpu-configurations '[{"architecture":"ARM_64"}]' \
  --resources "[{\"minimumMemoryInMiB\":${MEMORY_MIB}}]" \
  --egress-network-connectors "${BUILD_EGRESS_CONNECTORS}" \
  --logging "{\"cloudWatch\":{\"logGroup\":\"${LOG_GROUP}\"}}" \
  --hooks '{"port":8080,"microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":60,"terminate":"ENABLED","terminateTimeoutInSeconds":15,"suspend":"ENABLED","suspendTimeoutInSeconds":30,"resume":"ENABLED","resumeTimeoutInSeconds":30},"microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":300,"validate":"ENABLED","validateTimeoutInSeconds":60}}' \
  --environment-variables '{"ABCA_MICROVM_LIFECYCLE_PROTOCOL":"1"}' \
  --tags "abca:compute-backend=lambda-microvm" \
  --output json)"

echo "${CREATE_RESPONSE}"

IMAGE_ARN="$(CREATE_RESPONSE="${CREATE_RESPONSE}" python3 -c '
import json, os
print(json.loads(os.environ["CREATE_RESPONSE"]).get("imageArn", ""))
')"
IMAGE_VERSION="$(CREATE_RESPONSE="${CREATE_RESPONSE}" python3 -c '
import json, os
print(json.loads(os.environ["CREATE_RESPONSE"]).get("imageVersion", ""))
')"

cat <<EOF

==> Image creation started. Poll the build (snapshot builds take ~6 minutes):

  # NOTE: an ARN is required — a bare image name is rejected with
  #       "ValidationException: Invalid ARN format". The version is "1.0", not "1".
  # NOTE: there are TWO builds per version (one per chipsetGeneration), so inspect
  #       every entry in items[], not just items[0].
  aws lambda-microvms list-microvm-image-builds \\
    --image-identifier ${IMAGE_ARN:-<imageArn from the response above>} \\
    --image-version ${IMAGE_VERSION:-1.0}

  # snapshotBuild sizes live on get-microvm-image-build; get-microvm-image-version
  # returns snapshotBuild: null.
  aws lambda-microvms get-microvm-image-build \\
    --image-identifier ${IMAGE_ARN:-<imageArn>} \\
    --image-version ${IMAGE_VERSION:-1.0} --build-id <buildId>

  aws logs tail ${LOG_GROUP} --since 20m --follow

Once the version reports status ACTIVE, point the orchestrator at it:

  mise //cdk:deploy -- \\
    --context compute_type=lambda-microvm --context microvm_nested_stack=REPLACE_WITH_TRUE_OR_FALSE \\
    --context microvm_image_identifier=${IMAGE_ARN:-${IMAGE_NAME}} \\
    --context microvm_image_version=${IMAGE_VERSION:-1.0}

Cleanup, when you are done with an image: delete every version EXCEPT the last
(the last one cannot be deleted individually — "This is the last version. Please
delete the entire image"), then delete the image, which reaps the final version.
Failed builds still create versions that must be reaped.
EOF

print_p1_reminder
