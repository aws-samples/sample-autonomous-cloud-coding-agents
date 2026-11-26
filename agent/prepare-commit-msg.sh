#!/bin/bash

COMMIT_MSG_FILE=$1

if [ -z "${TASK_ID}" ]; then
  echo "[prepare-commit-msg] WARNING: TASK_ID not set, skipping attribution trailers" >&2
  exit 0
fi

# --no-divider keeps a "---" line in the body from being read as the end of the message.
git interpret-trailers --in-place --no-divider --if-exists doNothing \
  --trailer "Task-Id: ${TASK_ID}" \
  ${PROMPT_VERSION:+--trailer "Prompt-Version: ${PROMPT_VERSION}"} \
  ${WORKFLOW_ID:+--trailer "Workflow-Id: ${WORKFLOW_ID}"} \
  ${WORKFLOW_STEP:+--trailer "Workflow-Step: ${WORKFLOW_STEP}"} \
  "$COMMIT_MSG_FILE"
