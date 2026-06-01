"""PreToolUse, PostToolUse, and Stop hook callbacks.

- PreToolUse: three-outcome Cedar policy enforcement (ALLOW / DENY /
  REQUIRE_APPROVAL). The REQUIRE_APPROVAL path writes a pending approval
  row + transitions the task to AWAITING_APPROVAL atomically, polls for a
  human decision, then resumes / denies per the user's input. See
  ``docs/design/CEDAR_HITL_GATES.md`` §6.5.
- PostToolUse: output scanner for secrets/PII.
- Stop: between-turns hook dispatcher. Cancel → nudge → denial injection
  in that order (cancel-wins semantics, finding #2). Each producer
  appends synthetic user-message strings that get reinjected via the
  SDK's ``decision: "block"`` mechanism.

A module-level registry ``between_turns_hooks`` lets phases (Phase 2
nudges, Phase 3 denial injections) append additional synthetic-message
producers without touching the Stop hook callback itself.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import nudge_reader
import task_state
from nudge_reader import _xml_escape
from output_scanner import scan_tool_output
from policy import APPROVAL_RATE_LIMIT, FLOOR_TIMEOUT_S, Outcome
from progress_writer import _generate_ulid
from shell import log, log_error_cw

if TYPE_CHECKING:
    from policy import PolicyEngine
    from telemetry import _TrajectoryWriter

# ---------------------------------------------------------------------------
# Chunk 3 constants (§6.5 pseudocode)
# ---------------------------------------------------------------------------

FLOOR_30S: int = FLOOR_TIMEOUT_S  # §6 decision #6: sourced from contracts/constants.json
CLEANUP_MARGIN_120S: int = 120  # §6.5 lifetime-margin reserve for cleanup
# Poll cadence per §3 decision #3 and IMPL-12: 2s for the first 30s, 5s
# thereafter. Exact counts vary with ``timeout_s``; these pin the
# user-observable "fast for a bit, then slack off" behavior.
POLL_FAST_INTERVAL_S: float = 2.0
POLL_FAST_DURATION_S: float = 30.0
POLL_SLOW_INTERVAL_S: float = 5.0
POLL_DEGRADED_FAILS: int = 3  # emit approval_poll_degraded at this count (§13.2)
POLL_MAX_CONSECUTIVE_FAILS: int = 10  # treat as TIMED_OUT at this count (§13.2)
TOOL_INPUT_PREVIEW_MAX: int = 256  # §6.5: strip-ANSI, truncate

# ANSI CSI / OSC escape sequence stripper for ``tool_input_preview`` +
# ``permissionDecisionReason`` fields (§12.7). Re-derives the pattern from
# the canonical definition; kept local to avoid adding a cross-module
# dependency for one regex.
_ANSI_ESCAPE_RE = re.compile(r"\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])")


def _strip_ansi(text: str) -> str:
    """Remove ANSI CSI / OSC sequences to prevent terminal injection (§12.7)."""
    return _ANSI_ESCAPE_RE.sub("", text)


def _truncate(text: str, max_len: int) -> str:
    """Truncate ``text`` to ``max_len`` chars with an ellipsis marker."""
    if text is None:
        return ""
    if len(text) <= max_len:
        return text
    # Reserve 3 chars for the ellipsis so the returned string never
    # exceeds ``max_len``.
    return text[: max_len - 3] + "..."


def _tool_input_preview(tool_input: Any, max_len: int = TOOL_INPUT_PREVIEW_MAX) -> str:
    """Return an ANSI-stripped, truncated preview of ``tool_input`` for DDB.

    Uses ``json.dumps`` so dict/list inputs render as stable JSON rather
    than Python repr (avoids leaking ``OrderedDict(...)`` wrappers etc.).
    Falls back to ``str()`` on any serialization error; never raises.
    """
    try:
        rendered = (
            tool_input if isinstance(tool_input, str) else json.dumps(tool_input, default=str)
        )
    except (TypeError, ValueError):
        rendered = str(tool_input)
    return _truncate(_strip_ansi(rendered), max_len)


def _deny_response(reason: str) -> dict:
    """Build a PreToolUse DENY response with a sanitized reason.

    Guaranteed surface: ``permissionDecisionReason`` is ANSI-stripped and
    truncated to 500 chars so it can never carry terminal-escape injection
    or overflow a log line (§6.5, §12.7).
    """
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": _truncate(_strip_ansi(reason or "denied"), 500),
        }
    }


def _allow_response(reason: str = "permitted") -> dict:
    """Build a PreToolUse ALLOW response."""
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": reason,
        }
    }


async def pre_tool_use_hook(
    hook_input: Any,
    tool_use_id: str | None,
    hook_context: Any,
    *,
    engine: PolicyEngine,
    trajectory: _TrajectoryWriter | None = None,
    task_id: str | None = None,
    user_id: str | None = None,
    progress: Any = None,
    task_state_module: Any = None,
) -> dict:
    """PreToolUse hook: three-outcome Cedar policy enforcement (§6.5).

    Returns a dict with hookSpecificOutput containing:
    - permissionDecision: "allow" or "deny"
    - permissionDecisionReason: explanation string

    The REQUIRE_APPROVAL path (Chunk 3, §6.5) pauses here: writes a
    pending approval row + transitions the task to AWAITING_APPROVAL
    atomically, polls for a human decision with 2s→5s backoff, then
    returns allow / deny based on the decision. On TIMED_OUT a
    ConditionCheckFailed from the best-effort status write triggers the
    IMPL-24 re-read — if the user's decision landed between our poll
    and write, we honor it instead of falsely denying.

    ``task_id`` / ``user_id`` / ``progress`` are optional to preserve
    the Phase 1 test call shape. Without them the REQUIRE_APPROVAL path
    falls through to fail-closed DENY (state-write infrastructure is
    missing), so legacy callers still see coherent behaviour.
    ``task_state_module`` is a test seam for injecting a mocked
    ``task_state`` namespace; production callers rely on the default.
    """
    ts_module = task_state_module if task_state_module is not None else task_state

    if not isinstance(hook_input, dict):
        log("WARN", "PreToolUse hook received non-dict input — denying")
        return _deny_response("invalid hook input")

    tool_name = hook_input.get("tool_name", "unknown")
    tool_input = hook_input.get("tool_input", {})
    if isinstance(tool_input, str):
        try:
            tool_input = json.loads(tool_input)
        except (json.JSONDecodeError, TypeError):
            log("WARN", f"PreToolUse hook failed to parse tool_input — denying {tool_name}")
            return _deny_response("unparseable tool input")

    decision = engine.evaluate_tool_use(tool_name, tool_input)

    # Telemetry: ALLOW "permitted" is the quiet happy path; everything else
    # is worth a trajectory event. Treat REQUIRE_APPROVAL as "not allowed"
    # for the legacy ``allowed=False`` field so the Phase 2 trajectory
    # schema stays coherent — the specific outcome is already on the
    # ``reason`` string.
    if trajectory and decision.reason != "permitted":
        trajectory.write_policy_decision(
            tool_name, decision.allowed, decision.reason, decision.duration_ms
        )

    if decision.outcome == Outcome.ALLOW:
        return _allow_response(decision.reason or "permitted")

    if decision.outcome == Outcome.DENY:
        # IMPL-23: when the DENY arrived from the recent-decision cache
        # (evaluate_tool_use Step 2.5), emit a ``policy_decision``
        # milestone with ``decision_source="recent_decision_cache"`` to
        # TaskEventsTable so cache-driven denies are visible in the live
        # stream + 90d audit record (§12.8). No new approval row is
        # written and the gate counter is NOT bumped — the original
        # gate already accounted for the decision.
        if progress is not None and decision.cache_hit_metadata is not None:
            _try_progress(
                progress,
                "write_policy_decision_cached",
                **decision.cache_hit_metadata,
            )
        log("POLICY", f"DENIED: {tool_name} — {decision.reason}")
        return _deny_response(decision.reason)

    # -- REQUIRE_APPROVAL path (§6.5) ---------------------------------------
    return await _handle_require_approval(
        decision=decision,
        tool_name=tool_name,
        tool_input=tool_input,
        engine=engine,
        task_id=task_id,
        user_id=user_id,
        progress=progress,
        ts=ts_module,
    )


async def _handle_require_approval(
    *,
    decision: Any,
    tool_name: str,
    tool_input: dict,
    engine: PolicyEngine,
    task_id: str | None,
    user_id: str | None,
    progress: Any,
    ts: Any,
) -> dict:
    """REQUIRE_APPROVAL branch of ``pre_tool_use_hook``.

    Split out of the main hook for readability — the control-flow in
    §6.5 is long enough that inlining it obscures the top-level three-way
    branch.
    """
    # Missing task infrastructure → fail closed with a clear reason. This
    # lines up with §13.15: every exceptional branch ends in DENY.
    if not task_id:
        log("WARN", "REQUIRE_APPROVAL hit without task_id — fail-closed deny")
        return _deny_response("approval system unavailable (no task_id)")

    request_id = _generate_ulid()

    # Step 1 — per-task cap. §12.9: cap exceeded fails closed and the
    # cap_exceeded milestone carries the configured cap so dashboards
    # reflect the blueprint override.
    if engine.approval_gate_count >= engine.approval_gate_cap:
        if progress is not None:
            _try_progress(
                progress,
                "write_approval_cap_exceeded",
                request_id=request_id,
                count=engine.approval_gate_count,
                cap=engine.approval_gate_cap,
            )
        return _deny_response(f"approval-gate cap exceeded ({engine.approval_gate_cap}/task)")

    # Step 2 — per-minute rate limit. ``approvals_in_last_minute`` prunes
    # on read so the comparison is against the current sliding window.
    rate = engine.approvals_in_last_minute
    if rate >= APPROVAL_RATE_LIMIT:
        if progress is not None:
            _try_progress(
                progress,
                "write_approval_rate_limit_exceeded",
                request_id=request_id,
                rate=rate,
                limit=APPROVAL_RATE_LIMIT,
            )
        return _deny_response(f"approval-gate rate limit exceeded ({APPROVAL_RATE_LIMIT}/min)")

    # Step 3 — effective timeout with floor/ceiling math (§6.5). Emit
    # ``approval_timeout_capped`` when the caller's ask is clipped so the
    # user can see why (IMPL-26).
    remaining_lifetime = _remaining_maxlifetime_s()
    effective_timeout, clip_reason, requested_timeout = _compute_effective_timeout(
        decision_timeout_s=decision.timeout_s,
        task_default_timeout_s=engine.task_default_timeout_s,
        remaining_lifetime_s=remaining_lifetime,
    )
    if clip_reason is not None and progress is not None:
        _try_progress(
            progress,
            "write_approval_timeout_capped",
            request_id=request_id,
            requested_timeout_s=requested_timeout,
            effective_timeout_s=effective_timeout,
            reason=clip_reason,
            matching_rule_ids=(
                list(decision.matching_rule_ids) if clip_reason == "rule_annotation" else None
            ),
        )
    # IMPL-26: once per task, surface the "gates will have small windows
    # from here on" ceiling-shrinking milestone when the remaining
    # lifetime is approaching the 2x-task-default threshold.
    if (
        remaining_lifetime is not None
        and remaining_lifetime - CLEANUP_MARGIN_120S < 2 * engine.task_default_timeout_s
        and engine.mark_ceiling_shrinking_emitted()
        and progress is not None
    ):
        _try_progress(
            progress,
            "write_approval_ceiling_shrinking",
            request_id=request_id,
            max_lifetime_remaining_s=remaining_lifetime,
            cleanup_margin_s=CLEANUP_MARGIN_120S,
            task_default_timeout_s=engine.task_default_timeout_s,
        )

    # Step 4 — insufficient lifetime remaining for a valid approval
    # (§13.7). Below the floor we DENY immediately without writing the
    # approval row; no point waking the user to a guaranteed-dead gate.
    if remaining_lifetime is not None and remaining_lifetime - CLEANUP_MARGIN_120S < FLOOR_30S:
        return _deny_response(
            f"insufficient maxLifetime remaining ({remaining_lifetime}s) for approval"
        )

    # Step 5 — build the approval row per §10.1 schema.
    tool_input_sha256 = _sha256_tool_input_for_row(tool_input)
    row = {
        "task_id": task_id,
        "request_id": request_id,
        "tool_name": tool_name,
        "tool_input_preview": _tool_input_preview(tool_input),
        "tool_input_sha256": tool_input_sha256,
        "reason": decision.reason,
        "severity": decision.severity or "medium",
        "matching_rule_ids": list(decision.matching_rule_ids),
        "status": "PENDING",
        "created_at": _iso_now(),
        "timeout_s": effective_timeout,
        "ttl": int(time.time()) + effective_timeout + CLEANUP_MARGIN_120S,
        "user_id": user_id or "",
        "repo": engine.repo,
    }

    # Step 6 — bump counters BEFORE the write so cap/rate checks on
    # subsequent gates reflect the attempt even if the DDB write itself
    # fails. The session counter survives within the task; the failure
    # path below emits ``approval_write_failed`` so the lost row is
    # visible.
    engine.increment_approval_gate_count()
    engine.record_approval_gate_timestamp()

    # Chunk 7 (§13.6): best-effort atomic increment of the persisted
    # ``approval_gate_count`` on TaskTable. The session counter
    # enforces the cap within THIS container; the persisted counter
    # exists so a restarted container re-seeds from a non-zero value
    # instead of re-exposing the user to another ``approval_gate_cap``
    # worth of gates. Failure is best-effort per §13.6 — "counter is
    # a safety bound, not a correctness bound" — so we keep going on
    # error and accept the (bounded) restart-retry amplification.
    if task_id:
        await asyncio.to_thread(ts.increment_approval_gate_count_in_ddb, task_id)

    # Step 7 — cross-table atomic transition.
    try:
        await asyncio.to_thread(ts.transact_write_approval_request, task_id, request_id, row)
    except ts.ApprovalWriteError as exc:
        if progress is not None:
            _try_progress(
                progress,
                "write_approval_write_failed",
                request_id=request_id,
                error=f"cancelled: {exc.cancellation_reasons}",
            )
        return _deny_response("approval system unavailable (write cancelled)")
    except ts.ApprovalTablesUnavailable as exc:
        if progress is not None:
            _try_progress(
                progress,
                "write_approval_write_failed",
                request_id=request_id,
                error=f"tables unavailable: {exc}",
            )
        return _deny_response("approval system unavailable (tables unconfigured)")
    except Exception as exc:
        log(
            "ERROR",
            f"approval request write failed: {type(exc).__name__}: {exc}",
        )
        if progress is not None:
            _try_progress(
                progress,
                "write_approval_write_failed",
                request_id=request_id,
                error=f"{type(exc).__name__}: {exc}",
            )
        return _deny_response("approval system unavailable")

    # Step 8 — ``approval_requested`` milestone so the user's stream
    # shows the gate immediately.
    if progress is not None:
        _try_progress(
            progress,
            "write_approval_requested",
            request_id=request_id,
            tool_name=tool_name,
            input_preview=row["tool_input_preview"],
            reason=decision.reason,
            severity=row["severity"],
            timeout_s=effective_timeout,
            matching_rule_ids=list(decision.matching_rule_ids),
        )

    # Step 9 — poll for a decision.
    outcome = await _poll_for_decision(
        task_id=task_id,
        request_id=request_id,
        timeout_s=effective_timeout,
        progress=progress,
        ts=ts,
    )

    # Step 10 — IMPL-24 VM-throttle + late-approval race. Best-effort
    # flip to TIMED_OUT; if ConditionCheckFailed, the user beat us — read
    # and honor.
    if outcome["status"] == "TIMED_OUT":
        try:
            wrote = await asyncio.to_thread(
                ts.best_effort_update_approval_status,
                task_id,
                request_id,
                "TIMED_OUT",
                reason=outcome.get("reason"),
            )
        except Exception as exc:
            log("WARN", f"approval TIMED_OUT write raised: {type(exc).__name__}: {exc}")
            # Fall into the IMPL-24 re-read path. A transient DDB write
            # error MUST NOT bypass the late-approval check — the user's
            # APPROVED decision may already be on the row, and skipping
            # the re-read would falsely deny their tool call. Setting
            # ``wrote = False`` triggers the ConsistentRead below; if
            # the row still says PENDING the re-read is a no-op and we
            # keep the TIMED_OUT outcome. If it says APPROVED/DENIED,
            # ``_reconcile_late_decision`` honors the user's choice.
            wrote = False
        if not wrote:
            # User's decision beat our timer; re-read with ConsistentRead.
            try:
                row_reread = await asyncio.to_thread(
                    ts.get_approval_row,
                    task_id,
                    request_id,
                    consistent_read=True,
                )
            except Exception as exc:
                log("WARN", f"approval re-read raised: {type(exc).__name__}: {exc}")
                row_reread = None
            outcome = _reconcile_late_decision(outcome, row_reread, progress, request_id)

    # Step 11 — resume transition (RUNNING). The ``awaiting_approval_request_id``
    # condition prevents resuming a cancelled task or racing with another
    # approval.
    try:
        await asyncio.to_thread(ts.transact_resume_from_approval, task_id, request_id)
    except ts.ApprovalResumeError as exc:
        if progress is not None:
            _try_progress(
                progress,
                "write_approval_resume_failed",
                request_id=request_id,
                error=f"cancelled: {exc.cancellation_reasons}",
            )
        return _deny_response("task no longer awaiting approval")
    except Exception as exc:
        log("WARN", f"approval resume raised: {type(exc).__name__}: {exc}")
        if progress is not None:
            _try_progress(
                progress,
                "write_approval_resume_failed",
                request_id=request_id,
                error=f"{type(exc).__name__}: {exc}",
            )
        return _deny_response("approval resume failed")

    # Step 12 — terminal branches.
    status = outcome.get("status")
    if status == "APPROVED":
        scope = outcome.get("scope") or "this_call"
        if scope != "this_call":
            try:
                engine.allowlist.add(scope)
            except ValueError as exc:
                # Malformed scope from the API — log loudly but still
                # allow this one call (the user did approve it).
                log("WARN", f"invalid approved scope {scope!r}: {exc}")
        if progress is not None:
            _try_progress(
                progress,
                "write_approval_granted",
                request_id=request_id,
                scope=scope,
                decided_at=outcome.get("decided_at"),
                # Chunk 8a: propagate the row's ``created_at`` so the
                # ApprovalMetricsPublisher can compute decision latency.
                created_at=row.get("created_at"),
            )
        return _allow_response(f"User approved ({scope})")

    # DENIED or TIMED_OUT — cache + queue injection.
    cache_decision = "DENIED" if status == "DENIED" else "TIMED_OUT"
    # IMPL-23: thread the user's ``decided_at`` into the cache entry so
    # subsequent cache-hit events surface the ORIGINAL decision timestamp,
    # not the wall-clock time the cache was populated (which is ~the same
    # but technically wrong). ``decided_at`` for TIMED_OUT is the
    # agent-side clock moment the timeout fired; for DENIED it's the
    # user's deny timestamp from the Lambda audit row.
    engine.recent_decisions.record(
        tool_name,
        tool_input_sha256,
        decision=cache_decision,
        reason=outcome.get("reason", ""),
        original_decision_ts=outcome.get("decided_at"),
    )

    # Rule-level cache (§12.8 extension): on DENIED, record an entry
    # per matching_rule_id so semantic retries — same rule, different
    # input — get fast-denied without a new approval round-trip. Only
    # populate on DENIED because TIMED_OUT is ambiguous (user was
    # away, not actively refusing); TIMED_OUT cache entries stay
    # input-hash-scoped.
    if status == "DENIED":
        for rule_id in decision.matching_rule_ids:
            engine.recent_decisions.record_rule_decision(
                tool_name,
                rule_id,
                decision="DENIED",
                reason=outcome.get("reason", ""),
                original_decision_ts=outcome.get("decided_at"),
            )

    if status == "DENIED":
        engine.queue_denial_injection(
            request_id=request_id,
            reason=outcome.get("reason", ""),
            decided_at=outcome.get("decided_at"),
        )
        if progress is not None:
            _try_progress(
                progress,
                "write_approval_denied",
                request_id=request_id,
                reason=outcome.get("reason", ""),
                decided_at=outcome.get("decided_at"),
                # Chunk 8a: propagate the row's ``created_at`` so the
                # ApprovalMetricsPublisher can compute decision latency.
                created_at=row.get("created_at"),
            )
    elif progress is not None:
        _try_progress(
            progress,
            "write_approval_timed_out",
            request_id=request_id,
            timeout_s=effective_timeout,
            # Chunk 8a: propagate the row's ``created_at`` +
            # ``matching_rule_ids`` + the post-clip effective timeout
            # so the ApprovalMetricsPublisher can emit the decision
            # latency + the ``ApprovalTimeoutBreakdown`` histogram
            # with a normalized ``rule_id`` dimension.
            created_at=row.get("created_at"),
            effective_timeout_s=effective_timeout,
            matching_rule_ids=list(decision.matching_rule_ids),
        )

    # Guaranteed surface (§6.5): truncated reason even when denial
    # injection is pre-empted by a concurrent cancel. Wrap the user's
    # reason in authoritative stop-language — E2E Phase 4 observed
    # the agent treating bare "User denied" as "try a different
    # approach" and burning through max_turns retrying the same rule
    # with trivial variations. The explicit AUTHORITATIVE-prefixed
    # wording, combined with the rule-level recent-deny cache (§12.8),
    # makes retries fail fast with clear feedback.
    raw_reason = outcome.get("reason") or f"User {status.lower() if status else 'denied'}"
    if status == "DENIED":
        rule_hint = (
            f" (matching rule{'s' if len(decision.matching_rule_ids) != 1 else ''}: "
            f"{', '.join(decision.matching_rule_ids)})"
            if decision.matching_rule_ids
            else ""
        )
        reason_text = (
            f"AUTHORITATIVE DENY from human reviewer: {raw_reason}{rule_hint}. "
            "Do NOT retry this class of action with trivial variations; "
            "the same rule will fast-deny subsequent attempts. Find an "
            "alternative task strategy or report back to the user explaining "
            "why progress is blocked."
        )
    else:
        reason_text = raw_reason
    return _deny_response(reason_text)


def _reconcile_late_decision(
    outcome: dict,
    row: dict | None,
    progress: Any,
    request_id: str,
) -> dict:
    """IMPL-24: rebuild outcome from a re-read row after a TIMED_OUT race.

    - ``row["status"] == "APPROVED"`` → rebuild as APPROVED (allow flow).
    - ``row["status"] == "DENIED"`` → rebuild as DENIED (deny flow).
    - Anything else (row gone, still PENDING) → fall through with the
      original TIMED_OUT (§13.12 fail-closed branch).

    Emits ``approval_late_win`` for APPROVED or DENIED races so operator
    telemetry can count them.
    """
    if row is None:
        return outcome
    status = row.get("status")
    if status == "APPROVED":
        if progress is not None:
            _try_progress(
                progress,
                "write_approval_late_win",
                request_id=request_id,
                outcome="APPROVED",
                reason="user decision landed during TIMED_OUT write",
            )
        return {
            "status": "APPROVED",
            "scope": row.get("scope"),
            "decided_at": row.get("decided_at"),
            "decided_by": row.get("user_id"),
        }
    if status == "DENIED":
        if progress is not None:
            _try_progress(
                progress,
                "write_approval_late_win",
                request_id=request_id,
                outcome="DENIED",
                reason="user decision landed during TIMED_OUT write",
            )
        return {
            "status": "DENIED",
            "reason": row.get("deny_reason") or "denied",
            "decided_at": row.get("decided_at"),
        }
    return outcome


async def _poll_for_decision(
    *,
    task_id: str,
    request_id: str,
    timeout_s: int,
    progress: Any,
    ts: Any,
) -> dict:
    """Poll the approval row until terminal or timeout.

    Cadence: ``POLL_FAST_INTERVAL_S`` for ``POLL_FAST_DURATION_S``, then
    ``POLL_SLOW_INTERVAL_S`` (IMPL-12). Each iteration uses
    ConsistentRead; after ``POLL_DEGRADED_FAILS`` consecutive failures we
    emit ``approval_poll_degraded``; at ``POLL_MAX_CONSECUTIVE_FAILS`` we
    fall through as TIMED_OUT with a distinct reason (§13.2).

    Returns an outcome dict mirroring the approval row's terminal fields.
    """
    deadline = time.monotonic() + timeout_s
    start = time.monotonic()
    consecutive_fails = 0
    degraded_emitted = False

    while True:
        now = time.monotonic()
        if now >= deadline:
            return {"status": "TIMED_OUT", "reason": None}

        try:
            row = await asyncio.to_thread(
                ts.get_approval_row,
                task_id,
                request_id,
                consistent_read=True,
            )
            consecutive_fails = 0
        except Exception as exc:
            consecutive_fails += 1
            log(
                "WARN",
                f"approval poll get_item raised ({consecutive_fails}/"
                f"{POLL_MAX_CONSECUTIVE_FAILS}): {type(exc).__name__}: {exc}",
            )
            if consecutive_fails >= POLL_DEGRADED_FAILS and not degraded_emitted:
                if progress is not None:
                    _try_progress(
                        progress,
                        "write_approval_poll_degraded",
                        request_id=request_id,
                        consecutive_failures=consecutive_fails,
                    )
                degraded_emitted = True
            if consecutive_fails >= POLL_MAX_CONSECUTIVE_FAILS:
                return {
                    "status": "TIMED_OUT",
                    "reason": f"poll failed {consecutive_fails} consecutive times",
                }
            row = None  # force sleep below

        if row is not None:
            status = row.get("status")
            if status == "APPROVED":
                return {
                    "status": "APPROVED",
                    "scope": row.get("scope"),
                    "decided_at": row.get("decided_at"),
                    "decided_by": row.get("user_id"),
                }
            if status == "DENIED":
                return {
                    "status": "DENIED",
                    "reason": row.get("deny_reason") or "denied",
                    "decided_at": row.get("decided_at"),
                }

        # Compute sleep interval based on elapsed since poll started.
        elapsed = time.monotonic() - start
        interval = POLL_FAST_INTERVAL_S if elapsed < POLL_FAST_DURATION_S else POLL_SLOW_INTERVAL_S
        # Clamp sleep against remaining deadline so we don't oversleep.
        sleep_for = min(interval, max(0.0, deadline - time.monotonic()))
        if sleep_for <= 0:
            return {"status": "TIMED_OUT", "reason": None}
        await asyncio.sleep(sleep_for)


def _compute_effective_timeout(
    *,
    decision_timeout_s: int | None,
    task_default_timeout_s: int,
    remaining_lifetime_s: int | None,
) -> tuple[int, str | None, int]:
    """Compute the effective timeout per §6.5.

    ``min(rule-annotation timeout, task default, remaining lifetime -
    cleanup margin)``, floored at FLOOR_30S. The engine's
    ``_merge_annotations`` already applies ``min(rule_annotation,
    task_default)`` — decision.timeout_s reaches us pre-clipped against
    those two. Here we apply the remaining-lifetime ceiling and report
    whichever source pulled the effective timeout below the task
    default, so the user sees "your gate was clipped because ..." rather
    than silent clipping.

    Returns ``(effective, clip_reason, requested)``:
    - ``requested`` — the user-visible "would have liked" value (task
      default for display purposes; the rule's ask was already merged).
    - ``clip_reason`` — ``"rule_annotation"`` when the rule's annotation
      pulled the decision below the task default; ``"maxLifetime_ceiling"``
      when the remaining-lifetime ceiling is the tightest bound; ``None``
      when nothing clipped.
    """
    requested = task_default_timeout_s
    decision_value = (
        decision_timeout_s if decision_timeout_s is not None else task_default_timeout_s
    )

    # Start with the decision value (already clipped by rule vs task default
    # in the engine) and apply the remaining-lifetime ceiling here.
    effective = decision_value
    clip_reason: str | None = None

    # Rule annotation clipped below task default — surface that first so a
    # later lifetime-ceiling clip can override with a more specific reason.
    if decision_value < requested:
        clip_reason = "rule_annotation"

    if remaining_lifetime_s is not None:
        ceiling = remaining_lifetime_s - CLEANUP_MARGIN_120S
        if ceiling < effective:
            effective = ceiling
            clip_reason = "maxLifetime_ceiling"

    # Floor: if clipping pushed below the hard floor, the effective value
    # is floored (so the user can still respond) but the clip reason is
    # still the tightest-binding input. Floor is a safety net, not a user
    # concept.
    if effective < FLOOR_30S:
        effective = FLOOR_30S

    return effective, clip_reason, requested


def _remaining_maxlifetime_s() -> int | None:
    """Compute remaining AgentCore maxLifetime seconds.

    Reads ``AGENTCORE_MAX_LIFETIME_S`` (default 8h) and ``TASK_STARTED_AT``
    (ISO 8601, optional). Returns ``None`` if the start timestamp is
    unavailable; the hook treats this as "unknown, don't clip" so the
    gate still fires with the task default (fail-open on the optional
    signal rather than pre-DENY when unknown). A future Chunk wires
    these from the task launch path; for now they are optional hints.
    """
    try:
        max_lifetime = int(os.environ.get("AGENTCORE_MAX_LIFETIME_S", "28800"))
    except ValueError:
        max_lifetime = 28800
    started_at = os.environ.get("TASK_STARTED_AT")
    if not started_at:
        return None
    try:
        # Support both ISO 8601 (YYYY-MM-DDTHH:MM:SSZ) and raw epoch seconds.
        if started_at.isdigit():
            started_epoch = int(started_at)
        else:
            from datetime import datetime

            started_epoch = int(datetime.strptime(started_at, "%Y-%m-%dT%H:%M:%SZ").timestamp())
    except (ValueError, AttributeError):
        return None
    elapsed = int(time.time()) - started_epoch
    remaining = max_lifetime - elapsed
    return max(0, remaining)


def _sha256_tool_input_for_row(tool_input: Any) -> str:
    """Stable SHA-256 of ``tool_input`` for the approval row + cache key.

    Re-derives hashing here (rather than importing ``policy._sha256_tool_input``)
    so the hook's failure-mode is independent of the engine's internals and
    to keep import graphs shallow. The engine's own cache uses the same
    algorithm; §6.5 row + ``RecentDecisionCache`` need the same key shape.
    """
    import hashlib

    try:
        serialized = (
            tool_input if isinstance(tool_input, str) else json.dumps(tool_input, sort_keys=True)
        )
    except (TypeError, ValueError):
        serialized = str(tool_input)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _iso_now() -> str:
    """ISO 8601 UTC timestamp in the ``YYYY-MM-DDTHH:MM:SSZ`` form."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# S10: per-method consecutive-failure counters for ``_try_progress``.
# Progress writes are best-effort, but a hard infrastructure failure
# (DDB throttle, IAM regression, missing table) would otherwise be
# masked as a stream of WARN lines with no escalation. After
# ``_TRY_PROGRESS_ESCALATE_AFTER`` consecutive failures of the same
# method the next failure is logged at ERROR via ``log_error_cw`` so
# it lands in APPLICATION_LOGS / TaskDashboard, and the counter
# resets so escalations don't spam. Per-method state because a
# single failing method shouldn't suppress visibility into other
# kinds of progress writes that might still be working.
_TRY_PROGRESS_ESCALATE_AFTER = 5
_try_progress_consecutive_failures: dict[str, int] = {}


def _try_progress(progress: Any, method_name: str, /, **kwargs: Any) -> None:
    """Call a progress-writer method, swallowing errors.

    Progress is best-effort observability; a throttled DDB write must not
    break the approval flow. ``_emit_nudge_milestone`` uses a similar
    pattern for the Phase 2 nudges.

    S10 escalation: repeated consecutive failures of the same
    ``method_name`` are tracked per-process and escalated to ERROR
    after ``_TRY_PROGRESS_ESCALATE_AFTER`` so a silent live-stream
    outage becomes operator-visible.
    """
    if getattr(progress, "_disabled", False) is True:
        log("WARN", f"progress {method_name!r} skipped: circuit breaker open")
        return
    method = getattr(progress, method_name, None)
    if method is None:
        log("DEBUG", f"progress missing {method_name!r}; skipping")
        return
    try:
        method(**kwargs)
    except Exception as exc:  # pragma: no cover — defensive
        prev = _try_progress_consecutive_failures.get(method_name, 0)
        count = prev + 1
        if count >= _TRY_PROGRESS_ESCALATE_AFTER:
            log_error_cw(
                f"progress {method_name!r} has failed {count} consecutive times; "
                f"latest: {type(exc).__name__}: {exc}",
            )
            _try_progress_consecutive_failures[method_name] = 0  # reset to avoid spam
        else:
            log("WARN", f"progress {method_name!r} raised: {type(exc).__name__}: {exc}")
            _try_progress_consecutive_failures[method_name] = count
        return
    # Success path — reset the consecutive-failure count.
    if _try_progress_consecutive_failures.get(method_name):
        _try_progress_consecutive_failures[method_name] = 0


async def post_tool_use_hook(
    hook_input: Any,
    tool_use_id: str | None,
    hook_context: Any,
    *,
    trajectory: _TrajectoryWriter | None = None,
) -> dict:
    """PostToolUse hook: screen tool output for secrets/PII.

    Returns a dict with hookSpecificOutput.  When sensitive content is
    detected the response includes ``updatedMCPToolOutput`` containing the
    redacted version (steered enforcement — content is sanitized, not
    blocked).
    """
    _PASS_THROUGH: dict = {"hookSpecificOutput": {"hookEventName": "PostToolUse"}}
    _FAIL_CLOSED: dict = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "updatedMCPToolOutput": "[Output redacted: screening error — fail-closed]",
        }
    }

    if not isinstance(hook_input, dict):
        log("WARN", "PostToolUse hook received non-dict input — passing through")
        return _PASS_THROUGH

    tool_name = hook_input.get("tool_name", "unknown")

    if "tool_response" not in hook_input:
        log("WARN", f"PostToolUse hook: missing 'tool_response' key for {tool_name}")
        return _PASS_THROUGH

    tool_response = hook_input["tool_response"]

    # Normalise non-string responses
    if not isinstance(tool_response, str):
        tool_response = str(tool_response)

    try:
        result = scan_tool_output(tool_response)
    except Exception as exc:
        log("ERROR", f"Output scanner failed for {tool_name}: {type(exc).__name__}: {exc}")
        if trajectory:
            trajectory.write_output_screening_decision(
                tool_name, [f"SCANNER_ERROR: {type(exc).__name__}"], redacted=True, duration_ms=0.0
            )
        return _FAIL_CLOSED

    if result.has_sensitive_content:
        if trajectory:
            trajectory.write_output_screening_decision(
                tool_name, result.findings, redacted=True, duration_ms=result.duration_ms
            )
        log("POLICY", f"OUTPUT REDACTED: {tool_name} — {', '.join(result.findings)}")
        return {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "updatedMCPToolOutput": result.redacted_content,
            }
        }

    return _PASS_THROUGH


