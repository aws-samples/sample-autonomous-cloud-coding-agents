# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Write structured progress events to DynamoDB TaskEventsTable.

Follows the same patterns as ``_TrajectoryWriter`` in ``entrypoint.py``:
  - Lazy boto3 client initialization
  - Best-effort, fail-open (never crash the agent)
  - Circuit breaker: disable after 3 consecutive DDB write failures
  - Reads ``TASK_EVENTS_TABLE_NAME`` from environment (already set on AgentCore Runtime)

Each event is a DDB item with:
  - ``task_id`` (PK)
  - ``event_id`` (SK, ULID-compatible — time-sortable unique ID)
  - ``event_type``
  - ``metadata`` (Map)
  - ``timestamp`` (ISO 8601)
  - ``ttl`` (90-day, matching task retention)
"""

from __future__ import annotations

import json
import os
import random
import time
from datetime import UTC, datetime
from decimal import Decimal

# Preview field cap defaults (design §10.1):
#   - 200 chars for normal tasks — small DDB rows, cheap watch-stream bytes.
#   - 4096 chars (4 KB) for ``--trace`` opt-in tasks — full enough to
#     capture the critical lines of a tool invocation / model response
#     without blowing through DDB's per-item byte budget.
_PREVIEW_MAX_LEN = 200
_PREVIEW_MAX_LEN_TRACE = 4096

# 90 days in seconds — matches task retention TTL
_TTL_SECONDS = 90 * 24 * 60 * 60

# Crockford's Base32 alphabet for ULID encoding
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _generate_ulid() -> str:
    """Generate a ULID-compatible string using only the standard library.

    Format: 10-char timestamp (ms since epoch) + 16-char random, both in
    Crockford's Base32.  Lexicographically sortable by time.
    """
    timestamp_ms = int(time.time() * 1000)

    # Encode 48-bit timestamp into 10 Base32 chars (big-endian)
    t_chars = []
    t = timestamp_ms
    for _ in range(10):
        t_chars.append(_CROCKFORD[t & 0x1F])
        t >>= 5
    t_part = "".join(reversed(t_chars))

    # 80 bits of randomness → 16 Base32 chars
    r = random.getrandbits(80)
    r_chars = []
    for _ in range(16):
        r_chars.append(_CROCKFORD[r & 0x1F])
        r >>= 5
    r_part = "".join(reversed(r_chars))

    return t_part + r_part


def _truncate_preview(value: str | None, max_len: int = _PREVIEW_MAX_LEN) -> str:
    """Truncate a string to *max_len* chars for DDB preview fields."""
    if not value:
        return ""
    if len(value) <= max_len:
        return value
    return value[:max_len] + "..."


class _ProgressWriter:
    """Write AG-UI-style progress events to the existing DynamoDB TaskEventsTable.

    Fail-open: a DDB write failure is logged but never raises.  After
    ``_MAX_FAILURES`` consecutive failures the writer permanently disables
    itself (circuit breaker).
    """

    _MAX_FAILURES = 3

    def __init__(self, task_id: str, trace: bool = False) -> None:
        self._task_id = task_id
        self._table_name = os.environ.get("TASK_EVENTS_TABLE_NAME")
        self._table = None
        self._disabled = False
        self._failure_count = 0
        # Per-instance preview cap — design §10.1. ``trace=True`` raises
        # the cap from 200 chars to 4 KB for debug captures.
        self._preview_max_len = _PREVIEW_MAX_LEN_TRACE if trace else _PREVIEW_MAX_LEN

    def _preview(self, value: str | None) -> str:
        """Truncate *value* to the instance's preview cap."""
        return _truncate_preview(value, self._preview_max_len)

    # -- lazy init -------------------------------------------------------------

    def _ensure_table(self):
        """Lazily create the DynamoDB Table resource."""
        if self._table is not None:
            return
        if not self._table_name:
            self._disabled = True
            return

        import boto3

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        dynamodb = boto3.resource("dynamodb", region_name=region)
        self._table = dynamodb.Table(self._table_name)

    # -- core write ------------------------------------------------------------

    def _put_event(self, event_type: str, metadata: dict) -> None:
        """Write a single progress event item to DynamoDB."""
        if not self._table_name or self._disabled:
            return
        try:
            self._ensure_table()
            if self._table is None:
                self._disabled = True
                return

            now = datetime.now(UTC)
            item = {
                "task_id": self._task_id,
                "event_id": _generate_ulid(),
                "event_type": event_type,
                "metadata": json.loads(
                    json.dumps(metadata, default=str),
                    parse_float=Decimal,
                ),
                "timestamp": now.isoformat(),
                "ttl": int(now.timestamp()) + _TTL_SECONDS,
            }
            self._table.put_item(Item=item)

            # Reset failure count on success
            self._failure_count = 0

        except ImportError:
            self._disabled = True
            print("[progress] boto3 not available — skipping", flush=True)
        except Exception as e:
            self._failure_count += 1
            exc_type = type(e).__name__
            if self._failure_count >= self._MAX_FAILURES:
                self._disabled = True
                print(
                    f"[progress] DDB write failed {self._failure_count} times, "
                    f"disabling progress writer: {exc_type}: {e}",
                    flush=True,
                )
            else:
                print(
                    f"[progress] DDB write failed ({self._failure_count}/"
                    f"{self._MAX_FAILURES}): {exc_type}: {e}",
                    flush=True,
                )

    # -- public event methods --------------------------------------------------

    def write_agent_turn(
        self,
        turn: int,
        model: str,
        thinking: str,
        text: str,
        tool_calls_count: int,
    ) -> None:
        """Emit an ``agent_turn`` event after each AssistantMessage."""
        self._put_event(
            "agent_turn",
            {
                "turn": turn,
                "model": model,
                "thinking_preview": self._preview(thinking),
                "text_preview": self._preview(text),
                "tool_calls_count": tool_calls_count,
            },
        )

    def write_agent_tool_call(
        self,
        tool_name: str,
        tool_input: str,
        turn: int,
    ) -> None:
        """Emit an ``agent_tool_call`` event after each ToolUseBlock."""
        self._put_event(
            "agent_tool_call",
            {
                "tool_name": tool_name,
                "tool_input_preview": self._preview(tool_input),
                "turn": turn,
            },
        )

    def write_agent_tool_result(
        self,
        tool_name: str,
        is_error: bool,
        content: str,
        turn: int,
    ) -> None:
        """Emit an ``agent_tool_result`` event after each ToolResultBlock."""
        self._put_event(
            "agent_tool_result",
            {
                "tool_name": tool_name,
                "is_error": is_error,
                "content_preview": self._preview(content),
                "turn": turn,
            },
        )

    def write_agent_milestone(self, milestone: str, details: str = "") -> None:
        """Emit an ``agent_milestone`` event at key points."""
        self._put_event(
            "agent_milestone",
            {
                "milestone": milestone,
                "details": self._preview(details),
            },
        )

    def write_agent_cost_update(
        self,
        cost_usd: float | None,
        input_tokens: int,
        output_tokens: int,
        turn: int,
    ) -> None:
        """Emit an ``agent_cost_update`` event after each ResultMessage."""
        self._put_event(
            "agent_cost_update",
            {
                "cost_usd": cost_usd,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "turn": turn,
            },
        )

    def write_agent_error(self, error_type: str, message: str) -> None:
        """Emit an ``agent_error`` event on errors during execution."""
        self._put_event(
            "agent_error",
            {
                "error_type": error_type,
                "message_preview": self._preview(message),
            },
        )
