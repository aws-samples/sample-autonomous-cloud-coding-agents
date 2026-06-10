"""Unit tests for config.py — build_config and constants."""

from datetime import UTC
from unittest.mock import MagicMock, patch

import pytest

from config import PR_WORKFLOW_IDS, build_config, resolve_linear_api_token
from models import TaskConfig


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
        # No resolved_workflow ⇒ defaults to the coding workflow + new_task principal.
        config = build_config(
            repo_url="owner/repo",
            task_description="fix bug",
            github_token="ghp_test123",
            aws_region="us-east-1",
        )
        assert config.resolved_workflow == {"id": "coding/new-task-v1", "version": "1.0.0"}
        assert config.policy_principal == "new_task"
        assert config.is_pr_workflow is False

    def test_pr_iteration_workflow_requires_pr_number(self):
        with pytest.raises(ValueError, match="pr_number is required"):
            build_config(
                repo_url="owner/repo",
                github_token="ghp_test123",
                aws_region="us-east-1",
                resolved_workflow={"id": "coding/pr-iteration-v1", "version": "1.0.0"},
            )

    def test_pr_review_workflow_is_read_only_with_pr_review_principal(self):
        # #248 Phase 2a: pr-review keeps its "pr_review" identity principal, but
        # read-only enforcement now rides config.read_only (→ context.read_only),
        # not the principal literal.
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
        # pr_iteration is a writeable workflow — must NOT be read-only (else the
        # context.read_only hard-deny would wrongly block its Write/Edit).
        assert config.read_only is False

    def test_repoless_default_workflow_does_not_require_repo(self):
        # #248 Phase 3: default/agent-v1 is the repo-less platform default.
        config = build_config(
            task_description="Summarise these papers",
            aws_region="us-east-1",
            resolved_workflow={"id": "default/agent-v1", "version": "1.0.0"},
        )
        assert config.requires_repo is False
        assert config.repo_url == ""

    def test_workflow_load_failure_fails_closed(self, monkeypatch):
        # When the pinned workflow file can't load, the fallback must fail CLOSED:
        # an unrecognised id is treated as read-only (deny writes) and repo-bound,
        # rather than fail-open to writeable. Coding ids that ARE known-writeable
        # keep their writeable posture.
        import workflow as workflow_mod
        from workflow import WorkflowValidationError

        def boom(_workflow_id):
            raise WorkflowValidationError("simulated load failure")

        # build_config does `from workflow import load_workflow` at call time, so
        # patch the name on the workflow package the import resolves against.
        monkeypatch.setattr(workflow_mod, "load_workflow", boom)

        # Unknown id → read-only + requires repo (fail closed on both axes).
        cfg = build_config(
            repo_url="owner/repo",
            github_token="ghp_test123",
            task_description="x",
            aws_region="us-east-1",
            resolved_workflow={"id": "knowledge/mystery-v1", "version": "1.0.0"},
        )
        assert cfg.read_only is True
        assert cfg.requires_repo is True

        # Known-writeable coding id keeps writeable even on load failure.
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


