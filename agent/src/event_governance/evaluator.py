"""Declarative event rule matching (sync + async parity with CDK evaluator)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class EventRule:
    """One event governance rule from blueprint or registry pack."""

    id: str
    on: str
    action: str
    mode: str
    evaluation: str
    when: dict[str, Any] = field(default_factory=dict)
    reason: str = ""
    severity: str = "medium"
    timeout_s: int | None = None
    notify_channels: list[str] = field(default_factory=list)
    rule_pack_id: str | None = None


def _event_name(event_type: str, metadata: dict[str, Any]) -> str:
    """Resolve the rule ``on`` key for an incoming event."""
    if event_type == "agent_milestone":
        milestone = metadata.get("milestone")
        if isinstance(milestone, str):
            return milestone
    checkpoint = metadata.get("checkpoint")
    if isinstance(checkpoint, str):
        return checkpoint
    return event_type


def _fields_match(rule_when: dict[str, Any], metadata: dict[str, Any]) -> bool:
    expected = rule_when.get("fields")
    if not expected:
        return True
    if not isinstance(expected, dict):
        return False
    for key, want in expected.items():
        got = metadata.get(key)
        if got != want:
            return False
    return True


def _aggregate_match(
    rule_when: dict[str, Any],
    metadata: dict[str, Any],
    aggregate_state: dict[str, Any] | None,
) -> bool:
    agg = rule_when.get("aggregate")
    if not agg:
        return True
    if not isinstance(agg, dict):
        return False
    cost_gte = agg.get("cost_usd_gte")
    if cost_gte is not None:
        cumulative = aggregate_state.get("cumulative_cost_usd") if aggregate_state else None
        if cumulative is None:
            cumulative = metadata.get("cumulative_cost_usd")
        if cumulative is None:
            return False
        try:
            if float(cumulative) < float(cost_gte):
                return False
        except (TypeError, ValueError):
            return False
    turn_gte = agg.get("turn_count_gte")
    if turn_gte is not None:
        turns = aggregate_state.get("turn_count") if aggregate_state else None
        if turns is None:
            turns = metadata.get("turn_count")
        if turns is None:
            return False
        try:
            if float(turns) < float(turn_gte):
                return False
        except (TypeError, ValueError):
            return False
    return True


def match_rules(
    rules: list[EventRule],
    *,
    event_type: str,
    metadata: dict[str, Any],
    evaluation: str | None = None,
    aggregate_state: dict[str, Any] | None = None,
) -> list[EventRule]:
    """Return rules that match the given event."""
    name = _event_name(event_type, metadata)
    matched: list[EventRule] = []
    for rule in rules:
        if rule.on != name:
            continue
        if evaluation is not None and rule.evaluation != evaluation:
            continue
        when = rule.when or {}
        if not _fields_match(when, metadata):
            continue
        if not _aggregate_match(when, metadata, aggregate_state):
            continue
        matched.append(rule)
    return matched


def parse_rules(
    raw: list[dict[str, Any]] | None,
    *,
    rule_pack_id: str | None = None,
) -> list[EventRule]:
    """Parse blueprint/registry rule dicts into ``EventRule`` instances."""
    if not raw:
        return []
    out: list[EventRule] = []
    for item in raw:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        out.append(
            EventRule(
                id=str(item["id"]),
                on=str(item["on"]),
                action=str(item.get("action", "observe_only")),
                mode=str(item.get("mode", "observe_only")),
                evaluation=str(item.get("evaluation", "sync")),
                when=dict(item.get("when") or {}),
                reason=str(item.get("reason") or ""),
                severity=str(item.get("severity") or "medium"),
                timeout_s=item.get("timeout_s"),
                notify_channels=list(item.get("notify_channels") or []),
                rule_pack_id=rule_pack_id or item.get("rule_pack_id"),
            )
        )
    return out