# ---------------------------------------------------------------------------
# Between-turns hook registry (Phase 2 nudges, extensible for Phase 3)
# ---------------------------------------------------------------------------

# A hook takes a context dict (currently ``{"task_id": str}``) and returns a
# list of synthetic user-message strings to inject before the agent's next
# turn.  An empty list means "no injection — allow normal stop".
BetweenTurnsHook = Callable[[dict], list[str]]


# Process-lifetime dedup map: task_id -> set of nudge_ids already injected in
# this process.  Guards against infinite re-injection if ``mark_consumed``
# persistently fails (DDB throttling, IAM drift) — without this, the same
# nudge would be re-injected every Stop hook firing until ``max_turns`` is
# exhausted.  Lives for the duration of the process (== task) so it doesn't
# leak across tasks in the same runtime.
_INJECTED_NUDGES: dict[str, set[str]] = {}


def _reset_injected_nudges_for_tests() -> None:
    """Test-only helper to clear the in-process injected-nudge dedup set."""
    global _INJECTED_NUDGES
    _INJECTED_NUDGES = {}


def _emit_nudge_milestone(ctx: dict, milestone: str, details: str) -> None:
    """Emit ``agent_milestone`` to the progress writer.

    Best-effort — swallow errors so stream visibility failures never block
    nudge injection itself.  ``ctx`` may carry a ``progress`` ref stamped by
    :func:`stop_hook`.  Skips (with a log line in each case) when:

    - no ``progress`` ref is stamped on ``ctx`` (tests, early-boot, or a
      hook invoked outside :func:`stop_hook`'s dispatch)
    - the progress writer's circuit breaker has tripped after repeated
      DDB write failures (``ProgressWriter._disabled``)
    - the underlying ``write_agent_milestone`` raises despite the writer's
      own fail-open contract

    Surfacing these as log lines (instead of silent drops) lets
    ``--trace`` mode and CloudWatch Logs show when an ack could not be
    delivered to the durable event stream.
    """
    progress = ctx.get("progress")
    if progress is None:
        log("DEBUG", f"nudge milestone {milestone!r} skipped: no progress writer in ctx")
        return
    # Only skip when ``_disabled`` is explicitly True on a real ProgressWriter.
    # ``getattr(..., False)`` is not safe — ``MagicMock`` returns an auto-mock
    # attribute for any access, which evaluates truthy.
    if getattr(progress, "_disabled", False) is True:
        log(
            "WARN",
            f"nudge milestone {milestone!r} skipped: progress writer circuit breaker open",
        )
        return
    try:
        progress.write_agent_milestone(milestone=milestone, details=details)
    except Exception as exc:  # pragma: no cover — defensive, writers never raise
        log("WARN", f"nudge milestone {milestone!r} progress write failed: {exc}")


