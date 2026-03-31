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

if ! grep -q "^Task-Id:" "$COMMIT_MSG_FILE" 2>/dev/null; then
  # Add a blank line separator before trailers (git convention)
  echo "" >> "$COMMIT_MSG_FILE"
  echo "Task-Id: ${TASK_ID}" >> "$COMMIT_MSG_FILE"
  if [ -n "${PROMPT_VERSION}" ]; then
    echo "Prompt-Version: ${PROMPT_VERSION}" >> "$COMMIT_MSG_FILE"
  fi
fi
