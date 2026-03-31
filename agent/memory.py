"""Memory write functions for AgentCore Memory.

Best-effort (fail-open): all write operations are wrapped in try/except
so a Memory API outage never blocks the agent pipeline. Infrastructure
errors (network, auth, throttling) are caught and logged at WARN level;
programming errors (TypeError, ValueError, AttributeError) are logged at
ERROR level to surface bugs quickly.
"""

import os
import re
import time

_client = None

# Validates "owner/repo" format — must match the TypeScript-side isValidRepo pattern.
_REPO_PATTERN = re.compile(r"^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$")

# Current event schema version — used to distinguish records written under
# different namespace schemes (v1 = repos/ prefix, v2 = namespace templates).
_SCHEMA_VERSION = "2"


def _get_client():
    """Lazy-init and cache the AgentCore client for memory operations."""
    global _client
    if _client is not None:
        return _client
    import boto3

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if not region:
        raise ValueError("AWS_REGION or AWS_DEFAULT_REGION must be set for memory operations")
    _client = boto3.client("bedrock-agentcore", region_name=region)
    return _client


def _validate_repo(repo: str) -> None:
    """Raise ValueError if repo does not match expected owner/repo format."""
    if not _REPO_PATTERN.match(repo):
        raise ValueError(
            f"repo '{repo}' does not match expected owner/repo format "
            f"(pattern: {_REPO_PATTERN.pattern})"
        )


def _log_error(func_name: str, err: Exception, memory_id: str, task_id: str) -> None:
    """Log memory write failure with severity based on exception type."""
    is_programming_error = isinstance(err, (TypeError, ValueError, AttributeError, KeyError))
    level = "ERROR" if is_programming_error else "WARN"
    label = "unexpected error" if is_programming_error else "infra failure"
    print(
        f"[memory] [{level}] {func_name} {label}: "
        f"{type(err).__name__}: {err} "
        f"[memory_id={memory_id}, task_id={task_id}]",
        flush=True,
    )


def write_task_episode(
    memory_id: str,
    repo: str,
    task_id: str,
    status: str,
    pr_url: str | None = None,
    cost_usd: float | None = None,
    duration_s: float | None = None,
    self_feedback: str | None = None,
) -> bool:
    """Write a task episode to AgentCore Memory as a short-term event.

    The event captures the outcome of one task execution, including
    status, PR URL, cost, duration, and any self-feedback from the
    agent's "## Agent notes" section in the PR body.

    Uses actorId=repo and sessionId=task_id so the extraction strategy
    namespace templates (/{actorId}/episodes/{sessionId}/) place records
    into the correct per-repo, per-task namespace.

    Returns True on success, False on failure (fail-open).
    """
    try:
        _validate_repo(repo)
        client = _get_client()

        parts = [
            f"Task {task_id} completed with status: {status}.",
        ]
        if pr_url:
            parts.append(f"PR: {pr_url}.")
        if duration_s is not None:
            parts.append(f"Duration: {duration_s}s.")
        if cost_usd is not None:
            parts.append(f"Cost: ${cost_usd:.4f}.")
        if self_feedback:
            parts.append(f"Agent notes: {self_feedback}")

        episode_text = " ".join(parts)

        metadata = {
            "task_id": {"stringValue": task_id},
            "type": {"stringValue": "task_episode"},
            "schema_version": {"stringValue": _SCHEMA_VERSION},
        }
        if pr_url:
            metadata["pr_url"] = {"stringValue": pr_url}

        client.create_event(
            memoryId=memory_id,
            actorId=repo,
            sessionId=task_id,
            eventTimestamp=_iso_now(),
            payload=[
                {
                    "conversational": {
                        "content": {"text": episode_text},
                        "role": "OTHER",
                    }
                }
            ],
            metadata=metadata,
        )

        print(f"[memory] Task episode written for {task_id} [memory_id={memory_id}]", flush=True)
        return True
    except Exception as e:
        _log_error("write_task_episode", e, memory_id, task_id)
        return False


def write_repo_learnings(
    memory_id: str,
    repo: str,
    task_id: str,
    learnings: str,
) -> bool:
    """Write repository learnings to AgentCore Memory.

    Captures patterns, conventions, and insights discovered about the
    repository during task execution. Stored as a separate event so
    the semantic extraction strategy can surface them in future tasks.

    Uses actorId=repo and sessionId=task_id so the extraction strategy
    namespace templates (/{actorId}/knowledge/) place records into
    the correct per-repo namespace.

    Returns True on success, False on failure (fail-open).
    """
    try:
        _validate_repo(repo)
        client = _get_client()

        client.create_event(
            memoryId=memory_id,
            actorId=repo,
            sessionId=task_id,
            eventTimestamp=_iso_now(),
            payload=[
                {
                    "conversational": {
                        "content": {"text": f"Repository learnings: {learnings}"},
                        "role": "OTHER",
                    }
                }
            ],
            metadata={
                "task_id": {"stringValue": task_id},
                "type": {"stringValue": "repo_learnings"},
                "schema_version": {"stringValue": _SCHEMA_VERSION},
            },
        )

        print(f"[memory] Repo learnings written for {task_id} [memory_id={memory_id}]", flush=True)
        return True
    except Exception as e:
        _log_error("write_repo_learnings", e, memory_id, task_id)
        return False


def _iso_now() -> str:
    """Return current time as ISO 8601 string."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
