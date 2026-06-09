#!/usr/bin/env bash
#
#  MIT No Attribution — Copyright Amazon.com, Inc. or its affiliates.
#
# Orchestration debug helper for Linear parent/sub-issue orchestration
# (issue #247, Mode A). One command to see the full state of an
# orchestration run + the reconciler/processor logs — instead of
# hand-writing DynamoDB scans and `aws logs tail` each time.
#
# Usage:
#   scripts/orchestration-debug.sh                      # list all orchestrations
#   scripts/orchestration-debug.sh <orchestration_id>   # full DAG state for one run
#   scripts/orchestration-debug.sh logs [minutes]       # tail processor + reconciler logs
#
# Env overrides (auto-discovered from the deployed stack if unset):
#   STACK_NAME   (default: backgroundagent-dev)
#   AWS_REGION   (default: us-east-1)
#
set -euo pipefail

STACK_NAME="${STACK_NAME:-backgroundagent-dev}"
REGION="${AWS_REGION:-us-east-1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PP="python3 ${HERE}/orchestration_debug.py"

orch_table() {
  aws dynamodb list-tables --region "$REGION" --output text --query 'TableNames' \
    | tr '\t' '\n' | grep -i "${STACK_NAME}-OrchestrationTable" | head -1
}
processor_log() {
  echo "/aws/lambda/$(aws lambda list-functions --region "$REGION" \
    --query "Functions[?contains(FunctionName,'WebhookProces')].FunctionName" \
    --output text | tr '\t' '\n' | head -1)"
}
reconciler_log() {
  echo "/aws/lambda/$(aws lambda list-functions --region "$REGION" \
    --query "Functions[?contains(FunctionName,'OrchestrationReconciler')].FunctionName" \
    --output text | tr '\t' '\n' | head -1)"
}

CMD="${1:-list}"

if [[ "$CMD" == "logs" ]]; then
  MINUTES="${2:-15}"
  echo "═══ webhook processor (last ${MINUTES}m) ═══"
  aws logs tail "$(processor_log)" --region "$REGION" --since "${MINUTES}m" --format short 2>&1 \
    | grep -iE 'orchestration|seeded|release|reconcil|non-success|response_body|rejected|cycle|error' \
    || echo "  (no orchestration log lines)"
  echo ""
  echo "═══ reconciler (last ${MINUTES}m) ═══"
  aws logs tail "$(reconciler_log)" --region "$REGION" --since "${MINUTES}m" --format short 2>&1 \
    | grep -iE 'orchestration|released|skip|complete|reconcil|non-success|response_body|error' \
    || echo "  (no reconciler log lines — has it fired yet?)"
  exit 0
fi

TABLE="$(orch_table)"
if [[ -z "$TABLE" ]]; then
  echo "OrchestrationTable not found in stack $STACK_NAME ($REGION). Is it deployed?" >&2
  exit 1
fi

if [[ "$CMD" == "list" ]]; then
  echo "═══ all orchestrations in $TABLE ═══"
  aws dynamodb scan --table-name "$TABLE" --region "$REGION" \
    --filter-expression "sub_issue_id = :m" \
    --expression-attribute-values '{":m":{"S":"#meta"}}' \
    --output json 2>&1 | $PP list
  exit 0
fi

echo "═══ orchestration $CMD ═══"
aws dynamodb query --table-name "$TABLE" --region "$REGION" \
  --key-condition-expression "orchestration_id = :o" \
  --expression-attribute-values "{\":o\":{\"S\":\"$CMD\"}}" \
  --output json 2>&1 | $PP rows
