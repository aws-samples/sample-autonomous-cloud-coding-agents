"""Sync event governance coordinator — evaluate rules at pipeline checkpoints."""

from __future__ import annotations

import asyncio
from typing import Any

from event_governance.engine import build_policy_engine
from event_governance.evaluator import match_rules, parse_rules
from event_governance.gate import EventGateResult, gate_on_event_async
from event_governance.writer import policy_decision_metadata, write_policy_decision
from shell import log


def _run_async(coro: Any) -> Any:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    raise RuntimeError("evaluate_sync_event cannot run inside a running event loop")


def evaluate_sync_event(
    *,
    rules_raw: list[dict[str, Any]] | None,
    event_type: str,
    metadata: dict[str, Any],
    progress: Any,
    rule_pack_id: str | None = None,
    config: Any = None,
    engine: Any = None,
    task_id: str | None = None,
    user_id: str | None = None,
) -> EventGateResult | None:
    """Evaluate sync rules for one event. Returns gate result when enforce blocks."""
    rules = parse_rules(rules_raw, rule_pack_id=rule_pack_id)
    matched = match_rules(rules, event_type=event_type, metadata=metadata, evaluation="sync")
    if not matched:
        return None

    blocked: EventGateResult | None = None
    for rule in matched:
        enforce = rule.mode == "enforce"
        meta = policy_decision_metadata(
            rule=rule,
            event_type=event_type,
            metadata=metadata,
            enforce=enforce,
        )
        write_policy_decision(progress, event_type="policy_decision", metadata=meta)

        if rule.action == "require_approval" and enforce:
            resolved_task_id = task_id or (config.task_id if config else None)
            if engine is None and config is not None:
                engine = build_policy_engine(config)
            if engine is None or not resolved_task_id:
                log("WARN", f"Event rule {rule.id} enforce blocked but engine/task_id missing")
                return EventGateResult(allowed=False, reason="approval system unavailable")
            result = _run_async(
                gate_on_event_async(
                    rule=rule,
                    event_type=event_type,
                    metadata=metadata,
                    engine=engine,
                    task_id=resolved_task_id,
                    user_id=user_id or (config.user_id if config else None),
                    progress=progress,
                )
            )
            if not result.allowed:
                return result
            blocked = result
    return blocked
