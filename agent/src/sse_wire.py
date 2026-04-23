# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""AG-UI wire-format translator for Phase 1b SSE streaming.

Pure function translator: takes semantic event dicts emitted by
:class:`sse_adapter._SSEAdapter` (which mirror the ``_ProgressWriter`` event
vocabulary — ``agent_turn``, ``agent_tool_call``, ``agent_tool_result``,
``agent_milestone``, ``agent_cost_update``, ``agent_error``) and produces a
list of AG-UI-compliant event dicts ready to be JSON-serialised into SSE
``data:`` frames.

AG-UI conventions (see design doc §9.12, Appendix C):
* ``type`` is SCREAMING_SNAKE_CASE (``TEXT_MESSAGE_START``, ``TOOL_CALL_END``).
* Payload field names are camelCase (``messageId``, ``toolCallId``,
  ``toolCallName``, ``parentMessageId``).
* Every emitted event carries a ``timestamp`` in milliseconds since epoch.
* Message / tool-call identifiers are ULIDs (time-sortable) generated here.
* AG-UI has no native ``thinking`` or ``cost_update`` event → we emit
  ``CUSTOM`` events with a stable ``name`` so downstream consumers can opt in.

This module has no I/O and no async — it is trivially unit-testable and
importable by both the server handler and the test suite.
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field

# Crockford's Base32 alphabet for ULID encoding (mirrors progress_writer.py).
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _now_ms() -> int:
    """Milliseconds since UNIX epoch — AG-UI canonical timestamp unit."""
    return int(time.time() * 1000)


def _ulid() -> str:
    """Generate a ULID-compatible 26-char string (10 time + 16 random)."""
    timestamp_ms = _now_ms()
    t_chars = []
    t = timestamp_ms
    for _ in range(10):
        t_chars.append(_CROCKFORD[t & 0x1F])
        t >>= 5
    t_part = "".join(reversed(t_chars))

    r = random.getrandbits(80)
    r_chars = []
    for _ in range(16):
        r_chars.append(_CROCKFORD[r & 0x1F])
        r >>= 5
    r_part = "".join(reversed(r_chars))
    return t_part + r_part


@dataclass
class _TranslationState:
    """Per-stream state shared across translate() calls.

    The translator is stateless per-event but stateful per-stream — we need
    to remember the last assistant message id (so tool calls can reference
    it as ``parentMessageId``) and the mapping from ``(turn, tool_name)`` to
    ``toolCallId`` so that ``agent_tool_result`` events can attach to the
    same id emitted by the preceding ``agent_tool_call``.
    """

    last_message_id: str | None = None
    # Tool call correlation. Keyed by (turn, tool_name) — the runner emits
    # tool_call then tool_result in the same turn for the same tool_name.
    # We use a per-key FIFO list because a single turn may call the same
    # tool multiple times (e.g. Bash x3), and results come back in order.
    tool_calls_pending: dict[tuple[int, str], list[str]] = field(default_factory=dict)
    # Remember at least one terminal-error marker so the handler can decide
    # between RUN_FINISHED vs RUN_ERROR.
    saw_error: bool = False


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def make_run_started(run_id: str, thread_id: str = "") -> dict:
    """Synthesise a RUN_STARTED AG-UI event (emitted by handler, not adapter)."""
    return {
        "type": "RUN_STARTED",
        "timestamp": _now_ms(),
        "threadId": thread_id or run_id,
        "runId": run_id,
    }


def make_run_finished(run_id: str, thread_id: str = "") -> dict:
    """Synthesise a RUN_FINISHED AG-UI event."""
    return {
        "type": "RUN_FINISHED",
        "timestamp": _now_ms(),
        "threadId": thread_id or run_id,
        "runId": run_id,
    }


def make_run_error(run_id: str, code: str, message: str, thread_id: str = "") -> dict:
    """Synthesise a RUN_ERROR AG-UI event."""
    return {
        "type": "RUN_ERROR",
        "timestamp": _now_ms(),
        "threadId": thread_id or run_id,
        "runId": run_id,
        "code": code,
        "message": message,
    }


def translate(semantic_event: dict, *, state: _TranslationState) -> list[dict]:
    """Translate a semantic event dict into a list of AG-UI event dicts.

    Returns ``[]`` for unknown event types (fail-open: never raises on
    malformed input — the SSE stream's job is to stay alive).
    """
    etype = semantic_event.get("type")
    if etype == "agent_turn":
        return _translate_agent_turn(semantic_event, state)
    if etype == "agent_tool_call":
        return _translate_agent_tool_call(semantic_event, state)
    if etype == "agent_tool_result":
        return _translate_agent_tool_result(semantic_event, state)
    if etype == "agent_milestone":
        return _translate_agent_milestone(semantic_event, state)
    if etype == "agent_cost_update":
        return _translate_agent_cost_update(semantic_event, state)
    if etype == "agent_error":
        return _translate_agent_error(semantic_event, state)
    return []


# ---------------------------------------------------------------------------
# Per-event translators
# ---------------------------------------------------------------------------


