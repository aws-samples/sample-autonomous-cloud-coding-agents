# Agent Runtime

The agent runtime container for ABCA. Each agent instance clones a GitHub repo, works on a task using Claude, and delivers a result — a new pull request (`new_task`), updates to an existing PR (`pr_iteration`), or structured review comments on a PR (`pr_review`). Runs as a Docker container with two modes:

- **Local mode** — batch execution via `run.sh` with AgentCore-matching constraints (2 vCPU, 8 GB RAM)
- **AgentCore mode** — FastAPI server on port 8080 with `/invocations` and `/ping` endpoints, deployable to AWS Bedrock AgentCore Runtime

The Docker image is built for `linux/arm64` to match AgentCore Runtime requirements.

## Prerequisites

- Docker (with buildx for ARM64 cross-compilation if on x86)
- AWS credentials with Bedrock access (Claude Sonnet)
- GitHub fine-grained Personal Access Token (for local runs), or a GitHub App with AgentCore Token Vault (preferred for production — see [Developer Guide step 4](../docs/guides/DEVELOPER_GUIDE.md))

### GitHub PAT — Minimal Permissions (local runs)

Create a **fine-grained PAT** at GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens. In deployed (AgentCore) mode, the token is resolved by the orchestrator — from Token Vault (preferred) or Secrets Manager. See the [Developer Guide](../docs/guides/DEVELOPER_GUIDE.md) for setup.

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

Common ways to pass credentials into the container (when using `run.sh`):

**Option A** — Environment variables:
```bash
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_SESSION_TOKEN="..."   # if using temporary credentials
export AWS_REGION="us-east-1"
```

**Option B** — AWS CLI resolution (recommended for SSO): `run.sh` runs `aws configure export-credentials` when the AWS CLI is installed, so you can use `aws sso login` and optionally `AWS_PROFILE` without mounting `~/.aws`.

**Option C** — Mount `~/.aws` read-only (static access keys in files; SSO often does not work inside the container):
```bash
export AWS_PROFILE="my-profile"
export AWS_REGION="us-east-1"
```

## Quick Start (Local Mode)

```bash
export GITHUB_TOKEN="ghp_..."
export AWS_REGION="us-east-1"
# Either export keys, or run `aws sso login` (and optionally AWS_PROFILE) and let run.sh resolve credentials
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

The `run.sh` script overrides the container's default CMD to run `python /app/src/entrypoint.py` (batch mode) instead of the uvicorn server.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Local runs | | Fine-grained PAT (see permissions above). In deployed mode, resolved from Token Vault or Secrets Manager by the orchestrator. |
| `AWS_REGION` | Yes | | AWS region for Bedrock (e.g., `us-east-1`) |
| `AWS_ACCESS_KEY_ID` | Conditional† | | Explicit keys, if you are not using CLI-based resolution |
| `AWS_SECRET_ACCESS_KEY` | Conditional† | | Explicit keys, if you are not using CLI-based resolution |
| `AWS_SESSION_TOKEN` | No | | For temporary credentials |
| `AWS_PROFILE` | No | | Profile for `aws configure export-credentials` in `run.sh`, or default profile when using the `~/.aws` mount fallback |
| `ANTHROPIC_MODEL` | No | `us.anthropic.claude-sonnet-4-6` | Bedrock model ID |
| `MAX_TURNS` | No | `100` | Max agent turns before stopping |
| `MAX_BUDGET_USD` | No | | **Local batch only** (shell env when running `entrypoint.py` directly). Range 0.01–100; agent stops when the budget is reached. For deployed AgentCore **server** mode and production tasks, set **`max_budget_usd`** on task creation (REST API, CLI `--max-budget`, or Blueprint default); the orchestrator sends it in the `/invocations` JSON body — server mode does not read `MAX_BUDGET_USD` from the environment. |
| `DRY_RUN` | No | | Set to `1` to validate config and print the prompt without running the agent |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | No | `anthropic.claude-haiku-4-5-20251001-v1:0` | Bedrock model ID for the pre-flight safety check (see below) |

**Pre-flight check model**: Claude Code runs a quick safety verification using a small Haiku model before executing each tool command. On Bedrock, the default Haiku model ID may not be enabled in your account, causing the check to time out with *"Pre-flight check is taking longer than expected"* warnings. The agent sets `ANTHROPIC_DEFAULT_HAIKU_MODEL` to a known-available Bedrock Haiku model ID to avoid this. If you see pre-flight timeout warnings, verify that this model is enabled in your Bedrock model access settings.

† You need valid Bedrock credentials in the container: export keys (Option A), let `run.sh` inject keys from the AWS CLI after `aws sso login` or similar (Option B), or mount `~/.aws` (Option C). `run.sh` also sets `CLAUDE_CODE_USE_BEDROCK=1` so Claude Code uses Bedrock.

### Examples

```bash
# Dry run — validate config, fetch issue, print assembled prompt, then exit
DRY_RUN=1 ./agent/run.sh "owner/repo" 42

