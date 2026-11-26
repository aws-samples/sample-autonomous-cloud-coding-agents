# Agent Runtime

This is the agent runtime container for ABCA. Each agent instance clones a GitHub repo, works on a task using Claude, and delivers a result. The result is a new pull request (`new_task`), updates to an existing PR (`pr_iteration`), or structured review comments on a PR (`pr_review`). The runtime runs as a Docker container in one of two modes:

- **Local mode.** Batch execution via `run.sh` with AgentCore-matching constraints (2 vCPU, 8 GB RAM).
- **AgentCore mode.** FastAPI server on port 8080 with `/invocations` and `/ping` endpoints, deployable to AWS Bedrock AgentCore Runtime.

The Docker image is built for `linux/arm64` to match AgentCore Runtime requirements.

## Prerequisites

- Docker (with buildx for ARM64 cross-compilation if on x86)
- AWS credentials with Bedrock access (Claude Sonnet)
- GitHub fine-grained Personal Access Token

### GitHub PAT — Minimal Permissions

Two token types work. Choose based on your access model:

#### Fine-grained PAT (recommended for repos you own)

Go to GitHub > **Settings** > **Developer settings** > **Fine-grained tokens**.

For **Repository access**, select only the repos that the agent will work on.

| Permission | Access | Reason |
|------------|--------|--------|
| **Contents** | Read and write | `git clone` + `git push` |
| **Pull requests** | Read and write | `gh pr create` |
| **Issues** | Read | Fetch issue title, body, and comments for context |
| **Metadata** | Read | Granted by default |

**Limitation.** Fine-grained PATs can target only repos you own or repos in organizations that have opted in to fine-grained token access. If you are a collaborator on someone else's repo, or on a repo in an org that has not enabled the feature, the repo does not appear in the token creation UI.

#### Classic PAT (required for collaborator/cross-org access)

Use a classic PAT when fine-grained tokens cannot reach the target repository. That is typically the case when you are a collaborator on a repo owned by another user or an organization that has not enabled fine-grained token access.

Go to GitHub > **Settings** > **Developer settings** > **Personal access tokens** > **Tokens (classic)**.

| Scope | Reason |
|-------|--------|
| `public_repo` (public repositories) or `repo` (private repositories) | Clone, push, PRs and issues. `public_repo` reaches public repositories only. `repo` grants every private repository the token's owner can reach, so use it only when a target repository is private |
| `read:org` | Resolve org membership for org-owned repos |

A token acts for its owner. Whatever the scopes, the owner needs write access to the repository (collaborator or team role) for the agent to push.

Set an expiration (90 days recommended) and store the token in Secrets Manager the same way as a fine-grained token.

#### When to use which

| Scenario | Token type |
|----------|-----------|
| Your own repos or your org has fine-grained enabled | Fine-grained |
| Collaborator on another user's repo | Classic |
| Org has not opted in to fine-grained tokens | Classic |
| Targeting repos across multiple orgs | Classic (single token covers all) |

#### Push check before the agent runs

A token can read a repository and still be refused every push. A classic PAT with no scopes, for instance, still reads public repositories. Once the clone's remote and credential helper are set, the agent runs `git push --dry-run` through the same helper the final push uses. When GitHub refuses it, the task fails within seconds instead of at the final push after the agent's work:

| GitHub's answer | Task error |
|-----------------|------------|
| The token may not write | `Token cannot push to <repo>`, naming the token type and the permission to add |
| No credential accepted. The token was revoked or expired after the clone. An invalid one already fails at `preflight_failed` | `BLOCKED[auth_failure]`: replace the token secret |
| The repository is archived | `Repository <repo> is archived on GitHub`: unarchive it or target another repository |
| The organization enforces SAML single sign-on, or an IP allow list | `GitHub organization policy blocks pushes to <repo>`, naming the policy and its fix |
| No answer: GitHub or the network down after retries, or no reply within 120 s | `BLOCKED[dependency_unreachable]`, retryable |

The dry run sends no ref update, so the remote is not changed. It checks write access only. Branch rules and push protection are evaluated on a real push. Tasks that never push skip the check: read-only workflows (`coding/pr-review-v1`) and repository-bound workflows that deliver an artifact instead of a PR.

Setup also makes every push from the clone use the task's token over HTTPS. It pins the push URL to `https://github.com/<owner>/<repo>.git`, which git's `pushInsteadOf` rules do not rewrite, and stops with an error if an `insteadOf` rule in the machine's git configuration still would. It clears the `github.com` credential helpers the clone would inherit (a saved GitHub login, for instance) before adding `gh`. Helpers for other hosts keep working. Tasks whose workflow only looks up an existing pull request (`ensure_pr` with the `resolve` strategy) skip the check, as they never push.

