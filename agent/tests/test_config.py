"""Unit tests for config.py — build_config and constants."""

import sys
from unittest.mock import MagicMock, patch

import pytest

from config import PR_TASK_TYPES, build_config, resolve_linear_api_token
from models import TaskConfig


class TestAgentWorkspaceConstant:
    def test_default_value(self, monkeypatch):
        monkeypatch.delenv("AGENT_WORKSPACE", raising=False)
        import importlib

        import config

        importlib.reload(config)
        assert config.AGENT_WORKSPACE == "/workspace"


class TestPRTaskTypes:
    def test_contains_pr_iteration(self):
        assert "pr_iteration" in PR_TASK_TYPES

    def test_contains_pr_review(self):
        assert "pr_review" in PR_TASK_TYPES

    def test_does_not_contain_new_task(self):
        assert "new_task" not in PR_TASK_TYPES


class TestTaskTypeValidation:
    def test_invalid_task_type_raises(self):
        with pytest.raises(ValueError, match="Invalid task_type"):
            build_config(
                repo_url="owner/repo",
                task_description="fix bug",
                github_token="ghp_test123",
                aws_region="us-east-1",
                task_type="unknown_type",
            )

    def test_valid_task_types_accepted(self):
        for tt in ("new_task", "pr_iteration", "pr_review"):
            desc = "" if tt in ("pr_iteration", "pr_review") else "fix bug"
            pr = "42" if tt in ("pr_iteration", "pr_review") else ""
            config = build_config(
                repo_url="owner/repo",
                task_description=desc,
                github_token="ghp_test123",
                aws_region="us-east-1",
                task_type=tt,
                pr_number=pr,
            )
            assert config.task_type == tt


class TestBuildConfig:
    def test_valid_config_returns_task_config(self):
        config = build_config(
            repo_url="owner/repo",
            task_description="fix bug",
            github_token="ghp_test123",
            aws_region="us-east-1",
            task_id="test-id",
        )
        assert isinstance(config, TaskConfig)
        assert config.repo_url == "owner/repo"
        assert config.task_id == "test-id"

    def test_missing_repo_raises(self):
        with pytest.raises(ValueError, match="repo_url"):
            build_config(
                repo_url="",
                task_description="fix bug",
                github_token="ghp_test",
                aws_region="us-east-1",
            )

    def test_auto_generated_task_id(self):
        config = build_config(
            repo_url="owner/repo",
            task_description="do something",
            github_token="ghp_test",
            aws_region="us-east-1",
        )
        assert config.task_id
        assert len(config.task_id) == 12


class TestResolveLinearApiToken:
    """Coverage for the secrets-manager + boto3 fallback paths."""

    def test_returns_cached_env_var_without_calling_boto(self, monkeypatch):
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_cached")
        monkeypatch.setenv("LINEAR_API_TOKEN_SECRET_ARN", "arn:aws:sm:::secret/linear")
        # boto3 must not be touched if the env var is already set.
        with patch("config.log") as mock_log:
            assert resolve_linear_api_token() == "lin_cached"
        mock_log.assert_not_called()

    def test_returns_empty_when_no_secret_arn(self, monkeypatch):
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.delenv("LINEAR_API_TOKEN_SECRET_ARN", raising=False)
        assert resolve_linear_api_token() == ""

    def test_import_error_degrades_gracefully(self, monkeypatch):
        """If boto3 is missing from the container image, log WARN and return ''
        rather than crashing the agent."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("LINEAR_API_TOKEN_SECRET_ARN", "arn:aws:sm:::secret/linear")
        # Force `import boto3` (executed inside resolve_linear_api_token) to
        # raise ImportError by removing it from sys.modules and shadowing it.
        monkeypatch.setitem(sys.modules, "boto3", None)
        with patch("config.log") as mock_log:
            assert resolve_linear_api_token() == ""
        # WARN logged, no exception escaped.
        assert mock_log.call_count == 1
        assert mock_log.call_args[0][0] == "WARN"
        assert "boto3 unavailable" in mock_log.call_args[0][1]

    def test_access_denied_logged_at_error(self, monkeypatch):
        """Persistent IAM misconfig should page someone — escalate from WARN
        to ERROR so alerts fire."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("LINEAR_API_TOKEN_SECRET_ARN", "arn:aws:sm:::secret/linear")

        from botocore.exceptions import ClientError

        err = ClientError(
            {"Error": {"Code": "AccessDeniedException", "Message": "no access"}},
            "GetSecretValue",
        )
        fake_client = MagicMock()
        fake_client.get_secret_value.side_effect = err
        with patch("boto3.client", return_value=fake_client), patch("config.log") as mock_log:
            assert resolve_linear_api_token() == ""
        assert mock_log.call_count == 1
        assert mock_log.call_args[0][0] == "ERROR"

    def test_other_client_error_logged_at_warn(self, monkeypatch):
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("LINEAR_API_TOKEN_SECRET_ARN", "arn:aws:sm:::secret/linear")

        from botocore.exceptions import ClientError

        err = ClientError(
            {"Error": {"Code": "ResourceNotFoundException", "Message": "missing"}},
            "GetSecretValue",
        )
        fake_client = MagicMock()
        fake_client.get_secret_value.side_effect = err
        with patch("boto3.client", return_value=fake_client), patch("config.log") as mock_log:
            assert resolve_linear_api_token() == ""
        assert mock_log.call_count == 1
        assert mock_log.call_args[0][0] == "WARN"

    def test_botocore_error_logged_at_warn(self, monkeypatch):
        """The handler is split into ClientError + BotoCoreError branches.
        BotoCoreError covers transient connectivity / endpoint problems —
        log WARN and degrade gracefully rather than crashing the agent."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("LINEAR_API_TOKEN_SECRET_ARN", "arn:aws:sm:::secret/linear")

        from botocore.exceptions import EndpointConnectionError

        fake_client = MagicMock()
        fake_client.get_secret_value.side_effect = EndpointConnectionError(
            endpoint_url="https://secretsmanager.us-east-1.amazonaws.com",
        )
        with patch("boto3.client", return_value=fake_client), patch("config.log") as mock_log:
            assert resolve_linear_api_token() == ""
        assert mock_log.call_count == 1
        assert mock_log.call_args[0][0] == "WARN"
        assert "EndpointConnectionError" in mock_log.call_args[0][1]
