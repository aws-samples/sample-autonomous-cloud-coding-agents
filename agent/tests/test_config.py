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
    """Phase 2.0a: token resolves via AgentCore Identity, not Secrets Manager.

    Pins the contract that `LINEAR_API_TOKEN` env var is the public surface
    (consumed by `channel_mcp.py`'s `${LINEAR_API_TOKEN}` MCP placeholder
    and `linear_reactions.py`'s GraphQL Authorization header). Only the
    *source* of the value changed: previously boto3 secretsmanager, now
    bedrock_agentcore Identity.
    """

    def test_returns_cached_value_without_calling_identity(self, monkeypatch):
        """Fast-path: if LINEAR_API_TOKEN is already set, no SDK call fires."""
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_cached")
        with patch("bedrock_agentcore.services.identity.IdentityClient") as mock_client:
            assert resolve_linear_api_token() == "lin_api_cached"
            mock_client.assert_not_called()

    def test_returns_empty_when_provider_name_missing(self, monkeypatch):
        """Without LINEAR_API_KEY_PROVIDER_NAME, no source — return empty cleanly."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.delenv("LINEAR_API_KEY_PROVIDER_NAME", raising=False)
        with patch("bedrock_agentcore.services.identity.IdentityClient") as mock_client:
            assert resolve_linear_api_token() == ""
            mock_client.assert_not_called()

    def test_returns_empty_when_region_missing(self, monkeypatch):
        """No region → can't construct IdentityClient → empty + WARN, no SDK call."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("LINEAR_API_KEY_PROVIDER_NAME", "linear-api-key")
        monkeypatch.delenv("AWS_REGION", raising=False)
        monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
        with patch("bedrock_agentcore.services.identity.IdentityClient") as mock_client:
            assert resolve_linear_api_token() == ""
            mock_client.assert_not_called()

    def test_returns_empty_when_workload_token_not_in_context(self, monkeypatch):
        """Outside AgentCore Runtime, BedrockAgentCoreContext returns None.
        Don't try the local-auth fallback (writes .agentcore.json which
        doesn't fit our flow) — just return empty so MCP fails closed."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("LINEAR_API_KEY_PROVIDER_NAME", "linear-api-key")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        with patch(
            "bedrock_agentcore.runtime.BedrockAgentCoreContext.get_workload_access_token",
            return_value=None,
        ):
            assert resolve_linear_api_token() == ""

    def test_resolves_from_identity_and_caches_in_env(self, monkeypatch):
        """Happy path: workload token in context → IdentityClient.get_api_key
        returns the API key → set LINEAR_API_TOKEN env var → return token."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("LINEAR_API_KEY_PROVIDER_NAME", "linear-api-key")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_instance = MagicMock()

        async def _get_key(provider_name, agent_identity_token):
            return "lin_api_resolved"

        mock_instance.get_api_key = _get_key

        with (
            patch(
                "bedrock_agentcore.runtime.BedrockAgentCoreContext.get_workload_access_token",
                return_value="workload-token-abc",
            ),
            patch(
                "bedrock_agentcore.services.identity.IdentityClient",
                return_value=mock_instance,
            ) as mock_client_class,
        ):
            result = resolve_linear_api_token()

        assert result == "lin_api_resolved"
        # Construction passed the resolved region.
        mock_client_class.assert_called_once_with(region="us-east-1")
        # Side effect: env var populated for downstream consumers.
        import os

        assert os.environ.get("LINEAR_API_TOKEN") == "lin_api_resolved"

    def test_swallows_botocore_errors_and_logs_warn(self, monkeypatch):
        """Identity outages must NEVER crash the agent. Return empty + WARN;
        the Linear MCP will then fail on first call with a clear auth error."""
        from botocore.exceptions import ClientError

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("LINEAR_API_KEY_PROVIDER_NAME", "linear-api-key")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_instance = MagicMock()

        async def _raise(provider_name, agent_identity_token):
            raise ClientError(
                {"Error": {"Code": "AccessDenied", "Message": "denied"}},
                "GetResourceApiKey",
            )

        mock_instance.get_api_key = _raise

        with (
            patch(
                "bedrock_agentcore.runtime.BedrockAgentCoreContext.get_workload_access_token",
                return_value="workload-token-abc",
            ),
            patch(
                "bedrock_agentcore.services.identity.IdentityClient",
                return_value=mock_instance,
            ),
        ):
            # Must not raise.
            assert resolve_linear_api_token() == ""

    def test_returns_empty_when_get_api_key_returns_none(self, monkeypatch):
        """Defensive: if the SDK returns None (provider exists but no value),
        return empty rather than coercing to the string 'None'."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("LINEAR_API_KEY_PROVIDER_NAME", "linear-api-key")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_instance = MagicMock()

        async def _get_none(provider_name, agent_identity_token):
            return None

        mock_instance.get_api_key = _get_none

        with (
            patch(
                "bedrock_agentcore.runtime.BedrockAgentCoreContext.get_workload_access_token",
                return_value="workload-token-abc",
            ),
            patch(
                "bedrock_agentcore.services.identity.IdentityClient",
                return_value=mock_instance,
            ),
        ):
            assert resolve_linear_api_token() == ""

    def test_import_error_degrades_gracefully(self, monkeypatch):
        """If bedrock_agentcore SDK is missing from the container image, log
        WARN and return '' rather than crashing the agent. Adapted from PR #87
        nice-to-have improvement (the boto3 ImportError version) for the
        AgentCore SDK migration."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("LINEAR_API_KEY_PROVIDER_NAME", "linear-api-key")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        # Force `import bedrock_agentcore.services.identity` to raise ImportError.
        monkeypatch.setitem(sys.modules, "bedrock_agentcore.services.identity", None)
        with patch("config.log") as mock_log:
            assert resolve_linear_api_token() == ""
        # WARN logged, no exception escaped.
        assert mock_log.call_count >= 1
        assert any(call.args[0] == "WARN" for call in mock_log.call_args_list)
        assert any(
            "bedrock_agentcore unavailable" in call.args[1] for call in mock_log.call_args_list
        )

    def test_access_denied_logged_at_error(self, monkeypatch):
        """Persistent IAM misconfig should page someone — escalate from WARN
        to ERROR so alerts fire. Adapted from PR #87 nice-to-have
        improvement; the AgentCore equivalent is a missing
        `bedrock-agentcore:GetResourceApiKey` IAM permission."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("LINEAR_API_KEY_PROVIDER_NAME", "linear-api-key")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        from botocore.exceptions import ClientError

        mock_instance = MagicMock()

        async def _raise_access_denied(provider_name, agent_identity_token):
            raise ClientError(
                {"Error": {"Code": "AccessDeniedException", "Message": "no access"}},
                "GetResourceApiKey",
            )

        mock_instance.get_api_key = _raise_access_denied

        with (
            patch(
                "bedrock_agentcore.runtime.BedrockAgentCoreContext.get_workload_access_token",
                return_value="workload-token-abc",
            ),
            patch(
                "bedrock_agentcore.services.identity.IdentityClient",
                return_value=mock_instance,
            ),
            patch("config.log") as mock_log,
        ):
            assert resolve_linear_api_token() == ""
        assert mock_log.call_count == 1
        assert mock_log.call_args[0][0] == "ERROR"

    def test_resource_not_found_logged_at_error(self, monkeypatch):
        """Provider name typo / missing credential is also persistent — page
        someone rather than warn forever. Both AccessDeniedException and
        ResourceNotFoundException take the ERROR path; everything else stays
        at WARN (transient throttle, network blip)."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("LINEAR_API_KEY_PROVIDER_NAME", "linear-api-key")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        from botocore.exceptions import ClientError

        mock_instance = MagicMock()

        async def _raise_not_found(provider_name, agent_identity_token):
            raise ClientError(
                {"Error": {"Code": "ResourceNotFoundException", "Message": "missing provider"}},
                "GetResourceApiKey",
            )

        mock_instance.get_api_key = _raise_not_found

        with (
            patch(
                "bedrock_agentcore.runtime.BedrockAgentCoreContext.get_workload_access_token",
                return_value="workload-token-abc",
            ),
            patch(
                "bedrock_agentcore.services.identity.IdentityClient",
                return_value=mock_instance,
            ),
            patch("config.log") as mock_log,
        ):
            assert resolve_linear_api_token() == ""
        assert mock_log.call_count == 1
        assert mock_log.call_args[0][0] == "ERROR"
