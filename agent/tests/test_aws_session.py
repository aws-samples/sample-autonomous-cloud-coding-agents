# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

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
    monkeypatch.delenv(SESSION_ROLE_ARN_ENV, raising=False)
    reset_session_cache()
    yield
    reset_session_cache()


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
        configure_session(user_id="u-1", repo="owner/repo", task_id="t-abc")
        assert "AGENT_SESSION_USER_ID" not in aws_session.os.environ
        assert "u-1" not in aws_session.os.environ.values()


class TestSuccessiveTasks:
    def _start(self, task_id: str):
        configure_session(user_id="u-1", repo="owner/repo", task_id=task_id)
        with patch("boto3.Session", return_value=MagicMock(name=f"session-{task_id}")):
            return get_session()

    def test_the_next_task_starts_after_the_previous_one_is_released(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        first = self._start("t-1")
        aws_session.release_session("t-1")

        second = self._start("t-2")

        assert second is not first
        assert aws_session._tags["task_id"] == "t-2"

    def test_a_running_task_still_cannot_change_identity(self, monkeypatch):
        from aws_session import SessionScopingError

        monkeypatch.setenv("AWS_REGION", "us-east-1")
        self._start("t-1")

        with pytest.raises(SessionScopingError):
            configure_session(user_id="u-1", repo="owner/repo", task_id="t-2")

    def test_releasing_another_task_keeps_the_current_session(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        session = self._start("t-1")

        aws_session.release_session("t-other")

        assert aws_session._session is session
        assert aws_session._tags["task_id"] == "t-1"


class TestFailSafe:
    def test_no_role_arn_returns_plain_session(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        fake_session = MagicMock(name="plain-session")
        with patch("boto3.Session", return_value=fake_session) as mk:
            sess = get_session()
        assert sess is fake_session
        assert is_scoped() is False
        mk.assert_called_once()

    def test_blank_role_arn_treated_as_unset(self, monkeypatch):
        monkeypatch.setenv(SESSION_ROLE_ARN_ENV, "   ")
        with patch("boto3.Session", return_value=MagicMock()):
            get_session()
        assert is_scoped() is False


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
        import threading
        import time

        self._arn(monkeypatch)
        start = threading.Barrier(20)
        results: list[Any] = []
        lock = threading.Lock()

        def _slow_build(_arn: str) -> Any:
            time.sleep(0.05)
            return MagicMock(name="scoped")

        def _worker() -> None:
            start.wait(timeout=30)
            session = get_session()
            with lock:
                results.append(session)

        with patch("aws_session._build_scoped_session", side_effect=_slow_build) as mk_build:
            threads = [threading.Thread(target=_worker) for _ in range(20)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=60)

        mk_build.assert_called_once()
        assert len(results) == 20
        assert all(r is results[0] for r in results)

    def test_build_failure_fails_closed_when_scoping_requested(self, monkeypatch):
        self._arn(monkeypatch)
        from aws_session import SessionScopingError

        logged: list[str] = []
        with (
            patch("aws_session._build_scoped_session", side_effect=RuntimeError("boom")),
            patch("shell.log_error_cw", side_effect=lambda msg, **kw: logged.append(msg)),
            pytest.raises(SessionScopingError),
        ):
            get_session()
        assert any("SESSION_SCOPING_FAILED" in m for m in logged)

    def test_role_that_cannot_be_assumed_fails_closed(self, monkeypatch):
        from botocore.exceptions import ClientError

        from aws_session import SessionScopingError

        self._arn(monkeypatch)
        configure_session(user_id="u-1", repo="owner/repo", task_id="t-abc")
        sts = MagicMock(name="sts")
        sts.assume_role.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "not authorized"}}, "AssumeRole"
        )
        logged: list[str] = []

        with (
            patch("boto3.client", return_value=sts),
            patch("shell.log_error_cw", side_effect=lambda msg, **kw: logged.append(msg)),
            pytest.raises(SessionScopingError),
        ):
            get_session()

        sts.assume_role.assert_called_once()
        assert any("SESSION_SCOPING_FAILED" in m for m in logged)
        assert aws_session._session is None
        assert aws_session._scoped is None

    def test_role_that_cannot_be_assumed_stops_run_task(self, monkeypatch):
        from botocore.exceptions import ClientError

        from aws_session import SessionScopingError
        from pipeline import run_task

        self._arn(monkeypatch)
        sts = MagicMock(name="sts")
        sts.assume_role.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "not authorized"}}, "AssumeRole"
        )

        with (
            patch("boto3.client", return_value=sts),
            patch("shell.log_error_cw"),
            patch("pipeline.task_state") as task_state,
            patch("repo.setup_repo") as setup_repo,
            pytest.raises(SessionScopingError),
        ):
            run_task(
                repo_url="owner/repo",
                task_description="fix bug",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="test-id",
            )

        task_state.write_running.assert_not_called()
        setup_repo.assert_not_called()

    def test_assumable_role_is_assumed_once(self, monkeypatch):
        self._arn(monkeypatch)
        configure_session(user_id="u-1", repo="owner/repo", task_id="t-abc")
        sts = MagicMock(name="sts")
        sts.assume_role.return_value = {
            "Credentials": {
                "AccessKeyId": "ASIAEXAMPLE",
                "SecretAccessKey": "secret",
                "SessionToken": "token",
                "Expiration": datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=1),
            }
        }

        with patch("boto3.client", return_value=sts):
            session = get_session()
            frozen = session.get_credentials().get_frozen_credentials()

        assert is_scoped() is True
        assert frozen.access_key == "ASIAEXAMPLE"
        assert sts.assume_role.call_count == 1


