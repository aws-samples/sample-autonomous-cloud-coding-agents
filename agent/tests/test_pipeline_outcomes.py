"""Unit tests for pipeline task outcome resolution and error chaining."""

import pytest

from config import NEEDS_INPUT_MARKER
from hooks import _record_blocker_reason, _reset_blocker_reason_for_tests
from models import AgentResult
from pipeline import (
    _chain_prior_agent_error,
    _compute_turns_completed,
    _resolve_overall_task_status,
    _starts_with_needs_input_marker,
    _strip_needs_input_marker,
)


class TestNeedsInputMarker:
    """Clarify-before-spend (UX #4): detect + strip the hold-and-ask marker."""

    def test_detects_marker_on_first_line(self):
        text = f"{NEEDS_INPUT_MARKER}\nWhich page feels slow — the dashboard or the list?"
        assert _starts_with_needs_input_marker(text) is True

    def test_detects_marker_after_leading_blank_lines(self):
        text = f"\n\n{NEEDS_INPUT_MARKER} What target latency are you aiming for?"
        assert _starts_with_needs_input_marker(text) is True

    def test_ignores_marker_buried_mid_message(self):
        # A stray mention deep in prose is NOT a hold signal — only the first line.
        text = f"I made the change.\nBy the way {NEEDS_INPUT_MARKER} is our sentinel."
        assert _starts_with_needs_input_marker(text) is False

    def test_none_or_empty_is_not_a_hold(self):
        assert _starts_with_needs_input_marker(None) is False
        assert _starts_with_needs_input_marker("") is False
        assert _starts_with_needs_input_marker("Just a normal answer.") is False

    def test_strip_removes_leading_marker_only(self):
        text = f"{NEEDS_INPUT_MARKER}\nWhich part is slow?"
        assert _strip_needs_input_marker(text) == "Which part is slow?"
        # Idempotent-ish: no marker → unchanged (trimmed).
        assert _strip_needs_input_marker("  plain question?  ") == "plain question?"


@pytest.fixture(autouse=True)
def _reset_blocker_latch():
    """#251 carry-path latch is module-level; reset around every test so a
    detected blocker never leaks into an unrelated outcome-resolution case."""
    _reset_blocker_reason_for_tests()
    yield
    _reset_blocker_reason_for_tests()


