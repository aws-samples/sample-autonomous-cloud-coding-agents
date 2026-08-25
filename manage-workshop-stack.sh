#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Workshop Studio custom-bootstrap entry point.
# Runs in the privileged CodeBuild project provisioned by WorkshopStack.yaml.

set -euo pipefail

STACK_OPERATION=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
STACK_NAME="${ABCA_STACK_NAME:-backgroundagent-dev}"
BLUEPRINT_REPO="${BLUEPRINT_REPO:-aws-samples/sample-abca-playground}"
PARTICIPANT_USERNAME="${PARTICIPANT_USERNAME:-participant@workshop.local}"
PARTICIPANT_SECRET_NAME="${PARTICIPANT_SECRET_NAME:-abca-workshop/participant-credentials}"
ENABLE_AGENT_REGISTRY="${ENABLE_AGENT_REGISTRY:-false}"

export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"
export BLUEPRINT_REPO
export MISE_EXPERIMENTAL=1

install_toolchain() {
    if [[ ! -x "${HOME}/.local/bin/mise" ]]; then
        curl -fsSL https://mise.run | sh
    fi

    eval "$("${HOME}/.local/bin/mise" activate bash)"
    mise use --global node@22

    corepack enable
    corepack prepare yarn@1.22.22 --activate

    yarn install --frozen-lockfile
}

prepare_arm64_builder() {
    docker info >/dev/null
    if [[ "$(uname -m)" != "aarch64" ]]; then
        docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null
    fi
}

stack_output() {
    local output_key="$1"
    aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='${output_key}'].OutputValue | [0]" \
        --output text
}

