"""FastAPI server for AgentCore Runtime and Lambda MicroVMs.

Exposes /invocations (POST) and /ping (GET) on port 8080, matching the AgentCore
Runtime container contract, plus the AWS Lambda MicroVMs lifecycle hooks under
``/aws/lambda-microvms/runtime/v1/`` on the same port.

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
from microvm_http import microvm_resume, microvm_suspend
from microvm_lifecycle import (
    LifecycleUnavailable,
    get_context,
    get_registered_context,
    register_task,
    reseed_random,
    unregister_task,
)
from models import TaskResult
from observability import propagate_correlation_context
from pipeline import run_task
from shared_constants import SHARED_CONSTANTS
from shell import redact_secrets


def _emit_stdout_line(stamped: str) -> None:
    # CodeQL's cleartext-logging query models ``print`` and ``TextIOWrapper.write`` only.
    line = (stamped + "\n").encode("utf-8", errors="replace")
    try:
        while line:
            n = os.write(1, line)
            line = line[n:]
    except OSError:
        pass


def _debug_cw(msg: str, *, task_id: str | None = None) -> None:
    msg = redact_secrets(msg)
    stamped = f"[server/debug] {msg}"
    _emit_stdout_line(stamped)

    log_group = os.environ.get("LOG_GROUP_NAME")
    if not log_group:
        return

    # AgentCore's health check hits the container within ~1 s of boot: a synchronous
    # boto3 call here would keep uvicorn from answering ``GET /ping`` in time.
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
    tb = traceback.format_exc()
    _debug_cw(f"{message} [{type(exc).__name__}: {exc}]\n{tb}", task_id=task_id)


def _warn_cw(msg: str, *, task_id: str | None = None) -> None:
    msg = redact_secrets(msg)
    stamped = f"[server/warn] {msg}"
    _emit_stdout_line(stamped)

    # AgentCore does not forward container stdout to the APPLICATION_LOGS group.
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
        print(
            f"[server/warn/self] CloudWatch write failed: {type(_exc).__name__}: {_exc}",
            flush=True,
        )


def _debug_cw_write_blocking(log_group: str, task_id: str | None, stamped: str) -> None:
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
        print(
            f"[server/debug/self] CloudWatch write failed: {type(_exc).__name__}: {_exc}",
            flush=True,
        )


class _PingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return "GET /ping" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_PingFilter())

_active_threads: list[threading.Thread] = []
_threads_lock = threading.Lock()


_background_pipeline_failed: bool = False

_last_ping_status: str = ""

_HEARTBEAT_INTERVAL_SECONDS = 45


def _heartbeat_worker(task_id: str, stop: threading.Event) -> None:
    while not stop.wait(timeout=_HEARTBEAT_INTERVAL_SECONDS):
        try:
            lifecycle = get_context(task_id)
            if lifecycle:
                with lifecycle.activity():
                    task_state.write_heartbeat(task_id)
            else:
                task_state.write_heartbeat(task_id)
        except LifecycleUnavailable:
            continue
        except Exception as e:
            print(
                f"[heartbeat] write_heartbeat error (will retry): {type(e).__name__}: {e}",
                flush=True,
            )


def _drain_threads(timeout: int = 300) -> None:
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
    yield
    _drain_threads()


app = FastAPI(title="Background Agent", version="1.0.0", lifespan=lifespan)


def _extract_workload_access_token(request: Request) -> str:
    # ``WorkloadAccessToken`` is the documented header (``ACCESS_TOKEN_HEADER`` in the SDK's
    # ``runtime.models``); AgentCore also sends the undocumented ``x-amzn-...-runtime-...`` one.
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
      arrive".
    * HTTP 503 + ``{"status": "unhealthy", ...}`` — the background pipeline
      thread crashed.
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
    resolved_assets: list[dict] | None = None,
    microvm_id: str = "",
) -> None:
    global _background_pipeline_failed

    # Python ContextVar storage is per-thread: the token the SDK set in the request
    # handler's context is not visible here (aws/bedrock-agentcore-sdk-python#219).
    if workload_access_token:
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

    lifecycle = register_task(task_id, microvm_id) if microvm_id else None
    if lifecycle is not None:
        # Sockets idle across a long suspend can be dropped silently (VPC
        # endpoint/NAT idle timeout is 350 s). Claude Code waits 300 s for response
        # headers by default; streamed bodies keep their own idle watchdog.
        os.environ.setdefault("API_TIMEOUT_MS", "120000")
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
            resolved_assets=resolved_assets,
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
        if lifecycle:
            unregister_task(lifecycle)
        stop_heartbeat.set()
        if hb_thread is not None and hb_thread.is_alive():
            hb_thread.join(timeout=3)
        if task_id:
            from aws_session import release_session

            release_session(task_id)


def _extract_invocation_params(inp: dict, request: Request) -> dict:
    repo_url = inp.get("repo_url") or os.environ.get("REPO_URL", "")
    github_token = inp.get("github_token") or resolve_github_token()
    issue_number = str(inp.get("issue_number", "")) or os.environ.get("ISSUE_NUMBER", "")
    task_description = (
        inp.get("prompt", "")
        or inp.get("task_description", "")
        or os.environ.get("TASK_DESCRIPTION", "")
    )
    anthropic_model = (
        inp.get("model_id") or inp.get("anthropic_model") or os.environ.get("ANTHROPIC_MODEL", "")
    )
    system_prompt_overrides = inp.get("system_prompt_overrides", "")
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
    base_branch = inp.get("base_branch") or None
    merge_branches_raw = inp.get("merge_branches") or []
    merge_branches = [b for b in merge_branches_raw if isinstance(b, str)]
    cedar_policies = inp.get("cedar_policies") or []
    resolved_assets = inp.get("resolved_assets") or []
    approval_timeout_s = inp.get("approval_timeout_s")
    initial_approvals = inp.get("initial_approvals") or []
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
    trace = inp.get("trace") is True
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

    started_at = inp.get("task_started_at", "")
    if started_at and isinstance(started_at, str):
        os.environ["TASK_STARTED_AT"] = started_at

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
        "resolved_assets": resolved_assets,
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
    missing: list[str] = []
    workflow_id = (params.get("resolved_workflow") or {}).get("id", "coding/new-task-v1")

    requires_repo = True
    try:
        from workflow import WorkflowValidationError, load_workflow

        try:
            requires_repo = load_workflow(workflow_id).resolved_requires_repo
        except WorkflowValidationError:
            _warn_cw(f"could not resolve requires_repo for {workflow_id!r}; assuming repo required")
    except ImportError:
        _warn_cw(f"workflow loader unavailable for {workflow_id!r}; assuming repo required")
    if requires_repo and not params.get("repo_url"):
        missing.append("repo_url")

    if workflow_id in ("coding/pr-iteration-v1", "coding/pr-review-v1", "coding/restack-v1"):
        if not params.get("pr_number"):
            missing.append("pr_number")
    else:
        has_issue = bool(params.get("issue_number"))
        has_desc = bool(params.get("task_description"))
        if not (has_issue or has_desc):
            missing.append("issue_number_or_task_description")
    return missing


def _spawn_background(params: dict) -> threading.Thread:
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

    Any ``Accept: text/event-stream`` header is ignored — this runtime does
    not support live SSE streaming. Progress is observable via the durable
    DynamoDB records written by ``ProgressWriter``.
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


MICROVM_HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1"

app.add_api_route(f"{MICROVM_HOOK_PREFIX}/suspend", microvm_suspend, methods=["POST"])
app.add_api_route(f"{MICROVM_HOOK_PREFIX}/resume", microvm_resume, methods=["POST"])

_S3_URI_SCHEME = "s3://"

_PLATFORM_CONFIG_CONTRACT: dict[str, Any] = SHARED_CONSTANTS["microvm_platform_config"]

MICROVM_PLATFORM_CONFIG_ENV_BY_KEY: dict[str, str] = dict(_PLATFORM_CONFIG_CONTRACT["env_by_key"])

MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS: frozenset[str] = frozenset(
    _PLATFORM_CONFIG_CONTRACT["required"]
)

MICROVM_PLATFORM_CONFIG_ARN_KEYS: frozenset[str] = frozenset(_PLATFORM_CONFIG_CONTRACT["arn_keys"])

MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY: str = _PLATFORM_CONFIG_CONTRACT["account_anchor_key"]

_PLATFORM_CONFIG_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_PLATFORM_CONFIG_ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")

# A NUL makes ``os.environ[...] = value`` raise ``ValueError``; ``\x1b`` starts an ANSI escape
# sequence; ``\x0b``, ``\x0c`` and ``\x1c``-``\x1e`` are ``str.splitlines()`` boundaries.
_PLATFORM_CONFIG_FORBIDDEN_VALUE_CHARS = frozenset(chr(code) for code in range(0x20)) | {"\x7f"}


# ``arn:partition:service:region:account:resource``. The resource segment may
# itself contain colons (``secret:name-AbCdEf``).
_ARN_MIN_FIELDS = 6


def _validate_platform_config_contract() -> None:
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
    if anchor not in MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS:
        raise ValueError(
            f"{where}.account_anchor_key {anchor!r} must also be listed in .required — "
            "an optional anchor would make ARN pinning skippable by omission"
        )


_validate_platform_config_contract()


_HOOK_BUDGETS: dict[str, int] = SHARED_CONSTANTS["microvm_hook_budgets"]


def _validate_hook_budget_contract() -> None:
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
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _absent_required_platform_env() -> list[str]:
    return sorted(
        MICROVM_PLATFORM_CONFIG_ENV_BY_KEY[key]
        for key in MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS
        if not os.environ.get(MICROVM_PLATFORM_CONFIG_ENV_BY_KEY[key], "").strip()
    )


def _reject_foreign_arns(resolved: dict[str, str]) -> None:
    anchor_value = resolved.get(MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY, "")
    anchor_parts = anchor_value.split(":")
    if len(anchor_parts) < _ARN_MIN_FIELDS or anchor_parts[0] != "arn" or anchor_parts[2] != "iam":
        raise _PlatformConfigError(
            "MICROVM_RUN_PLATFORM_CONFIG_INVALID",
            f"platform_config.{MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY} must be a "
            "well-formed IAM role ARN (arn:<partition>:iam::<account>:role/…) — it is "
            "the anchor every other ARN in the block is checked against, so a "
            f"malformed one would let the block agree with itself; got {anchor_value!r}",
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
            "resolves credentials and fetches secrets, so an ARN that disagrees with "
            "the rest of the block is refused at the door rather than left to "
            "AccessDeny mid-startup; "
            f"rejected {rejected} (expected partition {want_partition!r}, account "
            f"{want_account!r}, taken from {MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY})",
        )


def _install_platform_config(raw: Any) -> list[str]:
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
        if any(char in _PLATFORM_CONFIG_FORBIDDEN_VALUE_CHARS for char in value):
            bad_types.append(f"{key}:control-characters")
            continue
        cleaned = value.strip()
        if cleaned:
            resolved[key] = cleaned

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

    ``boto3.client`` populates ``boto3.DEFAULT_SESSION``, a module global
    that memoizes the resolved credentials for the life of the process
    (``botocore.session.Session.get_credentials`` loads once, then caches).
    """
    _emit_stdout_line(f"[server/{tag}] {redact_secrets(msg)}")


