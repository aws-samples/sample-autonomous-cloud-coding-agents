# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Unit tests for the per-task scoped credential provider (aws_session)."""

from __future__ import annotations

import datetime
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

import aws_session
from aws_session import (
    SESSION_ROLE_ARN_ENV,
    configure_session,
    get_session,
    is_scoped,
    reset_session_cache,
)


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    """Clear cache + session tags between tests."""
    monkeypatch.delenv(SESSION_ROLE_ARN_ENV, raising=False)
    reset_session_cache()
    yield
    reset_session_cache()


# ---------------------------------------------------------------------------
# configure_session
# ---------------------------------------------------------------------------


class TestConfigureSession:
    def test_records_nonempty_tag_values_in_private_state(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        configure_session(user_id="u-1", repo="owner/repo", task_id="t-abc")
        assert aws_session._tags == {
            "user_id": "u-1",
            "repo": "owner/repo",
            "task_id": "t-abc",
        }

    def test_skips_empty_values(self, monkeypatch):
        configure_session(user_id="", repo="", task_id="t-only")
        assert aws_session._tags == {"task_id": "t-only"}

    def test_does_not_leak_tags_into_os_environ(self, monkeypatch):
        """Tenant identifiers must not land in os.environ (subprocesses inherit it)."""
        configure_session(user_id="u-1", repo="owner/repo", task_id="t-abc")
        assert "AGENT_SESSION_USER_ID" not in aws_session.os.environ
        assert "u-1" not in aws_session.os.environ.values()


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

    def test_concurrent_first_call_builds_once(self, monkeypatch):
        """Double-checked locking: 20 threads racing the first get_session()
        must assume the role exactly once and all receive the same session.

        The build sleeps briefly to widen the race window: without the inner
        ``if _session is not None`` recheck under the lock, threads queued on the
        lock would each rebuild — this asserts the recheck holds (one build)."""
        import threading
        import time

        self._arn(monkeypatch)
        start = threading.Barrier(20)  # release all threads simultaneously
        results: list[Any] = []
        lock = threading.Lock()

        def _slow_build(_arn: str) -> Any:
            time.sleep(0.05)
            return MagicMock(name="scoped")

        def _worker() -> None:
            start.wait()
            session = get_session()
            with lock:
                results.append(session)

        with patch("aws_session._build_scoped_session", side_effect=_slow_build) as mk_build:
            threads = [threading.Thread(target=_worker) for _ in range(20)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

        mk_build.assert_called_once()
        assert len(results) == 20
        assert all(r is results[0] for r in results)

    def test_build_failure_fails_closed_when_scoping_requested(self, monkeypatch):
        """When AGENT_SESSION_ROLE_ARN is set, a build failure must FAIL CLOSED
        (raise) and emit a loud signal — never silently run unscoped."""
        self._arn(monkeypatch)
        from aws_session import SessionScopingError

        logged: list[str] = []
        with (
            patch("aws_session._build_scoped_session", side_effect=RuntimeError("boom")),
            patch("shell.log_error_cw", side_effect=lambda msg, **kw: logged.append(msg)),
            pytest.raises(SessionScopingError),
        ):
            get_session()
        # The downgrade attempt was surfaced loudly before failing.
        assert any("SESSION_SCOPING_FAILED" in m for m in logged)


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


class TestTagTruncation:
    def test_overlong_value_truncated_to_256(self, monkeypatch):
        """An over-long repo slug must be clamped to the IAM 256-char limit so
        AssumeRole never fails closed on a long value (documented fail-safe)."""
        from aws_session import _MAX_TAG_VALUE_LEN, _session_tags

        configure_session(user_id="u-1", repo="r" * 300, task_id="t-abc")
        tags = {t["Key"]: t["Value"] for t in _session_tags()}
        assert len(tags["repo"]) == _MAX_TAG_VALUE_LEN == 256
        # Untruncated values are passed through unchanged.
        assert tags["user_id"] == "u-1"
