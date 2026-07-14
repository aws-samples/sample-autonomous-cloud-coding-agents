"""Cognito machine-to-machine token minting for AgentCore Gateway inbound auth.

Per-workspace Linear MCP gateways use a CUSTOM_JWT inbound authorizer (3LO
outbound is rejected with AWS_IAM — see docs/design/AGENTCORE_GATEWAY_MCP_SPIKE.md
F15/F16). The agent otherwise runs on IAM credentials with no JWT, so it mints a
bearer token from a Cognito client_credentials (machine-to-machine) app client
whose ``client_id`` the gateway's ``allowedClients`` trusts.

The M2M client id/secret/token-url live in the Secrets Manager secret named by
``LINEAR_GATEWAY_M2M_SECRET_ARN`` (set by the CDK stack only when the Linear
gateway substrate is deployed). When that env var is empty the substrate is off
and callers fall back to the direct ``mcp.linear.app`` path.
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.parse
import urllib.request

from shell import log

#: Env var naming the Secrets Manager secret with the M2M client bundle.
GATEWAY_M2M_SECRET_ENV = "LINEAR_GATEWAY_M2M_SECRET_ARN"  # noqa: S105 — env var *name*, not a secret value

#: Cache the minted token in-process. client_credentials tokens are ~1h; we
#: refresh a minute early. Keyed by nothing (one M2M client per deployment).
_token_cache: dict[str, object] = {"access_token": "", "expires_at": 0.0}

#: Refresh margin (seconds) before the cached token's expiry.
_REFRESH_MARGIN_S = 60


def _load_m2m_bundle() -> dict[str, str] | None:
    """Fetch + parse the M2M client bundle from Secrets Manager.

    Returns the parsed dict (client_id, client_secret, token_url, scope), or
    None when the substrate is off (env unset) or the secret can't be read —
    the caller then uses the direct Linear MCP path.
    """
    secret_arn = os.environ.get(GATEWAY_M2M_SECRET_ENV, "")
    if not secret_arn:
        return None
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if not region:
        log("WARN", "gateway_auth: AWS_REGION not set; cannot fetch M2M secret")
        return None
    try:
        import boto3
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as e:  # pragma: no cover - boto3 always present in the image
        log("WARN", f"gateway_auth: boto3 unavailable ({e})")
        return None
    try:
        sm = boto3.client("secretsmanager", region_name=region)
        resp = sm.get_secret_value(SecretId=secret_arn)
        bundle = json.loads(resp["SecretString"])
    except (BotoCoreError, ClientError, KeyError, json.JSONDecodeError, TypeError) as e:
        log("WARN", f"gateway_auth: could not read/parse M2M secret: {type(e).__name__}: {e}")
        return None
    if not (bundle.get("client_id") and bundle.get("client_secret") and bundle.get("token_url")):
        log("WARN", "gateway_auth: M2M secret missing client_id/client_secret/token_url")
        return None
    return bundle


def _request_token(bundle: dict[str, str]) -> tuple[str, float] | None:
    """POST client_credentials to the Cognito token endpoint.

    Returns (access_token, expires_at_epoch) or None on failure.
    """
    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        **({"scope": bundle["scope"]} if bundle.get("scope") else {}),
    }).encode("utf-8")
    # Cognito wants HTTP Basic auth (client_id:client_secret) for confidential clients.
    basic = base64.b64encode(f"{bundle['client_id']}:{bundle['client_secret']}".encode()).decode()
    # token_url comes from our own CDK-managed secret (a Cognito https endpoint),
    # not user input — S310 scheme-audit is not a concern here.
    req = urllib.request.Request(  # noqa: S310 — trusted https Cognito token URL from our secret
        bundle["token_url"],
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {basic}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 — trusted https Cognito token URL
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        log("WARN", f"gateway_auth: token request failed: {type(e).__name__}: {e}")
        return None
    token = payload.get("access_token", "")
    if not token:
        log("WARN", "gateway_auth: token endpoint returned no access_token")
        return None
    expires_in = int(payload.get("expires_in", 3600))
    return token, time.time() + expires_in


def get_gateway_bearer_token() -> str:
    """Return a valid M2M bearer token for gateway inbound auth, or "".

    Empty string means the Linear gateway substrate is off (or token minting
    failed) — the caller should use the direct ``mcp.linear.app`` path. Caches
    the token in-process and refreshes a minute before expiry.
    """
    now = time.time()
    cached = str(_token_cache.get("access_token") or "")
    if cached and float(_token_cache.get("expires_at") or 0) - _REFRESH_MARGIN_S > now:
        return cached

    bundle = _load_m2m_bundle()
    if bundle is None:
        return ""
    result = _request_token(bundle)
    if result is None:
        return ""
    token, expires_at = result
    _token_cache["access_token"] = token
    _token_cache["expires_at"] = expires_at
    log("TASK", "gateway_auth: minted M2M gateway bearer token")
    return token


def reset_token_cache() -> None:
    """Clear the in-process token cache (tests)."""
    _token_cache["access_token"] = ""
    _token_cache["expires_at"] = 0.0
