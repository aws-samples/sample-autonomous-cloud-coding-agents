"""Tests for event governance sync gate (issue #230 Phase 2)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

from event_governance.coordinator import evaluate_sync_event
from event_governance.gate import EventGateResult


def test_observe_only_writes_policy_decision_without_blocking() -> None:
    progress = MagicMock()
    rules = [
        {
            "id": "observe-plan",
            "on": "checkpoint:before_execution",
            "action": "require_approval",
            "mode": "observe_only",
            "evaluation": "sync",
            "reason": "dry run",
        },
    ]
    meta = {
        "checkpoint": "checkpoint:before_execution",
        "milestone": "checkpoint:before_execution",
    }
    result = evaluate_sync_event(
        rules_raw=rules,
        event_type="agent_milestone",
        metadata=meta,
        progress=progress,
    )
    assert result is None
    progress.write_policy_decision_event.assert_called_once()


def test_enforce_blocks_when_gate_denies() -> None:
    progress = MagicMock()
    rules = [
        {
            "id": "enforce-plan",
            "on": "checkpoint:before_execution",
            "action": "require_approval",
            "mode": "enforce",
            "evaluation": "sync",
            "reason": "blocked",
        },
    ]
    with patch(
        "event_governance.coordinator.gate_on_event_async",
        new_callable=AsyncMock,
        return_value=EventGateResult(allowed=False, reason="denied"),
    ):
        result = evaluate_sync_event(
            rules_raw=rules,
            event_type="agent_milestone",
            metadata={"checkpoint": "checkpoint:before_execution"},
            progress=progress,
            config=MagicMock(task_id="t1", user_id="u1"),
            task_id="t1",
            user_id="u1",
        )
    assert result is not None
    assert result.allowed is False
