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
#   3. Pick a managed base image (ADR-021's Region list applies — Lambda MicroVMs
#      exist in 5 Regions at launch). NOTE the version list comes back NEWEST
#      FIRST, so the latest version is `items[0]`, not `items[-1]`:
#
#        aws lambda-microvms list-managed-microvm-images
#        aws lambda-microvms list-managed-microvm-image-versions \
#          --image-identifier <baseImageArn> \
#          --query 'items[0].imageVersion' --output text
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
# build role, BUILD-time egress connector and log group. Hand the resulting image
# to the orchestrator without CDK owning it (pass the image ARN the script prints
# — `run-microvm` rejects a bare name):
#
#   MISE_EXPERIMENTAL=1 mise //cdk:deploy -- \
#     --context compute_type=lambda-microvm \
#     --context microvm_image_identifier=<imageArn>
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
# !! A P1 IMAGE IS RUNNABLE, BUT NOT SMOKE-VERIFIED !!
# ---------------------------------------------------------------------------
# This script packages and uploads a real artifact, and the image the service
# builds from it will reach ACTIVE, accept a `runHookPayload`, and launch. What
# it does NOT have is any smoke-parity guarantee.
#
# ADR-021 sub-decision 3's hook-phasing table (corrected after the live P1
# verification run) is now:
#
#   /ready, /run                    declared by the CDK construct AND served by
#                                   the agent in P1 (agent/src/server.py).
#                                   /ready is MANDATORY: create-microvm-image
#                                   refuses any lifecycle hook without it, and an
#                                   image with no hooks at all cannot receive a
#                                   runHookPayload — so "declare /run in P1,
#                                   serve it in P2" was never a reachable state.
#   /validate                       P2 (a /validate that 404s fails every build)
#   /terminate                      P2;  /suspend, /resume  P3
#
# Still unverified and owned by P2: AgentCore Memory grants + MEMORY_ID delivery,
# the agent's non-secret env parity inside the snapshot, egress specifics from a
# running MicroVM, and heartbeat/progress behaviour end to end. So clone → change
# → PR on this backend is untested. Keep production repos on
# compute_type=agentcore or ecs until P2 (smoke parity) lands. The Dockerfile is
# copied unmodified deliberately — adapting it to a MicroVM base image is P2 work.
#
# Requires: awscli v2, zip, rsync, python3 (none of which are installed by this script).

set -euo pipefail

# Make a failure impossible to miss even when the caller pipes us through `tee`.
# `foo.sh 2>&1 | tee log` reports tee's status, not ours (the live P1 run recorded
# EXIT=0 for a run that had actually failed at create-microvm-image), so print an
# explicit marker the teed log carries. Callers should ALSO set `set -o pipefail`
# or check `${PIPESTATUS[0]}`.
# shellcheck disable=SC2154 # $? inside the trap string is evaluated at trap time
trap 'rc=$?; [[ $rc -ne 0 ]] && echo "!! package-microvm-artifact.sh FAILED (exit ${rc}) !!" >&2; exit $rc' ERR

STACK_NAME="${STACK_NAME:-backgroundagent-dev}"
CREATE_IMAGE=0
BASE_IMAGE_ARN="${MICROVM_BASE_IMAGE_ARN:-}"
BASE_IMAGE_VERSION="${MICROVM_BASE_IMAGE_VERSION:-}"
IMAGE_NAME="${MICROVM_IMAGE_NAME:-}"
KEEP_STAGE=0

# BASELINE memory sizes the service accepts, and the default. NOT a range: the
# service enumerates the allowed baselines per base image and rejects anything
# else — 32768 (which this script used to send) fails with
#   "The requested memory size of 32768 MiB is not supported by base MicroVM
#    image ...al2023-1. Supported memory sizes in MiB are: [512, 1024, 2048,
#    4096, 8192]."
# This value is where the MicroVM STARTS, not a cap: the service scales a running
# MicroVM vertically to a 32 GiB / 16 vCPU peak on its own, and there is no field
# to request that. So a bigger build does not need a bigger number here.
# Keep in lockstep with MICROVM_SUPPORTED_MEMORY_MIB / DEFAULT_MINIMUM_MEMORY_MIB
# in cdk/src/constructs/lambda-microvm-compute.ts.
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
# BUILD-time connectors (TCP 443 + 80). `agent/Dockerfile` runs `apt-get`, which
# fetches over plain HTTP — with the 443-only RUNTIME connector every snapshot
# build failed ("Could not connect to deb.debian.org:80 … E: Unable to locate
# package curl", exit 100). Fall back to the runtime connectors only so an older
# stack still produces a comprehensible failure rather than an empty flag value.
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

  MISE_EXPERIMENTAL=1 mise //cdk:deploy -- --context compute_type=lambda-microvm