def _build_hook_log(msg: str) -> None:
    _aws_silent_log(msg, tag="build-hook")


def _pre_config_log(msg: str) -> None:
    _aws_silent_log(msg, tag="run-pre-config")


def _parse_terminate_microvm_id(raw: bytes) -> str:
    """Best-effort MicroVM id out of the raw ``/terminate`` body.

    The service sends a body whose ``microvmId`` is the empty string on this hook,
    unlike ``/run``, where it is populated.
    """
    if not raw.strip():
        return ""
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        _emit_stdout_line(f"[server/warn] /terminate hook body is not JSON ({exc}); ignoring it")
        # nosemgrep: py-silent-success-masking -- /terminate must answer 200 for ANY body (see docstring); "" is the EXPECTED production id, raising would report a hook failure for a teardown that succeeded, and the unreadable body is logged above  # noqa: E501
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
    string (``lambda-microvm-strategy.ts``) is one of two shapes:

    * ``{"agent_payload": {...}, "platform_config": {...}}`` — inline.
    * ``{"agent_payload_s3_uri": "s3://bucket/key", "platform_config": {...}}`` —
      a pointer; the object at the URI carries the task payload (and a
      ``platform_config`` copy).

    The service caps ``runHookPayload`` at 4 096 bytes.

    ``platform_config`` is a SIBLING of ``agent_payload``, not a field inside it.

    Both fields default to empty so a malformed call produces this module's
    structured 400 rather than FastAPI's 422.
    """

    microvmId: str = ""
    runHookPayload: str = ""


class _PayloadFetchError(Exception):
    pass


def _fetch_microvm_payload_from_s3(uri: str) -> dict:
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
        platform_config = fetched.get("platform_config")
        if platform_config is None:
            platform_config = envelope.get("platform_config")
        nested = fetched.get("agent_payload")
        if nested is None:
            return fetched, platform_config
        if not isinstance(nested, dict):
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


# Measured: on a MicroVM restored from the snapshot, the first exec of ``claude`` (a 225 MiB
# static ELF) faults its pages in from lazily-restored storage and took more than 10 s.
_READY_WARMUP_REQUIRED: tuple[str, ...] = ("claude", "--version")

_READY_WARMUP_OPTIONAL: tuple[tuple[str, ...], ...] = (
    ("git", "--version"),
    ("node", "--version"),
)

_READY_WARMUP_REQUIRED_TIMEOUT_SECONDS: int = _HOOK_BUDGETS["warmup_required_timeout_seconds"]

_READY_WARMUP_TOTAL_BUDGET_SECONDS: int = _HOOK_BUDGETS["warmup_total_budget_seconds"]

_READY_WARMUP_MIN_TIMEOUT_SECONDS = 1


def _warm_one_binary(argv: tuple[str, ...], timeout: float) -> str | None:
    name = argv[0]
    started = _time_for_debug.monotonic()
    try:
        completed = subprocess.run(
            list(argv),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except Exception as exc:
        elapsed = _time_for_debug.monotonic() - started
        _build_hook_log(f"/ready hook: warm-up of {name!r} FAILED after {elapsed:.1f}s: {exc!r}")
        return f"{name}:{type(exc).__name__}"

    elapsed = _time_for_debug.monotonic() - started
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
    snapshot: with the hook enabled and nothing serving it, both chipset builds
    fail with "Ready hook check failed: the application returned a client error
    (HTTP 4xx) response".

    Warms the snapshot first (:func:`_warm_snapshot_binaries`): the snapshot is
    only as warm as the pages that were touched before it was captured. A
    required warm-up failure returns 503, the hook contract's "not ready yet"
    signal, so the service keeps asking within the ``/ready`` budget and — if it
    never clears — fails the image build.

    Makes ZERO AWS calls, including its own logging (``_build_hook_log``): this
    runs under the build role, and a client built here would freeze a build-time
    boto3 session into the snapshot.

    Declared ``def`` rather than ``async def``: Starlette runs sync handlers in a
    threadpool, so a warm-up that blocks for seconds never competes with the
    event loop that has to keep ``GET /ping`` fast.
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

_MIN_PYTHON_VERSION = (3, 13)

_module_initialized = False


@app.post(f"{MICROVM_HOOK_PREFIX}/validate")
def microvm_validate():
    """MicroVM image ``/validate`` build hook — shallow snapshot self-check.

    Makes ZERO AWS API calls and touches no credential resolution. It runs during
    ``CreateMicrovmImage`` under the build role, which holds no Bedrock / Secrets
    Manager / DynamoDB grants, and any client built here would leave a resolved
    boto3 session — with the build role's credentials — frozen in the snapshot
    for every MicroVM launched from it.

    Checks, all in-process:

    * every hook route the image declares is registered;
    * interpreter floor, and that the cross-package ``platform_config`` contract
      loaded.

    Returns 200 with the individual check results. Returns 503 while a check
    fails, per the hook contract's still-initialising semantics; a permanently
    failing check therefore fails the image build.

    Baked-secret detection is report-only (``warnings``). Names only — never
    values.
    """
    expected_routes = {
        f"{MICROVM_HOOK_PREFIX}/{hook}"
        for hook in ("ready", "validate", "run", "terminate", "suspend", "resume")
    }
    registered = {getattr(route, "path", None) for route in app.routes}
    missing_routes = sorted(expected_routes - registered)

    checks = {
        "server_initialized": _module_initialized,
        "hook_routes_registered": not missing_routes,
        "python_version_supported": sys.version_info[:2] >= _MIN_PYTHON_VERSION,
        "platform_config_contract_loaded": bool(MICROVM_PLATFORM_CONFIG_ENV_BY_KEY),
        "image_lifecycle_protocol_supported": os.environ.get(
            SHARED_CONSTANTS["microvm_lifecycle"]["image_protocol_env"]
        )
        in (None, str(SHARED_CONSTANTS["microvm_lifecycle"]["protocol_version"])),
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
        # The MicroVM service does not parse the hook's response body.
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


_TERMINATE_BODY_BUDGET_SECONDS = 1.0


@app.post(f"{MICROVM_HOOK_PREFIX}/terminate")
async def microvm_terminate(request: Request):
    """MicroVM ``/terminate`` runtime hook — always 200.

    Called as the MicroVM is torn down. Three hard constraints:

    * It does not write terminal task status. The orchestrator owns terminal
      state: it finalizes the task and THEN calls ``TerminateMicrovm``.
    * It returns 200 inside the hook budget, even with nothing running. It never
      joins the pipeline thread.
    * It returns 200 for any BODY too. It takes the raw ``Request`` instead of a
      Pydantic body model: FastAPI validates a typed body BEFORE the handler
      runs, so malformed JSON, a wrong content-type, or a missing body would
      produce a 422.

    Closes the local coding barrier first and bounds the body read.
    """
    try:
        lifecycle = get_registered_context()
        if lifecycle is not None:
            lifecycle.close()
    except Exception as exc:
        _emit_stdout_line(f"[server/warn] /terminate barrier close failed: {type(exc).__name__}")
    raw = b""
    try:
        async with asyncio.timeout(_TERMINATE_BODY_BUDGET_SECONDS):
            raw = await request.body()
    except Exception as exc:
        _emit_stdout_line(f"[server/warn] /terminate hook could not read its body: {exc!r}")
    microvm_id = _parse_terminate_microvm_id(raw)

    active: int | None = None
    try:
        with _threads_lock:
            active = sum(1 for t in _active_threads if t.is_alive())
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
    The pipeline itself does not run on the hook path. The orchestrator payload
    is byte-identical across substrates (AgentCore receives it as ``input``, ECS
    as ``AGENT_PAYLOAD``, MicroVMs inside this envelope).

    ``platform_config`` is installed into ``os.environ`` FIRST, before anything
    reads ``GITHUB_TOKEN_SECRET_ARN``, ``AGENT_SESSION_ROLE_ARN`` or the table
    names.

    Session/workload headers are absent here (there is no AgentCore Runtime in
    front of this call): ``session_id`` and the workload token are empty.

    Sync ``def`` for the same reason as ``/ready``, and because the S3 payload
    fetch is a blocking boto3 call: in a threadpool it cannot stall the event
    loop.
    """
    _pre_config_log(
        f"/run hook received: microvm_id={body.microvmId!r} bytes={len(body.runHookPayload)}"
    )

    try:
        payload, platform_config = _resolve_microvm_run_payload(body.runHookPayload)
    except ValueError as exc:
        _pre_config_log(f"/run hook rejected: {exc}")
        return JSONResponse(
            status_code=400,
            content={
                "code": "MICROVM_RUN_PAYLOAD_INVALID",
                "message": str(exc),
            },
        )
    except Exception as exc:
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
        _debug_cw(
            f"/run hook installed platform_config env: {installed_env}",
            task_id=task_id_log or None,
        )
    else:
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

    reseed_random()
    _spawn_background({**params, "microvm_id": body.microvmId})
    task_id = params["task_id"]
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


_module_initialized = True
