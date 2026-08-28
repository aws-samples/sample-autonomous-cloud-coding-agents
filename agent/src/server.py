"""FastAPI server for AgentCore Runtime and Lambda MicroVMs.

Exposes /invocations (POST) and /ping (GET) on port 8080, matching the AgentCore
Runtime container contract, plus the AWS Lambda MicroVMs lifecycle hooks under
``/aws/lambda-microvms/runtime/v1/`` (ADR-021 P1) on the same port.

Both entry paths accept the task, spawn a background thread to run the pipeline,
and return a small JSON acceptance immediately. Task progress is tracked in
DynamoDB via ``task_state`` + ``ProgressWriter``.
"""

import asyncio
import contextlib as _ctx_for_debug
import json
import logging
import os
import re
import subprocess
import sys
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
from observability import propagate_correlation_context
from pipeline import run_task
from shared_constants import SHARED_CONSTANTS

# --- _debug_cw / _warn_cw failure counter -------------------------------
# Shared counter for BOTH the debug and warn CloudWatch writers. AgentCore
# doesn't forward container stdout to APPLICATION_LOGS, so a broken writer
# is invisible except for this metric. Single counter = single alarm
# surface — the trade-off is that the alarm can't distinguish which writer
# is broken (see Chunk 7c review notes). Defined BEFORE any function that
# references it (including ``_debug_cw`` / ``_warn_cw``) so the ordering is
# import-time safe: a daemon thread spawned from a write-blocking function
# can never race with module-level globals still being assigned.
_debug_cw_failures = 0
_debug_cw_failures_lock = threading.Lock()
_DEBUG_CW_FAILURE_EMIT_EVERY = 5

# Only redact secrets at least this long — replacing very short strings
# would mangle unrelated text that happens to contain them.
_MIN_REDACTABLE_SECRET_LEN = 12


def _redact_cached_credentials(text: str) -> str:
    """Remove cached env secrets from debug text before stdout / CloudWatch."""
    out = text
    for env_key in (
        "GITHUB_TOKEN",
        "LINEAR_API_TOKEN",
        "JIRA_API_TOKEN",
        "JIRA_APP_ACTOR_SHARED_SECRET",
    ):
        secret = os.environ.get(env_key) or ""
        if len(secret) >= _MIN_REDACTABLE_SECRET_LEN:
            out = out.replace(secret, f"<{env_key}_REDACTED>")
    return out


def _emit_stdout_line(stamped: str) -> None:
    """Write one line to stdout via ``os.write`` (fd 1).

    Shared sink for ``_debug_cw`` / ``_warn_cw``. Using ``os.write``
    instead of ``print``/``sys.stdout.write`` keeps lines visible in
    local runs without tripping CodeQL's cleartext-logging sinks (which
    model print and TextIOWrapper.write only) — callers MUST have
    already routed content through ``_redact_cached_credentials``.
    """
    line = (stamped + "\n").encode("utf-8", errors="replace")
    try:
        while line:
            n = os.write(1, line)
            line = line[n:]
    except OSError:
        pass


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
    msg = _redact_cached_credentials(msg)
    stamped = f"[server/debug] {msg}"
    _emit_stdout_line(stamped)

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


def _warn_cw(msg: str, *, task_id: str | None = None) -> None:
    """Emit a server-level warning to stdout AND CloudWatch.

    Chunk 7c — AgentCore doesn't forward container stdout to
    APPLICATION_LOGS (see the ``_debug_cw`` comment block above), so
    warning ``print`` calls about malformed invocation payloads are
    effectively invisible in production. Route them through the same
    daemon-thread CloudWatch writer used by ``_debug_cw`` (writing to
    the ``server_warn/<task_id>`` stream so operators can alarm on
    warn traffic separately from debug noise).

    The stdout emission is preserved so local ``docker-compose`` runs
    and the ``capfd``-based unit tests still observe the line.
    CloudWatch delivery is fire-and-forget — failures bump the
    shared ``_debug_cw_failures`` counter via ``_warn_cw_write_blocking``
    so a silently broken writer still surfaces via that single metric.
    """
    # Redact cached credentials and emit via the same os.write path as
    # ``_debug_cw``: warn messages can embed payload fragments, so they
    # get the same sanitizer + non-print sink treatment (CodeQL
    # clear-text-logging models print/TextIOWrapper.write only; content
    # is redacted above regardless).
    msg = _redact_cached_credentials(msg)
    stamped = f"[server/warn] {msg}"
    _emit_stdout_line(stamped)

    log_group = os.environ.get("LOG_GROUP_NAME")
    if not log_group:
        return

    _t = threading.Thread(
        target=_warn_cw_write_blocking,
        args=(log_group, task_id, stamped),
        name="warn-cw-write",
        daemon=True,
    )
    _t.start()


def _warn_cw_write_blocking(log_group: str, task_id: str | None, stamped: str) -> None:
    """Blocking CloudWatch write for ``_warn_cw`` — only called from a background thread.

    Mirrors ``_debug_cw_write_blocking`` but writes to the
    ``server_warn/<task_id>`` stream so warn-level traffic is easy to
    alarm on independently of debug breadcrumbs. Failures bump the
    shared ``_debug_cw_failures`` counter — a single alarm surface
    covers both writers.
    """
    try:
        from aws_session import platform_client

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = platform_client("logs", region_name=region)

        stream = f"server_warn/{task_id or 'server'}"
        with _ctx_for_debug.suppress(client.exceptions.ResourceAlreadyExistsException):
            client.create_log_stream(logGroupName=log_group, logStreamName=stream)

        client.put_log_events(
            logGroupName=log_group,
            logStreamName=stream,
            logEvents=[{"timestamp": int(_time_for_debug.time() * 1000), "message": stamped}],
        )
    except Exception as _exc:
        global _debug_cw_failures
        with _debug_cw_failures_lock:
            _debug_cw_failures += 1
        print(
            f"[server/warn/self] CloudWatch write failed: {type(_exc).__name__}: {_exc}",
            flush=True,
        )


def _debug_cw_write_blocking(log_group: str, task_id: str | None, stamped: str) -> None:
    """Blocking CloudWatch write — only called from a background thread."""
    try:
        from aws_session import platform_client

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = platform_client("logs", region_name=region)

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


def _extract_workload_access_token(request: Request) -> str:
    """Read AgentCore's workload access token off the inbound request.

    AgentCore Runtime delivers the token on `/invocations` requests under
    one of two header spellings (both observed on a single request via
    diagnostic logging):
      1. ``WorkloadAccessToken`` — the SDK's documented header in
         ``bedrock_agentcore.runtime.models::ACCESS_TOKEN_HEADER``.
      2. ``x-amzn-bedrock-agentcore-runtime-workload-accesstoken`` —
         undocumented but present on the wire; included for forward
         compatibility.

    The token must be propagated explicitly into the pipeline thread (see
    ``_run_task_background``) because Python ``ContextVar`` is per-thread,
    not per-request — the SDK's bundled ``_build_request_context``
    middleware sets it in the request handler's async context, but our
    pipeline runs in a separate ``threading.Thread`` spawned by
    ``_spawn_background``. The new thread sees a fresh empty ContextVar
    unless we re-set it on entry.

    See aws/bedrock-agentcore-sdk-python#219 for the upstream tracking
    issue (per-thread ContextVar) and the workaround pattern in
    ``awslabs/agentcore-samples`` 07-Outbound_Auth_3LO_ECS_Fargate.
    """
    return (
        request.headers.get("WorkloadAccessToken")
        or request.headers.get("x-amzn-bedrock-agentcore-runtime-workload-accesstoken")
        or request.headers.get("x-amzn-bedrock-agentcore-workload-access-token")
        or ""
    )


