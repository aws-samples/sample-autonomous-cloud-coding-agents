# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Real botocore objects and loopback HTTP exercise the credential boundary."""

from __future__ import annotations

import asyncio
import json
import threading
from datetime import UTC, datetime, timedelta, timezone
from unittest.mock import MagicMock
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

import pytest
from botocore.config import Config
from botocore.credentials import Credentials, DeferredRefreshableCredentials

import aws_session
from microvm_credentials import ScopedCredentialBroker
from microvm_lifecycle import LifecycleUnavailable, MicrovmLifecycle


@pytest.fixture(autouse=True)
def _reset():
    aws_session.reset_session_cache()
    yield
    aws_session.reset_session_cache()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _metadata(key: str) -> dict[str, str]:
    return {
        "access_key": key,
        "secret_key": "synthetic-secret",
        "token": "synthetic-token",
        "expiry_time": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
    }


def _envelope() -> dict[str, str]:
    return {
        "AccessKeyId": "SYNTHETIC",
        "SecretAccessKey": "synthetic-secret",
        "Token": "synthetic-token",
        "Expiration": (datetime.now(UTC) + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def _fetch(broker: ScopedCredentialBroker, *, token: str | None = None, path: str = ""):
    url = broker.environment["AWS_CONTAINER_CREDENTIALS_FULL_URI"] + path
    assert url.startswith("http://127.0.0.1:")
    request = Request(url)  # noqa: S310 — endpoint comes from this test's loopback broker
    if token is not None:
        request.add_header("Authorization", token)
    with build_opener(ProxyHandler({})).open(request, timeout=3) as response:
        assert response.headers["Cache-Control"] == "no-store"
        return json.load(response)


class TestRetainedCredentials:
    def _configure(self, monkeypatch):
        monkeypatch.setenv(
            aws_session.SESSION_ROLE_ARN_ENV, "arn:aws:iam::123456789012:role/session"
        )
        monkeypatch.setenv("AWS_REGION", "us-west-2")
        aws_session.configure_session("user", "owner/repo", "task")
        order = []

        def ambient_refresh():
            order.append("ambient")
            return _metadata(f"AMBIENT_{len(order)}")

        ambient = DeferredRefreshableCredentials(
            method="container-role", refresh_using=ambient_refresh
        )
        sts = MagicMock()
        sts._request_signer._credentials = ambient

        def assume(**_kwargs):
            ambient.get_frozen_credentials()
            order.append("tenant")
            return {
                "Credentials": {
                    "AccessKeyId": f"TENANT_{sts.assume_role.call_count}",
                    "SecretAccessKey": "synthetic-secret",
                    "SessionToken": "synthetic-token",
                    "Expiration": datetime.now(UTC) + timedelta(hours=1),
                }
            }

        sts.assume_role.side_effect = assume
        monkeypatch.setattr("boto3.client", lambda *_a, **_kw: sts)
        return sts, ambient, order

    def test_resume_refreshes_retained_clients_in_order_with_identical_tags(self, monkeypatch):
        sts, ambient, order = self._configure(monkeypatch)
        client = aws_session.tenant_client("s3", config=Config(signature_version="s3v4"))
        resource = aws_session.tenant_resource("dynamodb")
        original = aws_session.get_session().get_credentials()
        before = aws_session.export_microvm_credentials("task")
        tags = sts.assume_role.call_args.kwargs["Tags"]
        assert order == ["ambient", "tenant"]
        order.clear()

        aws_session.refresh_microvm_credentials("task")

        assert order == ["ambient", "tenant"]
        assert client._request_signer._credentials is original
        assert resource.meta.client._request_signer._credentials is original
        assert sts._request_signer._credentials is ambient
        assert aws_session.get_session().get_credentials() is original
        assert (
            sts.assume_role.call_args.kwargs["Tags"]
            == tags
            == [
                {"Key": "user_id", "Value": "user"},
                {"Key": "repo", "Value": "owner/repo"},
                {"Key": "task_id", "Value": "task"},
            ]
        )
        after = aws_session.export_microvm_credentials("task")
        assert before["AccessKeyId"] != after["AccessKeyId"]
        signed = client.generate_presigned_url(
            "get_object", Params={"Bucket": "synthetic", "Key": "synthetic"}
        )
        assert after["AccessKeyId"] in signed
        assert before["AccessKeyId"] not in signed

    @pytest.mark.parametrize("microvm", [False, True])
    def test_short_sts_network_budget_applies_only_to_microvm(self, monkeypatch, microvm):
        import microvm_lifecycle

        sts, _, _ = self._configure(monkeypatch)
        make_client = MagicMock(return_value=sts)
        monkeypatch.setattr("boto3.client", make_client)
        context = microvm_lifecycle.register_task("task", "vm") if microvm else None
        try:
            aws_session.export_microvm_credentials("task")
            config = make_client.call_args.kwargs["config"]
            assert config.connect_timeout == (2 if microvm else 60)
            assert config.read_timeout == (2 if microvm else 60)
            assert config.retries == ({"total_max_attempts": 1} if microvm else None)
        finally:
            if context is not None:
                microvm_lifecycle.unregister_task(context)

    def test_failed_ambient_refresh_never_attempts_tenant_renewal(self, monkeypatch):
        sts, ambient, _ = self._configure(monkeypatch)
        aws_session.export_microvm_credentials("task")
        count = sts.assume_role.call_count
        ambient._refresh_using = MagicMock(side_effect=RuntimeError("synthetic outage"))
        with pytest.raises(RuntimeError, match="synthetic outage"):
            aws_session.refresh_microvm_credentials("task")
        assert sts.assume_role.call_count == count

    def test_failed_tenant_refresh_is_mandatory_even_before_expiry(self, monkeypatch):
        sts, _, _ = self._configure(monkeypatch)
        aws_session.export_microvm_credentials("task")
        sts.assume_role.side_effect = RuntimeError("synthetic denial")
        with pytest.raises(RuntimeError, match="synthetic denial"):
            aws_session.refresh_microvm_credentials("task")

    def test_identity_cannot_change_after_clients_exist(self, monkeypatch):
        self._configure(monkeypatch)
        aws_session.export_microvm_credentials("task")
        aws_session.configure_session("user", "owner/repo", "task")
        with pytest.raises(aws_session.SessionScopingError, match="Cannot change identity"):
            aws_session.configure_session("another", "owner/other", "another-task")
        with pytest.raises(aws_session.SessionScopingError, match="original scoped task"):
            aws_session.export_microvm_credentials("another-task")
        assert aws_session._tags["user_id"] == "user"

    def test_static_runtime_credentials_cannot_claim_wake_renewal(self, monkeypatch):
        sts, _, _ = self._configure(monkeypatch)
        sts._request_signer._credentials = Credentials("STATIC", "synthetic")
        aws_session.export_microvm_credentials("task")
        with pytest.raises(aws_session.SessionScopingError, match="refreshable"):
            aws_session.refresh_microvm_credentials("task")

    def test_absent_scoping_or_ambient_provider_is_rejected(self, monkeypatch):
        self._configure(monkeypatch)
        aws_session.export_microvm_credentials("task")
        aws_session._ambient_credentials.clear()
        with pytest.raises(aws_session.SessionScopingError, match="No runtime"):
            aws_session.refresh_microvm_credentials("task")
        monkeypatch.setattr(aws_session, "_scoped", False)
        with pytest.raises(aws_session.SessionScopingError, match="original scoped task"):
            aws_session.export_microvm_credentials("task")

    def test_expired_replacement_is_rejected(self):
        metadata = _metadata("EXPIRED")
        metadata["expiry_time"] = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
        credentials = DeferredRefreshableCredentials(method="test", refresh_using=lambda: metadata)
        with pytest.raises(RuntimeError, match="still expired"):
            aws_session._locked_refresh(credentials, force=True)

    def test_expiration_is_utc_and_keys_are_a_coherent_pair(self):
        metadata = _metadata("PAIR")
        metadata["expiry_time"] = (
            datetime.now(UTC).astimezone(timezone(timedelta(hours=5))) + timedelta(hours=1)
        ).isoformat()
        credentials = DeferredRefreshableCredentials(method="test", refresh_using=lambda: metadata)
        result = aws_session._locked_refresh(credentials, force=False)
        expiry = datetime.fromisoformat(result["Expiration"])
        assert 3598 < (expiry - datetime.now(UTC)).total_seconds() <= 3600
        assert result["AccessKeyId"] == "PAIR"

    @pytest.mark.parametrize(
        ("remaining_seconds", "force", "must_fail"),
        [(12 * 60, False, False), (5 * 60, False, True), (12 * 60, True, True)],
    )
    def test_refresh_outage_preserves_only_advisory_cached_credentials(
        self, remaining_seconds, force, must_fail
    ):
        metadata = _metadata("CACHED")
        credentials = DeferredRefreshableCredentials(method="test", refresh_using=lambda: metadata)
        aws_session._locked_refresh(credentials, force=False)
        credentials._expiry_time = datetime.now(UTC) + timedelta(seconds=remaining_seconds)
        credentials._refresh_using = MagicMock(side_effect=RuntimeError("synthetic STS outage"))
        if must_fail:
            with pytest.raises(RuntimeError, match="synthetic STS outage"):
                aws_session._locked_refresh(credentials, force=force)
        else:
            result = aws_session._locked_refresh(credentials, force=force)
            assert result["AccessKeyId"] == "CACHED"
            assert result["Token"] == metadata["token"]
        credentials._refresh_using.assert_called_once()


class TestScopedBroker:
    def test_requires_auth_and_scrubs_only_child_environment(self, monkeypatch):
        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "PARENT")
        monkeypatch.setenv("AWS_PROFILE", "operator")
        monkeypatch.setenv("AWS_WEB_IDENTITY_TOKEN_FILE", "/synthetic/token")
        monkeypatch.setenv("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "/synthetic/ambient-token")
        monkeypatch.setenv("AWS_FUTURE_CREDENTIAL_SOURCE", "synthetic")
        monkeypatch.setenv("AWS_REGION", "us-west-2")
        provider = MagicMock(side_effect=_envelope)
        broker = ScopedCredentialBroker(MicrovmLifecycle("task", "vm"), provider=provider)
        try:
            import os

            assert os.environ["AWS_ACCESS_KEY_ID"] == "PARENT"
            assert os.environ["AWS_PROFILE"] == "operator"
            for key in (
                "AWS_ACCESS_KEY_ID",
                "AWS_PROFILE",
                "AWS_WEB_IDENTITY_TOKEN_FILE",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
                "AWS_FUTURE_CREDENTIAL_SOURCE",
            ):
                assert broker.environment[key] == ""
            assert "HOME" not in broker.environment
            assert "AWS_REGION" not in broker.environment
            for token, path, status in [(None, "", 403), ("wrong", "", 403), ("wrong", "/x", 404)]:
                with pytest.raises(HTTPError) as error:
                    _fetch(broker, token=token, path=path)
                assert error.value.code == status
            provider.assert_not_called()
            result = _fetch(broker, token=broker.environment["AWS_CONTAINER_AUTHORIZATION_TOKEN"])
            assert result["AccessKeyId"] == "SYNTHETIC"
        finally:
            broker.close()
            broker.close()
        assert not broker._thread.is_alive()

    def test_provider_failure_has_no_secret_details_or_fallback(self):
        provider = MagicMock(side_effect=RuntimeError("do-not-leak-this"))
        broker = ScopedCredentialBroker(MicrovmLifecycle("task", "vm"), provider=provider)
        try:
            with pytest.raises(HTTPError) as error:
                _fetch(broker, token=broker.environment["AWS_CONTAINER_AUTHORIZATION_TOKEN"])
            assert error.value.code == 503
            assert b"do-not-leak-this" not in error.value.read()
            provider.assert_called_once()
        finally:
            broker.close()

    @pytest.mark.anyio
    async def test_suspend_drains_broker_and_resume_failure_keeps_it_closed(self):
        class Deadline:
            def remaining_s(self) -> float:
                return 60

        lifecycle = MicrovmLifecycle("task", "vm")
        await lifecycle.tool_started("tool")
        lifecycle.park_approval("gate", "tool", Deadline())
        entered, release = threading.Event(), threading.Event()

        def provider():
            entered.set()
            assert release.wait(2)
            return _envelope()

        broker = ScopedCredentialBroker(lifecycle, provider=provider)
        try:
            fetch = asyncio.create_task(
                asyncio.to_thread(
                    _fetch, broker, token=broker.environment["AWS_CONTAINER_AUTHORIZATION_TOKEN"]
                )
            )
            assert await asyncio.to_thread(entered.wait, 1)
            checkpoint = MagicMock()
            suspend = asyncio.create_task(lifecycle.suspend(checkpoint, budget_s=2))
            await asyncio.sleep(0.03)
            checkpoint.assert_not_called()
            release.set()
            await fetch
            await suspend
            checkpoint.assert_called_once()
            with pytest.raises(HTTPError) as error:
                await asyncio.to_thread(
                    _fetch, broker, token=broker.environment["AWS_CONTAINER_AUTHORIZATION_TOKEN"]
                )
            assert error.value.code == 503
            with pytest.raises(RuntimeError, match="renewal failed"):
                await lifecycle.resume(
                    MagicMock(side_effect=RuntimeError("renewal failed")), budget_s=1
                )
            with pytest.raises(LifecycleUnavailable):
                await lifecycle.wait_until_open()
            with pytest.raises(HTTPError) as error:
                await asyncio.to_thread(
                    _fetch, broker, token=broker.environment["AWS_CONTAINER_AUTHORIZATION_TOKEN"]
                )
            assert error.value.code == 503
        finally:
            release.set()
            broker.close()
