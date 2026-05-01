"""FastAPI server for AgentCore Runtime.

Exposes /invocations (POST) and /ping (GET) on port 8080,
matching the AgentCore Runtime container contract.

The /invocations handler accepts the task, spawns a background thread to run
the pipeline, and returns a small JSON acceptance immediately. Task progress
is tracked in DynamoDB via ``task_state`` + ``ProgressWriter``.
"""

import asyncio
import contextlib as _ctx_for_debug
import logging
import os
import threading
import time as _time_for_debug
import traceback
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import task_state
from config import resolve_github_token
from models import TaskResult
from observability import set_session_id
from pipeline import run_task


def _debug_cw(msg: str, *, task_id: str | None = None) -> None:
    """Write a debug line to a CloudWatch stream in a background thread.

    Mirrors the ``_emit_metrics_to_cloudwatch`` pattern in ``telemetry.py``
    but runs the boto3 work in a daemon thread so the caller is never
    blocked — AgentCore's health check hits the container within ~1 s of
    boot, and synchronous boto3 calls during module import would starve
    uvicorn of the CPU time it needs to bind port 8080 and answer
    ``GET /ping``.

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
    """Like ``_debug_cw`` but also captures the full traceback."""
    tb = traceback.format_exc()
    _debug_cw(f"{message} [{type(exc).__name__}: {exc}]\n{tb}", task_id=task_id)


# --- _debug_cw failure counter -------------------------------------------
# Counts write failures from the daemon thread. AgentCore doesn't forward
# container stdout to APPLICATION_LOGS, so a broken _debug_cw is invisible
# except for this metric.
_debug_cw_failures = 0
_debug_cw_failures_lock = threading.Lock()
_DEBUG_CW_FAILURE_EMIT_EVERY = 5


def _debug_cw_write_blocking(log_group: str, task_id: str | None, stamped: str) -> None:
    """Blocking CloudWatch write — only called from a background thread."""
    try:
        import boto3

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
    except Exception as _exc:
        # Never let debug logging break the request path. Bump the failure
        # counter so operators can alarm on a blind debug path.
        global _debug_cw_failures
        with _debug_cw_failures_lock:
            _debug_cw_failures += 1
        print(
            f"[server/debug/self] CloudWatch write failed: {type(_exc).__name__}: {_exc}",
            flush=True,
        )


# Log the active event loop policy at import time.
# CRITICAL: use plain ``print`` here, NOT ``_debug_cw``, to avoid spawning a
# daemon thread during module import. In-container, that thread's first
# boto3 call contends with uvicorn's startup for the single scarce CPU
# slot and can make ``GET /ping`` return slow enough for AgentCore's
# health-check to fail.
_policy = asyncio.get_event_loop_policy()
print(
    f"[server/debug] boot: event_loop_policy={type(_policy).__module__}.{type(_policy).__name__}",
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
_background_pipeline_failed: bool = False

# Track last reported /ping status so we only emit a CW debug line on
# transitions (avoids flooding logs with per-health-check entries).
_last_ping_status: str = ""

# Heartbeat cadence for the TaskTable ``agent_heartbeat_at`` writer thread.
# Each live pipeline bumps the heartbeat every N seconds so operators can
# distinguish a stuck pipeline from a healthy long-running one.
_HEARTBEAT_INTERVAL_SECONDS = 45


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
      arrive". Load-bearing for long-running tasks.
    * HTTP 503 + ``{"status": "unhealthy", ...}`` — the background pipeline
      thread crashed; the orchestrator's reconciler takes over to transition
      the task to FAILED.
    """
    global _last_ping_status

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
    trace: bool = False,
    user_id: str = "",
) -> None:
    """Run the agent task in a background thread."""
    global _background_pipeline_failed

    _debug_cw(
        f"_run_task_background ENTERED task_id={task_id!r} "
        f"thread={threading.current_thread().name!r}",
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
            trace=trace,
            user_id=user_id,
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


def _extract_invocation_params(inp: dict, request: Request) -> dict:
    """Normalise ``input`` payload into keyword args for ``_run_task_background``."""
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
    # ``trace`` is strictly opt-in (design §10.1). Accept only real
    # booleans from the orchestrator — a string "false" would otherwise
    # flip the flag on.
    trace = inp.get("trace") is True
    # Platform user_id (Cognito ``sub``). Only consumed when ``trace``
    # is true (see ``TaskConfig.user_id``). String check defends against
    # a non-string payload — the agent writes this into an S3 key, so a
    # surprise ``None`` or int would blow up later at upload time.
    # When coercion fires, WARN loudly: a silent empty string combined
    # with ``trace=True`` would make Stage 4's upload path skip the S3
    # write with zero observability, and a user-reported "my trace
    # vanished" investigation would find nothing.
    raw_user_id = inp.get("user_id", "")
    if isinstance(raw_user_id, str):
        user_id = raw_user_id
    else:
        print(
            "[server/warn] user_id payload field is not a string "
            f"(type={type(raw_user_id).__name__}); coerced to empty. "
            f"task_id={inp.get('task_id', '')!r}",
            flush=True,
        )
        user_id = ""

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
        "trace": trace,
        "user_id": user_id,
    }


def _validate_required_params(params: dict) -> list[str]:
    """Check the minimum viable param set for the pipeline.

    Returns the list of missing field names (empty list = valid). The
    pipeline requires at minimum a ``repo_url`` and either an
    ``issue_number`` or ``task_description``; ``pr_iteration`` and
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


def _spawn_background(params: dict) -> threading.Thread:
    """Register and start a background pipeline thread."""
    global _background_pipeline_failed

    kwargs = dict(params)

    thread_name = f"pipeline-{params.get('task_id') or 'anon'}"
    _debug_cw(
        f"_spawn_background: thread_name={thread_name!r}",
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
    """Accept a task. Spawns a background pipeline and returns a JSON acceptance.

    Any ``Accept: text/event-stream`` header is ignored — this runtime no
    longer supports live SSE streaming. Progress is observable via the
    durable DynamoDB records written by ``ProgressWriter``.
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

    # Pre-flight validation: bail out with a structured 400 before spawning a
    # background thread that would crash deep inside setup_repo / hydration.
    missing = _validate_required_params(params)
    if missing:
        _debug_cw(
            f"/invocations rejected: missing required params {missing!r}",
            task_id=params.get("task_id"),
        )
        return JSONResponse(
            status_code=400,
            content={
                "code": "TASK_RECORD_INCOMPLETE",
                "message": (
                    "Task record is missing required fields. The orchestrator "
                    "should have populated these before invoking the runtime."
                ),
                "missing": missing,
            },
        )

    _debug_cw("routing to sync path", task_id=params.get("task_id"))
    _spawn_background(params)
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
