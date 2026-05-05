---
title: Phase 1b rev5 followups
---

# Phase 1b rev-5 — follow-up status

Created 2026-04-21 after the rev-5 multi-agent validation pass. Each item was
surfaced by one of the validators (`[SFH]` silent-failure-hunter, `[CR]`
code-reviewer, `[TDA]` type-design-analyzer, `[PTA]` pr-test-analyzer) or by
the user during review. This document tracks what landed vs what's still
pending, in the order the rev-5 rounds were executed.

## Round summary

| Round | Scope | Commit | Status |
|---|---|---|---|
| Rev-5 core | `bgagent run`, RUN_ELSEWHERE guard, execution_mode propagation, hydration | `022fb88`, `2d9d680` | ✅ |
| Pre-push hardening | P0-a, P0-b, P0-d, P0-e + key nits | `fe84de5` | ✅ |
| Stranded-task reconciler + concurrency raise | P0-c follow-up, MAX_CONCURRENT 3→10 | `9af3b50` | ✅ |
| Round 1 | Correctness: P1-3, P1-1, OBS-4 | `fce9d07` | ✅ |
| Round 2 | Error surfacing: P1-2, P1-5 | `bd7b886` | ✅ |
| Round 3 | Observability: OBS-1/2/3, P1-4 | `0d29939` | ✅ |
| Round 4a | Encapsulation: TDA-1, TDA-2, TDA-6 | `bc56731` | ✅ |
| Round 4b | Shared types: TDA-3, TDA-4, TDA-5 | `228c935` | ✅ |
| Round 5 | Design alignment: POLL-1, DATA-1 | `dfe7b84` | ✅ |
| Round 6 | Housekeeping (this commit) | TBD | in progress |

## ✅ Landed (grouped by round for traceability)

### Rev-5 final (pre-hardening)

- `bgagent run` direct-submit interactive path (`cli/src/commands/run.ts`).
- `execution_mode` end-to-end (CreateTaskRequest, TaskRecord, TaskDetail).
- Server-side RUN_ELSEWHERE guard + TaskTable param hydration.
- Two-runtime ECR pull fix (two `AssetImage.fromAsset` instances to dodge
  the L2 `AssetImage.bind` double-attach guard — see CDK-1 below).
- Client-side transport decision from `snapshot.execution_mode` (AgentCore
  wraps non-2xx as 424; decide on the client instead of parsing the
  wrapped response).

### Pre-push P0 hardening (`fe84de5`)

- **P0-a** `_SSEAdapter.write_agent_error` latent `_dropped_count` →
  `_undelivered_count` fix + regression test.
- **P0-b** `task_state.get_task` distinguishes NotFound (returns `None`,
  fail-open) from FetchFailed (raises `TaskFetchError`; server returns
  503). Prevents duplicate pipelines during DDB blips.
- **P0-d** `bgagent run` wraps `runSse` in try/catch; auto-cancels stranded
  task + emits `bgagent status <task_id>` resume hint + exit non-zero.
- **P0-e** Post-hydration validation returns 500
  `TASK_RECORD_INCOMPLETE` with a list of missing fields.
- Key nits: shared `_stream.ts`, typed `SnapshotResult.executionMode`,
  `TaskDetail.execution_mode` required in CLI, `EXECUTION_MODE_*` string
  constants in server.py, `_HEARTBEAT_INTERVAL_SECONDS`, `logInfo`
  cleanup, v3 diagram.

### Stranded-task reconciler (`9af3b50`) — P0-c

- `cdk/src/constructs/stranded-task-reconciler.ts` + handler
  `cdk/src/handlers/reconcile-stranded-tasks.ts`.
- EventBridge schedule every 5 min, per-mode timeouts (300 s interactive,
  1200 s orchestrator / legacy).
- Transitions stranded tasks to FAILED with
  `STRANDED_NO_HEARTBEAT`, emits `task_stranded` + `task_failed` events,
  decrements concurrency.
- `MAX_CONCURRENT_TASKS_PER_USER` default raised 3 → 10.

### Round 1 — correctness (`fce9d07`)

- **P1-3** — attach-path `subscribe()` exception no longer falls through
  to duplicate-spawn; returns 503 `SSE_ATTACH_RACE`
  (`agent/src/server.py`). Duplicate-pipeline risk closed.
- **P1-1** — 409 on the SSE path is always terminal. RUN_ELSEWHERE →
  fallback; any other 409 → `CliError` with a 500-byte body excerpt.
  Eliminates reconnect-storm on server-side refusals
  (`cli/src/sse-client.ts`).
- **OBS-4** — interactive path records `session_id` on TaskTable via
  new `task_state.write_session_info`; cancel-task Lambda resolves the
  correct runtime ARN from `execution_mode` + two new env vars
  (`RUNTIME_IAM_ARN`, `RUNTIME_JWT_ARN`) to sidestep the CFN cycle that
  would have been created by runtime-self-ARN injection.

### Round 2 — error surfacing (`bd7b886`)

- **P1-2** — post-SSE `getTask` failure now emits `WARN` to stderr with a
  `bgagent status <task_id>` suggestion and suffixes the terminal line
  with `(inferred)`.
- **P1-5** — new `_debug_cw_exc(message, exc, *, task_id)` helper
  formats tracebacks into CloudWatch at every rev-5 bare
  `except Exception` site.