EOF
  exit 1
fi

echo "    artifact bucket : ${ARTIFACT_BUCKET}"
echo "    artifact key    : ${ARTIFACT_KEY}"
echo "    build role      : ${BUILD_ROLE_ARN}"
echo "    egress (runtime): ${EGRESS_CONNECTORS}"
echo "    egress (build)  : ${BUILD_EGRESS_CONNECTORS}"
echo "    log group       : ${LOG_GROUP}"

# The reminder is a FUNCTION, and it is called BEFORE the create call as well as
# after. It used to be a heredoc at the very end, so the one run that most needed
# it — a create-microvm-image that failed validation — printed no banner at all.
print_p1_reminder() {
  cat <<'EOF'

!! REMINDER (ADR-021 P1): a P1 image is runnable but NOT smoke-verified.
   The image IS creatable and launchable and the agent DOES serve /ready + /run,
   so a lambda-microvm task can start and receive its payload. NOT verified:
   AgentCore Memory grants + MEMORY_ID delivery, the agent's non-secret env
   parity inside the snapshot, egress specifics from a running MicroVM, and
   heartbeat/progress behaviour. clone -> change -> PR on this backend is
   untested. Keep production repos on compute_type=agentcore or ecs until P2
   (smoke parity) lands. CDK synth emits the same warning
   (abca:microvm-image-p1-smoke-unverified) on every deploy that configures an image.
EOF
}

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
EOF
  print_p1_reminder
  exit 0
fi

# --- Optional: create the image out of band -----------------------------------
if [[ -z "${BASE_IMAGE_ARN}" || -z "${BASE_IMAGE_VERSION}" ]]; then
  echo "error: --create-image requires --base-image-arn and --base-image-version." >&2
  echo "       Discover them with: aws lambda-microvms list-managed-microvm-images" >&2
  echo "       NOTE: list-managed-microvm-image-versions returns NEWEST FIRST, so the latest" >&2
  echo "             version is items[0].imageVersion — items[-1] picks the OLDEST." >&2
  exit 2
fi

IMAGE_NAME="${IMAGE_NAME:-${STACK_NAME}-abca-agent}"

# Printed BEFORE the create call, so the reminder survives a create that fails
# service-side validation (which is exactly what happened on the first live run).
print_p1_reminder

echo "==> Creating MicroVM image '${IMAGE_NAME}' (${MEMORY_MIB} MiB baseline)"
# Flags use the Lambda MicroVMs service API shape (which differs from the
# CloudFormation shape used by CfnMicrovmImage), all confirmed against the live
# CLI/SDK model on 2026-07-31:
#   * `ARM_64` is the only documented architecture value.
#   * hooks are ENABLED/DISABLED with timeouts, NOT paths.
#   * `/ready` is MANDATORY whenever any lifecycle hook is enabled:
#       "The ready (/ready) MicroVM image hook must be enabled when any MicroVM
#        lifecycle hook (run, resume, suspend, or terminate) is enabled."
#     `/validate` stays disabled — the agent serves no validation endpoint, and a
#     404 there fails every build.
#   * the BUILD connector (443 + 80) is used here, not the runtime one.
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
  --hooks '{"port":8080,"microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":60},"microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":60}}' \
  --tags "abca:compute-backend=lambda-microvm" \
  --output json)"

echo "${CREATE_RESPONSE}"

# Every downstream call needs the image ARN, not the name:
#   list-microvm-image-builds --image-identifier <bare name>
#     -> ValidationException: Invalid ARN format: <name>
# and RunMicrovm likewise rejects a bare name ("Malformed ARN"). Pull the ARN and
# the real version string out of the response instead of telling the operator to
# retype the name.
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

  MISE_EXPERIMENTAL=1 mise //cdk:deploy -- \\
    --context compute_type=lambda-microvm \\
    --context microvm_image_identifier=${IMAGE_ARN:-${IMAGE_NAME}} \\
    --context microvm_image_version=${IMAGE_VERSION:-1.0}

Cleanup, when you are done with an image: delete every version EXCEPT the last
(the last one cannot be deleted individually — "This is the last version. Please
delete the entire image"), then delete the image, which reaps the final version.
Failed builds still create versions that must be reaped.
EOF

print_p1_reminder
