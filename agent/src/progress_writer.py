# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

from __future__ import annotations

import json
import os
import random
import threading
import time
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

from observability import current_otel_trace_id

_PREVIEW_MAX_LEN = 200
_PREVIEW_MAX_LEN_TRACE = 4096

_TTL_SECONDS = 90 * 24 * 60 * 60

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _generate_ulid() -> str:
    timestamp_ms = int(time.time() * 1000)

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


def _truncate_preview(value: str | None, max_len: int = _PREVIEW_MAX_LEN) -> str:
    if not value:
        return ""
    if len(value) <= max_len:
        return value
    return value[:max_len] + "..."


BlockerKind = Literal[
    "missing_secret",
    "egress_denied",
    "dependency_unreachable",
    "policy_fail_closed",
    "auth_failure",
    "unknown_environmental",
]

BLOCKER_KINDS: frozenset[str] = frozenset(
    {
        "missing_secret",
        "egress_denied",
        "dependency_unreachable",
        "policy_fail_closed",
        "auth_failure",
        "unknown_environmental",
    }
)


def format_blocker_reason(kind: str, detail: str, resource: str | None = None) -> str:
    """Build the canonical terminal-reason string for a blocker.

    Format: ``BLOCKED[<kind>]: <detail>`` with `` (resource: <resource>)``
    appended when *resource* is set. This exact shape is what the CDK
    classifier regex matches, so it must not drift.

    Unknown *kind* values fall back to ``unknown_environmental`` rather than
    raising.
    """
    safe_kind = kind if kind in BLOCKER_KINDS else "unknown_environmental"
    reason = f"BLOCKED[{safe_kind}]: {detail}"
    if resource:
        reason += f" (resource: {resource})"
    return reason


# DynamoDB rejects an item above 400 KB with ValidationException.
_PERMANENT_DDB_ERROR_CODES: frozenset[str] = frozenset(
    {
        "ValidationException",
        "ItemCollectionSizeLimitExceededException",
        "ResourceNotFoundException",
        "AccessDeniedException",
        "UnauthorizedOperation",
    }
)

_TRANSIENT_DDB_ERROR_CODES: frozenset[str] = frozenset(
    {
        "ProvisionedThroughputExceededException",
        "RequestLimitExceeded",
        "ThrottlingException",
        "ServiceUnavailable",
        "InternalServerError",
    }
)

_TRANSIENT_NETWORK_EXC_NAMES: frozenset[str] = frozenset(
    {
        "ConnectionError",
        "EndpointConnectionError",
        "ReadTimeoutError",
        "ConnectTimeoutError",
        "ConnectionClosedError",
        "ClientConnectionError",
    }
)


def _classify_ddb_error(exc: BaseException) -> Literal["permanent", "transient", "unknown"]:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        error_block = response.get("Error") or {}
        code = error_block.get("Code") if isinstance(error_block, dict) else None
        if isinstance(code, str):
            if code in _PERMANENT_DDB_ERROR_CODES:
                return "permanent"
            if code in _TRANSIENT_DDB_ERROR_CODES:
                return "transient"

    exc_name = type(exc).__name__
    if exc_name in _TRANSIENT_NETWORK_EXC_NAMES:
        return "transient"

    return "unknown"


class _SharedCircuitBreaker:
    def __init__(self) -> None:
        self._state: dict[str, dict[str, int | bool]] = {}
        self._lock = threading.Lock()

    def is_disabled(self, task_id: str) -> bool:
        with self._lock:
            return bool(self._state.get(task_id, {}).get("disabled", False))

    def disable(self, task_id: str) -> None:
        with self._lock:
            entry = self._state.setdefault(task_id, {"failure_count": 0, "disabled": False})
            entry["disabled"] = True

    def record_failure(self, task_id: str, max_failures: int) -> tuple[int, bool]:
        with self._lock:
            entry = self._state.setdefault(task_id, {"failure_count": 0, "disabled": False})
            entry["failure_count"] = int(entry["failure_count"]) + 1
            if entry["failure_count"] >= max_failures:
                entry["disabled"] = True
            return int(entry["failure_count"]), bool(entry["disabled"])

    def record_success(self, task_id: str) -> None:
        with self._lock:
            entry = self._state.get(task_id)
            if entry is not None:
                entry["failure_count"] = 0


_CIRCUIT_BREAKERS = _SharedCircuitBreaker()


def _reset_circuit_breakers() -> None:
    global _CIRCUIT_BREAKERS
    _CIRCUIT_BREAKERS = _SharedCircuitBreaker()


