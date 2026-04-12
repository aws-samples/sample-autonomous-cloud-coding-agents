"""Unit tests for pipeline.py — cedar_policies injection."""

from unittest.mock import MagicMock, patch


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
        """When cedar_policies are passed, they appear in the config dict."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = {
            "repo_dir": "/workspace/repo",
            "branch": "bgagent/test/branch",
            "build_before": True,
        }

        captured_config = {}

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None):
            captured_config.update(config)
            return {"status": "success", "turns": 1, "cost_usd": 0.01, "num_turns": 1}

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

        assert "cedar_policies" in captured_config
        assert captured_config["cedar_policies"] == policies

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
        """When cedar_policies are not passed, the key is absent from config."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = {
            "repo_dir": "/workspace/repo",
            "branch": "bgagent/test/branch",
            "build_before": True,
        }

        captured_config = {}

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None):
            captured_config.update(config)
            return {"status": "success", "turns": 1, "cost_usd": 0.01, "num_turns": 1}

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

        assert "cedar_policies" not in captured_config
