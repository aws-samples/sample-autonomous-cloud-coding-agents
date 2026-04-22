"""FastAPI server for AgentCore Runtime.

Exposes /invocations (POST) and /ping (GET) on port 8080,
matching the AgentCore Runtime container contract.

The /invocations handler accepts the task and either:

* **Sync path** (existing, unchanged): spawns a background thread to run
  the pipeline and returns a small JSON acceptance immediately. Task
  progress is tracked in DynamoDB via ``task_state`` + ``ProgressWriter``.
* **SSE path** (Phase 1b): when the request's ``Accept`` header contains
  ``text/event-stream``, the handler additionally attaches an
  ``_SSEAdapter`` to the pipeline and streams AG-UI-compliant events back
  over a ``text/event-stream`` response. DynamoDB durability is unchanged
  — the SSE stream is ephemeral and parallel to the durable writes.
"""

import asyncio
import contextlib
import json
import logging
import os
import threading
import traceback
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

import task_state
from config import resolve_github_token
from models import TaskResult
from observability import set_session_id
from pipeline import run_task
from sse_adapter import _SSEAdapter
from sse_wire import (
    _TranslationState,
    make_run_error,
    make_run_finished,
    make_run_started,
    translate,
)

# DEBUG LOGGING IS ENABLED BY DEFAULT during Phase 1b development.
# AgentCore Runtime does NOT forward container stdout to APPLICATION_LOGS.
# Only explicit CloudWatch Logs API writes land there (see how
# telemetry.py's _emit_metrics_to_cloudwatch uses boto3). To get debug
# visibility for the SSE path we mirror that pattern via _debug_cw below.
# The print() calls are retained for local docker-compose runs (DDB Local
# flow from agent/docker-compose.yml) where stdout is directly visible.

import contextlib as _ctx_for_debug
import time as _time_for_debug


def _debug_cw(msg: str, *, task_id: str | None = None) -> None:
    """Write a debug line to a CloudWatch stream in a background thread.

    Unconditional (DEBUG LOGGING ENABLED BY DEFAULT for Phase 1b). Mirrors
    the ``_emit_metrics_to_cloudwatch`` pattern in ``telemetry.py`` but runs
    the boto3 work in a daemon thread so the caller is never blocked —
    AgentCore's health check hits the container within ~1 s of boot, and
    synchronous boto3 calls during module import would starve uvicorn of
    the CPU time it needs to bind port 8080 and answer ``GET /ping``.

    Always prints to stdout so local docker-compose runs see the line
    immediately. CloudWatch writes are best-effort fire-and-forget.
    """
    stamped = f"[server/debug] {msg}"
    # Always visible on local stdout.
    print(stamped, flush=True)

    log_group = os.environ.get("LOG_GROUP_NAME")
    if not log_group:
        return

    # Fire-and-forget to avoid blocking the request / event loop.
    _t = threading.Thread(
        target=_debug_cw_write_blocking,
        args=(log_group, task_id, stamped),
        name="debug-cw-write",
        daemon=True,
    )
    _t.start()


def _debug_cw_exc(
    message: str,
    exc: BaseException,
    *,
    task_id: str | None = None,
) -> None:
    """Like ``_debug_cw`` but also captures the full traceback.

    Rev-5 P1-5: bare ``except Exception`` catches in this file previously
    logged only ``type(exc).__name__: exc``. A programming bug in, say,
    hydration (TypeError on a malformed record) would surface without a
    call site, making triage expensive. This helper inlines
    ``traceback.format_exc()`` so operators grepping CloudWatch see the
    full stack.
    """
    tb = traceback.format_exc()
    _debug_cw(f"{message} [{type(exc).__name__}: {exc}]\n{tb}", task_id=task_id)


# --- P1-4: _debug_cw failure counter -------------------------------------
# Counts write failures from the daemon thread. AgentCore doesn't forward
# container stdout to APPLICATION_LOGS, so a broken _debug_cw is invisible
# except for this metric. We expose the count via ``/ping`` and emit a
# structured log line every _DEBUG_CW_FAILURE_EMIT_EVERY failures so the
# dashboard can alarm on it.
_debug_cw_failures = 0
_debug_cw_failures_lock = threading.Lock()
_DEBUG_CW_FAILURE_EMIT_EVERY = 5


def _emit_sse_route_metric(task_id: str, route: str, *, subscriber_count: int | None = None) -> None:
    """Emit an SSE_ROUTE metric so operators can alarm on attach-vs-spawn drift.

    Rev-5 OBS-1: ``route ∈ {'attach', 'spawn'}`` per ``/invocations`` SSE
    call. Attach reuses an adapter already in the registry (same task_id,
    same microVM); spawn creates a new adapter + pipeline.

    Written to CloudWatch Logs as a JSON event (same pattern as
    ``telemetry._emit_metrics_to_cloudwatch``) under log stream
    ``sse_routing/<task_id>`` in ``LOG_GROUP_NAME``. Best-effort from a
    daemon thread so the request path is never blocked.
    """
    if not task_id or route not in ("attach", "spawn"):
        return
    log_group = os.environ.get("LOG_GROUP_NAME")
    if not log_group:
        return
    payload: dict[str, Any] = {
        "event": "SSE_ROUTE",
        "route": route,
        "task_id": task_id,
    }
    if subscriber_count is not None:
        payload["subscriber_count"] = subscriber_count
    threading.Thread(
        target=_emit_sse_route_metric_blocking,
        args=(log_group, task_id, payload),
        name="sse-route-metric",
        daemon=True,
    ).start()


