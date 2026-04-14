"""Unit tests for pipeline task outcome resolution and error chaining."""

from models import AgentResult
from pipeline import _chain_prior_agent_error, _resolve_overall_task_status


class TestResolveOverallTaskStatus:
    def test_success_end_turn_with_build_ok(self):
        ar = AgentResult(status="success", error=None)
        overall, err = _resolve_overall_task_status(ar, build_ok=True, pr_url="https://pr")
        assert overall == "success"
        assert err is None

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
