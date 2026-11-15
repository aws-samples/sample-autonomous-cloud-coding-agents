# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Credential lookups in ``config.py`` against a real Secrets Manager API."""

from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from botocore.exceptions import ClientError

from config import resolve_github_token, resolve_linear_api_token


@pytest.fixture
def create_secret(emulator):
    """Create secrets in the emulator; delete them when the test ends."""
    client = emulator.client("secretsmanager")
    arns: list[str] = []

    def _create(value: str) -> str:
        arn = client.create_secret(Name=f"abca-emu/{uuid.uuid4().hex}", SecretString=value)["ARN"]
        arns.append(arn)
        return arn

    yield _create

    for arn in arns:
        client.delete_secret(SecretId=arn, ForceDeleteWithoutRecovery=True)


@pytest.fixture
def token_env(agent_env, monkeypatch):
    """Both resolvers cache the token in ``os.environ``; undo that after the test.

    They assign ``os.environ[...]`` directly, which pytest only reverts for
    variables ``monkeypatch`` already owns — so claim them here, set to empty
    (which the resolvers treat as "not cached").
    """
    monkeypatch.setenv("GITHUB_TOKEN", "")
    monkeypatch.setenv("LINEAR_API_TOKEN", "")
    monkeypatch.delenv("LINEAR_VAULT_ENABLED", raising=False)
    monkeypatch.delenv("LINEAR_OAUTH_SECRET_ARN", raising=False)


class TestGithubTokenFromSecretsManager:
    def test_token_is_read_by_arn_and_cached_for_git(self, token_env, create_secret, monkeypatch):
        monkeypatch.setenv("GITHUB_TOKEN_SECRET_ARN", create_secret("emulator-github-token"))

        assert resolve_github_token() == "emulator-github-token"
        assert os.environ["GITHUB_TOKEN"] == "emulator-github-token"  # noqa: S105

    def test_cached_token_is_returned_without_another_lookup(
        self, token_env, create_secret, monkeypatch, emulator
    ):
        arn = create_secret("first-value")
        monkeypatch.setenv("GITHUB_TOKEN_SECRET_ARN", arn)
        resolve_github_token()
        emulator.client("secretsmanager").put_secret_value(SecretId=arn, SecretString="rotated")

        assert resolve_github_token() == "first-value"

    def test_missing_secret_raises_the_service_error(self, token_env, monkeypatch):
        monkeypatch.setenv(
            "GITHUB_TOKEN_SECRET_ARN",
            f"arn:aws:secretsmanager:us-east-1:000000000000:secret:absent-{uuid.uuid4().hex}",
        )

        with pytest.raises(ClientError) as raised:
            resolve_github_token()

        assert raised.value.response["Error"]["Code"] == "ResourceNotFoundException"


class TestLinearTokenFromSecretsManager:
    @staticmethod
    def _oauth_secret(**overrides) -> str:
        # expires_at is far enough ahead that the resolver never attempts a
        # refresh, which would call Linear's real OAuth endpoint.
        expires_at = (datetime.now(UTC) + timedelta(days=1)).isoformat().replace("+00:00", "Z")
        return json.dumps(
            {
                "access_token": "emulator-linear-access",
                "refresh_token": "emulator-linear-refresh",
                "expires_at": expires_at,
                "scope": "read,write",
                **overrides,
            }
        )

    def test_unexpired_token_is_returned_from_the_workspace_secret(self, token_env, create_secret):
        arn = create_secret(self._oauth_secret())

        resolved = resolve_linear_api_token({"linear_oauth_secret_arn": arn})

        assert resolved == "emulator-linear-access"
        assert os.environ["LINEAR_API_TOKEN"] == "emulator-linear-access"  # noqa: S105

    # ``shell.log`` writes to fd 1 directly, so these two read it with ``capfd``.
    def test_secret_that_is_not_json_yields_no_token(self, token_env, create_secret, capfd):
        arn = create_secret("not json")

        assert resolve_linear_api_token({"linear_oauth_secret_arn": arn}) == ""
        assert "is not valid JSON" in capfd.readouterr().out

    def test_missing_secret_is_logged_as_an_error_and_yields_no_token(self, token_env, capfd):
        arn = f"arn:aws:secretsmanager:us-east-1:000000000000:secret:absent-{uuid.uuid4().hex}"

        assert resolve_linear_api_token({"linear_oauth_secret_arn": arn}) == ""
        # The resolver escalates to ERROR only for the two "will not self-heal"
        # codes, matching on the code string the service returns.
        assert "ERROR resolve_linear_api_token failed: ResourceNotFoundException" in (
            capfd.readouterr().out
        )
