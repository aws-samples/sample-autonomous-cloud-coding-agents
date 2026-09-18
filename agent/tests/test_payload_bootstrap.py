"""Real bootstrap parsing/stream handling with AWS and HTTPS service boundaries stubbed."""

import hashlib
import json
import traceback
from email.message import Message
from io import BytesIO
from unittest.mock import MagicMock
from urllib.error import HTTPError
from urllib.parse import urlencode

import pytest
from botocore.response import StreamingBody
from fastapi.testclient import TestClient

import aws_session
import payload_bootstrap as bootstrap
import server


class HttpBody(BytesIO):
    def __init__(self, raw: bytes, length: int):
        super().__init__(raw)
        self.headers = {"Content-Length": str(length)}


def signed_url(task_id="task-1", bucket="payload-bucket", region="us-east-1"):
    suffix = "amazonaws.com.cn" if region.startswith("cn-") else "amazonaws.com"
    query = urlencode(
        {
            "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
            "X-Amz-Credential": f"EXAMPLE/20260913/{region}/s3/aws4_request",
            "X-Amz-Date": "20260913T120000Z",
            "X-Amz-Expires": "900",
            "X-Amz-SignedHeaders": "host",
            "X-Amz-Signature": "a" * 64,
            "X-Amz-Security-Token": "BEARER-SECRET",
        }
    )
    return f"https://{bucket}.s3.{region}.{suffix}/{task_id}/payload.json?{query}"


@pytest.fixture
def transport(monkeypatch):
    config = {
        "task_table_name": "Tasks",
        "task_events_table_name": "Events",
        "agent_session_role_arn": "arn:aws:iam::123456789012:role/AgentSession",
        "github_token_secret_arn": (
            "arn:aws:secretsmanager:us-west-2:123456789012:secret:github-token-123456"
        ),
    }
    manifest = {"version": 2, "backend": "lambda-microvm", "platform_config": config}
    raw_manifest = json.dumps(manifest).encode()
    key = "bootstrap/" + hashlib.sha256(raw_manifest).hexdigest() + ".json"
    reference = {
        "version": 2,
        "task_id": "task-1",
        "bootstrap_s3_uri": f"s3://payload-bucket/{key}",
        "payload_url": signed_url(),
        "expires_at": 1800000000000,
    }
    payload = {
        "task_id": "task-1",
        "repo_url": "org/repo",
        "prompt": "do it",
        "github_token": "fake",
    }
    document = {
        "version": 2,
        "task_id": "task-1",
        "agent_payload": payload,
        "platform_config": config,
    }
    streams = []
    s3 = MagicMock()

    def get_object(**kwargs):
        assert kwargs == {"Bucket": "payload-bucket", "Key": key}
        body = StreamingBody(BytesIO(raw_manifest), len(raw_manifest))
        streams.append(body)
        return {"Body": body, "ContentLength": len(raw_manifest)}

    s3.get_object.side_effect = get_object
    platform = MagicMock(return_value=s3)
    monkeypatch.setattr(aws_session, "platform_client", platform)
    opener = MagicMock()

    def response(_url, **kwargs):
        assert kwargs == {"timeout": 10}
        raw = json.dumps(document).encode()
        return HttpBody(raw, len(raw))

    opener.open.side_effect = response
    build = MagicMock(return_value=opener)
    monkeypatch.setattr(bootstrap, "build_opener", build)
    return {
        "reference": reference,
        "config": config,
        "payload": payload,
        "document": document,
        "manifest": manifest,
        "s3": s3,
        "platform": platform,
        "opener": opener,
        "build": build,
        "streams": streams,
    }


def test_authenticates_manifest_before_downloading_and_preserves_cross_region_secret(transport):
    payload, config = bootstrap.resolve_payload_reference(transport["reference"], "lambda-microvm")
    assert payload == transport["payload"]
    assert config == transport["config"]
    assert ":us-west-2:" in config["github_token_secret_arn"]
    transport["platform"].assert_called_once()
    assert transport["platform"].call_args.args == ("s3",)
    assert len(transport["streams"]) == 1
    assert transport["streams"][0]._raw_stream.closed
    assert transport["opener"].open.call_args.args == (transport["reference"]["payload_url"],)
    assert isinstance(transport["build"].call_args.args[1], bootstrap._NoRedirect)
    assert transport["build"].call_args.args[0].proxies == {}


@pytest.mark.parametrize("mutation", ["none", "url", "payload", "traversal"])
def test_replacement_reference_binds_task_attempt_and_exact_object(transport, mutation):
    reference = transport["reference"]
    reference["attempt_id"] = "replacement-2"
    reference["payload_url"] = signed_url("task-1/replacement-2")
    transport["payload"]["attempt_id"] = "replacement-2"
    if mutation == "url":
        reference["payload_url"] = signed_url("task-1/replacement-other")
    elif mutation == "payload":
        transport["payload"]["attempt_id"] = "replacement-other"
    elif mutation == "traversal":
        reference["attempt_id"] = "../replacement-other"
    if mutation == "none":
        payload, _ = bootstrap.resolve_payload_reference(reference, "lambda-microvm")
        assert payload["attempt_id"] == "replacement-2"
    else:
        with pytest.raises(ValueError):
            bootstrap.resolve_payload_reference(reference, "lambda-microvm")


