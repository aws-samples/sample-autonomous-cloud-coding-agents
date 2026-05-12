#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
    cat <<'EOF'
Usage: ./agent/run.sh [--server] [--local-events] <owner/repo> [args...]

Modes:
  (default)   Local batch mode — runs the agent, then exits
  --server    Server mode — starts FastAPI on port 8080 (/invocations + /ping)

Flags:
  --local-events  Connect to DynamoDB Local (port 8000) for progress events.
                  Requires: docker compose up -d && ./agent/scripts/create-local-tables.sh

The second argument (after flags) is auto-detected:
  - If numeric, treated as a GitHub issue number
  - Otherwise, treated as a task description

When an issue number is given, a third argument adds extra instructions.
In server mode, repo/issue/task args are optional (can be sent via /invocations payload).

Environment variables (required):
  GITHUB_TOKEN      GitHub Personal Access Token
  AWS_REGION        AWS region for Bedrock (e.g., us-east-1)

Environment variables (optional):
  ANTHROPIC_MODEL   Model to use (default: us.anthropic.claude-sonnet-4-6)
  DRY_RUN           Set to 1 to validate config and print prompt without running the agent
  MAX_TURNS         Max agent turns (default: 100)

AWS credentials — pick one method:
  Option A: Export AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
  Option B: Mount ~/.aws and set AWS_PROFILE

Examples:
  # Local mode — with issue number
  ./agent/run.sh "myorg/myrepo" 42

  # Local mode — with task description
  ./agent/run.sh "myorg/myrepo" "Add input validation to the login form"

  # Local mode — issue + additional instructions
  ./agent/run.sh "myorg/myrepo" 42 "Focus on the backend validation only"

  # Local mode — dry run (print prompt, don't invoke agent)
  DRY_RUN=1 ./agent/run.sh "myorg/myrepo" 42

  # Local mode with progress events to DynamoDB Local
  ./agent/run.sh --local-events "myorg/myrepo" 42

  # Server mode — start FastAPI, then invoke via curl
  ./agent/run.sh --server "myorg/myrepo"
  curl http://localhost:8080/ping
  curl -X POST http://localhost:8080/invocations \
    -H "Content-Type: application/json" \
    -d '{"input":{"prompt":"Fix the login bug"}}'
EOF
    exit 1
}

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
MODE="local"
LOCAL_EVENTS=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --server)
            MODE="server"
            shift
            ;;
        --local-events)
            LOCAL_EVENTS=true
            shift
            ;;
        --help|-h)
            usage
            ;;
        -*)
            echo "ERROR: Unknown flag: $1" >&2
            usage
            ;;
        *)
            break
            ;;
    esac
done

