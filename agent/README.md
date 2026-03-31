# Agent Runtime

The agent runtime container for ABCA. Each agent instance clones a GitHub repo, works on a task using Claude, and opens a pull request. Runs as a Docker container with two modes:

- **Local mode** — batch execution via `run.sh` with AgentCore-matching constraints (2 vCPU, 8 GB RAM)
- **AgentCore mode** — FastAPI server on port 8080 with `/invocations` and `/ping` endpoints, deployable to AWS Bedrock AgentCore Runtime

The Docker image is built for `linux/arm64` to match AgentCore Runtime requirements.

## Prerequisites

- Docker (with buildx for ARM64 cross-compilation if on x86)
- AWS credentials with Bedrock access (Claude Sonnet)
- GitHub fine-grained Personal Access Token

### GitHub PAT — Minimal Permissions

Create a **fine-grained PAT** at GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens.

**Repository access**: Select only the specific repo(s) the agent will work on.

| Permission | Access | Reason |
|------------|--------|--------|
| **Contents** | Read and write | `git clone` + `git push` |
| **Pull requests** | Read and write | `gh pr create` |
| **Issues** | Read | Fetch issue title, body, and comments for context |
| **Metadata** | Read | Granted by default |

No other permissions are needed.

### AWS Credentials

The agent uses Amazon Bedrock for Claude inference. You need credentials with `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` permissions.

Two options for passing credentials to the container:

**Option A** — Environment variables:
```bash
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_SESSION_TOKEN="..."   # if using temporary credentials
export AWS_REGION="us-east-1"
```

**Option B** — AWS profile (mounts `~/.aws` read-only):
```bash
export AWS_PROFILE="my-profile"
export AWS_REGION="us-east-1"
```

## Quick Start (Local Mode)

```bash
export GITHUB_TOKEN="ghp_..."
export AWS_REGION="us-east-1"
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."

# Run against a GitHub issue
./agent/run.sh "owner/repo" 42

# Run with a task description (no issue)
./agent/run.sh "owner/repo" "Fix the login validation bug"

# Issue + additional instructions
./agent/run.sh "owner/repo" 42 "Focus on the backend validation only"
```

## Local Mode Usage

```
./agent/run.sh <owner/repo> [issue_or_prompt] [extra_instructions]
```

The second argument is auto-detected:
- If numeric (e.g., `42`), it's treated as a GitHub issue number
- Otherwise, it's treated as a task description

When an issue number is given, the optional third argument provides additional instructions on top of the issue context.

The `run.sh` script overrides the container's default CMD to run `python /app/entrypoint.py` (batch mode) instead of the uvicorn server.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes | | Fine-grained PAT (see permissions above) |
| `AWS_REGION` | Yes | | AWS region for Bedrock (e.g., `us-east-1`) |
| `AWS_ACCESS_KEY_ID` | Yes* | | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | Yes* | | AWS credentials |
| `AWS_SESSION_TOKEN` | No | | For temporary credentials |
| `AWS_PROFILE` | Yes* | | Alternative to explicit keys (mounts `~/.aws`) |
| `ANTHROPIC_MODEL` | No | `us.anthropic.claude-sonnet-4-6` | Bedrock model ID |
| `MAX_TURNS` | No | `100` | Max agent turns before stopping |
| `MAX_BUDGET_USD` | No | | Max cost budget in USD (0.01–100). Agent stops when budget is reached. |
| `DRY_RUN` | No | | Set to `1` to validate config and print the prompt without running the agent |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | No | `anthropic.claude-haiku-4-5-20251001-v1:0` | Bedrock model ID for the pre-flight safety check (see below) |

**Pre-flight check model**: Claude Code runs a quick safety verification using a small Haiku model before executing each tool command. On Bedrock, the default Haiku model ID may not be enabled in your account, causing the check to time out with *"Pre-flight check is taking longer than expected"* warnings. The agent sets `ANTHROPIC_DEFAULT_HAIKU_MODEL` to a known-available Bedrock Haiku model ID to avoid this. If you see pre-flight timeout warnings, verify that this model is enabled in your Bedrock model access settings.

\* Provide either `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or `AWS_PROFILE`.

### Examples

```bash
# Dry run — validate config, fetch issue, print assembled prompt, then exit
DRY_RUN=1 ./agent/run.sh "owner/repo" 42

# Run with a specific model
ANTHROPIC_MODEL="us.anthropic.claude-sonnet-4-6" ./agent/run.sh "owner/repo" 42