class _ProgressWriter:
    _MAX_FAILURES = 3

    def __init__(
        self,
        task_id: str,
        trace: bool = False,
        user_id: str = "",
        repo: str | None = None,
    ) -> None:
        self._task_id = task_id
        self._user_id = user_id
        self._repo = repo
        self._table_name = os.environ.get("TASK_EVENTS_TABLE_NAME")
        self._table = None
        self._preview_max_len = _PREVIEW_MAX_LEN_TRACE if trace else _PREVIEW_MAX_LEN

    @property
    def _disabled(self) -> bool:
        return _CIRCUIT_BREAKERS.is_disabled(self._task_id)

    @_disabled.setter
    def _disabled(self, value: bool) -> None:
        if value:
            _CIRCUIT_BREAKERS.disable(self._task_id)

    @property
    def _failure_count(self) -> int:
        with _CIRCUIT_BREAKERS._lock:
            return int(_CIRCUIT_BREAKERS._state.get(self._task_id, {}).get("failure_count", 0))

    @_failure_count.setter
    def _failure_count(self, value: int) -> None:
        with _CIRCUIT_BREAKERS._lock:
            entry = _CIRCUIT_BREAKERS._state.setdefault(
                self._task_id, {"failure_count": 0, "disabled": False}
            )
            entry["failure_count"] = int(value)

    def _preview(self, value: str | None) -> str:
        return _truncate_preview(value, self._preview_max_len)

    def _ensure_table(self):
        if self._table is not None:
            return
        if not self._table_name:
            self._disabled = True
            return

        from aws_session import tenant_resource

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        dynamodb = tenant_resource("dynamodb", region_name=region)
        self._table = dynamodb.Table(self._table_name)

    def write_microvm_checkpoint(
        self, *, metadata: dict, condition_checks: list[dict], client
    ) -> None:
        """Atomically acknowledge a pause marker and its task/gate preconditions.

        This deliberately bypasses the best-effort event path: absent tables,
        disabled progress, failed conditions and uncertain writes must raise.
        """
        if not self._table_name or self._disabled:
            raise RuntimeError("Checkpoint progress table is unavailable")
        from boto3.dynamodb.types import TypeSerializer

        now = datetime.now(UTC)
        item = {
            "task_id": self._task_id,
            "event_id": _generate_ulid(),
            "event_type": "agent_milestone",
            "metadata": {"milestone": "microvm_suspend_checkpoint", **metadata},
            "timestamp": now.isoformat(),
            "ttl": int(now.timestamp()) + _TTL_SECONDS,
            "user_id": self._user_id,
        }
        if self._repo:
            item["repo"] = self._repo
        serializer = TypeSerializer()
        client.transact_write_items(
            TransactItems=[
                *({"ConditionCheck": check} for check in condition_checks),
                {
                    "Put": {
                        "TableName": self._table_name,
                        "Item": {key: serializer.serialize(value) for key, value in item.items()},
                        "ConditionExpression": "attribute_not_exists(task_id)",
                    }
                },
            ]
        )

    def _put_event(self, event_type: str, metadata: dict) -> None:
        from microvm_lifecycle import LifecycleUnavailable, get_context

        lifecycle = get_context(self._task_id)
        if lifecycle is None:
            self._put_event_best_effort(event_type, metadata)
            return
        try:
            with lifecycle.activity():
                acknowledged = False
                try:
                    acknowledged = self._put_event_best_effort(event_type, metadata)
                finally:
                    if not acknowledged:
                        lifecycle.progress_write_failed()
        except LifecycleUnavailable:
            lifecycle.progress_write_failed()
            print(
                f"[progress] lifecycle barrier closed — event not acknowledged "
                f"task_id={self._task_id} event_type={event_type} "
                f"phase={lifecycle.diagnostic_snapshot()['phase']}",
                flush=True,
            )

    def _put_event_best_effort(self, event_type: str, metadata: dict) -> bool:  # noqa: C901 -- 16 when the ceiling of 15 was set; must not grow
        if not self._table_name or self._disabled:
            return False
        try:
            self._ensure_table()
            if self._table is None:
                self._disabled = True
                return False

            now = datetime.now(UTC)
            trace_id = current_otel_trace_id()
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
            if self._user_id:
                item["user_id"] = self._user_id
            if self._repo:
                item["repo"] = self._repo
            if trace_id:
                item["trace_id"] = trace_id
            self._table.put_item(Item=item)

            _CIRCUIT_BREAKERS.record_success(self._task_id)
            return True

        except ImportError:
            self._disabled = True
            print("[progress] boto3 not available — skipping", flush=True)
        except Exception as e:
            classification = _classify_ddb_error(e)
            exc_type = type(e).__name__

            if classification == "permanent":
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
                    self._disabled = True
                    print(
                        f"[progress] DDB write failed with permanent error "
                        f"({exc_type}: {code}); disabling progress writer for "
                        f"task {self._task_id}: {e}",
                        flush=True,
                    )
                else:
                    print(
                        f"[progress] dropped event due to permanent DDB error "
                        f"({exc_type}: {code}); breaker NOT incremented: {e}",
                        flush=True,
                    )
                return False

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
                return False

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
        return False

    def write_agent_turn(
        self,
        turn: int,
        model: str,
        thinking: str,
        text: str,
        tool_calls_count: int,
    ) -> None:
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
        self._put_event(
            "agent_error",
            {
                "error_type": error_type,
                "message_preview": self._preview(message),
            },
        )

    def write_agent_blocked(
        self,
        *,
        kind: str,
        detail: str,
        remediation_hint: str,
        retryable: bool,
        resource: str | None = None,
    ) -> None:
        """Emit an ``agent_blocked`` event for an environmental fault.

        ``kind`` is one of :data:`BLOCKER_KINDS`; an unrecognised value is
        normalised to ``unknown_environmental``. ``detail`` and
        ``remediation_hint`` are truncated to the preview cap.
        """
        metadata: dict = {
            "kind": kind if kind in BLOCKER_KINDS else "unknown_environmental",
            "detail": self._preview(detail),
            "remediation_hint": self._preview(remediation_hint),
            "retryable": retryable,
        }
        if resource:
            metadata["resource"] = resource
        self._put_event("agent_blocked", metadata)

    def _put_approval_milestone(self, milestone: str, metadata: dict) -> None:
        payload: dict = {"milestone": milestone}
        payload.update(metadata)
        self._put_event("agent_milestone", payload)

    def write_approval_pre_approvals_loaded(self, count: int, scopes: list[str]) -> None:
        self._put_approval_milestone(
            "pre_approvals_loaded",
            {"count": count, "scopes": list(scopes)},
        )

    def write_approval_requested(
        self,
        *,
        request_id: str,
        tool_name: str,
        input_preview: str,
        reason: str,
        severity: str,
        timeout_s: int,
        matching_rule_ids: list[str],
    ) -> None:
        self._put_approval_milestone(
            "approval_requested",
            {
                "request_id": request_id,
                "tool_name": tool_name,
                "input_preview": self._preview(input_preview),
                "reason": self._preview(reason),
                "severity": severity,
                "timeout_s": timeout_s,
                "matching_rule_ids": list(matching_rule_ids),
            },
        )

    def write_approval_granted(
        self,
        *,
        request_id: str,
        scope: str,
        decided_at: str | None,
        created_at: str | None = None,
    ) -> None:
        """Emit ``approval_granted`` (user APPROVED).

        ``created_at`` is omitted from the event metadata when ``None``.
        """
        payload: dict = {
            "request_id": request_id,
            "scope": scope,
            "decided_at": decided_at,
        }
        if created_at is not None:
            payload["created_at"] = created_at
        self._put_approval_milestone("approval_granted", payload)

    def write_approval_denied(
        self,
        *,
        request_id: str,
        reason: str,
        decided_at: str | None,
        created_at: str | None = None,
    ) -> None:
        """Emit ``approval_denied`` (user DENIED).

        ``created_at`` is omitted from the event metadata when ``None``.
        """
        payload: dict = {
            "request_id": request_id,
            "reason": self._preview(reason),
            "decided_at": decided_at,
        }
        if created_at is not None:
            payload["created_at"] = created_at
        self._put_approval_milestone("approval_denied", payload)

    def write_approval_timed_out(
        self,
        *,
        request_id: str,
        timeout_s: int,
        created_at: str | None = None,
        effective_timeout_s: int | None = None,
        matching_rule_ids: list[str] | None = None,
    ) -> None:
        """Emit ``approval_timed_out`` (timer expired).

        - ``created_at`` — propagated from the approval row.
        - ``effective_timeout_s`` — the clipped timeout actually applied
          (from the approval row's ``timeout_s`` field, which is the
          post-clip value).
        - ``matching_rule_ids`` — rule ids that matched at gate-fire time.

        Each of the three is omitted from the event metadata when ``None``.
        """
        payload: dict = {"request_id": request_id, "timeout_s": timeout_s}
        if created_at is not None:
            payload["created_at"] = created_at
        if effective_timeout_s is not None:
            payload["effective_timeout_s"] = effective_timeout_s
        if matching_rule_ids is not None:
            payload["matching_rule_ids"] = list(matching_rule_ids)
        self._put_approval_milestone("approval_timed_out", payload)

    def write_approval_stranded(
        self,
        *,
        request_id: str,
        age_s: int,
        reason: str,
    ) -> None:
        self._put_approval_milestone(
            "approval_stranded",
            {"request_id": request_id, "age_s": age_s, "reason": self._preview(reason)},
        )

    def write_approval_write_failed(self, *, request_id: str | None, error: str) -> None:
        self._put_approval_milestone(
            "approval_write_failed",
            {"request_id": request_id, "error": self._preview(error)},
        )

    def write_approval_resume_failed(self, *, request_id: str, error: str) -> None:
        self._put_approval_milestone(
            "approval_resume_failed",
            {"request_id": request_id, "error": self._preview(error)},
        )

    def write_approval_poll_degraded(self, *, request_id: str, consecutive_failures: int) -> None:
        self._put_approval_milestone(
            "approval_poll_degraded",
            {
                "request_id": request_id,
                "consecutive_failures": consecutive_failures,
            },
        )

    def write_approval_timeout_capped(
        self,
        *,
        request_id: str,
        requested_timeout_s: int,
        effective_timeout_s: int,
        reason: str,
        matching_rule_ids: list[str] | None = None,
    ) -> None:
        """Emit ``approval_timeout_capped`` when min-wins clips the timeout.

        ``reason`` ∈ {rule_annotation, maxLifetime_ceiling, runtime_jwt_ceiling}.
        ``matching_rule_ids`` populated when ``reason == "rule_annotation"``.
        """
        payload: dict = {
            "request_id": request_id,
            "requested_timeout_s": requested_timeout_s,
            "effective_timeout_s": effective_timeout_s,
            "reason": reason,
        }
        if matching_rule_ids is not None:
            payload["matching_rule_ids"] = list(matching_rule_ids)
        self._put_approval_milestone("approval_timeout_capped", payload)

    def write_approval_ceiling_shrinking(
        self,
        *,
        request_id: str,
        max_lifetime_remaining_s: int,
        cleanup_margin_s: int,
        task_default_timeout_s: int,
    ) -> None:
        self._put_approval_milestone(
            "approval_ceiling_shrinking",
            {
                "request_id": request_id,
                "maxLifetime_remaining_s": max_lifetime_remaining_s,
                "cleanup_margin_s": cleanup_margin_s,
                "task_default_timeout_s": task_default_timeout_s,
            },
        )

    def write_approval_cap_exceeded(self, *, request_id: str, count: int, cap: int) -> None:
        self._put_approval_milestone(
            "approval_cap_exceeded",
            {"request_id": request_id, "count": count, "cap": cap},
        )

    def write_approval_rate_limit_exceeded(self, *, request_id: str, rate: int, limit: int) -> None:
        self._put_approval_milestone(
            "approval_rate_limit_exceeded",
            {"request_id": request_id, "rate": rate, "limit": limit},
        )

    def write_approval_late_win(self, *, request_id: str, outcome: str, reason: str) -> None:
        self._put_approval_milestone(
            "approval_late_win",
            {
                "request_id": request_id,
                "outcome": outcome,
                "reason": self._preview(reason),
            },
        )

    def write_policy_decision_cached(
        self,
        *,
        tool_name: str,
        tool_input_sha256: str,
        cached_decision: str,
        cached_reason: str,
        original_decision_ts: str,
        matched_rule_id: str | None = None,
    ) -> None:
        """Emit ``policy_decision`` for a recent-decision-cache hit.

        ``matched_rule_id`` is the rule a rule-level hit was denied for (a
        retry that matches a rule the user has just denied). A hit on the
        exact input has none, and the field is omitted from the metadata.
        """
        self._put_approval_milestone(
            "policy_decision",
            {
                "decision_source": "recent_decision_cache",
                "tool_name": tool_name,
                "tool_input_sha256": tool_input_sha256,
                **({} if matched_rule_id is None else {"matched_rule_id": matched_rule_id}),
                "cached_decision": cached_decision,
                "cached_reason": self._preview(cached_reason),
                "original_decision_ts": original_decision_ts,
            },
        )