read_source_github_token() {
    if [[ -z "${GITHUB_TOKEN_SOURCE_SECRET_ARN:-}" ]]; then
        echo "GITHUB_TOKEN_SOURCE_SECRET_ARN is required" >&2
        return 1
    fi

    local secret_value
    if [[ -n "${GITHUB_TOKEN_BROKER_ROLE_ARN:-}" ]]; then
        local credentials access_key secret_key session_token
        credentials=$(aws sts assume-role \
            --role-arn "$GITHUB_TOKEN_BROKER_ROLE_ARN" \
            --role-session-name abca-workshop-token-seed \
            --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' \
            --output text)
        read -r access_key secret_key session_token <<<"$credentials"

        secret_value=$(
            AWS_ACCESS_KEY_ID="$access_key" \
            AWS_SECRET_ACCESS_KEY="$secret_key" \
            AWS_SESSION_TOKEN="$session_token" \
            aws secretsmanager get-secret-value \
                --secret-id "$GITHUB_TOKEN_SOURCE_SECRET_ARN" \
                --query SecretString \
                --output text
        )
    else
        secret_value=$(aws secretsmanager get-secret-value \
            --secret-id "$GITHUB_TOKEN_SOURCE_SECRET_ARN" \
            --query SecretString \
            --output text)
    fi

    if [[ "$secret_value" == \{* ]]; then
        secret_value=$(jq -r '.token // .github_token // empty' <<<"$secret_value")
    fi

    if [[ -z "$secret_value" || "$secret_value" == "null" ]]; then
        echo "The source GitHub token secret is empty" >&2
        return 1
    fi

    printf '%s' "$secret_value"
}

seed_github_token() {
    local target_secret_arn github_token
    target_secret_arn=$(stack_output GitHubTokenSecretArn)
    github_token=$(read_source_github_token)

    printf '%s' "$github_token" |
        aws secretsmanager put-secret-value \
            --secret-id "$target_secret_arn" \
            --secret-string file:///dev/stdin \
            >/dev/null
}

ensure_participant_secret() {
    local password secret_json

    if aws secretsmanager describe-secret \
        --secret-id "$PARTICIPANT_SECRET_NAME" \
        --region "$REGION" \
        >/dev/null 2>&1; then
        return
    fi

    password="Wksp!$(openssl rand -hex 16)Aa9"
    secret_json=$(jq -cn \
        --arg username "$PARTICIPANT_USERNAME" \
        --arg password "$password" \
        '{username: $username, password: $password}')

    printf '%s' "$secret_json" |
        aws secretsmanager create-secret \
            --name "$PARTICIPANT_SECRET_NAME" \
            --description "ABCA Workshop Studio participant login" \
            --secret-string file:///dev/stdin \
            --region "$REGION" \
            >/dev/null
}

ensure_participant_user() {
    local user_pool_id secret_json username password
    user_pool_id=$(stack_output UserPoolId)
    secret_json=$(aws secretsmanager get-secret-value \
        --secret-id "$PARTICIPANT_SECRET_NAME" \
        --region "$REGION" \
        --query SecretString \
        --output text)
    username=$(jq -r '.username' <<<"$secret_json")
    password=$(jq -r '.password' <<<"$secret_json")

    if ! aws cognito-idp admin-get-user \
        --user-pool-id "$user_pool_id" \
        --username "$username" \
        --region "$REGION" \
        >/dev/null 2>&1; then
        aws cognito-idp admin-create-user \
            --user-pool-id "$user_pool_id" \
            --username "$username" \
            --temporary-password "$password" \
            --message-action SUPPRESS \
            --user-attributes \
                Name=email,Value="$username" \
                Name=email_verified,Value=true \
            --region "$REGION" \
            >/dev/null
    fi

    aws cognito-idp admin-set-user-password \
        --user-pool-id "$user_pool_id" \
        --username "$username" \
        --password "$password" \
        --permanent \
        --region "$REGION" \
        >/dev/null
}

deploy_stack() {
    install_toolchain
    prepare_arm64_builder

    pushd cdk >/dev/null
    npx cdk bootstrap \
        "aws://$(aws sts get-caller-identity --query Account --output text)/${REGION}"
    npx cdk deploy "$STACK_NAME" \
        --require-approval never \
        --context "blueprintRepo=${BLUEPRINT_REPO}" \
        --context "enableAgentRegistry=${ENABLE_AGENT_REGISTRY}"
    popd >/dev/null

    seed_github_token
    ensure_participant_secret
    ensure_participant_user
}

delete_participant_secret() {
    aws secretsmanager delete-secret \
        --secret-id "$PARTICIPANT_SECRET_NAME" \
        --force-delete-without-recovery \
        --region "$REGION" \
        >/dev/null 2>&1 || true
}

delete_bootstrap_stack() {
    local bucket_name repository_name

    bucket_name=$(aws cloudformation describe-stacks \
        --stack-name CDKToolkit \
        --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue | [0]" \
        --output text 2>/dev/null || true)
    repository_name=$(aws cloudformation describe-stacks \
        --stack-name CDKToolkit \
        --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='ContainerAssetsRepositoryName'].OutputValue | [0]" \
        --output text 2>/dev/null || true)

    if [[ -n "$bucket_name" && "$bucket_name" != "None" ]]; then
        aws s3 rm "s3://${bucket_name}" --recursive --region "$REGION" || true
    fi
    if [[ -n "$repository_name" && "$repository_name" != "None" ]]; then
        aws ecr delete-repository \
            --repository-name "$repository_name" \
            --force \
            --region "$REGION" \
            >/dev/null 2>&1 || true
    fi

    if aws cloudformation describe-stacks \
        --stack-name CDKToolkit \
        --region "$REGION" \
        >/dev/null 2>&1; then
        aws cloudformation delete-stack --stack-name CDKToolkit --region "$REGION"
        aws cloudformation wait stack-delete-complete \
            --stack-name CDKToolkit \
            --region "$REGION"
    fi

    if [[ -n "$bucket_name" && "$bucket_name" != "None" ]]; then
        aws s3api delete-bucket --bucket "$bucket_name" --region "$REGION" \
            >/dev/null 2>&1 || true
    fi
}

destroy_stack() {
    install_toolchain

    if aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        >/dev/null 2>&1; then
        pushd cdk >/dev/null
        npx cdk destroy "$STACK_NAME" --force
        popd >/dev/null
    fi

    delete_participant_secret
    delete_bootstrap_stack
}

case "$STACK_OPERATION" in
    create|update)
        deploy_stack
        ;;
    delete)
        destroy_stack
        ;;
    *)
        echo "Invalid stack operation: '$STACK_OPERATION' (expected create|update|delete)" >&2
        exit 1
        ;;
esac
