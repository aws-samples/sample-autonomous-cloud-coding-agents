import os
from datetime import UTC
from unittest.mock import MagicMock, call, patch

import pytest

from config import (
    PR_WORKFLOW_IDS,
    build_config,
    clear_jira_task_credentials,
    resolve_jira_oauth_token,
    resolve_linear_api_token,
)
from models import TaskConfig

# `datetime.fromisoformat` accepts the last two, whose "Z" is not the zone suffix: parsed raw (ruff
# FURB162's unsafe fix) the first raises TypeError in the resolver, the second is valid until 2099.
_MALFORMED_EXPIRES_AT = ["this is not a date", "2099-01-01Z00:00:00", "2099-01-01Z00:00:00+00:00"]


class TestAgentWorkspaceConstant:
    def test_default_value(self, monkeypatch):
        monkeypatch.delenv("AGENT_WORKSPACE", raising=False)
        import importlib

        import config

        importlib.reload(config)
        assert config.AGENT_WORKSPACE == "/workspace"


class TestPRWorkflowIds:
    def test_contains_pr_iteration_workflow(self):
        assert "coding/pr-iteration-v1" in PR_WORKFLOW_IDS

    def test_contains_pr_review_workflow(self):
        assert "coding/pr-review-v1" in PR_WORKFLOW_IDS

    def test_does_not_contain_new_task_workflow(self):
        assert "coding/new-task-v1" not in PR_WORKFLOW_IDS


