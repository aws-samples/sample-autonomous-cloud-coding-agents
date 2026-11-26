from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections.abc import Callable
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import nudge_reader
import task_state
from microvm_lifecycle import ApprovalRecord, get_context
from nudge_reader import _xml_escape
from output_scanner import _PATTERNS, scan_tool_output
from policy import (
    APPROVAL_RATE_LIMIT,
    FLOOR_TIMEOUT_S,
    Outcome,
    _sha256_tool_input,
    approval_deadline_epoch,
)
from progress_writer import _generate_ulid
from shared_constants import SHARED_CONSTANTS
from shell import log, log_error_cw, redact_secrets
from stuck_guard import StuckGuard

if TYPE_CHECKING:
    from policy import PolicyEngine
    from telemetry import _TrajectoryWriter

FLOOR_30S: int = FLOOR_TIMEOUT_S
CLEANUP_MARGIN_120S: int = 120
POLL_FAST_INTERVAL_S: float = 2.0
POLL_FAST_DURATION_S: float = 30.0
POLL_SLOW_INTERVAL_S: float = 5.0
POLL_DEGRADED_FAILS: int = 3
POLL_MAX_CONSECUTIVE_FAILS: int = 10
TOOL_INPUT_PREVIEW_MAX: int = 256
PERMISSION_REASON_MAX: int = 500
ELLIPSIS_LEN: int = 3


@dataclass(frozen=True)
class _ApprovalDeadline:
    wall_deadline: float
    monotonic_deadline: float

    @classmethod
    def from_recorded(cls, created_at: str, timeout_s: int) -> _ApprovalDeadline:
        wall_deadline = float(approval_deadline_epoch(created_at, timeout_s))
        remaining = max(0.0, min(timeout_s, wall_deadline - time.time()))
        return cls(wall_deadline, time.monotonic() + remaining)

    def remaining_s(self) -> float:
        return max(
            0.0,
            min(self.monotonic_deadline - time.monotonic(), self.wall_deadline - time.time()),
        )


_ANSI_ESCAPE_RE = re.compile(r"\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])")


def _strip_ansi(text: str) -> str:
    return _ANSI_ESCAPE_RE.sub("", text)


def _truncate(text: str | None, max_len: int) -> str:
    if text is None:
        return ""
    if len(text) <= max_len:
        return text
    if max_len <= ELLIPSIS_LEN:
        return text[:max_len]
    return text[: max_len - ELLIPSIS_LEN] + "..."


def _tool_input_preview(tool_input: dict) -> str:
    return _truncate(_strip_ansi(json.dumps(tool_input, default=str)), TOOL_INPUT_PREVIEW_MAX)


_EGRESS_DENIAL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"[Cc]ould not resolve host:?\s+(?P<host>[A-Za-z0-9._-]+)"),
    re.compile(r"[Ff]ailed to connect to\s+(?P<host>[A-Za-z0-9._-]+)"),
    re.compile(r"getaddrinfo (?:ENOTFOUND|EAI_AGAIN)\s+(?P<host>[A-Za-z0-9._-]+)"),
    re.compile(r"HTTPS?ConnectionPool\(host='(?P<host>[A-Za-z0-9._-]+)'"),
    re.compile(r"Failed to resolve '(?P<host>[A-Za-z0-9._-]+)'"),
    re.compile(
        r"nodename nor servname provided|Temporary failure in name resolution"
        r"|Name or service not known|Connection refused|Network is unreachable"
        r"|NameResolutionError|Failed to establish a new connection",
    ),
)

_LOOPBACK_HOST_RE = re.compile(r"localhost|127(?:\.\d+){3}|0(?:\.0){3}", re.IGNORECASE)

_NETWORK_TOOLS = frozenset(("Bash", "WebFetch"))


_LAST_BLOCKER_REASON: str | None = None


def _record_blocker_reason(kind: str, detail: str, resource: str | None = None) -> None:
    global _LAST_BLOCKER_REASON
    from progress_writer import format_blocker_reason

    _LAST_BLOCKER_REASON = format_blocker_reason(kind, detail, resource)


def last_blocker_reason() -> str | None:
    return _LAST_BLOCKER_REASON


def reset_blocker_reason() -> None:
    global _LAST_BLOCKER_REASON
    _LAST_BLOCKER_REASON = None


_LAST_STUCK_SUMMARY: str | None = None


def _screened(text: str) -> str:
    return redact_secrets(scan_tool_output(text).redacted_content)


def last_stuck_summary() -> str | None:
    """Return the latched stuck-guard summary with secrets redacted, or ``None``."""
    if not _LAST_STUCK_SUMMARY:
        return _LAST_STUCK_SUMMARY
    return _screened(_LAST_STUCK_SUMMARY)


def reset_stuck_summary() -> None:
    global _LAST_STUCK_SUMMARY
    _LAST_STUCK_SUMMARY = None


def detect_egress_denial(text: str) -> tuple[bool, str | None]:
    """Scan tool output for an egress-denial signature.

    Returns ``(detected, host_or_None)``: ``(True, host)`` on the first matching
    signature (``host`` is ``None`` for a signature that names no host), or
    ``(False, None)`` when nothing matches.
    """
    if not text:
        return False, None
    for pattern in _EGRESS_DENIAL_PATTERNS:
        match = pattern.search(text)
        if match:
            host = match.groupdict().get("host") if match.groupdict() else None
            return True, host
    return False, None


