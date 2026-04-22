# Phase 1b rev-5 — deferred follow-ups

Created 2026-04-21 after the rev-5 multi-agent validation pass. Each item is a
concrete, scoped piece of work that did **not** land in the rev-5 PR.

Items are tagged with the validator that surfaced them:
- `[SFH]` = `silent-failure-hunter`
- `[CR]` = `code-reviewer`
- `[TDA]` = `type-design-analyzer`
- `[PTA]` = `pr-test-analyzer`

Priority is the team's call (no SLA implied). `P0` here means "the rev-5 PR
shipped without it because the ordinary case is handled elsewhere"; it does
not mean "fix today."

---

## ✅ Stranded-task reconciler (P0-c) — LANDED

Shipped alongside this rev-5 PR as a separate construct
(`cdk/src/constructs/stranded-task-reconciler.ts`) + handler
(`cdk/src/handlers/reconcile-stranded-tasks.ts`).

- Runs every 5 minutes on an EventBridge schedule.
- Queries `TaskTable.StatusIndex` for `status IN (SUBMITTED, HYDRATING)` with
  `created_at < cutoff`.
- Per-row per-mode threshold: 300 s for interactive, 1200 s for orchestrator
  (including legacy rows without `execution_mode`). Configurable via Lambda
  env vars.
- Transitions to `FAILED` with `error_message="Stranded: ... no pipeline
  attached before timeout"`, emits `task_stranded` + `task_failed` events
  (the `task_stranded` event carries `{code: 'STRANDED_NO_HEARTBEAT',
  prior_status, execution_mode, age_seconds}`), and decrements the user's
  concurrency counter.
- Idempotent: conditional UpdateItem on `status = :expected` means a
  concurrent legitimate transition wins.

RUNNING / FINALIZING are NOT handled here — `pollTaskStatus` in
`orchestrator.ts` already transitions those to TIMED_OUT via the
`agent_heartbeat_at` path. This reconciler only catches the "never
started" case.

---

## ✅ MAX_CONCURRENT_TASKS_PER_USER: 3 → 10 — LANDED

Default raised in `cdk/src/constructs/task-orchestrator.ts:163` after the
live concurrency-limit incident during E2E-B retry (two stranded
interactive tasks occupied the user's 3 slots, admission-rejected a legit
submit). The stranded-task reconciler above prevents slot accumulation, so
the bump is ergonomic rather than load-bearing. Test updated.

---

## Silent-failure hardening

### P1-1 — sse-client: 409 non-JSON bodies fall through to reconnect — [SFH]
`cli/src/sse-client.ts:589-612` currently logs nothing and treats a 409 whose
body is not JSON as a generic retryable HTTP error. Should always surface the
body (truncated) at `logError` and make 409 terminal-by-default for SSE.

### P1-2 — getTask post-SSE failure silently infers status — [SFH]
`cli/src/commands/watch.ts:616-629` only `debug()`-logs when the final
authoritative-status lookup fails; the user sees `Task completed.` + exit 0
even if REST is down. Promote to `logWarn` with a `bgagent status <task_id>`
retry hint.

### P1-3 — Attach-path subscribe() failure → falls through to spawn — [SFH]
`agent/src/server.py:655-667`: if `has_subscribers=True` but `subscribe()`
raises (adapter closing race, queue full), we currently spawn a second
pipeline for the same task_id. Should return 503 with a retry hint instead.

### P1-4 — `_debug_cw` daemon-thread failures lost in production — [SFH]
`agent/src/server.py:90-109`. Container stdout is not forwarded to
APPLICATION_LOGS on AgentCore, so a broken `_debug_cw` is invisible. Emit a
counter via the telemetry path (`debug_cw_write_failures`) so we can alarm on
a blind rev-5 code path.

### P1-5 — broad `except Exception` loses tracebacks — [SFH]
`agent/src/server.py:662, 691, 762, 771, 791, 805`. Every rev-5 try-block
catches everything and logs only the exception type + message. Include
`traceback.format_exc()` in `_debug_cw` output; narrow to
`(ClientError, BotoCoreError)` where only a boto-specific branch is
expected.

---

## Type-design refactors — [TDA]

These are correctness-preserving but will pay dividends on long-term drift.