def _nudge_between_turns_hook(ctx: dict) -> list[str]:
    """Read pending nudges for the task and return them as XML user messages.

    Best-effort: marks each nudge consumed after formatting.  If
    ``mark_consumed`` fails we still inject (the conditional-update contract
    means at-most-once delivery on success, at-least-once on mark failures —
    better to over-steer than to drop a user instruction).

    Additionally, a process-lifetime dedup set (``_INJECTED_NUDGES``)
    prevents infinite re-injection of the same nudge across turns if
    ``mark_consumed`` repeatedly fails.

    Emits a ``nudge_acknowledged`` ``agent_milestone`` event **before**
    returning the injected user-message list (combined-turn ack, see
    ``INTERACTIVE_AGENTS.md`` §AD-5) so the durable event stream records
    the ack in the same turn the nudge is consumed.  Emission is
    best-effort: if the progress writer's circuit breaker has tripped
    (repeated DDB write failures) or no ``progress`` ref is stamped on
    ``ctx``, the ack is logged but skipped and the injection still
    proceeds — better to steer the agent than block on a flaky event
    table.
    """
    task_id = ctx.get("task_id") or ""
    if not task_id:
        return []

    # Belt-and-braces second guard against the "cancel consumes nudges" hazard
    # (krokoko PR #52 review finding #3).  The primary guard is the loop-level
    # break in :func:`stop_hook` which short-circuits the dispatcher as soon as
    # any earlier hook sets ``_cancel_requested``.  That assumes
    # ``_cancel_between_turns_hook`` runs BEFORE this hook — true for the
    # module-level ``between_turns_hooks`` registry today (line 340), but a
    # future reorder (or a test that rebinds the list without preserving
    # order) would silently reintroduce the bug: ``read_pending`` +
    # ``mark_consumed`` would flip the DDB rows to consumed and stamp
    # ``_INJECTED_NUDGES`` for a dying agent that will never see the text.
    # Early-returning here makes the invariant structural — no nudges are
    # ever consumed once cancel is flagged, regardless of hook ordering.
    if ctx.get("_cancel_requested"):
        return []

    try:
        pending = nudge_reader.read_pending(task_id)
    except Exception as exc:
        log("WARN", f"nudge read_pending raised: {type(exc).__name__}: {exc}")
        return []

    # Filter out any nudges already injected in this process (regardless of
    # whether mark_consumed succeeded previously).
    already = _INJECTED_NUDGES.get(task_id, set())
    pending = [n for n in pending if n.get("nudge_id") not in already]

    if not pending:
        return []

    try:
        formatted = nudge_reader.format_as_user_message(pending)
    except Exception as exc:
        log("WARN", f"nudge format failed: {type(exc).__name__}: {exc}")
        return []

    # Record injection BEFORE mark_consumed so a persistent mark_consumed
    # failure cannot cause re-injection on a later turn.
    task_set = _INJECTED_NUDGES.setdefault(task_id, set())
    for n in pending:
        nid = n.get("nudge_id")
        if nid:
            task_set.add(nid)

    # Mark-consumed is best-effort; log failures but do not block injection.
    for n in pending:
        try:
            nudge_reader.mark_consumed(task_id, n["nudge_id"])
        except Exception as exc:
            log("WARN", f"nudge mark_consumed raised: {type(exc).__name__}: {exc}")

    count = len(pending)
    log("NUDGE", f"Injecting {count} nudge(s) for task {task_id}")

    # Short details string for the stream — preview the first nudge, total
    # count, and the nudge IDs for traceability.  Kept under ~120 chars so
    # it fits on a single terminal line.
    first_msg = (pending[0].get("message") or "")[:60]
    ids = ",".join(str(n.get("nudge_id", ""))[-8:] for n in pending)
    details = f"{count} nudge(s) acknowledged (ids=…{ids}): {first_msg}" + (
        "…" if count > 1 or len(first_msg) == 60 else ""
    )
    # AD-5: emit the ack BEFORE returning the injection list.
    _emit_nudge_milestone(ctx, "nudge_acknowledged", details)

    return [formatted] if formatted else []


