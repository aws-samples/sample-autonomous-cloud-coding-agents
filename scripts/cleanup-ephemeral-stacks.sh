#!/usr/bin/env bash
# cleanup-ephemeral-stacks.sh — Delete ephemeral CloudFormation stacks older than MAX_AGE_HOURS.
#
# Targets stacks deployed by this CDK app that do NOT have termination protection.
# Handles stuck ENI cleanup (AgentCore/Lambda Hyperplane ENIs) before deletion.
#
# Usage:
#   AWS_PROFILE=abca ./scripts/cleanup-ephemeral-stacks.sh [--dry-run] [--max-age-hours N] [--prefix PREFIX]
#
# Options:
#   --dry-run           Show what would be deleted without acting
#   --max-age-hours N   Delete stacks older than N hours (default: 4)
#   --prefix PREFIX     Only target stacks matching this prefix (default: all ABCA stacks)
#   --force-eni         Force-detach ENIs even if stack deletion hasn't started yet
#
# Safety:
#   - Never touches stacks with termination protection enabled
#   - Only targets stacks with description matching "ABCA Development Stack"
#   - Skips stacks in UPDATE_IN_PROGRESS or CREATE_IN_PROGRESS states

set -euo pipefail

MAX_AGE_HOURS=${MAX_AGE_HOURS:-4}
DRY_RUN=false
PREFIX=""
FORCE_ENI=false
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true; shift ;;
    --max-age-hours) MAX_AGE_HOURS="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --force-eni) FORCE_ENI=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

MAX_AGE_SECONDS=$((MAX_AGE_HOURS * 3600))
NOW=$(date +%s)

echo "=== Ephemeral Stack Cleanup ==="
echo "  Region:        $REGION"
echo "  Max age:       ${MAX_AGE_HOURS}h"
echo "  Dry run:       $DRY_RUN"
echo "  Prefix filter: ${PREFIX:-<none>}"
echo ""

# List all stacks (excluding deleted ones)
STACKS=$(aws cloudformation list-stacks \
  --region "$REGION" \
  --stack-status-filter \
    CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE \
    UPDATE_ROLLBACK_COMPLETE DELETE_FAILED \
  --query 'StackSummaries[*].[StackName,CreationTime]' \
  --output text 2>/dev/null)

if [[ -z "$STACKS" ]]; then
  echo "No stacks found."
  exit 0
fi

DELETED=0
SKIPPED=0

while IFS=$'\t' read -r STACK_NAME CREATION_TIME; do
  # Apply prefix filter
  if [[ -n "$PREFIX" && "$STACK_NAME" != "$PREFIX"* ]]; then
    continue
  fi

  # Get stack details (description, termination protection, tags)
  STACK_INFO=$(aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].[Description,EnableTerminationProtection,StackStatus]' \
    --output text 2>/dev/null) || continue

  DESCRIPTION=$(echo "$STACK_INFO" | cut -f1)
  TERMINATION_PROTECTED=$(echo "$STACK_INFO" | cut -f2)
  STATUS=$(echo "$STACK_INFO" | cut -f3)

  # Only target stacks from this CDK app
  if [[ "$DESCRIPTION" != "ABCA Development Stack" ]]; then
    continue
  fi

  # Never touch termination-protected stacks
  if [[ "$TERMINATION_PROTECTED" == "True" ]]; then
    echo "  SKIP (protected): $STACK_NAME"
    ((SKIPPED++)) || true
    continue
  fi

  # Skip stacks in active transitions
  if [[ "$STATUS" == *"IN_PROGRESS"* ]]; then
    echo "  SKIP (in progress): $STACK_NAME ($STATUS)"
    ((SKIPPED++)) || true
    continue
  fi

  # Check age
  CREATED_EPOCH=$(date -d "$CREATION_TIME" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "${CREATION_TIME%%.*}" +%s 2>/dev/null || echo 0)
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

  # --- ENI cleanup (handles stuck VPC deletion) ---
  # Find security groups owned by this stack
  SG_IDS=$(aws cloudformation list-stack-resources \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --query "StackResourceSummaries[?ResourceType=='AWS::EC2::SecurityGroup'].PhysicalResourceId" \
    --output text 2>/dev/null) || true

  if [[ -n "$SG_IDS" && "$SG_IDS" != "None" ]]; then
    for SG_ID in $SG_IDS; do
      # Find ENIs attached to this security group
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

        # Wait briefly for detachment
        echo "    Waiting 15s for ENI detachment..."
        sleep 15

        # Delete the ENIs
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

  # --- Delete the stack ---
  echo "    Deleting stack $STACK_NAME..."
  aws cloudformation delete-stack \
    --region "$REGION" \
    --stack-name "$STACK_NAME" 2>/dev/null

  ((DELETED++)) || true

done <<< "$STACKS"

echo ""
echo "=== Summary ==="
echo "  Deleted: $DELETED"
echo "  Skipped: $SKIPPED"

if [[ "$DELETED" -gt 0 && "$DRY_RUN" == "false" ]]; then
  echo ""
  echo "Note: Stack deletion is asynchronous. Monitor with:"
  echo "  aws cloudformation list-stacks --stack-status-filter DELETE_IN_PROGRESS --region $REGION"
fi