class InvocationRequest(BaseModel):
    input: dict[str, Any]


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
    build_command: str = "",
    lint_command: str = "",
    prompt_version: str = "",
    memory_id: str = "",
    resolved_workflow: dict | None = None,
    branch_name: str = "",
    pr_number: str = "",
    base_branch: str | None = None,
    merge_branches: list[str] | None = None,
    cedar_policies: list[str] | None = None,
    approval_timeout_s: int | None = None,
    initial_approvals: list[str] | None = None,
    initial_approval_gate_count: int = 0,
    approval_gate_cap: int | None = None,
    channel_source: str = "",
    channel_metadata: dict[str, str] | None = None,
    trace: bool = False,
    user_id: str = "",
    workload_access_token: str = "",
    attachments: list[dict] | None = None,
) -> None:
    """Run the agent task in a background thread."""
    global _background_pipeline_failed

    # Re-establish the AgentCore workload-token ContextVar in this thread.
    # Python ContextVar storage is per-thread, so the request-handler thread's
    # context (where BedrockAgentCoreApp's _build_request_context would normally
    # set this) doesn't propagate to here. Without this re-set,
    # IdentityClient.get_api_key() callers like resolve_linear_api_token()
    # short-circuit on a None workload token even when the platform delivered
    # one. See aws/bedrock-agentcore-sdk-python#219 for the upstream design
    # constraint that motivates this manual propagation.
    if workload_access_token:
        # Vestigial path from the parked AgentCore Identity flow. If the
        # `bedrock-agentcore` SDK is missing or its module structure
        # changes, fail open: the Linear token resolver falls back to
        # reading per-workspace Secrets Manager directly, so the agent
        # can still proceed without this ContextVar set. Catching
        # (ImportError, AttributeError) here keeps the pipeline alive
        # instead of bricking the entire task with no diagnostic when
        # the upstream SDK rearranges modules.
        try:
            from bedrock_agentcore.runtime.context import BedrockAgentCoreContext

            BedrockAgentCoreContext.set_workload_access_token(workload_access_token)
        except (ImportError, AttributeError) as e:
            _warn_cw(
                f"bedrock_agentcore workload-token bridge unavailable "
                f"({type(e).__name__}: {e}); the Linear reactions token will "
                "resolve via Secrets Manager fallback",
                task_id=task_id,
            )

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
        # Propagate the correlation envelope into this thread's OTEL context
        # so spans are correlated with the AgentCore session and the platform
        # identity in CloudWatch (#245). Runs whenever any field is present —
        # session_id may be empty while user_id/repo are known.
        if session_id or user_id or repo_url:
            propagate_correlation_context(session_id, user_id=user_id, repo=repo_url or None)

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
            build_command=build_command,
            lint_command=lint_command,
            prompt_version=prompt_version,
            memory_id=memory_id,
            resolved_workflow=resolved_workflow,
            branch_name=branch_name,
            pr_number=pr_number,
            base_branch=base_branch,
            merge_branches=merge_branches,
            cedar_policies=cedar_policies,
            approval_timeout_s=approval_timeout_s,
            initial_approvals=initial_approvals,
            initial_approval_gate_count=initial_approval_gate_count,
            approval_gate_cap=approval_gate_cap,
            channel_source=channel_source,
            channel_metadata=channel_metadata,
            trace=trace,
            user_id=user_id,
            attachments=attachments,
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
    # #1: per-repo build/lint verification commands. Empty → agent defaults to mise.
    build_command = inp.get("build_command", "")
    lint_command = inp.get("lint_command", "")
    max_turns = int(inp.get("max_turns", 0)) or int(os.environ.get("MAX_TURNS", "100"))
    max_budget_usd = float(inp.get("max_budget_usd", 0)) or None
    aws_region = inp.get("aws_region") or os.environ.get("AWS_REGION", "")
    task_id = inp.get("task_id", "")
    hydrated_context = inp.get("hydrated_context")
    prompt_version = inp.get("prompt_version", "")
    memory_id = inp.get("memory_id") or os.environ.get("MEMORY_ID", "")
    resolved_workflow = inp.get("resolved_workflow")
    branch_name = inp.get("branch_name", "")
    pr_number = str(inp.get("pr_number", ""))
    # Stacked-child base branch + (diamond) predecessor branches
    # to merge in. The orchestrator sets these from the orchestration row;
    # absent for ordinary tasks (agent branches off main as today).
    base_branch = inp.get("base_branch") or None
    merge_branches_raw = inp.get("merge_branches") or []
    merge_branches = [b for b in merge_branches_raw if isinstance(b, str)]
    cedar_policies = inp.get("cedar_policies") or []
    # Cedar HITL (§7.3) — per-task approval defaults + seeded allowlist.
    # Both are forwarded verbatim to the pipeline; the engine
    # validates shape at construction time and raises on bad input.
    approval_timeout_s = inp.get("approval_timeout_s")
    initial_approvals = inp.get("initial_approvals") or []
    # Chunk 7: TaskTable-persisted ``approval_gate_count`` threaded by
    # the orchestrator so a container restart (§13.6) resumes the
    # cumulative gate budget instead of resetting to 0. Non-int payloads
    # coerce to 0 to keep the invocation path fail-open on a malformed
    # field; the downstream PolicyEngine rejects negatives loudly.
    raw_gate_count = inp.get("initial_approval_gate_count", 0)
    try:
        initial_approval_gate_count = int(raw_gate_count)
    except (TypeError, ValueError):
        _warn_cw(
            "initial_approval_gate_count payload field is not an int "
            f"(type={type(raw_gate_count).__name__}, value={raw_gate_count!r}); "
            f"coerced to 0. task_id={inp.get('task_id', '')!r}",
            task_id=inp.get("task_id"),
        )
        initial_approval_gate_count = 0
    # Chunk 7b (§4 step 5, decision #13): per-task cap resolved by the
    # submit path and persisted on the TaskRecord. Threaded so a
    # blueprint-configured cap (or the default-50 frozen at submit) wins
    # over the PolicyEngine's compile-time fallback on restarts. A
    # malformed payload coerces to ``None`` so the engine can still
    # construct; its own bounds check would reject anything out-of-range.
    raw_approval_gate_cap = inp.get("approval_gate_cap")
    approval_gate_cap: int | None = None
    if raw_approval_gate_cap is not None:
        try:
            approval_gate_cap = int(raw_approval_gate_cap)
        except (TypeError, ValueError):
            _warn_cw(
                "approval_gate_cap payload field is not an int "
                f"(type={type(raw_approval_gate_cap).__name__}, value={raw_approval_gate_cap!r}); "
                f"falling back to engine default. task_id={inp.get('task_id', '')!r}",
                task_id=inp.get("task_id"),
            )
            approval_gate_cap = None
    channel_source = inp.get("channel_source", "") or ""
    channel_metadata = inp.get("channel_metadata") or {}
    attachments = inp.get("attachments") or []
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
        _warn_cw(
            "user_id payload field is not a string "
            f"(type={type(raw_user_id).__name__}); coerced to empty. "
            f"task_id={inp.get('task_id', '')!r}",
            task_id=inp.get("task_id"),
        )
        user_id = ""

    session_id = request.headers.get("x-amzn-bedrock-agentcore-runtime-session-id", "")

    # Cedar HITL: stamp TASK_STARTED_AT so the PreToolUse hook's
    # ``_remaining_maxlifetime_s`` (agent/src/hooks.py §6.5) has the
    # real per-task clock to compute the maxLifetime ceiling. Without
    # this the hook's ceiling computation silently falls back to
    # "unknown, don't clip" (fail-open) and the user may be asked for
    # approval on a gate whose window will expire before they can
    # respond.
    started_at = inp.get("task_started_at", "")
    if started_at and isinstance(started_at, str):
        os.environ["TASK_STARTED_AT"] = started_at

    # AgentCore-injected workload access token (see _extract_workload_access_token
    # for full rationale). Threaded into _run_task_background so the pipeline
    # thread can call BedrockAgentCoreContext.set_workload_access_token() on entry
    # — without that the IdentityClient.get_api_key path used by
    # resolve_linear_api_token() returns None.
    workload_access_token = _extract_workload_access_token(request)

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
        "build_command": build_command,
        "lint_command": lint_command,
        "prompt_version": prompt_version,
        "memory_id": memory_id,
        "resolved_workflow": resolved_workflow,
        "branch_name": branch_name,
        "pr_number": pr_number,
        "base_branch": base_branch,
        "merge_branches": merge_branches,
        "cedar_policies": cedar_policies,
        "approval_timeout_s": approval_timeout_s,
        "initial_approvals": initial_approvals,
        "initial_approval_gate_count": initial_approval_gate_count,
        "approval_gate_cap": approval_gate_cap,
        "channel_source": channel_source,
        "channel_metadata": channel_metadata,
        "trace": trace,
        "user_id": user_id,
        "workload_access_token": workload_access_token,
        "attachments": attachments,
    }


