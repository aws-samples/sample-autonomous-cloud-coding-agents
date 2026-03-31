---
title: Using the CLI
---

The `bgagent` CLI is the recommended way to interact with the platform. It authenticates via Cognito, manages token caching, and provides formatted output.

### Setup

```bash
# Build the CLI
cd cli && npx projen build && cd ..

# Configure with your stack outputs
bgagent configure \
  --api-url $API_URL \
  --region us-east-1 \
  --user-pool-id $USER_POOL_ID \
  --client-id $APP_CLIENT_ID

# Log in
bgagent login --username user@example.com
```

### Submitting a task

```bash
# From a GitHub issue
bgagent submit --repo owner/repo --issue 42

# From a text description
bgagent submit --repo owner/repo --task "Add input validation to the /users POST endpoint"

# Submit and wait for completion
bgagent submit --repo owner/repo --issue 42 --wait
```

**Options:**

| Flag | Description |
|---|---|
| `--repo` | GitHub repository (`owner/repo`). Required. |
| `--issue` | GitHub issue number. |
| `--task` | Task description text. |
| `--max-turns` | Maximum agent turns (1–500). Overrides per-repo Blueprint default. Platform default: 100. |
| `--max-budget` | Maximum cost budget in USD (0.01–100). Overrides per-repo Blueprint default. No default limit. |
| `--idempotency-key` | Idempotency key for deduplication. |
| `--wait` | Poll until the task reaches a terminal status. |
| `--output` | Output format: `text` (default) or `json`. |

At least one of `--issue` or `--task` is required.

### Checking task status

#### Single task

```bash
bgagent status <TASK_ID>

# Poll until completion
bgagent status <TASK_ID> --wait
```

#### All tasks

```bash
bgagent list
bgagent list --status RUNNING,SUBMITTED
bgagent list --repo owner/repo --limit 10
```

### Viewing task events

```bash
bgagent events <TASK_ID>
bgagent events <TASK_ID> --limit 20
```

### Cancelling a task

```bash
bgagent cancel <TASK_ID>
```