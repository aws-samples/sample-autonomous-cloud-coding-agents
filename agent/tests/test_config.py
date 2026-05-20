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
    """Phase 2.0b-O2: token resolves from per-workspace Secrets Manager.

    The orchestrator stamps `linear_oauth_secret_arn` into the task's
    channel_metadata at creation time. resolve_linear_api_token reads
    the secret JSON via boto3, refreshes it if expiring, and caches the
    access_token in `LINEAR_API_TOKEN` for the Linear MCP placeholder.
    """

    def test_returns_cached_value_without_calling_secrets_manager(self, monkeypatch):
        """Fast-path: if LINEAR_API_TOKEN is already set, no SDK call fires."""
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_oauth_cached")
        with patch("boto3.client") as mock_boto:
            assert resolve_linear_api_token() == "lin_oauth_cached"
            mock_boto.assert_not_called()

    def test_returns_empty_when_secret_arn_missing(self, monkeypatch):
        """Without channel_metadata.linear_oauth_secret_arn or env, no source — empty."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.delenv("LINEAR_OAUTH_SECRET_ARN", raising=False)
        with patch("boto3.client") as mock_boto:
            assert resolve_linear_api_token() == ""
            mock_boto.assert_not_called()

    def test_returns_empty_when_region_missing(self, monkeypatch):
        """No region → can't construct boto3 client → empty + WARN, no SDK call."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.delenv("AWS_REGION", raising=False)
        monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
        with patch("boto3.client") as mock_boto:
            assert resolve_linear_api_token({"linear_oauth_secret_arn": "arn:test"}) == ""
            mock_boto.assert_not_called()

    def test_resolves_from_secrets_manager_and_caches_in_env(self, monkeypatch):
        """Happy path: channel_metadata carries the ARN, secret has access_token + future expiry."""
        from datetime import datetime, timedelta, timezone

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        future = (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        token_payload = {
            "access_token": "lin_oauth_fresh",
            "refresh_token": "lin_refresh_xyz",
            "expires_at": future,
            "scope": "read write app:assignable app:mentionable",
            "client_id": "cid",
            "client_secret": "csec",
            "workspace_id": "ws-uuid",
            "workspace_slug": "acme",
            "installed_at": "2026-05-19T08:00:00Z",
            "updated_at": "2026-05-19T08:00:00Z",
            "installed_by_platform_user_id": "cog-sub",
        }
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {
            "SecretString": __import__("json").dumps(token_payload),
        }
        with patch("boto3.client", return_value=mock_sm):
            assert resolve_linear_api_token({"linear_oauth_secret_arn": "arn:test"}) == "lin_oauth_fresh"

        # Cached for subsequent reads.
        import os as _os
        assert _os.environ.get("LINEAR_API_TOKEN") == "lin_oauth_fresh"
        # Reset for other tests.
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_returns_empty_on_secrets_manager_access_denied(self, monkeypatch):
        """ClientError surfaces as empty + ERROR log, never crashes the agent."""
        from botocore.exceptions import ClientError

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        mock_sm = MagicMock()
        mock_sm.get_secret_value.side_effect = ClientError(
            {"Error": {"Code": "AccessDeniedException", "Message": "no perms"}},
            "GetSecretValue",
        )
        with patch("boto3.client", return_value=mock_sm):
            assert resolve_linear_api_token({"linear_oauth_secret_arn": "arn:test"}) == ""

    def test_falls_back_to_env_var_when_channel_metadata_omits_arn(self, monkeypatch):
        """LINEAR_OAUTH_SECRET_ARN env var is the back-compat fallback."""
        from datetime import datetime, timedelta, timezone

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("LINEAR_OAUTH_SECRET_ARN", "arn:from-env")
        future = (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {
            "SecretString": __import__("json").dumps({
                "access_token": "lin_oauth_envpath",
                "refresh_token": "rt", "expires_at": future, "scope": "read",
                "client_id": "c", "client_secret": "s",
                "workspace_id": "w", "workspace_slug": "s",
                "installed_at": "x", "updated_at": "x",
                "installed_by_platform_user_id": "u",
            }),
        }
        with patch("boto3.client", return_value=mock_sm):
            assert resolve_linear_api_token() == "lin_oauth_envpath"
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