### AWS Credentials

The agent uses Amazon Bedrock for Claude inference. You need credentials with `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` permissions.

Common ways to pass credentials into the container when you use `run.sh`:

**Option A.** Environment variables:
```bash
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_SESSION_TOKEN="..."   # if using temporary credentials
export AWS_REGION="us-east-1"
```

**Option B.** AWS CLI resolution (recommended for SSO). `run.sh` runs `aws configure export-credentials` when AWS CLI v2 is installed, so you can use `aws sso login` and optionally `AWS_PROFILE` without mounting `~/.aws`. AWS CLI v1 has no such command. With v1, `run.sh` mounts `~/.aws` (Option C).

**Option C.** Mount `~/.aws` read-only. This option works with static access keys in files. SSO often does not work inside the container:
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

`run.sh` detects the type of the second argument:
- A numeric argument, such as `42`, is treated as a GitHub issue number.
- Any other argument is treated as a task description.

When an issue number is given, the optional third argument provides additional instructions on top of the issue context.

The `run.sh` script overrides the container's default CMD to run `python /app/src/entrypoint.py` (batch mode) instead of the uvicorn server.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes | | Fine-grained PAT (see permissions above) |
| `AWS_REGION` | Yes | | AWS region for Bedrock (for example `us-east-1`) |
| `AWS_ACCESS_KEY_ID` | Conditional† | | Explicit keys, if you are not using CLI-based resolution |
| `AWS_SECRET_ACCESS_KEY` | Conditional† | | Explicit keys, if you are not using CLI-based resolution |
| `AWS_SESSION_TOKEN` | No | | For temporary credentials |
| `AWS_PROFILE` | No | | Profile for `aws configure export-credentials` in `run.sh`, or default profile when using the `~/.aws` mount fallback |
| `ANTHROPIC_MODEL` | No | `global.anthropic.claude-opus-5-5` | Bedrock **inference profile** ID for `InvokeModel` (see [inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-use.html)). Must be a geo-prefixed profile ID matching the deployment's `bedrockGeoRegion`, not a bare foundation-model ID. See [Model configuration](../docs/guides/DEVELOPER_GUIDE.md#model-configuration) |
| `MAX_TURNS` | No | `100` | Max agent turns before stopping |
| `MAX_BUDGET_USD` | No | | **Local batch only** (shell env when running `entrypoint.py` directly). Range 0.01 to 100. The agent stops when the budget is reached. For deployed AgentCore **server** mode and production tasks, set **`max_budget_usd`** on task creation (REST API, CLI `--max-budget`, or Blueprint default). The orchestrator sends it in the `/invocations` JSON body. Server mode does not read `MAX_BUDGET_USD` from the environment. |
| `DRY_RUN` | No | | Set to `1` to validate config and print the length and hash of the prompts without running the agent |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | No | `global.anthropic.claude-haiku-5-5` | Bedrock **inference profile** ID for the small, fast auxiliary model, used for the pre-flight safety check and WebFetch summarization (see below). Set by the CDK stack (the runtime environment block of `cdk/src/stacks/agent.ts`), which derives the prefix from `bedrockGeoRegion`. A geo prefix is required |
| `NUDGES_TABLE_NAME` | No | | **Phase 2.** DynamoDB table for mid-task user nudges (`<user_nudge>` XML blocks injected between turns). If unset, the agent runs without nudge support. `nudge_reader.read_pending()` returns `[]` and logs a WARN once. Set automatically by the CDK stack on every compute backend: in the AgentCore runtime environment, in the ECS task definitions, and for a Lambda MicroVM through `platform_config`. |
| `JIRA_APP_ACTOR_PROXY_URL` | No | | Resolved per-task from the Jira tenant secret. Forge v2 web-trigger URL used for app-authored Jira comments and transitions. |
| `JIRA_APP_ACTOR_SHARED_SECRET` | No | | Resolved per-task from the Jira tenant secret. HMAC key for the Forge proxy. Redacted from agent diagnostics. |
| `JIRA_API_TOKEN` | No | | Legacy per-task Jira 3LO token. Used for outbound writes only when no app actor is configured. |

`run_task` removes all Jira credential variables before every invocation,
including non-Jira tasks, so a warm AgentCore process cannot expose one
tenant's OAuth or Forge credential to the next task. When it returns or
raises, it puts the environment of the process back as it found it, so a
credential that the task resolved (a Linear token, the Jira variables above)
is no longer in that environment.