def _emit_sse_route_metric_blocking(log_group: str, task_id: str, payload: dict) -> None:
    try:
        import boto3  # noqa: PLC0415
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = boto3.client("logs", region_name=region)
        stream = f"sse_routing/{task_id}"
        with _ctx_for_debug.suppress(client.exceptions.ResourceAlreadyExistsException):
            client.create_log_stream(logGroupName=log_group, logStreamName=stream)
        import json as _json  # noqa: PLC0415
        import time as _time  # noqa: PLC0415
        client.put_log_events(
            logGroupName=log_group,
            logStreamName=stream,
            logEvents=[{
                "timestamp": int(_time.time() * 1000),
                "message": _json.dumps(payload),
            }],
        )
    except Exception as exc:
        # Best-effort metric emission; never cascade a metric failure.
        print(f"[sse-route-metric] write failed: {type(exc).__name__}: {exc}", flush=True)


def _debug_cw_write_blocking(log_group: str, task_id: str | None, stamped: str) -> None:
    """Blocking CloudWatch write — only called from a background thread."""
    try:
        import boto3  # noqa: PLC0415  (intentional lazy import, mirrors telemetry.py)

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = boto3.client("logs", region_name=region)

        stream = f"server_debug/{task_id or 'server'}"
        with _ctx_for_debug.suppress(client.exceptions.ResourceAlreadyExistsException):
            client.create_log_stream(logGroupName=log_group, logStreamName=stream)

        client.put_log_events(
            logGroupName=log_group,
            logStreamName=stream,
            logEvents=[{"timestamp": int(_time_for_debug.time() * 1000), "message": stamped}],
        )
    except Exception as _exc:  # noqa: BLE001
        # Never let debug logging break the request path. Bump the failure
        # counter (P1-4) so operators can alarm on a blind rev-5 debug
        # path; emit a structured log line every N failures so one appears
        # in APPLICATION_LOGS even if `stamped` writes are broken.
        global _debug_cw_failures
        emit_snapshot: int | None = None
        with _debug_cw_failures_lock:
            _debug_cw_failures += 1
            if _debug_cw_failures == 1 or _debug_cw_failures % _DEBUG_CW_FAILURE_EMIT_EVERY == 0:
                emit_snapshot = _debug_cw_failures
        print(f"[server/debug/self] CloudWatch write failed: {type(_exc).__name__}: {_exc}", flush=True)
        if emit_snapshot is not None:
            # Best-effort: emit a metric to the sse_routing stream (which
            # uses a separate code path, so less likely to be broken the
            # same way).
            try:
                _emit_sse_route_metric_blocking(log_group, task_id or 'server', {
                    "event": "DEBUG_CW_WRITE_FAILURES",
                    "count": _debug_cw_failures,
                    "last_error_type": type(_exc).__name__,
                })
            except Exception:
                pass


# Log the active event loop policy at import time.
# CRITICAL: use plain ``print`` here, NOT ``_debug_cw``, to avoid spawning a
# daemon thread during module import. In-container, that thread's first
# boto3 call contends with uvicorn's startup for the single scarce CPU
# slot and can make ``GET /ping`` return slow enough for AgentCore's
# health-check to fail (observed symptom: 424 "Runtime health check
# failed or timed out" before any request reaches the container). CW
# debug writes are re-enabled by the time the first request arrives.
_policy = asyncio.get_event_loop_policy()
print(
    f"[server/debug] boot: event_loop_policy={type(_policy).__module__}.{type(_policy).__name__} "
    f"sse_adapter_imported=True sse_wire_imported=True",
    flush=True,
)


# Suppress noisy /ping health check access logs from uvicorn
class _PingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return "GET /ping" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_PingFilter())

# Track active background threads for graceful shutdown
_active_threads: list[threading.Thread] = []
_threads_lock = threading.Lock()

# Rev-5 Branch A (design doc §9.13.3): per-microVM registry of active
# ``_SSEAdapter`` instances by ``task_id``. A second SSE invocation for a
# task that already has a running pipeline in THIS microVM attaches to the
# existing adapter via ``subscribe()`` instead of spawning a duplicate
# pipeline. Entries are removed in ``_run_task_background``'s ``finally``.
# Guarded by ``_threads_lock`` — adapter lifecycle is tied to its thread.
_active_sse_adapters: dict[str, _SSEAdapter] = {}

# Set when the pipeline thread raises after /invocations accepted (Dynamo backup + ping signal).
_background_pipeline_failed = False

# Track last reported /ping status so we only emit a CW debug line on
# transitions (avoids flooding logs with per-health-check entries).
_last_ping_status: str = ""

