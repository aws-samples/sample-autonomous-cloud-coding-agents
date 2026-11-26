import pytest

from config import NEEDS_INPUT_MARKER
from hooks import _record_blocker_reason
from models import AgentResult
from pipeline import (
    _apply_delivery_gate,
    _chain_prior_agent_error,
    _compute_turns_completed,
    _resolve_overall_task_status,
    _starts_with_needs_input_marker,
    _strip_needs_input_marker,
)


class TestNeedsInputMarker:
    def test_detects_marker_on_first_line(self):
        text = f"{NEEDS_INPUT_MARKER}\nWhich page feels slow — the dashboard or the list?"
        assert _starts_with_needs_input_marker(text) is True

    def test_detects_marker_after_leading_blank_lines(self):
        text = f"\n\n{NEEDS_INPUT_MARKER} What target latency are you aiming for?"
        assert _starts_with_needs_input_marker(text) is True

    def test_ignores_marker_buried_mid_message(self):
        text = f"I made the change.\nBy the way {NEEDS_INPUT_MARKER} is our sentinel."
        assert _starts_with_needs_input_marker(text) is False

    def test_none_or_empty_is_not_a_hold(self):
        assert _starts_with_needs_input_marker(None) is False
        assert _starts_with_needs_input_marker("") is False
        assert _starts_with_needs_input_marker("Just a normal answer.") is False

    def test_strip_removes_leading_marker_only(self):
        text = f"{NEEDS_INPUT_MARKER}\nWhich part is slow?"
        assert _strip_needs_input_marker(text) == "Which part is slow?"
        assert _strip_needs_input_marker("  plain question?  ") == "plain question?"


class TestResolveOverallTaskStatus:
    def test_success_with_build_ok(self):
        ar = AgentResult(status="success")
        status, err = _resolve_overall_task_status(ar, build_ok=True, pr_url="https://pr")
        assert status == "success"
        assert err is None

    def test_end_turn_with_build_ok(self):
        ar = AgentResult(status="end_turn")
        status, err = _resolve_overall_task_status(ar, build_ok=True, pr_url=None)
        assert status == "success"
        assert err is None

    def test_success_preserves_existing_error(self):
        ar = AgentResult(status="success", error="non-fatal warning")
        status, err = _resolve_overall_task_status(ar, build_ok=True, pr_url=None)
        assert status == "success"
        assert err == "non-fatal warning"

    def test_success_with_build_failed(self):
        ar = AgentResult(status="success")
        status, err = _resolve_overall_task_status(ar, build_ok=False, pr_url="https://pr")
        assert status == "error"
        assert err is not None
        assert "agent_status='success'" in err
        assert "build_ok=False" in err

    def test_success_with_build_TIMED_OUT_marks_timeout_distinctly(self):
        ar = AgentResult(status="success")
        status, err = _resolve_overall_task_status(
            ar, build_ok=False, pr_url="https://pr", build_timed_out=True
        )
        assert status == "error"
        assert err is not None
        assert "build_ok=timeout" in err
        assert "build_ok=False" not in err

    def test_build_failed_but_not_timeout_keeps_false_marker(self):
        ar = AgentResult(status="success")
        _, err = _resolve_overall_task_status(
            ar, build_ok=False, pr_url="https://pr", build_timed_out=False
        )
        assert err is not None
        assert "build_ok=False" in err
        assert "timeout" not in err

    def test_infra_failed_build_forces_error_even_when_gate_would_pass(self):
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

    @pytest.mark.parametrize("build_ok", [True, False])
    def test_unknown_merges_existing_agent_error(self, build_ok):
        ar = AgentResult(status="unknown", error="receive_response() failed: boom")
        overall, err = _resolve_overall_task_status(ar, build_ok=build_ok, pr_url=None)
        assert overall == "error"
        assert err is not None
        assert "receive_response() failed: boom" in err
        assert "ResultMessage" in err

    @pytest.mark.parametrize("build_ok", [True, False])
    def test_error_status_without_message_gets_default(self, build_ok):
        ar = AgentResult(status="error", error=None)
        overall, err = _resolve_overall_task_status(ar, build_ok=build_ok, pr_url=None)
        assert overall == "error"
        assert err is not None
        assert "agent_status='error'" in err

    def test_error_status_preserves_agent_error(self):
        ar = AgentResult(status="error", error="OOM killed")
        status, err = _resolve_overall_task_status(ar, build_ok=False, pr_url=None)
        assert status == "error"
        assert err == "OOM killed"

    def test_error_promotes_latched_blocker_reason(self):
        _record_blocker_reason("egress_denied", "blocked host", resource="pypi.org")
        ar = AgentResult(status="error", error=None)
        overall, err = _resolve_overall_task_status(ar, build_ok=True, pr_url=None)
        assert overall == "error"
        assert err == "BLOCKED[egress_denied]: blocked host (resource: pypi.org)"

    def test_specific_agent_error_wins_over_latched_blocker(self):
        _record_blocker_reason("egress_denied", "blocked host", resource="pypi.org")
        ar = AgentResult(status="error", error="receive_response() failed: boom")
        overall, err = _resolve_overall_task_status(ar, build_ok=True, pr_url=None)
        assert overall == "error"
        assert err == "receive_response() failed: boom"

    def test_unknown_status_promotes_latched_blocker(self):
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