**Bedrock model access (main model).** Configuring `ANTHROPIC_MODEL` and IAM credentials is not enough. Your AWS account must be able to **invoke** that model in Amazon Bedrock. Follow [Request access to models](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html): Marketplace permissions on first use, Anthropic first-time use where required, and a valid payment method for Marketplace-backed models. Always use an inference profile ID such as `global.anthropic.claude-opus-5-5`. A bare foundation-model ID cannot be invoked with on-demand throughput, and Bedrock rejects it with `ValidationException`. IAM must also grant the model. See [Model configuration](../docs/guides/DEVELOPER_GUIDE.md#model-configuration) for the full layering. If the CLI stops with a message that the model is not available on your Bedrock deployment, fix model access in the console or switch `ANTHROPIC_MODEL` to an entitled profile, then retry.

**Pre-flight check model.** Before it executes each tool command, Claude Code runs a safety verification with a small Haiku model. On Bedrock, the default Haiku model ID may not be enabled in your account. The check then times out with *"Pre-flight check is taking longer than expected"* warnings. To avoid the timeout, the agent sets `ANTHROPIC_DEFAULT_HAIKU_MODEL` to a known-available Bedrock Haiku model ID. If you see pre-flight timeout warnings, verify that this model is enabled in your Bedrock model access settings.

† You need valid Bedrock credentials in the container: export keys (Option A), let `run.sh` inject keys from the AWS CLI after `aws sso login` or similar (Option B), or mount `~/.aws` (Option C). `run.sh` also sets `CLAUDE_CODE_USE_BEDROCK=1` so Claude Code uses Bedrock.

### Examples

```bash
# Dry run — validate config, fetch issue, print the length and hash of the prompts, then exit
DRY_RUN=1 ./agent/run.sh "owner/repo" 42

# Run with a specific model (overrides the global.anthropic.claude-opus-5-5 default).
# Must be a geo-prefixed inference profile that IAM grants — see Model configuration.
ANTHROPIC_MODEL="us.anthropic.claude-sonnet-4-6" ./agent/run.sh "owner/repo" 42

# Limit agent to 50 turns
MAX_TURNS=50 ./agent/run.sh "owner/repo" "Add unit tests for the auth module"

# Local batch only — cap cost (production tasks use API max_budget_usd instead)
MAX_BUDGET_USD=5 ./agent/run.sh "owner/repo" "Small refactor"
```

## AgentCore Runtime Mode

When the container is deployed to AgentCore Runtime, or run without a CMD override, it starts a FastAPI server on port 8080.

### Container Lifecycle and Isolation

The [AgentCore docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html) state that *"each user session receives its own dedicated microVM with isolated compute, memory, and filesystem resources"* and that *"after session completion, the entire microVM is terminated and memory is sanitized."*

To be safe, the agent isolates each task into its own workspace directory:

- **Task isolation via workspace.** Each invocation clones the repo into `/workspace/{task_id}`, a unique directory per task.
- **Idle timeout.** After about 15 minutes of no invocations, the MicroVM is terminated.
- **Disk accumulation.** The 10 GB disk limit may apply across all invocations within the VM's lifetime.

### Endpoints

**`GET /ping`.** Health check. It returns `{"status": "healthy"}` while the last accepted task completed normally, or while no task has failed in the background thread. If the background pipeline thread raised after `/invocations` returned, it returns **503** with `{"status":"unhealthy","reason":"background_pipeline_failed"}`, so that a live process is not mistaken for successful work. The task should also be marked **FAILED** in DynamoDB. That status is written from both `pipeline.run_task` and the server thread as a backup. A separate daemon thread writes a DynamoDB heartbeat (`agent_heartbeat_at`) every 45 seconds while a task is running. The orchestrator uses the heartbeat to detect agent crashes (see [ORCHESTRATOR.md](../docs/design/ORCHESTRATOR.md)). The heartbeat worker survives transient DynamoDB errors. Each write is wrapped in try/except, so a single failure does not stop the thread.

**`POST /invocations`.** Accepts a task and starts the agent in a **background thread**. The handler returns **immediately** with an acceptance payload. It does not wait for the agent to finish. While the task runs, progress and the final outcome are written to DynamoDB when `TASK_TABLE_NAME` is set (see `task_state.py`). The deployed platform polls that table via the orchestrator. For ad-hoc local testing without DynamoDB, follow **`docker logs -f bgagent-run`** (or your container name).

Request payload, with representative fields. The API orchestrator sends a fuller object that includes hydrated GitHub and issue context:

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

- `task_id` correlates with DynamoDB and logs. If it is omitted for local experiments, the agent generates a short id.
- `model_id` is the preferred key from the orchestrator. `anthropic_model` is also accepted.
- Optional platform fields (when using the full stack) include `hydrated_context`, `system_prompt_overrides`, `prompt_version`, and `memory_id`.

All fields in `input` fall back to container environment variables when omitted. Set secrets such as `GITHUB_TOKEN` as runtime environment variables via the CDK stack. Do not send them in the payload, because AgentCore logs the full request payload in plain text.

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

Final metrics, such as PR URL, cost, turns, and build status, appear in the container logs, in DynamoDB when configured, and in the REST API for deployed tasks (`GET /v1/tasks/{task_id}` via the `bgagent` CLI or an HTTP client).

### AWS Lambda MicroVMs lifecycle hooks (ADR-021 P1 + P2)

The same uvicorn process also serves the **Lambda MicroVMs** lifecycle hooks, on the same port, 8080, which the image's `hooks.port` declares. On that backend there is no `InvokeAgentRuntime` and no HTTP path from the orchestrator to the agent at all. The task payload arrives as the `/run` hook body, and nothing else connects to the agent.

**`POST /aws/lambda-microvms/runtime/v1/ready`.** Build hook. The hook is **mandatory**, not optional. `CreateMicrovmImage` refuses an image that enables *any* lifecycle hook without `/ready`. With the hook enabled but unserved, every build fails with `Ready hook check failed: the application returned a client error (HTTP 4xx) response`.

Its 200 is the signal the service waits for before **taking the snapshot**. `/ready` is therefore the only hook that can put a warm page in that snapshot, so it does two things:

1. It reports that uvicorn is bound and that `server` imported cleanly. The import pulls in `pipeline`, then `runner`, then the policy engine, so a missing policy file fails the *build* rather than the first task.
2. It **warms the heavyweight binaries** by running `claude --version` (required), plus `git` and `node` on a best-effort basis.

That warm-up exists because of a live defect (ADR-021 P2-F5). `claude` is a **225 MiB statically-linked ELF**. On a MicroVM restored from a snapshot that never touched the binary, the first `exec` had to fault every page in from lazily-restored storage. `runner.py`'s version probe timed out at 10 s and **every task failed at turn 0**, reproducibly, while the same binary in the same image answers in under a second locally. If a *required* warm-up fails, `/ready` returns **503**, the hook contract's "not ready yet". The service then keeps asking within the `/ready` budget and, failing that, fails the image build. That is the right trade, because a snapshot that cannot exec `claude` cannot run one task. The `/ready` hook budget is 300 s for the same reason (`READY_HOOK_TIMEOUT_SECONDS` in `cdk/src/constructs/lambda-microvm-compute.ts`). Build hooks are allowed up to 3600 s. Budgets are composed, not stacked. `claude` runs **first** with its own 120 s. The best-effort commands then **share** what is left of a 240 s total ceiling, and are skipped once the remainder is too small to warm anything. The whole warm-up therefore stays inside the hook budget, and a hung `git` or `node` can never hold up a 200 that the required warm-up has already earned. All three numbers are in `contracts/constants.json` under `microvm_hook_budgets`, which this server *and* the CDK construct read, because neither side can enforce the relationship `warmup_required < warmup_total < ready_hook` alone. `scripts/check-constants-sync.ts` asserts the ordering and bans a literal re-declaration on either side. A `--version` exec is not an AWS call and touches no network, so the hook stays AWS-silent (below).

The warm-up is the *primary* fix. The probe that failed is also now non-fatal. `runner.py`'s `_log_claude_cli_version` keeps its loosened 60 s bound and also downgrades every `subprocess.SubprocessError` or `OSError` to a `WARN`. A diagnostic whose entire output is a log line must not be able to end a task at turn 0, however it fails.

**`POST /aws/lambda-microvms/runtime/v1/validate`.** Build hook (P2). It is a **shallow self-check only**: server alive, every hook route registered, interpreter floor, `platform_config` contract loaded. It returns 200 with the individual check results, or 503 while still initialising. A 503 that never clears fails the build, which is the right outcome for a broken snapshot. That 503 branch is a **guard against a future refactor**, not a state you can reach today. `_module_initialized` is set as the module's last statement, and uvicorn accepts no request until the import completes. The branch therefore becomes reachable only once someone moves warm-up work behind the bind. A hook with only a 200 path would then report a still-initialising snapshot as valid.

The hook runs under the **build role**, which deliberately holds no Bedrock, Secrets Manager, or DynamoDB grants. The hook therefore **makes zero AWS API calls and must keep making zero**, its own logging included. Both build hooks log to stdout via `_build_hook_log`, never through the CloudWatch writer. There are two reasons. First, a Logs write outside the service's `/aws/lambda-microvms/*` namespace, the build role's only Logs grant, can only fail, and leaves nothing but a `CloudWatch write failed` line on stdout. Second, `boto3.client(...)` populates `boto3.DEFAULT_SESSION`, a module global that holds a resolved credential chain. The snapshot would then freeze that chain in for every MicroVM launched from that image version. Only the credentials would be frozen. Clients still re-resolve the region. "Deeper warm-up assertions" (Bedrock reachability, Memory access, tool availability) are therefore *not* implementable here. The one member of that list that turned out to be partly implementable, proving that the local `claude` binary execs, is on `/ready` instead, as a side effect of warming the binary (above). A local `exec` is not an AWS call, and the check belongs to the hook whose 200 gates the snapshot.

Baked secrets are **reported, not enforced**. `warnings` lists the names (never the values) of any credential-shaped env var present in the snapshot, because the build environment's own credentials may legitimately be in that env and failing here would fail every build.

**`POST /aws/lambda-microvms/runtime/v1/terminate`.** Runtime hook (P2). It is best-effort. It emits one final structured log line and returns 200. It does so always, inside the hook budget, even with nothing running, and for **any body**: malformed JSON, a wrong content-type, an empty body or no body at all. For that reason the handler takes the raw request instead of a typed body model. FastAPI validates a typed body *before* the handler runs, so a truncated body would answer 422 and report a hook failure for a teardown that actually succeeded. The hook does **not** join the pipeline thread, which is `lifespan`'s job on graceful shutdown. It **never writes terminal task status**. The orchestrator finalizes the task and *then* calls `TerminateMicrovm`, so a status write here would race that finalization. Nothing is buffered to flush. `ProgressWriter` does a synchronous `put_item` per event, so progress is already durable at call time.

`microvmId` is parsed defensively and **arrives empty in practice**. The service sends `""` here, unlike `/run`, where it is populated (live-verified, ADR-021 P2-F8). So an empty id is expected and normal, not a degraded read, and this hook therefore **cannot** join the guest's record to the control-plane one. `/run`'s `hook accepted task_id=… microvm_id=…` line carries that correlation. What `/terminate` contributes is the pipeline-state snapshot it reports.

**`POST /aws/lambda-microvms/runtime/v1/run`.** Payload delivery. It validates the body, installs `platform_config` (below), starts the pipeline in a background thread, and returns 200 inside the hook budget of 1 to 60 s. The pipeline starts on the same path that `/invocations` uses, from `_extract_invocation_params` to `_spawn_background`. Body:

```json
{
  "microvmId": "microvm-b44b69d9-…",
  "runHookPayload": "{\"agent_payload_s3_uri\": \"s3://bucket/<task_id>/payload.json\", \"platform_config\": {…}}"
}
```

`runHookPayload` is an opaque **string** that the service passes through from `RunMicrovm`. ABCA's contract for it is one of two shapes, which mirror the ECS container env contract (`AGENT_PAYLOAD` or `AGENT_PAYLOAD_S3_URI`):

| Envelope | When |
|---|---|
| `{"agent_payload": {…}, "platform_config": {…}}` | the whole orchestrator payload inline, only when it fits |
| `{"agent_payload_s3_uri": "s3://bucket/key", "platform_config": {…}}` | pointer to the payload in the platform payload bucket |

The service caps `runHookPayload` at **4 096 bytes**, so the **pointer form is the normal one**. A hydrated payload is essentially always larger. Fetching the payload needs no new env var. The MicroVM execution role holds read-only access to that bucket, and the URI carries the bucket and the key.

#### `platform_config` — the agent's env, delivered per task (P2)

On AgentCore and ECS the agent's non-secret platform env arrives as runtime env or container overrides. A MicroVM boots from a **snapshot**, so its env is frozen at *image build* time. Baking the deployment's identifiers in would make every image version describe a deployment that may since have been redeployed. The identifiers therefore travel with the task, as a **sibling** of `agent_payload`. Per-task fields like `memory_id` stay *inside* `agent_payload`. `platform_config` configures the process, and `agent_payload` describes the task:

```json
{ "platform_config": { "task_table_name": "…", "github_token_secret_arn": "arn:…" } }
```

Each snake_case key installs into its UPPER_SNAKE env var, and a payload value **wins** over any image or pre-existing value. The payload describes the live deployment, and the snapshot describes a past one. Installation happens **before** any credential or pipeline initialisation. The very next step resolves the GitHub token from `GITHUB_TOKEN_SECRET_ARN`. Everything the hook logs before that point goes to stdout only (`[server/run-pre-config]`), for the same reason as in the build hooks. The CloudWatch writer resolves AWS credentials and pins `boto3.DEFAULT_SESSION`. It pins the credentials only, and the region is re-resolved per client. Until the install has run, the only environment available is whatever the snapshot baked. The single AWS call allowed before the install is the S3 payload fetch, because the config is inside the object being fetched. The allowlist is in `contracts/constants.json` under `microvm_platform_config` (produced by the orchestrator and consumed here, with the shape enforced by `mise run check:constants-sync`):

| Key | Env var | Required |
|---|---|---|
| `task_table_name` | `TASK_TABLE_NAME` | ✅ |
| `task_events_table_name` | `TASK_EVENTS_TABLE_NAME` | ✅ |
| `github_token_secret_arn` | `GITHUB_TOKEN_SECRET_ARN` | ✅ |
| `agent_session_role_arn` | `AGENT_SESSION_ROLE_ARN` | ✅ |
| `task_approvals_table_name` | `TASK_APPROVALS_TABLE_NAME` | |
| `nudges_table_name` | `NUDGES_TABLE_NAME` | |
| `log_group_name` | `LOG_GROUP_NAME` | |
| `artifacts_bucket_name` | `ARTIFACTS_BUCKET_NAME` | |
| `trace_artifacts_bucket_name` | `TRACE_ARTIFACTS_BUCKET_NAME` | |
| `linear_oauth_secret_arn` | `LINEAR_OAUTH_SECRET_ARN` | |
| `jira_oauth_secret_arn` | `JIRA_OAUTH_SECRET_ARN` | |
| `aws_sdk_ua_app_id` | `AWS_SDK_UA_APP_ID` | |
| `anthropic_default_haiku_model` | `ANTHROPIC_DEFAULT_HAIKU_MODEL` | |

Values are **non-secret identifiers only**. Secrets are still fetched at `/run` time from Secrets Manager using the ARNs delivered here, so the snapshot stays secret-free. The allowlist **fails closed**. These values land in `os.environ` of the process that spawns the agent's tool subprocesses, so an unrecognised key is an env-injection attempt (`LD_PRELOAD`, `AWS_ENDPOINT_URL`, …), and the whole run is rejected with nothing installed. Blank or `null` values for optional keys are skipped rather than overwriting an image value. Blank required keys are rejected. An envelope with no `platform_config` at all is accepted with a prominent warning, because the image and the orchestrator deploy on independent cadences.

Rejections are structured so they are readable in the MicroVM log group: `400 MICROVM_RUN_PAYLOAD_INVALID` (unusable envelope, so retrying the same body cannot help), `500 MICROVM_RUN_PAYLOAD_UNREADABLE` (the S3 fetch failed), `400 MICROVM_RUN_PLATFORM_CONFIG_INVALID` (key off the allowlist, non-object block, or non-string value, so fix the producer), `400 MICROVM_RUN_PLATFORM_CONFIG_INCOMPLETE` (a required key missing or blank, so fix the deployment wiring), `400 TASK_RECORD_INCOMPLETE` (same validator and vocabulary as `/invocations`).

**`POST /aws/lambda-microvms/runtime/v1/suspend`** and **`/resume`.** Runtime hooks (P3, `microvm_http.py`). `/suspend` drains acknowledged progress and verifies that the task is safely parked at its approval gate within the hook budget. When that is unsafe, it answers **200 `declined`** and the guest keeps working, because any non-200 answer makes the service terminate the VM. `/resume` refreshes task-scoped and ambient credentials, re-reads the gate and reseeds CSPRNGs before the coding barrier opens. After a declined suspend it answers 200 `not-suspended`. `/terminate` closes the coding barrier first. Inside the guest, the Claude CLI gets credentials from a loopback container-credential broker (`microvm_credentials.py`) that renews them before signing with expired keys.

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

The repo URL passed to `run.sh` is set as a container env var, so it can be omitted from the payload. You can also start the server without a repo and pass the repo per request:

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

Both modes share the agent pipeline. Behavior varies by task type (`new_task`, `pr_iteration`, `pr_review`):

1. **Config validation.** Checks required parameters.
2. **Context hydration.** Fetches the GitHub issue (title, body, comments) if an issue number is provided. For `pr_iteration` and `pr_review`, fetches PR context (diff, description, review comments).
3. **Prompt assembly.** Combines the system prompt (behavioral contract, selected by task type from `prompts/`) with the issue or PR context and the task description.
4. **Deterministic pre-hooks.** Clones the repo, creates or checks out the branch, configures git auth, and runs `mise trust`, `mise install`, `mise run build`, and `mise run lint`.
5. **Agent execution.** Invokes the Claude Agent SDK via the `ClaudeSDKClient` class (connect, query, and receive_response pattern) in unattended mode. The agent:
   - Understands the codebase.
   - **`new_task`.** Makes changes, runs tests and linters, commits and pushes after each unit of work, and creates a pull request.
   - **`pr_iteration`.** Reads review feedback, addresses it with focused changes, commits and pushes, and posts a summary comment on the PR.
   - **`pr_review`.** Analyzes changes read-only (no `Write` or `Edit` tools available), composes structured review findings, and posts a batch review via the GitHub Reviews API.
6. **Deterministic post-hooks.** Verifies `mise run build` and `mise run lint`, and ensures that a PR exists (creates one if the agent did not). For `pr_review`, build status is informational only and the commit and push steps are skipped.
7. **Status resolution.** `_resolve_overall_task_status()` maps the agent outcome (success, end_turn, error, or unknown) and the build gate into a final task status. `agent_status=unknown` (SDK stream ended without a ResultMessage) always fails. Success is never inferred from PR or build alone. If a post-hook raises after the agent ran, `_chain_prior_agent_error()` preserves the agent-layer error so that the later exception does not mask it.
8. **Metrics.** Returns duration, disk usage, turn count, cost, and PR URL.

### Commit trailers

The `prepare-commit-msg` hook (`prepare-commit-msg.sh`, installed into the clone at the end of the pre-hooks) adds attribution trailers to every commit made in the clone from then on: the agent's commits, and the safety-net commit of work the agent left uncommitted. It reads the values from environment variables that the agent sets itself (they are not inputs of `run.sh`):

| Trailer | Example | Meaning | Variable, and what sets it |
|---------|---------|---------|----------------------------|
| `Task-Id` | `01KRPZ3PF8ZBRZ2600GRJS2VF7` | The task that made the commit | `TASK_ID`: the pipeline, before the pre-hooks |
| `Prompt-Version` | `1c9c10e027a2` | The task's `prompt_version`: 12 hex digits of a hash over the constant `system_prompt_v1` and the Blueprint's `system_prompt_overrides`, not over the prompt's text. No trailer when the task was given none | `PROMPT_VERSION`: the pipeline, before the pre-hooks |
| `Workflow-Id` | `coding/new-task-v1` | The workflow the task runs | `WORKFLOW_ID`: the workflow step runner, when a step starts |
| `Workflow-Step` | `implement` | The workflow step that was running: the step's `name`, else its `kind` | `WORKFLOW_STEP`: the workflow step runner, when a step starts |

For a task with a repository the step runner runs the agent step only, so the commits of a task name that step (`implement` for `coding/new-task-v1`), the safety-net commit included. That commit follows the agent step and saves that step's work. A trailer the message already has is kept, so an amended commit keeps the step it was first made in.

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
# Build for ARM64 (AgentCore Runtime target). Run from the repository root:
# the Dockerfile copies agent/ and contracts/ from there.
docker buildx build --platform linux/arm64 -f agent/Dockerfile -t bgagent-local --load .

# Check image size
docker images bgagent-local --format "{{.Size}}"
```

## File Structure

```
agent/
├── Dockerfile           Python 3.13 + Node.js 24 + Claude Code CLI + git + gh + mise (default platform linux/arm64)
├── .dockerignore
├── pyproject.toml       App dependencies (claude-agent-sdk, FastAPI, boto3, OpenTelemetry distro, MCP, cedarpy, …)
├── uv.lock              Locked deps for reproducible `uv sync` in the image
├── mise.toml            Tool versions / tasks used when the target repo relies on mise
├── src/                 Agent source modules (pythonpath configured in pyproject.toml)
│   ├── __init__.py
│   ├── entrypoint.py    Re-export shim for backward compatibility (tests); delegates to specific modules
│   ├── config.py        Configuration: build_config(), get_config(), resolve_github_token(), resolve_linear_api_token(); resolves the pinned workflow (resolved_workflow / ids like coding/new-task-v1) and validates required inputs per the workflow's requires_repo / read_only / is_pr_workflow (replaced TaskType in #248)
│   ├── models.py        Pydantic data models (TaskConfig, RepoSetup, AgentResult, TaskResult, HydratedContext, AttachmentConfig, etc.). TaskConfig carries the workflow fields (resolved_workflow, policy_principal, read_only, allowed_tools, requires_repo, is_pr_workflow) that replaced the former TaskType enum (#248)
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
│   ├── server.py        FastAPI — async /invocations (background thread), /ping health check, MicroVM /ready + /run lifecycle hooks, heartbeat daemon; OTEL session correlation
│   ├── task_state.py    Best-effort DynamoDB task status and heartbeat writes (no-op if TASK_TABLE_NAME unset)
│   ├── observability.py OpenTelemetry helpers (e.g. AgentCore session id)
│   ├── memory.py        Optional memory / episode integration for the agent
│   └── prompts/         System prompt templates, keyed by resolved workflow id (#248)
│       ├── __init__.py  Prompt registry — get_system_prompt(workflow_id) maps each workflow id to its template; warns + falls back for an unregistered id
│       ├── base.py      Shared base template for coding workflows (environment, rules, git/branch/PR placeholders)
│       ├── new_task.py  Workflow fragment for coding/new-task-v1 (create branch, implement, open PR)
│       ├── pr_iteration.py  Workflow fragment for coding/pr-iteration-v1 (read feedback, address, push)
│       ├── pr_review.py     Workflow fragment for coding/pr-review-v1 (read-only analysis, structured review comments)
│       ├── default_agent.py Repo-less prompt for default/agent-v1 (no git/branch/PR; deliverable is the final message)
│       └── web_research.py  Repo-less research prompt for knowledge/web-research-v1 (WebFetch sourcing, structured cited answer)
├── scripts/diagnostics/ Optional ops diagnostics (not bundled in the production image)
│   ├── test_sdk_smoke.py        Minimal SDK smoke test (ClaudeSDKClient → CLI → Bedrock)
│   └── test_subprocess_threading.py  Subprocess-in-background-thread verification
├── prepare-commit-msg.sh Git hook (Task-Id / Prompt-Version / Workflow-Id / Workflow-Step trailers on commits)
├── run.sh               Build + run helper for local/server mode with AgentCore constraints
├── tests/               pytest unit tests (pythonpath: src/)
│   ├── test_config.py       Config validation and workflow-resolution tests (requires_repo / read_only / is_pr_workflow, load-failure fallback)
│   ├── test_hooks.py        PreToolUse hook and hook matcher tests
│   ├── test_models.py       Pydantic model tests (construction, validation, frozen enforcement, model_dump)
│   ├── test_policy.py       Cedar policy engine tests (fail-closed, deny-list)
│   ├── test_pipeline.py     Pipeline tests (run_task with the agent, the repository setup and the post-hooks stubbed)
│   ├── test_pipeline_outcomes.py  Outcome tests (_resolve_overall_task_status, _chain_prior_agent_error, delivery gate)
│   ├── test_shell.py        Shell utility tests (slugify, redact_secrets, truncate, format_bytes)
│   └── ...
├── tests_emulator/      Emulator-backed tests: real agent code against a local AWS Emulator (`mise run test:integration`; not collected by the unit run)
```

The container CMD runs the app under `opentelemetry-instrument` with uvicorn on the asyncio event loop, not uvloop. That choice avoids known subprocess issues with uvloop.

The image sets `OTEL_PYTHON_DISABLED_INSTRUMENTATIONS`, so the `requests` and `urllib3` instrumentation stays off. That instrumentation would copy the trace context and the task's correlation baggage into the headers of the agent's requests to Linear and Atlassian. A value given at run time replaces the image's. Keep both names in it.

**Diagnostics.** `scripts/diagnostics/` holds optional smoke tests for local AgentCore debugging. They are not copied into the production Docker image.

### MicroVM optional service configuration

The shared `contracts/constants.json` allowlist transports `tool_gateway_url` as
`ABCA_TOOL_GATEWAY_URL`, `linear_vault_enabled` as `LINEAR_VAULT_ENABLED`, and
`linear_workload_identity_name` as `LINEAR_WORKLOAD_IDENTITY_NAME` in the MicroVM
`platform_config` payload. These optional values come from the deployed Gateway
and vault configuration. They contain identifiers, not credential values.
Rebuild the MicroVM snapshot from this checkout before you enable those features.
An older image does not recognize the new keys. AgentCore and ECS receive the
same settings through their deployment environment.
