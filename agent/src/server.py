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
        # Never let debug logging break the request path.
        print(f"[server/debug/self] CloudWatch write failed: {type(_exc).__name__}: {_exc}", flush=True)


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


def _heartbeat_worker(task_id: str, stop: threading.Event) -> None:
    """Periodically refresh ``agent_heartbeat_at`` so the orchestrator can detect crashes."""
    while not stop.wait(timeout=45):
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
        _debug_cw(f"_extract_invocation_params FAILED: {type(exc).__name__}: {exc}")
        traceback.print_exc()
        raise

    if _wants_sse(request):
        _debug_cw("routing to SSE path", task_id=params.get("task_id"))
        try:
            response = await _invoke_sse(params)
            _debug_cw("_invoke_sse returned StreamingResponse", task_id=params.get("task_id"))
            return response
        except Exception as exc:
            _debug_cw(
                f"_invoke_sse FAILED: {type(exc).__name__}: {exc}",
                task_id=params.get("task_id"),
            )
            traceback.print_exc()
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


async def _invoke_sse(params: dict) -> StreamingResponse:
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
        except Exception as exc:
            _debug_cw(
                f"attach subscribe FAILED ({type(exc).__name__}: {exc}); falling through to spawn",
                task_id=task_id,
            )
            # Fall through to spawn below.
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

    # --- SPAWN path: no pipeline running for this task_id in this microVM ---
    try:
        sse_adapter = _SSEAdapter(task_id=task_id)
        _debug_cw(f"_SSEAdapter constructed for {task_id!r}", task_id=task_id)
    except Exception as exc:
        _debug_cw(f"_SSEAdapter construction FAILED: {type(exc).__name__}: {exc}", task_id=task_id)
        traceback.print_exc()
        raise

    try:
        loop = asyncio.get_running_loop()
        sse_adapter.attach_loop(loop)
        _debug_cw(f"attached asyncio loop: {type(loop).__name__}", task_id=task_id)
    except Exception as exc:
        _debug_cw(f"attach_loop FAILED: {type(exc).__name__}: {exc}", task_id=task_id)
        traceback.print_exc()
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
        _debug_cw(
            f"subscribe FAILED in spawn path: {type(exc).__name__}: {exc}",
            task_id=task_id,
        )
        # Roll back the registry insert on failure.
        with _threads_lock:
            if _active_sse_adapters.get(task_id) is sse_adapter:
                _active_sse_adapters.pop(task_id, None)
        raise

    try:
        _spawn_background(params, sse_adapter=sse_adapter)
        _debug_cw(f"background thread spawned for task_id={task_id!r}", task_id=task_id)
    except Exception as exc:
        _debug_cw(f"_spawn_background FAILED: {type(exc).__name__}: {exc}", task_id=task_id)
        traceback.print_exc()
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
