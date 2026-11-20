#!/bin/bash
# Git prepare-commit-msg hook — appends Task-Id and Prompt-Version trailers
# to every commit message. Installed by the agent entrypoint during setup_repo().
#
# Environment variables (set by entrypoint before hook installation):
#   TASK_ID         — unique task identifier
#   PROMPT_VERSION  — 12-char hex hash of the system prompt

COMMIT_MSG_FILE=$1

# Only add trailers if TASK_ID is set and not already present (idempotent)
if [ -z "${TASK_ID}" ]; then
  echo "[prepare-commit-msg] WARNING: TASK_ID not set, skipping attribution trailers" >&2
  exit 0
fi

# git reads the trailers of a message from its last paragraph only, so these two join
# the block the message ends with (Co-Authored-By stays a trailer) or start one when
# there is none. A trailer the message already has is left alone, and --no-divider
# keeps a "---" line in the body from being read as the end of the message.
git interpret-trailers --in-place --no-divider --if-exists doNothing \
  --trailer "Task-Id: ${TASK_ID}" \
  ${PROMPT_VERSION:+--trailer "Prompt-Version: ${PROMPT_VERSION}"} \
  "$COMMIT_MSG_FILE"
