"""Unit tests for pipeline.py — cedar_policies injection and pure helpers."""

from unittest.mock import MagicMock, patch

from models import AgentResult, RepoSetup, TaskConfig
from pipeline import _chain_prior_agent_error, _resolve_overall_task_status


class TestCedarPoliciesInjection:
    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_cedar_policies_injected_into_config(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        """When cedar_policies are passed, they appear in the config."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        captured_config: TaskConfig | None = None

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, sse_adapter=None):
            nonlocal captured_config
            captured_config = config
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=True),
            patch("pipeline.verify_lint", return_value=True),
            patch(
                "pipeline.ensure_pr",
                return_value="https://github.com/org/repo/pull/1",
            ),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            policies = [
                'forbid (principal, action, resource) when { resource == Agent::Tool::"Bash" };'
            ]
            run_task(
                repo_url="owner/repo",
                task_description="fix bug",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="test-id",
                cedar_policies=policies,
            )

        assert captured_config is not None
        assert captured_config.cedar_policies == policies

    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_cedar_policies_absent_when_not_passed(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        """When cedar_policies are not passed, the default empty list is on config."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        captured_config: TaskConfig | None = None

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, sse_adapter=None):
            nonlocal captured_config
            captured_config = config
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=True),
            patch("pipeline.verify_lint", return_value=True),
            patch(
                "pipeline.ensure_pr",
                return_value="https://github.com/org/repo/pull/1",
            ),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            run_task(
                repo_url="owner/repo",
                task_description="fix bug",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="test-id",
            )

        assert captured_config is not None
        assert captured_config.cedar_policies == []


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

    def test_success_with_build_failed(self):
        ar = AgentResult(status="success")
        status, err = _resolve_overall_task_status(ar, build_ok=False, pr_url="https://pr")
        assert status == "error"
        assert err is not None
        assert "agent_status='success'" in err
        assert "build_ok=False" in err

    def test_unknown_always_error_even_with_pr_and_build(self):
        """agent_status=unknown must always fail — never infer success from PR/build."""
        ar = AgentResult(status="unknown")
        status, err = _resolve_overall_task_status(ar, build_ok=True, pr_url="https://pr")
        assert status == "error"
        assert err is not None
        assert "ResultMessage" in err

    def test_unknown_with_prior_error_chains(self):
        ar = AgentResult(status="unknown", error="connection reset")
        status, err = _resolve_overall_task_status(ar, build_ok=False, pr_url=None)
        assert status == "error"
        assert err is not None
        assert "connection reset" in err
        assert "ResultMessage" in err

    def test_error_status_preserves_agent_error(self):
        ar = AgentResult(status="error", error="OOM killed")
        status, err = _resolve_overall_task_status(ar, build_ok=False, pr_url=None)
        assert status == "error"
        assert err == "OOM killed"

    def test_error_status_without_agent_error_generates_message(self):
        ar = AgentResult(status="error")
        status, err = _resolve_overall_task_status(ar, build_ok=False, pr_url=None)
        assert status == "error"
        assert err is not None
        assert "agent_status='error'" in err

    def test_unknown_no_pr_no_build(self):
        ar = AgentResult(status="unknown")
        status, err = _resolve_overall_task_status(ar, build_ok=False, pr_url=None)
        assert status == "error"
        assert err is not None
        assert "ResultMessage" in err

    def test_success_preserves_existing_error(self):
        """If agent reports success with a non-fatal error, it's preserved on success."""
        ar = AgentResult(status="success", error="non-fatal warning")
        status, err = _resolve_overall_task_status(ar, build_ok=True, pr_url=None)
        assert status == "success"
        assert err == "non-fatal warning"


class TestSSEAdapterIntegration:
    """Phase 1b: run_task accepts sse_adapter kwarg and mirrors milestone writes."""

    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_run_task_accepts_none_sse_adapter(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        """Default None keeps existing behaviour; run_agent gets sse_adapter=None."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        captured_kwargs: dict = {}

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, sse_adapter=None):
            captured_kwargs["sse_adapter"] = sse_adapter
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=True),
            patch("pipeline.verify_lint", return_value=True),
            patch("pipeline.ensure_pr", return_value="https://github.com/o/r/pull/1"),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            run_task(
                repo_url="o/r",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-none",
            )

        assert captured_kwargs["sse_adapter"] is None

    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_run_task_mirrors_milestones_and_closes_adapter(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        """When sse_adapter is provided, the 3 milestones are mirrored and close is called."""
        from sse_adapter import _SSEAdapter

        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, sse_adapter=None):
            assert sse_adapter is not None
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        adapter = _SSEAdapter("t-mirror")
        milestones: list[str] = []
        original_ms = adapter.write_agent_milestone

        def _spy(ms, details=""):
            milestones.append(ms)
            return original_ms(ms, details)

        monkeypatch.setattr(adapter, "write_agent_milestone", _spy)

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=True),
            patch("pipeline.verify_lint", return_value=True),
            patch("pipeline.ensure_pr", return_value="https://github.com/o/r/pull/1"),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            run_task(
                repo_url="o/r",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-mirror",
                sse_adapter=adapter,
            )

        assert "repo_setup_complete" in milestones
        assert "agent_execution_complete" in milestones
        assert "pr_created" in milestones
        # close() marks the adapter closed
        assert adapter._closed is True


class TestRunnerSSEAdapterKwarg:
    """Verify runner.run_agent accepts sse_adapter kwarg (smoke test)."""

    def test_runner_signature_accepts_sse_adapter(self):
        import inspect

        from runner import run_agent

        sig = inspect.signature(run_agent)
        assert "sse_adapter" in sig.parameters
        assert sig.parameters["sse_adapter"].default is None