def _validate_required_params(params: dict) -> list[str]:
    """Check the minimum viable param set for the pipeline.

    Returns the list of missing field names (empty list = valid). A repo-bound
    workflow requires ``repo_url``; a repo-less workflow (``requires_repo:false``,
    #248 Phase 3) does not. All non-PR workflows need either an ``issue_number``
    or ``task_description``; PR workflows (``coding/pr-iteration-v1`` /
    ``coding/pr-review-v1`` / ``coding/restack-v1``) require ``pr_number``
    instead and carry no description.
    """
    missing: list[str] = []
    workflow_id = (params.get("resolved_workflow") or {}).get("id", "coding/new-task-v1")

    # Repo is mandatory only for repo-bound workflows. Resolve requires_repo from
    # the workflow itself (authoritative, matches config.build_config); a load
    # failure fails SAFE — assume a repo is required so a repo-bound task is never
    # admitted without one.
    requires_repo = True
    try:
        from workflow import WorkflowValidationError, load_workflow

        try:
            requires_repo = load_workflow(workflow_id).resolved_requires_repo
        except WorkflowValidationError:
            # Expected failure modes (missing/corrupt/schema-invalid file, or a
            # future registry-only id) — fail SAFE (repo required). A genuine
            # programming error is NOT caught here so it surfaces loudly.
            _warn_cw(f"could not resolve requires_repo for {workflow_id!r}; assuming repo required")
    except ImportError:
        _warn_cw(f"workflow loader unavailable for {workflow_id!r}; assuming repo required")
    if requires_repo and not params.get("repo_url"):
        missing.append("repo_url")

    if workflow_id in ("coding/pr-iteration-v1", "coding/pr-review-v1", "coding/restack-v1"):
        if not params.get("pr_number"):
            missing.append("pr_number")
    else:
        # Non-PR workflow: need EITHER issue_number or task_description.
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

    inp = body.input
    task_id_log = str(inp.get("task_id", ""))
    repo_url_log = str(inp.get("repo_url") or os.environ.get("REPO_URL", ""))
    try:
        params = _extract_invocation_params(inp, request)
        _debug_cw(
            f"params extracted: task_id={task_id_log!r} "
            f"repo_url={repo_url_log!r} session_id={session_hdr[:20]!r}",
            task_id=task_id_log or None,
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
            task_id=task_id_log or None,
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

    _debug_cw("routing to sync path", task_id=task_id_log or None)
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


# --------------------------------------------------------------------------
# AWS Lambda MicroVMs lifecycle hooks (ADR-021 P1 + P2)
# --------------------------------------------------------------------------
# The MicroVM backend has NO orchestrator→agent HTTP path: the task payload
# arrives as the ``/run`` hook's request body and nothing else dials in. The
# service calls these routes on the port declared in the image's ``hooks.port``
# (8080 — the same uvicorn process that serves /invocations and /ping), so the
# hooks live here rather than in a sidecar.
#
# Four hooks are served; ``/suspend`` + ``/resume`` are still P3:
#   * ``/ready`` (build, P1) is MANDATORY. ``CreateMicrovmImage`` refuses an image
#     that enables ANY lifecycle hook without it ("The ready (/ready) MicroVM
#     image hook must be enabled when any MicroVM lifecycle hook … is enabled"),
#     and an image with no hooks at all cannot receive a ``runHookPayload``. So
#     ADR-021's original "declare /run in P1, serve it in P2" split was not a
#     reachable service state.
#   * ``/run`` (runtime, P1) is the payload-delivery channel — and, since P2, the
#     platform-configuration channel (see ``platform_config`` below).
#   * ``/validate`` (build, P2) is the snapshot self-check. It runs under the
#     BUILD role and makes ZERO AWS calls — see ``microvm_validate``.
#   * ``/terminate`` (runtime, P2) is a best-effort final flush. It never writes
#     terminal task status — the orchestrator owns terminal state.
# ``/suspend`` and ``/resume`` are P3 (they need the ComputeStrategy interface
# widening). Declaring a hook the agent does not answer fails the corresponding
# build or lifecycle transition, which is why the construct declares exactly the
# hooks served here.
MICROVM_HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1"

#: ``s3://`` scheme prefix for the out-of-band payload pointer.
_S3_URI_SCHEME = "s3://"

# --- platform_config allowlist (ADR-021 P2) --------------------------------
# WHY the agent's platform env arrives in the ``/run`` payload at all, instead of
# being baked into the image like it is on AgentCore/ECS: the MicroVM image is a
# SNAPSHOT. Its process environment is frozen at build time and then replayed by
# every MicroVM launched from that image version, so image env is
# version-frozen — it describes the deployment as it looked when the snapshot was
# taken. The orchestrator's values describe the LIVE deployment (tables, buckets,
# secret ARNs, the session role it just provisioned). When the two disagree the
# live one is right, so a payload-supplied value WINS over any pre-existing /
# image value (see ``_install_platform_config``). It also keeps the build hooks
# AWS-silent: with no ``LOG_GROUP_NAME`` in the snapshot there is nothing for a
# build-time hook to write to (see ``_build_hook_log``).
#
# WHY an allowlist, and why it fails closed: these values are installed into
# ``os.environ`` of the process that spawns the agent's tool subprocesses. An
# unrecognised key is therefore an attempt to set an arbitrary environment
# variable in the agent (``AWS_ENDPOINT_URL``, ``LD_PRELOAD``, ``PATH``, …), i.e.
# an injection attempt, not a forward-compatibility nicety — so an unknown key
# REJECTS the whole run rather than being skipped. Values are non-secret
# identifiers only; secrets are still fetched at ``/run`` time from Secrets
# Manager using the ARNs delivered here.
#
# SOURCE OF TRUTH: ``contracts/constants.json`` →
# ``microvm_platform_config``. The PRODUCER of this block is
# ``buildMicrovmPlatformConfig`` in
# ``cdk/src/handlers/shared/strategies/lambda-microvm-strategy.ts`` (ADR-021 P2
# Stage B) — the strategy, NOT ``orchestrator.ts``, which does not mention it.
# The producer must read the SAME contract file (TypeScript gets
# compile-time enforcement of the key names via ``resolveJsonModule``) rather
# than re-declaring the key names. ``mise run check:constants-sync``
# (``scripts/check-constants-sync.ts``) validates this block's shape and rejects a
# literal re-declaration of either constant below in the Python consumers.
_PLATFORM_CONFIG_CONTRACT: dict[str, Any] = SHARED_CONSTANTS["microvm_platform_config"]

#: ``platform_config`` key (snake_case) → environment variable it becomes.
MICROVM_PLATFORM_CONFIG_ENV_BY_KEY: dict[str, str] = dict(_PLATFORM_CONFIG_CONTRACT["env_by_key"])

#: Subset without which a task cannot run: no task/event tables means no status
#: or progress writes, no GitHub secret ARN means no clone/PR, and no session
#: role ARN means no tenant-scoped credentials. Missing or blank → 400.
MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS: frozenset[str] = frozenset(
    _PLATFORM_CONFIG_CONTRACT["required"]
)

#: Keys whose VALUE is an ARN, and which are therefore pinned to this
#: deployment's own partition + account before installation.
#:
#: WHY value validation exists at all, when the KEY allowlist above already fails
#: closed: the key allowlist stops a payload setting ``LD_PRELOAD``; it does not
#: stop a payload pointing an *allowlisted* key at someone else's resource. The
#: sharp case is ``github_token_secret_arn``: ``config.resolve_github_token``
#: fetches whatever ARN it names using the UNSCOPED execution role and caches the
#: raw ``SecretString`` into ``os.environ["GITHUB_TOKEN"]``, from which
#: ``shell.py`` hands the environment to every repo subprocess — i.e. into the
#: model's tool surface. That role holds a *prefix* grant on
#: ``bgagent-linear-oauth-*`` / ``bgagent-jira-oauth-*`` (unavoidable: the CLI
#: mints those names at setup, so they are unknown at synth), so a ``/run``
#: payload naming another workspace's channel-OAuth secret would otherwise
#: succeed — allowlisted key, unvalidated value, matching grant.
#:
#: The prefix grant is at ECS parity. The ASYMMETRY that makes it reachable is
#: new to this backend: on ECS these ARNs arrive as deploy-time container env; here
#: they arrive in a network payload. So this is where an ARN stops being free-form.
MICROVM_PLATFORM_CONFIG_ARN_KEYS: frozenset[str] = frozenset(_PLATFORM_CONFIG_CONTRACT["arn_keys"])

#: The key whose ARN supplies the partition/account every other ARN must match.
#:
#: Deliberately a payload key rather than ``os.environ`` or an STS call.
#: ``os.environ`` is empty here by construction (nothing is baked into the
#: snapshot — see ``imageEnvironmentVariables``), so anchoring on the environment
#: would silently degrade this whole check to shape-only in the intended
#: deployment. An ``sts:GetCallerIdentity`` is not available either: this runs
#: BEFORE ``platform_config`` is installed, on the path that must make zero AWS
#: calls beyond the S3 payload fetch. ``agent_session_role_arn`` is the right
#: anchor because it is REQUIRED (so always present when this check runs) and
#: because it is the one ARN that cannot be usefully forged: a foreign session
#: role fails closed at ``sts:AssumeRole`` (``SessionScopingError``), so an
#: attacker who redirects it loses the run instead of gaining a secret.
MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY: str = _PLATFORM_CONFIG_CONTRACT["account_anchor_key"]

_PLATFORM_CONFIG_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_PLATFORM_CONFIG_ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")

#: Control characters refused in any ``platform_config`` value.
#:
#: A NUL makes ``os.environ[...] = value`` raise ``ValueError`` — which is NOT a
#: :class:`_PlatformConfigError`, so it escaped the handler's structured-400 path
#: and became a bare FastAPI 500, mid-loop, leaving the keys installed so far in
#: place (a partial install breaks the fail-closed contract this block exists
#: for). A newline forges extra lines in the structured logs emitted below. Keys
#: were regex-validated and values were not; this closes the other half of the
#: same threat model.
_PLATFORM_CONFIG_FORBIDDEN_VALUE_CHARS = ("\x00", "\n", "\r")

#: Colon-separated fields in a well-formed ARN:
#: ``arn:partition:service:region:account:resource``. The resource segment may
#: itself contain colons (``secret:name-AbCdEf``), so this is a MINIMUM, never an
#: equality — and ``split(":")`` is left unbounded so ``parts[4]`` is the account
#: whatever the resource looks like.
_ARN_MIN_FIELDS = 6


def _validate_platform_config_contract() -> None:
    """Fail-fast on a malformed ``microvm_platform_config`` contract.

    Runs at import time, so a corrupt contract fails the IMAGE BUILD (uvicorn
    never binds → the ``/ready`` hook never answers) instead of the first task —
    the same posture the policy-file load already has.
    """
    where = "contracts/constants.json: microvm_platform_config"
    if not MICROVM_PLATFORM_CONFIG_ENV_BY_KEY:
        raise ValueError(f"{where}.env_by_key must not be empty")
    for key, env_name in MICROVM_PLATFORM_CONFIG_ENV_BY_KEY.items():
        if not _PLATFORM_CONFIG_KEY_RE.match(key):
            raise ValueError(f"{where}.env_by_key key {key!r} is not snake_case")
        if not isinstance(env_name, str) or not _PLATFORM_CONFIG_ENV_RE.match(env_name):
            raise ValueError(
                f"{where}.env_by_key[{key!r}] must be an UPPER_SNAKE env var name, got {env_name!r}"
            )
    env_names = list(MICROVM_PLATFORM_CONFIG_ENV_BY_KEY.values())
    if len(set(env_names)) != len(env_names):
        raise ValueError(f"{where}.env_by_key maps two keys onto the same env var")
    if not MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS:
        raise ValueError(f"{where}.required must not be empty")
    unknown_required = sorted(
        MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS - set(MICROVM_PLATFORM_CONFIG_ENV_BY_KEY)
    )
    if unknown_required:
        raise ValueError(
            f"{where}.required names key(s) absent from env_by_key: {unknown_required}"
        )
    if not MICROVM_PLATFORM_CONFIG_ARN_KEYS:
        raise ValueError(f"{where}.arn_keys must not be empty")
    unknown_arn = sorted(MICROVM_PLATFORM_CONFIG_ARN_KEYS - set(MICROVM_PLATFORM_CONFIG_ENV_BY_KEY))
    if unknown_arn:
        raise ValueError(f"{where}.arn_keys names key(s) absent from env_by_key: {unknown_arn}")
    anchor = MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY
    if anchor not in MICROVM_PLATFORM_CONFIG_ARN_KEYS:
        raise ValueError(f"{where}.account_anchor_key {anchor!r} must be one of arn_keys")
    # The anchor must be REQUIRED, or the pinning check silently disarms itself on
    # any payload that omits it — the exact failure mode this contract prevents.
    if anchor not in MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS:
        raise ValueError(
            f"{where}.account_anchor_key {anchor!r} must also be listed in .required — "
            "an optional anchor would make ARN pinning skippable by omission"
        )


_validate_platform_config_contract()


#: MicroVM lifecycle-hook budgets, shared with the CDK construct that declares them.
#:
#: ``contracts/constants.json`` → ``microvm_hook_budgets``. The agent's ``/ready``
#: warm-up ceiling and the service-side ``/ready`` hook timeout
#: (``READY_HOOK_TIMEOUT_SECONDS`` in
#: ``cdk/src/constructs/lambda-microvm-compute.ts``) are not two independent
#: numbers: the warm-up must finish inside the hook budget or a fix for a runtime
#: failure becomes a build failure. An invariant between two values cannot be
#: enforced from one side, so both live in the contract and
#: ``scripts/check-constants-sync.ts`` asserts ``warmup_total < ready_hook`` and
#: rejects a literal re-declaration on either side.
_HOOK_BUDGETS: dict[str, int] = SHARED_CONSTANTS["microvm_hook_budgets"]


def _validate_hook_budget_contract() -> None:
    """Fail-fast on a ``microvm_hook_budgets`` block that cannot hold.

    Import time, so a contract whose warm-up no longer fits inside the hook budget
    fails the IMAGE BUILD rather than producing a ``/ready`` that times out — the
    same posture as :func:`_validate_platform_config_contract`.
    """
    where = "contracts/constants.json: microvm_hook_budgets"
    for name in ("ready_hook_timeout_seconds", "warmup_total_budget_seconds"):
        value = _HOOK_BUDGETS.get(name)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ValueError(f"{where}.{name} must be a positive integer, got {value!r}")
    required = _HOOK_BUDGETS.get("warmup_required_timeout_seconds")
    if not isinstance(required, int) or isinstance(required, bool) or required <= 0:
        raise ValueError(
            f"{where}.warmup_required_timeout_seconds must be a positive integer, got {required!r}"
        )
    if _HOOK_BUDGETS["warmup_total_budget_seconds"] >= _HOOK_BUDGETS["ready_hook_timeout_seconds"]:
        raise ValueError(
            f"{where}: warmup_total_budget_seconds "
            f"({_HOOK_BUDGETS['warmup_total_budget_seconds']}) must be < "
            f"ready_hook_timeout_seconds ({_HOOK_BUDGETS['ready_hook_timeout_seconds']}) — "
            "/ready has to answer inside the hook budget."
        )
    if required >= _HOOK_BUDGETS["warmup_total_budget_seconds"]:
        raise ValueError(
            f"{where}: warmup_required_timeout_seconds ({required}) must be < "
            f"warmup_total_budget_seconds "
            f"({_HOOK_BUDGETS['warmup_total_budget_seconds']}) — the required command "
            "must leave the optional ones something to share."
        )


_validate_hook_budget_contract()


class _PlatformConfigError(Exception):
    """A ``platform_config`` block the agent refuses to install (fail closed).

    Carries the wire ``code`` the ``/run`` hook returns, so the handler maps one
    exception type onto the two distinct operator remedies: a producer bug /
    injection attempt (``…_INVALID``) versus a deployment wiring gap
    (``…_INCOMPLETE``).
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _absent_required_platform_env() -> list[str]:
    """Required ``platform_config`` env vars that are unset in the LIVE environment.

    The no-``platform_config`` path's audit. Checks the ENV VAR names rather than
    the contract keys, because on that path the only possible source is whatever
    the image snapshot baked — so the effective environment is the thing to
    interrogate, and a value that arrived by any route counts.

    Blank/whitespace-only counts as absent, matching
    :func:`_install_platform_config`'s own rule: CloudFormation renders an
    unresolved value as ``""``, and an empty table name is not a table name.
    """
    return sorted(
        MICROVM_PLATFORM_CONFIG_ENV_BY_KEY[key]
        for key in MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS
        if not os.environ.get(MICROVM_PLATFORM_CONFIG_ENV_BY_KEY[key], "").strip()
    )


def _reject_foreign_arns(resolved: dict[str, str]) -> None:
    """Pin every ARN-shaped value to this deployment's own partition + account.

    Raises :class:`_PlatformConfigError` (``…_INVALID``) if any
    :data:`MICROVM_PLATFORM_CONFIG_ARN_KEYS` value is malformed or names a
    different partition/account than
    :data:`MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY` does. See that constant for
    why the anchor is a payload key rather than the environment or STS.

    Region is deliberately NOT pinned. Secrets Manager and IAM ARNs legitimately
    differ on that axis in this system — IAM is global (empty region field), and a
    cross-Region secret is a supported deployment shape — so requiring agreement
    would reject valid configurations while adding nothing: the execution role's
    grants are account-scoped, so an in-account cross-Region ARN reaches nothing
    the in-Region one does not. Partition + account is the boundary that matters.
    """
    anchor_value = resolved.get(MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY, "")
    # The anchor is contract-guaranteed REQUIRED (asserted at import), so by the
    # time this runs the required-key check has already accepted it.
    anchor_parts = anchor_value.split(":")
    if len(anchor_parts) < _ARN_MIN_FIELDS or anchor_parts[0] != "arn":
        raise _PlatformConfigError(
            "MICROVM_RUN_PLATFORM_CONFIG_INVALID",
            f"platform_config.{MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY} must be a "
            "well-formed ARN — it is the anchor every other ARN in the block is "
            f"checked against; got {anchor_value!r}",
        )
    want_partition, want_account = anchor_parts[1], anchor_parts[4]

    rejected: list[str] = []
    for key in sorted(MICROVM_PLATFORM_CONFIG_ARN_KEYS):
        value = resolved.get(key)
        if value is None:
            continue
        parts = value.split(":")
        if len(parts) < _ARN_MIN_FIELDS or parts[0] != "arn":
            rejected.append(f"{key}:malformed")
            continue
        if parts[1] != want_partition or parts[4] != want_account:
            rejected.append(f"{key}:foreign-partition-or-account")

    if rejected:
        raise _PlatformConfigError(
            "MICROVM_RUN_PLATFORM_CONFIG_INVALID",
            "platform_config ARN values are installed into the environment that "
            "resolves credentials and fetches secrets, so an ARN outside this "
            "deployment's own partition and account is an exfiltration primitive, "
            f"not a configuration choice; rejected {rejected} "
            f"(expected partition {want_partition!r}, account {want_account!r}, "
            f"taken from {MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY})",
        )


def _install_platform_config(raw: Any) -> list[str]:
    """Validate ``platform_config`` against the allowlist and install it into env.

    Returns the sorted env var names actually installed. Rules, all deliberate:

    * ``None`` / absent → install nothing and return ``[]``. This is the P1
      envelope (no ``platform_config`` sibling), where the snapshot's own env is
      all there is; a MicroVM image can be launched by an orchestrator that
      predates Stage B, and the two deploy on independent cadences.
    * present but not an object, or carrying ANY key outside the allowlist, or
      carrying a non-string value, or carrying a control character in a value →
      reject the run (``…_INVALID``). Unknown keys are an env-injection attempt,
      not a compatibility gap (see the allowlist comment above), so the whole
      block is refused rather than filtered. Control characters are refused for
      the reason in ``_PLATFORM_CONFIG_FORBIDDEN_VALUE_CHARS``.
    * ``None`` / blank / whitespace-only values are treated as ABSENT, not as an
      instruction to clear the variable: the natural TypeScript producer
      (``process.env.X ?? ''``) emits an empty string for a resource the
      deployment does not have, and clobbering an image value with ``""`` would
      turn "not configured over there" into "unconfigured here".
    * every required key must survive that filter, else reject
      (``…_INCOMPLETE``). An explicitly-sent-but-empty ``{}`` therefore fails —
      a producer with nothing to say must omit the key entirely.
    * every ARN-shaped value must name THIS deployment's partition + account,
      else reject (``…_INVALID``) — see :func:`_reject_foreign_arns`.

    Payload values WIN over pre-existing/image env (see the block comment above:
    image env is version-frozen, the payload describes the live deployment).
    """
    if raw is None:
        return []
    if not isinstance(raw, dict):
        raise _PlatformConfigError(
            "MICROVM_RUN_PLATFORM_CONFIG_INVALID",
            f"platform_config must be an object, got {type(raw).__name__}",
        )

    unknown = sorted(key for key in raw if key not in MICROVM_PLATFORM_CONFIG_ENV_BY_KEY)
    if unknown:
        raise _PlatformConfigError(
            "MICROVM_RUN_PLATFORM_CONFIG_INVALID",
            f"platform_config carries key(s) outside the allowlist: {unknown}. "
            "These would become process environment variables, so an unrecognised "
            "key is refused rather than ignored. Allowed keys: "
            f"{sorted(MICROVM_PLATFORM_CONFIG_ENV_BY_KEY)}",
        )

    resolved: dict[str, str] = {}
    bad_types: list[str] = []
    for key, value in raw.items():
        if value is None:
            continue
        if not isinstance(value, str):
            bad_types.append(f"{key}:{type(value).__name__}")
            continue
        if any(char in value for char in _PLATFORM_CONFIG_FORBIDDEN_VALUE_CHARS):
            # Rejected BEFORE any install, not caught during it: see
            # ``_PLATFORM_CONFIG_FORBIDDEN_VALUE_CHARS``. A NUL reaching
            # ``os.environ`` raises a bare ``ValueError`` mid-loop, which both
            # escapes this module's structured-400 contract and leaves a partial
            # install behind.
            bad_types.append(f"{key}:control-characters")
            continue
        if value.strip():
            resolved[key] = value

    if bad_types:
        raise _PlatformConfigError(
            "MICROVM_RUN_PLATFORM_CONFIG_INVALID",
            "platform_config values become environment variables, so they must be "
            f"strings without control characters; rejected {sorted(bad_types)}",
        )

    missing = sorted(MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS - resolved.keys())
    if missing:
        raise _PlatformConfigError(
            "MICROVM_RUN_PLATFORM_CONFIG_INCOMPLETE",
            f"platform_config is missing or blank for required key(s): {missing}. "
            "The orchestrator must populate these before starting the MicroVM — "
            "without them the agent cannot write task status/progress, resolve the "
            "GitHub token, or scope its credentials to the tenant.",
        )

    _reject_foreign_arns(resolved)

    installed: list[str] = []
    for key, value in sorted(resolved.items()):
        env_name = MICROVM_PLATFORM_CONFIG_ENV_BY_KEY[key]
        os.environ[env_name] = value
        installed.append(env_name)
    return installed


def _aws_silent_log(msg: str, *, tag: str) -> None:
    """Emit one log line WITHOUT touching any AWS seam.

    The shared sink for the two hook paths that must stay AWS-silent (the build
    hooks, and ``/run`` before ``platform_config`` is installed). Deliberately NOT
    ``_debug_cw`` / ``_warn_cw``: those writers spawn a daemon thread that builds a
    CloudWatch Logs client whenever ``LOG_GROUP_NAME`` is set, which drags in AWS
    credential resolution and — worse — populates ``boto3.DEFAULT_SESSION``, a
    module global that MEMOIZES the resolved CREDENTIALS for the life of the
    process (``botocore.session.Session.get_credentials`` loads once, then caches).

    Precisely: region and ``AWS_SDK_UA_APP_ID`` are NOT frozen — botocore's
    ``EnvironmentProvider`` holds a live reference to ``os.environ`` and
    re-resolves both on every client construction (measured on this repo's pinned
    botocore in a clean-room env). The CREDENTIALS are, and on a build hook those
    are the BUILD role's. That narrower claim is also the stronger one: build-role
    credentials frozen into a snapshot every MicroVM restores from is a security
    property, whereas a stale region would be a mere bug.

    Routes through the same ``os.write`` sink and credential redaction as
    ``_debug_cw``, so local runs and the ``capfd``-based tests still see the line.
    """
    _emit_stdout_line(f"[server/{tag}] {_redact_cached_credentials(msg)}")


def _build_hook_log(msg: str) -> None:
    """stdout-only log line for the BUILD hooks (``/ready``, ``/validate``).

    A build hook must make ZERO AWS calls. Two structural reasons, on top of
    ``_aws_silent_log``'s general one:

    1. The build role's Logs grant is scoped to the service's own
       ``/aws/lambda-microvms/*`` namespace, so a write to any OTHER
       ``LOG_GROUP_NAME`` — e.g. an APPLICATION_LOGS group baked into a legacy or
       hand-built image — can only FAIL. That failure bumps the shared
       ``_debug_cw_failures`` counter, i.e. such an image build would poison the
       "debug path is blind" signal with a false positive.
    2. ``boto3.DEFAULT_SESSION`` created during ``/ready`` freezes the BUILD role's
       CREDENTIALS into the snapshot, where every launched MicroVM would inherit
       them (region is re-resolved per client; credentials are not — see
       ``_aws_silent_log``). This is the load-bearing reason.

    Being AWS-silent by construction rather than by "``LOG_GROUP_NAME`` happens
    not to be baked" is what keeps that true if a future image ever bakes it.
    """
    _aws_silent_log(msg, tag="build-hook")


def _pre_config_log(msg: str) -> None:
    """stdout-only log line for the part of ``/run`` that precedes the install.

    Same class of defect as logging from a build hook, one phase later: until
    ``_install_platform_config`` has run, ``LOG_GROUP_NAME`` is whatever the
    snapshot happens to carry — normally nothing, but a legacy or hand-built image
    could bake it, and then a ``_debug_cw`` on this path would resolve credentials
    and pin ``boto3.DEFAULT_SESSION`` *before* ``AGENT_SESSION_ROLE_ARN`` is in the
    environment — memoizing the UNSCOPED compute-role credentials for the life of
    the process, where the whole point of that variable is that every later client
    is tenant-scoped. (Region and ``AWS_SDK_UA_APP_ID`` are re-resolved per client
    and so are NOT at risk here; the credentials are the exposure.) The one AWS
    call this phase is allowed to make is the S3 payload fetch, because
    ``platform_config`` is inside the object it fetches.

    Nothing observable is lost. In the intended deployment there is no baked
    ``LOG_GROUP_NAME``, so ``_debug_cw`` would have degraded to exactly this
    stdout line anyway; and the *reason* for every pre-install rejection also
    travels in the structured 4xx/5xx response body, which is what the MicroVM
    service surfaces to the operator.
    """
    _aws_silent_log(msg, tag="run-pre-config")


def _parse_terminate_microvm_id(raw: bytes) -> str:
    """Best-effort MicroVM id out of the raw ``/terminate`` body.

    ``/terminate`` must answer 200 for ANY body, so it cannot use a Pydantic body
    model: FastAPI validates that *before* the handler runs and answers 422 on
    malformed JSON, a wrong content-type, or (for a required model) no body at all
    — reporting a hook failure for a teardown that actually succeeded. So the
    handler takes the raw request and this function degrades instead of raising:
    anything unparseable, non-object, or missing simply yields ``""`` and the hook
    still acknowledges.

    **``""`` is the EXPECTED result in production, not a degraded one** (ADR-021
    P2-F8, live 2026-08-07). The service sends a body whose ``microvmId`` is the
    empty string — ``{"microvm_id": ""}`` in the guest's own breadcrumb — unlike
    ``/run``, where it is populated. So an empty id is normal-and-uninteresting and
    is logged without comment; only a body that is genuinely unreadable (not JSON,
    not an object) earns a warning, because that would mean the wire contract
    changed shape rather than merely omitting a value.

    The consequence for correlation, stated plainly because the hook's original
    rationale claimed the opposite: **this hook cannot join the guest record to the
    control-plane one.** ``/run``'s "hook accepted task_id=… microvm_id=…" line
    carries that join (it always has, and its id IS populated); ``/terminate``'s
    value is the pipeline-state snapshot it reports, not the id.

    Accepts both spellings of the field (``microvmId`` is the service's camelCase
    wire name; ``microvm_id`` is tolerated because it costs one ``or``). The id is
    used only as a log/response correlation string, never as an authorization or
    lookup key, so degrading to empty has no security consequence.
    """
    if not raw.strip():
        return ""
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        # Not silent: an unreadable body is worth a breadcrumb even though it
        # cannot change the outcome.
        _emit_stdout_line(f"[server/warn] /terminate hook body is not JSON ({exc}); ignoring it")
        return ""
    if not isinstance(parsed, dict):
        _emit_stdout_line(
            f"[server/warn] /terminate hook body is {type(parsed).__name__}, "
            "expected an object; ignoring it"
        )
        return ""
    candidate = parsed.get("microvmId") or parsed.get("microvm_id") or ""
    return candidate if isinstance(candidate, str) else ""


class MicrovmRunHookRequest(BaseModel):
    """Body the MicroVM service POSTs to the ``/run`` hook.

    ``runHookPayload`` is the opaque STRING the orchestrator passed to
    ``RunMicrovm`` — the service does not parse it. ABCA's contract for that
    string (``lambda-microvm-strategy.ts``) is one of two shapes, mirroring the
    ECS container env contract (``AGENT_PAYLOAD`` / ``AGENT_PAYLOAD_S3_URI``):

    * ``{"agent_payload": {...}, "platform_config": {...}}`` — inline.
    * ``{"agent_payload_s3_uri": "s3://bucket/key", "platform_config": {...}}`` —
      a pointer; the object at the URI carries the task payload (and a
      ``platform_config`` copy, so either end of the fetch yields it).

    The pointer form is the DOMINANT one: the service caps ``runHookPayload`` at
    4 096 bytes and a hydrated payload is essentially always larger.

    ``platform_config`` (ADR-021 P2) is a SIBLING of ``agent_payload``, not a
    field inside it: it configures the agent's *process*, whereas
    ``agent_payload`` describes the *task* (``memory_id`` and friends stay
    inside ``agent_payload``, unchanged). See ``_install_platform_config``.

    Both fields default to empty so a malformed call produces this module's
    structured 400 rather than FastAPI's 422 — the service surfaces a 4xx as a
    generic "client error" hook failure either way, and our own body is what ends
    up in the MicroVM log group.
    """

    microvmId: str = ""  # service field name; camelCase on the wire
    runHookPayload: str = ""  # service field name; camelCase on the wire


class _PayloadFetchError(Exception):
    """A ``/run`` payload the agent could not READ, as opposed to could not PARSE.

    Exists purely to be *not* a ``ValueError``, because the ``/run`` handler
    discriminates its 400 from its 500 on exactly that type and the two answers
    make opposite promises to the operator:

    * 400 ``MICROVM_RUN_PAYLOAD_INVALID`` — "the orchestrator built a bad
      envelope; retrying an identical body cannot help."
    * 500 ``MICROVM_RUN_PAYLOAD_UNREADABLE`` — "the payload could not be read;
      retrying CAN help."

    A truncated, racing, or half-written S3 object is the SECOND kind, but its
    natural exception is ``json.JSONDecodeError`` — a ``ValueError`` subclass — so
    it landed in the 400 branch and told the operator the orchestrator was at
    fault when the orchestrator was fine and the object was bad. Only the
    *pre-fetch* URI-shape check legitimately raises ``ValueError`` on this path,
    which is why a blanket ``except ValueError`` is the wrong discriminator and
    this type exists.
    """


def _fetch_microvm_payload_from_s3(uri: str) -> dict:
    """Read and parse the out-of-band ``/run`` payload from S3.

    Same fetch the ECS boot command performs for ``AGENT_PAYLOAD_S3_URI``; the
    MicroVM **execution role** holds the read grant, scoped to the platform
    payload bucket. Errors propagate to the caller, which turns them into a
    structured 400/500 — silently starting a pipeline with no payload would
    produce a task that runs with an empty prompt.

    The URI-SHAPE check raises ``ValueError`` (the orchestrator's envelope is
    wrong → 400). Everything AFTER the fetch raises :class:`_PayloadFetchError`
    (the object is wrong → 500, retryable). See that class.

    Built through ``aws_session.platform_client`` so the call carries the ABCA
    ``md/`` solution-attribution segment (#319). Platform, not tenant: the bucket
    is platform-owned and — decisively — this is the ONE call that must happen
    BEFORE ``platform_config`` is installed (the config is inside the object
    being fetched), so ``AGENT_SESSION_ROLE_ARN`` may not be set yet and a
    tenant-scoped client could not be built. ``platform_client`` does not touch
    the cached session, so this call also cannot pin an unscoped session for the
    rest of the task. The ``app/`` UA segment (native, from ``AWS_SDK_UA_APP_ID``)
    is the one attribution field this single call can miss for the same
    chicken-and-egg reason.
    """
    remainder = uri[len(_S3_URI_SCHEME) :]
    bucket, _, key = remainder.partition("/")
    if not bucket or not key:
        raise ValueError(f"agent_payload_s3_uri is not a bucket/key URI: {uri!r}")

    from aws_session import platform_client

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    client = platform_client("s3", region_name=region)
    body = client.get_object(Bucket=bucket, Key=key)["Body"].read()
    try:
        payload = json.loads(body)
    except ValueError as exc:
        # ``JSONDecodeError`` IS a ``ValueError``, so without this re-raise a
        # truncated or half-written object would be reported as an orchestrator
        # envelope bug and marked non-retryable. Re-raised as the type the handler
        # routes to its retryable 500.
        raise _PayloadFetchError(
            f"S3 payload at {uri!r} is not valid JSON ({exc}); the object may be "
            "truncated or still being written"
        ) from exc
    if not isinstance(payload, dict):
        raise _PayloadFetchError(
            f"S3 payload at {uri!r} is {type(payload).__name__}, expected an object"
        )
    return payload


def _resolve_microvm_run_payload(run_hook_payload: str) -> tuple[dict, Any]:
    """Split the ``runHookPayload`` string into (agent payload, platform config).

    The second element is returned RAW (unvalidated) — ``_install_platform_config``
    owns its allowlist checks so the two failure classes get distinct wire codes.
    ``None`` means the envelope carried no ``platform_config`` at all.

    Raises ``ValueError`` for every ENVELOPE shape the agent cannot act on — the
    caller maps that onto its 400 ("the orchestrator built this; a retry cannot
    help"). Problems with the CONTENT of a fetched S3 object raise
    :class:`_PayloadFetchError` instead, which the caller maps onto its retryable
    500: the orchestrator's envelope was fine and the object was not.
    """
    if not run_hook_payload.strip():
        raise ValueError("runHookPayload is empty")

    try:
        envelope = json.loads(run_hook_payload)
    except json.JSONDecodeError as exc:
        raise ValueError(f"runHookPayload is not valid JSON: {exc}") from exc

    if not isinstance(envelope, dict):
        raise ValueError(f"runHookPayload must be a JSON object, got {type(envelope).__name__}")

    inline = envelope.get("agent_payload")
    if inline is not None:
        if not isinstance(inline, dict):
            raise ValueError(f"agent_payload must be an object, got {type(inline).__name__}")
        return inline, envelope.get("platform_config")

    uri = envelope.get("agent_payload_s3_uri")
    if isinstance(uri, str) and uri.startswith(_S3_URI_SCHEME):
        fetched = _fetch_microvm_payload_from_s3(uri)
        # ``platform_config`` may sit beside the pointer (outer envelope) or
        # inside the fetched object — the producer writes it in BOTH places on
        # this path deliberately, so the agent gets it whichever end it reads.
        # Inner first, outer as the fallback.
        platform_config = fetched.get("platform_config")
        if platform_config is None:
            platform_config = envelope.get("platform_config")
        # The fetched object is EITHER the same envelope shape as the inline form
        # ({"agent_payload": …}) or the task payload itself with ``platform_config``
        # merged in at the top level (what the strategy writes today, and what P1
        # wrote without the config). Both are accepted because the image snapshot
        # and the orchestrator Lambda deploy on independent cadences — a new image
        # must not require a same-instant orchestrator. Discriminating on the
        # ``agent_payload`` key is unambiguous: no orchestrator task payload has a
        # field by that name. A stray ``platform_config`` key left in the bare
        # form is inert — ``_extract_invocation_params`` reads named fields only.
        nested = fetched.get("agent_payload")
        if nested is None:
            return fetched, platform_config
        if not isinstance(nested, dict):
            # Content of the FETCHED OBJECT, not of the envelope — so this is the
            # retryable class, same as a truncated body. See ``_PayloadFetchError``.
            raise _PayloadFetchError(
                f"agent_payload in the S3 payload must be an object, got {type(nested).__name__}"
            )
        return nested, platform_config
    if uri is not None:
        raise ValueError(f"agent_payload_s3_uri must be an s3:// URI, got {uri!r}")

    raise ValueError(
        "runHookPayload envelope has neither agent_payload nor agent_payload_s3_uri "
        f"(keys: {sorted(envelope)})"
    )


#: The ONE executable whose warm-up gates the snapshot, exec'd FIRST.
#:
#: WHY THIS EXISTS (ADR-021 P2-F5, live 2026-08-07). ``/ready`` used to answer 200
#: the moment uvicorn was bound, and its own docstring said the point of the hook
#: was that "the snapshot is taken with a warm server". The snapshot was warm for
#: uvicorn and stone cold for the binary that does all the work: ``claude`` is a
#: **225 MiB (236,305,136-byte) statically-linked ELF** whose pages had never been
#: touched when the snapshot was captured. On a guest restored from that snapshot,
#: the FIRST ``exec`` of it has to fault those pages in from lazily-restored
#: storage — and ``runner.py``'s version probe timed out at 10 s, failing EVERY
#: task at turn 0, reproducibly, while the same binary in the same image answers
#: in under a second locally. Exec'ing it here means those pages are resident when
#: the snapshot is taken, so every MicroVM cloned from it inherits them warm.
#:
#: It is REQUIRED (a failure answers 503 and ultimately fails the image build)
#: because a snapshot that cannot exec ``claude`` cannot run a single task, and it
#: goes FIRST so no best-effort warm-up can eat the budget it needs.
#:
#: ``--version`` is the cheapest argv that still exec's the real binary: it touches
#: no network, writes nothing, and needs no credentials — which is what keeps
#: ``/ready`` AWS-silent (see ``_build_hook_log``).
_READY_WARMUP_REQUIRED: tuple[str, ...] = ("claude", "--version")

#: Best-effort warm-ups, exec'd AFTER the required one and only with what is left
#: of :data:`_READY_WARMUP_TOTAL_BUDGET_SECONDS`.
#:
#: Same mechanism, no measured problem: neither was observed to blow a timeout, and
#: a snapshot missing them is still a snapshot that can start a task — so neither
#: may fail a build, and neither may delay the 200 that a successful required
#: warm-up has already earned. Nothing is added here on speculation: every entry
#: costs build time and, more importantly, snapshot memory.
_READY_WARMUP_OPTIONAL: tuple[tuple[str, ...], ...] = (
    ("git", "--version"),
    ("node", "--version"),
)

#: Budget for the REQUIRED warm-up alone, in seconds.
#:
#: Deliberately generous, and generosity is nearly free: the hook runs once per
#: image build (twice per image — one build per chipset). A cold 225 MiB ``exec``
#: is exactly the operation whose duration nobody here can predict, which is the
#: whole lesson of P2-F5, where a tight bound on a version probe cost every task.
#:
#: Contract-sourced (see :data:`_HOOK_BUDGETS`) so that it, the total ceiling and
#: the CDK hook budget are one edit rather than three.
_READY_WARMUP_REQUIRED_TIMEOUT_SECONDS: int = _HOOK_BUDGETS["warmup_required_timeout_seconds"]

#: Ceiling for the WHOLE warm-up (required + every optional), in seconds.
#:
#: The hook's own budget (``READY_HOOK_TIMEOUT_SECONDS`` in
#: ``cdk/src/constructs/lambda-microvm-compute.ts``) comes from the SAME contract
#: block, and this ceiling must stay strictly below it — ``/ready`` has to answer
#: inside the hook budget, and the margin covers uvicorn scheduling plus the
#: request itself. That margin is the point: per-command budgets do NOT compose —
#: three commands at 120 s each is 360 s, which would blow a 300 s hook budget and
#: turn a warm-up meant to prevent a runtime failure into a build failure. So the
#: required command takes its own budget and the optional ones SHARE whatever is
#: left of this ceiling, meaning the warm-up's worst case is bounded by one number
#: that can be compared against the hook budget by eye — and by
#: ``scripts/check-constants-sync.ts``, which rejects a contract where it is not.
_READY_WARMUP_TOTAL_BUDGET_SECONDS: int = _HOOK_BUDGETS["warmup_total_budget_seconds"]

#: Below this many seconds of remaining budget an optional warm-up is skipped
#: rather than started: a sub-second timeout cannot warm a large binary, it can
#: only manufacture a scary log line.
_READY_WARMUP_MIN_TIMEOUT_SECONDS = 1


def _warm_one_binary(argv: tuple[str, ...], timeout: float) -> str | None:
    """Exec ``argv`` once, bounded by ``timeout``. Returns a failure tag or ``None``.

    Every failure mode of ``subprocess.run`` is caught here rather than propagating
    — a warm-up defect must produce the hook's own honest 503, not a FastAPI 500
    that reports a hook failure with no explanation in the build log. The caller
    decides whether the returned tag is fatal.
    """
    name = argv[0]
    started = _time_for_debug.monotonic()
    try:
        # Fixed argv from the module constants above, `shell=False`, and no user- or
        # payload-derived input anywhere on this path (`/ready` takes no request
        # body at all) — so there is no injection surface here.
        completed = subprocess.run(
            list(argv),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except Exception as exc:
        # FileNotFoundError (not on PATH), TimeoutExpired, PermissionError, …
        elapsed = _time_for_debug.monotonic() - started
        _build_hook_log(f"/ready hook: warm-up of {name!r} FAILED after {elapsed:.1f}s: {exc!r}")
        return f"{name}:{type(exc).__name__}"

    elapsed = _time_for_debug.monotonic() - started
    # Version strings only — no repo content, no credentials — and the first line
    # is enough to identify the binary that was warmed.
    detail = (completed.stdout or completed.stderr or "").strip().splitlines()
    version = detail[0] if detail else ""
    if completed.returncode != 0:
        _build_hook_log(
            f"/ready hook: warm-up of {name!r} exited {completed.returncode} "
            f"after {elapsed:.1f}s ({version!r})"
        )
        return f"{name}:exit{completed.returncode}"

    _build_hook_log(f"/ready hook: warmed {name!r} in {elapsed:.1f}s (version={version!r})")
    return None


def _warm_snapshot_binaries() -> list[str]:
    """Warm the snapshot's heavyweight binaries; return the REQUIRED failures.

    An empty list means the snapshot is warm enough to capture. Best-effort
    failures are logged and never appear in the return value.

    Ordering and budgeting are the contract, not an implementation detail:

    * the REQUIRED command runs FIRST, with its own
      :data:`_READY_WARMUP_REQUIRED_TIMEOUT_SECONDS`, so no best-effort warm-up can
      starve the one that decides whether the snapshot is usable;
    * if it fails, the optional ones are SKIPPED — the image build is already going
      to fail, so spending more of the hook budget warming ``git`` buys nothing and
      delays the 503 the service is waiting for;
    * the optional ones then SHARE what is left of
      :data:`_READY_WARMUP_TOTAL_BUDGET_SECONDS`, each bounded by the remaining
      budget, so a hung optional command can delay the 200 by at most the remainder
      and can never prevent it. Once the remainder falls below
      :data:`_READY_WARMUP_MIN_TIMEOUT_SECONDS` the rest are skipped with a log line.

    Makes ZERO AWS calls and no network calls: ``--version`` execs plus stdout
    lines, so ``/ready``'s AWS-silence property is intact.
    """
    deadline = _time_for_debug.monotonic() + _READY_WARMUP_TOTAL_BUDGET_SECONDS

    failure = _warm_one_binary(_READY_WARMUP_REQUIRED, _READY_WARMUP_REQUIRED_TIMEOUT_SECONDS)
    if failure is not None:
        _build_hook_log(
            f"/ready hook: skipping best-effort warm-ups after {_READY_WARMUP_REQUIRED[0]!r} "
            "failed — the image build cannot succeed, so the 503 should not wait"
        )
        return [failure]

    for argv in _READY_WARMUP_OPTIONAL:
        remaining = deadline - _time_for_debug.monotonic()
        if remaining < _READY_WARMUP_MIN_TIMEOUT_SECONDS:
            _build_hook_log(
                f"/ready hook: skipping best-effort warm-up of {argv[0]!r} — "
                f"{remaining:.1f}s left of the {_READY_WARMUP_TOTAL_BUDGET_SECONDS}s warm-up "
                "ceiling. The required warm-up already succeeded, so this does not "
                "block the snapshot."
            )
            continue
        _warm_one_binary(argv, remaining)

    return []


@app.post(f"{MICROVM_HOOK_PREFIX}/ready")
def microvm_ready():
    """MicroVM image ``/ready`` build hook — "the application has initialised".

    A 200 from this route is the signal the service waits for before taking the
    snapshot, so answering it at all is what makes the image buildable: with the
    hook enabled and nothing serving it, both chipset builds fail with "Ready hook
    check failed: the application returned a client error (HTTP 4xx) response".

    Reaching this handler already proves everything the ORIGINAL ``/ready``
    contract needed: uvicorn is bound on the hook port and ``server`` imported
    cleanly (which pulls in ``pipeline`` → ``runner`` → the policy engine, so a
    missing policy file or a broken import fails the BUILD instead of the first
    task). The *shape* checks — hook routes registered, interpreter and contract
    sanity — belong to ``/validate``, which reports them individually.

    **It then WARMS the snapshot** (:func:`_warm_snapshot_binaries`, ADR-021
    P2-F5). This is the hook's second job and the reason it can now take seconds
    rather than microseconds: the snapshot is only as warm as the pages that were
    touched before it was captured, and the 225 MiB ``claude`` binary was never
    among them — which failed every P2 smoke task at turn 0. A **required**
    warm-up failure returns **503**, the hook contract's "not ready yet" signal,
    so the service keeps asking within the ``/ready`` budget and — if it never
    clears — fails the image build. Failing the build is right: a snapshot that
    cannot exec ``claude`` cannot run a single task, and discovering that at build
    time costs one build instead of every task.

    The whole warm-up is bounded by
    :data:`_READY_WARMUP_TOTAL_BUDGET_SECONDS`, which the shared contract keeps
    strictly inside the hook's own budget with margin to spare — the required
    command takes its own share and the best-effort ones split the remainder, so
    this handler cannot talk itself past the deadline the service is holding it to.

    Makes ZERO AWS calls, including its own logging (``_build_hook_log``): this
    runs under the build role, and a client built here would freeze a build-time
    boto3 session into the snapshot. A ``--version`` subprocess is not an AWS call
    and touches no network, so the warm-up does not weaken that property.

    Declared ``def`` rather than ``async def`` on purpose, and now load-bearing
    rather than stylistic: Starlette runs sync handlers in a threadpool, so a
    warm-up that blocks for seconds never competes with the event loop that has to
    keep ``GET /ping`` fast.
    """
    _build_hook_log("/ready hook: server is up, warming the snapshot before it is taken")
    failures = _warm_snapshot_binaries()
    if failures:
        _build_hook_log(
            f"/ready hook: NOT ready — required warm-up failed for {failures}. "
            "The snapshot would launch MicroVMs that cannot exec these binaries."
        )
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "failed_warmups": failures},
        )
    _build_hook_log("/ready hook: reporting ready for snapshot")
    return {"status": "ready"}


#: Env var names that must never be baked into a MicroVM snapshot (ADR-021
#: sub-decision 3: "the image build shall not embed secrets, tokens, or per-task
#: identity in the snapshot"). ``/validate`` REPORTS these rather than failing on
#: them — see ``microvm_validate``.
_SNAPSHOT_FORBIDDEN_SECRET_ENV = (
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "LINEAR_API_TOKEN",
    "JIRA_API_TOKEN",
    "JIRA_APP_ACTOR_SHARED_SECRET",
    "ANTHROPIC_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
)

#: Interpreter floor, mirroring ``requires-python`` in ``agent/pyproject.toml``.
_MIN_PYTHON_VERSION = (3, 13)

# Set once, as the LAST statement of this module. ``/validate`` reports 503 until
# then: it is the only honest "still initialising" signal available to a build
# hook. Unreachable in practice today (uvicorn accepts no request until the import
# completes) — it is a tripwire for the refactor that moves warm-up work behind the
# bind, at which point the flag is the difference between a 503 and a snapshot
# reported valid while still initialising. See ``microvm_validate``.
_module_initialized = False


@app.post(f"{MICROVM_HOOK_PREFIX}/validate")
def microvm_validate():
    """MicroVM image ``/validate`` build hook — shallow snapshot self-check.

    **THIS HOOK MAKES ZERO AWS API CALLS, AND MUST KEEP MAKING ZERO.** It runs
    during ``CreateMicrovmImage`` under the **build role**, which deliberately
    holds no Bedrock / Secrets Manager / DynamoDB grants (ADR-021 sub-decision 4:
    the build path's only extra privilege is port 80 egress for ``apt-get``). So
    the "deeper warm-up assertions" ADR-021 originally sketched for this hook —
    Bedrock reachability, Memory access, tool availability — are NOT implementable
    here: every one of them would AccessDenied and fail every image build. They
    belong to the first task's own error handling, not to a build hook.

    The one member of that list that turned out to be *partly* implementable landed
    on ``/ready`` instead, and for a different reason: ``/ready`` warms (and so
    incidentally proves the execability of) the local ``claude`` binary, because a
    cold 225 MiB ELF in the snapshot killed every task at turn 0 (ADR-021 P2-F5).
    That is a local ``exec``, not an AWS call, so it violates nothing above — but it
    belongs to the hook whose 200 gates the snapshot, not to the hook that reports
    check results.

    It must also not touch credential resolution: ``platform_config`` has not
    arrived yet (it comes with ``/run``), and any client built here would leave a
    resolved boto3 session — with the build role's credentials and the build
    region — frozen in the snapshot for every MicroVM launched from it. Hence
    ``_build_hook_log`` instead of ``_debug_cw``, and no import of
    ``aws_session``.

    What it CAN prove, all in-process:

    * the server is alive and this route is reachable at all;
    * every hook route the image declares is registered (a typo'd prefix would
      otherwise surface as a failed lifecycle transition on the first real task);
    * interpreter floor, and that the cross-package ``platform_config`` contract
      loaded — the thing ``/run`` will validate the payload against.

    Returns 200 with the individual check results. Returns **503** while the
    module has not finished initialising, per the hook contract's
    still-initialising semantics; a permanently failing check therefore fails the
    image build, which is the correct outcome for a genuinely broken snapshot.

    **The 503 branch is a REFACTOR TRIPWIRE, not a reachable state today.**
    ``_module_initialized`` is set as the last statement of this module and uvicorn
    does not accept a request until the import completes, so under the current
    import-time-only initialisation the check cannot be observed False from a real
    hook call. It is kept because that is a property of *how the module happens to
    initialise*, not of the contract: the moment anyone moves warm-up work behind
    the bind — a lifespan startup task, a lazily-built cache, a thread the first
    request has to wait on — the honest answer becomes 503, and a hook that had
    only a 200 path would report a broken snapshot as a valid one. Cheap to keep,
    silently wrong to delete.

    Baked-secret detection is REPORT-ONLY (``warnings``): the build environment's
    own credentials may legitimately be in this process's env, so failing here
    would fail every build. Names only — never values.
    """
    expected_routes = {
        f"{MICROVM_HOOK_PREFIX}/{hook}" for hook in ("ready", "validate", "run", "terminate")
    }
    registered = {getattr(route, "path", None) for route in app.routes}
    missing_routes = sorted(expected_routes - registered)

    checks = {
        "server_initialized": _module_initialized,
        "hook_routes_registered": not missing_routes,
        "python_version_supported": sys.version_info[:2] >= _MIN_PYTHON_VERSION,
        "platform_config_contract_loaded": bool(MICROVM_PLATFORM_CONFIG_ENV_BY_KEY),
    }
    failed = sorted(name for name, ok in checks.items() if not ok)

    baked_secrets = [name for name in _SNAPSHOT_FORBIDDEN_SECRET_ENV if os.environ.get(name)]

    body: dict[str, Any] = {
        "status": "valid" if not failed else "not_ready",
        "checks": checks,
        "python_version": ".".join(str(part) for part in sys.version_info[:3]),
        "hook_prefix": MICROVM_HOOK_PREFIX,
        "platform_config_keys": len(MICROVM_PLATFORM_CONFIG_ENV_BY_KEY),
        "warnings": [f"secret_env_present_in_snapshot:{name}" for name in baked_secrets],
    }
    if missing_routes:
        body["missing_routes"] = missing_routes

    if baked_secrets:
        # Named, on its OWN line, and emitted on both the 200 and 503 paths.
        # Report-only is the right call — a baked secret must not fail an image
        # build that is otherwise sound — but DISCARDING the report is not: the
        # `warnings` array below rides a response body the MicroVM service does not
        # parse, so without this line the one signal that a snapshot froze a
        # credential reaches nobody. `_build_hook_log` puts it in the build log
        # group, which is the artifact an operator actually reads.
        _build_hook_log(
            "/validate hook WARNING: secret-bearing env var(s) present in the "
            f"snapshot: {baked_secrets}. ADR-021 sub-decision 3 forbids baking "
            "secrets, tokens, or per-task identity into an image — every MicroVM "
            "restored from this snapshot inherits them. Re-build the image without "
            "them; the run itself is not blocked."
        )

    if failed:
        body["failed_checks"] = failed
        _build_hook_log(f"/validate hook: NOT ready, failed checks={failed}")
        return JSONResponse(status_code=503, content=body)

    _build_hook_log(
        f"/validate hook: ok (python={body['python_version']}, "
        f"platform_config_keys={body['platform_config_keys']}, warnings={len(baked_secrets)})"
    )
    return body


@app.post(f"{MICROVM_HOOK_PREFIX}/terminate")
async def microvm_terminate(request: Request):
    """MicroVM ``/terminate`` runtime hook — best-effort flush, always 200.

    Called as the MicroVM is torn down. Three hard constraints:

    * **It must not write terminal task status.** The orchestrator owns terminal
      state: it finalizes the task and THEN calls ``TerminateMicrovm``, so a
      terminate hook that wrote ``FAILED``/``COMPLETED`` would race the
      finalization it follows and could clobber the real outcome with a
      substrate-shutdown artifact. The pipeline thread's own crash path
      (``_run_task_background``) remains the only in-guest terminal writer.
    * **It must return 200 inside the hook budget, even with nothing running.**
      So it never joins the pipeline thread (a drain could take minutes — that is
      ``lifespan``'s job on a graceful shutdown) and every best-effort step is
      wrapped: a failure here must not turn a clean teardown into a hook failure.
    * **It must return 200 for any BODY too.** That is why this handler takes the
      raw ``Request`` instead of a Pydantic body model: FastAPI validates a typed
      body BEFORE the handler runs, so malformed JSON, a wrong content-type, or a
      missing body would produce a 422 this function never gets a chance to
      prevent — a reported hook failure on a successful teardown. Parsing is
      deferred to ``_parse_terminate_microvm_id``, which degrades to ``""``.

    ``async def`` (unlike ``/ready`` and ``/run``) because reading the raw body
    requires awaiting it. Safe on the event loop: the work is a JSON parse, a
    thread-count read and a fire-and-forget log — no blocking AWS call.

    On flushing: there is nothing buffered to flush. ``_ProgressWriter`` performs
    a synchronous DynamoDB ``put_item`` per event, and ``task_state`` writes
    inline, so every progress/status write is already durable at call time — this
    hook has no queue to drain, which is why it is a log-and-acknowledge rather
    than a flush loop. (ADR-021 sub-decision 2's "flush progress events before
    returning 200" applies to ``/suspend`` in P3 for the same reason: durability
    is per-write, so the hook only has to observe it.)
    """
    raw = b""
    try:
        raw = await request.body()
    except Exception as exc:
        # A truncated/aborted body must not become a 5xx: the VM is going away and
        # the id is only a correlation string. Logged, not swallowed.
        _emit_stdout_line(f"[server/warn] /terminate hook could not read its body: {exc!r}")
    microvm_id = _parse_terminate_microvm_id(raw)

    # `None`, not `0`: if the thread-count read below raises, "we could not tell"
    # must not be reported as the confident "nothing was running" — the one reading
    # an operator would use to conclude a clean teardown.
    active: int | None = None
    try:
        with _threads_lock:
            active = sum(1 for t in _active_threads if t.is_alive())
        # Final structured line. Fire-and-forget CloudWatch (LOG_GROUP_NAME is
        # present at runtime when the orchestrator delivered it via /run's
        # platform_config; on the legacy no-config path `_debug_cw` degrades to
        # stdout) so a terminated MicroVM leaves a last breadcrumb in the task's log
        # group; stdout regardless.
        #
        # `microvm_id` is normally `""` here — that is what the service sends on
        # this hook (P2-F8, see `_parse_terminate_microvm_id`), not a parse
        # failure. The load-bearing fields are the pipeline-state ones.
        _debug_cw(
            "/terminate hook: "
            + json.dumps(
                {
                    "event": "microvm_terminate",
                    "microvm_id": microvm_id,
                    "active_pipeline_threads": active,
                    "background_pipeline_failed": _background_pipeline_failed,
                    "timestamp": datetime.now(UTC).isoformat(),
                },
                sort_keys=True,
            )
        )
    except Exception as exc:
        # Best-effort by contract: the VM is going away either way, and a 5xx
        # here would report a hook failure for a teardown that succeeded. Logged
        # (not swallowed) so the failure is still findable.
        _emit_stdout_line(f"[server/warn] /terminate hook best-effort step failed: {exc!r}")

    return {
        "status": "acknowledged",
        "microvm_id": microvm_id,
        "active_pipeline_threads": active,
        "timestamp": datetime.now(UTC).isoformat(),
    }


@app.post(f"{MICROVM_HOOK_PREFIX}/run")
def microvm_run(request: Request, body: MicrovmRunHookRequest):
    """MicroVM ``/run`` lifecycle hook — accept the task and start the pipeline.

    Fast-notification contract (1-60 s hook budget): validate, spawn, return 200.
    The pipeline itself must NOT run on the hook path, so this reuses the exact
    mechanism ``/invocations`` uses — ``_extract_invocation_params`` →
    ``_validate_required_params`` → ``_spawn_background`` — rather than a second,
    drifting payload mapper. The orchestrator payload is byte-identical across
    substrates (AgentCore receives it as ``input``, ECS as ``AGENT_PAYLOAD``,
    MicroVMs inside this envelope), which is what makes that reuse correct.

    ``platform_config`` (P2) is installed into ``os.environ`` FIRST — before
    ``_extract_invocation_params``, which calls ``resolve_github_token()`` and so
    reads ``GITHUB_TOKEN_SECRET_ARN``, and before any pipeline/credential
    initialisation that reads ``AGENT_SESSION_ROLE_ARN`` or the table names.
    Installing after that point would resolve the whole task against the
    snapshot's version-frozen env and silently ignore the values the orchestrator
    sent.

    Session/workload headers are absent here (there is no AgentCore Runtime in
    front of this call), so ``_extract_invocation_params`` resolves an empty
    ``session_id`` / workload token — the same posture the ECS backend already
    has, per ADR-021 sub-decision 3's identity delta.

    Sync ``def`` for the same reason as ``/ready``, and additionally because the
    S3 payload fetch is a blocking boto3 call: in a threadpool it cannot stall
    the event loop.

    **Every log line before the install goes through ``_pre_config_log``** (stdout
    only). Until ``platform_config`` is in the environment, a ``_debug_cw`` here
    would resolve AWS credentials and pin ``boto3.DEFAULT_SESSION`` off whatever
    the snapshot happens to carry — the same defect the build hooks avoid, one
    phase later. The single AWS call this phase is allowed to make is the S3
    payload fetch, because the config is inside the object being fetched.
    """
    _pre_config_log(
        f"/run hook received: microvm_id={body.microvmId!r} bytes={len(body.runHookPayload)}"
    )

    try:
        payload, platform_config = _resolve_microvm_run_payload(body.runHookPayload)
    except ValueError as exc:
        # Bad envelope — the orchestrator built something this agent cannot act
        # on. 400 (not 500) because retrying an identical body cannot help.
        _pre_config_log(f"/run hook rejected: {exc}")
        return JSONResponse(
            status_code=400,
            content={
                "code": "MICROVM_RUN_PAYLOAD_INVALID",
                "message": str(exc),
            },
        )
    except Exception as exc:
        # Payload could not be READ: S3 AccessDenied / NoSuchKey / transient, or a
        # `_PayloadFetchError` for an object that fetched but was truncated,
        # non-JSON, or not an object. 500 so the failure is distinguishable from a
        # malformed ENVELOPE (the 400 above) and is correctly reported as
        # retryable, and loud enough to find in the MicroVM log group — via the
        # response body, since the CloudWatch writer is off-limits until the config
        # is installed.
        _pre_config_log(
            f"/run hook payload fetch FAILED [{type(exc).__name__}: {exc}]\n"
            f"{traceback.format_exc()}"
        )
        return JSONResponse(
            status_code=500,
            content={
                "code": "MICROVM_RUN_PAYLOAD_UNREADABLE",
                "message": f"{type(exc).__name__}: {exc}",
            },
        )

    task_id_log = str(payload.get("task_id", ""))

    try:
        installed_env = _install_platform_config(platform_config)
    except _PlatformConfigError as exc:
        _pre_config_log(f"/run hook rejected: {exc}")
        return JSONResponse(
            status_code=400,
            content={"code": exc.code, "message": str(exc)},
        )

    if installed_env:
        # Names only: the values are non-secret identifiers, but the list is what
        # an operator needs to see when the agent behaves as if a table or bucket
        # were missing. Emitted AFTER the install so it can reach the log group
        # the payload just named.
        _debug_cw(
            f"/run hook installed platform_config env: {installed_env}",
            task_id=task_id_log or None,
        )
    else:
        # No `platform_config` — the legacy P1 envelope. This branch must NOT simply
        # shrug: the required keys exist because without them the agent cannot write
        # status/progress, resolve the GitHub token, or (decisively)
        # tenant-scope its credentials — `aws_session.get_session` falls back to the
        # ambient compute role with scoping silently OFF when
        # `AGENT_SESSION_ROLE_ARN` is unset. So the check is re-run against the
        # EFFECTIVE environment: a legacy or hand-built image that bakes those
        # values still runs (that is the compatibility this branch is for), while
        # version skew — a pre-Stage-B orchestrator launching a P2 image, which
        # bakes nothing — is REJECTED instead of running unscoped.
        #
        # STILL pre-install, so the line is stdout only. A `_warn_cw` here would
        # spawn the CloudWatch writer thread and pin `boto3.DEFAULT_SESSION` off the
        # snapshot's baked env, which is the very defect this branch is reporting.
        # Nothing is lost: on the intended deployment (no baked `LOG_GROUP_NAME`)
        # `_warn_cw` would have degraded to this same stdout line, on a legacy image
        # the log group would be the wrong one anyway, and the rejection reason also
        # travels in the structured response body the service surfaces.
        absent = _absent_required_platform_env()
        if absent:
            _pre_config_log(
                f"/run hook REJECTED: no platform_config and the image snapshot does "
                f"not supply required value(s) either: {absent}"
                + (f" task_id={task_id_log!r}" if task_id_log else "")
            )
            return JSONResponse(
                status_code=400,
                content={
                    "code": "MICROVM_RUN_PLATFORM_CONFIG_INCOMPLETE",
                    "message": (
                        "The /run envelope carried no platform_config and the image "
                        "snapshot does not carry the required values either, so this "
                        f"MicroVM cannot run a task: {absent} are unset. This is a "
                        "version skew — an orchestrator predating ADR-021 P2 launching "
                        "a P2 image, which bakes no environment by design. Refusing "
                        "rather than running with tenant scoping disabled. Redeploy the "
                        "orchestrator so it sends platform_config."
                    ),
                    "missing_env": absent,
                },
            )
        _pre_config_log(
            "/run hook received no platform_config; running on the image snapshot's "
            "own environment, which is frozen at build time and which DOES supply "
            "every required value. Expected only from an orchestrator that predates "
            "ADR-021 P2 paired with an image that bakes its own configuration."
            + (f" task_id={task_id_log!r}" if task_id_log else "")
        )

    try:
        params = _extract_invocation_params(payload, request)
    except Exception as exc:
        _debug_cw_exc(
            "/run hook _extract_invocation_params FAILED", exc, task_id=task_id_log or None
        )
        raise

    missing = _validate_required_params(params)
    if missing:
        _debug_cw(
            f"/run hook rejected: missing required params {missing!r}",
            task_id=task_id_log or None,
        )
        return JSONResponse(
            status_code=400,
            content={
                "code": "TASK_RECORD_INCOMPLETE",
                "message": (
                    "Task record is missing required fields. The orchestrator "
                    "should have populated these before starting the MicroVM."
                ),
                "missing": missing,
            },
        )

    _spawn_background(params)
    task_id = params["task_id"]
    # Carries microvm_id as well as task_id: the "/run hook received" line that
    # used to correlate the two is stdout-only now (pre-install), so this is the
    # first line that reaches the task's log group and it has to join the CloudWatch
    # record to the control-plane one on its own.
    _debug_cw(
        f"/run hook accepted task_id={task_id!r} microvm_id={body.microvmId!r}",
        task_id=task_id or None,
    )
    return {
        "status": "accepted",
        "task_id": task_id,
        "microvm_id": body.microvmId,
        "timestamp": datetime.now(UTC).isoformat(),
    }


# LAST statement in the module, on purpose: ``/validate`` reports 503 until this
# flips, so the flag means "import completed" rather than "the flag exists".
_module_initialized = True
