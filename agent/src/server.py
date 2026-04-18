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

# Log the active event loop policy at import time so operators can diagnose
# uvloop-related subprocess conflicts (see: uvloop SIGCHLD bug).
_policy = asyncio.get_event_loop_policy()
print(
    f"[server] Event loop policy: {type(_policy).__module__}.{type(_policy).__name__}",
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

# Set when the pipeline thread raises after /invocations accepted (Dynamo backup + ping signal).
_background_pipeline_failed = False

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
    """Health check endpoint. Returns 503 if the last background pipeline thread crashed."""
    if _background_pipeline_failed:
        return JSONResponse(
            status_code=503,
            content={
                "status": "unhealthy",
                "reason": "background_pipeline_failed",
            },
        )
    return {"status": "healthy"}


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

    thread = threading.Thread(
        target=_run_task_background,
        kwargs=kwargs,
        name=f"pipeline-{params.get('task_id') or 'anon'}",
    )
    with _threads_lock:
        _active_threads[:] = [t for t in _active_threads if t.is_alive()]
        if not _active_threads:
            _background_pipeline_failed = False
        _active_threads.append(thread)
    thread.start()
    return thread


@app.post("/invocations")
async def invoke_agent(request: Request, body: InvocationRequest):
    """Accept a task. Routes to sync JSON or SSE stream based on Accept header.

    The sync path returns immediately with an acceptance JSON (existing
    orchestrator contract — byte-for-byte preserved). The SSE path streams
    AG-UI events and a terminal RUN_FINISHED/RUN_ERROR when the pipeline
    completes.
    """
    inp = body.input
    params = _extract_invocation_params(inp, request)

    if _wants_sse(request):
        return await _invoke_sse(params)

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


async def _sse_event_stream(sse_adapter: _SSEAdapter, run_id: str):
    """Async generator yielding AG-UI-framed bytes for the StreamingResponse.

    Responsibilities:
    * Emit synthesised ``RUN_STARTED`` first.
    * Drain the adapter's queue, translating each semantic event into one
      or more AG-UI events.
    * Emit ``: ping\\n\\n`` comment frames every 15 s when idle.
    * Emit terminal ``RUN_FINISHED`` or ``RUN_ERROR`` when the close
      sentinel arrives.
    * Tolerate client disconnect: the generator is cancelled cleanly, the
      background pipeline continues, and DDB remains the durable source.
    """
    state = _TranslationState()

    def _frame(obj: dict) -> bytes:
        return f"data: {json.dumps(obj, default=str)}\n\n".encode()

    try:
        # Initial RUN_STARTED — synthesised by the handler, not the adapter.
        yield _frame(make_run_started(run_id))

        while True:
            try:
                item = await asyncio.wait_for(sse_adapter.get(), timeout=_SSE_KEEPALIVE_SECONDS)
            except TimeoutError:
                # Idle keepalive: ``:`` prefix = SSE comment, ignored by EventSource.
                yield b": ping\n\n"
                continue

            if item is None:
                # Close sentinel → emit terminal and exit.
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

            for agui_event in translate(item, state=state):
                yield _frame(agui_event)
    except (asyncio.CancelledError, GeneratorExit):
        # Client disconnected mid-stream. Detach the adapter so the
        # pipeline's enqueues become silent drops; let the background
        # thread keep running — ProgressWriter is still writing to DDB.
        with contextlib.suppress(Exception):
            sse_adapter.detach_loop()
        raise
    except Exception as exc:
        # Never let a stream error kill the background task. Log and
        # terminate the stream cleanly.
        print(
            f"[server] SSE stream error (background task continues): {type(exc).__name__}: {exc}",
            flush=True,
        )
        with contextlib.suppress(Exception):
            sse_adapter.detach_loop()
        return


async def _invoke_sse(params: dict) -> StreamingResponse:
    """Content-type negotiated SSE branch of /invocations."""
    task_id = params["task_id"] or "anon"
    sse_adapter = _SSEAdapter(task_id=task_id)
    loop = asyncio.get_running_loop()
    sse_adapter.attach_loop(loop)

    _spawn_background(params, sse_adapter=sse_adapter)

    headers = {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(
        _sse_event_stream(sse_adapter, run_id=task_id),
        media_type="text/event-stream",
        headers=headers,
    )
