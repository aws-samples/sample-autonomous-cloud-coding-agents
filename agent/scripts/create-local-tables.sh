#!/usr/bin/env bash
# Create DynamoDB tables in DynamoDB Local for local agent testing.
#
# Prerequisites:
#   docker compose up -d   (starts DynamoDB Local on port 8000)
#   AWS CLI installed
#
# Usage:
#   ./agent/scripts/create-local-tables.sh

set -euo pipefail

ENDPOINT="http://localhost:8000"
REGION="us-east-1"

# Common args for all commands
DDB_ARGS=(--endpoint-url "$ENDPOINT" --region "$REGION" --no-cli-pager)

echo "Creating local DynamoDB tables..."

# ---------------------------------------------------------------------------
# TaskEventsTable — matches cdk/src/constructs/task-events-table.ts
#   PK: task_id (S), SK: event_id (S, ULID)
#   TTL: ttl
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# TaskTable — matches cdk/src/constructs/task-table.ts
#   PK: task_id (S)
#   TTL: ttl
#   GSIs omitted (not needed for local agent testing)
# ---------------------------------------------------------------------------
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
