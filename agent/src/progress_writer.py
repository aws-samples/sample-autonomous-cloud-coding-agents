# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Write structured progress events to DynamoDB TaskEventsTable.

Follows the same patterns as ``_TrajectoryWriter`` in ``entrypoint.py``:
  - Lazy boto3 client initialization
  - Best-effort, fail-open (never crash the agent)
  - Circuit breaker: disable after 3 consecutive *transient* DDB write
    failures (krokoko PR #52 review finding #6 — permanent errors like
    ``ValidationException`` no longer trip the breaker).
  - Reads ``TASK_EVENTS_TABLE_NAME`` from environment (already set on AgentCore Runtime)

Each event is a DDB item with:
  - ``task_id`` (PK)
  - ``event_id`` (SK, ULID-compatible — time-sortable unique ID)
  - ``event_type``
  - ``metadata`` (Map)
  - ``timestamp`` (ISO 8601)
  - ``ttl`` (90-day, matching task retention)

Circuit-breaker state is **shared across all writer instances for the same
task** (krokoko PR #52 review finding #8).  Runner-level (turn/tool events)
and pipeline-level (milestones) writers are two ``_ProgressWriter``
instances with the same ``task_id``; without shared state a throttling burst
on one would let the other keep writing, producing visible gaps in the
event stream.  See :class:`_SharedCircuitBreaker` for the mechanism.
"""

from __future__ import annotations

import json
import os
import random
import threading
import time
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

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


# ---------------------------------------------------------------------------
# Error classification (krokoko PR #52 review finding #6)
# ---------------------------------------------------------------------------

# DDB error codes that are NOT recoverable by retry — retrying will keep
# failing the same way forever, so letting them increment ``_failure_count``
# would eventually trip the breaker and silence the entire progress stream
# for this task.  Examples seen in practice:
#   - ``ValidationException`` — e.g. a trace-heavy event pushes the item
#     past the 400 KB DDB limit.  Subsequent lighter events would succeed,
#     but today's bare ``except Exception`` counter already tripped.
#   - ``ItemCollectionSizeLimitExceededException`` — local-index partition
#     collection exceeded 10 GB; same story.
#   - ``AccessDeniedException`` / ``UnauthorizedOperation`` — IAM misconfig
#     at deploy time; retry is futile and the breaker should flip
#     *immediately* so we don't waste three events worth of noise finding
#     this out.
#   - ``ResourceNotFoundException`` — table genuinely does not exist in
#     this deploy.  Log loudly and disable.
_PERMANENT_DDB_ERROR_CODES: frozenset[str] = frozenset(
    {
        "ValidationException",
        "ItemCollectionSizeLimitExceededException",
        "ResourceNotFoundException",
        "AccessDeniedException",
        "UnauthorizedOperation",
    }
)

# DDB error codes that ARE expected to self-heal (throughput throttling,
# control-plane blips, network-level timeouts).  These feed the normal
# circuit-breaker counter — three in a row and we disable, matching the
# original design.
_TRANSIENT_DDB_ERROR_CODES: frozenset[str] = frozenset(
    {
        "ProvisionedThroughputExceededException",
        "RequestLimitExceeded",
        "ThrottlingException",
        "ServiceUnavailable",
        "InternalServerError",
    }
)

# Non-``ClientError`` transient types — matched on class name because
# ``botocore.exceptions`` may not be importable in every environment (the
# writer must not crash the agent if boto3 is missing, see ``ImportError``
# handling in ``_put_event``).
_TRANSIENT_NETWORK_EXC_NAMES: frozenset[str] = frozenset(
    {
        "ConnectionError",
        "EndpointConnectionError",
        "ReadTimeoutError",
        "ConnectTimeoutError",
        "ConnectionClosedError",
        # boto3's retry wrapper surface
        "ClientConnectionError",
    }
)


def _classify_ddb_error(exc: BaseException) -> Literal["permanent", "transient", "unknown"]:
    """Classify a DDB-layer exception for circuit-breaker accounting.

    Rules (krokoko PR #52 review finding #6):

    - ``ClientError`` with an AWS error code we recognise as permanent
      (schema/size/IAM/missing-table) → ``"permanent"``.  Drop the
      individual event, do NOT trip the breaker — the next event may be a
      smaller payload that succeeds just fine.
    - ``ClientError`` with a recognised transient code, OR a network-layer
      exception class we know (``EndpointConnectionError`` et al.) →
      ``"transient"``.  Feed the normal counter.
    - Anything else → ``"unknown"``.  Default to transient-style accounting
      (increment the counter) but log at a louder ERROR level so operators
      can add the new code to the permanent/transient table next release.
      This is intentionally conservative: instant-disable on unknown errors
      would over-correct from today's bare-except behaviour and risk a new
      botocore release silencing the stream on benign retryable codes.

    We identify ``ClientError`` structurally (duck-typed via
    ``exc.response["Error"]["Code"]``) rather than ``isinstance`` so the
    classifier remains importable in environments where ``botocore`` is
    missing (e.g. pure-python unit tests).
    """
    # ClientError: response is a dict with a nested Error.Code string.
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        error_block = response.get("Error") or {}
        code = error_block.get("Code") if isinstance(error_block, dict) else None
        if isinstance(code, str):
            if code in _PERMANENT_DDB_ERROR_CODES:
                return "permanent"
            if code in _TRANSIENT_DDB_ERROR_CODES:
                return "transient"
            # Unknown AWS error code — fall through to class-name match,
            # then to "unknown" default.

    # Non-ClientError: match by class name for network-layer exceptions.
    exc_name = type(exc).__name__
    if exc_name in _TRANSIENT_NETWORK_EXC_NAMES:
        return "transient"

    return "unknown"


# ---------------------------------------------------------------------------
# Shared circuit-breaker state (krokoko PR #52 review finding #8)
# ---------------------------------------------------------------------------


class _SharedCircuitBreaker:
    """Process-wide circuit-breaker state keyed by ``task_id``.

    Both the runner (turn/tool events) and pipeline (milestones) create
    their own ``_ProgressWriter`` instance.  Before this class each writer
    kept its own ``_failure_count`` / ``_disabled`` flag, so a throttling
    burst would trip one writer while the other kept firing — producing a
    visibly half-alive event stream (e.g. milestones arriving after all
    turn events went silent).

    The contract is now: **one task's stream is either healthy or
    disabled, never half-alive.**  Every writer for the same ``task_id``
    reads/writes the same counter, and the first one to hit
    ``_MAX_FAILURES`` disables the stream for the whole task.

    State resets on fresh ``task_id`` (new task, new state).  A test-only
    reset helper (:func:`_reset_circuit_breakers`) clears every entry so
    one test's tripped breaker does not leak into the next.

    The empty-string sentinel ``"unknown"`` that ``runner.py`` falls back
    to (``config.task_id or "unknown"``) is treated as a plain key here —
    writers with a real ``task_id`` never collide with it, and two
    ``"unknown"`` writers running in the same process would legitimately
    share state (they can't be distinguished anyway).
    """

    def __init__(self) -> None:
        # task_id -> (failure_count, disabled)
        self._state: dict[str, dict[str, int | bool]] = {}
        # A single lock for the whole map is plenty — write contention on
        # this path is bounded by the DDB write rate (handful per second),
        # so coarse-grained locking has no measurable cost and keeps the
        # invariants (read-modify-write of failure_count) simple.
        self._lock = threading.Lock()

    def is_disabled(self, task_id: str) -> bool:
        with self._lock:
            return bool(self._state.get(task_id, {}).get("disabled", False))

    def disable(self, task_id: str) -> None:
        """Flip the breaker open for this ``task_id`` immediately.

        Used by the permanent-error fast path (``AccessDeniedException``,
        ``ResourceNotFoundException``) where retry has zero chance of
        helping and we would rather silence the stream than spam
        CloudWatch with three copies of the same IAM error.
        """
        with self._lock:
            entry = self._state.setdefault(task_id, {"failure_count": 0, "disabled": False})
            entry["disabled"] = True

    def record_failure(self, task_id: str, max_failures: int) -> tuple[int, bool]:
        """Increment the counter; return (new_count, now_disabled)."""
        with self._lock:
            entry = self._state.setdefault(task_id, {"failure_count": 0, "disabled": False})
            entry["failure_count"] = int(entry["failure_count"]) + 1
            if entry["failure_count"] >= max_failures:
                entry["disabled"] = True
            return int(entry["failure_count"]), bool(entry["disabled"])

    def record_success(self, task_id: str) -> None:
        """Reset the failure counter on a successful write.

        Does NOT clear ``disabled`` — once the breaker is open we stay
        open for the rest of the task.  Re-enabling mid-task would let a
        single flaky minute burn through the budget repeatedly; better to
        accept a degraded stream than oscillate.
        """
        with self._lock:
            entry = self._state.get(task_id)
            if entry is not None:
                entry["failure_count"] = 0


# Module-level singleton — shared across every ``_ProgressWriter`` in the
# process.  Tests reset it via :func:`_reset_circuit_breakers`.
_CIRCUIT_BREAKERS = _SharedCircuitBreaker()


def _reset_circuit_breakers() -> None:
    """Test-only helper: clear all shared circuit-breaker state.

    Pinned here (not hidden behind ``_`` alone) so future contributors who
    add tests involving multiple writers remember to reset between tests.
    Forgetting to reset means a prior test's tripped breaker silently
    disables the writer under test — the symptom is "put_item never
    called" with no other signal.
    """
    global _CIRCUIT_BREAKERS
    _CIRCUIT_BREAKERS = _SharedCircuitBreaker()


# ---------------------------------------------------------------------------
# Progress writer
# ---------------------------------------------------------------------------


class _ProgressWriter:
    """Write AG-UI-style progress events to the existing DynamoDB TaskEventsTable.

    Fail-open: a DDB write failure is logged but never raises.  After
    ``_MAX_FAILURES`` consecutive *transient* failures the task's stream
    is permanently disabled (circuit breaker).  Permanent errors
    (``ValidationException`` et al.) drop the individual event without
    tripping the breaker — see :func:`_classify_ddb_error`.

    Circuit-breaker state lives in :data:`_CIRCUIT_BREAKERS` and is
    shared across every writer instance for the same ``task_id``.  Two
    writers (runner + pipeline) observing the same task therefore agree
    on whether the stream is healthy; there is no "half-alive" state
    where one writer is still emitting and the other is silent.
    """

    _MAX_FAILURES = 3

    def __init__(self, task_id: str, trace: bool = False) -> None:
        self._task_id = task_id
        self._table_name = os.environ.get("TASK_EVENTS_TABLE_NAME")
        self._table = None
        # Per-instance preview cap — design §10.1. ``trace=True`` raises
        # the cap from 200 chars to 4 KB for debug captures.
        self._preview_max_len = _PREVIEW_MAX_LEN_TRACE if trace else _PREVIEW_MAX_LEN

    # ------------------------------------------------------------------
    # Circuit-breaker proxies (finding #8): keep the historical
    # ``writer._disabled`` / ``writer._failure_count`` surface working as
    # read-only attributes.  Callers in ``hooks.py`` and tests inspect
    # these directly — see ``_emit_nudge_milestone`` which reads
    # ``getattr(progress, "_disabled", False)``.  We back them with the
    # shared state so external readers see the consolidated view.
    # ------------------------------------------------------------------

    @property
    def _disabled(self) -> bool:
        return _CIRCUIT_BREAKERS.is_disabled(self._task_id)

    @_disabled.setter
    def _disabled(self, value: bool) -> None:
        # The only legitimate transition is False -> True (flip the
        # breaker open).  We honour that for back-compat with existing
        # callers, and ignore attempts to re-enable mid-task to match
        # ``record_success`` semantics.
        if value:
            _CIRCUIT_BREAKERS.disable(self._task_id)

    @property
    def _failure_count(self) -> int:
        with _CIRCUIT_BREAKERS._lock:
            return int(_CIRCUIT_BREAKERS._state.get(self._task_id, {}).get("failure_count", 0))

    @_failure_count.setter
    def _failure_count(self, value: int) -> None:
        # Test seam: allow direct writes so legacy tests that assign
        # ``writer._failure_count = 0`` keep working.  Production code
        # should use ``record_success`` / ``record_failure`` instead.
        with _CIRCUIT_BREAKERS._lock:
            entry = _CIRCUIT_BREAKERS._state.setdefault(
                self._task_id, {"failure_count": 0, "disabled": False}
            )
            entry["failure_count"] = int(value)

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
        """Write a single progress event item to DynamoDB.

        Error handling splits three ways (krokoko PR #52 review finding
        #6):

        - **ImportError** (no boto3 on the path) — disable the writer
          immediately, this is unrecoverable.
        - **Permanent DDB errors** (``ValidationException``, missing
          table, IAM denial) — drop this event, do NOT increment the
          shared failure counter.  ``AccessDeniedException`` /
          ``ResourceNotFoundException`` additionally flip the breaker
          open immediately because retrying is pointless.
        - **Transient DDB errors** (throttling, network blips) — feed the
          shared circuit-breaker counter; trip at ``_MAX_FAILURES``.
        - **Unknown exceptions** — increment like transient but log at a
          louder ERROR level so unexpected codes surface in reviews.
        """
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

            # Success: reset the shared failure counter.  We do NOT flip
            # ``disabled`` back to False — a tripped breaker stays open
            # for the rest of the task (see ``_SharedCircuitBreaker``
            # docstring).
            _CIRCUIT_BREAKERS.record_success(self._task_id)

        except ImportError:
            self._disabled = True
            print("[progress] boto3 not available — skipping", flush=True)
        except Exception as e:
            classification = _classify_ddb_error(e)
            exc_type = type(e).__name__

            if classification == "permanent":
                # Permanent errors: drop the event, do NOT increment the
                # shared counter.  The next (possibly smaller / different)
                # event may well succeed.  However a handful of permanent
                # codes (IAM denial, missing table) genuinely mean the
                # whole stream is dead — flip the breaker for those so we
                # don't spam CloudWatch with repeats.
                response = getattr(e, "response", None)
                code: str | None = None
                if isinstance(response, dict):
                    error_block = response.get("Error") or {}
                    if isinstance(error_block, dict):
                        raw_code = error_block.get("Code")
                        if isinstance(raw_code, str):
                            code = raw_code
                permanent_codes = {
                    "AccessDeniedException",
                    "UnauthorizedOperation",
                    "ResourceNotFoundException",
                }
                if code in permanent_codes:
                    # Immediate disable: retrying an IAM / missing-table
                    # error will only produce more copies of the same
                    # error.  Loud log so operators notice.
                    self._disabled = True
                    print(
                        f"[progress] DDB write failed with permanent error "
                        f"({exc_type}: {code}); disabling progress writer for "
                        f"task {self._task_id}: {e}",
                        flush=True,
                    )
                else:
                    # Event-level drop (size/schema violation).  Keep the
                    # stream alive.
                    print(
                        f"[progress] dropped event due to permanent DDB error "
                        f"({exc_type}: {code}); breaker NOT incremented: {e}",
                        flush=True,
                    )
                return

            if classification == "transient":
                new_count, now_disabled = _CIRCUIT_BREAKERS.record_failure(
                    self._task_id, self._MAX_FAILURES
                )
                if now_disabled:
                    print(
                        f"[progress] DDB write failed {new_count} times "
                        f"(transient); disabling progress writer for task "
                        f"{self._task_id}: {exc_type}: {e}",
                        flush=True,
                    )
                else:
                    print(
                        f"[progress] DDB write failed ({new_count}/"
                        f"{self._MAX_FAILURES}, transient): {exc_type}: {e}",
                        flush=True,
                    )
                return

            # Unknown: count like transient but flag loudly so operators
            # can add the new code to the classifier next release.
            new_count, now_disabled = _CIRCUIT_BREAKERS.record_failure(
                self._task_id, self._MAX_FAILURES
            )
            if now_disabled:
                print(
                    f"[progress] ERROR: DDB write failed {new_count} times with "
                    f"UNKNOWN error class; disabling progress writer for task "
                    f"{self._task_id}: {exc_type}: {e}",
                    flush=True,
                )
            else:
                print(
                    f"[progress] ERROR: DDB write failed ({new_count}/"
                    f"{self._MAX_FAILURES}) with UNKNOWN error class — consider "
                    f"adding {exc_type} to the classifier: {e}",
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
