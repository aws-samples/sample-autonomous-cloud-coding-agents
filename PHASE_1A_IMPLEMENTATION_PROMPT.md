# Phase 1a Implementation: DynamoDB Progress Events + CLI Watch

## Context

You are working in the ABCA repository (Autonomous Background Coding Agents on AWS) on branch `feature/interactive-background-agents` in worktree `/Users/samcaso/Documents/Repos/2026/aiengineering/abca-worktrees/interactive-agents`.

A comprehensive design document has been completed and committed at `docs/design/INTERACTIVE_AGENTS.md` (1,300 lines). **Read this document first** — specifically Sections 8 (Error Handling), 10 (Implementation Plan, Phase 1a), and Appendix C (File Change Map, Phase 1a). The design was reviewed 3 times (technical gaps, claims verification, codebase validation) and all findings were addressed.

Read `AGENTS.md` for repo conventions, build commands (`mise`), and testing patterns. Read `CLAUDE.md` for project instructions.

## How to work

### Use subagents to parallelize and manage context

- **Research phase:** Before writing code, spawn parallel subagents to read all the "Key files to read" listed below. Do not read them all sequentially in the main context — use subagents to gather summaries and key patterns, then synthesize.
- **Implementation phase:** The agent-side work (`progress_writer.py`, `entrypoint.py` changes, Python tests) and CLI-side work (`watch.ts`, CLI tests, `bgagent.ts` registration) are independent. Implement them in parallel using subagents or worktrees where possible.
- **Testing phase:** Run agent tests and CLI tests in parallel. If one fails, keep working on fixing it while the other suite runs.
- **Keep the main context clean.** Delegate file reading, code exploration, and web research to subagents. Reserve the main context for writing code and making decisions.

### CRITICAL: Do not deviate from the design

The design document (`docs/design/INTERACTIVE_AGENTS.md`) was produced through extensive research, review, and iteration with the project owner. It is the source of truth.

**If you encounter an error, test failure, or technical blocker during implementation:**

1. **DO NOT take shortcuts or change the design to make it work.** Do not silently simplify, skip features, weaken error handling, or alter the architecture to work around a problem.
2. **First, research the problem.** Use the `web-researcher` subagent to search for solutions, check SDK documentation, look for known issues or workarounds that are compatible with the design.
3. **If the design truly cannot work as specified** (e.g., an SDK limitation, a DDB constraint, a Python/TypeScript incompatibility), **surface the blocker explicitly.** Describe:
   - What you tried
   - What failed and why
   - What research you did
   - What the design says vs what reality requires
   - Proposed alternatives (if any) — but do NOT implement them
4. **Wait for explicit approval before changing any design decision.** The project owner will decide whether to amend the design or find a different solution.

This rule applies to ALL aspects: error handling patterns (fail-open/fail-closed), event types, field names, DDB schema, CLI behavior, test patterns. The design was carefully considered — if something seems wrong, it's more likely a misunderstanding than a design error. Ask before changing.

## What to build

Phase 1a is the foundation for interactive agents: the agent writes structured progress events to DynamoDB during execution, and the CLI can display them in near-real-time via polling.

**Zero new AWS infrastructure.** Uses the existing `TaskEventsTable` and existing IAM grants. Zero new auth. Changes only in `agent/` and `cli/`.

## Specific deliverables

### 1. `agent/progress_writer.py` (NEW)

A `_ProgressWriter` class that writes structured AG-UI-style events to the existing DynamoDB `TaskEventsTable`. Follow the same patterns as the existing `_TrajectoryWriter` in `entrypoint.py`:

- Lazy boto3 client initialization
- Best-effort, fail-open (never crash the agent)
- Circuit breaker: disable after 3 consecutive DDB write failures
- Read `TASK_EVENTS_TABLE_NAME` from environment (already set on AgentCore Runtime)
- Each event is a DDB item with: `task_id` (PK), `event_id` (SK, ULID), `event_type`, `metadata` (Map), `timestamp` (ISO 8601), `ttl` (90-day, matching task retention)

Event types to support:

| `event_type` | When emitted | `metadata` |
|---|---|---|
| `agent_turn` | After each `AssistantMessage` | `{turn, model, thinking_preview (200 chars), text_preview (200 chars), tool_calls_count}` |
| `agent_tool_call` | After each `ToolUseBlock` | `{tool_name, tool_input_preview (200 chars), turn}` |
| `agent_tool_result` | After each `ToolResultBlock` | `{tool_name, is_error, content_preview (200 chars), turn}` |
| `agent_milestone` | At key points (repo cloned, tests started, PR created) | `{milestone, details}` |
| `agent_cost_update` | After each `ResultMessage` or periodically | `{cost_usd, input_tokens, output_tokens, turn}` |
| `agent_error` | On errors during execution | `{error_type, message_preview (200 chars)}` |

Truncate all preview fields to prevent oversized DDB items. Use `ulid` for event_id ordering (already a dependency in the agent).

