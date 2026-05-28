# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Unit tests for the per-task scoped credential provider (aws_session)."""

from __future__ import annotations

import datetime
from unittest.mock import MagicMock, patch

import pytest

import aws_session
from aws_session import (
    REPO_ENV,
    SESSION_ROLE_ARN_ENV,
    TASK_ID_ENV,
    USER_ID_ENV,
    configure_session,
    get_session,
    is_scoped,
    reset_session_cache,
)


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    """Clear cache + session-tag env between tests."""
    for var in (SESSION_ROLE_ARN_ENV, USER_ID_ENV, REPO_ENV, TASK_ID_ENV):
        monkeypatch.delenv(var, raising=False)
    reset_session_cache()
    yield
    reset_session_cache()


# ---------------------------------------------------------------------------
# configure_session
# ---------------------------------------------------------------------------


class TestConfigureSession:
    def test_exports_nonempty_tag_values(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        configure_session(user_id="u-1", repo="owner/repo", task_id="t-abc")
        assert aws_session.os.environ[USER_ID_ENV] == "u-1"
        assert aws_session.os.environ[REPO_ENV] == "owner/repo"
        assert aws_session.os.environ[TASK_ID_ENV] == "t-abc"

    def test_skips_empty_values(self, monkeypatch):
        configure_session(user_id="", repo="", task_id="t-only")
        assert USER_ID_ENV not in aws_session.os.environ
        assert REPO_ENV not in aws_session.os.environ
        assert aws_session.os.environ[TASK_ID_ENV] == "t-only"


# ---------------------------------------------------------------------------
# Fail-safe: no SessionRole ARN → plain session, never scoped
# ---------------------------------------------------------------------------


class TestFailSafe:
    def test_no_role_arn_returns_plain_session(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        fake_session = MagicMock(name="plain-session")
        with patch("boto3.Session", return_value=fake_session) as mk:
            sess = get_session()
        assert sess is fake_session
        assert is_scoped() is False
        # Plain session built with region, NOT via assume-role.
        mk.assert_called_once()

    def test_blank_role_arn_treated_as_unset(self, monkeypatch):
        monkeypatch.setenv(SESSION_ROLE_ARN_ENV, "   ")
        with patch("boto3.Session", return_value=MagicMock()):
            get_session()
        assert is_scoped() is False


# ---------------------------------------------------------------------------
# Scoped: SessionRole ARN set → refreshable assumed-role session
# ---------------------------------------------------------------------------


class TestScopedSession:
    def _arn(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv(SESSION_ROLE_ARN_ENV, "arn:aws:iam::111122223333:role/abca-session")

    def test_builds_scoped_session_when_arn_present(self, monkeypatch):
        self._arn(monkeypatch)
        configure_session(user_id="u-1", repo="owner/repo", task_id="t-abc")

        with patch("aws_session._build_scoped_session") as mk_build:
            sentinel = MagicMock(name="scoped-session")
            mk_build.return_value = sentinel
            sess = get_session()

        assert sess is sentinel
        assert is_scoped() is True
        mk_build.assert_called_once_with("arn:aws:iam::111122223333:role/abca-session")

    def test_session_is_cached(self, monkeypatch):
        self._arn(monkeypatch)
        with patch("aws_session._build_scoped_session") as mk_build:
            mk_build.return_value = MagicMock()
            first = get_session()
            second = get_session()
        assert first is second
        mk_build.assert_called_once()

    def test_build_failure_falls_back_to_plain(self, monkeypatch):
        self._arn(monkeypatch)
        with (
            patch("aws_session._build_scoped_session", side_effect=RuntimeError("boom")),
            patch("boto3.Session", return_value=MagicMock(name="fallback")),
        ):
            get_session()
        # Must NOT crash the agent; degrades to unscoped.
        assert is_scoped() is False


# ---------------------------------------------------------------------------
# Refresh callback: re-assumes with session tags before the 1h chaining cap
# ---------------------------------------------------------------------------


class TestRefreshCallback:
    def _setup(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv(SESSION_ROLE_ARN_ENV, "arn:aws:iam::111122223333:role/abca-session")
        configure_session(user_id="u-1", repo="owner/repo", task_id="t-abc")

    def _patched_build(self, monkeypatch, assume_response):
        """Build a real scoped session but with sts + botocore mocked.

        Returns (sts_client_mock, captured_refresh_callable).
        """
        self._setup(monkeypatch)

        sts_client = MagicMock(name="sts")
        sts_client.assume_role.return_value = assume_response

        captured = {}

        class _FakeDeferred:
            def __init__(self, method, refresh_using):
                captured["method"] = method
                captured["refresh"] = refresh_using

        fake_botocore_session = MagicMock(name="botocore-session")

        with (
            patch("boto3.client", return_value=sts_client),
            patch("boto3.Session", return_value=MagicMock(name="boto3-session")),
            patch("botocore.credentials.DeferredRefreshableCredentials", _FakeDeferred),
            patch("botocore.session.get_session", return_value=fake_botocore_session),
        ):
            get_session()

        return sts_client, captured

    def test_refresh_calls_assume_role_with_session_tags(self, monkeypatch):
        expiry = datetime.datetime(2026, 1, 1, 12, 0, 0, tzinfo=datetime.UTC)
        resp = {
            "Credentials": {
                "AccessKeyId": "AKIA...",
                "SecretAccessKey": "secret",
                "SessionToken": "token",
                "Expiration": expiry,
            }
        }
        sts_client, captured = self._patched_build(monkeypatch, resp)

        # The deferred provider was wired with our refresh callable.
        assert captured["method"] == "sts-assume-role-session-tags"
        creds = captured["refresh"]()

        # Re-assumes and returns botocore-shaped dict.
        sts_client.assume_role.assert_called_once()
        kwargs = sts_client.assume_role.call_args.kwargs
        assert kwargs["RoleArn"] == "arn:aws:iam::111122223333:role/abca-session"
        assert kwargs["DurationSeconds"] == 3600  # role-chaining cap
        assert kwargs["RoleSessionName"].startswith("abca-t-abc")
        tags = {t["Key"]: t["Value"] for t in kwargs["Tags"]}
        assert tags == {"user_id": "u-1", "repo": "owner/repo", "task_id": "t-abc"}

        assert creds["access_key"] == "AKIA..."
        assert creds["secret_key"] == "secret"  # noqa: S105
        assert creds["token"] == "token"  # noqa: S105
        assert creds["expiry_time"] == expiry.isoformat()

    def test_refresh_can_be_invoked_repeatedly(self, monkeypatch):
        """Simulates a >1h task: botocore calls refresh again near expiry."""
        expiry = datetime.datetime(2026, 1, 1, 12, 0, 0, tzinfo=datetime.UTC)
        resp = {
            "Credentials": {
                "AccessKeyId": "AKIA...",
                "SecretAccessKey": "secret",
                "SessionToken": "token",
                "Expiration": expiry,
            }
        }
        sts_client, captured = self._patched_build(monkeypatch, resp)
        captured["refresh"]()
        captured["refresh"]()
        assert sts_client.assume_role.call_count == 2

    def test_omits_empty_tags(self, monkeypatch):
        """Only configured tags are sent (no empty-value tags)."""
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv(SESSION_ROLE_ARN_ENV, "arn:aws:iam::111122223333:role/abca-session")
        configure_session(user_id="u-1", repo="", task_id="t-abc")
        expiry = datetime.datetime(2026, 1, 1, tzinfo=datetime.UTC)
        resp = {
            "Credentials": {
                "AccessKeyId": "k",
                "SecretAccessKey": "s",
                "SessionToken": "t",
                "Expiration": expiry,
            }
        }

        sts_client = MagicMock()
        sts_client.assume_role.return_value = resp
        captured = {}

        class _FakeDeferred:
            def __init__(self, method, refresh_using):
                captured["refresh"] = refresh_using

        with (
            patch("boto3.client", return_value=sts_client),
            patch("boto3.Session", return_value=MagicMock()),
            patch("botocore.credentials.DeferredRefreshableCredentials", _FakeDeferred),
            patch("botocore.session.get_session", return_value=MagicMock()),
        ):
            get_session()
        captured["refresh"]()

        tags = {t["Key"]: t["Value"] for t in sts_client.assume_role.call_args.kwargs["Tags"]}
        assert tags == {"user_id": "u-1", "task_id": "t-abc"}
        assert "repo" not in tags
