#!/usr/bin/env bash

set -euo pipefail

ENDPOINT="http://localhost:8000"
REGION="us-east-1"

DDB_ARGS=(--endpoint-url "$ENDPOINT" --region "$REGION")

echo "Creating local DynamoDB tables..."

if aws dynamodb describe-table --table-name TaskEventsTable "${DDB_ARGS[@]}" >/dev/null 2>&1; then
  echo "  TaskEventsTable already exists — skipping"
else
  aws dynamodb create-table \
    --table-name TaskEventsTable \
    --attribute-definitions \
      AttributeName=task_id,AttributeType=S \
      AttributeName=event_id,AttributeType=S \
    --key-schema \
      AttributeName=task_id,KeyType=HASH \
      AttributeName=event_id,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    "${DDB_ARGS[@]}" >/dev/null
  echo "  TaskEventsTable created"
fi

if aws dynamodb describe-table --table-name TaskTable "${DDB_ARGS[@]}" >/dev/null 2>&1; then
  echo "  TaskTable already exists — skipping"
else
  aws dynamodb create-table \
    --table-name TaskTable \
    --attribute-definitions \
      AttributeName=task_id,AttributeType=S \
    --key-schema \
      AttributeName=task_id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    "${DDB_ARGS[@]}" >/dev/null
  echo "  TaskTable created"
fi

echo "Done. Tables available at $ENDPOINT"