# Run with a specific model
ANTHROPIC_MODEL="us.anthropic.claude-sonnet-4-6" ./agent/run.sh "owner/repo" 42

# Limit agent to 50 turns
MAX_TURNS=50 ./agent/run.sh "owner/repo" "Add unit tests for the auth module"

# Local batch only — cap cost (production tasks use API max_budget_usd instead)
MAX_BUDGET_USD=5 ./agent/run.sh "owner/repo" "Small refactor"
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

**`GET /ping`** — Health check. Returns `{"status": "healthy"}` while the last accepted task completed normally (or no task has failed in the background thread). If the background pipeline thread raised after `/invocations` returned, returns **503** with `{"status":"unhealthy","reason":"background_pipeline_failed"}` so a live process is not mistaken for successful work. The task should also be marked **FAILED** in DynamoDB (written from both `pipeline.run_task` and the server thread as a backup). A separate daemon thread writes a DynamoDB heartbeat (`agent_heartbeat_at`) every 45 seconds while a task is running; the orchestrator uses this to detect agent crashes (see [ORCHESTRATOR.md](../docs/design/ORCHESTRATOR.md)). The heartbeat worker is resilient to transient DynamoDB errors — each write is wrapped in try/except so a single failure does not kill the thread.

**`POST /invocations`** — Accept a task and start the agent in a **background thread**. The handler returns **immediately** with an acceptance payload; it does not wait for the agent to finish. While the task runs, progress and the final outcome are written to **DynamoDB** when `TASK_TABLE_NAME` is set (see `task_state.py`); the deployed platform polls that table via the orchestrator. For ad-hoc local testing without DynamoDB, follow **`docker logs -f bgagent-run`** (or your container name).

Request payload (representative fields — the API orchestrator sends a fuller object including hydrated GitHub/issue context):

```json
{
  "input": {
    "task_id": "9e285dba622d",
    "repo_url": "owner/repo",
    "prompt": "update the rfc issue template to add a codeowners field",
    "issue_number": "",
    "max_turns": 100,
    "max_budget_usd": 5.0,
    "model_id": "us.anthropic.claude-sonnet-4-6",
    "aws_region": "us-east-1"
  }
}
```

- `task_id` — Correlates with DynamoDB and logs; if omitted for local experiments, the agent generates a short id.
- `model_id` — Preferred key from the orchestrator; `anthropic_model` is also accepted.
- Optional platform fields (when using the full stack) include `hydrated_context`, `system_prompt_overrides`, `prompt_version`, and `memory_id`.

All fields in `input` fall back to container environment variables when omitted. Secrets like `GITHUB_TOKEN` should be set as runtime environment variables via the CDK stack — not sent in the payload, since AgentCore logs the full request payload in plain text. In production, Token Vault is the preferred credential source: the agent calls `GetWorkloadAccessToken` + `GetResourceOauth2Token` to obtain a short-lived GitHub OAuth token at runtime (see [Developer Guide step 4](../docs/guides/DEVELOPER_GUIDE.md)).

Immediate response (acceptance):

```json
{
  "output": {
    "message": {
      "role": "assistant",
      "content": [{"text": "Task accepted: 9e285dba622d"}]
    },
    "result": {
      "status": "accepted",
      "task_id": "9e285dba622d"
    },
    "timestamp": "2026-02-20T01:00:00.000000+00:00"
  }
}
```

Final metrics (PR URL, cost, turns, build status, etc.) appear in **container logs**, in **DynamoDB** when configured, and in the **REST API** for deployed tasks (`GET /v1/tasks/{task_id}` via the `bgagent` CLI or HTTP client).

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

# Iterate on a PR (address review feedback)
bgagent submit --repo owner/repo --pr 42

# Review a PR (read-only — posts structured review comments)
bgagent submit --repo owner/repo --review-pr 55

