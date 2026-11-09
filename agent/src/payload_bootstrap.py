"""Authenticate deployment settings before reading one task's payload.

The ambient worker role can GetObject only under its deployment's bootstrap/
prefix, with an explicit deny outside that prefix (including public buckets).
Only the coordinator can write those manifests. The payload itself is fetched
without worker credentials, using a single-object capability. Never log it.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener

from shared_constants import SHARED_CONSTANTS

CONTRACT = SHARED_CONSTANTS["payload_bootstrap"]


class PayloadFetchError(RuntimeError):
    """Authenticated bootstrap or payload bytes could not be read; contains no URL."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _object(raw: bytes, label: str) -> dict:
    try:
        value = json.loads(raw)
    except (UnicodeError, ValueError):
        raise PayloadFetchError(f"{label} is not valid JSON") from None
    if not isinstance(value, dict):
        raise PayloadFetchError(f"{label} must contain an object")
    return value


def _manifest(uri: str, backend: str) -> tuple[str, dict]:
    parsed = urlsplit(uri)
    if (
        parsed.scheme != "s3"
        or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", parsed.netloc)
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("bootstrap_s3_uri must identify a deployment manifest")
    key = parsed.path.removeprefix("/")
    expected = re.fullmatch(re.escape(CONTRACT["manifest_prefix"]) + r"([a-f0-9]{64})\.json", key)
    if not expected:
        raise ValueError("bootstrap_s3_uri has an invalid manifest key")

    # Do not use a caller-supplied endpoint or default cached boto3 session.
    from botocore.config import Config

    from aws_session import platform_client

    try:
        client = platform_client(
            "s3",
            config=Config(connect_timeout=5, read_timeout=10, retries={"max_attempts": 2}),
        )
        response = client.get_object(Bucket=parsed.netloc, Key=key)
        body = response["Body"]
        try:
            length = response.get("ContentLength")
            if not isinstance(length, int) or not 0 < length <= CONTRACT["max_manifest_bytes"]:
                raise PayloadFetchError("deployment manifest has an invalid length")
            raw = body.read(CONTRACT["max_manifest_bytes"] + 1)
            if len(raw) != length:
                raise PayloadFetchError("deployment manifest body is incomplete")
        finally:
            body.close()
    except PayloadFetchError:
        raise
    except Exception as exc:
        # SDK/HTTP exception text can contain URLs. Expose only the class.
        raise PayloadFetchError(f"deployment manifest read failed ({type(exc).__name__})") from None
    if hashlib.sha256(raw).hexdigest() != expected[1]:
        raise PayloadFetchError("deployment manifest digest does not match its key")
    manifest = _object(raw, "deployment manifest")
    if manifest.get("version") != CONTRACT["version"] or manifest.get("backend") != backend:
        raise ValueError("deployment manifest version/backend does not match this worker")
    if not isinstance(manifest.get("platform_config"), dict):
        raise ValueError("deployment manifest has no platform configuration")
    return parsed.netloc, manifest["platform_config"]


def _payload_url(url: str, bucket: str, task_id: str) -> None:
    """Permit only the exact object's regional S3 HTTPS endpoint, without redirects."""
    try:
        parsed = urlsplit(url)
        query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
        if any(len(values) != 1 for values in query.values()):
            raise ValueError
        _access_key, _date, region, service, terminator = query["X-Amz-Credential"][0].split("/")
        if (
            service != "s3"
            or terminator != "aws4_request"
            or not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d", region)
            or query["X-Amz-Algorithm"] != ["AWS4-HMAC-SHA256"]
            or query["X-Amz-SignedHeaders"] != ["host"]
            or not re.fullmatch(r"[a-f0-9]{64}", query["X-Amz-Signature"][0])
            or not 0 < int(query["X-Amz-Expires"][0]) <= CONTRACT["url_ttl_seconds"]
            or parsed.scheme != "https"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port is not None
            or parsed.fragment
        ):
            raise ValueError
        suffix = "amazonaws.com.cn" if region.startswith("cn-") else "amazonaws.com"
        host = f"s3.{region}.{suffix}"
        valid = (
            parsed.netloc == f"{bucket}.{host}" and parsed.path == f"/{task_id}/payload.json"
        ) or (parsed.netloc == host and parsed.path == f"/{bucket}/{task_id}/payload.json")
        if not valid:
            raise ValueError
    except (KeyError, IndexError, TypeError, ValueError):
        raise ValueError("payload reference must sign this task's exact S3 object") from None


def _download(url: str) -> dict:
    # Disable environment proxies and redirects. No AWS credential provider is
    # involved; S3 authorizes the coordinator's signature on this one object.
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(url, timeout=10) as response:
            length = int(response.headers.get("Content-Length", "0"))
            if not 0 < length <= CONTRACT["max_payload_bytes"]:
                raise PayloadFetchError("task payload has an invalid length")
            raw = response.read(CONTRACT["max_payload_bytes"] + 1)
            if len(raw) != length:
                raise PayloadFetchError("task payload body is incomplete")
        return _object(raw, "task payload")
    except PayloadFetchError:
        raise
    except HTTPError as exc:
        raise PayloadFetchError(f"task payload download returned HTTP {exc.code}") from None
    except Exception as exc:
        raise PayloadFetchError(f"task payload download failed ({type(exc).__name__})") from None


def resolve_payload_reference(reference: Any, backend: str) -> tuple[dict, dict]:
    if not isinstance(reference, dict) or reference.get("version") != CONTRACT["version"]:
        raise ValueError(
            "payload bootstrap v2 is required; deploy a matching coordinator and image"
        )
    task_id = reference.get("task_id")
    uri = reference.get("bootstrap_s3_uri")
    url = reference.get("payload_url")
    if (
        not isinstance(task_id, str)
        or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id)
        or not isinstance(uri, str)
        or not isinstance(url, str)
    ):
        raise ValueError("payload reference is missing task identity or download coordinates")
    bucket, config = _manifest(uri, backend)
    _payload_url(url, bucket, task_id)
    document = _download(url)
    payload = document.get("agent_payload")
    if (
        document.get("version") != CONTRACT["version"]
        or document.get("task_id") != task_id
        or not isinstance(payload, dict)
        or payload.get("task_id") != task_id
    ):
        raise ValueError("downloaded payload does not belong to the referenced task")
    if document.get("platform_config") != config:
        raise ValueError(
            "payload configuration does not match the authenticated deployment manifest"
        )
    return payload, config


def load_ecs_payload() -> dict:
    """Consume the capability before task subprocesses can inherit the environment."""
    raw = os.environ.pop("AGENT_PAYLOAD_REF", "")
    if not raw:
        raise ValueError("AGENT_PAYLOAD_REF is required; deploy a matching coordinator and image")
    try:
        reference = json.loads(raw)
    except (UnicodeError, ValueError) as exc:
        raise ValueError("AGENT_PAYLOAD_REF is not valid JSON") from exc
    if not isinstance(reference, dict) or reference.get("task_id") != os.environ.get("TASK_ID"):
        raise ValueError("payload reference does not match the ECS task identity")
    payload, _ = resolve_payload_reference(reference, "ecs")
    return payload