# Keepalive cadence for SSE streams — comment frames keep proxies from timing out.
_SSE_KEEPALIVE_SECONDS = 15.0

# Heartbeat cadence for the TaskTable ``agent_heartbeat_at`` writer thread.
# Each live pipeline bumps the heartbeat every N seconds so operators can
# distinguish a stuck pipeline from a healthy long-running one.
_HEARTBEAT_INTERVAL_SECONDS = 45

# Canonical execution-mode strings. Mirror the TypeScript
# ``ExecutionMode = 'orchestrator' | 'interactive'`` union in
# ``cdk/src/handlers/shared/types.ts`` / ``cli/src/types.ts``. Legacy rows
# (pre-rev-5) have no ``execution_mode`` field and are treated as
# ``EXECUTION_MODE_ORCHESTRATOR`` (preserves Phase 1a behaviour).
EXECUTION_MODE_ORCHESTRATOR = "orchestrator"
EXECUTION_MODE_INTERACTIVE = "interactive"


def _heartbeat_worker(task_id: str, stop: threading.Event) -> None:
    """Periodically refresh ``agent_heartbeat_at`` so the orchestrator can detect crashes."""
    while not stop.wait(timeout=_HEARTBEAT_INTERVAL_SECONDS):
        try:
            task_state.write_heartbeat(task_id)
        except Exception as e:
            print(
                f"[heartbeat] write_heartbeat error (will retry): {type(e).__name__}: {e}",
                flush=True,
            )