# Submit and wait for completion
bgagent submit --repo owner/repo --issue 42 --wait
```

For the full CLI reference, see the [User guide](../docs/guides/USER_GUIDE.md).

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

The agent pipeline (shared by both modes). Behavior varies by task type (`new_task`, `pr_iteration`, `pr_review`):

1. **Config validation** — checks required parameters
2. **Context hydration** — fetches the GitHub issue (title, body, comments) if an issue number is provided; for `pr_iteration` and `pr_review`, fetches PR context (diff, description, review comments)
3. **Prompt assembly** — combines the system prompt (behavioral contract, selected by task type from `prompts/`) with the issue/PR context and task description
4. **Deterministic pre-hooks** — clones repo, creates or checks out branch, configures git auth, runs `mise trust`, `mise install`, `mise run build`, and `mise run lint`
5. **Agent execution** — invokes the Claude Agent SDK via the `ClaudeSDKClient` class (connect/query/receive_response pattern) in unattended mode. The agent:
   - Understands the codebase
   - **`new_task`**: Makes changes, runs tests and linters, commits and pushes after each unit of work, creates a pull request
   - **`pr_iteration`**: Reads review feedback, addresses it with focused changes, commits and pushes, posts a summary comment on the PR
   - **`pr_review`**: Analyzes changes read-only (no `Write` or `Edit` tools available), composes structured review findings, posts a batch review via the GitHub Reviews API
6. **Deterministic post-hooks** — verifies `mise run build` and `mise run lint`, ensures a PR exists (creates one if the agent did not). For `pr_review`, build status is informational only and the commit/push steps are skipped.
7. **Status resolution** — `_resolve_overall_task_status()` maps the agent outcome (success/end_turn/error/unknown) and build gate into a final task status. `agent_status=unknown` (SDK stream ended without a ResultMessage) always fails — success is never inferred from PR or build alone. If a post-hook raises after the agent ran, `_chain_prior_agent_error()` preserves the agent-layer error so it is not masked by the later exception.
8. **Metrics** — returns duration, disk usage, turn count, cost, and PR URL

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
├── Dockerfile           Python 3.13 + Node.js 20 + Claude Code CLI + git + gh + mise (default platform linux/arm64)
├── .dockerignore
├── pyproject.toml       App dependencies (claude-agent-sdk, FastAPI, boto3, OpenTelemetry distro, MCP, cedarpy, …)
├── uv.lock              Locked deps for reproducible `uv sync` in the image
├── mise.toml            Tool versions / tasks used when the target repo relies on mise
├── src/                 Agent source modules (pythonpath configured in pyproject.toml)
│   ├── __init__.py
│   ├── entrypoint.py    Re-export shim for backward compatibility (tests); delegates to specific modules
│   ├── config.py        Configuration: build_config(), get_config(), resolve_github_token(), TaskType validation
│   ├── models.py        Pydantic data models (TaskConfig, RepoSetup, AgentResult, TaskResult, HydratedContext, etc.) and enumerations (TaskType StrEnum)
│   ├── pipeline.py      Top-level pipeline: main() CLI entry, run_task() orchestration, status resolution, error chaining
│   ├── runner.py        Agent runner: run_agent() — ClaudeSDKClient connect/query/receive_response
│   ├── context.py       Context hydration: fetch_github_issue(), assemble_prompt() (local/dry-run only)
│   ├── prompt_builder.py System prompt assembly + memory context, repo config scanning
│   ├── hooks.py         PreToolUse hook callback for Cedar policy enforcement (Claude Agent SDK hooks)
│   ├── policy.py        Cedar policy engine — in-process cedarpy evaluation, fail-closed, deny-list model
│   ├── post_hooks.py    Deterministic post-hooks: ensure_committed, ensure_pushed, ensure_pr, verify_build, verify_lint
│   ├── repo.py          Repository setup: clone, branch, git auth, mise trust/install/build/lint
│   ├── shell.py         Shell utilities: log(), run_cmd(), redact_secrets(), slugify(), truncate()
│   ├── telemetry.py     Metrics, disk usage, trajectory writer (_TrajectoryWriter with write_policy_decision)
│   ├── server.py        FastAPI — async /invocations (background thread), /ping health check, heartbeat daemon; OTEL session correlation
│   ├── task_state.py    Best-effort DynamoDB task status and heartbeat writes (no-op if TASK_TABLE_NAME unset)
│   ├── observability.py OpenTelemetry helpers (e.g. AgentCore session id)
│   ├── memory.py        Optional memory / episode integration for the agent
│   ├── system_prompt.py Behavioral contract (PRD Section 11)
│   └── prompts/         Per-task-type system prompt workflows
│       ├── __init__.py  Prompt registry — assembles base template + workflow for each task type
│       ├── base.py      Shared base template (environment, rules, placeholders)
│       ├── new_task.py  Workflow for new_task (create branch, implement, open PR)
│       ├── pr_iteration.py  Workflow for pr_iteration (read feedback, address, push)
│       └── pr_review.py     Workflow for pr_review (read-only analysis, structured review comments)
├── prepare-commit-msg.sh Git hook (Task-Id / Prompt-Version trailers on commits)
├── run.sh               Build + run helper for local/server mode with AgentCore constraints
├── tests/               pytest unit tests (pythonpath: src/)
│   ├── test_config.py       Config validation and TaskType tests
│   ├── test_hooks.py        PreToolUse hook and hook matcher tests
│   ├── test_models.py       Pydantic model tests (construction, validation, frozen enforcement, model_dump)
│   ├── test_policy.py       Cedar policy engine tests (fail-closed, deny-list)
│   ├── test_pipeline.py     Pipeline tests (cedar_policies injection, _resolve_overall_task_status, _chain_prior_agent_error)
│   ├── test_shell.py        Shell utility tests (slugify, redact_secrets, truncate, format_bytes)
│   └── ...
├── test_sdk_smoke.py    Diagnostic: minimal SDK smoke test (ClaudeSDKClient → CLI → Bedrock)
└── test_subprocess_threading.py  Diagnostic: subprocess-in-background-thread verification
```

The container **CMD** runs the app under `opentelemetry-instrument` with **uvicorn** using the **asyncio** event loop (not uvloop), avoiding known subprocess issues with uvloop.