def _denial_between_turns_hook(ctx: dict) -> list[str]:
    """Drain queued denial injections into ``<user_denial>`` XML blocks.

    Registered AFTER ``_cancel_between_turns_hook`` and
    ``_nudge_between_turns_hook`` (cancel-wins semantics, finding #2).
    If cancel flagged this turn we early-return — denial injection is
    explicitly best-effort on cancelled tasks, and the guaranteed
    surface is the ``permissionDecisionReason`` that
    ``pre_tool_use_hook`` already returned on the deny response
    (§6.5 line 922).

    ``ctx["engine"]`` is expected when the pipeline wires the approval
    engine through; absent it this hook is a no-op (Phase 1 call sites
    that don't thread an engine ref through still work).
    """
    if ctx.get("_cancel_requested"):
        return []
    engine = ctx.get("engine")
    if engine is None:
        return []
    # ``drain_denial_injections`` clears the queue; this is deliberate
    # so a transient SDK failure that drops the injection does not
    # re-inject the same denial on every subsequent Stop seam.
    try:
        pending = engine.drain_denial_injections()
    except Exception as exc:  # pragma: no cover — defensive
        log("WARN", f"denial drain raised: {type(exc).__name__}: {exc}")
        return []
    if not pending:
        return []

    blocks: list[str] = []
    request_ids: list[str] = []
    for entry in pending:
        rid = _xml_escape(str(entry.get("request_id", "")))
        reason = _xml_escape(str(entry.get("reason", "")))
        decided_at = _xml_escape(str(entry.get("decided_at", "") or ""))
        blocks.append(
            f'<user_denial request_id="{rid}" decided_at="{decided_at}">\n{reason}\n</user_denial>'
        )
        if entry.get("request_id"):
            request_ids.append(str(entry["request_id"]))

    count = len(pending)
    log("POLICY", f"Injecting {count} denial(s) for task {ctx.get('task_id', '')}")
    # Emit a single ``user_denial_injected`` milestone per Stop seam so
    # the durable event stream records the ack. Mirrors
    # ``nudge_acknowledged`` (§AD-5); this is an additive milestone not
    # in the §11.1 enumerated list, so keep the name distinct from the
    # enumerated ``approval_*`` prefix.
    _emit_nudge_milestone(
        ctx,
        "user_denial_injected",
        f"{count} denial(s) injected (ids={','.join(request_ids)})",
    )
    return ["\n".join(blocks)] if blocks else []


