---
title: "Using the CLI"
---

The `bgagent` CLI is the recommended way to interact with the platform. It authenticates via Cognito, manages token caching, and provides formatted output.

The CLI is not published to npm; it runs from your checkout of **this repository**. `mise run install` writes the `bgagent` command to `~/.local/bin`, and `mise run build` (or `mise run cli:install`, which also writes the command) compiles the CLI it runs. `bgagent` always runs the CLI of the checkout that installed it, from any directory, and keeps that directory, so relative paths such as `--attachment` resolve where you typed them; `mise run cli:install --force` from another checkout switches it. Without the command, `node cli/lib/bin/bgagent.js` from the repo root takes the same subcommands. The [CLI README](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/cli/README.md#installation) has the details.

### Setup

```bash
mise run cli:install   # from the repo root: compile the CLI, write the bgagent command

# Configure with your stack outputs
bgagent configure \
  --api-url $API_URL \
  --region "$REGION" \
  --user-pool-id $USER_POOL_ID \
  --client-id $APP_CLIENT_ID

# Log in
bgagent login --username user@example.com
```

### Operator commands (stack admin)

Stack admins can introspect deployment state and run smoke checks **without Cognito login** — these commands use operator AWS credentials (IAM profile / `AWS_REGION`):

```bash
# Print stack outputs (ApiUrl, UserPoolId, AppClientId, GitHubTokenSecretArn, …)
bgagent platform outputs --stack-name backgroundagent-dev

# Smoke-check API, Cognito, GitHub token, Bedrock model, onboarded repos
bgagent platform doctor --stack-name backgroundagent-dev

# List onboarded repositories
bgagent repo list

# Show RepoConfig for one repo (secret ARNs redacted)
bgagent repo show owner/repo

# Store the platform GitHub PAT (or a per-blueprint secret via --repo)
bgagent github set-token
bgagent github set-token --repo owner/repo
```

The read-only operator commands (`platform`, `repo`, `runtime`, `ops`, `webhook test`, `admin list-users`) accept `--output json`; the credential-writing `github` and `admin invite-user`/`delete-user`/`reset-password` commands do not. Region defaults to `bgagent configure --region` or `AWS_REGION`.

### Submitting a task

```bash
# From a GitHub issue
bgagent submit --repo owner/repo --issue 42

# From a text description
bgagent submit --repo owner/repo --task "Add input validation to the /users POST endpoint"

# Iterate on an existing pull request (address review feedback)
bgagent submit --repo owner/repo --pr 42

# Iterate on a PR with additional instructions
bgagent submit --repo owner/repo --pr 42 --task "Focus on the null check Alice flagged"

# Review an existing pull request (read-only  - posts structured review comments)
bgagent submit --repo owner/repo --review-pr 55

# Review a PR with a specific focus area
bgagent submit --repo owner/repo --review-pr 55 --task "Focus on security and error handling"

# Select an explicit workflow (overrides the one --pr/--review-pr would imply)
bgagent submit --repo owner/repo --task "Research the tradeoffs" --workflow knowledge/web-research-v1

# Submit with attachments (local files)
bgagent submit --repo owner/repo --task "Fix this bug" \
  --attachment screenshot.png \
  --attachment error.log

# Submit with a URL attachment
bgagent submit --repo owner/repo --task "Implement this design" \
  --attachment https://figma.com/file/abc123/export.png

# Submit and wait for completion
bgagent submit --repo owner/repo --issue 42 --wait
```

**Example** (default `text` output immediately after a successful submit  - task is `SUBMITTED`, branch name reserved):

```bash
bgagent submit --repo awslabs/agent-plugins --task "add codeowners field to RFC issue template"
```

```text
Task:        01KN37PZ77P1W19D71DTZ15X6X
Status:      SUBMITTED
Repo:        awslabs/agent-plugins
Description: add codeowners field to RFC issue template
Branch:      bgagent/01KN37PZ77P1W19D71DTZ15X6X/add-codeowners-field-to-rfc-issue-template
Created:     2026-04-01T00:39:51.271Z
```

**Options:**

| Flag | Description |
|---|---|
| `--repo` | GitHub repository (`owner/repo`). Required. |
| `--issue` | GitHub issue number. |
| `--task` | Task description text. |
| `--pr` | PR number to iterate on. Selects the `coding/pr-iteration-v1` workflow. The agent checks out the PR's branch, reads review feedback, and pushes updates. |
| `--review-pr` | PR number to review. Selects the `coding/pr-review-v1` workflow. The agent checks out the PR's branch, analyzes changes read-only, and posts structured review comments. |
| `--workflow` | Workflow to run, as `<id>[@<constraint>]` (e.g. `coding/new-task-v1`). Overrides the workflow implied by `--pr`/`--review-pr`; without any of the three flags the CLI sends `coding/new-task-v1`. |
| `--attachment` | Attach a local file or URL (repeatable). Local files ≤ 500 KB are sent inline, up to 3 MB in total; the other files use presigned upload. URLs are fetched during hydration. See [Attachments](#attachments) below. |
| `--max-turns` | Maximum agent turns (1–500). Overrides per-repo Blueprint default. Platform default: 100. |
| `--max-budget` | Maximum cost budget in USD (0.01–100). Overrides per-repo Blueprint default. No default limit. |
| `--idempotency-key` | Idempotency key for deduplication. |
| `--trace` | Enable detailed tracing: raises progress preview cap to 4 KB and uploads full NDJSON trajectory to S3 on completion. Download with `bgagent trace download`. |
| `--approval-timeout` | Cedar HITL per-task approval timeout in seconds (default 300). A matching rule with its own `@approval_timeout_s` annotation still takes the minimum. See [Approval gates](/sample-autonomous-cloud-coding-agents/using/approval-gates-cedar-hitl). |
| `--microvm-sleep-after` | Seconds to wait for approval before putting a Lambda MicroVM to sleep (default 60; 0–3600 accepted). Use `off` to keep it awake. Requires the deployment's automatic-sleep feature to be enabled; does not change approval deadlines or affect other compute backends. |
| `--pre-approve` | Cedar HITL scope to approve up-front (repeatable). Scope forms: `all_session`, `tool_type:<name>`, `tool_group:<name>`, `bash_pattern:<glob>`, `write_path:<glob>`, `rule:<rule_id>`. Hard-deny rules are always enforced. |
| `--wait` | Poll until the task reaches a terminal status. |
| `--output` | Output format: `text` (default) or `json`. |

At least one of `--issue`, `--task`, `--pr`, or `--review-pr` is required. The `--pr` and `--review-pr` flags are mutually exclusive.

### Attachments

Attachments let you provide non-text context to the agent — screenshots of bugs, design mockups, CSV data, log files, or URLs to external resources. Every attachment passes through security screening before reaching the agent.

**Supported file types:**

| Category | Types | Extensions |
|---|---|---|
| Images | PNG, JPEG | `.png`, `.jpg` |
| Text files | Plain text, CSV, Markdown, JSON, PDF, Log | `.txt`, `.csv`, `.md`, `.json`, `.pdf`, `.log` |

**Limits:**

| Limit | Value |
|---|---|
| Max attachments per task | 10 |
| Max size per attachment | 10 MB |
| Max total size per task | 50 MB |
| URL attachments | HTTPS only |

**Usage:**

```bash
# Local file (the MIME type comes from the file extension)
bgagent submit --repo owner/repo --task "Fix this layout" \
  --attachment screenshot.png

# Multiple attachments
bgagent submit --repo owner/repo --task "Analyze these logs" \
  --attachment error.log \
  --attachment metrics.csv

# URL attachment (fetched during task hydration)
bgagent submit --repo owner/repo --task "Implement this design" \
  --attachment https://example.com/mockup.png
```

The CLI automatically routes attachments through the optimal upload path:

- **Files ≤ 500 KB** are sent inline (base64-encoded in the request body), up to 3 MB in total.
- **Files > 500 KB**, and smaller files once 3 MB are sent inline, use presigned upload (uploaded directly to S3, then confirmed).
- **URLs** are validated at submission and fetched during context hydration with SSRF protection.

**Security screening:**

All attachments are screened before reaching the agent:

- **Images**: Magic bytes validation, dimension checks (max 8000px per side), Bedrock Guardrail content screening (prompt attack detection). Only PNG and JPEG are accepted.
- **Text files**: Magic bytes validation, Bedrock Guardrail text content screening. PDFs have text extracted (max 50 pages) before screening.
- **URLs**: HTTPS-only enforcement, DNS resolution pinning (prevents DNS rebinding/SSRF), private IP blocking, redirect validation, size and timeout limits.

If any attachment fails screening, the entire task is rejected with a clear error identifying the problematic file. Re-submit without the flagged attachment.

### Checking task status

#### Single task

```bash
bgagent status <TASK_ID>

# Poll until completion
bgagent status <TASK_ID> --wait
```

**Example** (default `text` output once the task has finished  - `COMPLETED`, with session id, PR link, duration, and cost):

```bash
bgagent status 01KN37PZ77P1W19D71DTZ15X6X
```

```text
Task:        01KN37PZ77P1W19D71DTZ15X6X
Status:      COMPLETED
Repo:        awslabs/agent-plugins
Description: add codeowners field to RFC issue template
Branch:      bgagent/01KN37PZ77P1W19D71DTZ15X6X/add-codeowners-field-to-rfc-issue-template
Session:     9891af91-bfc6-488f-bfe6-ce8f8c9a63cf
PR:          https://github.com/awslabs/agent-plugins/pull/43
Created:     2026-04-01T00:39:51.271Z
Started:     2026-04-01T00:39:56.647Z
Completed:   2026-04-01T00:43:49Z
Duration:    148.6s
Cost:        $0.1751
```

#### All tasks

```bash
bgagent list
bgagent list --status RUNNING,SUBMITTED
bgagent list --repo owner/repo --limit 10
```

The table is `TASK ID`, `STATUS`, `REPO`, `CREATED`, `HEARTBEAT`, `DESCRIPTION`.

#### Is a running task actually alive? (`HEARTBEAT`)

While a task is `RUNNING` the agent writes a liveness beat every 45 seconds. `bgagent status` shows it as a `Heartbeat:` line and `bgagent list` as a `HEARTBEAT` column, both as an **age** rather than a timestamp, because the age is the signal:

```text
Heartbeat:   2026-04-01T00:41:02.118Z (12s ago)
```

- **Under ~1 minute** - healthy; the agent is working.
- **Several minutes and climbing** - the agent is hung, deadlocked, or was OOM-killed inside an otherwise-healthy compute environment. The platform detects this itself and fails the task rather than letting it burn its full timeout, so you do not need to act; the failure message will name the compute substrate.
- **`—`** - nothing to report. Shown for terminal tasks (the last beat means nothing next to a final status), before the first beat arrives, and on the `ecs` backend, where the agent runs the pipeline directly rather than serving HTTP and so beats only once at start.

### Viewing task events

```bash
bgagent events <TASK_ID>
bgagent events <TASK_ID> --limit 20
bgagent events <TASK_ID> --output json
```

Use **`--output json`** to see the full payload for **`preflight_failed`** (`reason`, `detail`, and per-check metadata). See **Task events** under **Task lifecycle** for how to interpret common `reason` values.

### Watching a task in real time

Stream progress events (turns, tool calls, tool results, milestones, cost updates) from a running task and exit automatically when it reaches a terminal state.

```bash
bgagent watch <TASK_ID>

# JSON output (one event per line) — useful for scripting
bgagent watch <TASK_ID> --output json
```

Exit codes: `0` on `COMPLETED`, `1` on `FAILED` / `CANCELLED` / `TIMED_OUT`, `2` when the CLI gives up because the API kept failing (the task may still be running: run the command again to resume). Press Ctrl+C to exit early without affecting the task.

### Steering a running task (nudge)

Send a mid-run message to the agent while it is working. The agent emits a `nudge_acknowledged` milestone before incorporating your guidance into its next turn.

```bash
bgagent nudge <TASK_ID> "Focus on the auth module first"

# Example: redirect scope mid-task
bgagent nudge <TASK_ID> "Skip the docs update, just fix the handler"
```

Nudges are delivered between turns — the agent finishes its current tool call before reading the message. You can send multiple nudges; each one is acknowledged in order.

### Tracing a task

Submit a task with `--trace` to enable detailed tracing. This raises the progress-writer preview cap from 200 chars to 4 KB and uploads a full gzipped NDJSON trajectory to S3 when the task finishes.

```bash
# Submit with tracing enabled
bgagent submit --repo owner/repo --issue 42 --trace

# Download the trace after the task completes
bgagent trace download <TASK_ID>

# Pipe to jq for analysis
bgagent trace download <TASK_ID> | jq -s .

# Save raw gzip to a file
bgagent trace download <TASK_ID> -o trace.ndjson.gz

# Overwrite existing file
bgagent trace download <TASK_ID> -o trace.ndjson.gz --force
```

### Debug output

Add `--verbose` to any `bgagent` command to emit the full HTTP request/response cycle on stderr. This is useful for diagnosing auth, network, or API contract issues.

```bash
bgagent --verbose status <TASK_ID>
bgagent --verbose submit --repo owner/repo --task "Fix the bug"
```

### Cancelling a task

```bash
bgagent cancel <TASK_ID>
```