def test_large_registry_bundle_reaches_run_mapper_and_mcp_loader(transport, monkeypatch, tmp_path):
    """Resolve real v2 bytes and carry the bundle from /run into the real local loader."""
    from registry.loader import apply_resolved_assets

    runtime = {
        "transport": "http",
        "url": "https://mcp.example.com/tools",
        "headers": {"X-Registry-Context": "x" * 6000},
    }
    assets = [
        {
            "kind": "mcp_server",
            "namespace": "acme",
            "name": "large",
            "version": "1.0.0",
            "runtime": runtime,
        }
    ]
    transport["payload"]["resolved_assets"] = assets
    # Isolate real config installation; no task thread or CloudWatch client runs.
    monkeypatch.setattr(server.os, "environ", dict(server.os.environ))
    monkeypatch.setattr(server, "_debug_cw", lambda *args, **kwargs: None)
    spawn = MagicMock()
    monkeypatch.setattr(server, "_spawn_background", spawn)
    with TestClient(server.app) as client:
        response = client.post(
            server.MICROVM_HOOK_PREFIX + "/run",
            json={
                "microvmId": "mvm-registry",
                "runHookPayload": json.dumps(transport["reference"]),
            },
        )
    assert response.status_code == 200
    spawn.assert_called_once()
    received = spawn.call_args.args[0]["resolved_assets"]
    assert received == assets
    assert apply_resolved_assets(str(tmp_path), received) == ["acme__large"]
    saved = json.loads((tmp_path / ".mcp.json").read_text())
    assert saved["mcpServers"]["acme__large"] == {
        "type": "http",
        "url": runtime["url"],
        "headers": runtime["headers"],
    }


@pytest.mark.parametrize("reference", [{}, {"agent_payload": {}}, {"version": 1}, [], "raw"])
def test_legacy_and_malformed_envelopes_never_read_or_start(reference, transport):
    with pytest.raises(ValueError, match="v2 is required"):
        bootstrap.resolve_payload_reference(reference, "lambda-microvm")
    transport["platform"].assert_not_called()


@pytest.mark.parametrize(
    "uri",
    [
        "http://169.254.169.254/metadata",
        "s3://payload-bucket/task-2/payload.json",
        "s3://payload-bucket/bootstrap/../task-2/payload.json",
        "s3://payload-bucket/bootstrap/not-a-digest.json",
        "s3://payload-bucket/bootstrap/" + "a" * 64 + ".json?versionId=evil",
    ],
)
def test_manifest_shape_rejects_other_objects_before_aws(transport, uri):
    transport["reference"]["bootstrap_s3_uri"] = uri
    with pytest.raises(ValueError):
        bootstrap.resolve_payload_reference(transport["reference"], "lambda-microvm")
    transport["platform"].assert_not_called()


def test_foreign_manifest_denial_prevents_download_and_config_install(
    transport, monkeypatch, capfd
):
    transport["s3"].get_object.side_effect = PermissionError("AccessDenied")
    install = MagicMock()
    spawn = MagicMock()
    monkeypatch.setattr(server, "_install_platform_config", install)
    monkeypatch.setattr(server, "_spawn_background", spawn)
    with TestClient(server.app) as client:
        response = client.post(
            server.MICROVM_HOOK_PREFIX + "/run",
            json={
                "microvmId": "mvm",
                "runHookPayload": json.dumps(transport["reference"]),
            },
        )
    assert response.status_code == 500
    assert response.json()["code"] == "MICROVM_RUN_PAYLOAD_UNREADABLE"
    install.assert_not_called()
    spawn.assert_not_called()
    transport["opener"].open.assert_not_called()
    assert "BEARER-SECRET" not in capfd.readouterr().out