def _cancel_between_turns_hook(ctx: dict) -> list[str]:
    """Detect user-initiated cancellation and signal the Stop hook to halt.

    Reads the task record from DynamoDB each turn.  If ``status == "CANCELLED"``
    sets ``ctx["_cancel_requested"] = True`` so :func:`stop_hook` returns
    ``continue_=False`` and the SDK tears the agent down cleanly.

    Fail-open: a ``TaskFetchError`` (transient DDB failure) is treated as
    "no cancel detected" to avoid stranding running tasks on blips.  This is
    symmetric with ``_nudge_between_turns_hook`` (also fail-open for DDB).
    Worst case a cancel is missed for one turn; the next turn will catch it.

    Returns ``[]`` always — the cancel signal flows via the ctx sentinel, not
    via injected text.  Injecting text would cause the SDK to continue the
    conversation, which is the opposite of what cancel needs.
    """
    task_id = ctx.get("task_id") or ""
    if not task_id:
        return []
    try:
        record = task_state.get_task(task_id)
    except task_state.TaskFetchError as exc:
        log("WARN", f"cancel hook get_task raised: {type(exc).__name__}: {exc}")
        return []
    if record and record.get("status") == "CANCELLED":
        ctx["_cancel_requested"] = True
        _emit_nudge_milestone(
            ctx,
            "cancel_detected",
            "Task cancelled by user; stopping agent after this turn.",
        )
    return []