### Round 3 — observability (`0d29939`)

- **OBS-1** — `_emit_sse_route_metric(task_id, route)` writes
  `{event: "SSE_ROUTE", route: "attach"|"spawn"}` to CW stream
  `sse_routing/<task_id>`; called from both `_invoke_sse` branches.
  Enables attach-vs-spawn ratio alarms.
- **OBS-2** — after hydration, always log `post-hydration params:
  populated=[...] origin={k: 'record'|'caller'}`.
- **OBS-3** — structured `event` fields on admission logs
  (`task.admitted.orchestrator_skipped`, `...orchestrator_invoked`,
  `...orchestrator_invoke_failed`).
- **P1-4** — `_debug_cw_failures` counter bumped on daemon-thread
  failures; every 5 failures (and the first) emits
  `{event: "DEBUG_CW_WRITE_FAILURES", count, last_error_type}` via the
  separate sse-routing code path.

### Round 4a — encapsulation (`bc56731`)

- **TDA-1** — `_AdapterRegistry` class owns `_threads_lock` + enforces
  identity-checked pop in one place. Four open-coded sites collapsed to
  `remove_if_current(task_id, adapter)`. `insert` raises on genuine
  conflict.
- **TDA-2** — `_SSEAdapter.subscription()` context manager yields the
  queue and auto-unsubscribes on exit (normal + exception paths). Raw
  `subscribe()`/`unsubscribe()` retained for the
  `_sse_event_stream` handoff to `StreamingResponse`.
- **TDA-6** — Python `ExecutionMode = Literal["orchestrator",
  "interactive"]` + `normalize_execution_mode(raw)` helper for safe
  coercion from DDB/env.

### Round 4b — shared types (`228c935`)

- **TDA-3** — `ApiErrorCode` union + `ApiErrorBody<C>` envelope +
  `isApiError<C>(body, code)` type guard, defined in both
  `cdk/src/handlers/shared/types.ts` and `cli/src/types.ts`. sse-client
  uses the guard in its 409 branch.
- **TDA-4** — cross-file drift detection via
  `cli/test/types-sync.test.ts`. Parses the CDK types.ts source and
  asserts `ExecutionMode` + `ApiErrorCode` unions match the CLI
  canonical list. Bigger `@abca/shared-types` workspace deferred per
  scope.
- **TDA-5** — `SemanticEvent` TypedDict union in
  `agent/src/sse_adapter.py`. Six event shapes declared, each mirroring
  the sibling `ProgressWriter.write_agent_*` dict.

### Round 5 — design alignment (`dfe7b84`)

- **POLL-1** — `watch` polling cadence decays 500 ms → 2 s after 3 min.
  First 3 min matches design §9.13.1; the decay caps REST cost for
  long-running observation.
- **DATA-1** — `TaskResult` gains `turns_attempted` + `turns_completed`
  (clamped to `max_turns` when `error_max_turns`). Legacy `turns` field
  retained as `turns_attempted` value for back-compat.
  `TaskRecord`/`TaskDetail` in CDK + CLI types mirror; `toTaskDetail`
  forwards.

## Non-code follow-ups tracked elsewhere

### ✅ CDK-1 — Upstream bug filed: aws/aws-cdk#37663

`cdk/src/stacks/agent.ts` has a two-artifact workaround:

```ts
const artifactIam = agentcore.AgentRuntimeArtifact.fromAsset(runnerPath);
const artifactJwt = agentcore.AgentRuntimeArtifact.fromAsset(runnerPath);
```

Root cause in `@aws-cdk/aws-bedrock-agentcore-alpha`'s `AssetImage.bind`
method: it guards against double-grant with `this.bound = true`, so
when the same artifact instance is passed to two Runtimes the second
runtime's execution role never receives ECR pull permissions. Image
pull fails with 424 "no basic auth credentials".

Filed upstream at <https://github.com/aws/aws-cdk/issues/37663> with
minimal repro, root-cause analysis, and a suggested fix. The code
comment at `cdk/src/stacks/agent.ts:55-68` now links the issue.
Keep the two-artifact workaround until the upstream fix ships (or
remove it when this repo upgrades to a version that includes the
fix).

### Candidates NOT landed (by design)

- **Full `@abca/shared-types` workspace (bigger TDA-4)** — deferred in
  favour of the drift-detection test. Spin up when a third package
  needs the shared types (e.g., a future SDK package, or if the web
  console moves in-tree).
- **`SemanticEvent` threaded through adapter signatures** — TDA-5
  landed the types; call-site propagation (`_enqueue(event:
  SemanticEvent)` etc.) deferred until we tighten mypy strictness.
- **CLI formatter for `turns_attempted`/`turns_completed`** — DATA-1
  landed the DDB/REST fields; `bgagent status` / `bgagent watch`
  formatters still display just `turns`. UX decision for a separate
  pass (e.g., "6 turns (7 attempted — hit max_turns cap)").

## Status as of this round

All validator-surfaced P0/P1/OBS/TDA/POLL/DATA items are either landed
or explicitly classified as not-in-scope above. CDK-1 is filed
upstream (aws/aws-cdk#37663); the two-artifact workaround stays until
the upstream fix ships.