def test_run_hook_never_logs_the_chained_http_error_url(transport, monkeypatch, capfd):
    url = transport["reference"]["payload_url"]
    transport["opener"].open.side_effect = HTTPError(url, 403, url, Message(), None)
    install = MagicMock()
    monkeypatch.setattr(server, "_install_platform_config", install)
    with TestClient(server.app) as client:
        response = client.post(
            server.MICROVM_HOOK_PREFIX + "/run",
            json={
                "microvmId": "mvm",
                "runHookPayload": json.dumps(transport["reference"]),
            },
        )
    assert response.status_code == 500
    install.assert_not_called()
    assert "BEARER-SECRET" not in response.text
    assert "BEARER-SECRET" not in capfd.readouterr().out


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d["platform_config"].update(
            github_token_secret_arn="arn:aws:secretsmanager:us-west-2:123456789012:secret:bgagent-linear-oauth-victim"
        ),
        lambda d: d.update(task_id="task-2"),
        lambda d: d["agent_payload"].update(task_id="task-2"),
        lambda d: d.update(platform_config=None),
    ],
)
def test_same_account_workspace_redirect_or_task_substitution_is_rejected(transport, mutate):
    # Detach the document from the fixture's authenticated manifest values.
    transport["document"]["platform_config"] = dict(transport["config"])
    mutate(transport["document"])
    with pytest.raises(ValueError):
        bootstrap.resolve_payload_reference(transport["reference"], "lambda-microvm")


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data",
        signed_url(task_id="task-2"),
        signed_url(bucket="another-bucket"),
        signed_url().replace("amazonaws.com/", "amazonaws.com.evil.example/"),
        signed_url().replace("https://", "https://user@"),
        signed_url().replace("amazonaws.com/", "amazonaws.com:443/"),
        signed_url() + "#fragment",
        signed_url() + "&X-Amz-Signature=" + "b" * 64,
        signed_url().replace("X-Amz-Expires=900", "X-Amz-Expires=999999"),
    ],
)
def test_download_reference_rejects_wrong_task_hosts_redirect_coordinates_and_ambiguity(
    transport, url
):
    transport["reference"]["payload_url"] = url
    with pytest.raises(ValueError, match="exact S3 object"):
        bootstrap.resolve_payload_reference(transport["reference"], "lambda-microvm")
    transport["opener"].open.assert_not_called()


@pytest.mark.parametrize(
    "raw,length",
    [
        (b'{"truncated":', 13),
        (b"\xff", 1),
        (b"[]", 2),
        (b"{}", 40),
        (b"{}", 0),
        (b"{}", bootstrap.CONTRACT["max_payload_bytes"] + 1),
    ],
)
def test_bad_payload_bytes_are_unreadable_not_bad_envelopes(transport, raw, length):
    body = HttpBody(raw, length)
    transport["opener"].open.side_effect = None
    transport["opener"].open.return_value = body
    with pytest.raises(bootstrap.PayloadFetchError):
        bootstrap.resolve_payload_reference(transport["reference"], "lambda-microvm")
    assert body.closed


@pytest.mark.parametrize("mode", ["digest", "short", "closed", "too_large", "array"])
def test_bad_manifest_streams_fail_before_download_and_are_closed(transport, mode):
    raw = b"[]" if mode == "array" else b"{}"
    length = 100 if mode == "short" else len(raw)
    if mode == "too_large":
        length = bootstrap.CONTRACT["max_manifest_bytes"] + 1
    body = StreamingBody(BytesIO(raw), length)
    if mode == "closed":
        body.close()
    transport["s3"].get_object.side_effect = None
    transport["s3"].get_object.return_value = {"Body": body, "ContentLength": length}
    with pytest.raises(bootstrap.PayloadFetchError):
        bootstrap.resolve_payload_reference(transport["reference"], "lambda-microvm")
    assert body._raw_stream.closed
    transport["opener"].open.assert_not_called()


@pytest.mark.parametrize("code", [301, 307, 403, 500])
def test_redirect_expiry_and_service_errors_do_not_echo_capabilities(transport, code):
    url = transport["reference"]["payload_url"]
    transport["opener"].open.side_effect = HTTPError(url, code, url, Message(), None)
    with pytest.raises(bootstrap.PayloadFetchError, match=f"HTTP {code}") as error:
        bootstrap.resolve_payload_reference(transport["reference"], "lambda-microvm")
    assert "BEARER-SECRET" not in str(error.value)
    # ECS's Python boot command can print an uncaught exception. Its formatted
    # traceback must be safe too, not just the MicroVM route's JSON response.
    assert "BEARER-SECRET" not in "".join(traceback.format_exception(error.value))
    assert bootstrap._NoRedirect().redirect_request(None, None, code, "", {}, url) is None


def test_ecs_consumes_reference_before_running_code(transport, monkeypatch):
    monkeypatch.setenv("TASK_ID", "task-1")
    monkeypatch.setenv("AGENT_PAYLOAD_REF", json.dumps(transport["reference"]))
    resolve = MagicMock(return_value=(transport["payload"], {}))
    monkeypatch.setattr(bootstrap, "resolve_payload_reference", resolve)
    assert bootstrap.load_ecs_payload() == transport["payload"]
    import os

    assert "AGENT_PAYLOAD_REF" not in os.environ
    assert resolve.call_args.args[1] == "ecs"


def test_ecs_rejects_another_tasks_reference(transport, monkeypatch):
    monkeypatch.setenv("TASK_ID", "task-2")
    monkeypatch.setenv("AGENT_PAYLOAD_REF", json.dumps(transport["reference"]))
    with pytest.raises(ValueError, match="ECS task identity"):
        bootstrap.load_ecs_payload()
    transport["platform"].assert_not_called()