class TestResolveOverallTaskStatus:
    def test_success_end_turn_with_build_ok(self):
        ar = AgentResult(status="success", error=None)
        overall, err = _resolve_overall_task_status(ar, build_ok=True, pr_url="https://pr")
        assert overall == "success"
        assert err is None

    def test_infra_failed_build_forces_error_even_when_gate_would_pass(self):
        # ABCA-659 #2: the build was killed by ENOSPC/OOM (build_infra_failed).
        # Even if the regression-only gate would pass (build_ok=True — e.g. the
        # pre-agent baseline was ALSO infra-killed, so "already red → not a
        # regression"), we must NOT report a false ✅ on unverified code. Forces
        # an error with a build_ok=infra marker for the platform's honest copy.
        ar = AgentResult(status="success", error=None)
        overall, err = _resolve_overall_task_status(
            ar,
            build_ok=True,
            pr_url="https://pr",
            build_infra_failed=True,
        )
        assert overall == "error"
        assert "build_ok=infra" in (err or "")

    def test_infra_failed_marker_present_when_gate_also_fails(self):
        ar = AgentResult(status="end_turn", error=None)
        overall, err = _resolve_overall_task_status(
            ar,
            build_ok=False,
            pr_url=None,
            build_infra_failed=True,
        )
        assert overall == "error"
        assert "build_ok=infra" in (err or "")

    def test_unknown_is_always_error_even_with_pr(self):
        ar = AgentResult(status="unknown", error=None)
        overall, err = _resolve_overall_task_status(
            ar,
            build_ok=True,
            pr_url="https://github.com/o/r/pull/1",
        )
        assert overall == "error"
        assert err is not None
        assert "ResultMessage" in (err or "")
        assert "unknown" in (err or "").lower()

    def test_unknown_merges_existing_agent_error(self):
        ar = AgentResult(status="unknown", error="receive_response() failed: boom")
        overall, err = _resolve_overall_task_status(ar, build_ok=True, pr_url=None)
        assert overall == "error"
        assert err is not None
        assert "receive_response() failed: boom" in err
        assert "ResultMessage" in err

    def test_error_status_without_message_gets_default(self):
        ar = AgentResult(status="error", error=None)
        overall, err = _resolve_overall_task_status(ar, build_ok=True, pr_url=None)
        assert overall == "error"
        assert err is not None
        assert "agent_status='error'" in err

    def test_error_promotes_latched_blocker_reason(self):
        # #251 carry-path: a hook-detected blocker with no SDK error message is
        # promoted into the terminal reason so the CDK classifier gives a remedy.
        _record_blocker_reason("egress_denied", "blocked host", resource="pypi.org")
        ar = AgentResult(status="error", error=None)
        overall, err = _resolve_overall_task_status(ar, build_ok=True, pr_url=None)
        assert overall == "error"
        assert err == "BLOCKED[egress_denied]: blocked host (resource: pypi.org)"

    def test_specific_agent_error_wins_over_latched_blocker(self):
        # A concrete SDK error must NOT be overwritten by the latch.
        _record_blocker_reason("egress_denied", "blocked host", resource="pypi.org")
        ar = AgentResult(status="error", error="receive_response() failed: boom")
        overall, err = _resolve_overall_task_status(ar, build_ok=True, pr_url=None)
        assert overall == "error"
        assert err == "receive_response() failed: boom"

    def test_unknown_status_promotes_latched_blocker(self):
        # An egress denial that kills outbound calls is a likely cause of a
        # missing ResultMessage (agent_status=unknown). The precise blocker
        # reason must win over the generic SDK-no-result message.
        _record_blocker_reason("egress_denied", "blocked host", resource="pypi.org")
        ar = AgentResult(status="unknown", error=None)
        overall, err = _resolve_overall_task_status(ar, build_ok=False, pr_url=None)
        assert overall == "error"
        assert err == "BLOCKED[egress_denied]: blocked host (resource: pypi.org)"

    def test_unknown_status_without_blocker_uses_sdk_message(self):
        ar = AgentResult(status="unknown", error=None)
        overall, err = _resolve_overall_task_status(ar, build_ok=False, pr_url=None)
        assert overall == "error"
        assert "ResultMessage" in (err or "")

    def test_error_status_preserves_bedrock_entitlement_message(self):
        """Runner maps ResultMessage.is_error to agent_status=error; pipeline must fail."""
        ar = AgentResult(
            status="error",
            error=(
                "The model us.anthropic.claude-sonnet-4-6 is not available "
                "on your bedrock deployment."
            ),
        )
        overall, err = _resolve_overall_task_status(ar, build_ok=True, pr_url=None)
        assert overall == "error"
        assert err is not None
        assert "not available" in err


class TestChainPriorAgentError:
    def test_no_agent_result(self):
        msg = _chain_prior_agent_error(None, ValueError("post-hook failed"))
        assert "ValueError" in msg
        assert "post-hook failed" in msg

    def test_chains_agent_error_string(self):
        ar = AgentResult(status="error", error="agent blew up")
        msg = _chain_prior_agent_error(ar, RuntimeError("ensure_pr failed"))
        assert "agent blew up" in msg
        assert "ensure_pr failed" in msg
        assert "subsequent failure" in msg

    def test_chains_status_error_without_message(self):
        ar = AgentResult(status="error", error=None)
        msg = _chain_prior_agent_error(ar, OSError("network"))
        assert "Agent reported status=error" in msg
        assert "network" in msg