def _deny_response(reason: str) -> dict:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": _truncate(
                _strip_ansi(reason or "denied"), PERMISSION_REASON_MAX
            ),
        }
    }


def _allow_response(reason: str = "permitted") -> dict:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": reason,
        }
    }


_CLONE_CMD_RE = re.compile(
    r"(?:^|[;&|\n(]|&&|\|\|)\s*(?:gh\s+repo\s+clone|git\s+(?:-C\s+\S+\s+)?clone)\b",
    re.IGNORECASE,
)

_LINE_CONTINUATION_RE = re.compile(r"\\[ \t]*\r?\n[ \t]*")

_SHELL_SEPARATOR_RE = re.compile(r"(?:&&|\|\||[;&|])")

_HEREDOC_RE = re.compile(r"<<-?[ \t]*(['\"]?)(\w+)\1")

_CLOSED_TEXT_RE = re.compile(
    r"""
    \\.                    # an escaped character
    | (?<!\S)\#.*          # a comment, to the end of the line
    | '[^']*'              # a string in single quotes
    | "(?:[^"\\]|\\.)*"    # a string in double quotes
    """,
    re.VERBOSE,
)

_FREE_TEXT_ARG_RE = re.compile(
    r"(?:^|\s)(?:-m|--message|--body|--body-file|-b|--title|-t|-F|--field|--raw-field)\b",
    re.IGNORECASE,
)


def _repo_slug_variants(repo_url: str) -> list[str]:
    slug = (repo_url or "").strip().removesuffix(".git").strip("/").lower()
    if not slug:
        return []
    return [slug, f"{slug}.git"]


def _command_lines(command: str) -> list[str]:
    lines = command.split("\n")
    last = {line.strip(): number for number, line in enumerate(lines)}
    commands: list[list[str]] = []
    quote = ""
    word = None
    for number, line in enumerate(lines):
        if quote or word is not None:
            commands[-1].append(line)
        else:
            commands.append([line])
        if word is not None:
            if line.strip() == word:
                word = None
            continue
        operator = _HEREDOC_RE.search(line)
        if operator and last.get(operator[2], -1) > number:
            word = operator[2]
        opener = re.search("['\"]", _CLOSED_TEXT_RE.sub("", quote + line))
        quote = opener[0] if opener else ""
    return ["\n".join(one) for one in commands]


def _is_self_reclone(command: str, repo_url: str) -> bool:
    if not command or not repo_url:
        return False
    variants = _repo_slug_variants(repo_url)
    if not variants:
        return False
    normalized = _LINE_CONTINUATION_RE.sub(" ", command)
    normalized = ";".join(_command_lines(normalized))
    for segment in _SHELL_SEPARATOR_RE.split(normalized):
        clone = _CLONE_CMD_RE.search(segment)
        if clone is None:
            continue
        free_text = _FREE_TEXT_ARG_RE.search(segment)
        if free_text is not None and free_text.start() < clone.start():
            continue
        haystack = segment[clone.start() :].lower().replace("git@github.com:", "github.com/")
        if any(re.search(rf"(?<![\w.-]){re.escape(v)}(?![\w.-])", haystack) for v in variants):
            return True
    return False


_REDACTION_MARKER_RE = re.compile(
    r"\[REDACTED-(?:" + "|".join(re.escape(label) for label, _ in _PATTERNS) + r")\]"
    r"|\[Output redacted: [^\]\n]*\]"
)

_MARKER_FILE_LIMIT = 5_000_000


def _introduced_marker(tool_name: Any, tool_input: dict, cwd: Any) -> str | None:
    if tool_name == "Write":
        new = tool_input.get("content")
    elif tool_name == "Edit":
        new = tool_input.get("new_string")
    else:
        return None
    if not isinstance(new, str):
        return None
    markers = _REDACTION_MARKER_RE.findall(new)
    if not markers:
        return None
    old = tool_input.get("old_string")
    if tool_name == "Write":
        old = ""
        path = os.path.join(str(cwd or ""), str(tool_input.get("file_path") or ""))
        # A regular file only: a pipe or a device would not return.
        if os.path.isfile(path):
            try:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    old = fh.read(_MARKER_FILE_LIMIT)
            except OSError as exc:
                log("WARN", f"redaction-marker guard cannot read {path}: {type(exc).__name__}")
    if not isinstance(old, str):
        old = ""
    return next((m for m in markers if new.count(m) > old.count(m)), None)


def _redaction_marker_denial(
    tool_name: Any, tool_input: dict, cwd: Any, trajectory: _TrajectoryWriter | None
) -> dict | None:
    marker = _introduced_marker(tool_name, tool_input, cwd)
    if marker is None:
        return None
    path = _truncate(str(tool_input.get("file_path") or ""), 160)
    log("POLICY", f"DENIED {tool_name} of {path}: it would write the redaction marker {marker}")
    if trajectory:
        trajectory.write_policy_decision(tool_name, False, "redaction_marker_blocked", 0)
    return _deny_response(
        f"This {tool_name} would write the redaction marker '{marker}' into the file. "
        "The marker is not content of the file: in the output you were shown it "
        "stands for a value that is hidden from you, and the real value is still "
        "in the file on disk. Do not write the marker and do not guess the value. "
        "Leave that line as it is and change the file around it, with an Edit "
        "whose old_string and new_string do not include the line."
    )


