---
title: "Using the CLI"
---

The `bgagent` CLI is the recommended way to interact with the platform. It authenticates through Cognito, manages token caching, and provides formatted output.

This repository builds the CLI under `cli/`. After the compile, run the entrypoint as `node lib/bin/bgagent.js` from the `cli` directory. That entrypoint is the path `package.json` exposes as `bin`. If you install a published package or link `bgagent` onto your `PATH`, you can call `bgagent` directly. The subcommands are the same.

### Setup

```bash
cd cli
mise run build

# Configure with your stack outputs (run from cli/)
node lib/bin/bgagent.js configure \
  --api-url $API_URL \
  --region "$REGION" \
  --user-pool-id $USER_POOL_ID \
  --client-id $APP_CLIENT_ID

# Log in
node lib/bin/bgagent.js login --username user@example.com
```

### Operator commands (stack admin)

Stack admins can inspect deployment state and run smoke checks **without Cognito login**. These commands use operator AWS credentials (IAM profile / `AWS_REGION`):

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

The read-only operator commands (`platform`, `repo`, `runtime`, `ops`, `webhook test`, and `admin list-users`) accept `--output json`. The credential-writing `github` and `admin invite-user`/`delete-user`/`reset-password` commands do not. The region defaults to `bgagent configure --region` or `AWS_REGION`.

### Submitting a task

```bash
# From cli/  - from a GitHub issue
node lib/bin/bgagent.js submit --repo owner/repo --issue 42

# From a text description
node lib/bin/bgagent.js submit --repo owner/repo --task "Add input validation to the /users POST endpoint"

# Iterate on an existing pull request (address review feedback)
node lib/bin/bgagent.js submit --repo owner/repo --pr 42

# Iterate on a PR with additional instructions
node lib/bin/bgagent.js submit --repo owner/repo --pr 42 --task "Focus on the null check Alice flagged"

# Review an existing pull request (read-only  - posts structured review comments)
node lib/bin/bgagent.js submit --repo owner/repo --review-pr 55

# Review a PR with a specific focus area
node lib/bin/bgagent.js submit --repo owner/repo --review-pr 55 --task "Focus on security and error handling"

# Select an explicit workflow (overrides the one --pr/--review-pr would imply)
node lib/bin/bgagent.js submit --repo owner/repo --task "Research the tradeoffs" --workflow knowledge/web-research-v1

# Submit with attachments (local files)
node lib/bin/bgagent.js submit --repo owner/repo --task "Fix this bug" \
  --attachment screenshot.png \
  --attachment error.log

# Submit with a URL attachment
node lib/bin/bgagent.js submit --repo owner/repo --task "Implement this design" \
  --attachment https://figma.com/file/abc123/export.png

# Submit and wait for completion
node lib/bin/bgagent.js submit --repo owner/repo --issue 42 --wait
```

**Example** of the default `text` output immediately after a successful submit. The task is `SUBMITTED` and the branch name is reserved:

```bash
node lib/bin/bgagent.js submit --repo awslabs/agent-plugins --task "add codeowners field to RFC issue template"
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
| `--workflow` | Workflow to run, as `<id>[@<constraint>]` (for example `coding/new-task-v1`). Overrides the workflow implied by `--pr` or `--review-pr`. Without any of the three flags, the CLI sends `coding/new-task-v1`. |
| `--attachment` | Attach a local file or URL (repeatable). Local files ≤ 500 KB are sent inline, up to 3 MB in total. The other files use presigned upload. URLs are fetched during hydration. See [Attachments](#attachments) below. |
| `--max-turns` | Maximum agent turns (1 to 500). Overrides per-repo Blueprint default. Platform default: 100. |
| `--max-budget` | Maximum cost budget in USD (0.01 to 100). Overrides per-repo Blueprint default. No default limit. |
| `--idempotency-key` | Idempotency key for deduplication. |
| `--trace` | Enable detailed tracing. Raises the progress preview cap to 4 KB and uploads the full NDJSON trajectory to S3 on completion. Download with `bgagent trace download`. |
| `--approval-timeout` | Cedar HITL per-task approval timeout in seconds (default 300). A matching rule with its own `@approval_timeout_s` annotation still takes the minimum. See [Approval gates](/sample-autonomous-cloud-coding-agents/using/approval-gates-cedar-hitl). |
| `--microvm-sleep-after` | Seconds to wait for approval before putting a Lambda MicroVM to sleep (default 60, 0 to 3600 accepted). Use `off` to keep it awake. Requires the deployment's automatic-sleep feature to be enabled. Does not change approval deadlines or affect other compute backends. |
| `--pre-approve` | Cedar HITL scope to approve up-front (repeatable). Scope forms: `all_session`, `tool_type:<name>`, `tool_group:<name>`, `bash_pattern:<glob>`, `write_path:<glob>`, `rule:<rule_id>`. Hard-deny rules are always enforced. |
| `--wait` | Poll until the task reaches a terminal status. |
| `--output` | Output format: `text` (default) or `json`. |

At least one of `--issue`, `--task`, `--pr`, or `--review-pr` is required. The `--pr` and `--review-pr` flags are mutually exclusive.

### Attachments

Attachments let you give the agent non-text context, such as screenshots of bugs, design mockups, CSV data, log files, or URLs to external resources. Every attachment goes through security screening before it reaches the agent.

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
node lib/bin/bgagent.js submit --repo owner/repo --task "Fix this layout" \
  --attachment screenshot.png

# Multiple attachments
node lib/bin/bgagent.js submit --repo owner/repo --task "Analyze these logs" \
  --attachment error.log \
  --attachment metrics.csv

# URL attachment (fetched during task hydration)
node lib/bin/bgagent.js submit --repo owner/repo --task "Implement this design" \
  --attachment https://example.com/mockup.png
```

