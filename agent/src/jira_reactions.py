"""Jira issue-comment helper for Jira-origin tasks.

Posts a "starting" comment on the originating Jira issue at task start — the
Jira analogue of ``linear_reactions`` (Linear uses emoji reactions; Jira's
REST API has no lightweight reaction primitive, so comments are the right
tool).

The *terminal* status comment is NOT posted from here: since issue #573 the
deterministic fan-out plane (``cdk/src/handlers/fanout-task-events.ts``
``dispatchToJira``) owns it, so it carries cost/turns/duration and fires even
when this agent crashes before completing. This module only owns the start
comment.

Why a direct REST call instead of MCP: Atlassian's Remote MCP
(``mcp.atlassian.com``) requires an interactive, browser-based OAuth 2.1
authorization flow with dynamic client registration — it does NOT accept the
stored Jira REST OAuth token as a ``Bearer`` header, and a headless background
agent cannot complete the interactive handshake. The MCP path therefore fails
to connect in the runtime (``claude mcp list`` → "Failed to connect"). The
Jira *REST* API, by contrast, accepts the same stored OAuth access token (it
carries ``write:jira-work``), so we post comments via
``POST /rest/api/3/issue/{key}/comment`` on the cross-region
``api.atlassian.com/ex/jira/{cloudId}`` base. This is the "Plan B REST shim"
the ``channel_mcp`` module's comments anticipated.

Gating: every function is a no-op unless ``channel_source == 'jira'`` and the
issue key + cloud id are present in ``channel_metadata``. All network / auth
errors are logged and swallowed — a transient Jira API failure must never fail
the task itself (comments are advisory UX, not load-bearing).

See: ``agent/src/channel_mcp.py`` for the (non-functional) MCP gate, and
``agent/src/linear_reactions.py`` for the parallel Linear shim.
"""

from __future__ import annotations

import os
import threading
from typing import Any
from urllib.parse import quote

import requests

from shell import log

#: Atlassian cross-region REST base. The ``{cloudId}`` segment scopes the
#: call to the tenant; ``JIRA_API_TOKEN`` (populated by
#: ``config.resolve_jira_oauth_token``) authorizes it.
JIRA_API_BASE = "https://api.atlassian.com/ex/jira"

#: Request timeout — comments are fire-and-forget status UX; never block the
#: task pipeline for more than a couple of seconds.
REQUEST_TIMEOUT_SECONDS = 5.0

#: Auth-failure circuit breaker. Mirrors ``linear_reactions``: after this many
#: consecutive 401/403s the breaker opens and later calls short-circuit
#: without hitting the network (avoids flooding CloudWatch when a token is
#: revoked). A successful 2xx resets the counter.
_AUTH_FAILURE_THRESHOLD = 3
_consecutive_auth_failures: int = 0
_auth_circuit_open: bool = False
_auth_state_lock = threading.Lock()


def _enabled(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
) -> tuple[str, str] | None:
    """Return ``(cloud_id, issue_key)`` if comments should fire, else None.

    Gating mirrors ``channel_mcp.configure_channel_mcp`` — the same
    ``channel_source == 'jira'`` check, plus a metadata presence check so we
    don't fire REST calls we can't address.
    """
    if channel_source != "jira":
        return None
    if not channel_metadata:
        return None
    cloud_id = channel_metadata.get("jira_cloud_id")
    issue_key = channel_metadata.get("jira_issue_key")
    if not cloud_id or not issue_key:
        return None
    return cloud_id, issue_key


def _adf(text: str) -> dict[str, Any]:
    """Wrap plain text in a minimal Atlassian Document Format comment body."""
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]},
        ],
    }


def _post_comment(cloud_id: str, issue_key: str, text: str) -> bool:
    """POST a comment to the issue. Return True on success, False on any failure.

    Swallows network / auth / schema errors with a WARN log — comments are
    advisory and never gate the pipeline. After ``_AUTH_FAILURE_THRESHOLD``
    consecutive auth failures the module-level circuit breaker opens and later
    calls short-circuit without hitting the network.
    """
    global _consecutive_auth_failures, _auth_circuit_open

    with _auth_state_lock:
        circuit_open = _auth_circuit_open
    if circuit_open:
        log("DEBUG", "jira_reactions: auth circuit still open; short-circuiting call")
        return False

    token = os.environ.get("JIRA_API_TOKEN", "")
    if not token:
        log("WARN", "jira_reactions: JIRA_API_TOKEN not set; skipping comment")
        return False

    # URL-encode both path segments. cloud_id and issue_key originate from the
    # verified webhook payload (stamped into channel_metadata by the
    # processor), but encoding them keeps an unexpected value from injecting
    # extra path segments into the gateway URL. `safe=""` so even "/" encodes.
    url = (
        f"{JIRA_API_BASE}/{quote(cloud_id, safe='')}"
        f"/rest/api/3/issue/{quote(issue_key, safe='')}/comment"
    )
    try:
        resp = requests.post(
            url,
            json={"body": _adf(text)},
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as e:
        log("WARN", f"jira_reactions: request failed ({type(e).__name__}): {e}")
        # nosemgrep: py-silent-success-masking -- Jira comments are best-effort on network blips
        return False

    if resp.status_code in (401, 403):
        with _auth_state_lock:
            _consecutive_auth_failures += 1
            opened = (
                _consecutive_auth_failures >= _AUTH_FAILURE_THRESHOLD and not _auth_circuit_open
            )
            if opened:
                _auth_circuit_open = True
                failures = _consecutive_auth_failures
        if opened:
            log(
                "ERROR",
                "jira_reactions: auth circuit OPEN after "
                f"{failures} consecutive {resp.status_code}s — Jira token likely "
                "revoked/expired without a working refresh. Suppressing further "
                "Jira calls for this container.",
            )
        else:
            log("WARN", f"jira_reactions: HTTP {resp.status_code} from Jira (auth)")
        return False

    # Jira returns 201 Created on a successful comment.
    if resp.status_code not in (200, 201):
        log("WARN", f"jira_reactions: HTTP {resp.status_code} from Jira: {resp.text[:200]}")
        return False

    with _auth_state_lock:
        _consecutive_auth_failures = 0
    return True


def comment_task_started(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
) -> None:
    """Post a "starting" comment on the Jira issue. No-op for non-Jira tasks."""
    target = _enabled(channel_source, channel_metadata)
    if not target:
        return
    cloud_id, issue_key = target
    ok = _post_comment(
        cloud_id,
        issue_key,
        "🤖 ABCA picked up this issue and started working on it. "
        "I'll comment again when the pull request is ready.",
    )
    log("TASK", f"jira_reactions: comment_task_started issue={issue_key} ok={ok}")


# NOTE: there is deliberately no ``comment_task_finished`` here. Since issue
# #573 the deterministic fan-out plane
# (``cdk/src/handlers/fanout-task-events.ts`` ``dispatchToJira``) owns the Jira
# terminal comment — it carries cost/turns/duration and, crucially, fires even
# when the agent crashes before completing (max-turns, OOM). The agent only
# posts the *start* comment (``comment_task_started`` above); posting a terminal
# comment here too would double-comment on the issue.


def _reset_state_for_testing() -> None:
    """Test-only: reset the auth circuit-breaker module state."""
    global _consecutive_auth_failures, _auth_circuit_open
    with _auth_state_lock:
        _consecutive_auth_failures = 0
        _auth_circuit_open = False
