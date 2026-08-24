#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Workshop Studio custom-bootstrap entry point (smoke test).
#
# Per the Workshop Studio cookbook "Bootstrapping new Workshop Studio AWS
# Accounts using a custom bash script", the reusable WorkshopStack.yaml
# CodeBuild project clones this repo at RepoUrl@RepoBranchName and runs:
#
#     ./manage-workshop-stack.sh <create|update|delete>
#
# This is the SIMPLEST possible version: it just creates (and deletes) one
# S3 bucket, to prove the ABCA repo can be bootstrapped end-to-end in the
# workshop environment before we layer in the real deploy.
#
# Template parameters are passed in as environment variables:
#   PARTICIPANT_ROLE_ARN, PARTICIPANT_ASSUMED_ROLE_ARN,
#   ASSETS_BUCKET_NAME, ASSETS_BUCKET_PREFIX, IS_WORKSHOP_STUDIO_ENV

set -uo pipefail

STACK_OPERATION=$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')

# Region CodeBuild runs in (falls back through the usual AWS env vars).
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

# Deterministic, account-scoped bucket name so create is idempotent and delete
# can always find it again. Bucket names must be globally unique + lowercase.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET_NAME="abca-workshop-smoke-${ACCOUNT_ID}-${REGION}"

create_stack() {
    echo "Creating smoke-test bucket: ${BUCKET_NAME} (${REGION})"

    # Already own it? Nothing to do -> keeps create/update idempotent + retryable.
    if aws s3api head-bucket --bucket "${BUCKET_NAME}" 2>/dev/null; then
        echo "Bucket already exists; nothing to do."
        return 0
    fi

    # us-east-1 rejects a LocationConstraint; every other region requires one.
    if [[ "${REGION}" == "us-east-1" ]]; then
        aws s3api create-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
    else
        aws s3api create-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" \
            --create-bucket-configuration LocationConstraint="${REGION}"
    fi

    echo "Created bucket ${BUCKET_NAME}."
}

delete_stack() {
    echo "Deleting smoke-test bucket: ${BUCKET_NAME}"

    if ! aws s3api head-bucket --bucket "${BUCKET_NAME}" 2>/dev/null; then
        echo "Bucket does not exist; nothing to delete."
        return 0
    fi

    # Empty then remove; --force handles a non-empty bucket in one shot.
    aws s3 rb "s3://${BUCKET_NAME}" --force
    echo "Deleted bucket ${BUCKET_NAME}."
}

case "${STACK_OPERATION}" in
    create|update) create_stack ;;
    delete)        delete_stack ;;
    *)
        echo "Invalid stack operation: '${STACK_OPERATION}' (expected create|update|delete)"
        exit 1
        ;;
esac
