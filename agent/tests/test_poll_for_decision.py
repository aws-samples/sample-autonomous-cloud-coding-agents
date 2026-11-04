"""Tests for the ``_poll_for_decision`` polling loop in hooks.py.

Covers the consecutive-failure path (S2 from PR review) — explicit
injection of N consecutive ``ClientError`` failures from
``ts.get_approval_row`` to verify the
``POLL_MAX_CONSECUTIVE_FAILS`` safety path returns TIMED_OUT with
the distinct "poll failed N consecutive times" reason. Pre-S2 only
the all-PENDING happy-path timeout was tested.
"""

import asyncio
import math
from unittest.mock import MagicMock

import hooks
from hooks import _ApprovalDeadline, _compute_effective_timeout
from policy import PolicyEngine


def _run(coro):
    return asyncio.run(coro)


class TestPollForDecisionConsecutiveFails:
    def test_n_consecutive_failures_returns_timed_out_with_reason(self, monkeypatch):
        """At ``POLL_MAX_CONSECUTIVE_FAILS`` failures we surface a
        distinct TIMED_OUT outcome whose ``reason`` documents the
        infrastructure-failure cause (§13.2). This is the primary
        S2 assertion: every poll iteration raises, the loop tallies
        the failures, and at the threshold the function returns
        without further polling.
        """
        # Tiny intervals so the loop iterates fast but doesn't immediately
        # bail via the ``sleep_for <= 0`` early return.
        monkeypatch.setattr(hooks, "POLL_FAST_INTERVAL_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_FAST_DURATION_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_SLOW_INTERVAL_S", 0.001)

        ts = MagicMock()
        # Every call raises — simulates a sustained DDB outage.
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
        """``approval_poll_degraded`` fires once at
        ``POLL_DEGRADED_FAILS`` consecutive failures and not again
        on every subsequent poll — IMPL-22 / §13.2.
        """
        # Tiny intervals so the loop iterates fast but doesn't immediately
        # bail via the ``sleep_for <= 0`` early return.
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

        # Filter to write_approval_poll_degraded calls. Should be exactly one.
        degraded_calls = [
            c for c in progress.method_calls if c[0] == "write_approval_poll_degraded"
        ]
        # progress is a MagicMock — _try_progress calls
        # ``getattr(progress, method_name)(**kwargs)``. The method-name
        # invocation lands on ``progress.write_approval_poll_degraded(...)``;
        # mock.method_calls is the right capture surface.
        assert len(degraded_calls) == 1, (
            f"Expected exactly one write_approval_poll_degraded; got {len(degraded_calls)}: "
            f"{degraded_calls}"
        )

    def test_recovery_resets_failure_counter(self, monkeypatch):
        """A successful poll between failures resets the counter so
        intermittent DDB blips don't accumulate to the timeout
        threshold. The counter monotone-increment-only behaviour
        would falsely TIMED_OUT a task that survived a brief
        outage.
        """
        # Tiny intervals so the loop iterates fast but doesn't immediately
        # bail via the ``sleep_for <= 0`` early return.
        monkeypatch.setattr(hooks, "POLL_FAST_INTERVAL_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_FAST_DURATION_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_SLOW_INTERVAL_S", 0.001)

        ts = MagicMock()
        # 5 fails, 1 success (still PENDING), then APPROVED. With
        # max-fails = 10, this should succeed via APPROVED — proving
        # the counter reset.
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
        """If the deadline fires before ``POLL_MAX_CONSECUTIVE_FAILS``
        is reached, the outcome is still TIMED_OUT but the
        ``reason`` is None — the standard timeout path, not the
        infra-failure path. Distinguishing the two is part of the
        IMPL-24 design.
        """
        # Tiny intervals so the loop iterates fast but doesn't immediately
        # bail via the ``sleep_for <= 0`` early return.
        monkeypatch.setattr(hooks, "POLL_FAST_INTERVAL_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_FAST_DURATION_S", 0.001)
        monkeypatch.setattr(hooks, "POLL_SLOW_INTERVAL_S", 0.001)

        ts = MagicMock()
        ts.get_approval_row.return_value = {"status": "PENDING"}

        progress = MagicMock()
        # An already elapsed explicit deadline returns immediately.
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
        assert outcome.get("reason") is None  # not the infra-failure path


# --- Explicit approval deadlines (no compute-lifetime deadline) ------------


def test_default_builtin_gate_has_no_automatic_deadline():
    engine = PolicyEngine(task_type="new_task", repo="owner/repo")
    decision = engine.evaluate_tool_use("Bash", {"command": "git push --force origin feature"})
    assert decision.outcome == "require_approval"
    assert decision.timeout_s == 0


def test_zero_deadline_survives_a_long_pause(monkeypatch):
    deadline = _ApprovalDeadline.from_recorded("2026-01-01T00:00:00Z", 0)
    monkeypatch.setattr("hooks.time.time", lambda: 9_999_999_999)
    monkeypatch.setattr("hooks.time.monotonic", lambda: 9_999_999_999)
    assert math.isinf(deadline.remaining_s())
    assert _compute_effective_timeout(
        decision_timeout_s=0, task_default_timeout_s=0, remaining_lifetime_s=10
    ) == (0, None, 0)


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