# Limit agent to 50 turns
MAX_TURNS=50 ./agent/run.sh "owner/repo" "Add unit tests for the auth module"
```

## AgentCore Runtime Mode

When deployed to AgentCore Runtime (or run without CMD override), the container starts a FastAPI server on port 8080.

### Container Lifecycle and Isolation

The [AgentCore docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html) state that *"each user session receives its own dedicated microVM with isolated compute, memory, and filesystem resources"* and that *"after session completion, the entire microVM is terminated and memory is sanitized."*

To be safe, the agent isolates each task into its own workspace directory:

- **Task isolation via workspace**: Each invocation clones the repo into `/workspace/{task_id}` (a unique directory per task).
- **Idle timeout**: After ~15 minutes of no invocations, the MicroVM is terminated.
- **Disk accumulation**: The 10 GB disk limit may apply across all invocations within the VM's lifetime.

### Endpoints

**`GET /ping`** — Health check. Returns `{"status": "healthy"}`. Stays responsive while the agent runs.

**`POST /invocations`** — Run the agent. Blocks until complete.

Request payload:
```json
{
  "input": {
    "prompt": "update the rfc issue template to add a codeowners field",
    "repo_url": "owner/repo",
    "issue_number": "",
    "max_turns": 100,
    "max_budget_usd": 5.0,
    "anthropic_model": "us.anthropic.claude-sonnet-4-6",
    "aws_region": "us-east-1"
  }
}
```

All fields in `input` fall back to container environment variables if omitted. Secrets like `GITHUB_TOKEN` should be set as runtime environment variables via the CDK stack — not sent in the payload, since AgentCore logs the full request payload in plain text.

Response:
```json
{
  "output": {
    "message": {
      "role": "assistant",
      "content": [{"text": "PR created: https://github.com/owner/repo/pull/3"}]
    },
    "result": {
      "status": "success",
      "pr_url": "https://github.com/owner/repo/pull/3",
      "build_passed": true,
      "cost_usd": 0.3598,
      "turns": 18,
      "duration_s": 126.3,
      "task_id": "9e285dba622d"
    },
    "timestamp": "2026-02-20T01:00:00.000000+00:00"
  }
}
```

### Testing Server Mode Locally

Use `run.sh --server` to build and start the server locally. It handles credentials, port mapping, and resource constraints automatically:

```bash
# Start server (builds image, resolves AWS creds, exposes :8080)
./agent/run.sh --server "owner/repo"

# Health check
curl http://localhost:8080/ping

# Invoke
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"input":{"prompt":"Fix the login bug"}}'
```

The repo URL passed to `run.sh` is set as a container env var, so it can be omitted from the payload. You can also start the server without a repo and pass it per-request:

```bash
./agent/run.sh --server
```

### Invoking via the CLI

Use the `bgagent` CLI to submit tasks to the deployed agent through the REST API. See `cli/` for build instructions.

```bash
# Configure the CLI (one-time setup using stack outputs)
bgagent configure \
  --api-url <ApiUrl> --region us-east-1 \
  --user-pool-id <UserPoolId> --client-id <AppClientId>

# Log in
bgagent login --username user@example.com

# Submit with a task description
bgagent submit --repo owner/repo --task "update the rfc issue template"

# Submit with a GitHub issue
bgagent submit --repo owner/repo --issue 42

# Submit and wait for completion
bgagent submit --repo owner/repo --issue 42 --wait
```

For the full CLI reference, see the [User guide](docs/guides/USER_GUIDE.md).

## Monitoring a Running Agent

The local container runs with a fixed name (`bgagent-run`). Open a second terminal to monitor it:

```bash
# Live agent output (follows logs in real time)
docker logs -f bgagent-run

# CPU, memory, and network usage (updates every second)
docker stats bgagent-run

# Disk usage inside the container (one-off check)
docker exec bgagent-run du -sh /workspace

# Shell into the running container to inspect files
docker exec -it bgagent-run bash
```

The `run.sh` script prints these commands when it starts.

## What It Does

The agent pipeline (shared by both modes):

1. **Config validation** — checks required parameters
2. **Context hydration** — fetches the GitHub issue (title, body, comments) if an issue number is provided
3. **Prompt assembly** — combines the system prompt (behavioral contract) with the issue context and task description
4. **Deterministic pre-hooks** — clones repo, creates branch, configures git auth, runs `mise trust`, `mise install`, and `mise run build`
5. **Agent execution** — invokes the Claude Agent SDK via the `ClaudeSDKClient` class (connect/query/receive_response pattern) in unattended mode. The agent:
   - Understands the codebase
   - Makes changes, runs tests and linters
   - Commits and pushes after each unit of work
   - Creates a pull request with summary, testing notes, and decisions
6. **Deterministic post-hooks** — verifies build (`mise run build`), ensures PR exists (creates one if the agent didn't)
7. **Metrics** — returns duration, disk usage, turn count, cost, and PR URL

## Metrics

After the agent completes, a summary report is printed:

```
============================================================
METRICS REPORT
============================================================
  status                        : success
  agent_status                  : end_turn
  pr_url                        : https://github.com/owner/repo/pull/3
  build_passed                  : True
  cost_usd                      : 0.3598
  turns                         : 34
  duration_s                    : 312.4
  task_id                       : a1b2c3d4e5f6
  disk_before                   : 0.0 B
  disk_after                    : 487.2 MB
  disk_delta                    : 487.2 MB
============================================================
```

These map to AgentCore Runtime constraints:

| Metric | AgentCore Limit |
|--------|-----------------|
| Docker image size | 2 GB |
| Disk usage (clone + deps + build) | 10 GB |
| Memory | 8 GB |
| CPU | 2 vCPU |
| Duration | 8 hours |

## Building Manually

```bash
# Build for ARM64 (AgentCore Runtime target)
docker buildx build --platform linux/arm64 -t bgagent-local --load ./agent

# Check image size
docker images bgagent-local --format "{{.Size}}"
```

## File Structure

```
agent/
├── Dockerfile          Python 3.12 + Node.js 20 + Claude Code CLI + git + gh + mise (ARM64)
├── .dockerignore
├── pyproject.toml      Dependencies: claude-agent-sdk, requests, fastapi, uvicorn (no uvloop)
├── entrypoint.py       Config, context hydration, agent invocation via ClaudeSDKClient, metrics, run_task() entry point
├── server.py           FastAPI app — /invocations and /ping for AgentCore Runtime
├── system_prompt.py    Behavioral contract (PRD Section 11)
├── run.sh              Build + run helper for local/server mode with AgentCore constraints
├── test_sdk_smoke.py   Diagnostic: minimal SDK smoke test (ClaudeSDKClient → CLI → Bedrock)
└── test_subprocess_threading.py  Diagnostic: subprocess-in-background-thread verification
```
