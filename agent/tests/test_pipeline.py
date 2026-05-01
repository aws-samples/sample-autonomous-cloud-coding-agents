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

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None):
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

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None):
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


class TestCancelSkipsPostHooks:
    """Cancel short-circuit: if task is CANCELLED when run_agent returns, the
    pipeline must skip post-hooks so no PR is pushed on a cancelled task.
    """

    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_cancelled_task_skips_post_hooks(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None):
            return AgentResult(status="success", turns=2, cost_usd=0.01, num_turns=2)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        # Simulate cancel-task.ts having already flipped the status.
        mock_get_task = MagicMock(return_value={"status": "CANCELLED"})

        mock_ensure_pr = MagicMock()
        mock_ensure_committed = MagicMock()

        with (
            patch("pipeline.ensure_committed", mock_ensure_committed),
            patch("pipeline.verify_build"),
            patch("pipeline.verify_lint"),
            patch("pipeline.ensure_pr", mock_ensure_pr),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline.task_state") as mock_task_state_mod,
        ):
            # Route get_task through the mock; keep TaskFetchError importable.
            mock_task_state_mod.get_task = mock_get_task
            mock_task_state_mod.TaskFetchError = Exception  # type: ignore[attr-defined]

            from pipeline import run_task

            result = run_task(
                repo_url="o/r",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-cancelled",
            )

        # CRITICAL: no PR push, no commit safety-net on cancelled task.
        mock_ensure_pr.assert_not_called()
        mock_ensure_committed.assert_not_called()
        assert result["status"] == "cancelled"
        assert result["task_id"] == "t-cancelled"

    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_running_task_runs_post_hooks_normally(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        """Regression guard: a task that is NOT cancelled still runs post-hooks."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None):
            return AgentResult(status="success", turns=2, cost_usd=0.01, num_turns=2)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        mock_ensure_pr = MagicMock(return_value="https://github.com/o/r/pull/1")

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=True),
            patch("pipeline.verify_lint", return_value=True),
            patch("pipeline.ensure_pr", mock_ensure_pr),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline.task_state") as mock_task_state_mod,
        ):
            # Task is RUNNING (not cancelled) — normal path must execute.
            mock_task_state_mod.get_task = MagicMock(return_value={"status": "RUNNING"})
            mock_task_state_mod.TaskFetchError = Exception  # type: ignore[attr-defined]

            from pipeline import run_task

            run_task(
                repo_url="o/r",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-running",
            )

        mock_ensure_pr.assert_called_once()


# ---------------------------------------------------------------------------
# Chunk K1 — trace threading into TaskConfig (design §10.1)
# ---------------------------------------------------------------------------


class TestTraceThreading:
    """run_task(trace=...) must land on ``TaskConfig.trace`` so the
    runner.py _ProgressWriter picks it up. This is the exact junction a
    reviewer caught as silently dropping the flag in review; lock it
    with a dedicated test.
    """

    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_run_task_trace_true_sets_config_trace_true(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        captured_config: TaskConfig | None = None

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None):
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
                task_description="deep debug",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-trace",
                trace=True,
            )

        assert captured_config is not None
        # The config reaching run_agent carries trace=True so runner.py's
        # _ProgressWriter(config.task_id, trace=config.trace) picks it up.
        assert captured_config.trace is True

    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_run_task_trace_default_is_false(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        captured_config: TaskConfig | None = None

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None):
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
                task_description="normal task",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-notrace",
            )

        assert captured_config is not None
        assert captured_config.trace is False