async def pre_tool_use_hook(
    hook_input: Any,
    tool_use_id: str | None,
    _hook_context: Any,
    *,
    engine: PolicyEngine,
    trajectory: _TrajectoryWriter | None = None,
    task_id: str | None = None,
    user_id: str | None = None,
    progress: Any = None,
    task_state_module: Any = None,
    repo_url: str | None = None,
) -> dict:
    """PreToolUse hook: three-outcome Cedar policy enforcement.

    Returns a dict with hookSpecificOutput containing:
    - permissionDecision: "allow" or "deny"
    - permissionDecisionReason: explanation string

    The REQUIRE_APPROVAL path pauses here until a human decision or the
    timeout, then returns allow / deny based on the decision. Without
    ``task_id`` that path denies. ``task_state_module`` replaces the
    ``task_state`` module in tests.
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

    if not isinstance(tool_input, dict):
        log("WARN", f"PreToolUse hook received non-dict tool_input — denying {tool_name}")
        return _deny_response("tool input is not an object")

    if tool_name == "Bash" and repo_url:
        command = tool_input.get("command", "")
        if isinstance(command, str) and _is_self_reclone(command, repo_url):
            reason = (
                f"The repository '{repo_url}' is ALREADY cloned and checked out in "
                "your working directory — do NOT clone it again or work in another "
                "directory. Your commits must land in the current working directory "
                "so the platform can open the pull request on the correct branch. "
                "Remove the clone command and work in place (edit, commit, and push "
                "from where you already are)."
            )
            log("POLICY", f"DENIED self-reclone of {repo_url}: {_screened(command)[:160]}")
            if trajectory:
                trajectory.write_policy_decision("Bash", False, "self_reclone_blocked", 0)
            return _deny_response(reason)

    denial = _redaction_marker_denial(tool_name, tool_input, hook_input.get("cwd"), trajectory)
    if denial:
        return denial

    decision = engine.evaluate_tool_use(tool_name, tool_input)

    if trajectory and decision.reason != "permitted":
        trajectory.write_policy_decision(
            tool_name, decision.allowed, decision.reason, decision.duration_ms
        )

    if decision.outcome == Outcome.ALLOW:
        return _allow_response(decision.reason or "permitted")

    if decision.outcome == Outcome.DENY:
        if decision.cache_hit_metadata is not None:
            _try_progress(
                progress,
                "write_policy_decision_cached",
                **decision.cache_hit_metadata,
            )
        if getattr(decision, "fail_closed", False):
            _record_blocker_reason("policy_fail_closed", decision.reason)
            _try_progress(
                progress,
                "write_agent_blocked",
                kind="policy_fail_closed",
                detail=decision.reason,
                remediation_hint=(
                    "The Cedar policy engine errored or was unavailable "
                    "(fail-closed). Check the agent policy-engine logs and the "
                    "policy bundle; this is a misconfiguration, not an "
                    "intentional deny."
                ),
                retryable=False,
            )
        log("POLICY", f"DENIED: {tool_name} — {decision.reason}")
        return _deny_response(decision.reason)

    return await _handle_require_approval(
        decision=decision,
        tool_name=tool_name,
        tool_input=tool_input,
        engine=engine,
        task_id=task_id,
        user_id=user_id,
        progress=progress,
        ts=ts_module,
        tool_use_id=tool_use_id,
    )


async def _handle_require_approval(  # noqa: C901 -- 24, down from 35 when the ceiling of 15 was set; must not grow
    *,
    decision: Any,
    tool_name: str,
    tool_input: dict,
    engine: PolicyEngine,
    task_id: str | None,
    user_id: str | None,
    progress: Any,
    ts: Any,
    tool_use_id: str | None = None,
) -> dict:
    if not task_id:
        log("WARN", "REQUIRE_APPROVAL hit without task_id — fail-closed deny")
        return _deny_response("approval system unavailable (no task_id)")

    request_id = _generate_ulid()

    if engine.approval_gate_count >= engine.approval_gate_cap:
        _try_progress(
            progress,
            "write_approval_cap_exceeded",
            request_id=request_id,
            count=engine.approval_gate_count,
            cap=engine.approval_gate_cap,
        )
        return _deny_response(f"approval-gate cap exceeded ({engine.approval_gate_cap}/task)")

    rate = engine.approvals_in_last_minute
    if rate >= APPROVAL_RATE_LIMIT:
        _try_progress(
            progress,
            "write_approval_rate_limit_exceeded",
            request_id=request_id,
            rate=rate,
            limit=APPROVAL_RATE_LIMIT,
        )
        return _deny_response(f"approval-gate rate limit exceeded ({APPROVAL_RATE_LIMIT}/min)")

    remaining_lifetime = _remaining_maxlifetime_s()
    effective_timeout, clip_reason, requested_timeout = _compute_effective_timeout(
        decision_timeout_s=decision.timeout_s,
        task_default_timeout_s=engine.task_default_timeout_s,
        remaining_lifetime_s=remaining_lifetime,
    )
    if clip_reason is not None:
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
    if (
        remaining_lifetime is not None
        and remaining_lifetime - CLEANUP_MARGIN_120S < 2 * engine.task_default_timeout_s
        and engine.mark_ceiling_shrinking_emitted()
    ):
        _try_progress(
            progress,
            "write_approval_ceiling_shrinking",
            request_id=request_id,
            max_lifetime_remaining_s=remaining_lifetime,
            cleanup_margin_s=CLEANUP_MARGIN_120S,
            task_default_timeout_s=engine.task_default_timeout_s,
        )

    if remaining_lifetime is not None and remaining_lifetime - CLEANUP_MARGIN_120S < FLOOR_30S:
        return _deny_response(
            f"insufficient maxLifetime remaining ({remaining_lifetime}s) for approval"
        )

    tool_input_sha256 = _sha256_tool_input(tool_input)
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
        "user_id": user_id or "",
        "repo": engine.repo,
    }
    row["deadline_epoch"] = approval_deadline_epoch(row["created_at"], effective_timeout)
    row["ttl"] = row["deadline_epoch"] + CLEANUP_MARGIN_120S
    deadline = _ApprovalDeadline.from_recorded(row["created_at"], effective_timeout)

    engine.increment_approval_gate_count()
    engine.record_approval_gate_timestamp()

    await asyncio.to_thread(ts.increment_approval_gate_count_in_ddb, task_id)

    try:
        await asyncio.to_thread(ts.transact_write_approval_request, task_id, request_id, row)
    except ts.ApprovalWriteError as exc:
        _try_progress(
            progress,
            "write_approval_write_failed",
            request_id=request_id,
            error=f"cancelled: {exc.cancellation_reasons}",
        )
        return _deny_response("approval system unavailable (write cancelled)")
    except ts.ApprovalTablesUnavailable as exc:
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
        _try_progress(
            progress,
            "write_approval_write_failed",
            request_id=request_id,
            error=f"{type(exc).__name__}: {exc}",
        )
        return _deny_response("approval system unavailable")

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

    lifecycle = get_context(task_id)
    park = (
        lifecycle.park_approval(
            request_id,
            tool_use_id,
            deadline,
            record=ApprovalRecord(
                user_id=row["user_id"],
                repo=row["repo"],
                created_at=row["created_at"],
                timeout_s=effective_timeout,
            ),
        )
        if lifecycle
        else None
    )
    try:
        outcome = await _poll_for_decision(
            task_id=task_id,
            request_id=request_id,
            deadline=deadline,
            progress=progress,
            ts=ts,
        )
    finally:
        if lifecycle and park:
            await lifecycle.leave_approval(park)

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
            wrote = False
        if not wrote:
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

    try:
        await asyncio.to_thread(ts.transact_resume_from_approval, task_id, request_id)
    except ts.ApprovalResumeError as exc:
        _try_progress(
            progress,
            "write_approval_resume_failed",
            request_id=request_id,
            error=f"cancelled: {exc.cancellation_reasons}",
        )
        return _deny_response("task no longer awaiting approval")
    except Exception as exc:
        log("WARN", f"approval resume raised: {type(exc).__name__}: {exc}")
        _try_progress(
            progress,
            "write_approval_resume_failed",
            request_id=request_id,
            error=f"{type(exc).__name__}: {exc}",
        )
        return _deny_response("approval resume failed")

    status = outcome.get("status")
    if status == "APPROVED":
        scope = outcome.get("scope") or "this_call"
        for grant in _allowlist_scopes(scope, tool_name):
            try:
                engine.allowlist.add(grant)
            except ValueError as exc:
                log("WARN", f"invalid approved scope {scope!r}: {exc}")
        _try_progress(
            progress,
            "write_approval_granted",
            request_id=request_id,
            scope=scope,
            decided_at=outcome.get("decided_at"),
            created_at=row.get("created_at"),
        )
        return _allow_response(f"User approved ({scope})")

    cache_decision = "DENIED" if status == "DENIED" else "TIMED_OUT"
    engine.recent_decisions.record(
        tool_name,
        tool_input_sha256,
        decision=cache_decision,
        reason=outcome.get("reason") or "",
        original_decision_ts=outcome.get("decided_at"),
    )

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
        _try_progress(
            progress,
            "write_approval_denied",
            request_id=request_id,
            reason=outcome.get("reason", ""),
            decided_at=outcome.get("decided_at"),
            created_at=row.get("created_at"),
        )
    else:
        _try_progress(
            progress,
            "write_approval_timed_out",
            request_id=request_id,
            timeout_s=effective_timeout,
            created_at=row.get("created_at"),
            effective_timeout_s=effective_timeout,
            matching_rule_ids=list(decision.matching_rule_ids),
        )

    raw_reason = outcome.get("reason") or f"User {status.lower() if status else 'denied'}"
    if status == "DENIED":
        rule_hint = (
            f" (matching rule{'s' if len(decision.matching_rule_ids) != 1 else ''}: "
            f"{', '.join(decision.matching_rule_ids)})"
            if decision.matching_rule_ids
            else ""
        )
        prefix = "AUTHORITATIVE DENY from human reviewer: "
        stop_language = (
            ". Do NOT retry this class of action with trivial variations; "
            "the same rule will fast-deny subsequent attempts. Find an "
            "alternative task strategy or report back to the user explaining "
            "why progress is blocked."
        )
        room = PERMISSION_REASON_MAX - len(prefix) - len(stop_language)
        rule_hint = _truncate(rule_hint, room)
        reason = _truncate(_strip_ansi(raw_reason), room - len(rule_hint))
        reason_text = prefix + reason + rule_hint + stop_language
    else:
        reason_text = raw_reason
    return _deny_response(reason_text)


def _allowlist_scopes(scope: str, tool_name: str) -> list[str]:
    from policy import TOOL_GROUPS

    if scope == "this_call":
        return []
    if scope == "tool_type_session":
        return [f"tool_type:{tool_name}"]
    if scope == "tool_group_session":
        groups = [group for group, tools in TOOL_GROUPS.items() if tool_name in tools]
        if not groups:
            log("WARN", f"tool_group_session approved for {tool_name}, which is in no tool group")
        return [f"tool_group:{group}" for group in groups]
    return [scope]


def _reconcile_late_decision(
    outcome: dict,
    row: dict | None,
    progress: Any,
    request_id: str,
) -> dict:
    if row is None:
        return outcome
    status = row.get("status")
    if status == "APPROVED":
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
    if status == "CANCELLED":
        return {"status": "CANCELLED", "reason": row.get("cancellation_reason")}
    if status == "DENIED":
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
    deadline: _ApprovalDeadline,
    progress: Any,
    ts: Any,
) -> dict:
    start = time.monotonic()
    consecutive_fails = 0
    degraded_emitted = False

    lifecycle = get_context(task_id)
    while True:
        async with lifecycle.approval_poll() if lifecycle else nullcontext():
            if deadline.remaining_s() <= 0:
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
                row = None

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
                if status == "CANCELLED":
                    return {
                        "status": "CANCELLED",
                        "reason": row.get("cancellation_reason"),
                    }

        elapsed = time.monotonic() - start
        interval = POLL_FAST_INTERVAL_S if elapsed < POLL_FAST_DURATION_S else POLL_SLOW_INTERVAL_S
        sleep_for = min(interval, deadline.remaining_s())
        if sleep_for <= 0:
            return {"status": "TIMED_OUT", "reason": None}
        await asyncio.sleep(sleep_for)


def _compute_effective_timeout(
    *,
    decision_timeout_s: int | None,
    task_default_timeout_s: int,
    remaining_lifetime_s: int | None,
) -> tuple[int, str | None, int]:
    requested = task_default_timeout_s
    decision_value = (
        decision_timeout_s if decision_timeout_s is not None else task_default_timeout_s
    )

    effective = decision_value
    clip_reason: str | None = None

    if decision_value < requested:
        clip_reason = "rule_annotation"

    if remaining_lifetime_s is not None:
        ceiling = remaining_lifetime_s - CLEANUP_MARGIN_120S
        if ceiling < effective:
            effective = ceiling
            clip_reason = "maxLifetime_ceiling"

    if effective < FLOOR_30S:
        effective = FLOOR_30S

    return effective, clip_reason, requested


def _remaining_maxlifetime_s() -> int | None:
    try:
        max_lifetime = int(os.environ.get("AGENTCORE_MAX_LIFETIME_S", "28800"))
    except ValueError:
        max_lifetime = 28800
    started_at = os.environ.get("TASK_STARTED_AT")
    if not started_at:
        return None
    try:
        if started_at.isdigit():
            started_epoch = int(started_at)
        else:
            started = datetime.fromisoformat(started_at)
            if started.tzinfo is None:
                started = started.replace(tzinfo=UTC)
            started_epoch = int(started.timestamp())
    except (ValueError, AttributeError):
        # nosemgrep: py-silent-success-masking -- start unknown: the gate gets no lifetime ceiling
        return None
    elapsed = int(time.time()) - started_epoch
    remaining = max_lifetime - elapsed
    return max(0, remaining)


def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


_TRY_PROGRESS_ESCALATE_AFTER = 5
_try_progress_consecutive_failures: dict[str, int] = {}


def _try_progress(progress: Any, method_name: str, /, **kwargs: Any) -> None:
    if getattr(progress, "_disabled", False) is True:
        log("WARN", f"progress {method_name!r} skipped: circuit breaker open")
        return
    method = getattr(progress, method_name, None)
    if method is None:
        log("DEBUG", f"progress missing {method_name!r}; skipping")
        return
    try:
        method(**kwargs)
    except Exception as exc:
        prev = _try_progress_consecutive_failures.get(method_name, 0)
        count = prev + 1
        if count >= _TRY_PROGRESS_ESCALATE_AFTER:
            log_error_cw(
                f"progress {method_name!r} has failed {count} consecutive times; "
                f"latest: {type(exc).__name__}: {exc}",
            )
            _try_progress_consecutive_failures[method_name] = 0
        else:
            log("WARN", f"progress {method_name!r} raised: {type(exc).__name__}: {exc}")
            _try_progress_consecutive_failures[method_name] = count
        return
    if _try_progress_consecutive_failures.get(method_name):
        _try_progress_consecutive_failures[method_name] = 0


async def post_tool_use_hook(
    hook_input: Any,
    _tool_use_id: str | None,
    _hook_context: Any,
    *,
    trajectory: _TrajectoryWriter | None = None,
    stuck_guard: StuckGuard | None = None,
    progress: Any = None,
) -> dict:
    """PostToolUse hook: screen tool output for secrets/PII.

    Returns a dict with hookSpecificOutput.  When sensitive content is
    detected the response includes ``updatedToolOutput``: the tool response
    in its own shape, with the secrets in its strings redacted. A response
    in which the scanner fails on a string is blanked as a whole.

    With ``progress``, an egress-denial signature in the tool output emits
    an ``egress_denied`` blocker event. With ``stuck_guard``, every tool
    result is recorded, and its one-time advisory about a repeating failing
    command is returned as ``additionalContext``. Neither alters the
    screening outcome.
    """
    _PASS_THROUGH: dict = {"hookSpecificOutput": {"hookEventName": "PostToolUse"}}

    if not isinstance(hook_input, dict):
        log("WARN", "PostToolUse hook received non-dict input — passing through")
        return _PASS_THROUGH

    tool_name = hook_input.get("tool_name", "unknown")

    if "tool_response" not in hook_input:
        log("WARN", f"PostToolUse hook: missing 'tool_response' key for {tool_name}")
        return _PASS_THROUGH

    tool_response = hook_input["tool_response"]
    output: dict = {"hookEventName": "PostToolUse"}

    steer = _observe_tool_result(
        tool_name,
        hook_input.get("tool_input"),
        tool_response,
        progress=progress,
        stuck_guard=stuck_guard,
        # A Bash command can hide a failure behind its exit status (``yarn build | tail``).
        failed=None if tool_name == "Bash" else False,
    )
    if steer:
        output["additionalContext"] = steer

    findings: list[str] = []
    marker = "[Output redacted: screening error — fail-closed]"

    def _screen(text: str) -> str:
        try:
            result = scan_tool_output(text)
        except Exception as exc:
            finding = f"SCANNER_ERROR: {type(exc).__name__}"
            if finding not in findings:
                log("ERROR", f"Output scanner failed for {tool_name}: {type(exc).__name__}: {exc}")
                findings.append(finding)
            return marker
        findings.extend(found for found in result.findings if found not in findings)
        return result.redacted_content if result.has_sensitive_content else text

    started = time.monotonic()
    screened = _map_strings(tool_response, _screen)
    redacted = True
    if any(found.startswith("SCANNER_ERROR") for found in findings):
        screened = _fail_closed_output(tool_name, tool_response, marker)
        redacted = str(tool_name).startswith("mcp__") or str(tool_name) in _SCHEMA_FIXED
    if findings:
        if trajectory:
            trajectory.write_output_screening_decision(
                tool_name,
                findings,
                redacted=redacted,
                duration_ms=(time.monotonic() - started) * 1000,
            )
        outcome = "OUTPUT REDACTED" if redacted else "OUTPUT NOT SCREENED"
        log("POLICY", f"{outcome}: {tool_name} — {', '.join(findings)}")
        output["updatedToolOutput"] = screened

    return {"hookSpecificOutput": output}


async def post_tool_use_failure_hook(
    hook_input: Any,
    _tool_use_id: str | None,
    _hook_context: Any,
    *,
    stuck_guard: StuckGuard | None = None,
    progress: Any = None,
) -> dict:
    """PostToolUseFailure hook: show a failed tool call to the observers.

    The CLI fires this event, and no PostToolUse, for a tool call that fails —
    for Bash, a command that exits non-zero, unless the CLI reads that status
    as an answer (1 from ``grep`` without a match) — with the text of the
    failure under ``error``. Returns the stuck guard's advisory as
    ``additionalContext`` when there is one, else an empty answer.
    """
    if not isinstance(hook_input, dict):
        log("WARN", "PostToolUseFailure hook received non-dict input — ignoring")
        return {}

    steer = _observe_tool_result(
        hook_input.get("tool_name", "unknown"),
        hook_input.get("tool_input"),
        str(hook_input.get("error", "")),
        progress=progress,
        stuck_guard=stuck_guard,
    )
    if not steer:
        return {}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUseFailure",
            "additionalContext": steer,
        }
    }


def _observe_tool_result(
    tool_name: str,
    tool_input: Any,
    response: Any,
    *,
    progress: Any,
    stuck_guard: StuckGuard | None,
    failed: bool | None = None,
) -> str | None:
    global _LAST_STUCK_SUMMARY

    text = response if isinstance(response, str) else str(response)

    egress_detected, host = detect_egress_denial(text)
    if egress_detected:
        detail = (
            f"A connection to {host!r} was blocked"
            if host
            else "An outbound connection was blocked"
        ) + f" during {tool_name}."
        if (
            host
            and not _LOOPBACK_HOST_RE.fullmatch(host)
            and str(tool_name) in _NETWORK_TOOLS
            and failed is not False
        ):
            _record_blocker_reason("egress_denied", detail, host)
        _try_progress(
            progress,
            "write_agent_blocked",
            kind="egress_denied",
            detail=detail,
            remediation_hint=(
                f"Allowlist {host!r} in the DNS Firewall rule group"
                if host
                else "Allowlist the required host in the DNS Firewall rule group"
            )
            + " if it is a legitimate dependency. The agent never widens egress itself.",
            retryable=False,
            resource=host,
        )

    if stuck_guard is None:
        return None
    action = None
    try:
        stuck_guard.record_tool_result(
            tool_name,
            _map_strings(tool_input, _screened),
            text if failed is False else str(_map_strings(response, _screened)),
            failed,
        )
        action = stuck_guard.evaluate()
        _LAST_STUCK_SUMMARY = stuck_guard.recent_failure_summary()
    except Exception as exc:
        log("WARN", f"stuck-guard raised (ignored): {type(exc).__name__}: {exc}")
    if action is None or action.kind != "steer":
        return None
    _try_progress(
        progress,
        "write_agent_milestone",
        milestone="stuck_steer",
        details=action.message[:_NUDGE_PREVIEW_LEN],
    )
    log("NUDGE", f"stuck-guard STEER injected: {_screened(action.signature)}")
    return action.message


# The CLI checks a rewritten response against the output schema of the tool and
# passes the original output on when it does not fit.
_SCHEMA_FIXED: dict[str, tuple[str, ...]] = {
    # The keys of "gitOperation", which the CLI adds to the result of a command
    # it takes for a commit, a merge, a rebase or a pull request.
    "Bash": ("kind", "action"),
    "Edit": ("status",),
    "Glob": (),
    "Grep": ("mode",),
    "Read": ("type",),
    "WebFetch": (),
    "Write": ("type", "status"),
}


def _fail_closed_output(tool_name: Any, tool_response: Any, marker: str) -> Any:
    name = str(tool_name)
    if name.startswith("mcp__"):
        # The result of an MCP tool is a list of content blocks, and the Messages
        # API refuses a request that holds a block whose "type" is no block type.
        return marker
    if name == "Read" and isinstance(tool_response, dict) and tool_response.get("type") != "text":
        # The blocks of an image, a PDF or a notebook do not take blanked data.
        return {
            "type": "text",
            "file": {
                "filePath": marker,
                "content": marker,
                "numLines": 1,
                "startLine": 1,
                "totalLines": 1,
            },
        }
    return _map_strings(tool_response, lambda _text: marker, _SCHEMA_FIXED.get(name, ()))


def _map_strings(value: Any, fn: Callable[[str], str], keep: tuple[str, ...] = ()) -> Any:
    if isinstance(value, str):
        return fn(value)
    if isinstance(value, dict):
        return {
            key: item if key in keep else _map_strings(item, fn, keep)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_map_strings(item, fn, keep) for item in value]
    return value


BetweenTurnsHook = Callable[[dict], list[str]]


_INJECTED_NUDGES: dict[str, set[str]] = {}

_NUDGE_PREVIEW_LEN = 60


def _reset_injected_nudges_for_tests() -> None:
    global _INJECTED_NUDGES
    _INJECTED_NUDGES = {}


def _nudge_between_turns_hook(ctx: dict) -> list[str]:
    task_id = ctx.get("task_id") or ""
    if not task_id:
        return []

    if ctx.get("_cancel_requested"):
        return []

    pending = nudge_reader.read_pending(task_id)

    already = _INJECTED_NUDGES.get(task_id, set())
    pending = [n for n in pending if n.get("nudge_id") not in already]

    if not pending:
        return []

    formatted = nudge_reader.format_as_user_message(pending)

    task_set = _INJECTED_NUDGES.setdefault(task_id, set())
    for n in pending:
        nid = n.get("nudge_id")
        if nid:
            task_set.add(nid)

    for n in pending:
        nudge_reader.mark_consumed(task_id, n["nudge_id"])

    count = len(pending)
    log("NUDGE", f"Injecting {count} nudge(s) for task {task_id}")

    first_msg = (pending[0].get("message") or "")[:_NUDGE_PREVIEW_LEN]
    ids = ",".join(str(n.get("nudge_id", ""))[-8:] for n in pending)
    details = f"{count} nudge(s) acknowledged (ids=…{ids}): {first_msg}" + (
        "…" if count > 1 or len(first_msg) == _NUDGE_PREVIEW_LEN else ""
    )
    _try_progress(
        ctx.get("progress"),
        "write_agent_milestone",
        milestone="nudge_acknowledged",
        details=details,
    )

    return [formatted] if formatted else []


def _denial_between_turns_hook(ctx: dict) -> list[str]:
    if ctx.get("_cancel_requested"):
        return []
    engine = ctx.get("engine")
    if engine is None:
        return []
    pending = engine.drain_denial_injections()
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
    _try_progress(
        ctx.get("progress"),
        "write_agent_milestone",
        milestone="user_denial_injected",
        details=f"{count} denial(s) injected (ids={','.join(request_ids)})",
    )
    return ["\n".join(blocks)] if blocks else []


def _cancel_between_turns_hook(ctx: dict) -> list[str]:
    task_id = ctx.get("task_id") or ""
    if not task_id:
        return []
    try:
        record = task_state.get_task(task_id)
    except task_state.TaskFetchError as exc:
        log("WARN", f"cancel hook get_task raised: {type(exc).__name__}: {exc}")
        # nosemgrep: py-silent-success-masking -- fail-open cancel; DDB blip delays one turn
        return []
    if record and record.get("status") == "CANCELLED":
        ctx["_cancel_requested"] = True
        _try_progress(
            ctx.get("progress"),
            "write_agent_milestone",
            milestone="cancel_detected",
            details="Task cancelled by user; stopping agent after this turn.",
        )
    return []


between_turns_hooks: list[BetweenTurnsHook] = [
    _cancel_between_turns_hook,
    _nudge_between_turns_hook,
    _denial_between_turns_hook,
]


async def stop_hook(
    _hook_input: Any,
    _tool_use_id: str | None,
    _hook_context: Any,
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

    ``progress`` and ``engine`` are threaded into each hook's ``ctx``.
    Without ``engine`` no denial is injected.
    """
    ctx = {
        "task_id": task_id,
        "progress": progress,
        "engine": engine,
    }

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
            break

    if ctx.get("_cancel_requested"):
        return {
            "continue_": False,
            "stopReason": "Task cancelled by user",
        }

    if not chunks:
        return {}

    reason = "\n\n".join(chunks)
    return {"decision": "block", "reason": reason}