# Global list of between-turns hooks.  Cancel MUST run first so it can
# short-circuit nudges on cancelled tasks (no point injecting nudges into a
# dying agent — worse, the nudge reader mutates DDB state that the agent will
# never act on; see krokoko PR #52 review finding #3).  The :func:`stop_hook`
# dispatcher breaks out of the loop as soon as ``_cancel_requested`` is set,
# and :func:`_nudge_between_turns_hook` early-returns when the flag is already
# present — belt-and-braces in case a future ``append`` reorders this list.
# Phase 3 (approval gates) should ``append`` additional hooks AFTER the
# nudge reader to preserve cancel-wins semantics.
between_turns_hooks: list[BetweenTurnsHook] = [
    _cancel_between_turns_hook,
    _nudge_between_turns_hook,
    # Chunk 3 (finding #2): denial injection runs LAST so both cancel and
    # nudge short-circuits pre-empt it. The hook explicitly re-checks
    # ``_cancel_requested`` so re-ordering doesn't silently break cancel
    # semantics (belt-and-braces, matching ``_nudge_between_turns_hook``).
    _denial_between_turns_hook,
]


async def stop_hook(
    hook_input: Any,
    tool_use_id: str | None,
    hook_context: Any,
    *,
    task_id: str,
    progress: Any = None,
    engine: Any = None,
) -> dict:
    """Stop hook: run registered between-turns hooks; block if they produce text.

    Returning ``{"decision": "block", "reason": "<text>"}`` tells the SDK to
    continue the conversation with *text* as the next user message rather
    than actually stopping.  If no hook produces text we return an empty
    dict (allow stop).

    Each between-turns hook is invoked via ``asyncio.to_thread`` so that
    sync boto3 calls inside the hook (DDB query + update) do not stall the
    asyncio loop driving ``client.receive_response()``.

    ``progress`` is an optional writer ref threaded into each hook's ``ctx``
    so hooks can emit their own milestone / progress events without holding
    a module-global reference to it. ``engine`` is threaded through for
    ``_denial_between_turns_hook`` which needs to drain queued denials;
    absent it the denial hook is a no-op (Phase 1 / Phase 2 call paths).
    """
    ctx = {
        "task_id": task_id,
        "progress": progress,
        "engine": engine,
    }

    # Cancel-before-nudge short-circuit (krokoko PR #52 review finding #3).
    # Previously the loop ran ALL hooks before checking ``_cancel_requested``,
    # which meant the nudge hook's ``read_pending`` + ``mark_consumed`` path
    # executed even on cancelled tasks — flipping the DDB rows to consumed
    # and stamping ``_INJECTED_NUDGES`` for a dying agent.  The user saw a
    # 202 Accepted for their nudge but the injection was discarded when we
    # returned ``continue_=False`` below.  Breaking out of the loop as soon
    # as any hook sets ``_cancel_requested`` guarantees subsequent hooks
    # (notably the nudge reader) never run, so DDB state is never mutated
    # for work the agent will never do.  The registry at line 340 keeps
    # ``_cancel_between_turns_hook`` first so this break fires before the
    # nudge hook gets a chance.  ``_nudge_between_turns_hook`` also carries
    # an internal cancel-check as belt-and-braces in case a future refactor
    # reorders the registry.
    chunks: list[str] = []
    for hook in between_turns_hooks:
        try:
            produced = await asyncio.to_thread(hook, ctx)
        except Exception as exc:
            log(
                "WARN",
                f"between-turns hook raised (task_id={task_id}): {type(exc).__name__}: {exc}",
            )
            continue
        if produced:
            chunks.extend(produced)
        if ctx.get("_cancel_requested"):
            # Any text produced by earlier hooks in this same loop iteration
            # is discarded below — the ``_cancel_requested`` branch returns
            # ``continue_=False`` and never reads ``chunks``.  This is
            # intentional: cancel wins, and we would rather drop a
            # simultaneous nudge than inject into a dying agent.
            break

    # Cancel takes precedence over nudge injection.  ``continue_: False`` tells
    # the SDK to end the turn loop and return control to the caller, which
    # lets the pipeline see the CANCELLED status and skip post-hooks.
    if ctx.get("_cancel_requested"):
        return {
            "continue_": False,
            "stopReason": "Task cancelled by user",
        }

    if not chunks:
        return {}

    reason = "\n\n".join(chunks)
    return {"decision": "block", "reason": reason}