# In local mode, repo is required. In server mode, it's optional.
if [[ "$MODE" == "local" && $# -lt 1 ]]; then
    usage
fi

REPO_URL="${1:-}"
ISSUE_NUMBER=""
TASK_DESCRIPTION=""

if [[ $# -ge 2 ]]; then
    if [[ "${2}" =~ ^[0-9]+$ ]]; then
        ISSUE_NUMBER="${2}"
        TASK_DESCRIPTION="${3:-}"
    else
        TASK_DESCRIPTION="${2}"
    fi
fi

# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    echo "ERROR: GITHUB_TOKEN is not set" >&2
    exit 1
fi
if [[ -z "${AWS_REGION:-}" ]]; then
    echo "ERROR: AWS_REGION is not set" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Resolve AWS credentials (before Docker build to fail fast)
# ---------------------------------------------------------------------------
# Store resolved credentials in variables so they can be applied to DOCKER_ARGS
# after the image is built. This avoids a lengthy Docker build only to discover
# that AWS credentials are missing or expired.
AWS_CRED_MODE=""
RESOLVED_KEY=""
RESOLVED_SECRET=""
RESOLVED_TOKEN=""

if [[ -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
    AWS_CRED_MODE="explicit"
    RESOLVED_KEY="${AWS_ACCESS_KEY_ID}"
    RESOLVED_SECRET="${AWS_SECRET_ACCESS_KEY}"
    RESOLVED_TOKEN="${AWS_SESSION_TOKEN:-}"
    echo "  AWS:       using explicit credentials (AWS_ACCESS_KEY_ID)"
elif command -v aws &>/dev/null; then
    # Resolve credentials from the AWS CLI (handles SSO, profiles, credential files).
    # This avoids the need to mount ~/.aws and replicate the full credential chain
    # inside the container — SSO tokens in particular don't resolve well there.
    echo "  AWS:       resolving credentials via AWS CLI${AWS_PROFILE:+ (profile '${AWS_PROFILE}')}..."
    EXPORT_CMD=(aws configure export-credentials --format process)
    [[ -n "${AWS_PROFILE:-}" ]] && EXPORT_CMD+=(--profile "${AWS_PROFILE}")

    CREDS_JSON=$("${EXPORT_CMD[@]}" 2>/dev/null) || {
        echo "ERROR: Failed to resolve AWS credentials via AWS CLI." >&2
        echo "  Possible fixes:" >&2
        echo "    - Run 'aws sso login${AWS_PROFILE:+ --profile ${AWS_PROFILE}}' if using SSO" >&2
        echo "    - Run 'aws configure${AWS_PROFILE:+ --profile ${AWS_PROFILE}}' to set up a profile" >&2
        echo "    - Export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY directly" >&2
        exit 1
    }

    AWS_CRED_MODE="resolved"
    RESOLVED_KEY=$(echo "$CREDS_JSON" | python3 -c "import sys,json; c=json.load(sys.stdin); print(c['AccessKeyId'])")
    RESOLVED_SECRET=$(echo "$CREDS_JSON" | python3 -c "import sys,json; c=json.load(sys.stdin); print(c['SecretAccessKey'])")
    RESOLVED_TOKEN=$(echo "$CREDS_JSON" | python3 -c "import sys,json; c=json.load(sys.stdin); print(c.get('SessionToken',''))")
    echo "  AWS:       resolved temporary credentials (AccessKeyId: ${RESOLVED_KEY:0:8}...)"
elif [[ -d "${HOME}/.aws" ]]; then
    AWS_CRED_MODE="mount"
    if [[ -n "${AWS_PROFILE:-}" ]]; then
        echo "  AWS:       mounting ~/.aws with profile '${AWS_PROFILE}' (SSO may not work)"
    else
        echo "  AWS:       mounting ~/.aws (using default profile)"
    fi
else
    echo "WARNING: No AWS credentials detected. Set AWS_ACCESS_KEY_ID or AWS_PROFILE, or ensure ~/.aws exists." >&2
fi

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
echo "Building Docker image..."
docker build --build-arg CACHE_BUST="$(date +%s)" -t bgagent-local "$SCRIPT_DIR"

# Print image size
IMAGE_SIZE=$(docker image inspect bgagent-local --format='{{.Size}}')
IMAGE_SIZE_MB=$((IMAGE_SIZE / 1024 / 1024))
echo "Image size: ${IMAGE_SIZE_MB} MB (limit: 2048 MB)"

if [[ $IMAGE_SIZE_MB -gt 2048 ]]; then
    echo "WARNING: Image exceeds AgentCore 2 GB limit!" >&2
fi

# ---------------------------------------------------------------------------
# Run with AgentCore-matching constraints
# ---------------------------------------------------------------------------

# Remove any leftover container from a previous run
docker rm -f bgagent-run 2>/dev/null || true

CONTAINER_NAME="bgagent-run"

DOCKER_ARGS=(
    --rm
    --name "$CONTAINER_NAME"
    --cpus=2
    --memory=8g
    -e "CLAUDE_CODE_USE_BEDROCK=1"
    -e "AWS_REGION=${AWS_REGION}"
    -e "GITHUB_TOKEN=${GITHUB_TOKEN}"
    -e "ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-us.anthropic.claude-sonnet-4-6}"
)

# Repo URL (may be empty in server mode — sent via payload)
[[ -n "${REPO_URL}" ]] && DOCKER_ARGS+=(-e "REPO_URL=${REPO_URL}")

# Optional env vars
[[ -n "${ISSUE_NUMBER}" ]] && DOCKER_ARGS+=(-e "ISSUE_NUMBER=${ISSUE_NUMBER}")
[[ -n "${TASK_DESCRIPTION}" ]] && DOCKER_ARGS+=(-e "TASK_DESCRIPTION=${TASK_DESCRIPTION}")
[[ -n "${DRY_RUN:-}" ]] && DOCKER_ARGS+=(-e "DRY_RUN=${DRY_RUN}")
[[ -n "${MAX_TURNS:-}" ]] && DOCKER_ARGS+=(-e "MAX_TURNS=${MAX_TURNS}")
[[ -n "${MAX_BUDGET_USD:-}" ]] && DOCKER_ARGS+=(-e "MAX_BUDGET_USD=${MAX_BUDGET_USD}")

# Local events mode: connect to DynamoDB Local via the agent-local network
if [[ "$LOCAL_EVENTS" == true ]]; then
    # Verify DynamoDB Local is running
    if ! docker inspect dynamodb-local >/dev/null 2>&1; then
        echo "ERROR: DynamoDB Local is not running." >&2
        echo "  Start it with: cd agent && docker compose up -d" >&2
        echo "  Create tables: ./agent/scripts/create-local-tables.sh" >&2
        exit 1
    fi
    DOCKER_ARGS+=(
        --network agent-local
        -e "TASK_EVENTS_TABLE_NAME=TaskEventsTable"
        -e "TASK_TABLE_NAME=TaskTable"
        -e "AWS_ENDPOINT_URL_DYNAMODB=http://dynamodb-local:8000"
    )
    echo "  Events:    DynamoDB Local (http://localhost:8000)"
fi

# Server mode: expose port 8080
if [[ "$MODE" == "server" ]]; then
    DOCKER_ARGS+=(-p 8080:8080)
fi

# Apply previously resolved AWS credentials to DOCKER_ARGS
if [[ "$AWS_CRED_MODE" == "explicit" || "$AWS_CRED_MODE" == "resolved" ]]; then
    DOCKER_ARGS+=(
        -e "AWS_ACCESS_KEY_ID=${RESOLVED_KEY}"
        -e "AWS_SECRET_ACCESS_KEY=${RESOLVED_SECRET}"
    )
    [[ -n "${RESOLVED_TOKEN}" ]] && DOCKER_ARGS+=(-e "AWS_SESSION_TOKEN=${RESOLVED_TOKEN}")
elif [[ "$AWS_CRED_MODE" == "mount" ]]; then
    # Fallback: mount ~/.aws directly (works for static credential files, not SSO)
    DOCKER_ARGS+=(-v "${HOME}/.aws:/home/agent/.aws:ro")
    [[ -n "${AWS_PROFILE:-}" ]] && DOCKER_ARGS+=(-e "AWS_PROFILE=${AWS_PROFILE}")
fi

echo ""
echo "Running agent with AgentCore constraints (2 vCPU, 8 GB RAM)..."
echo "  Container: ${CONTAINER_NAME}"
echo "  Mode:      ${MODE}"
[[ -n "${REPO_URL}" ]] && echo "  Repo:      ${REPO_URL}"
[[ -n "${ISSUE_NUMBER}" ]] && echo "  Issue:     #${ISSUE_NUMBER}"
[[ -n "${TASK_DESCRIPTION}" ]] && echo "  Task:      ${TASK_DESCRIPTION}"
echo ""
echo "Monitor in another terminal:"
echo "  docker logs -f ${CONTAINER_NAME}        # live output"
echo "  docker stats ${CONTAINER_NAME}          # CPU, memory, disk I/O"
echo "  docker exec ${CONTAINER_NAME} du -sh /workspace  # disk usage"
if [[ "$LOCAL_EVENTS" == true ]]; then
echo "  mise run local:events                   # query progress events"
fi
echo ""

if [[ "$MODE" == "server" ]]; then
    echo "Server endpoints:"
    echo "  curl http://localhost:8080/ping"
    echo "  curl -X POST http://localhost:8080/invocations -H 'Content-Type: application/json' -d '{\"input\":{...}}'"
    echo ""
    docker run "${DOCKER_ARGS[@]}" bgagent-local
else
    docker run "${DOCKER_ARGS[@]}" bgagent-local python /app/src/entrypoint.py
fi
