---
name: submit-task
description: >-
  Submit a coding task to the ABCA platform via CLI or REST API. Guides prompt
  quality, workflow selection, and cost controls. Use when the user says "submit a task",
  "create a task", "run the agent", "send task to agent", "bgagent submit",
  "new task", "pr iteration", "pr review", "review a PR", "quick submit",
  "submit to ABCA", or wants to automate coding work.
argument-hint: <repo> [description]
---

# Submit a Coding Task

You are helping the user submit a well-crafted coding task to the ABCA platform. Good prompts are critical — the agent works autonomously without asking clarifying questions.

> **Running the CLI:** examples below call `node cli/lib/bin/bgagent.js …` from the repo root. In a **non-interactive or mise-managed shell** `node` may not be on `PATH` (`command not found`) — prefix with `mise exec --` (e.g. `mise exec -- node cli/lib/bin/bgagent.js submit …`), or use a global `bgagent` if installed. If `cli/lib/bin/bgagent.js` is missing, run `mise run build` first.

**Quick mode:** If the user provided a repo and description inline (e.g. "submit task to owner/repo: fix the login bug"), infer the workflow from the description and skip to Step 5:
- PR number or "review PR" → `--review-pr`
- "iterate on PR" or "fix PR feedback" → `--pr`
- Just a number → `--issue`
- Otherwise → `--task` with the text description

## Step 1: Determine Workflow

Use AskUserQuestion to understand what the user wants:

| Workflow | When to use | CLI selector | Outcome |
|----------|------------|--------------|---------|
| `coding/new-task-v1` | Implement a feature, fix a bug, refactor code | `--issue` or `--task` | Creates a branch + opens a PR |
| `coding/pr-iteration-v1` | Address review feedback on an existing PR | `--pr` | Updates the existing PR |
| `coding/pr-review-v1` | Get a structured code review (read-only) | `--review-pr` | Posts review comments |

## Step 2: Collect Task Details

Based on the workflow, gather:

**For `coding/new-task-v1`:**
- Repository (`owner/repo`)
- GitHub issue number (preferred — agent fetches full context) OR text description
- If using text: the desired end state, scope constraints, acceptance criteria

**For `coding/pr-iteration-v1`:**
- Repository (`owner/repo`)
- PR number
- Optional: Additional guidance ("Focus on security feedback only")

**For `coding/pr-review-v1`:**
- Repository (`owner/repo`)
- PR number
- Optional: Review focus ("Check for SQL injection", "Review test coverage")

## Step 3: Prompt Quality Check

Before submitting, validate the prompt against these principles:

**Good prompts:**
- Describe the desired END STATE, not step-by-step instructions
- Are specific about scope (one logical change per task)
- State preconditions and constraints ("Use React 18, not 19")
- Define verifiable goals ("npm test must pass")
- Provide examples when behavior is ambiguous
- Reference relevant files/modules (not specific line numbers)

**Bad prompts (fix these before submitting):**
- Too vague: "Fix the bug" -> "Fix 500 on POST /users when email has plus signs"
- Too prescriptive: "Change line 42" -> "Increase auth timeout to 10s for slow connections"
- Kitchen sink: "Fix login, add dark mode, update README" -> Split into separate tasks
- Missing context: "Make it work like the other service" -> Describe explicitly

If the prompt needs improvement, suggest a rewritten version before submitting.

## Step 4: Set Cost Controls

Recommend appropriate limits based on task complexity:

| Task complexity | Suggested max_turns | Suggested max_budget |
|----------------|--------------------|--------------------|
| Typo/config change | 10-30 | $1-5 |
| Bug fix (clear scope) | 50-100 | $5-20 |
| New feature | 100-200 | $20-50 |
| Large refactor | 200-500 | $50-100 |
| PR iteration | 30-100 | $5-20 |
| PR review | 30-80 | $5-10 |

## Step 5: Submit

**Via CLI (preferred):**
```bash
# From the repo root
node cli/lib/bin/bgagent.js submit \
  --repo owner/repo \
  --issue 42 \
  --max-turns 100 \
  --max-budget 20 \
  --wait  # Optional: poll until completion
```

**CLI flag reference:**
- `--repo owner/repo` (required)
- `--issue N` — GitHub issue number (default workflow: `coding/new-task-v1`)
- `--task "description"` — Text description (default workflow: `coding/new-task-v1`)
- `--pr N` — PR number (`coding/pr-iteration-v1`)
- `--review-pr N` — PR number (`coding/pr-review-v1`)
- `--workflow coding/foo-v1` — Explicit workflow override (optional)
- `--max-turns N` — Turn limit (1-500)
- `--max-budget N` — USD cost limit ($0.01-$100)
- `--idempotency-key KEY` — Deduplication key for safe retries
- `--trace` — Enable detailed tracing (4 KB preview cap + full NDJSON trajectory upload to S3)
- `--wait` — Poll until terminal status
- `--output json|text` — Output format

At least one of `--issue`, `--task`, `--pr`, or `--review-pr` is required.

**Via REST API:**
```bash
curl -X POST "$API_URL/tasks" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "owner/repo",
    "issue_number": 42,
    "workflow_ref": "coding/new-task-v1",
    "max_turns": 100,
    "max_budget_usd": 20
  }'
```

## Step 6: Monitor and Interact

After submission, show how to monitor and steer the task:
```bash
# Watch progress in real time (adaptive polling, auto-exits on terminal state)
node cli/lib/bin/bgagent.js watch <TASK_ID>

# Check status snapshot
node cli/lib/bin/bgagent.js status <TASK_ID>

# Steer the agent mid-run (combined-turn acknowledgement)
node cli/lib/bin/bgagent.js nudge <TASK_ID> "Focus on the auth module first"

# View event log
node cli/lib/bin/bgagent.js events <TASK_ID>

# Download execution trace (requires --trace on submit)
node cli/lib/bin/bgagent.js trace download <TASK_ID>

# List running tasks
node cli/lib/bin/bgagent.js list --status RUNNING
```

Task states: SUBMITTED -> HYDRATING -> RUNNING -> COMPLETED/FAILED/CANCELLED/TIMED_OUT

## Input Mode Quick Reference

- `--issue` only: Issue is well-written with clear requirements
- `--task` only: Ad-hoc work or pre-issue tasks
- `--issue + --task`: Issue context + scope narrowing or extra guidance
- `--pr` only: Address all PR review feedback
- `--pr + --task`: PR feedback + focused scope
- `--review-pr` only: Full structured code review
- `--review-pr + --task`: Focused review on specific concerns