def _translate_agent_turn(ev: dict, state: _TranslationState) -> list[dict]:
    """agent_turn → [CUSTOM(thinking)?, TEXT_MESSAGE_START, _CONTENT, _END].

    START and END both carry the semantic metadata (turn, model,
    tool_calls_count, thinking_preview, text_preview) so the CLI's
    ``agUiToSemantic`` can reconstruct the full ``agent_turn`` line on
    TEXT_MESSAGE_END without correlating an earlier frame.  Without these
    fields the CLI renders ``Turn #0 (, 0 tool calls)`` for every row.
    """
    out: list[dict] = []
    thinking = ev.get("thinking") or ""
    text = ev.get("text") or ""
    turn = int(ev.get("turn", 0) or 0)
    model = ev.get("model") or ""
    tool_calls_count = int(ev.get("tool_calls_count", 0) or 0)

    if thinking:
        out.append(
            {
                "type": "CUSTOM",
                "timestamp": _now_ms(),
                "name": "agent_thinking",
                "value": {"turn": turn, "thinking": thinking},
            }
        )

    message_id = _ulid()
    state.last_message_id = message_id
    out.append(
        {
            "type": "TEXT_MESSAGE_START",
            "timestamp": _now_ms(),
            "messageId": message_id,
            "role": "assistant",
            "turn": turn,
            "model": model,
            "tool_calls_count": tool_calls_count,
            "thinking_preview": thinking,
            "text_preview": text,
        }
    )
    out.append(
        {
            "type": "TEXT_MESSAGE_CONTENT",
            "timestamp": _now_ms(),
            "messageId": message_id,
            "delta": text,
        }
    )
    out.append(
        {
            "type": "TEXT_MESSAGE_END",
            "timestamp": _now_ms(),
            "messageId": message_id,
            "turn": turn,
            "model": model,
            "tool_calls_count": tool_calls_count,
            "thinking_preview": thinking,
            "text_preview": text,
        }
    )
    return out


def _translate_agent_tool_call(ev: dict, state: _TranslationState) -> list[dict]:
    """agent_tool_call → [TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END]."""
    tool_name = ev.get("tool_name") or "unknown"
    tool_input = ev.get("tool_input") or ""
    turn = int(ev.get("turn", 0) or 0)

    tool_call_id = _ulid()
    # Track for correlation with the ToolResultBlock that follows in a
    # later UserMessage. Bucket by (turn, tool_name) FIFO — the runner
    # emits results in call order.
    key = (turn, tool_name)
    state.tool_calls_pending.setdefault(key, []).append(tool_call_id)

    start: dict = {
        "type": "TOOL_CALL_START",
        "timestamp": _now_ms(),
        "toolCallId": tool_call_id,
        "toolCallName": tool_name,
    }
    if state.last_message_id:
        start["parentMessageId"] = state.last_message_id

    args = {
        "type": "TOOL_CALL_ARGS",
        "timestamp": _now_ms(),
        "toolCallId": tool_call_id,
        "delta": tool_input,
    }
    end = {
        "type": "TOOL_CALL_END",
        "timestamp": _now_ms(),
        "toolCallId": tool_call_id,
    }
    return [start, args, end]


def _translate_agent_tool_result(ev: dict, state: _TranslationState) -> list[dict]:
    """agent_tool_result → [TOOL_CALL_RESULT]."""
    tool_name = ev.get("tool_name") or ""
    is_error = bool(ev.get("is_error", False))
    content = ev.get("content") or ""
    turn = int(ev.get("turn", 0) or 0)

    # Correlate with the pending tool call id if we have one; otherwise
    # synthesise a fresh id so the event is still well-formed (the
    # consumer loses the pairing but nothing crashes).
    key = (turn, tool_name)
    pending = state.tool_calls_pending.get(key)
    if pending:
        tool_call_id = pending.pop(0)
        if not pending:
            state.tool_calls_pending.pop(key, None)
    else:
        tool_call_id = _ulid()

    result: dict = {
        "type": "TOOL_CALL_RESULT",
        "timestamp": _now_ms(),
        "toolCallId": tool_call_id,
        "role": "tool",
        "content": content,
    }
    if is_error:
        result["error"] = True
    return [result]


def _translate_agent_milestone(ev: dict, _state: _TranslationState) -> list[dict]:
    """agent_milestone → [STEP_STARTED, STEP_FINISHED] paired point-in-time."""
    milestone = ev.get("milestone") or "milestone"
    details = ev.get("details") or ""
    started = {
        "type": "STEP_STARTED",
        "timestamp": _now_ms(),
        "stepName": milestone,
    }
    finished: dict = {
        "type": "STEP_FINISHED",
        "timestamp": _now_ms(),
        "stepName": milestone,
    }
    if details:
        finished["details"] = details
    return [started, finished]


def _translate_agent_cost_update(ev: dict, _state: _TranslationState) -> list[dict]:
    """agent_cost_update → [CUSTOM(agent_cost_update)] — no native AG-UI event."""
    return [
        {
            "type": "CUSTOM",
            "timestamp": _now_ms(),
            "name": "agent_cost_update",
            "value": {
                "cost_usd": ev.get("cost_usd"),
                "input_tokens": int(ev.get("input_tokens", 0) or 0),
                "output_tokens": int(ev.get("output_tokens", 0) or 0),
                "turn": int(ev.get("turn", 0) or 0),
            },
        }
    ]


def _translate_agent_error(ev: dict, state: _TranslationState) -> list[dict]:
    """agent_error → [CUSTOM(agent_error)] + mark state.saw_error terminal.

    Phase 1b decision: every ``agent_error`` from the pipeline indicates a
    failed task (the runner only emits these in an exception handler). We
    still emit as CUSTOM here; the handler consults ``state.saw_error`` to
    decide RUN_FINISHED vs RUN_ERROR at close time.
    """
    state.saw_error = True
    return [
        {
            "type": "CUSTOM",
            "timestamp": _now_ms(),
            "name": "agent_error",
            "value": {
                "error_type": ev.get("error_type") or "UnknownError",
                "message": ev.get("message") or "",
            },
        }
    ]
