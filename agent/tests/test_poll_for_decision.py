import asyncio
from unittest.mock import MagicMock

import hooks
from policy import PolicyEngine


def _run(coro):
    return asyncio.run(coro)


class TestPollForDecisionConsecutiveFails:
    def test_n_consecutive_failures_returns_timed_out_with_reason(self, monkeypatch):
        monkeypatch.setattr(hooks, "POLL_FAST_INTERVAL_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_FAST_DURATION_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_SLOW_INTERVAL_S", 0.001)

        ts = MagicMock()
        ts.get_approval_row.side_effect = RuntimeError("ddb unavailable")

        progress = MagicMock()
        outcome = _run(
            hooks._poll_for_decision(
                task_id="01KTASK",
                request_id="01KREQ",
                deadline=hooks._ApprovalDeadline.from_recorded(hooks._iso_now(), 300),
                progress=progress,
                ts=ts,
            )
        )

        assert outcome["status"] == "TIMED_OUT"
        assert "consecutive" in outcome["reason"].lower()
        assert ts.get_approval_row.call_count == hooks.POLL_MAX_CONSECUTIVE_FAILS

    def test_degraded_emitted_once_at_threshold(self, monkeypatch):
        monkeypatch.setattr(hooks, "POLL_FAST_INTERVAL_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_FAST_DURATION_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_SLOW_INTERVAL_S", 0.001)

        ts = MagicMock()
        ts.get_approval_row.side_effect = RuntimeError("ddb unavailable")

        progress = MagicMock()
        _run(
            hooks._poll_for_decision(
                task_id="01KTASK",
                request_id="01KREQ",
                deadline=hooks._ApprovalDeadline.from_recorded(hooks._iso_now(), 300),
                progress=progress,
                ts=ts,
            )
        )

        degraded_calls = [
            c for c in progress.method_calls if c[0] == "write_approval_poll_degraded"
        ]
        assert len(degraded_calls) == 1, (
            f"Expected exactly one write_approval_poll_degraded; got {len(degraded_calls)}: "
            f"{degraded_calls}"
        )

    def test_recovery_resets_failure_counter(self, monkeypatch):
        monkeypatch.setattr(hooks, "POLL_FAST_INTERVAL_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_FAST_DURATION_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_SLOW_INTERVAL_S", 0.001)

        ts = MagicMock()
        side_effects = [
            RuntimeError("transient 1"),
            RuntimeError("transient 2"),
            RuntimeError("transient 3"),
            RuntimeError("transient 4"),
            RuntimeError("transient 5"),
            {"status": "PENDING"},
            {"status": "APPROVED", "scope": "this_call", "decided_at": "t1", "user_id": "u1"},
        ]
        ts.get_approval_row.side_effect = side_effects

        progress = MagicMock()
        outcome = _run(
            hooks._poll_for_decision(
                task_id="01KTASK",
                request_id="01KREQ",
                deadline=hooks._ApprovalDeadline.from_recorded(hooks._iso_now(), 300),
                progress=progress,
                ts=ts,
            )
        )

        assert outcome["status"] == "APPROVED"
        assert outcome["scope"] == "this_call"

    def test_deadline_beats_failures_when_timeout_short(self, monkeypatch):
        monkeypatch.setattr(hooks, "POLL_FAST_INTERVAL_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_FAST_DURATION_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_SLOW_INTERVAL_S", 0.001)

        ts = MagicMock()
        ts.get_approval_row.return_value = {"status": "PENDING"}

        progress = MagicMock()
        outcome = _run(
            hooks._poll_for_decision(
                task_id="01KTASK",
                request_id="01KREQ",
                deadline=hooks._ApprovalDeadline(0, 0),
                progress=progress,
                ts=ts,
            )
        )

        assert outcome["status"] == "TIMED_OUT"
        assert outcome.get("reason") is None


def test_explicit_rule_deadline_survives_a_no_deadline_task_default():
    engine = PolicyEngine(
        task_type="new_task",
        repo="owner/repo",
        blueprint_soft_policies=(
            '@tier("soft") @rule_id("explicit") @approval_timeout_s("120") '
            'forbid (principal, action == Agent::Action::"execute_bash", resource) '
            'when { context.command like "*explicit-tool*" };'
        ),
    )
    decision = engine.evaluate_tool_use("Bash", {"command": "explicit-tool"})
    assert decision.timeout_s == 120
