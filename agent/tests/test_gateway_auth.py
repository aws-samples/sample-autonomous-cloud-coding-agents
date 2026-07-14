"""Unit tests for gateway_auth — Cognito M2M token minting for gateway inbound."""

from __future__ import annotations

import io
import json

import gateway_auth
from gateway_auth import get_gateway_bearer_token, reset_token_cache


class _FakeSM:
    def __init__(self, secret_obj):
        self._s = json.dumps(secret_obj)

    def get_secret_value(self, SecretId):  # noqa: N803 - boto3 kwarg name
        return {"SecretString": self._s}


def _patch_secret(monkeypatch, secret_obj, arn="arn:aws:secretsmanager:us-east-1:1:secret:bgagent-linear-gateway-m2m"):
    monkeypatch.setenv(gateway_auth.GATEWAY_M2M_SECRET_ENV, arn)
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    import boto3
    monkeypatch.setattr(boto3, "client", lambda *a, **k: _FakeSM(secret_obj))


def _patch_token_endpoint(monkeypatch, payload):
    def fake_urlopen(req, timeout=0):
        return io.BytesIO(json.dumps(payload).encode())
    monkeypatch.setattr(gateway_auth.urllib.request, "urlopen", fake_urlopen)


class TestGetGatewayBearerToken:
    def setup_method(self):
        reset_token_cache()

    def test_returns_empty_when_substrate_off(self, monkeypatch):
        monkeypatch.delenv(gateway_auth.GATEWAY_M2M_SECRET_ENV, raising=False)
        assert get_gateway_bearer_token() == ""

    def test_mints_token_from_secret_and_endpoint(self, monkeypatch):
        _patch_secret(monkeypatch, {
            "client_id": "cid", "client_secret": "csec",
            "token_url": "https://x.auth.us-east-1.amazoncognito.com/oauth2/token",
            "scope": "bgagent-linear-gateway/invoke",
        })
        _patch_token_endpoint(monkeypatch, {"access_token": "TOK123", "expires_in": 3600})
        assert get_gateway_bearer_token() == "TOK123"

    def test_caches_token_across_calls(self, monkeypatch):
        _patch_secret(monkeypatch, {"client_id": "c", "client_secret": "s", "token_url": "https://t/oauth2/token"})
        calls = {"n": 0}

        def fake_urlopen(req, timeout=0):
            calls["n"] += 1
            return io.BytesIO(json.dumps({"access_token": "TOK", "expires_in": 3600}).encode())
        monkeypatch.setattr(gateway_auth.urllib.request, "urlopen", fake_urlopen)

        assert get_gateway_bearer_token() == "TOK"
        assert get_gateway_bearer_token() == "TOK"
        assert calls["n"] == 1  # second call served from cache

    def test_empty_when_secret_missing_fields(self, monkeypatch):
        _patch_secret(monkeypatch, {"client_id": "c"})  # no client_secret/token_url
        assert get_gateway_bearer_token() == ""

    def test_empty_when_token_endpoint_returns_no_token(self, monkeypatch):
        _patch_secret(monkeypatch, {"client_id": "c", "client_secret": "s", "token_url": "https://t/oauth2/token"})
        _patch_token_endpoint(monkeypatch, {"error": "invalid_client"})
        assert get_gateway_bearer_token() == ""

    def test_empty_when_region_unset(self, monkeypatch):
        monkeypatch.setenv(gateway_auth.GATEWAY_M2M_SECRET_ENV, "arn:x")
        monkeypatch.delenv("AWS_REGION", raising=False)
        monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
        assert get_gateway_bearer_token() == ""
