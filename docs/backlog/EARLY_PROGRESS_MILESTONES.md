# Backlog: Emit earlier progress milestones during setup phase

> **Status:** Backlog — to be worked in a separate session
> **Severity:** Low — UX enhancement, no correctness impact
> **Discovered:** 2026-04-17 during Phase 1a E2E testing on account `169728770098`

---

## Problem

When a user runs `bgagent watch <task_id>` on a newly submitted task, the watch display shows nothing for ~2 minutes on a cold start. The first progress event (`agent_milestone: repo_setup_complete`) only fires **after** `setup_repo()` completes — which includes container cold start, git clone, dependency install, and baseline build.

Observed timeline from a real E2E test (task `01KPCEW4H131EE3EC5SDQWYQHX`, repo `scoropeza/agent-plugins`):

| Time | Event | Source |
|------|-------|--------|
| 00:53:52 | `task_created` | Orchestrator |
| 00:53:59 | `session_started` | Orchestrator |
| 00:54:00 | Container startup | AgentCore |
| **00:56:09** | **`agent_milestone: repo_setup_complete`** | **Agent (first progress event)** |

Users see an apparently "stuck" task for ~2 minutes despite meaningful work happening (clone, install, build).

## Desired behavior

Emit progress milestones at finer granularity during `run_task()` so users see progress within 1-2 seconds of the agent container starting, and get visibility into each setup sub-phase.

### Proposed milestones (in order)

| Milestone | When emitted | Typical latency from session start |
|-----------|-------------|-----------------------------------|
| `agent_started` | First line of `run_task()`, right after `task_state.write_running()` | < 1s |
| `cloning_repo` | Just before `setup_repo()` → `git clone` | ~1s |
| `repo_cloned` | After `git clone` returns | ~5-20s |
| `installing_dependencies` | Before dep install (if detected) | ~5-25s |
| `dependencies_installed` | After dep install | ~30-90s |
| `running_baseline_build` | Before baseline build/verify | ~30-90s |
| `baseline_build_complete` | After baseline build | ~60-120s |
| `repo_setup_complete` | **(existing)** After `setup_repo()` fully complete | ~120-180s |
| `agent_execution_complete` | **(existing)** After `run_agent()` | varies |
| `pr_created` | **(existing)** After `ensure_pr()` | varies |

### Design notes

- Use the existing `agent_milestone` event type — no new schema, no CDK changes
- `details` field can include sub-phase specifics (e.g., `details="using npm"`, `details="3.2s"`)
- Milestones must be **fail-open** — a write failure during setup should never block setup from continuing (circuit breaker already handles this)
- If `setup_repo()` is called with skipped dep install (e.g., `task_type: pr_review`), emit `dependencies_skipped` instead

## Root cause

`agent/entrypoint.py:run_task()` only emits three milestones:
1. `repo_setup_complete` — after `setup_repo()`
2. `agent_execution_complete` — after `run_agent()`
3. `pr_created` — after `ensure_pr()` (conditional)

The `setup_repo()` function itself (in `entrypoint.py`) has no progress_writer integration — it logs to stdout (`log("SETUP", ...)` and `log("CMD", ...)`) but doesn't emit structured events.

## Files to modify

| File | Change |
|------|--------|
| `agent/entrypoint.py` | Add `progress.write_agent_milestone(...)` calls at the start of `run_task()` and around each sub-phase of `setup_repo()`. Requires passing the `_ProgressWriter` instance into `setup_repo()`, OR calling it from the caller around each step. |
| `agent/tests/test_entrypoint.py` | Add tests verifying milestones are emitted in the expected order (may require splitting `setup_repo` into smaller testable units first). |
| `docs/design/INTERACTIVE_AGENTS.md` | Update the `agent_milestone` metadata table in Section 5 to list the new milestone values. |

## Test cases

### Unit tests — `agent/tests/test_entrypoint.py`

1. **`agent_started` emitted immediately**
   - Mock `setup_repo`, `run_agent`, `ensure_pr` to all succeed
   - Capture progress_writer calls
   - Assert: first call is `agent_milestone` with `milestone="agent_started"` and it occurs before any setup_repo interaction

2. **Milestones emitted in correct order on happy path**
   - Mock all sub-phases with small delays
   - Assert: progress_writer receives the 9 milestones in the expected order (see table above)

3. **Setup failure still emits preceding milestones**
   - Mock `git clone` to succeed but `npm install` to fail
   - Assert: `cloning_repo`, `repo_cloned`, `installing_dependencies` emitted before the failure
   - Assert: `dependencies_installed` NOT emitted
   - Assert: task transitions to FAILED, `agent_error` event emitted

4. **Skipped deps emits `dependencies_skipped`**
   - Config with `task_type: pr_review`
   - Mock setup to skip dep install
   - Assert: `dependencies_skipped` emitted instead of `installing_dependencies`/`dependencies_installed`

5. **Circuit breaker during setup doesn't block setup**
   - Force progress_writer into disabled state (simulate 3 failures)
   - Assert: `setup_repo` still completes successfully
   - Assert: no exception propagates to `run_task`

### Integration smoke test (manual, not automated)

1. Deploy stack with the change
2. Submit a task: `bgagent submit --repo <owner>/<repo> --task "Simple change"`
3. Run `bgagent watch <task_id>` immediately
4. Verify: within 2-5 seconds of the task entering RUNNING, you see `★ agent_started`
5. Verify: cloning_repo → repo_cloned → installing_dependencies → ... milestones appear during the setup phase
6. Verify: `repo_setup_complete` still appears at the end of setup (as before)
7. Verify: no regression in the existing flow (agent completes normally, PR is created)

## Acceptance criteria

- [ ] User sees at least one progress event within 5 seconds of the agent container starting
- [ ] At minimum 6 sub-phase milestones are emitted during the setup phase (not just the final `repo_setup_complete`)
- [ ] Milestones are emitted in a consistent order across runs
- [ ] Failure during any sub-phase still emits preceding milestones + a final `agent_error` event
- [ ] All 5 unit test cases pass
- [ ] Integration smoke test documented and verified
- [ ] No regression to Phase 1a baseline milestones (`repo_setup_complete`, `agent_execution_complete`, `pr_created` still emit as expected)
- [ ] `_ProgressWriter` circuit breaker still works during setup (no hard failures)

## Notes

- This is purely a UX improvement for the watch command. It does not change the task lifecycle, correctness, or any other behavior.
- A related (larger) improvement is AgentCore pre-warming (Iteration 5 in the roadmap). That addresses the root cause — cold start latency — while this addresses the visibility of that latency.
- Consider whether finer-grained progress during `npm install` itself (e.g., piping install progress) is worthwhile. Probably not — structured milestones at phase boundaries are simpler and sufficient.

## Related

- Current milestone emission points: `agent/entrypoint.py` (3 calls in `run_task()`)
- ProgressWriter spec: `agent/progress_writer.py`, design doc Section 5
- Roadmap item for the root cause: "Environment pre-warming (snapshot-on-schedule)" in `docs/guides/ROADMAP.md` (Iteration 5)