The CLI chooses the upload path for each attachment:

- **Files ≤ 500 KB** are sent inline (base64-encoded in the request body), up to 3 MB in total.
- **Files > 500 KB**, and smaller files once 3 MB are sent inline, use presigned upload. The CLI uploads them directly to S3 and then confirms the upload.
- **URLs** are validated at submission and fetched during context hydration with SSRF protection.

**Security screening:**

All attachments are screened before they reach the agent:

- **Images.** Magic bytes validation, dimension checks (at most 8000px per side), and Bedrock Guardrail content screening for prompt attacks. Only PNG and JPEG are accepted.
- **Text files.** Magic bytes validation and Bedrock Guardrail text content screening. The text of a PDF is extracted (at most 50 pages) before screening.
- **URLs.** HTTPS-only enforcement, DNS resolution pinning (which prevents DNS rebinding and SSRF), private IP blocking, redirect validation, and size and timeout limits.

If any attachment fails screening, the platform rejects the entire task with an error that identifies the file. Submit the task again without the flagged attachment.

### Checking task status

Run these commands from the `cli/` directory, as in **Setup**.

#### Single task

```bash
node lib/bin/bgagent.js status <TASK_ID>

# Poll until completion
node lib/bin/bgagent.js status <TASK_ID> --wait
```

**Example** of the default `text` output once the task has finished. The status is `COMPLETED`, and the output has the session id, PR link, duration, and cost:

```bash
node lib/bin/bgagent.js status 01KN37PZ77P1W19D71DTZ15X6X
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
node lib/bin/bgagent.js list
node lib/bin/bgagent.js list --status RUNNING,SUBMITTED
node lib/bin/bgagent.js list --repo owner/repo --limit 10
```

The columns of the table are `TASK ID`, `STATUS`, `REPO`, `CREATED`, `HEARTBEAT`, and `DESCRIPTION`.

#### Is a running task actually alive? (`HEARTBEAT`)

While a task is `RUNNING`, the agent writes a liveness beat every 45 seconds. `bgagent status` shows the beat as a `Heartbeat:` line, and `bgagent list` shows it as a `HEARTBEAT` column. Both show an **age**, not a timestamp, because the age tells you whether the agent is alive:

```text
  Heartbeat:     12s ago
```

- **Under about 1 minute.** Healthy. The agent is working.
- **Several minutes and rising.** The agent is hung, is deadlocked, or was OOM-killed inside an otherwise healthy compute environment. The platform detects this state itself and fails the task instead of letting it run to its full timeout, so you do not need to act. The failure message names the compute substrate.
- **`—`.** Nothing to report. The CLI shows it for terminal tasks, because the last beat means nothing next to a final status. The CLI also shows it before the first beat arrives, and on the `ecs` backend, where the agent runs the pipeline directly instead of serving HTTP and so beats only once, at the start.

### Viewing task events

```bash
node lib/bin/bgagent.js events <TASK_ID>
node lib/bin/bgagent.js events <TASK_ID> --limit 20
node lib/bin/bgagent.js events <TASK_ID> --output json
```

Use `--output json` to see the full payload of `preflight_failed` (`reason`, `detail`, and per-check metadata). See **Task events** under **Task lifecycle** for how to interpret common `reason` values.

### Watching a task in real time

