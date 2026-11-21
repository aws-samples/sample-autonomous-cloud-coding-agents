#!/bin/bash
# Git prepare-commit-msg hook — appends attribution trailers to every commit
# message: Task-Id, Prompt-Version, Workflow-Id and Workflow-Step. Installed by
# the agent entrypoint during setup_repo().
#
# Environment variables:
#   TASK_ID         — unique task identifier (set by the pipeline before setup_repo())
#   PROMPT_VERSION  — 12-char hex hash of the system prompt (same place)
#   WORKFLOW_ID     — id of the workflow the task runs, e.g. coding/new-task-v1
#   WORKFLOW_STEP   — name of the workflow step that is running, e.g. implement
#                     (both set by the workflow step runner when a step starts)

COMMIT_MSG_FILE=$1

# Only add trailers if TASK_ID is set and not already present (idempotent)
if [ -z "${TASK_ID}" ]; then
  echo "[prepare-commit-msg] WARNING: TASK_ID not set, skipping attribution trailers" >&2
  exit 0
fi

# git reads the trailers of a message from its last paragraph only, so these join
# the block the message ends with (Co-Authored-By stays a trailer) or start one when
# there is none. A trailer the message already has is left alone, and --no-divider
# keeps a "---" line in the body from being read as the end of the message.
git interpret-trailers --in-place --no-divider --if-exists doNothing \
  --trailer "Task-Id: ${TASK_ID}" \
  ${PROMPT_VERSION:+--trailer "Prompt-Version: ${PROMPT_VERSION}"} \
  ${WORKFLOW_ID:+--trailer "Workflow-Id: ${WORKFLOW_ID}"} \
  ${WORKFLOW_STEP:+--trailer "Workflow-Step: ${WORKFLOW_STEP}"} \
  "$COMMIT_MSG_FILE"