def _drain_threads(timeout: int = 300) -> None:
    """Join all active background threads, allowing in-flight tasks to complete."""
    with _threads_lock:
        alive = [t for t in _active_threads if t.is_alive()]
    if not alive:
        return
    print(f"[server] Draining {len(alive)} active thread(s) (timeout={timeout}s)...", flush=True)
    per_thread = max(timeout // len(alive), 10)
    for t in alive:
        t.join(timeout=per_thread)
        if t.is_alive():
            print(f"[server] Thread {t.name} did not finish within {per_thread}s", flush=True)
    still_alive = sum(1 for t in alive if t.is_alive())
    if still_alive:
        print(f"[server] {still_alive} thread(s) still alive after drain", flush=True)
    else:
        print("[server] All threads drained successfully", flush=True)


@asynccontextmanager
async def lifespan(_application: FastAPI):
    """Lifespan event handler — drain threads on shutdown."""
    yield
    _drain_threads()


app = FastAPI(title="Background Agent", version="1.0.0", lifespan=lifespan)


class InvocationRequest(BaseModel):
    input: dict[str, Any]


class InvocationResponse(BaseModel):
    output: dict[str, Any]


@app.get("/ping")
async def ping():
    """Health check endpoint.

    Return shape per AgentCore Runtime Service Contract
    (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html):

    * ``{"status": "healthy"}``      — no work in progress; idle timer counts.
    * ``{"status": "HealthyBusy"}``  — pipeline thread is alive, agent is processing;
      AgentCore treats this as "do not idle-evict me even if no new invocations
      arrive". Load-bearing for long-running tasks that have no active SSE
      watcher (Path 2 orchestrator-spawned flows, §9.13.2).
    * HTTP 503 + ``{"status": "unhealthy", ...}`` — the background pipeline
      thread crashed (Phase 1a contract); the orchestrator's reconciler takes
      over to transition the task to FAILED.
    """
    global _last_ping_status  # noqa: PLW0603

    if _background_pipeline_failed:
        status = "unhealthy"
        if status != _last_ping_status:
            _debug_cw(f"/ping transition: {_last_ping_status or '<init>'} -> {status}")
            _last_ping_status = status
        return JSONResponse(
            status_code=503,
            content={"status": status, "reason": "background_pipeline_failed"},
        )

    with _threads_lock:
        any_alive = any(t.is_alive() for t in _active_threads)

    status = "HealthyBusy" if any_alive else "healthy"
    if status != _last_ping_status:
        _debug_cw(f"/ping transition: {_last_ping_status or '<init>'} -> {status}")
        _last_ping_status = status
    return {"status": status}


def _run_task_background(
    repo_url: str,
    task_description: str,
    issue_number: str,
    github_token: str,
    anthropic_model: str,
    max_turns: int,
    max_budget_usd: float | None,
    aws_region: str,
    task_id: str,
    session_id: str = "",
    hydrated_context: dict | None = None,
    system_prompt_overrides: str = "",
    prompt_version: str = "",
    memory_id: str = "",
    task_type: str = "new_task",
    branch_name: str = "",
    pr_number: str = "",
    cedar_policies: list[str] | None = None,
    sse_adapter: _SSEAdapter | None = None,
) -> None:
    """Run the agent task in a background thread."""
    global _background_pipeline_failed

    _debug_cw(
        f"_run_task_background ENTERED task_id={task_id!r} "
        f"sse_adapter_attached={sse_adapter is not None} thread={threading.current_thread().name!r}",
        task_id=task_id,
    )

    stop_heartbeat = threading.Event()
    hb_thread: threading.Thread | None = None
    if task_id:
        hb_thread = threading.Thread(
            target=_heartbeat_worker,
            args=(task_id, stop_heartbeat),
            name=f"heartbeat-{task_id}",
            daemon=True,
        )
        hb_thread.start()

    try:
        # Propagate session ID into this thread's OTEL context so spans
        # are correlated with the AgentCore session in CloudWatch.
        if session_id:
            set_session_id(session_id)

        run_task(
            repo_url=repo_url,
            task_description=task_description,
            issue_number=issue_number,
            github_token=github_token,
            anthropic_model=anthropic_model,
            max_turns=max_turns,
            max_budget_usd=max_budget_usd,
            aws_region=aws_region,
            task_id=task_id,
            hydrated_context=hydrated_context,
            system_prompt_overrides=system_prompt_overrides,
            prompt_version=prompt_version,
            memory_id=memory_id,
            task_type=task_type,
            branch_name=branch_name,
            pr_number=pr_number,
            cedar_policies=cedar_policies,
            sse_adapter=sse_adapter,
        )
        _background_pipeline_failed = False
    except Exception as e:
        _background_pipeline_failed = True
        print(f"Background task {task_id} failed: {type(e).__name__}: {e}")
        traceback.print_exc()
        if task_id:
            backup = TaskResult(
                status="error",
                error=f"Background pipeline thread: {type(e).__name__}: {e}",
                task_id=task_id,
            )
            task_state.write_terminal(task_id, "FAILED", backup.model_dump())
    finally:
        stop_heartbeat.set()
        if hb_thread is not None and hb_thread.is_alive():
            hb_thread.join(timeout=3)
        # Close the SSE adapter last — pipeline.run_task also closes it,
        # but .close() is idempotent and this belt-and-braces guard ensures
        # the consumer unblocks even if run_task returned via an unexpected
        # path that skipped its own close() (e.g. KeyboardInterrupt).
        if sse_adapter is not None:
            with contextlib.suppress(Exception):
                sse_adapter.close()

        # Rev-5: remove this task's adapter from the per-microVM registry so
        # a future SSE invocation for the same task_id (unlikely after
        # completion, but guards against test re-entry and future restart
        # semantics) takes the spawn path rather than attaching to a closed
        # adapter.
        if task_id:
            with _threads_lock:
                current = _active_sse_adapters.get(task_id)
                if current is sse_adapter:
                    _active_sse_adapters.pop(task_id, None)
                    _debug_cw(
                        f"registry: removed task_id={task_id!r} "
                        f"active_count={len(_active_sse_adapters)}",
                        task_id=task_id,
                    )


def _extract_invocation_params(inp: dict, request: Request) -> dict:
    """Normalise ``input`` payload into keyword args for ``_run_task_background``.

    Pulled out so both the sync and SSE code paths build identical kwargs.
    """
    repo_url = inp.get("repo_url") or os.environ.get("REPO_URL", "")
    github_token = inp.get("github_token") or resolve_github_token()
    issue_number = str(inp.get("issue_number", "")) or os.environ.get("ISSUE_NUMBER", "")
    task_description = (
        inp.get("prompt", "")
        or inp.get("task_description", "")
        or os.environ.get("TASK_DESCRIPTION", "")
    )
    # Fix: orchestrator sends "model_id", not "anthropic_model"
    anthropic_model = (
        inp.get("model_id") or inp.get("anthropic_model") or os.environ.get("ANTHROPIC_MODEL", "")
    )
    system_prompt_overrides = inp.get("system_prompt_overrides", "")
    max_turns = int(inp.get("max_turns", 0)) or int(os.environ.get("MAX_TURNS", "100"))
    max_budget_usd = float(inp.get("max_budget_usd", 0)) or None
    aws_region = inp.get("aws_region") or os.environ.get("AWS_REGION", "")
    task_id = inp.get("task_id", "")
    hydrated_context = inp.get("hydrated_context")
    prompt_version = inp.get("prompt_version", "")
    memory_id = inp.get("memory_id") or os.environ.get("MEMORY_ID", "")
    task_type = inp.get("task_type", "new_task")
    branch_name = inp.get("branch_name", "")
    pr_number = str(inp.get("pr_number", ""))
    cedar_policies = inp.get("cedar_policies") or []

    session_id = request.headers.get("x-amzn-bedrock-agentcore-runtime-session-id", "")

    return {
        "repo_url": repo_url,
        "task_description": task_description,
        "issue_number": issue_number,
        "github_token": github_token,
        "anthropic_model": anthropic_model,
        "max_turns": max_turns,
        "max_budget_usd": max_budget_usd,
        "aws_region": aws_region,
        "task_id": task_id,
        "session_id": session_id,
        "hydrated_context": hydrated_context,
        "system_prompt_overrides": system_prompt_overrides,
        "prompt_version": prompt_version,
        "memory_id": memory_id,
        "task_type": task_type,
        "branch_name": branch_name,
        "pr_number": pr_number,
        "cedar_policies": cedar_policies,
    }


def _validate_required_params(params: dict) -> list[str]:
    """Check the rev-5 interactive SSE path's minimum viable param set.

    Called AFTER TaskTable hydration in ``_invoke_sse``. Returns the list of
    missing field names (empty list = valid). The pipeline requires at
    minimum a ``repo_url`` and either an ``issue_number`` or
    ``task_description`` to have something to do; ``pr_iteration`` and
    ``pr_review`` task_types additionally require ``pr_number``.
    """
    missing: list[str] = []
    if not params.get("repo_url"):
        missing.append("repo_url")
    task_type = params.get("task_type") or "new_task"
    if task_type in ("pr_iteration", "pr_review"):
        if not params.get("pr_number"):
            missing.append("pr_number")
    else:
        # new_task: need EITHER issue_number or task_description.
        has_issue = bool(params.get("issue_number"))
        has_desc = bool(params.get("task_description"))
        if not (has_issue or has_desc):
            missing.append("issue_number_or_task_description")
    return missing


def _wants_sse(request: Request) -> bool:
    """True iff the client requested ``text/event-stream`` via Accept.

    Case-insensitive substring match: matches the bare MIME type as well
    as quality-parameterised values like ``text/event-stream;q=1.0`` or a
    comma-separated list containing ``text/event-stream``. Missing or
    mismatched Accept (incl. ``application/json``, ``*/*``, absent) falls
    back to the synchronous path — preserving existing behaviour exactly.
    """
    accept = request.headers.get("accept", "") or ""
    return "text/event-stream" in accept.lower()


def _spawn_background(params: dict, sse_adapter: _SSEAdapter | None) -> threading.Thread:
    """Register and start a background pipeline thread. Shared by both paths."""
    global _background_pipeline_failed

    kwargs = dict(params)
    kwargs["sse_adapter"] = sse_adapter

    thread_name = f"pipeline-{params.get('task_id') or 'anon'}"
    _debug_cw(
        f"_spawn_background: thread_name={thread_name!r} "
        f"sse_adapter_attached={sse_adapter is not None}",
        task_id=params.get("task_id"),
    )
    thread = threading.Thread(
        target=_run_task_background,
        kwargs=kwargs,
        name=thread_name,
    )
    with _threads_lock:
        _active_threads[:] = [t for t in _active_threads if t.is_alive()]
        if not _active_threads:
            _background_pipeline_failed = False
        _active_threads.append(thread)
    thread.start()
    _debug_cw(
        f"_spawn_background: thread started name={thread_name!r}",
        task_id=params.get("task_id"),
    )
    return thread


@app.post("/invocations")
async def invoke_agent(request: Request, body: InvocationRequest):
    """Accept a task. Routes to sync JSON or SSE stream based on Accept header.

    The sync path returns immediately with an acceptance JSON (existing
    orchestrator contract — byte-for-byte preserved). The SSE path streams
    AG-UI events and a terminal RUN_FINISHED/RUN_ERROR when the pipeline
    completes.
    """
    accept_header = request.headers.get("accept", "") or ""
    session_hdr = request.headers.get("x-amzn-bedrock-agentcore-runtime-session-id", "") or ""
    _debug_cw(
        f"/invocations received: accept={accept_header!r} "
        f"session={session_hdr[:20]!r} body_input_keys={list(body.input.keys())}"
    )

    try:
        inp = body.input
        params = _extract_invocation_params(inp, request)
        _debug_cw(
            f"params extracted: task_id={params.get('task_id')!r} "
            f"repo_url={params.get('repo_url')!r} session_id={params.get('session_id', '')[:20]!r}",
            task_id=params.get("task_id"),
        )
    except Exception as exc:
        _debug_cw_exc("_extract_invocation_params FAILED", exc)
        raise

    if _wants_sse(request):
        _debug_cw("routing to SSE path", task_id=params.get("task_id"))
        try:
            response = await _invoke_sse(params)
            _debug_cw("_invoke_sse returned StreamingResponse", task_id=params.get("task_id"))
            return response
        except Exception as exc:
            _debug_cw_exc("_invoke_sse FAILED", exc, task_id=params.get("task_id"))
            raise

    _debug_cw("routing to sync path", task_id=params.get("task_id"))
    # ----- existing sync path (unchanged behaviour) --------------------
    _spawn_background(params, sse_adapter=None)
    task_id = params["task_id"]
    return JSONResponse(
        content={
            "output": {
                "message": {
                    "role": "assistant",
                    "content": [{"text": f"Task accepted: {task_id}"}],
                },
                "result": {"status": "accepted", "task_id": task_id},
                "timestamp": datetime.now(UTC).isoformat(),
            }
        }
    )


# ---------------------------------------------------------------------------
# SSE path
# ---------------------------------------------------------------------------


async def _sse_event_stream(
    sse_adapter: _SSEAdapter,
    run_id: str,
    sub_queue: "asyncio.Queue[Any]",
):
    """Async generator yielding AG-UI-framed bytes for the StreamingResponse.

    Drains a per-observer subscriber queue (``sub_queue``) — NOT the adapter's
    default queue — so multiple CLI watchers attached to the same pipeline
    (rev-5 multi-subscriber fan-out) each receive the full event stream
    independently.

    Responsibilities:

    * Emit synthesised ``RUN_STARTED`` first.
    * Drain ``sub_queue``, translating each semantic event into one or more
      AG-UI events.
    * Emit ``: ping\\n\\n`` comment frames every 15 s when idle.
    * Emit terminal ``RUN_FINISHED`` or ``RUN_ERROR`` when the close sentinel
      arrives on this observer's queue.
    * Tolerate client disconnect: the generator unsubscribes ITS queue (leaves
      the adapter and other subscribers intact) and the background pipeline
      continues writing to DDB via ProgressWriter.
    """
    _debug_cw(f"_sse_event_stream ENTERED run_id={run_id!r}", task_id=run_id)
    state = _TranslationState()

    def _frame(obj: dict) -> bytes:
        return f"data: {json.dumps(obj, default=str)}\n\n".encode()

    try:
        # Initial RUN_STARTED — synthesised by the handler, not the adapter.
        started_frame = _frame(make_run_started(run_id))
        _debug_cw(
            f"_sse_event_stream about to yield RUN_STARTED ({len(started_frame)} bytes)",
            task_id=run_id,
        )
        yield started_frame
        _debug_cw("_sse_event_stream yielded RUN_STARTED; entering drain loop", task_id=run_id)

        event_count = 0
        ping_count = 0
        while True:
            try:
                raw = await asyncio.wait_for(sub_queue.get(), timeout=_SSE_KEEPALIVE_SECONDS)
            except TimeoutError:
                ping_count += 1
                _debug_cw(f"keepalive ping #{ping_count} (no events in 15s)", task_id=run_id)
                # Idle keepalive: ``:`` prefix = SSE comment, ignored by EventSource.
                yield b": ping\n\n"
                continue

            # Adapter uses a distinguishing close sentinel (object()) — normalise
            # to None here so the rest of the loop treats it uniformly.
            item = None if raw is _adapter_close_sentinel() else raw

            if item is None:
                # Close sentinel → emit terminal and exit.
                _debug_cw(
                    f"close sentinel received; saw_error={state.saw_error} "
                    f"event_count={event_count} ping_count={ping_count}",
                    task_id=run_id,
                )
                if state.saw_error:
                    yield _frame(
                        make_run_error(
                            run_id,
                            code="AgentError",
                            message="Task failed (see prior agent_error event)",
                        )
                    )
                else:
                    yield _frame(make_run_finished(run_id))
                return

            event_count += 1
            agui_events = translate(item, state=state)
            _debug_cw(
                f"event #{event_count}: semantic.type={item.get('type')!r} "
                f"→ {len(agui_events)} AG-UI frame(s)",
                task_id=run_id,
            )
            for agui_event in agui_events:
                yield _frame(agui_event)
    except (asyncio.CancelledError, GeneratorExit):
        # THIS client disconnected. Unsubscribe only our queue — the adapter
        # and any other observers keep running, and the background pipeline
        # keeps writing to DDB via ProgressWriter.
        _debug_cw(
            "_sse_event_stream client disconnect (CancelledError/GeneratorExit)",
            task_id=run_id,
        )
        with contextlib.suppress(Exception):
            sse_adapter.unsubscribe(sub_queue)
        raise
    except Exception as exc:
        # Never let a stream error kill the background task. Log, unsubscribe
        # this observer, and terminate the stream cleanly.
        print(
            f"[server] SSE stream error (background task continues): {type(exc).__name__}: {exc}",
            flush=True,
        )
        traceback.print_exc()
        with contextlib.suppress(Exception):
            sse_adapter.unsubscribe(sub_queue)
        return


def _adapter_close_sentinel() -> Any:
    """Return the adapter module's private close sentinel.

    Kept as a tiny helper so ``_sse_event_stream`` can identify the sentinel
    without reaching into the private name directly at every comparison.
    """
    from sse_adapter import _CLOSE_SENTINEL as sentinel  # noqa: PLC0415
    return sentinel


async def _invoke_sse(params: dict) -> StreamingResponse | JSONResponse:
    """Content-type negotiated SSE branch of /invocations.

    Rev-5 attach-don't-spawn logic (§9.13.3): if this microVM already has a
    running pipeline for ``task_id`` (tracked in ``_active_sse_adapters``),
    the observer subscribes to the existing adapter and returns a
    ``StreamingResponse`` without spawning a new pipeline. Otherwise the
    classic spawn path runs: create adapter → attach loop → register →
    spawn ``run_task`` → return streaming response.
    """
    task_id_arg = params.get("task_id")
    _debug_cw(f"_invoke_sse ENTERED task_id={task_id_arg!r}", task_id=task_id_arg)

    task_id = params["task_id"] or "anon"

    # --- ATTACH path: same-session reconnect or concurrent observer ---------
    with _threads_lock:
        existing = _active_sse_adapters.get(task_id)
    if existing is not None and existing.has_subscribers:
        try:
            sub_queue = existing.subscribe()
            _debug_cw(
                f"attach path: subscribed to existing adapter for task_id={task_id!r} "
                f"subscriber_count={existing.subscriber_count}",
                task_id=task_id,
            )
            _emit_sse_route_metric(task_id, "attach", subscriber_count=existing.subscriber_count)
        except Exception as exc:
            # A live adapter exists (has_subscribers was True) but we
            # couldn't subscribe — likely an adapter-closing race or a
            # queue-lifecycle bug. Do NOT fall through to spawn; that
            # would duplicate the pipeline in this microVM. Return 503
            # so the client retries, by which time the adapter has
            # either finished closing (attach path won't match) or
            # recovered.
            _debug_cw_exc(
                "attach subscribe FAILED; returning 503 to client "
                "for retry (NOT spawning duplicate)",
                exc,
                task_id=task_id,
            )
            return JSONResponse(
                status_code=503,
                content={
                    "code": "SSE_ATTACH_RACE",
                    "message": (
                        "Pipeline adapter is transitioning; retry in a moment."
                    ),
                },
            )
        else:
            headers = {
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            }
            return StreamingResponse(
                _sse_event_stream(existing, run_id=task_id, sub_queue=sub_queue),
                media_type="text/event-stream",
                headers=headers,
            )

    # --- RUN_ELSEWHERE guard (rev 5, §9.13.4) -------------------------------
    # Before spawning a pipeline for ``task_id``, check TaskTable. If the
    # task was submitted with ``execution_mode != 'interactive'`` the
    # orchestrator path is (or was) running it on Runtime-IAM; spawning here
    # would duplicate the pipeline. Return 409 RUN_ELSEWHERE so the CLI's
    # ``--transport auto`` can fall back to polling.
    #
    # IMPORTANT: `get_task` returning ``None`` means "record not found"
    # (fail-open for blueprints / legacy tasks predating rev 5). If DDB
    # itself fails we fail CLOSED with 503: treating a transient fetch
    # failure as "no record → spawn" would duplicate pipelines whenever DDB
    # is slow or throttling.
    if task_id and task_id != "anon":
        try:
            record = task_state.get_task(task_id)
        except task_state.TaskFetchError as exc:
            _debug_cw(
                f"RUN_ELSEWHERE guard: TaskTable fetch FAILED "
                f"({exc}) — returning 503 so client retries",
                task_id=task_id,
            )
            return JSONResponse(
                status_code=503,
                content={
                    "code": "TASK_STATE_UNAVAILABLE",
                    "message": (
                        "Could not verify task execution_mode; retry shortly."
                    ),
                },
            )
        if record is not None:
            existing_mode = record.get("execution_mode") or EXECUTION_MODE_ORCHESTRATOR
            if existing_mode != EXECUTION_MODE_INTERACTIVE:
                _debug_cw(
                    f"RUN_ELSEWHERE: task_id={task_id!r} execution_mode="
                    f"{existing_mode!r} — returning 409 so client falls back to polling",
                    task_id=task_id,
                )
                return JSONResponse(
                    status_code=409,
                    content={
                        "code": "RUN_ELSEWHERE",
                        "message": (
                            "Task is running (or was submitted to run) on a "
                            "different runtime. Use polling to observe progress."
                        ),
                        "execution_mode": existing_mode,
                    },
                )

            # --- Hydrate params from TaskTable (rev 5, §9.13.4) -----------
            # The CLI's SSE body only carries ``{task_id}``; the full set of
            # pipeline inputs (repo_url, task_description, issue_number,
            # max_turns, max_budget_usd, task_type, branch_name, pr_number)
            # must come from TaskTable when the CLI drove admission. Fill
            # any missing fields; never overwrite a value the caller did
            # pass (orchestrator path preserves its existing contract).
            hydrated_from_record: dict = {}
            if not params.get("repo_url") and record.get("repo"):
                params["repo_url"] = record["repo"]
                hydrated_from_record["repo_url"] = record["repo"]
            if not params.get("task_description") and record.get("task_description"):
                params["task_description"] = record["task_description"]
                hydrated_from_record["task_description"] = "<present>"
            if not params.get("issue_number") and record.get("issue_number") is not None:
                params["issue_number"] = str(record["issue_number"])
                hydrated_from_record["issue_number"] = params["issue_number"]
            if not params.get("max_turns") and record.get("max_turns"):
                params["max_turns"] = int(record["max_turns"])
                hydrated_from_record["max_turns"] = params["max_turns"]
            if params.get("max_budget_usd") in (None, 0, 0.0) and record.get("max_budget_usd") is not None:
                params["max_budget_usd"] = float(record["max_budget_usd"])
                hydrated_from_record["max_budget_usd"] = params["max_budget_usd"]
            if not params.get("task_type") or params.get("task_type") == "new_task":
                if record.get("task_type"):
                    params["task_type"] = record["task_type"]
                    hydrated_from_record["task_type"] = record["task_type"]
            if not params.get("branch_name") and record.get("branch_name"):
                params["branch_name"] = record["branch_name"]
                hydrated_from_record["branch_name"] = record["branch_name"]
            if not params.get("pr_number") and record.get("pr_number") is not None:
                params["pr_number"] = str(record["pr_number"])
                hydrated_from_record["pr_number"] = params["pr_number"]
            if hydrated_from_record:
                _debug_cw(
                    f"hydrated {len(hydrated_from_record)} params from TaskTable: "
                    f"{sorted(hydrated_from_record.keys())}",
                    task_id=task_id,
                )
            # OBS-2: always log the post-hydration keyset (non-empty fields)
            # + hydration origin for each so "ran with wrong repo" triage
            # can distinguish a hydration miss from a wrong caller value.
            populated_keys = sorted(k for k, v in params.items() if v not in (None, "", 0, 0.0, []))
            origin = {k: ("record" if k in hydrated_from_record else "caller") for k in populated_keys}
            _debug_cw(
                f"post-hydration params: populated={populated_keys} origin={origin}",
                task_id=task_id,
            )

            # --- Record session + runtime ARN on TaskTable (rev 5, OBS-4)
            # The orchestrator Lambda writes these fields for Runtime-IAM
            # tasks; the interactive path has no Lambda in the loop, so
            # we write them here just before spawning. Consumed by
            # `cancel-task` (StopRuntimeSession needs both the runtime ARN
            # and the session id) and by the stranded-task reconciler.
            interactive_session_id = params.get("session_id") or ""
            interactive_runtime_arn = os.environ.get("AGENT_RUNTIME_ARN", "") or ""
            if interactive_session_id or interactive_runtime_arn:
                task_state.write_session_info(
                    task_id,
                    interactive_session_id,
                    interactive_runtime_arn,
                )
                _debug_cw(
                    f"wrote session_info to TaskTable: session_id="
                    f"{interactive_session_id!r} runtime_arn="
                    f"{interactive_runtime_arn!r}",
                    task_id=task_id,
                )

            # --- Post-hydration validation (rev 5, §9.13.4) --------------
            # After hydration completes, the pipeline still needs a minimum
            # viable parameter set. Validate here so users see a crisp
            # TASK_RECORD_INCOMPLETE error instead of a cryptic git-clone
            # failure three stack frames into ``setup_repo``.
            missing_fields = _validate_required_params(params)
            if missing_fields:
                _debug_cw(
                    f"TASK_RECORD_INCOMPLETE: task_id={task_id!r} "
                    f"missing={missing_fields!r}",
                    task_id=task_id,
                )
                return JSONResponse(
                    status_code=500,
                    content={
                        "code": "TASK_RECORD_INCOMPLETE",
                        "message": (
                            "Task record is missing required fields after "
                            "hydration. This is a server-side data consistency "
                            "issue; please retry or contact an operator."
                        ),
                        "missing": missing_fields,
                    },
                )

    # --- SPAWN path: no pipeline running for this task_id in this microVM ---
    try:
        sse_adapter = _SSEAdapter(task_id=task_id)
        _debug_cw(f"_SSEAdapter constructed for {task_id!r}", task_id=task_id)
    except Exception as exc:
        _debug_cw_exc("_SSEAdapter construction FAILED", exc, task_id=task_id)
        raise

    try:
        loop = asyncio.get_running_loop()
        sse_adapter.attach_loop(loop)
        _debug_cw(f"attached asyncio loop: {type(loop).__name__}", task_id=task_id)
    except Exception as exc:
        _debug_cw_exc("attach_loop FAILED", exc, task_id=task_id)
        raise

    # Register the adapter BEFORE spawning so a rapid reconnect race (unlikely
    # but possible when AgentCore retries quickly) attaches to the existing
    # adapter instead of double-spawning.
    with _threads_lock:
        _active_sse_adapters[task_id] = sse_adapter
    _debug_cw(
        f"registry: inserted task_id={task_id!r} "
        f"active_count={len(_active_sse_adapters)}",
        task_id=task_id,
    )

    # Subscribe THIS observer's queue BEFORE spawning the pipeline so no
    # events are missed between spawn and first drain iteration.
    try:
        sub_queue = sse_adapter.subscribe()
    except Exception as exc:
        _debug_cw_exc("subscribe FAILED in spawn path", exc, task_id=task_id)
        # Roll back the registry insert on failure.
        with _threads_lock:
            if _active_sse_adapters.get(task_id) is sse_adapter:
                _active_sse_adapters.pop(task_id, None)
        raise

    try:
        _spawn_background(params, sse_adapter=sse_adapter)
        _debug_cw(f"background thread spawned for task_id={task_id!r}", task_id=task_id)
        _emit_sse_route_metric(task_id, "spawn")
    except Exception as exc:
        _debug_cw_exc("_spawn_background FAILED", exc, task_id=task_id)
        # Roll back the registry insert on spawn failure.
        with _threads_lock:
            if _active_sse_adapters.get(task_id) is sse_adapter:
                _active_sse_adapters.pop(task_id, None)
        raise

    headers = {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    _debug_cw(
        f"returning StreamingResponse for task_id={task_id!r} "
        f"media_type=text/event-stream headers={list(headers.keys())}",
        task_id=task_id,
    )
    return StreamingResponse(
        _sse_event_stream(sse_adapter, run_id=task_id, sub_queue=sub_queue),
        media_type="text/event-stream",
        headers=headers,
    )