async def _lifecycle_tool_started(lifecycle: Any, hook_input: Any, tool_use_id: str | None) -> None:
    await lifecycle.tool_started(tool_use_id)
    if isinstance(hook_input, dict):
        tool_input = hook_input.get("tool_input")
        if not isinstance(tool_input, dict) or tool_input.get("run_in_background"):
            lifecycle.disable_suspend()


def _lifecycle_tool_finished(lifecycle: Any, hook_input: Any, tool_use_id: str | None) -> None:
    # The CLI can move a running Bash call to the background: with a background
    # task id in the result, the child may still run after the post hook.
    if isinstance(hook_input, dict):
        response = hook_input.get("tool_response")
        if isinstance(response, dict) and (
            response.get("backgroundTaskId") or response.get("background_task_id")
        ):
            lifecycle.disable_suspend()
    lifecycle.tool_finished(tool_use_id)


def build_hook_matchers(
    engine: PolicyEngine,
    trajectory: _TrajectoryWriter | None = None,
    task_id: str = "",
    progress: Any = None,
    user_id: str = "",
    repo_url: str = "",
) -> dict:
    """Build hook matchers dict for ClaudeAgentOptions.

    Returns a dict mapping HookEvent strings to lists of HookMatcher
    instances, ready to pass as ``hooks=...`` to ClaudeAgentOptions.

    ``progress`` is forwarded to both the PreToolUse hook (approval gate
    milestones) and the Stop hook (nudge/denial acks). ``user_id`` is
    written onto the approval row.
    """
    from claude_agent_sdk.types import (
        HookContext,
        HookInput,
        HookJSONOutput,
        HookMatcher,
        PostToolUseHookSpecificOutput,
        SyncHookJSONOutput,
    )

    _stuck_guard = StuckGuard()
    lifecycle = get_context(task_id)

    async def _pre(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
        allowed = False
        try:
            if lifecycle:
                await _lifecycle_tool_started(lifecycle, hook_input, tool_use_id)
            result = await pre_tool_use_hook(
                hook_input,
                tool_use_id,
                ctx,
                engine=engine,
                trajectory=trajectory,
                task_id=task_id or None,
                user_id=user_id or None,
                progress=progress,
                repo_url=repo_url or None,
            )
            if result.get("hookSpecificOutput", {}).get("permissionDecision") == "allow":
                if lifecycle:
                    await lifecycle.wait_until_open()
                allowed = True
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
        finally:
            if lifecycle and not allowed:
                lifecycle.tool_finished(tool_use_id)
        return SyncHookJSONOutput(**result)

    async def _post(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
        try:
            result = await post_tool_use_hook(
                hook_input,
                tool_use_id,
                ctx,
                trajectory=trajectory,
                progress=progress,
                stuck_guard=_stuck_guard,
            )
            return SyncHookJSONOutput(**result)
        except Exception as exc:
            log("ERROR", f"PostToolUse wrapper crashed: {type(exc).__name__}: {exc}")
            marker = "[Output redacted: hook error — fail-closed]"
            fail_closed: PostToolUseHookSpecificOutput = {
                "hookEventName": "PostToolUse",
                "updatedToolOutput": _fail_closed_output(
                    hook_input.get("tool_name"), hook_input.get("tool_response", marker), marker
                ),
            }
            return SyncHookJSONOutput(hookSpecificOutput=fail_closed)
        finally:
            if lifecycle:
                _lifecycle_tool_finished(lifecycle, hook_input, tool_use_id)

    async def _post_failure(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
        try:
            result = await post_tool_use_failure_hook(
                hook_input,
                tool_use_id,
                ctx,
                progress=progress,
                stuck_guard=_stuck_guard,
            )
            return SyncHookJSONOutput(**result)
        except Exception as exc:
            log("ERROR", f"PostToolUseFailure wrapper crashed: {type(exc).__name__}: {exc}")
            return SyncHookJSONOutput()
        finally:
            if lifecycle:
                lifecycle.tool_finished(tool_use_id)

    async def _stop(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
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
        return SyncHookJSONOutput(**result)

    # Without an explicit timeout the CLI cancels a hook callback that is still
    # waiting for an approval.
    callback_window_s = SHARED_CONSTANTS["approval_timeout_s"]["max"]
    return {
        "PreToolUse": [
            HookMatcher(
                matcher=None,
                hooks=[_pre],
                timeout=callback_window_s + CLEANUP_MARGIN_120S,
            )
        ],
        "PostToolUse": [HookMatcher(matcher=None, hooks=[_post])],
        "PostToolUseFailure": [HookMatcher(matcher=None, hooks=[_post_failure])],
        "Stop": [HookMatcher(matcher=None, hooks=[_stop])],
    }