def build_hook_matchers(
    engine: PolicyEngine,
    trajectory: _TrajectoryWriter | None = None,
    task_id: str = "",
    progress: Any = None,
    user_id: str = "",
) -> dict:
    """Build hook matchers dict for ClaudeAgentOptions.

    Returns a dict mapping HookEvent strings to lists of HookMatcher
    instances, ready to pass as ``hooks=...`` to ClaudeAgentOptions.

    The SDK expects ``dict[HookEvent, list[HookMatcher]]`` where HookMatcher
    has ``matcher: str | None`` and ``hooks: list[HookCallback]``.

    ``progress`` is forwarded to both the PreToolUse hook (approval gate
    milestones) and the Stop hook (nudge/denial acks). ``user_id`` is
    written onto the approval row so ownership checks on the REST side
    can enforce §12.2 (user can only approve their own gates).
    """
    from claude_agent_sdk.types import (
        HookContext,
        HookInput,
        HookJSONOutput,
        HookMatcher,
        PostToolUseHookSpecificOutput,
        SyncHookJSONOutput,
    )

    # Closure-based wrapper matches the HookCallback signature exactly:
    # (HookInput, str | None, HookContext) -> Awaitable[HookJSONOutput]
    async def _pre(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
        # Fail-closed wrapper (mirrors _post and _stop). If the inner hook
        # or its dispatch path raises an unexpected exception (asyncio
        # cancellation, TypeError from a malformed payload, etc.), the
        # SDK's default behaviour for an unhandled hook exception is
        # undefined — we MUST NOT trust it to fail closed. Mapping every
        # uncaught exception to a DENY here makes the security posture
        # explicit at the SDK boundary.
        try:
            result = await pre_tool_use_hook(
                hook_input,
                tool_use_id,
                ctx,
                engine=engine,
                trajectory=trajectory,
                task_id=task_id or None,
                user_id=user_id or None,
                progress=progress,
            )
        except Exception as exc:
            log(
                "ERROR",
                f"PreToolUse wrapper crashed (task_id={task_id}): {type(exc).__name__}: {exc}",
            )
            log_error_cw(
                f"PreToolUse wrapper crashed: {type(exc).__name__}: {exc}",
                task_id=task_id or None,
            )
            return SyncHookJSONOutput(
                **_deny_response("Hook error — fail-closed deny"),
            )
        return SyncHookJSONOutput(**result)

    async def _post(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
        try:
            result = await post_tool_use_hook(hook_input, tool_use_id, ctx, trajectory=trajectory)
            return SyncHookJSONOutput(**result)
        except Exception as exc:
            log("ERROR", f"PostToolUse wrapper crashed: {type(exc).__name__}: {exc}")
            fail_closed: PostToolUseHookSpecificOutput = {
                "hookEventName": "PostToolUse",
                "updatedMCPToolOutput": "[Output redacted: hook error — fail-closed]",
            }
            return SyncHookJSONOutput(hookSpecificOutput=fail_closed)

    async def _stop(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
        # Capture task_id up-front so it can be included in any wrapper
        # crash log for post-hoc correlation with user complaints.
        stop_task_id = task_id
        try:
            result = await stop_hook(
                hook_input,
                tool_use_id,
                ctx,
                task_id=stop_task_id,
                progress=progress,
                engine=engine,
            )
        except Exception as exc:
            log(
                "ERROR",
                f"Stop wrapper crashed (task_id={stop_task_id}): {type(exc).__name__}: {exc}",
            )
            return SyncHookJSONOutput()
        # Empty dict == allow stop.  SyncHookJSONOutput(**{}) is fine.
        return SyncHookJSONOutput(**result)

    return {
        "PreToolUse": [HookMatcher(matcher=None, hooks=[_pre])],
        "PostToolUse": [HookMatcher(matcher=None, hooks=[_post])],
        "Stop": [HookMatcher(matcher=None, hooks=[_stop])],
    }