class TestDeliveryGate:
    @staticmethod
    def _gate(
        overall_status: str = "success",
        result_error: str | None = None,
        *,
        workflow_read_only: bool = False,
        artifact_workflow: bool = False,
        needs_input: bool = False,
        ensure_pr_strategy: str = "create",
        pr_url: str | None = None,
        commit_landed: bool = False,
    ) -> tuple[str, str | None]:
        return _apply_delivery_gate(
            overall_status,
            result_error,
            workflow_read_only=workflow_read_only,
            artifact_workflow=artifact_workflow,
            needs_input=needs_input,
            ensure_pr_strategy=ensure_pr_strategy,
            pr_url=pr_url,
            commit_landed=commit_landed,
        )

    def test_success_no_pr_no_commit_becomes_lost(self):
        overall, err = self._gate()
        assert overall == "error"
        assert err is not None
        assert "deliverable=lost" in err

    def test_success_no_pr_but_commit_landed_is_no_pr(self):
        overall, err = self._gate(commit_landed=True)
        assert overall == "error"
        assert err is not None
        assert "deliverable=no_pr" in err

    def test_success_with_pr_is_untouched(self):
        overall, err = self._gate(pr_url="https://github.com/o/r/pull/1")
        assert overall == "success"
        assert err is None

    def test_read_only_success_no_pr_stays_success(self):
        overall, err = self._gate(workflow_read_only=True)
        assert overall == "success"
        assert err is None

    def test_artifact_workflow_success_no_pr_stays_success(self):
        overall, err = self._gate(artifact_workflow=True)
        assert overall == "success"
        assert err is None

    def test_needs_input_success_no_pr_stays_success(self):
        overall, err = self._gate(needs_input=True)
        assert overall == "success"
        assert err is None

    def test_non_create_strategy_success_no_pr_stays_success(self):
        overall, err = self._gate(ensure_pr_strategy="push_resolve")
        assert overall == "success"
        assert err is None

    def test_already_error_is_left_error(self):
        overall, err = self._gate(overall_status="error", result_error="build failed")
        assert overall == "error"
        assert err == "build failed"

    def test_lost_reason_matches_classifier_pattern(self):
        _, err = self._gate()
        assert err is not None
        assert "agent_status=success" in err
        assert "deliverable=lost" in err

    def test_lost_reason_names_both_lost_work_and_a_run_that_changed_nothing(self):
        _, err = self._gate()
        assert err is not None
        assert "the agent made no change" in err
        assert "its changes did not land" in err


class TestChainPriorAgentError:
    def test_none_agent_result_returns_exception_only(self):
        exc = RuntimeError("post-hook crash")
        assert _chain_prior_agent_error(None, exc) == "RuntimeError: post-hook crash"

    def test_agent_with_error_chains_both(self):
        ar = AgentResult(status="error", error="SDK timeout")
        exc = ValueError("PR creation failed")
        result = _chain_prior_agent_error(ar, exc)
        assert result == "SDK timeout; subsequent failure: ValueError: PR creation failed"

    def test_agent_error_status_without_error_message(self):
        ar = AgentResult(status="error")
        exc = OSError("disk full")
        result = _chain_prior_agent_error(ar, exc)
        assert result == "Agent reported status=error; subsequent failure: OSError: disk full"

    def test_agent_success_returns_exception_only(self):
        ar = AgentResult(status="success")
        exc = RuntimeError("unexpected")
        assert _chain_prior_agent_error(ar, exc) == "RuntimeError: unexpected"

    def test_agent_unknown_no_error_returns_exception_only(self):
        ar = AgentResult(status="unknown")
        exc = TypeError("bad arg")
        assert _chain_prior_agent_error(ar, exc) == "TypeError: bad arg"


class TestComputeTurnsCompleted:
    @pytest.mark.parametrize("turns", [3, 5, 6, 7])
    def test_turns_below_the_cap_pass_through_unchanged(self, turns):
        assert _compute_turns_completed(turns, max_turns=10) == turns

    def test_count_above_the_cap_is_clamped(self):
        assert _compute_turns_completed(11, max_turns=10) == 10

    def test_exact_max_passes_through(self):
        assert _compute_turns_completed(10, max_turns=10) == 10

    def test_limit_of_zero_is_no_cap(self):
        # The SDK hands --max-turns to the CLI only for a truthy value, so a run
        # with max_turns 0 has no turn limit.
        assert _compute_turns_completed(37, max_turns=0) == 37

    def test_missing_count_round_trips(self):
        assert _compute_turns_completed(None, max_turns=10) is None

    def test_zero_count_round_trips(self):
        assert _compute_turns_completed(0, max_turns=10) == 0


class TestMaxTurnsStuckEnrichment:
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
        import hooks

        monkeypatch.setattr(hooks, "last_stuck_summary", lambda: "last tool calls repeated: X")
        ar = AgentResult(status="error", error="receive_response() failed: boom")
        _, err = _resolve_overall_task_status(ar, build_ok=False, pr_url=None)
        assert err is not None
        assert "last tool calls repeated" not in err

    def test_max_turns_with_no_stuck_summary_left_unchanged(self, monkeypatch):
        import hooks

        monkeypatch.setattr(hooks, "last_stuck_summary", lambda: None)
        ar = AgentResult(
            status="error_max_turns",
            error="Agent session error (subtype=error_max_turns)",
        )
        _, err = _resolve_overall_task_status(ar, build_ok=False, pr_url=None)
        assert err == "Agent session error (subtype=error_max_turns)"

    def test_stuck_summary_not_double_appended(self, monkeypatch):
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
