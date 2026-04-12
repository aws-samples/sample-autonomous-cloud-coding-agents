"""FastAPI server for AgentCore Runtime.

Exposes /invocations (POST) and /ping (GET) on port 8080,
matching the AgentCore Runtime container contract.

The /invocations handler accepts the task, spawns a background thread
to run the agent pipeline, and returns immediately with an acceptance
response. Task progress is tracked in DynamoDB (see task_state.py).
"""

import asyncio
import logging
import os
import threading
import traceback
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI, Request
from pydantic import BaseModel

from config import resolve_github_token
from observability import set_session_id
from pipeline import run_task

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
    """Health check endpoint. Must remain responsive at all times."""
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
) -> None:
    """Run the agent task in a background thread."""
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
        )
    except Exception as e:
        print(f"Background task {task_id} failed: {type(e).__name__}: {e}")
        traceback.print_exc()


@app.post("/invocations", response_model=InvocationResponse)
def invoke_agent(request: Request, body: InvocationRequest):
    """Accept a task and run the agent pipeline in a background thread.

    Returns immediately with an acceptance response containing the task_id.
    Task progress is tracked in DynamoDB via task_state.
    """
    inp = body.input

    # Extract params — payload overrides env vars
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

    # Extract AgentCore session ID from request headers for OTEL correlation
    session_id = request.headers.get("x-amzn-bedrock-agentcore-runtime-session-id", "")

    thread = threading.Thread(
        target=_run_task_background,
        args=(
            repo_url,
            task_description,
            issue_number,
            github_token,
            anthropic_model,
            max_turns,
            max_budget_usd,
            aws_region,
            task_id,
            session_id,
            hydrated_context,
            system_prompt_overrides,
            prompt_version,
            memory_id,
            task_type,
            branch_name,
            pr_number,
            cedar_policies,
        ),
    )
    # Track the thread for graceful shutdown BEFORE starting it so
    # _drain_threads cannot miss a very-short-lived thread.
    with _threads_lock:
        _active_threads[:] = [t for t in _active_threads if t.is_alive()]
        _active_threads.append(thread)
    thread.start()

    return InvocationResponse(
        output={
            "message": {
                "role": "assistant",
                "content": [{"text": f"Task accepted: {task_id}"}],
            },
            "result": {"status": "accepted", "task_id": task_id},
            "timestamp": datetime.now(UTC).isoformat(),
        }
    )
