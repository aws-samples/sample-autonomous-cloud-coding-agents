"""Emit unified PolicyDecisionEvent rows to TaskEventsTable."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from event_governance.evaluator import EventRule


def _correlation_id(event_type: str, rule_id: str) -> str:
    return f"{event_type}:{rule_id}:{uuid.uuid4().hex[:12]}"


def policy_decision_metadata(
    *,
    rule: EventRule,
    event_type: str,
    metadata: dict[str, Any],
    enforce: bool,
) -> dict[str, Any]:
    """Build metadata for a top-level ``policy_decision`` event."""
    trigger_milestone = metadata.get("milestone") if event_type == "agent_milestone" else None
    checkpoint = metadata.get("checkpoint")
    would_block = rule.action == "require_approval" and rule.mode == "enforce"
    decision = "require_approval" if rule.action == "require_approval" else "observe"
    if rule.action in ("notify", "cancel_task", "inject_nudge", "escalate"):
        decision = "observe"
    return {
        "decision": decision,
        "source": "event_rule",
        "enforcement_mode": "enforce" if enforce else "observe_only",
        "rule_id": rule.id,
        "rule_pack_id": rule.rule_pack_id,
        "trigger_event_type": event_type,
        "trigger_milestone": trigger_milestone,
        "checkpoint": checkpoint,
        "correlation_id": _correlation_id(event_type, rule.id),
        "matching_rule_ids": [rule.id],
        "reason": rule.reason or f"Event rule {rule.id} matched on {rule.on}",
        "severity": rule.severity,
        "timeout_s": rule.timeout_s,
        "action": rule.action,
        "would_block": would_block,
    }


def write_policy_decision(progress: Any, *, event_type: str, metadata: dict[str, Any]) -> None:
    """Write a top-level policy_decision event via ProgressWriter."""
    if progress is None:
        return
    if hasattr(progress, "write_policy_decision_event"):
        progress.write_policy_decision_event(metadata)
    else:
        progress._put_event("policy_decision", metadata)
