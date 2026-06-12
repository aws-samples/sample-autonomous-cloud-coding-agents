"""Outbound AWS SDK User-Agent solution tracking (#319).

Every AWS API call made by the agent carries two ABCA solution-tracking
segments in the ``User-Agent`` header:

    app/uksb-wt64nei4u6/{STACKNAME}            (only when ABCA_STACK_NAME set)
    md/uksb-wt64nei4u6#agent[#{TRACE}]

Both are emitted via botocore's *verbatim* ``user_agent_extra`` path — NOT
the sanitizing ``user_agent_appid`` config field, whose allowed charset
excludes ``/`` and would mangle the ``uksb-wt64nei4u6/`` separator into
``-``. Because the raw path applies no sanitization, this module sanitizes
``{STACKNAME}`` and ``{TRACE}`` itself (non-UA-token chars → ``-``).

The static part is baked once at client/session construction. The optional
``#{TRACE}`` suffix (the current task id) is appended **per request** by a
``before-send`` event handler that mutates only the outgoing header — never
the client config — so the singleton session in :mod:`aws_session` keeps its
connection pool across trace changes (see issue #319 "Connection sharing").

Trace state is plain lock-guarded module state rather than a ``ContextVar``:
the task runs on a thread spawned by ``server.py``, where per-thread
``ContextVar`` propagation is exactly the trap documented at
``server.py`` (workload-token plumbing). One agent process works one task.

The TypeScript counterparts are ``cdk/src/handlers/shared/ua.ts`` and
``cli/src/ua.ts`` — the solution id, wire format, and sanitization rules
must stay identical across all three.
"""

from __future__ import annotations

import os
import string
import threading
from typing import Any

# AWS solution-tracking id for ABCA. Also appears (deploy-time counterpart,
# #292) in the CloudFormation stack description in ``cdk/src/main.ts`` and in
# the TS mirrors of this module. Per-surface literal by design — see PR #338.
SOLUTION_ID = "uksb-wt64nei4u6"

# Stable per-component label: this surface IS the Python agent runtime.
COMPONENT = "agent"

# Deployed CloudFormation stack name, threaded in by CDK (AgentCore runtime
# env / ECS container env). Absent in local dev — the app/ segment is then
# omitted entirely.
STACK_NAME_ENV = "ABCA_STACK_NAME"

# The documented app-id budget is 50 chars on the value;
# len("uksb-wt64nei4u6/") == 16, leaving 34 for the stack name.
_STACK_NAME_MAX = 34

# RFC 7230 token charset (the UA product-token alphabet). '/' and '#' are
# deliberately NOT here — they are the structural separators of the scheme.
_ALLOWED = frozenset(string.ascii_letters + string.digits + "!$%&'*+-.^_`|~")

_trace_lock = threading.Lock()
_trace: str | None = None


def sanitize_ua_value(raw: str) -> str:
    """Replace every non-UA-token char (incl. non-ASCII) with ``-``."""
    return "".join(c if c in _ALLOWED else "-" for c in raw)


def static_user_agent_extra() -> str:
    """The static UA suffix baked at client/session construction.

    ``app/{SOLUTION_ID}/{stack}`` (stack sanitized FIRST, then clipped to 34
    so a replaced multi-byte char can't be re-split) followed by
    ``md/{SOLUTION_ID}#{COMPONENT}``. Without a stack name only the ``md/``
    segment is emitted — never a placeholder.
    """
    segments = []
    stack_name = os.environ.get(STACK_NAME_ENV, "").strip()
    if stack_name:
        clipped = sanitize_ua_value(stack_name)[:_STACK_NAME_MAX]
        segments.append(f"app/{SOLUTION_ID}/{clipped}")
    segments.append(f"md/{SOLUTION_ID}#{COMPONENT}")
    return " ".join(segments)


def set_trace(handle: str | None) -> None:
    """Set (or clear, with ``None``/empty) the ambient trace handle.

    Called once per task with the task id (``aws_session.configure_session``).
    The handle is stored raw and sanitized on read.
    """
    global _trace
    with _trace_lock:
        _trace = handle or None


def get_trace() -> str | None:
    """Current trace handle, sanitized to UA-token-safe ASCII, or ``None``."""
    with _trace_lock:
        raw = _trace
    return sanitize_ua_value(raw) if raw else None


def register_trace_appender(events: Any) -> None:
    """Append ``#{TRACE}`` to the outgoing User-Agent on every request.

    ``events`` is a botocore event emitter — either ``client.meta.events``
    (single client) or a botocore session's emitter (propagates to every
    client *and resource* derived from it). Registered on ``before-send`` so
    it runs after botocore renders the header (``user_agent_extra`` is the
    final component, so the suffix lands exactly on our ``md/`` segment) and
    mutates only the header — the connection pool is untouched.
    """

    def _append_trace(request: Any, **_kwargs: Any) -> None:
        trace = get_trace()
        if not trace:
            return
        current = request.headers.get("User-Agent")
        if current is None:
            return
        # Headers may surface as bytes depending on the transport path.
        if isinstance(current, bytes):
            current = current.decode("ascii", errors="replace")
        request.headers["User-Agent"] = f"{current}#{trace}"

    events.register("before-send.*", _append_trace, unique_id="abca-ua-trace")


def client_config() -> Any:
    """``botocore.config.Config`` carrying the static UA suffix.

    For direct ``boto3.client(...)`` call sites that don't go through a
    shared session (see ``aws_session.platform_client``).
    """
    from botocore.config import Config

    return Config(user_agent_extra=static_user_agent_extra())
