#!/usr/bin/env bash
#
# package-microvm-artifact.sh — build and upload the AWS Lambda MicroVMs image
# artifact for the ABCA agent (ADR-021, sub-decision 3).
#
# ---------------------------------------------------------------------------
# WHY THIS SCRIPT EXISTS
# ---------------------------------------------------------------------------
# `AWS::Lambda::MicrovmImage` *is* wired in CDK (see
# `cdk/src/constructs/lambda-microvm-compute.ts`), but CloudFormation cannot
# produce its own `codeArtifact`: the resource consumes a zip that already sits
# in S3, and that zip has to be assembled from the `agent/` tree. Unlike an ECR
# image there is no CDK asset type for "zip + Dockerfile a MicroVM image builds
# from", so packaging + upload is one out-of-band step, run once per agent
# change. Everything else — buckets, roles, connector, log group, the image
# resource itself — is CDK-managed.
#
# ---------------------------------------------------------------------------
# BOOTSTRAP SEQUENCE (first time)
# ---------------------------------------------------------------------------
#   1. Deploy the MicroVM substrate WITHOUT an image. Synth warns that no image
#      is configured; that is expected — the artifact bucket must exist before
#      you can upload to it.
#
#        MISE_EXPERIMENTAL=1 mise //cdk:deploy -- --context compute_type=lambda-microvm
#
#   2. Package + upload the artifact (this script). It reads the bucket name and
#      object key straight from the stack outputs, so there is nothing to copy
#      by hand:
#
#        cdk/scripts/package-microvm-artifact.sh --stack-name backgroundagent-dev
#
#   3. Pick a managed base image (the script prints the candidates; ADR-021's
#      Region list applies — Lambda MicroVMs exist in 5 Regions at launch):
#
#        aws lambda-microvms list-managed-microvm-images
#        aws lambda-microvms list-managed-microvm-image-versions \
#          --image-arn <baseImageArn>
#
#   4. Redeploy with the base image pinned. THIS is the step that creates the
#      image resource and injects MICROVM_IMAGE_IDENTIFIER into the orchestrator:
#
#        MISE_EXPERIMENTAL=1 mise //cdk:deploy -- \
#          --context compute_type=lambda-microvm \
#          --context microvm_base_image_arn=<baseImageArn> \
#          --context microvm_base_image_version=<version>
#
# On subsequent agent changes only step 2 is needed, followed by a CloudFormation
# update of the image resource (the service builds a NEW image version from the
# refreshed artifact).
#
# ---------------------------------------------------------------------------
# THE OUT-OF-BAND ALTERNATIVE (--create-image)
# ---------------------------------------------------------------------------
# Snapshot builds fail for ordinary Dockerfile reasons and take minutes, so
# iterating through CloudFormation is painful. With `--create-image` the script
# calls `aws lambda-microvms create-microvm-image` itself, using the CDK-created
# build role, connector and log group. Hand the resulting image to the
# orchestrator without CDK owning it:
#
#   MISE_EXPERIMENTAL=1 mise //cdk:deploy -- \
#     --context compute_type=lambda-microvm \
#     --context microvm_image_identifier=<name-or-arn>
#
# ---------------------------------------------------------------------------
# WHAT GOES IN THE ZIP
# ---------------------------------------------------------------------------
# The service builds the zip's `Dockerfile` with the zip root as build context,
# so the layout must mirror the paths `agent/Dockerfile` COPYs from — which are
# repo-root-relative (`COPY agent/src/ …`, `COPY contracts/ …`). The staged tree
# is therefore:
#
#   Dockerfile      <- verbatim copy of agent/Dockerfile (MicroVM needs it at the root)
#   agent/          <- minus .venv/, __pycache__, test caches
#   contracts/      <- cross-language constants the agent reads at runtime
#
# ---------------------------------------------------------------------------
# !! A P1 IMAGE IS NOT RUNNABLE END TO END !!
# ---------------------------------------------------------------------------
# This script packages and uploads a real artifact, and the image the service
# builds from it will reach ACTIVE — but the backend does not work yet.
# ADR-021 sub-decision 3's hook-phasing table splits declaring a hook from
# serving it:
#
#   /run                            declared by the CDK construct in P1,
#                                   SERVED by the agent in P2
#   /ready, /validate               declared + served in P2 (build hooks; a
#                                   /validate that 404s fails every build)
#   /terminate                      P2;  /suspend, /resume  P3
#
# So an image built today boots the existing FastAPI server and then does not
# answer /run: a lambda-microvm task will start a MicroVM and fail to progress
# past session start. Keep production repos on compute_type=agentcore or ecs
# until P2 (smoke parity) lands. The Dockerfile is copied unmodified for the same
# reason — adapting it to a MicroVM base image and adding the hook endpoints is
# agent-side P2/P3 work. This script is the packaging half only.
#
# Requires: awscli v2, zip, rsync, python3 (none of which are installed by this script).

