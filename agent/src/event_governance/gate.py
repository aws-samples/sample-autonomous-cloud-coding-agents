"""Event-sourced approval gates (Phase 2 enforce mode)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from event_governance.evaluator import EventRule

from hooks import _handle_require_approval
from policy import PolicyDecision


@dataclass
class EventGateResult:
    """Outcome of a sync event gate."""

    allowed: bool
    reason: str = ""


async def gate_on_event_async(
    *,
    rule: EventRule,
    event_type: str,
    metadata: dict[str, Any],
    engine: Any,
    task_id: str | None,
    user_id: str | None,
    progress: Any,
    ts_module: Any = None,
) -> EventGateResult:
    """Block on human approval for an event rule (enforce + require_approval)."""
    checkpoint = metadata.get("checkpoint") or rule.on
    tool_input = {"checkpoint": checkpoint, "event_type": event_type, **metadata}
    decision = PolicyDecision.require_approval(
        reason=rule.reason or f"Approval required at {checkpoint}",
        severity=rule.severity,
        timeout_s=rule.timeout_s or engine.task_default_timeout_s,
        matching_rule_ids=(rule.id,),
    )
    tool_name = f"event:{checkpoint}"
    response = await _handle_require_approval(
        decision=decision,
        tool_name=tool_name,
        tool_input=tool_input,
        engine=engine,
        task_id=task_id,
        user_id=user_id,
        progress=progress,
        ts=ts_module,
        approval_source="event",
        event_type=event_type,
        event_checkpoint=str(checkpoint),
        rule_id=rule.id,
    )
    allowed = response.get("hookSpecificOutput", {}).get("permissionDecision") == "allow"
    reason = response.get("hookSpecificOutput", {}).get("permissionDecisionReason", "")
    return EventGateResult(allowed=allowed, reason=reason or "")
