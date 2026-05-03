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

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
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

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
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

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
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

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
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

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
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

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
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


class TestTraceS3Upload:
    """K2 Stage 4 — pipeline triggers the S3 trace upload only when
    ``trace=True`` AND ``user_id`` is non-empty; threads the resulting
    ``trace_s3_uri`` into ``task_state.write_terminal`` so the
    TaskRecord update is atomic with terminal-status."""

    @patch("pipeline.upload_trace_to_s3")
    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_upload_happens_when_trace_and_user_id(
        self,
        mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            # Simulate the runner accumulating one event so dump returns bytes.
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_upload.return_value = "s3://b/traces/u-1/t-up.jsonl.gz"

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=True),
            patch("pipeline.verify_lint", return_value=True),
            patch("pipeline.ensure_pr", return_value=None),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            result = run_task(
                repo_url="owner/repo",
                task_description="debug it",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-up",
                trace=True,
                user_id="u-1",
            )

        # Upload was called with the expected identifiers.
        assert mock_upload.called
        call_kwargs = mock_upload.call_args.kwargs
        assert call_kwargs["task_id"] == "t-up"
        assert call_kwargs["user_id"] == "u-1"
        assert isinstance(call_kwargs["body"], bytes)

        # trace_s3_uri was threaded into the terminal write.
        assert result["trace_s3_uri"] == "s3://b/traces/u-1/t-up.jsonl.gz"
        mock_task_state.write_terminal.assert_called()
        terminal_result = mock_task_state.write_terminal.call_args.args[2]
        assert terminal_result["trace_s3_uri"] == "s3://b/traces/u-1/t-up.jsonl.gz"

    @patch("pipeline.upload_trace_to_s3")
    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_upload_skipped_when_trace_false(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
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
            patch("pipeline.ensure_pr", return_value=None),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            result = run_task(
                repo_url="owner/repo",
                task_description="normal",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-nt",
                trace=False,
                user_id="u-1",
            )

        assert not mock_upload.called
        assert result["trace_s3_uri"] is None

    @patch("pipeline.upload_trace_to_s3")
    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_upload_skipped_when_user_id_empty_and_trace_true(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        """K2 Stage 3 review Finding #1 — empty user_id with trace=True
        must skip the upload to avoid writing an unreachable
        ``traces//<task_id>.jsonl.gz`` artifact."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
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
            patch("pipeline.ensure_pr", return_value=None),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            result = run_task(
                repo_url="owner/repo",
                task_description="trace without user",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-no-uid",
                trace=True,
                user_id="",  # empty — must gate upload
            )

        assert not mock_upload.called
        assert result["trace_s3_uri"] is None

    @patch("pipeline.upload_trace_to_s3")
    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_upload_fail_open_does_not_fail_task(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        """A failed S3 upload (fail-open returns None) must NOT flip
        the task to FAILED — the trajectory is a debug artifact."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_upload.return_value = None  # simulate S3 failure

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=True),
            patch("pipeline.verify_lint", return_value=True),
            patch("pipeline.ensure_pr", return_value=None),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            result = run_task(
                repo_url="owner/repo",
                task_description="trace fail",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-fail",
                trace=True,
                user_id="u-1",
            )

        assert mock_upload.called
        # Fail-open: task is still success, trace_s3_uri just absent.
        assert result["status"] == "success"
        assert result["trace_s3_uri"] is None

    @patch("pipeline.upload_trace_to_s3")
    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_cancel_path_does_not_upload_trace_when_trace_false(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        """Cancel path must NOT attempt an S3 upload when ``trace=False``.

        L4 flipped the previous blanket "no upload on cancel" rule: the
        cancel path now best-effort uploads and self-heals when
        ``config.trace=True`` (so users can debug cancelled-mid-run
        tasks). This test pins the negative side — without ``--trace``,
        there is still no upload on the cancel path. Post-hooks must
        still be skipped in both cases."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        mock_get_task = MagicMock(return_value={"status": "CANCELLED"})

        with (
            patch("pipeline.ensure_committed") as mock_ensure_committed,
            patch("pipeline.verify_build"),
            patch("pipeline.verify_lint"),
            patch("pipeline.ensure_pr") as mock_ensure_pr,
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline.task_state") as mock_task_state_mod,
        ):
            mock_task_state_mod.get_task = mock_get_task
            mock_task_state_mod.TaskFetchError = Exception  # type: ignore[attr-defined]

            from pipeline import run_task

            result = run_task(
                repo_url="owner/repo",
                task_description="mid-run cancel no trace",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-cancelled-no-trace",
                trace=False,  # no --trace → no upload even on cancel
                user_id="u-1",
            )

        mock_upload.assert_not_called()
        mock_ensure_committed.assert_not_called()
        mock_ensure_pr.assert_not_called()
        assert result["status"] == "cancelled"
        assert result["task_id"] == "t-cancelled-no-trace"
        assert "trace_s3_uri" not in result

    @patch("pipeline.upload_trace_to_s3")
    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_cancel_path_uploads_and_self_heals_when_trace(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        """L4 item 1c — cancel path with ``trace=True`` best-effort
        uploads to S3 and calls ``write_trace_uri_conditional`` so the
        trajectory captured before cancel stays recoverable.

        ``write_terminal`` cannot persist ``trace_s3_uri`` atomically on
        this path because its ConditionExpression rejects CANCELLED —
        the conditional-self-heal helper (scoped to
        ``attribute_not_exists(trace_s3_uri) AND status IN (...)``)
        handles the persistence instead."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            # Seed the accumulator so dump_gzipped_jsonl returns bytes.
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_upload.return_value = "s3://bucket/traces/u-1/t-cancelled-trace.jsonl.gz"

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        mock_get_task = MagicMock(return_value={"status": "CANCELLED"})

        with (
            patch("pipeline.ensure_committed") as mock_ensure_committed,
            patch("pipeline.verify_build"),
            patch("pipeline.verify_lint"),
            patch("pipeline.ensure_pr") as mock_ensure_pr,
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline.task_state") as mock_task_state_mod,
        ):
            mock_task_state_mod.get_task = mock_get_task
            mock_task_state_mod.TaskFetchError = Exception  # type: ignore[attr-defined]
            mock_task_state_mod.write_trace_uri_conditional = MagicMock(return_value=True)

            from pipeline import run_task

            result = run_task(
                repo_url="owner/repo",
                task_description="mid-run cancel with trace",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-cancelled-trace",
                trace=True,
                user_id="u-1",
            )

            # Upload was attempted.
            mock_upload.assert_called_once()
            # Self-heal was invoked with the resulting URI.
            mock_task_state_mod.write_trace_uri_conditional.assert_called_once_with(
                "t-cancelled-trace",
                "s3://bucket/traces/u-1/t-cancelled-trace.jsonl.gz",
            )
            # write_terminal is NOT called on the cancel path (its
            # ConditionExpression would reject CANCELLED).
            mock_task_state_mod.write_terminal.assert_not_called()

        # Post-hooks still skipped (cancel short-circuit).
        mock_ensure_committed.assert_not_called()
        mock_ensure_pr.assert_not_called()
        # Cancel-shaped return payload.
        assert result["status"] == "cancelled"
        assert result["task_id"] == "t-cancelled-trace"

    @patch("pipeline.upload_trace_to_s3")
    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_cancel_path_heal_failure_is_fail_open(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        """L4 item 1c — when the self-heal helper raises on the cancel
        path, the cancel fast-path must still return cleanly; an
        upload/persist error must not propagate and turn a valid cancel
        into a pipeline crash."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_upload.return_value = "s3://bucket/traces/u-1/t-cancelled-crash.jsonl.gz"

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        mock_get_task = MagicMock(return_value={"status": "CANCELLED"})

        with (
            patch("pipeline.ensure_committed"),
            patch("pipeline.verify_build"),
            patch("pipeline.verify_lint"),
            patch("pipeline.ensure_pr"),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline.task_state") as mock_task_state_mod,
        ):
            mock_task_state_mod.get_task = mock_get_task
            mock_task_state_mod.TaskFetchError = Exception  # type: ignore[attr-defined]
            # Self-heal raises — cancel path must swallow it.
            mock_task_state_mod.write_trace_uri_conditional = MagicMock(
                side_effect=RuntimeError("ddb boom")
            )

            from pipeline import run_task

            # No exception should escape — fail-open contract.
            result = run_task(
                repo_url="owner/repo",
                task_description="cancel with heal failure",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-cancelled-crash",
                trace=True,
                user_id="u-1",
            )

        # Upload was attempted; heal raised but was swallowed.
        mock_upload.assert_called_once()
        assert result["status"] == "cancelled"
        assert result["task_id"] == "t-cancelled-crash"


class TestTraceCrashPath:
    """K2 review Finding #1 — a pipeline crash (exception after the
    agent loop) must still attempt the trace upload so the user can
    debug the failure. The upload is fully fail-open under the crash
    path too: an S3 error must not mask or replace the underlying
    pipeline exception."""

    @patch("pipeline.upload_trace_to_s3")
    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_crash_path_uploads_trace_and_threads_uri(
        self,
        mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            # Accumulate something so dump has bytes, then later cause
            # the pipeline to crash post-hooks.
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_upload.return_value = "s3://b/traces/u-1/t-crash.jsonl.gz"

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        # Force a crash after agent completes but before terminal write:
        # ``verify_build`` raises, which escapes to the outer except.
        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", side_effect=RuntimeError("build verify boom")),
            patch("pipeline.verify_lint", return_value=True),
            patch("pipeline.ensure_pr", return_value=None),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            import contextlib

            from pipeline import run_task

            with contextlib.suppress(RuntimeError):
                run_task(
                    repo_url="owner/repo",
                    task_description="crash case",
                    github_token="ghp_test",
                    aws_region="us-east-1",
                    task_id="t-crash",
                    trace=True,
                    user_id="u-1",
                )  # pipeline re-raises after writing FAILED

        # Upload was invoked on the crash path.
        assert mock_upload.called
        call_kwargs = mock_upload.call_args.kwargs
        assert call_kwargs["task_id"] == "t-crash"
        assert call_kwargs["user_id"] == "u-1"

        # Terminal was written as FAILED WITH trace_s3_uri threaded in.
        mock_task_state.write_terminal.assert_called()
        args, _ = mock_task_state.write_terminal.call_args
        assert args[1] == "FAILED"
        crash_result = args[2]
        assert crash_result["trace_s3_uri"] == "s3://b/traces/u-1/t-crash.jsonl.gz"

    @patch("pipeline.upload_trace_to_s3")
    @patch("pipeline.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_crash_path_upload_exception_does_not_mask_original_error(
        self,
        mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        """If the crash-path upload itself raises, the original
        pipeline exception must still be the one that propagates."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_upload.side_effect = RuntimeError("upload explode")

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", side_effect=ValueError("original pipeline error")),
            patch("pipeline.verify_lint", return_value=True),
            patch("pipeline.ensure_pr", return_value=None),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            import pytest

            from pipeline import run_task

            with pytest.raises(ValueError, match="original pipeline error"):
                run_task(
                    repo_url="owner/repo",
                    task_description="mask test",
                    github_token="ghp_test",
                    aws_region="us-east-1",
                    task_id="t-mask",
                    trace=True,
                    user_id="u-1",
                )

        # Terminal still written despite the upload failure.
        mock_task_state.write_terminal.assert_called()
