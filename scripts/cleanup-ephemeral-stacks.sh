#!/usr/bin/env bash
# cleanup-ephemeral-stacks.sh — Delete ephemeral CloudFormation stacks older than MAX_AGE_HOURS.
#
# Usage:
#   AWS_PROFILE=abca ./scripts/cleanup-ephemeral-stacks.sh [--dry-run] [--max-age-hours N] [--prefix PREFIX] [--region REGION]
#
# Options:
#   --dry-run           Show what would be deleted without acting
#   --max-age-hours N   Delete stacks older than N hours (default: 48)
#   --prefix PREFIX     Only target stacks matching this prefix (default: all ABCA stacks)
#   --region REGION     AWS region to operate in (default: $AWS_DEFAULT_REGION or us-east-1)
#
# Safety:
#   - Never touches stacks with termination protection enabled
#   - Only targets stacks whose description starts with "ABCA Development Stack"
#   - Skips stacks in UPDATE_IN_PROGRESS or CREATE_IN_PROGRESS states

set -euo pipefail

MAX_AGE_HOURS=${MAX_AGE_HOURS:-48}
DRY_RUN=false
PREFIX=""
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true; shift ;;
    --max-age-hours)
      [[ $# -ge 2 ]] || { echo "Error: --max-age-hours requires a value" >&2; exit 1; }
      MAX_AGE_HOURS="$2"; shift 2 ;;
    --prefix)
      [[ $# -ge 2 ]] || { echo "Error: --prefix requires a value" >&2; exit 1; }
      PREFIX="$2"; shift 2 ;;
    --region)
      [[ $# -ge 2 ]] || { echo "Error: --region requires a value" >&2; exit 1; }
      REGION="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if ! [[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]]; then
  echo "Error: --max-age-hours must be a non-negative integer (got: '$MAX_AGE_HOURS')" >&2
  exit 1
fi

MAX_AGE_SECONDS=$((MAX_AGE_HOURS * 3600))
NOW=$(date +%s)

CALLER_IDENTITY=$(aws sts get-caller-identity \
  --region "$REGION" \
  --query '[Account,Arn]' --output text 2>/dev/null) || {
  echo "Error: unable to resolve AWS identity (sts:GetCallerIdentity failed). Check credentials." >&2
  exit 1
}
ACCOUNT_ID=$(echo "$CALLER_IDENTITY" | cut -f1)
CALLER_ARN=$(echo "$CALLER_IDENTITY" | cut -f2)

echo "=== Ephemeral Stack Cleanup ==="
echo "  Account:       $ACCOUNT_ID"
echo "  Identity:      $CALLER_ARN"
echo "  Region:        $REGION"
echo "  Max age:       ${MAX_AGE_HOURS}h"
echo "  Dry run:       $DRY_RUN"
echo "  Prefix filter: ${PREFIX:-<none>}"
echo ""

if ! STACKS=$(aws cloudformation list-stacks \
  --region "$REGION" \
  --stack-status-filter \
    CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE \
    UPDATE_ROLLBACK_COMPLETE DELETE_FAILED \
  --query 'StackSummaries[*].[StackName,CreationTime]' \
  --output text); then
  echo "Error: cloudformation:ListStacks failed. Check credentials/permissions/region." >&2
  exit 1
fi

if [[ -z "$STACKS" ]]; then
  echo "No stacks found."
  exit 0
fi

DELETED=0
SKIPPED=0
FAILED=0

while IFS=$'\t' read -r STACK_NAME CREATION_TIME; do
  if [[ -n "$PREFIX" && "$STACK_NAME" != "$PREFIX"* ]]; then
    continue
  fi

  STACK_INFO=$(aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].[Description,EnableTerminationProtection,StackStatus]' \
    --output text 2>/dev/null) || continue

  DESCRIPTION=$(echo "$STACK_INFO" | cut -f1)
  TERMINATION_PROTECTED=$(echo "$STACK_INFO" | cut -f2)
  STATUS=$(echo "$STACK_INFO" | cut -f3)

  if [[ "$DESCRIPTION" != "ABCA Development Stack"* ]]; then
    continue
  fi

  if [[ "$TERMINATION_PROTECTED" == "True" ]]; then
    echo "  SKIP (protected): $STACK_NAME"
    ((SKIPPED++)) || true
    continue
  fi

  if [[ "$STATUS" == *"IN_PROGRESS"* ]]; then
    echo "  SKIP (in progress): $STACK_NAME ($STATUS)"
    ((SKIPPED++)) || true
    continue
  fi

  # CreationTime is UTC (e.g. 2026-06-18T00:23:10.123Z). GNU `date -d` honours the Z natively;
  # BSD `date -j` assumes local time unless given -u.
  CREATED_EPOCH=$(date -d "$CREATION_TIME" +%s 2>/dev/null || date -j -u -f "%Y-%m-%dT%H:%M:%S" "${CREATION_TIME%%.*}" +%s 2>/dev/null || echo "")
  if ! [[ "$CREATED_EPOCH" =~ ^[0-9]+$ ]]; then
    echo "  SKIP (unparseable creation time '$CREATION_TIME'): $STACK_NAME"
    ((SKIPPED++)) || true
    continue
  fi
  AGE_SECONDS=$((NOW - CREATED_EPOCH))

  if [[ $AGE_SECONDS -lt $MAX_AGE_SECONDS ]]; then
    AGE_HOURS=$((AGE_SECONDS / 3600))
    echo "  SKIP (too young: ${AGE_HOURS}h): $STACK_NAME"
    ((SKIPPED++)) || true
    continue
  fi

  AGE_HOURS=$((AGE_SECONDS / 3600))
  echo "  TARGET: $STACK_NAME (age: ${AGE_HOURS}h, status: $STATUS)"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "    [dry-run] Would delete $STACK_NAME"
    ((DELETED++)) || true
    continue
  fi

  # Stuck AgentCore/Lambda Hyperplane ENIs block the VPC deletion.
  SG_IDS=$(aws cloudformation list-stack-resources \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --query "StackResourceSummaries[?ResourceType=='AWS::EC2::SecurityGroup'].PhysicalResourceId" \
    --output text 2>/dev/null) || true

  if [[ -n "$SG_IDS" && "$SG_IDS" != "None" ]]; then
    for SG_ID in $SG_IDS; do
      # shellcheck disable=SC2016  # backticks are JMESPath literal syntax for --query, must NOT expand
      ENIS=$(aws ec2 describe-network-interfaces \
        --region "$REGION" \
        --filters "Name=group-id,Values=$SG_ID" \
        --query 'NetworkInterfaces[?Status==`in-use`].[NetworkInterfaceId,Attachment.AttachmentId]' \
        --output text 2>/dev/null) || true

      if [[ -n "$ENIS" && "$ENIS" != "None" ]]; then
        echo "    Cleaning up ENIs in security group $SG_ID..."
        while IFS=$'\t' read -r ENI_ID ATTACHMENT_ID; do
          if [[ -n "$ENI_ID" && "$ENI_ID" != "None" ]]; then
            echo "      Force-detaching $ENI_ID ($ATTACHMENT_ID)"
            aws ec2 detach-network-interface \
              --region "$REGION" \
              --attachment-id "$ATTACHMENT_ID" \
              --force 2>/dev/null || true
          fi
        done <<< "$ENIS"

        echo "    Waiting 15s for ENI detachment..."
        sleep 15

        AVAILABLE_ENIS=$(aws ec2 describe-network-interfaces \
          --region "$REGION" \
          --filters "Name=group-id,Values=$SG_ID" "Name=status,Values=available" \
          --query 'NetworkInterfaces[*].NetworkInterfaceId' \
          --output text 2>/dev/null) || true

        for ENI_ID in $AVAILABLE_ENIS; do
          if [[ -n "$ENI_ID" && "$ENI_ID" != "None" ]]; then
            echo "      Deleting $ENI_ID"
            aws ec2 delete-network-interface \
              --region "$REGION" \
              --network-interface-id "$ENI_ID" 2>/dev/null || true
          fi
        done
      fi
    done
  fi

  echo "    Deleting stack $STACK_NAME..."
  if aws cloudformation delete-stack \
    --region "$REGION" \
    --stack-name "$STACK_NAME"; then
    ((DELETED++)) || true
  else
    echo "    ERROR: delete-stack failed for $STACK_NAME (continuing)" >&2
    ((FAILED++)) || true
  fi

done <<< "$STACKS"

echo ""
echo "=== Summary ==="
echo "  Deleted: $DELETED"
echo "  Skipped: $SKIPPED"
echo "  Failed:  $FAILED"

if [[ "$DELETED" -gt 0 && "$DRY_RUN" == "false" ]]; then
  echo ""
  echo "Note: Stack deletion is asynchronous. Monitor with:"
  echo "  aws cloudformation list-stacks --stack-status-filter DELETE_IN_PROGRESS --region $REGION"
fi