class TestComputeTurnsCompleted:
    """Rev-5 DATA-1: ``turns_completed`` must clamp to ``max_turns`` only on
    ``error_max_turns``; all other statuses pass ``turns_attempted`` through."""

    def test_success_passes_turns_through_unchanged(self):
        # Agent finished cleanly in 5 SDK turns; max allowed 10. No clamp.
        assert _compute_turns_completed("success", 5, max_turns=10) == 5

    def test_end_turn_passes_turns_through_unchanged(self):
        assert _compute_turns_completed("end_turn", 3, max_turns=10) == 3

    def test_error_status_without_max_turns_does_not_clamp(self):
        # Generic error — e.g. tool failure — should NOT clamp.
        assert _compute_turns_completed("error", 7, max_turns=10) == 7

    def test_error_max_turns_clamps_when_sdk_overreports(self):
        # SDK reports max_turns + 1 on error_max_turns; clamp to the declared
        # ceiling so ``turns_completed`` reflects what actually executed.
        assert _compute_turns_completed("error_max_turns", 11, max_turns=10) == 10

    def test_error_max_turns_does_not_increase_below_the_clamp(self):
        # Defensive: if the SDK reported fewer turns than max (shouldn't
        # happen, but we don't want to invent turns).
        assert _compute_turns_completed("error_max_turns", 6, max_turns=10) == 6

    def test_error_max_turns_with_exact_max_passes_through(self):
        # Edge case: attempted == max_turns; min() is a no-op.
        assert _compute_turns_completed("error_max_turns", 10, max_turns=10) == 10

    def test_none_turns_attempted_round_trips(self):
        # Missing SDK count must round-trip as None so writers can detect
        # "no turn counter available" vs "zero turns".
        assert _compute_turns_completed("success", None, max_turns=10) is None
        assert _compute_turns_completed("error_max_turns", None, max_turns=10) is None

    def test_zero_turns_attempted_round_trips(self):
        # Zero is treated the same as None (falsy) so we don't clamp it to a
        # negative / nonsensical value.
        assert _compute_turns_completed("error_max_turns", 0, max_turns=10) == 0


class TestMaxTurnsStuckEnrichment:
    """N3 wiring seam (#600): _resolve_overall_task_status enriches a max_turns
    reason with the stuck-guard summary (hooks.last_stuck_summary). Previously
    tested only at its two pure endpoints; this drives the append itself."""

    def test_max_turns_appends_stuck_summary(self, monkeypatch):
        import hooks

        summary = "last tool calls repeated: git push — invalid credentials"
        monkeypatch.setattr(hooks, "last_stuck_summary", lambda: summary)
        ar = AgentResult(
            status="error_max_turns",
            error="Agent session error (subtype=error_max_turns)",
        )
        _, err = _resolve_overall_task_status(ar, build_ok=False, pr_url=None)
        assert err is not None
        assert "error_max_turns" in err
        assert summary in err

    def test_non_max_turns_error_is_not_enriched(self, monkeypatch):
        # A generic failure must NOT pull in the stuck summary — only max_turns.
        import hooks

        monkeypatch.setattr(hooks, "last_stuck_summary", lambda: "last tool calls repeated: X")
        ar = AgentResult(status="error", error="receive_response() failed: boom")
        _, err = _resolve_overall_task_status(ar, build_ok=False, pr_url=None)
        assert err is not None
        assert "last tool calls repeated" not in err

    def test_max_turns_with_no_stuck_summary_left_unchanged(self, monkeypatch):
        # A task that used its turns productively (window not failure-dominated →
        # summary None) leaves the max_turns reason unchanged.
        import hooks

        monkeypatch.setattr(hooks, "last_stuck_summary", lambda: None)
        ar = AgentResult(
            status="error_max_turns",
            error="Agent session error (subtype=error_max_turns)",
        )
        _, err = _resolve_overall_task_status(ar, build_ok=False, pr_url=None)
        assert err == "Agent session error (subtype=error_max_turns)"

    def test_stuck_summary_not_double_appended(self, monkeypatch):
        # Idempotent: if the summary is already in the reason (e.g. a durable
        # re-resolution of the same result), it must not be appended twice.
        import hooks

        summary = "last tool calls repeated: git push — invalid credentials"
        monkeypatch.setattr(hooks, "last_stuck_summary", lambda: summary)
        ar = AgentResult(
            status="error_max_turns",
            error=f"Agent session error (subtype=error_max_turns) — {summary}",
        )
        _, err = _resolve_overall_task_status(ar, build_ok=False, pr_url=None)
        assert err is not None
        assert err.count(summary) == 1