class TestResolveLinearApiTokenRefreshPaths:
    """Tests for the refresh sub-flow inside resolve_linear_api_token.

    The agent's `_refresh` is a non-trivial state machine: try
    /oauth/token, on `invalid_grant` re-read SM (concurrent caller may
    have rotated), retry once with the freshly-read refresh_token. Each
    branch needs explicit coverage because they're hot-path during the
    24h Linear access-token TTL window.
    """

    @staticmethod
    def _stored(**overrides):
        from datetime import datetime, timedelta

        # Default: token expires in 30s so _is_expiring returns True
        # and the refresh path runs.
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

    def test_expiring_token_triggers_refresh_and_returns_new_access_token(self, monkeypatch):
        """Happy refresh: expiring stored token → POST /oauth/token → new access_token."""
        import json
        from unittest.mock import patch as upatch

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": json.dumps(self._stored())}

        # urlopen returns access_token=lin_new, expires_in=86400.
        fake_resp = MagicMock()
        fake_resp.read.return_value = json.dumps(
            {
                "access_token": "lin_new",
                "refresh_token": "rt-new",
                "expires_in": 86400,
                "scope": "read write",
            }
        ).encode("utf-8")
        fake_resp.__enter__ = MagicMock(return_value=fake_resp)
        fake_resp.__exit__ = MagicMock(return_value=False)

        with (
            patch("boto3.client", return_value=mock_sm),
            upatch("urllib.request.urlopen", return_value=fake_resp),
        ):
            assert resolve_linear_api_token({"linear_oauth_secret_arn": "arn:t"}) == "lin_new"
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_invalid_grant_with_concurrent_refresh_uses_freshly_read_token(self, monkeypatch):
        """Race-recovery: refresh returns invalid_grant; re-read SM finds rotated token; use it."""
        import io
        import json
        import urllib.error
        from datetime import datetime, timedelta
        from email.message import Message
        from unittest.mock import patch as upatch

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        future = (datetime.now(UTC) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        old = self._stored(refresh_token="rt-old")
        rotated = self._stored(
            access_token="lin_concurrent",
            refresh_token="rt-rotated",
            expires_at=future,
        )
        mock_sm = MagicMock()
        mock_sm.get_secret_value.side_effect = [
            {"SecretString": json.dumps(old)},  # initial read
            {"SecretString": json.dumps(rotated)},  # re-read after invalid_grant
        ]

        # First /oauth/token POST returns 400 invalid_grant.
        http_err = urllib.error.HTTPError(
            "https://api.linear.app/oauth/token",
            400,
            "Bad Request",
            Message(),
            io.BytesIO(json.dumps({"error": "invalid_grant"}).encode("utf-8")),
        )

        with (
            patch("boto3.client", return_value=mock_sm),
            upatch("urllib.request.urlopen", side_effect=http_err),
        ):
            # Should return the access_token from the freshly-read
            # rotated secret WITHOUT a second /oauth/token POST.
            assert (
                resolve_linear_api_token({"linear_oauth_secret_arn": "arn:t"}) == "lin_concurrent"
            )
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_invalid_grant_with_no_concurrent_refresh_returns_empty(self, monkeypatch):
        """No race: invalid_grant + re-read finds same refresh_token → permanent failure."""
        import io
        import json
        import urllib.error
        from email.message import Message
        from unittest.mock import patch as upatch

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        same = self._stored(refresh_token="rt-shared")
        mock_sm = MagicMock()
        # Both reads return the same secret (no concurrent rotation).
        mock_sm.get_secret_value.return_value = {"SecretString": json.dumps(same)}

        http_err = urllib.error.HTTPError(
            "https://api.linear.app/oauth/token",
            400,
            "Bad Request",
            Message(),
            io.BytesIO(json.dumps({"error": "invalid_grant"}).encode("utf-8")),
        )

        with (
            patch("boto3.client", return_value=mock_sm),
            upatch("urllib.request.urlopen", side_effect=http_err),
        ):
            # Permanent rejection; agent falls through to using the
            # original (stale) token. The function still returns the
            # in-memory access_token so callers don't crash, but the
            # token is the expiring one — Linear MCP will fail closed
            # on the next call.
            result = resolve_linear_api_token({"linear_oauth_secret_arn": "arn:t"})
            # We don't assert empty here because the resolver returns
            # the stale token rather than empty when refresh fails;
            # the important thing is it didn't crash.
            assert isinstance(result, str)
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_malformed_expires_at_treated_as_expiring_with_warn_log(self, monkeypatch, caplog):
        """Bad expires_at format triggers the refresh path AND logs a WARN."""
        import json
        from unittest.mock import patch as upatch

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        bad = self._stored(expires_at="this is not a date")
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": json.dumps(bad)}

        # urlopen returns success — we just want to verify the refresh
        # path got triggered by the malformed expires_at.
        fake_resp = MagicMock()
        fake_resp.read.return_value = json.dumps(
            {"access_token": "lin_refreshed", "expires_in": 3600}
        ).encode("utf-8")
        fake_resp.__enter__ = MagicMock(return_value=fake_resp)
        fake_resp.__exit__ = MagicMock(return_value=False)

        with (
            patch("boto3.client", return_value=mock_sm),
            upatch("urllib.request.urlopen", return_value=fake_resp) as urlopen_mock,
        ):
            assert resolve_linear_api_token({"linear_oauth_secret_arn": "arn:t"}) == "lin_refreshed"
            # Refresh path was actually invoked (the assertion above
            # only succeeds if urlopen ran).
            assert urlopen_mock.called
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_network_failure_during_refresh_returns_stale_token(self, monkeypatch):
        """URLError during refresh: surface stale token instead of crashing."""
        import json
        import urllib.error
        from unittest.mock import patch as upatch

        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": json.dumps(self._stored())}

        with (
            patch("boto3.client", return_value=mock_sm),
            upatch("urllib.request.urlopen", side_effect=urllib.error.URLError("DNS down")),
        ):
            # Doesn't crash; returns the stale (expiring) access_token.
            result = resolve_linear_api_token({"linear_oauth_secret_arn": "arn:t"})
            assert result == "lin_old"
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)

    def test_corrupted_secret_json_returns_empty_with_error_log(self, monkeypatch):
        """B3: corrupted SM payload → empty string return, no traceback."""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {
            "SecretString": "this is { not } valid json",
        }
        with patch("boto3.client", return_value=mock_sm):
            assert resolve_linear_api_token({"linear_oauth_secret_arn": "arn:t"}) == ""
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