set -euo pipefail

STACK_NAME="${STACK_NAME:-backgroundagent-dev}"
CREATE_IMAGE=0
BASE_IMAGE_ARN="${MICROVM_BASE_IMAGE_ARN:-}"
BASE_IMAGE_VERSION="${MICROVM_BASE_IMAGE_VERSION:-}"
IMAGE_NAME="${MICROVM_IMAGE_NAME:-}"
KEEP_STAGE=0

usage() {
  cat <<'USAGE'
Usage: package-microvm-artifact.sh [options]

  --stack-name NAME        ABCA stack to read outputs from (default: backgroundagent-dev,
                           or $STACK_NAME)
  --create-image           After uploading, call `aws lambda-microvms create-microvm-image`
                           using the CDK-created build role / connector / log group
  --base-image-arn ARN     Managed base image ARN (required with --create-image)
  --base-image-version V   Managed base image version (required with --create-image)
  --image-name NAME        Image name for --create-image (default: <stackName>-abca-agent)
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
    --keep-stage) KEEP_STAGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for tool in aws zip python3 rsync; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' is required but not on PATH" >&2; exit 1; }
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --- Stack outputs ------------------------------------------------------------
# One describe-stacks call, then pull each output by key. Failing loudly here
# (rather than uploading to a guessed bucket) is deliberate: a typo'd bucket
# name would silently produce an artifact the build role cannot read, and the
# only symptom would be a failed snapshot build.
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
BUILD_ROLE_ARN="$(stack_output MicrovmBuildRoleArn)"
EGRESS_CONNECTORS="$(stack_output MicrovmEgressConnectorArns)"
LOG_GROUP="$(stack_output MicrovmLogGroupName)"

if [[ -z "${ARTIFACT_BUCKET}" || -z "${ARTIFACT_KEY}" ]]; then
  cat >&2 <<EOF
error: stack '${STACK_NAME}' has no MicrovmArtifactBucketName/MicrovmArtifactObjectKey output.

That means this stack was not deployed with the lambda-microvm compute backend.
Deploy it first:

  MISE_EXPERIMENTAL=1 mise //cdk:deploy -- --context compute_type=lambda-microvm
EOF
  exit 1
fi

echo "    artifact bucket : ${ARTIFACT_BUCKET}"
echo "    artifact key    : ${ARTIFACT_KEY}"
echo "    build role      : ${BUILD_ROLE_ARN}"
echo "    egress connector: ${EGRESS_CONNECTORS}"
echo "    log group       : ${LOG_GROUP}"

# --- Stage + zip --------------------------------------------------------------
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/abca-microvm-artifact.XXXXXX")"
cleanup() {
  if [[ "${KEEP_STAGE}" -eq 0 ]]; then
    rm -rf "${STAGE_DIR}"
  else
    echo "==> Staging directory kept at ${STAGE_DIR}"
  fi
}
trap cleanup EXIT

echo "==> Staging agent tree in ${STAGE_DIR}"
# The MicroVM build context is the zip root, and agent/Dockerfile COPYs
# repo-root-relative paths — so the staged tree mirrors the repo, with the
# Dockerfile additionally promoted to the root where the service looks for it.
cp "${REPO_ROOT}/agent/Dockerfile" "${STAGE_DIR}/Dockerfile"

# Excludes match the build inputs the Dockerfile never COPYs but which dominate
# the zip size: the local virtualenv, Python/pytest caches, and node_modules.
rsync -a \
  --exclude '.venv/' \
  --exclude '__pycache__/' \
  --exclude '.pytest_cache/' \
  --exclude '.ruff_cache/' \
  --exclude '.mypy_cache/' \
  --exclude 'node_modules/' \
  --exclude '*.pyc' \
  "${REPO_ROOT}/agent" "${STAGE_DIR}/"
rsync -a --exclude 'node_modules/' "${REPO_ROOT}/contracts" "${STAGE_DIR}/"