### TDA-1 — `_active_sse_adapters` → `_AdapterRegistry` class
`agent/src/server.py`. Today a bare `dict` at module scope with three
open-coded identity-checked pop sites and invariants-by-comment. Wrap behind
a small class that owns `_threads_lock` and exposes
`insert / remove_if_current / get`. Makes the invariants structural.

### TDA-2 — `_SSEAdapter.subscribe()` → subscription handle / context manager
`agent/src/sse_adapter.py`. Returning a raw `asyncio.Queue` requires callers
to remember `unsubscribe(queue)` with the exact same object. A `with
adapter.subscribe() as queue:` pattern (or a `Subscription` dataclass with
`__enter__`/`__exit__`) would make unsubscription structural. Also: decide
whether to keep the legacy `get()` + default-subscriber path or remove it
entirely.

### TDA-3 — Shared `ApiErrorBody<Code>` envelope
`cdk/src/handlers/shared/types.ts` + `cli/src/types.ts` + `agent/src/server.py`.
Today the `RUN_ELSEWHERE` response is an ad-hoc dict on the server and parsed
via an ad-hoc shape on the client. Introduce a typed envelope so `code`
strings are a union and `execution_mode` in the details is typed. Second ad-hoc
error shape in the project; a shared type would prevent the third.

### TDA-4 — `ExecutionMode` single source of truth
`cdk/src/handlers/shared/types.ts` + `cli/src/types.ts`. Already flagged in
AGENTS.md as "must stay in sync" but the duplication remains. Spin up a tiny
`@abca/shared-types` workspace (or codegen) so future variants can't drift.

### TDA-5 — `_SSEAdapter` event dicts → `SemanticEvent` TypedDict union
`agent/src/sse_adapter.py`. `_enqueue(event: dict)` + `get() -> dict | None`
use bare dicts for a closed set of semantic event shapes. A TypedDict union
(or frozen dataclasses) would make parity with `ProgressWriter` compile-
checkable.

### TDA-6 — Python-side `ExecutionMode` Literal + normalizer
`agent/src/server.py`. `record.get("execution_mode") or "orchestrator"` is
stringly-typed. Introduce
`ExecutionMode = Literal["orchestrator", "interactive"]` and a single
`normalize_execution_mode(raw) -> ExecutionMode` helper (returning the
"orchestrator" legacy default).

---

## Observability gaps

### OBS-1 — Metric for attach-vs-spawn ratio — [SFH P2-3]
`agent/src/server.py`. Emit counters (`sse.attach.count`, `sse.spawn.count`)
so a regression (always spawning, or attaching to a dead adapter) is
alarmable.

### OBS-2 — Post-hydration full-param keyset log — [SFH P2-2]
`agent/src/server.py:751-756`. Today we log which fields hydration TOUCHED;
we don't log the final full keyset. When triaging "ran with wrong repo" we
can't tell whether hydration overwrote a CLI value or CLI passed a wrong
one.

### OBS-3 — Stable event name on admission log — [SFH P2-1]
`cdk/src/handlers/shared/create-task-core.ts:267-287`. Free-text "Admission:
interactive mode, orchestrator invoke skipped" has no stable filter key; add
a `event: 'task.admitted.orchestrator_skipped'` field.

### OBS-4 — TaskTable writes for interactive path — [self-identified]
`agent/src/server.py`. The orchestrator path writes `session_id` and
`agent_runtime_arn` on the TaskTable record; the interactive path does NOT.
Needed for cancellation (`StopRuntimeSession`) and cross-runtime observability
in Phase 1c. Small add in `_run_task_background`: write both fields when
`sse_adapter is not None`.

---

## Data-shape clarity

### DATA-1 — `turns` DDB field: split into `turns_attempted` + derived `turns_completed` — [user 2026-04-21]
`agent/src/pipeline.py:423` writes `turns = agent_result.num_turns or agent_result.turns` to TaskTable. The SDK reports `num_turns = max_turns + 1` when the abort happens on the cap check — i.e., `turns=7` when `max_turns=6` is cleanly honored. Operators asking "why is `turns=7` when I asked for 6?" reasonably expect the field to mean completed turns.