### 2. `agent/entrypoint.py` (MODIFY)

Integrate `_ProgressWriter` into the `run_agent()` function's message loop. The current loop at line ~1380 is:

```python
async for message in client.receive_response():
    if isinstance(message, SystemMessage):
        # ... existing handling
    elif isinstance(message, AssistantMessage):
        # ... existing trajectory writing
    elif isinstance(message, ResultMessage):
        # ... existing result handling
```

Add `progress_writer.write_event(message)` calls alongside the existing `trajectory.write_turn(...)` calls. The ProgressWriter should handle all message type mapping internally — the caller just passes the message.

Also emit `agent_milestone` events at key points in `run_task()`:
- After `setup_repo()`: `{milestone: "repo_setup_complete", details: setup notes}`
- After `run_agent()`: `{milestone: "agent_execution_complete", details: status}`
- After `ensure_pr()`: `{milestone: "pr_created", details: pr_url}`

### 3. `agent/tests/test_progress_writer.py` (NEW)

Unit tests for `_ProgressWriter`:
- Test event formatting for each event type
- Test truncation of preview fields
- Test circuit breaker (3 failures → disabled)
- Test fail-open (DDB write failure doesn't raise)
- Test TTL calculation
- Mock DDB — do NOT make real AWS calls

Follow existing test patterns in `agent/tests/`. Use `pytest`.

### 4. `cli/src/commands/watch.ts` (NEW)

New CLI command: `bgagent watch <task_id>`

Behavior:
- Polls `GET /v1/tasks/{id}/events` every 2 seconds
- Renders events in a readable format (colored, structured)
- Shows: turn number, tool calls, thinking previews, cost running total, milestones
- Exits when task reaches a terminal state (COMPLETED/FAILED/CANCELLED/TIMED_OUT)
- Supports `--output json` for machine-readable output
- Supports Ctrl+C for clean exit

Use the existing `api-client.ts` for HTTP calls and `auth.ts` for authentication. Follow the patterns in existing commands (e.g., `src/commands/events.ts` for fetching events, `src/commands/status.ts` for polling).

Track the last seen `event_id` to avoid re-displaying events. Use the `after` query parameter if the events endpoint supports it, otherwise filter client-side.

### 5. `cli/test/commands/watch.test.ts` (NEW)

Unit tests for the watch command:
- Test event rendering for each event type
- Test polling loop with mock API
- Test terminal state detection and exit
- Test `--output json` mode

### 6. `cli/src/bin/bgagent.ts` (MODIFY)

Register the `watch` command in the CLI program.

## Key files to read before implementing

| File | Why |
|------|-----|
| `agent/entrypoint.py` | The `run_agent()` function (line ~1310) and `_TrajectoryWriter` class (line ~951) — follow the same patterns |
| `agent/task_state.py` | DDB write patterns with fail-open error handling |
| `agent/observability.py` | OTEL span patterns (add a `task.progress_writing` span) |
| `cdk/src/constructs/task-events-table.ts` | DDB table schema (PK: `task_id`, SK: `event_id`) |
| `cdk/src/handlers/get-task-events.ts` | How events are read (the watch command calls this endpoint) |
| `cli/src/commands/events.ts` | Existing events command pattern to follow |
| `cli/src/commands/status.ts` | Existing polling pattern to follow |
| `docs/design/INTERACTIVE_AGENTS.md` | Sections 8.1-8.4 for error handling patterns, Section 10 Phase 1a for scope |

## Constraints

- **Backward compatibility**: Existing fire-and-forget tasks must work unchanged. The ProgressWriter is additive — if it fails, the task still completes normally.
- **No new DDB tables**: Use the existing `TaskEventsTable`. The agent already has `grantReadWriteData` on it.
- **No new auth**: CLI uses existing Cognito JWT. No AgentCore Identity changes.
- **No SSE/WebSocket**: This is pure DDB + REST polling. SSE upgrade is Phase 1b (separate task).
- **Fail-open**: Progress events are observability, not correctness. Never crash the agent for a progress write failure.
- **Use existing deps**: `ulid` is already available in the agent. `boto3` is already available. Don't add new dependencies.

## Testing

Run agent tests: `cd agent && python -m pytest tests/`
Run CLI tests: `cd cli && mise run test`
Full build: `mise run build` (from repo root, with `MISE_EXPERIMENTAL=1`)

## Definition of done

- [ ] `agent/progress_writer.py` with all 6 event types, circuit breaker, fail-open
- [ ] `agent/entrypoint.py` integrated with ProgressWriter (message loop + milestones)
- [ ] `agent/tests/test_progress_writer.py` passing
- [ ] `cli/src/commands/watch.ts` with polling, rendering, terminal state exit
- [ ] `cli/test/commands/watch.test.ts` passing
- [ ] `cli/src/bin/bgagent.ts` updated with watch command
- [ ] All existing tests still pass (`mise run build`)
- [ ] No new AWS resources or IAM changes needed
