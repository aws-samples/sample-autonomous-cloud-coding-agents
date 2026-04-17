"""Unit tests for config.py — build_config, constants, and token resolution."""

from unittest.mock import MagicMock, patch

import pytest

from config import PR_TASK_TYPES, build_config, resolve_github_token
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


class TestResolveGitHubToken:
    def test_returns_cached_env_var(self, monkeypatch):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_cached")
        monkeypatch.delenv("WORKLOAD_IDENTITY_NAME", raising=False)
        monkeypatch.delenv("GITHUB_TOKEN_SECRET_ARN", raising=False)
        assert resolve_github_token() == "ghp_cached"

    def test_returns_empty_when_nothing_configured(self, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.delenv("WORKLOAD_IDENTITY_NAME", raising=False)
        monkeypatch.delenv("GITHUB_OAUTH2_PROVIDER_NAME", raising=False)
        monkeypatch.delenv("GITHUB_TOKEN_SECRET_ARN", raising=False)
        assert resolve_github_token() == ""

    @patch("boto3.client")
    def test_token_vault_preferred_over_secrets_manager(self, mock_boto3_client, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("WORKLOAD_IDENTITY_NAME", "test-agent")
        monkeypatch.setenv("GITHUB_OAUTH2_PROVIDER_NAME", "test-github")
        secret_arn = "arn:aws:secretsmanager:us-east-1:123:secret:pat"
        monkeypatch.setenv("GITHUB_TOKEN_SECRET_ARN", secret_arn)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_client = MagicMock()
        mock_boto3_client.return_value = mock_client
        mock_client.get_workload_access_token.return_value = {
            "workloadAccessToken": "wat-123",
        }
        mock_client.get_resource_oauth2_token.return_value = {
            "accessToken": "gho_tokenvault",
        }

        token = resolve_github_token()

        assert token == "gho_tokenvault"
        mock_boto3_client.assert_called_once_with("bedrock-agentcore", region_name="us-east-1")
        mock_client.get_workload_access_token.assert_called_once_with(workloadName="test-agent")
        mock_client.get_resource_oauth2_token.assert_called_once_with(
            workloadIdentityToken="wat-123",
            resourceCredentialProviderName="test-github",
            scopes=["repo"],
            oauth2Flow="M2M",
        )
        # Token Vault used — Secrets Manager should NOT be called
        mock_client.get_secret_value.assert_not_called()

    @patch("boto3.client")
    def test_falls_back_to_secrets_manager(self, mock_boto3_client, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.delenv("WORKLOAD_IDENTITY_NAME", raising=False)
        monkeypatch.delenv("GITHUB_OAUTH2_PROVIDER_NAME", raising=False)
        secret_arn = "arn:aws:secretsmanager:us-east-1:123:secret:pat"
        monkeypatch.setenv("GITHUB_TOKEN_SECRET_ARN", secret_arn)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_client = MagicMock()
        mock_boto3_client.return_value = mock_client
        mock_client.get_secret_value.return_value = {"SecretString": "ghp_pat123"}

        token = resolve_github_token()

        assert token == "ghp_pat123"
        mock_boto3_client.assert_called_once_with("secretsmanager", region_name="us-east-1")

    @patch("boto3.client")
    def test_token_vault_caches_in_env(self, mock_boto3_client, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("WORKLOAD_IDENTITY_NAME", "agent")
        monkeypatch.setenv("GITHUB_OAUTH2_PROVIDER_NAME", "github")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_client = MagicMock()
        mock_boto3_client.return_value = mock_client
        mock_client.get_workload_access_token.return_value = {"workloadAccessToken": "wat"}
        mock_client.get_resource_oauth2_token.return_value = {"accessToken": "gho_cached"}

        token = resolve_github_token()
        assert token == "gho_cached"

        # Verify it was cached in os.environ
        import os

        assert os.environ.get("GITHUB_TOKEN") == "gho_cached"

    @patch("boto3.client")
    def test_token_vault_get_workload_token_error(self, mock_boto3_client, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("WORKLOAD_IDENTITY_NAME", "agent")
        monkeypatch.setenv("GITHUB_OAUTH2_PROVIDER_NAME", "github")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_client = MagicMock()
        mock_boto3_client.return_value = mock_client
        mock_client.get_workload_access_token.side_effect = Exception("AccessDenied")

        with pytest.raises(RuntimeError, match="failed to get workload access token"):
            resolve_github_token()

    @patch("boto3.client")
    def test_token_vault_empty_workload_token(self, mock_boto3_client, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("WORKLOAD_IDENTITY_NAME", "agent")
        monkeypatch.setenv("GITHUB_OAUTH2_PROVIDER_NAME", "github")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_client = MagicMock()
        mock_boto3_client.return_value = mock_client
        mock_client.get_workload_access_token.return_value = {"workloadAccessToken": ""}

        with pytest.raises(RuntimeError, match="empty workload access token"):
            resolve_github_token()

    @patch("boto3.client")
    def test_token_vault_empty_github_token(self, mock_boto3_client, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("WORKLOAD_IDENTITY_NAME", "agent")
        monkeypatch.setenv("GITHUB_OAUTH2_PROVIDER_NAME", "github")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_client = MagicMock()
        mock_boto3_client.return_value = mock_client
        mock_client.get_workload_access_token.return_value = {"workloadAccessToken": "wat"}
        mock_client.get_resource_oauth2_token.return_value = {"accessToken": ""}

        with pytest.raises(RuntimeError, match="empty GitHub access token"):
            resolve_github_token()

    def test_partial_token_vault_falls_back_to_pat(self, monkeypatch):
        """Only WORKLOAD_IDENTITY_NAME set — should skip Token Vault."""
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("WORKLOAD_IDENTITY_NAME", "agent")
        monkeypatch.delenv("GITHUB_OAUTH2_PROVIDER_NAME", raising=False)
        monkeypatch.delenv("GITHUB_TOKEN_SECRET_ARN", raising=False)
        assert resolve_github_token() == ""

    @patch("boto3.client")
    def test_secrets_manager_empty_secret_raises(self, mock_boto3_client, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.delenv("WORKLOAD_IDENTITY_NAME", raising=False)
        monkeypatch.delenv("GITHUB_OAUTH2_PROVIDER_NAME", raising=False)
        secret_arn = "arn:aws:secretsmanager:us-east-1:123:secret:pat"
        monkeypatch.setenv("GITHUB_TOKEN_SECRET_ARN", secret_arn)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_client = MagicMock()
        mock_boto3_client.return_value = mock_client
        mock_client.get_secret_value.return_value = {"SecretString": ""}

        with pytest.raises(RuntimeError, match="empty or stored as binary"):
            resolve_github_token()