`bgagent watch` streams progress events (turns, tool calls, tool results, milestones, and cost updates) from a running task and exits automatically when the task reaches a terminal state.

```bash
node lib/bin/bgagent.js watch <TASK_ID>

# JSON output (one event per line) — useful for scripting
node lib/bin/bgagent.js watch <TASK_ID> --output json
```

The exit code is `0` on `COMPLETED`, `1` on `FAILED`, `CANCELLED`, or `TIMED_OUT`, and `2` when the CLI gives up because the API kept failing. After exit code `2`, the task may still be running. Run the command again to resume. Press Ctrl+C to exit early without affecting the task.

### Steering a running task (nudge)

Send a message to the agent while it is working. The agent emits a `nudge_acknowledged` milestone before it uses your guidance in its next turn.

```bash
node lib/bin/bgagent.js nudge <TASK_ID> "Focus on the auth module first"

# Example: redirect scope mid-task
node lib/bin/bgagent.js nudge <TASK_ID> "Skip the docs update, just fix the handler"
```

Nudges are delivered between turns. The agent finishes its current tool call before it reads the message. You can send multiple nudges. The agent acknowledges them in order.

### Tracing a task

Submit a task with `--trace` to enable detailed tracing. Tracing raises the progress-writer preview cap from 200 characters to 4 KB and uploads a full gzipped NDJSON trajectory to S3 when the task finishes.

```bash
# Submit with tracing enabled
node lib/bin/bgagent.js submit --repo owner/repo --issue 42 --trace

# Download the trace after the task completes
node lib/bin/bgagent.js trace download <TASK_ID>

# Pipe to jq for analysis
node lib/bin/bgagent.js trace download <TASK_ID> | jq -s .

# Save raw gzip to a file
node lib/bin/bgagent.js trace download <TASK_ID> -o trace.ndjson.gz

# Overwrite existing file
node lib/bin/bgagent.js trace download <TASK_ID> -o trace.ndjson.gz --force
```

### Debug output

Add `--verbose` to any `bgagent` command to print the full HTTP request and response cycle on stderr. Use it to diagnose auth, network, or API contract issues.

```bash
node lib/bin/bgagent.js --verbose status <TASK_ID>
node lib/bin/bgagent.js --verbose submit --repo owner/repo --task "Fix the bug"
```

### Cancelling a task

```bash
node lib/bin/bgagent.js cancel <TASK_ID>
```

### Reading your scoreboard (stats)

`bgagent stats` prints the scoreboard of your own finished tasks: how long the work you handed to agents took, how often it ended in a verified and then a merged pull request, how much of your attention and money it needed, and whether it stayed inside the rules.

```bash
# Your tasks of the last 30 days
node lib/bin/bgagent.js stats

# The last 7 days, in one repository
node lib/bin/bgagent.js stats --range 7d --repo owner/repo

# The same numbers as JSON
node lib/bin/bgagent.js stats --output json
```

**Options:**

| Flag | Description |
|---|---|
| `--range` | Period the numbers cover: `7d` or `30d` (default). It ends at the moment of the request. |
| `--repo` | Count the tasks of one repository only (`owner/repo`, in any letter case). |
| `--output` | Output format: `text` (default) or `json`. `json` prints the scoreboard as the API returns it (see [API_CONTRACT.md](/sample-autonomous-cloud-coding-agents/architecture/api-contract#list-tasks)). |

The numbers stand under four headings, Speed, Quality, Leverage and Trust, and the finished tasks per outcome follow them. Under a number stand the counts it rests on and, for some, the same number for the period of that length before. A number with nothing to compute it from shows `-`, and the line under it says why. The **Scoreboard** page of the operator console shows the same numbers under the same labels.

One document, the observability design, defines what a number counts. [The numbers](/sample-autonomous-cloud-coding-agents/architecture/observability#the-numbers) has a row for every number, under the label the command prints. [Words](/sample-autonomous-cloud-coding-agents/architecture/observability#words) defines the terms those rows use and the six outcomes. [Not counted and not measured](/sample-autonomous-cloud-coding-agents/architecture/observability#not-counted-and-not-measured) lists what the scoreboard does not see.

**Limits:**

- **Your own tasks only.** No option shows another user's numbers or a team's. Every user's numbers are on the CloudWatch dashboard, in the "Factory scoreboard" row.
- **7 or 30 days.** The numbers cover the last 7 or 30 days, beside the period of the same length before, and no option reaches further back.
- **`--repo` filters after the read.** A request reads a bounded number of your task records and then counts those of the repository, so the notice that the numbers cover part of the range can appear for a repository with few tasks.