**Proposed:**
- Rename the DDB column to `turns_attempted` (faithful to what the SDK gives us — counts the check that fired the cap).
- Derive a `turns_completed` at read time (or at write time): `turns_attempted - (1 if agent_status == 'error_max_turns' else 0)`. For non-cap terminations, `attempted == completed`.
- Propagate through `TaskDetail` (CDK side) + CLI `types.ts` + watch/run formatters + docs + dashboards.
- Backfill strategy for existing rows: write both fields going forward; read-time code tolerates old rows where only `turns` is present (treat as `turns_attempted`).

**Why deferred:** rename is a cross-cutting churn (TaskTable shape, TaskDetail contract, CLI types, dashboard widgets, tests). Not a correctness bug — just a naming mismatch between SDK semantics and user expectation.

## Polling and performance

### POLL-1 — Polling interval 2 s → 500 ms — [design deviation D2]
`cli/src/commands/watch.ts:36`. Design §9.13.1 said 500 ms for the polling
fallback; we kept 2 s from Phase 1a. Evaluate whether 500 ms is worth the
API Gateway / REST load increase; may be fine given the fan-out is
per-observer and most tasks complete in minutes. If yes, also consider
decaying from 500 ms → 2 s after N minutes to cap cost.

---

## CDK / infra hygiene

### CDK-1 — File upstream bug for `AssetImage.bind` double-attach — [self]
`cdk/src/stacks/agent.ts:55-65`. The two-artifact workaround references
`<check>` as a placeholder for the upstream issue link. File the issue
against `@aws-cdk/aws-bedrock-agentcore-alpha` (or the containing repo) and
update the comment with the real URL.

### CDK-2 — Assert ECR pull perms on both runtime roles in CDK tests — [PTA]
`cdk/test/stacks/agent.test.ts`. The current 37 tests would still pass if we
reverted to a single `AssetImage.fromAsset`. Add a test that asserts each of
`RuntimeExecutionRole` and `RuntimeJwtExecutionRole` carries
`ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`,
`ecr:BatchCheckLayerAvailability`, and `ecr:GetAuthorizationToken` scoped to
the asset repo.

---

## Done — landed in rev-5 final PR

These items were surfaced by the validators and addressed inline:

- **P0-a** `_SSEAdapter.write_agent_error` references non-existent
  `_dropped_count` → `_undelivered_count` fix. One line +
  `test_write_agent_error_fallback_uses_undelivered_counter`.
- **P0-b** `task_state.get_task` conflated NotFound with FetchFailed →
  introduce explicit `TaskFetchError` / `TaskNotFound` distinction; server.py
  RUN_ELSEWHERE guard returns 503 on FetchFailed instead of falling through
  to spawn (avoids duplicate pipelines during DDB blips).
- **P0-d** `bgagent run` wrapped `runSse` in try/catch; emits task_id +
  `bgagent watch <task>` resume hint + cancels the task on CLI-side fatal
  error + fetches final status before exit.
- **P0-e** Post-hydration validation in `_invoke_sse`: asserts minimum viable
  params for the task_type and returns a 500 with
  `{"code": "TASK_RECORD_INCOMPLETE", "missing": [...]}` on failure — user
  sees a clear error instead of a git-clone failure five frames deep.
- **Key nits** — `validateStreamTimeout` + `DEFAULT_STREAM_TIMEOUT_SECONDS`
  lifted to `cli/src/commands/_stream.ts`; `SnapshotResult.executionMode`
  typed as `ExecutionMode | null`; `TaskDetail.execution_mode` required in
  CLI to match CDK; `EXECUTION_MODE_INTERACTIVE`/`ORCHESTRATOR` constants in
  `server.py`; no-op `if/else` in `watch.ts logInfo` removed; heartbeat
  interval extracted to `_HEARTBEAT_INTERVAL_SECONDS`; `run.ts` `logInfo`
  signature aligned with `watch.ts`; `Verbose mode:` line gated on
  `isVerbose()`.
- **Tests added** — hydration-fills-missing-params +
  hydration-explicit-wins-over-record; SIGINT-propagation-through-runSse;
  createTask-succeeds-SSE-fails-immediately; ECR-pull-perms-on-both-runtime-
  roles.