ARTIFACT_ZIP="${STAGE_DIR}.zip"
rm -f "${ARTIFACT_ZIP}"
echo "==> Zipping to ${ARTIFACT_ZIP}"
( cd "${STAGE_DIR}" && zip -q -r "${ARTIFACT_ZIP}" . )
echo "    $(du -h "${ARTIFACT_ZIP}" | cut -f1) artifact"

# --- Upload -------------------------------------------------------------------
echo "==> Uploading to s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}"
aws s3 cp "${ARTIFACT_ZIP}" "s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}"
rm -f "${ARTIFACT_ZIP}"

if [[ "${CREATE_IMAGE}" -eq 0 ]]; then
  cat <<EOF

==> Artifact uploaded. Next: create (or update) the image.

  CDK-managed (recommended) — redeploy with the base image pinned:

    aws lambda-microvms list-managed-microvm-images
    MISE_EXPERIMENTAL=1 mise //cdk:deploy -- \\
      --context compute_type=lambda-microvm \\
      --context microvm_base_image_arn=<baseImageArn> \\
      --context microvm_base_image_version=<version>

  Out of band — re-run this script with:

    --create-image --base-image-arn <arn> --base-image-version <version>

!! REMINDER (ADR-021 P1): the resulting image is NOT runnable end to end. It
   advertises the /run lifecycle hook, which the agent does not serve until P2,
   so a lambda-microvm task will start a MicroVM and then fail to progress past
   session start. Keep production repos on compute_type=agentcore or ecs until
   P2 (smoke parity) lands.
EOF
  exit 0
fi

# --- Optional: create the image out of band -----------------------------------
if [[ -z "${BASE_IMAGE_ARN}" || -z "${BASE_IMAGE_VERSION}" ]]; then
  echo "error: --create-image requires --base-image-arn and --base-image-version." >&2
  echo "       Discover them with: aws lambda-microvms list-managed-microvm-images" >&2
  exit 2
fi

IMAGE_NAME="${IMAGE_NAME:-${STACK_NAME}-abca-agent}"

echo "==> Creating MicroVM image '${IMAGE_NAME}'"
# Flags use the Lambda MicroVMs service API shape (which differs from the
# CloudFormation shape used by CfnMicrovmImage). Notably: ARM_64, the platform
# egress connector (so build-time network egress is subject to the same DNS
# Firewall rules), and ENABLED for the service's fixed `/run` hook on port 8080
# — the only lifecycle hook P1 configures.
aws lambda-microvms create-microvm-image \
  --name "${IMAGE_NAME}" \
  --description "ABCA agent snapshot for ${STACK_NAME} (ADR-021, out-of-band build)" \
  --base-image-arn "${BASE_IMAGE_ARN}" \
  --base-image-version "${BASE_IMAGE_VERSION}" \
  --build-role-arn "${BUILD_ROLE_ARN}" \
  --code-artifact "{\"uri\":\"s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}\"}" \
  --cpu-configurations '[{"architecture":"ARM_64"}]' \
  --resources '[{"minimumMemoryInMiB":32768}]' \
  --egress-network-connectors "${EGRESS_CONNECTORS}" \
  --logging "{\"cloudWatch\":{\"logGroup\":\"${LOG_GROUP}\"}}" \
  --hooks '{"port":8080,"microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":60}}' \
  --tags "abca:compute-backend=lambda-microvm"

cat <<EOF

==> Image creation started. Poll the build (snapshot builds take minutes):

  aws lambda-microvms list-microvm-image-builds --image-identifier ${IMAGE_NAME} --image-version 1
  aws logs tail ${LOG_GROUP} --since 20m --follow

Once the build reports ACTIVE, point the orchestrator at it:

  MISE_EXPERIMENTAL=1 mise //cdk:deploy -- \\
    --context compute_type=lambda-microvm \\
    --context microvm_image_identifier=${IMAGE_NAME}

!! REMINDER (ADR-021 P1): ACTIVE means the snapshot built, NOT that the backend
   works. The image advertises the /run lifecycle hook, which the agent does not
   serve until P2, so a lambda-microvm task will start a MicroVM and then fail to
   progress past session start. Keep production repos on compute_type=agentcore
   or ecs until P2 (smoke parity) lands. CDK synth emits the same warning
   (abca:microvm-image-p1-not-runnable) on every deploy that configures an image.
EOF