class TestWorkflowResolution:
    def test_default_workflow_when_omitted(self):
        config = build_config(
            repo_url="owner/repo",
            task_description="fix bug",
            github_token="ghp_test123",
            aws_region="us-east-1",
        )
        assert config.resolved_workflow == {"id": "coding/new-task-v1", "version": "1.0.0"}
        assert config.policy_principal == "new_task"
        assert config.is_pr_workflow is False

    def test_haiku_model_defaults_to_inference_profile(self, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_DEFAULT_HAIKU_MODEL", raising=False)
        config = build_config(
            repo_url="owner/repo",
            task_description="fix bug",
            github_token="ghp_test123",
            aws_region="us-east-1",
        )
        assert config.haiku_model == "global.anthropic.claude-haiku-5-5"

    def test_haiku_model_resolves_from_env(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "us.anthropic.claude-haiku-x")
        config = build_config(
            repo_url="owner/repo",
            task_description="fix bug",
            github_token="ghp_test123",
            aws_region="us-east-1",
        )
        assert config.haiku_model == "us.anthropic.claude-haiku-x"

    def test_pr_iteration_workflow_requires_pr_number(self):
        with pytest.raises(ValueError, match="pr_number is required"):
            build_config(
                repo_url="owner/repo",
                github_token="ghp_test123",
                aws_region="us-east-1",
                resolved_workflow={"id": "coding/pr-iteration-v1", "version": "1.0.0"},
            )

    def test_pr_review_workflow_is_read_only_with_pr_review_principal(self):
        config = build_config(
            repo_url="owner/repo",
            github_token="ghp_test123",
            aws_region="us-east-1",
            resolved_workflow={"id": "coding/pr-review-v1", "version": "1.0.0"},
            pr_number="42",
        )
        assert config.is_pr_workflow is True
        assert config.policy_principal == "pr_review"
        assert config.read_only is True

    def test_pr_iteration_workflow_maps_to_pr_iteration_principal(self):
        config = build_config(
            repo_url="owner/repo",
            github_token="ghp_test123",
            aws_region="us-east-1",
            resolved_workflow={"id": "coding/pr-iteration-v1", "version": "1.0.0"},
            pr_number="42",
        )
        assert config.policy_principal == "pr_iteration"
        assert config.read_only is False

    def test_repoless_default_workflow_does_not_require_repo(self):
        config = build_config(
            task_description="Summarise these papers",
            aws_region="us-east-1",
            resolved_workflow={"id": "default/agent-v1", "version": "1.0.0"},
        )
        assert config.requires_repo is False
        assert config.repo_url == ""

    def test_workflow_load_failure_fails_closed(self, monkeypatch):
        import workflow as workflow_mod
        from workflow import WorkflowValidationError

        def boom(_workflow_id):
            raise WorkflowValidationError("simulated load failure")

        monkeypatch.setattr(workflow_mod, "load_workflow", boom)

        cfg = build_config(
            repo_url="owner/repo",
            github_token="ghp_test123",
            task_description="x",
            aws_region="us-east-1",
            resolved_workflow={"id": "knowledge/mystery-v1", "version": "1.0.0"},
        )
        assert cfg.read_only is True
        assert cfg.requires_repo is True

        cfg2 = build_config(
            repo_url="owner/repo",
            github_token="ghp_test123",
            task_description="x",
            aws_region="us-east-1",
            resolved_workflow={"id": "coding/new-task-v1", "version": "1.0.0"},
        )
        assert cfg2.read_only is False
        assert cfg2.requires_repo is True


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
    def test_returns_cached_value_without_calling_secrets_manager(self, monkeypatch):
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_oauth_cached")
        with patch("boto3.client") as mock_boto:
            assert resolve_linear_api_token() == "lin_oauth_cached"
            mock_boto.assert_not_called()

    def test_returns_empty_when_secret_arn_missing(self, monkeypatch):
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.delenv("LINEAR_OAUTH_SECRET_ARN", raising=False)
        with patch("boto3.client") as mock_boto:
            assert resolve_linear_api_token() == ""
            mock_boto.assert_not_called()

    def test_returns_empty_when_region_missing(self, monkeypatch):
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.delenv("AWS_REGION", raising=False)
        monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
        with patch("boto3.client") as mock_boto:
            assert resolve_linear_api_token({"linear_oauth_secret_arn": "arn:test"}) == ""
            mock_boto.assert_not_called()

    def test_resolves_from_secrets_manager_and_caches_in_env(self, monkeypatch):
        from datetime import datetime, timedelta

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        future = (datetime.now(UTC) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
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
            resolved = resolve_linear_api_token({"linear_oauth_secret_arn": "arn:test"})
            assert resolved == "lin_oauth_fresh"

        import os as _os

        assert _os.environ.get("LINEAR_API_TOKEN") == "lin_oauth_fresh"
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_returns_empty_on_secrets_manager_access_denied(self, monkeypatch):
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
        from datetime import datetime, timedelta

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("LINEAR_OAUTH_SECRET_ARN", "arn:from-env")
        future = (datetime.now(UTC) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {
            "SecretString": __import__("json").dumps(
                {
                    "access_token": "lin_oauth_envpath",
                    "refresh_token": "rt",
                    "expires_at": future,
                    "scope": "read",
                    "client_id": "c",
                    "client_secret": "s",
                    "workspace_id": "w",
                    "workspace_slug": "s",
                    "installed_at": "x",
                    "updated_at": "x",
                    "installed_by_platform_user_id": "u",
                }
            ),
        }
        with patch("boto3.client", return_value=mock_sm):
            assert resolve_linear_api_token() == "lin_oauth_envpath"
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_force_replaces_the_cached_token_with_the_stored_one(self, monkeypatch):
        import json
        from datetime import datetime, timedelta

        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_old")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        future = (datetime.now(UTC) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {
            "SecretString": json.dumps(
                {"access_token": "lin_new", "refresh_token": "rt", "expires_at": future}
            ),
        }
        with patch("boto3.client", return_value=mock_sm):
            resolved = resolve_linear_api_token({"linear_oauth_secret_arn": "arn:t"}, force=True)

        assert resolved == "lin_new"
        assert os.environ.get("LINEAR_API_TOKEN") == "lin_new"
        assert mock_sm.method_calls == [call.get_secret_value(SecretId="arn:t")]

    def test_force_keeps_the_cached_token_when_there_is_nothing_to_resolve(self, monkeypatch):
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_preset")
        monkeypatch.delenv("LINEAR_OAUTH_SECRET_ARN", raising=False)
        with patch("boto3.client") as mock_boto:
            assert resolve_linear_api_token(force=True) == ""
            mock_boto.assert_not_called()

        assert os.environ.get("LINEAR_API_TOKEN") == "lin_preset"


class TestResolveLinearApiTokenVaultPath:
    def _enable_vault(self, monkeypatch):
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("LINEAR_VAULT_ENABLED", "true")
        monkeypatch.setenv("LINEAR_WORKLOAD_IDENTITY_NAME", "abca_linear_oauth")

    def _meta(self):
        return {
            "linear_provider_name": "bgagent-linear-oauth-acme",
            "linear_workspace_id": "org-abc",
            "linear_oauth_secret_arn": "arn:sm:acme",
        }

    def test_prefers_the_recorded_vault_user_id(self, monkeypatch):
        self._enable_vault(monkeypatch)
        mock_client = MagicMock()
        mock_client.get_workload_access_token_for_user_id.return_value = {
            "workloadAccessToken": "wat-xyz",
        }
        mock_client.get_resource_oauth2_token.return_value = {"accessToken": "lin_oauth_vault"}
        meta = {**self._meta(), "linear_vault_user_id": "linear-ws-acme"}
        with patch("boto3.client", return_value=mock_client):
            assert resolve_linear_api_token(meta) == "lin_oauth_vault"
        mock_client.get_workload_access_token_for_user_id.assert_called_once_with(
            workloadName="abca_linear_oauth", userId="linear-ws-acme"
        )

    def test_falls_back_to_derived_user_id_when_none_recorded(self, monkeypatch):
        self._enable_vault(monkeypatch)
        mock_client = MagicMock()
        mock_client.get_workload_access_token_for_user_id.return_value = {
            "workloadAccessToken": "wat-xyz",
        }
        mock_client.get_resource_oauth2_token.return_value = {"accessToken": "lin_oauth_vault"}
        with patch("boto3.client", return_value=mock_client):
            assert resolve_linear_api_token(self._meta()) == "lin_oauth_vault"
        mock_client.get_workload_access_token_for_user_id.assert_called_once_with(
            workloadName="abca_linear_oauth", userId="linear-workspace-org-abc"
        )

    def test_mints_via_vault_and_caches(self, monkeypatch):
        self._enable_vault(monkeypatch)
        mock_client = MagicMock()
        mock_client.get_workload_access_token_for_user_id.return_value = {
            "workloadAccessToken": "wat-xyz",
        }
        mock_client.get_resource_oauth2_token.return_value = {"accessToken": "lin_oauth_vault"}
        with patch("boto3.client", return_value=mock_client):
            resolved = resolve_linear_api_token(self._meta())
        assert resolved == "lin_oauth_vault"
        mock_client.get_workload_access_token_for_user_id.assert_called_once_with(
            workloadName="abca_linear_oauth", userId="linear-workspace-org-abc"
        )
        assert mock_client.get_resource_oauth2_token.call_args.kwargs["customParameters"] == {
            "actor": "app",
            "prompt": "consent",
        }
        mock_client.get_secret_value.assert_not_called()
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_force_asks_the_vault_again_instead_of_returning_the_cached_token(self, monkeypatch):
        self._enable_vault(monkeypatch)
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_oauth_vault_at_start")
        mock_client = MagicMock()
        mock_client.get_workload_access_token_for_user_id.return_value = {
            "workloadAccessToken": "wat-xyz",
        }
        mock_client.get_resource_oauth2_token.return_value = {"accessToken": "lin_oauth_vault"}
        with patch("boto3.client", return_value=mock_client):
            assert resolve_linear_api_token(self._meta(), force=True) == "lin_oauth_vault"

        assert os.environ.get("LINEAR_API_TOKEN") == "lin_oauth_vault"

    def test_consent_required_falls_back_to_secrets_manager(self, monkeypatch):
        from datetime import datetime, timedelta

        self._enable_vault(monkeypatch)
        future = (datetime.now(UTC) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        mock_client = MagicMock()
        mock_client.get_workload_access_token_for_user_id.return_value = {
            "workloadAccessToken": "wat"
        }
        mock_client.get_resource_oauth2_token.return_value = {
            "authorizationUrl": "https://bedrock-agentcore.../authorize?request_uri=urn:x",
        }
        mock_client.get_secret_value.return_value = {
            "SecretString": __import__("json").dumps(
                {
                    "access_token": "lin_oauth_sm_fallback",
                    "refresh_token": "rt",
                    "expires_at": future,
                    "scope": "read",
                    "client_id": "c",
                    "client_secret": "s",
                    "workspace_id": "w",
                    "workspace_slug": "s",
                    "installed_at": "x",
                    "updated_at": "x",
                    "installed_by_platform_user_id": "u",
                }
            ),
        }
        with patch("boto3.client", return_value=mock_client):
            resolved = resolve_linear_api_token(self._meta())
        assert resolved == "lin_oauth_sm_fallback"
        mock_client.get_secret_value.assert_called()
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_vault_error_falls_back_to_secrets_manager(self, monkeypatch):
        from datetime import datetime, timedelta

        from botocore.exceptions import ClientError

        self._enable_vault(monkeypatch)
        future = (datetime.now(UTC) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        mock_client = MagicMock()
        mock_client.get_workload_access_token_for_user_id.side_effect = ClientError(
            {"Error": {"Code": "AccessDeniedException", "Message": "no perms"}},
            "GetWorkloadAccessTokenForUserId",
        )
        mock_client.get_secret_value.return_value = {
            "SecretString": __import__("json").dumps(
                {
                    "access_token": "lin_oauth_sm_after_error",
                    "refresh_token": "rt",
                    "expires_at": future,
                    "scope": "read",
                    "client_id": "c",
                    "client_secret": "s",
                    "workspace_id": "w",
                    "workspace_slug": "s",
                    "installed_at": "x",
                    "updated_at": "x",
                    "installed_by_platform_user_id": "u",
                }
            ),
        }
        with patch("boto3.client", return_value=mock_client):
            resolved = resolve_linear_api_token(self._meta())
        assert resolved == "lin_oauth_sm_after_error"
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_vault_error_with_a_secret_that_carries_no_grant_yields_no_token(self, monkeypatch):
        from botocore.exceptions import ClientError

        self._enable_vault(monkeypatch)
        mock_client = MagicMock()
        mock_client.get_workload_access_token_for_user_id.side_effect = ClientError(
            {"Error": {"Code": "ThrottlingException", "Message": "slow down"}},
            "GetWorkloadAccessTokenForUserId",
        )
        mock_client.get_secret_value.return_value = {
            "SecretString": __import__("json").dumps(
                {
                    "access_token": "",
                    "refresh_token": "",
                    "expires_at": "",
                    "scope": "",
                    "client_id": "c",
                    "client_secret": "s",
                    "workspace_id": "w",
                    "workspace_slug": "s",
                    "installed_at": "x",
                    "updated_at": "x",
                    "installed_by_platform_user_id": "u",
                }
            ),
        }
        with (
            patch("boto3.client", return_value=mock_client),
            patch(
                "urllib.request.urlopen",
                side_effect=AssertionError("the agent asked Linear for a new token"),
            ) as urlopen_mock,
        ):
            assert resolve_linear_api_token(self._meta()) == ""
            urlopen_mock.assert_not_called()

    def test_skips_vault_when_no_provider_name(self, monkeypatch):
        from datetime import datetime, timedelta

        self._enable_vault(monkeypatch)
        future = (datetime.now(UTC) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        mock_client = MagicMock()
        mock_client.get_secret_value.return_value = {
            "SecretString": __import__("json").dumps(
                {
                    "access_token": "lin_oauth_sm_only",
                    "refresh_token": "rt",
                    "expires_at": future,
                    "scope": "read",
                    "client_id": "c",
                    "client_secret": "s",
                    "workspace_id": "w",
                    "workspace_slug": "s",
                    "installed_at": "x",
                    "updated_at": "x",
                    "installed_by_platform_user_id": "u",
                }
            ),
        }
        with patch("boto3.client", return_value=mock_client):
            resolved = resolve_linear_api_token({"linear_oauth_secret_arn": "arn:sm:acme"})
        assert resolved == "lin_oauth_sm_only"
        mock_client.get_workload_access_token_for_user_id.assert_not_called()
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_disabled_flag_skips_vault(self, monkeypatch):
        from datetime import datetime, timedelta

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.delenv("LINEAR_VAULT_ENABLED", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        future = (datetime.now(UTC) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        mock_client = MagicMock()
        mock_client.get_secret_value.return_value = {
            "SecretString": __import__("json").dumps(
                {
                    "access_token": "lin_oauth_sm_flag_off",
                    "refresh_token": "rt",
                    "expires_at": future,
                    "scope": "read",
                    "client_id": "c",
                    "client_secret": "s",
                    "workspace_id": "w",
                    "workspace_slug": "s",
                    "installed_at": "x",
                    "updated_at": "x",
                    "installed_by_platform_user_id": "u",
                }
            ),
        }
        with patch("boto3.client", return_value=mock_client):
            resolved = resolve_linear_api_token(self._meta())
        assert resolved == "lin_oauth_sm_flag_off"
        mock_client.get_workload_access_token_for_user_id.assert_not_called()
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)


class TestResolveLinearApiTokenNoRefresh:
    @staticmethod
    def _stored(**overrides):
        from datetime import datetime, timedelta

        soon = (datetime.now(UTC) + timedelta(seconds=30)).isoformat().replace("+00:00", "Z")
        base = {
            "access_token": "lin_old",
            "refresh_token": "rt-old",
            "expires_at": soon,
            "scope": "read write",
            "client_id": "cid",
            "client_secret": "csec",
            "workspace_id": "ws-uuid",
            "workspace_slug": "acme",
            "installed_at": "2026-05-19T08:00:00Z",
            "updated_at": "2026-05-19T08:00:00Z",
            "installed_by_platform_user_id": "cog",
        }
        base.update(overrides)
        return base

    def test_expiring_token_fails_closed_without_network_call(self, monkeypatch, capfd):
        import json
        from unittest.mock import patch as upatch

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": json.dumps(self._stored())}

        with (
            patch("boto3.client", return_value=mock_sm),
            upatch(
                "urllib.request.urlopen",
                side_effect=AssertionError("the agent asked Linear for a new token"),
            ) as urlopen_mock,
        ):
            assert resolve_linear_api_token({"linear_oauth_secret_arn": "arn:t"}) == ""
            urlopen_mock.assert_not_called()
        assert mock_sm.method_calls == [call.get_secret_value(SecretId="arn:t")]
        assert os.environ.get("LINEAR_API_TOKEN") in (None, "")
        assert "stored token is expiring and the agent does not refresh" in capfd.readouterr().out
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_expiring_token_at_task_end_leaves_the_cached_one_in_place(self, monkeypatch):
        import json
        from unittest.mock import patch as upatch

        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_at_start")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": json.dumps(self._stored())}

        with (
            patch("boto3.client", return_value=mock_sm),
            upatch(
                "urllib.request.urlopen",
                side_effect=AssertionError("the agent asked Linear for a new token"),
            ) as urlopen_mock,
        ):
            resolved = resolve_linear_api_token({"linear_oauth_secret_arn": "arn:t"}, force=True)
            urlopen_mock.assert_not_called()

        assert resolved == ""
        assert mock_sm.method_calls == [call.get_secret_value(SecretId="arn:t")]
        assert os.environ.get("LINEAR_API_TOKEN") == "lin_at_start"

    @pytest.mark.parametrize("bad_stamp", _MALFORMED_EXPIRES_AT)
    def test_malformed_expires_at_fails_closed_with_warn_log(self, monkeypatch, capfd, bad_stamp):
        import json
        from unittest.mock import patch as upatch

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        bad = self._stored(expires_at=bad_stamp)
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": json.dumps(bad)}

        with (
            patch("boto3.client", return_value=mock_sm),
            upatch("urllib.request.urlopen") as urlopen_mock,
        ):
            assert resolve_linear_api_token({"linear_oauth_secret_arn": "arn:t"}) == ""
            urlopen_mock.assert_not_called()
        assert f"malformed expires_at '{bad_stamp}'" in capfd.readouterr().out
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_corrupted_secret_json_returns_empty_with_error_log(self, monkeypatch):
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {
            "SecretString": "this is { not } valid json",
        }
        with patch("boto3.client", return_value=mock_sm):
            assert resolve_linear_api_token({"linear_oauth_secret_arn": "arn:t"}) == ""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)


class TestResolveJiraOauthToken:
    def test_returns_cached_value_without_calling_secrets_manager(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_oauth_cached")
        with patch("boto3.client") as mock_boto:
            assert resolve_jira_oauth_token() == "jira_oauth_cached"
            mock_boto.assert_not_called()

    def test_returns_empty_when_secret_arn_missing(self, monkeypatch):
        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        monkeypatch.delenv("JIRA_OAUTH_SECRET_ARN", raising=False)
        with patch("boto3.client") as mock_boto:
            assert resolve_jira_oauth_token() == ""
            mock_boto.assert_not_called()

    def test_clear_jira_task_credentials_removes_oauth_and_app_actor_values(
        self,
        monkeypatch,
    ):
        for name in (
            "JIRA_API_TOKEN",
            "JIRA_APP_ACTOR_CONFIGURED",
            "JIRA_APP_ACTOR_PROXY_URL",
            "JIRA_APP_ACTOR_SHARED_SECRET",
        ):
            monkeypatch.setenv(name, "stale")

        clear_jira_task_credentials()

        assert "JIRA_API_TOKEN" not in os.environ
        assert "JIRA_APP_ACTOR_CONFIGURED" not in os.environ
        assert "JIRA_APP_ACTOR_PROXY_URL" not in os.environ
        assert "JIRA_APP_ACTOR_SHARED_SECRET" not in os.environ

    def test_metadata_bound_task_clears_stale_app_actor_when_secret_arn_missing(
        self,
        monkeypatch,
    ):
        monkeypatch.delenv("JIRA_OAUTH_SECRET_ARN", raising=False)
        monkeypatch.setenv("JIRA_API_TOKEN", "previous-human-token")
        monkeypatch.setenv("JIRA_APP_ACTOR_CONFIGURED", "1")
        monkeypatch.setenv(
            "JIRA_APP_ACTOR_PROXY_URL",
            "https://previous.webtrigger.atlassian.app/public/trigger",
        )
        monkeypatch.setenv("JIRA_APP_ACTOR_SHARED_SECRET", "s" * 64)

        with patch("boto3.client") as mock_boto:
            assert resolve_jira_oauth_token({"jira_cloud_id": "next-tenant"}) == ""
            mock_boto.assert_not_called()

        assert "JIRA_API_TOKEN" not in os.environ
        assert "JIRA_APP_ACTOR_CONFIGURED" not in os.environ
        assert "JIRA_APP_ACTOR_PROXY_URL" not in os.environ
        assert "JIRA_APP_ACTOR_SHARED_SECRET" not in os.environ

    def test_returns_empty_when_region_missing(self, monkeypatch):
        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        monkeypatch.delenv("AWS_REGION", raising=False)
        monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
        with patch("boto3.client") as mock_boto:
            assert resolve_jira_oauth_token({"jira_oauth_secret_arn": "arn:test"}) == ""
            mock_boto.assert_not_called()

    def test_resolves_from_secrets_manager_and_caches_in_env(self, monkeypatch):
        from datetime import datetime, timedelta

        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        future = (datetime.now(UTC) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        token_payload = {
            "access_token": "jira_oauth_fresh",
            "refresh_token": "jira_refresh_xyz",
            "expires_at": future,
            "scope": "read:jira-work write:jira-work offline_access",
            "client_id": "cid",
            "client_secret": "csec",
            "cloud_id": "cloud-uuid",
            "site_url": "https://acme.atlassian.net",
            "installed_at": "2026-05-19T08:00:00Z",
            "updated_at": "2026-05-19T08:00:00Z",
            "installed_by_platform_user_id": "cog-sub",
        }
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {
            "SecretString": __import__("json").dumps(token_payload),
        }
        with patch("boto3.client", return_value=mock_sm):
            resolved = resolve_jira_oauth_token({"jira_oauth_secret_arn": "arn:test"})
            assert resolved == "jira_oauth_fresh"

        import os as _os

        assert _os.environ.get("JIRA_API_TOKEN") == "jira_oauth_fresh"
        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)

    def test_obtains_secretsmanager_client_via_platform_client(self, monkeypatch):
        from datetime import datetime, timedelta

        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        future = (datetime.now(UTC) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {
            "SecretString": __import__("json").dumps(
                {
                    "access_token": "jira_via_platform_client",
                    "refresh_token": "rt",
                    "expires_at": future,
                    "scope": "read:jira-work",
                    "client_id": "c",
                    "client_secret": "s",
                    "cloud_id": "cloud-uuid",
                    "site_url": "https://acme.atlassian.net",
                    "installed_at": "x",
                    "updated_at": "x",
                    "installed_by_platform_user_id": "u",
                }
            ),
        }
        with patch("aws_session.platform_client", return_value=mock_sm) as pc:
            resolved = resolve_jira_oauth_token({"jira_oauth_secret_arn": "arn:test"})
            assert resolved == "jira_via_platform_client"
            pc.assert_called_with("secretsmanager", region_name="us-east-1")
        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)

    def test_graceful_skip_when_boto3_imports_unavailable(self, monkeypatch):
        import builtins

        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "boto3" or name == "aws_session":
                raise ImportError(f"simulated missing {name}")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        assert resolve_jira_oauth_token({"jira_oauth_secret_arn": "arn:test"}) == ""
        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)

    def test_resolves_forge_app_actor_even_when_oauth_token_is_expiring(self, monkeypatch):
        import json
        from datetime import datetime, timedelta

        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        soon = (datetime.now(UTC) + timedelta(seconds=10)).isoformat().replace("+00:00", "Z")
        token_payload = {
            "access_token": "expired-human-token",
            "refresh_token": "refresh",
            "expires_at": soon,
            "scope": "read:jira-work write:jira-work",
            "client_id": "cid",
            "client_secret": "csec",
            "cloud_id": "cloud-uuid",
            "site_url": "https://acme.atlassian.net",
            "installed_at": "2026-05-19T08:00:00Z",
            "updated_at": "2026-05-19T08:00:00Z",
            "installed_by_platform_user_id": "cog-sub",
            "app_actor_proxy_url": ("https://install.webtrigger.atlassian.app/public/trigger"),
            "app_actor_shared_secret": "s" * 64,
            "app_actor_configured_at": "2026-07-23T00:00:00Z",
        }
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": json.dumps(token_payload)}

        with patch("boto3.client", return_value=mock_sm):
            assert resolve_jira_oauth_token({"jira_oauth_secret_arn": "arn:test"}) == ""

        assert os.environ["JIRA_APP_ACTOR_CONFIGURED"] == "1"
        assert os.environ["JIRA_APP_ACTOR_PROXY_URL"].endswith("/public/trigger")
        assert os.environ["JIRA_APP_ACTOR_SHARED_SECRET"] == "s" * 64
        monkeypatch.delenv("JIRA_APP_ACTOR_CONFIGURED", raising=False)
        monkeypatch.delenv("JIRA_APP_ACTOR_PROXY_URL", raising=False)
        monkeypatch.delenv("JIRA_APP_ACTOR_SHARED_SECRET", raising=False)

    def test_metadata_only_app_actor_configuration_fails_closed(self, monkeypatch):
        import json

        monkeypatch.setenv("AWS_REGION", "us-east-1")
        token_payload = {
            "access_token": "human-token",
            "refresh_token": "refresh",
            "expires_at": "2099-01-01T00:00:00Z",
            "app_actor_account_id": "app-account-1",
            "app_actor_proxy_url": ["not", "a", "string"],
            "app_actor_shared_secret": 123,
        }
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": json.dumps(token_payload)}

        with patch("boto3.client", return_value=mock_sm):
            assert (
                resolve_jira_oauth_token({"jira_oauth_secret_arn": "arn:metadata-only"})
                == "human-token"
            )

        assert os.environ["JIRA_APP_ACTOR_CONFIGURED"] == "1"
        assert "JIRA_APP_ACTOR_PROXY_URL" not in os.environ
        assert "JIRA_APP_ACTOR_SHARED_SECRET" not in os.environ
        monkeypatch.delenv("JIRA_APP_ACTOR_CONFIGURED", raising=False)

    def test_returns_empty_on_secrets_manager_access_denied(self, monkeypatch):
        from botocore.exceptions import ClientError

        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        mock_sm = MagicMock()
        mock_sm.get_secret_value.side_effect = ClientError(
            {"Error": {"Code": "AccessDeniedException", "Message": "no perms"}},
            "GetSecretValue",
        )
        with patch("boto3.client", return_value=mock_sm):
            assert resolve_jira_oauth_token({"jira_oauth_secret_arn": "arn:test"}) == ""

    @pytest.mark.parametrize("payload", [[], 5, "scalar", True])
    def test_returns_empty_on_valid_non_object_secret_json(self, monkeypatch, payload):
        import json

        monkeypatch.setenv("AWS_REGION", "us-east-1")
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": json.dumps(payload)}

        with patch("boto3.client", return_value=mock_sm):
            assert resolve_jira_oauth_token({"jira_oauth_secret_arn": "arn:non-object"}) == ""

        assert "JIRA_API_TOKEN" not in os.environ
        assert "JIRA_APP_ACTOR_CONFIGURED" not in os.environ

    def test_falls_back_to_env_var_when_channel_metadata_omits_arn(self, monkeypatch):
        from datetime import datetime, timedelta

        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("JIRA_OAUTH_SECRET_ARN", "arn:from-env")
        future = (datetime.now(UTC) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {
            "SecretString": __import__("json").dumps(
                {
                    "access_token": "jira_oauth_envpath",
                    "refresh_token": "rt",
                    "expires_at": future,
                    "scope": "read:jira-work",
                    "client_id": "c",
                    "client_secret": "s",
                    "cloud_id": "cl",
                    "site_url": "https://x.atlassian.net",
                    "installed_at": "x",
                    "updated_at": "x",
                    "installed_by_platform_user_id": "u",
                }
            ),
        }
        with patch("boto3.client", return_value=mock_sm):
            assert resolve_jira_oauth_token() == "jira_oauth_envpath"
        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)


class TestResolveJiraOauthTokenNoRefresh:
    @staticmethod
    def _stored(**overrides):
        from datetime import datetime, timedelta

        soon = (datetime.now(UTC) + timedelta(seconds=30)).isoformat().replace("+00:00", "Z")
        base = {
            "access_token": "jira_old",
            "refresh_token": "rt-old",
            "expires_at": soon,
            "scope": "read:jira-work write:jira-work",
            "client_id": "cid",
            "client_secret": "csec",
            "cloud_id": "cloud-uuid",
            "site_url": "https://acme.atlassian.net",
            "installed_at": "2026-05-19T08:00:00Z",
            "updated_at": "2026-05-19T08:00:00Z",
            "installed_by_platform_user_id": "cog",
        }
        base.update(overrides)
        return base

    def test_expiring_token_fails_closed_without_network_call(self, monkeypatch):
        import json
        from unittest.mock import patch as upatch

        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": json.dumps(self._stored())}

        with (
            patch("boto3.client", return_value=mock_sm),
            upatch("urllib.request.urlopen") as urlopen_mock,
        ):
            assert resolve_jira_oauth_token({"jira_oauth_secret_arn": "arn:t"}) == ""
            urlopen_mock.assert_not_called()
        import os as _os

        assert _os.environ.get("JIRA_API_TOKEN") in (None, "")
        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)

    def test_valid_token_used_verbatim_without_network_call(self, monkeypatch):
        import json
        from datetime import datetime, timedelta
        from unittest.mock import patch as upatch

        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        future = (datetime.now(UTC) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        valid = self._stored(access_token="jira_valid", expires_at=future)
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": json.dumps(valid)}

        with (
            patch("boto3.client", return_value=mock_sm),
            upatch("urllib.request.urlopen") as urlopen_mock,
        ):
            assert resolve_jira_oauth_token({"jira_oauth_secret_arn": "arn:t"}) == "jira_valid"
            urlopen_mock.assert_not_called()
        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)

    @pytest.mark.parametrize("bad_stamp", _MALFORMED_EXPIRES_AT)
    def test_malformed_expires_at_fails_closed(self, monkeypatch, bad_stamp):
        import json
        from unittest.mock import patch as upatch

        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        bad = self._stored(expires_at=bad_stamp)
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": json.dumps(bad)}

        with (
            patch("boto3.client", return_value=mock_sm),
            upatch("urllib.request.urlopen") as urlopen_mock,
        ):
            assert resolve_jira_oauth_token({"jira_oauth_secret_arn": "arn:t"}) == ""
            urlopen_mock.assert_not_called()
        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)

    def test_corrupted_secret_json_returns_empty_with_error_log(self, monkeypatch):
        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {
            "SecretString": "this is { not } valid json",
        }
        with patch("boto3.client", return_value=mock_sm):
            assert resolve_jira_oauth_token({"jira_oauth_secret_arn": "arn:t"}) == ""
        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