class TestRefreshCallback:
    def _setup(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv(SESSION_ROLE_ARN_ENV, "arn:aws:iam::111122223333:role/abca-session")
        configure_session(user_id="u-1", repo="owner/repo", task_id="t-abc")

    def _patched_build(self, monkeypatch, assume_response):
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

        assert captured["method"] == "sts-assume-role-session-tags"
        creds = captured["refresh"]()

        sts_client.assume_role.assert_called_once()
        kwargs = sts_client.assume_role.call_args.kwargs
        assert kwargs["RoleArn"] == "arn:aws:iam::111122223333:role/abca-session"
        assert kwargs["DurationSeconds"] == 3600
        assert kwargs["RoleSessionName"].startswith("abca-t-abc")
        tags = {t["Key"]: t["Value"] for t in kwargs["Tags"]}
        assert tags == {"user_id": "u-1", "repo": "owner/repo", "task_id": "t-abc"}

        assert creds["access_key"] == "AKIA..."
        assert creds["secret_key"] == "secret"  # noqa: S105
        assert creds["token"] == "token"  # noqa: S105
        assert creds["expiry_time"] == expiry.isoformat()

    def test_refresh_can_be_invoked_repeatedly(self, monkeypatch):
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
        from aws_session import _MAX_TAG_VALUE_LEN, _session_tags

        configure_session(user_id="u-1", repo="r" * 300, task_id="t-abc")
        tags = {t["Key"]: t["Value"] for t in _session_tags()}
        assert len(tags["repo"]) == _MAX_TAG_VALUE_LEN == 256
        assert tags["user_id"] == "u-1"


class TestSolutionUserAgent:
    def test_platform_client_carries_md_segment(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        from aws_session import platform_client

        with patch("boto3.client", return_value=MagicMock(name="logs")) as mk:
            platform_client("logs", region_name="us-east-1")

        cfg = mk.call_args.kwargs["config"]
        assert cfg.user_agent_extra == "md/uksb-wt64nei4u6#agent"

    def test_unscoped_tenant_client_carries_md_segment(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        from aws_session import tenant_client

        with patch("boto3.client", return_value=MagicMock(name="ddb")) as mk:
            tenant_client("dynamodb")

        cfg = mk.call_args.kwargs["config"]
        assert cfg.user_agent_extra == "md/uksb-wt64nei4u6#agent"

    def test_caller_config_is_merged_not_overwritten(self, monkeypatch):
        from botocore.config import Config

        monkeypatch.setenv("AWS_REGION", "us-east-1")
        from aws_session import platform_client

        with patch("boto3.client", return_value=MagicMock()) as mk:
            platform_client("logs", config=Config(read_timeout=7, user_agent_extra="caller/1.0"))

        cfg = mk.call_args.kwargs["config"]
        assert cfg.read_timeout == 7
        assert "caller/1.0" in cfg.user_agent_extra
        assert "md/uksb-wt64nei4u6#agent" in cfg.user_agent_extra

    def test_caller_config_without_ua_extra_gets_md_segment(self, monkeypatch):
        from botocore.config import Config

        monkeypatch.setenv("AWS_REGION", "us-east-1")
        from aws_session import platform_client

        with patch("boto3.client", return_value=MagicMock()) as mk:
            platform_client("logs", config=Config(read_timeout=7))

        cfg = mk.call_args.kwargs["config"]
        assert cfg.read_timeout == 7
        assert cfg.user_agent_extra == "md/uksb-wt64nei4u6#agent"

    def test_merge_ua_config_preserves_other_caller_config_keys(self):
        from botocore.config import Config

        import aws_session

        caller = Config(read_timeout=7, connect_timeout=3, user_agent_extra="caller/1.0")
        merged = aws_session._merge_ua_config({"config": caller})["config"]
        assert merged.read_timeout == 7
        assert merged.connect_timeout == 3
        assert "caller/1.0" in merged.user_agent_extra
        assert "md/uksb-wt64nei4u6#agent" in merged.user_agent_extra

    def test_collision_branch_preserves_ua_config_own_keys(self):
        from botocore.config import Config

        import aws_session

        ua_config = Config(user_agent_extra="md/uksb-wt64nei4u6#agent", read_timeout=99)
        caller = Config(user_agent_extra="caller/1.0", connect_timeout=3)
        with patch("ua.client_config", return_value=ua_config):
            merged = aws_session._merge_ua_config({"config": caller})["config"]
        assert merged.read_timeout == 99
        assert merged.connect_timeout == 3
        assert "caller/1.0" in merged.user_agent_extra
        assert "md/uksb-wt64nei4u6#agent" in merged.user_agent_extra

    def test_scoped_session_sets_session_level_extra(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv(SESSION_ROLE_ARN_ENV, "arn:aws:iam::111122223333:role/abca-session")
        configure_session(user_id="u-1", repo="owner/repo", task_id="t-abc")

        fake_botocore_session = MagicMock(name="botocore-session")
        with (
            patch("boto3.client", return_value=MagicMock(name="sts")),
            patch("boto3.Session", return_value=MagicMock(name="boto3-session")),
            patch("botocore.credentials.DeferredRefreshableCredentials"),
            patch("botocore.session.get_session", return_value=fake_botocore_session),
        ):
            get_session()

        assert fake_botocore_session.user_agent_extra == "md/uksb-wt64nei4u6#agent"


class TestRetryMode:
    def test_platform_client_names_the_retry_mode(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        from aws_session import platform_client

        with patch("boto3.client", return_value=MagicMock(name="logs")) as mk:
            platform_client("logs", region_name="us-east-1")

        assert mk.call_args.kwargs["config"].retries == {"mode": "legacy"}

    def test_unscoped_tenant_client_and_resource_name_the_retry_mode(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        from aws_session import tenant_client, tenant_resource

        with patch("boto3.client", return_value=MagicMock(name="ddb")) as client:
            tenant_client("dynamodb")
        with patch("boto3.resource", return_value=MagicMock(name="ddb")) as resource:
            tenant_resource("dynamodb")

        assert client.call_args.kwargs["config"].retries == {"mode": "legacy"}
        assert resource.call_args.kwargs["config"].retries == {"mode": "legacy"}

    def test_caller_retry_settings_survive_and_get_the_mode(self):
        from botocore.config import Config

        caller = Config(read_timeout=7, retries={"total_max_attempts": 1})
        merged = aws_session._merge_ua_config({"config": caller})["config"]
        assert merged.retries == {"mode": "legacy", "total_max_attempts": 1}
        assert merged.read_timeout == 7
        assert merged.user_agent_extra == "md/uksb-wt64nei4u6#agent"

    def test_caller_retry_mode_wins(self):
        from botocore.config import Config

        caller = Config(retries={"mode": "adaptive", "total_max_attempts": 2})
        merged = aws_session._merge_ua_config({"config": caller})["config"]
        assert merged.retries == {"mode": "adaptive", "total_max_attempts": 2}

    def test_scoped_session_and_its_sts_client_name_the_retry_mode(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv(SESSION_ROLE_ARN_ENV, "arn:aws:iam::111122223333:role/abca-session")
        configure_session(user_id="u-1", repo="owner/repo", task_id="t-abc")

        fake_botocore_session = MagicMock(name="botocore-session")
        with (
            patch("boto3.client", return_value=MagicMock(name="sts")) as sts,
            patch("boto3.Session", return_value=MagicMock(name="boto3-session")),
            patch("botocore.credentials.DeferredRefreshableCredentials"),
            patch("botocore.session.get_session", return_value=fake_botocore_session),
        ):
            get_session()

        fake_botocore_session.set_config_variable.assert_any_call("retry_mode", "legacy")
        assert sts.call_args.kwargs["config"].retries == {"mode": "legacy"}

    def test_real_factory_client_resolves_the_legacy_mode(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        from aws_session import platform_client

        client = platform_client("dynamodb", region_name="us-east-1")
        assert client.meta.config.retries["mode"] == "legacy"

    def test_real_session_client_resolves_the_legacy_mode(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        from botocore.config import Config

        session = get_session()
        assert session.client("dynamodb").meta.config.retries["mode"] == "legacy"
        capped = session.client("dynamodb", config=Config(retries={"total_max_attempts": 2}))
        assert capped.meta.config.retries == {"mode": "legacy", "total_max_attempts": 2}

    def test_environment_retry_mode_is_left_to_botocore(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("AWS_RETRY_MODE", "adaptive")
        from aws_session import platform_client

        with patch("boto3.client", return_value=MagicMock(name="logs")) as mk:
            platform_client("logs", region_name="us-east-1")
        assert mk.call_args.kwargs["config"].retries is None
        assert mk.call_args.kwargs["config"].user_agent_extra == "md/uksb-wt64nei4u6#agent"

        real = platform_client("dynamodb", region_name="us-east-1")
        assert real.meta.config.retries["mode"] == "adaptive"
        assert get_session().client("dynamodb").meta.config.retries["mode"] == "adaptive"

    def test_environment_retry_mode_keeps_a_callers_retry_settings(self, monkeypatch):
        from botocore.config import Config

        monkeypatch.setenv("AWS_RETRY_MODE", "standard")
        caller = Config(retries={"total_max_attempts": 1})
        merged = aws_session._merge_ua_config({"config": caller})["config"]
        assert merged.retries == {"total_max_attempts": 1}
