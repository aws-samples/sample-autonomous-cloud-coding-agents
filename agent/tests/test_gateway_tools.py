"""Unit tests for the in-process AgentCore Gateway MCP bridge (ADR-019 P1).

Covers the feature gate (URL absent → no server), the tool-result shaping,
SigV4 request signing, federated-tool name matching, and the graceful
error-to-tool-error path. The network round-trip itself (``_call_gateway``) is
mocked — these are unit tests, not an integration test against a live Gateway.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

import gateway_tools as gw


def _run(coro):
    return asyncio.run(coro)


class TestBuildGatewayServer:
    def test_returns_none_when_gateway_url_unset(self, monkeypatch):
        # Feature off (no --context enableToolGateway=true) → nothing offered.
        monkeypatch.delenv(gw.GATEWAY_URL_ENV, raising=False)
        assert gw.build_gateway_server() is None

    def test_returns_none_when_gateway_url_blank(self, monkeypatch):
        monkeypatch.setenv(gw.GATEWAY_URL_ENV, "   ")
        assert gw.build_gateway_server() is None

    def test_builds_sdk_server_when_url_present(self, monkeypatch):
        monkeypatch.setenv(gw.GATEWAY_URL_ENV, "https://gw.example/mcp")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        server = gw.build_gateway_server()
        assert server is not None
        assert server["type"] == "sdk"
        assert server["name"] == gw.GATEWAY_SERVER_NAME

    def test_falls_back_to_aws_default_region(self, monkeypatch):
        # AWS_DEFAULT_REGION-only is a common Lambda/ECS combination; the bridge
        # must build, not silently disable, when only that var is set.
        monkeypatch.setenv(gw.GATEWAY_URL_ENV, "https://gw.example/mcp")
        monkeypatch.delenv("AWS_REGION", raising=False)
        monkeypatch.setenv("AWS_DEFAULT_REGION", "eu-west-1")
        server = gw.build_gateway_server()
        assert server is not None
        assert server["name"] == gw.GATEWAY_SERVER_NAME

    def test_returns_none_and_warns_when_url_set_but_no_region(self, monkeypatch, capfd):
        # N3 region guard: URL set (feature opted in) but no region resolvable is
        # a deployment misconfig. Disable the bridge with a WARN rather than
        # letting it surface later as an opaque SigV4 signing error.
        monkeypatch.setenv(gw.GATEWAY_URL_ENV, "https://gw.example/mcp")
        monkeypatch.delenv("AWS_REGION", raising=False)
        monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
        assert gw.build_gateway_server() is None
        assert "no AWS region is resolvable" in capfd.readouterr().out

    def test_server_name_is_neutral_no_linear(self):
        # The scrubber strip_linear_mcp_servers deletes any entry containing
        # "linear"; the federated bridge must never collide with that marker.
        assert "linear" not in gw.GATEWAY_SERVER_NAME.lower()


class TestRepoConfigImpl:
    def test_missing_repo_arg_is_a_tool_error_without_network_call(self, monkeypatch):
        called = False

        async def _boom(*a, **k):
            nonlocal called
            called = True

        monkeypatch.setattr(gw, "_call_gateway", _boom)
        result = _run(gw._repo_config_impl("https://gw/mcp", "us-east-1", {}))
        assert result["isError"] is True
        assert "repo" in result["content"][0]["text"].lower()
        assert called is False

    def test_happy_path_returns_gateway_structured_content(self, monkeypatch):
        captured = {}

        async def _fake_call(url, region, tool_suffix, arguments):
            captured.update(url=url, region=region, tool_suffix=tool_suffix, arguments=arguments)
            return SimpleNamespace(
                structuredContent={
                    "repo": "aws-samples/x",
                    "onboarded": True,
                    "compute_type": "agentcore",
                },
                content=[],
                isError=False,
            )

        monkeypatch.setattr(gw, "_call_gateway", _fake_call)
        result = _run(
            gw._repo_config_impl("https://gw/mcp", "us-west-2", {"repo": "  aws-samples/x  "})
        )

        # Trimmed repo forwarded to the federated tool by suffix.
        assert captured["arguments"] == {"repo": "aws-samples/x"}
        assert captured["tool_suffix"] == gw.REMOTE_REPO_CONFIG_TOOL
        assert captured["region"] == "us-west-2"
        assert result["isError"] is False
        payload = json.loads(result["content"][0]["text"])
        assert payload["onboarded"] is True
        assert payload["compute_type"] == "agentcore"

    def test_gateway_exception_becomes_tool_error_not_raise(self, monkeypatch):
        async def _fail(*a, **k):
            raise RuntimeError("gateway unreachable")

        monkeypatch.setattr(gw, "_call_gateway", _fail)
        result = _run(gw._repo_config_impl("https://gw/mcp", "us-east-1", {"repo": "org/repo"}))
        assert result["isError"] is True
        assert "gateway unreachable" in result["content"][0]["text"]

    def test_expected_transport_error_logs_warn_not_error(self, monkeypatch, capfd):
        # A TimeoutError is an EXPECTED federation hiccup → WARN, tool error,
        # and (crucially) NOT routed through the loud log_error_cw path.
        loud = []
        monkeypatch.setattr(gw, "log_error_cw", lambda msg: loud.append(msg))

        async def _timeout(*a, **k):
            raise TimeoutError("slow gateway")

        monkeypatch.setattr(gw, "_call_gateway", _timeout)
        result = _run(gw._repo_config_impl("https://gw/mcp", "us-east-1", {"repo": "org/repo"}))
        assert result["isError"] is True
        assert loud == []  # expected error must not page operators
        assert "WARN" in capfd.readouterr().out

    def test_unexpected_error_is_logged_loudly(self, monkeypatch):
        # An AttributeError (unexpected response shape / coding bug) must reach
        # log_error_cw so it surfaces in APPLICATION_LOGS, still without raising.
        loud = []
        monkeypatch.setattr(gw, "log_error_cw", lambda msg: loud.append(msg))

        async def _bug(*a, **k):
            raise AttributeError("unexpected shape")

        monkeypatch.setattr(gw, "_call_gateway", _bug)
        result = _run(gw._repo_config_impl("https://gw/mcp", "us-east-1", {"repo": "org/repo"}))
        assert result["isError"] is True
        assert len(loud) == 1
        assert "UNEXPECTED" in loud[0]
        assert "unexpected shape" in result["content"][0]["text"]

    def test_propagates_remote_is_error_flag(self, monkeypatch):
        async def _err_result(*a, **k):
            return SimpleNamespace(
                structuredContent=None,
                content=[SimpleNamespace(type="text", text="tool blew up")],
                isError=True,
            )

        monkeypatch.setattr(gw, "_call_gateway", _err_result)
        result = _run(gw._repo_config_impl("https://gw/mcp", "us-east-1", {"repo": "org/repo"}))
        assert result["isError"] is True
        assert result["content"][0]["text"] == "tool blew up"


class TestResultToText:
    def test_prefers_structured_content(self):
        r = SimpleNamespace(structuredContent={"a": 1}, content=[])
        assert json.loads(gw._result_to_text(r)) == {"a": 1}

    def test_falls_back_to_text_blocks(self):
        r = SimpleNamespace(
            structuredContent=None,
            content=[
                SimpleNamespace(type="text", text="line1"),
                SimpleNamespace(type="image", text=None),
                SimpleNamespace(type="text", text="line2"),
            ],
        )
        assert gw._result_to_text(r) == "line1\nline2"

    def test_empty_when_no_content(self):
        r = SimpleNamespace(structuredContent=None, content=None)
        assert gw._result_to_text(r) == ""


class TestMatchRemoteTool:
    def test_matches_target_prefixed_name(self):
        full = "abca-repo-config___abca_repo_config"
        tools = [SimpleNamespace(name=full)]
        assert gw._match_remote_tool(tools, "abca_repo_config") == full

    def test_matches_bare_name(self):
        tools = [SimpleNamespace(name="abca_repo_config")]
        assert gw._match_remote_tool(tools, "abca_repo_config") == "abca_repo_config"

    def test_raises_when_absent(self):
        tools = [SimpleNamespace(name="something_else")]
        with pytest.raises(RuntimeError, match="no 'abca_repo_config' tool"):
            gw._match_remote_tool(tools, "abca_repo_config")

    def test_raises_on_ambiguous_match(self):
        tools = [
            SimpleNamespace(name="t1___abca_repo_config"),
            SimpleNamespace(name="t2___abca_repo_config"),
        ]
        with pytest.raises(RuntimeError, match="multiple"):
            gw._match_remote_tool(tools, "abca_repo_config")


class _AsyncCM:
    """Minimal async-context-manager wrapper around a fixed enter value."""

    def __init__(self, value):
        self._value = value

    async def __aenter__(self):
        return self._value

    async def __aexit__(self, *exc):
        return False


class TestCallGateway:
    def test_opens_session_lists_and_calls_matched_tool(self, monkeypatch):
        calls = {}

        class _Session:
            def __init__(self, read, write):
                calls["session_args"] = (read, write)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def initialize(self):
                calls["initialized"] = True

            async def list_tools(self):
                return SimpleNamespace(
                    tools=[SimpleNamespace(name="abca-repo-config___abca_repo_config")]
                )

            async def call_tool(self, name, arguments, read_timeout_seconds=None):
                calls["call"] = (name, arguments)
                return SimpleNamespace(structuredContent={"ok": True}, content=[], isError=False)

        def _fake_transport(url, auth, timeout):
            calls["transport"] = (url, timeout)
            return _AsyncCM(("READ", "WRITE", lambda: "sid"))

        monkeypatch.setattr(gw, "_sigv4_auth", lambda region: "AUTH")
        monkeypatch.setattr("mcp.client.streamable_http.streamablehttp_client", _fake_transport)
        monkeypatch.setattr("mcp.ClientSession", _Session)

        result = _run(
            gw._call_gateway("https://gw/mcp", "us-east-1", "abca_repo_config", {"repo": "o/r"})
        )

        assert calls["transport"][0] == "https://gw/mcp"
        assert calls["initialized"] is True
        # Matched the target-prefixed federated tool name and forwarded args.
        assert calls["call"] == ("abca-repo-config___abca_repo_config", {"repo": "o/r"})
        assert result.structuredContent == {"ok": True}


class TestSigV4Auth:
    def test_signs_request_with_sigv4_headers(self, monkeypatch):
        import httpx
        from botocore.credentials import Credentials

        # Deterministic static credentials — no real AWS lookup.
        creds = Credentials("AKIDEXAMPLE", "secret", "sessiontoken")
        fake_session = SimpleNamespace(get_credentials=lambda: creds)
        monkeypatch.setattr("botocore.session.get_session", lambda: fake_session)

        auth = gw._sigv4_auth("us-east-1")
        request = httpx.Request("POST", "https://gw.example/mcp", content=b'{"jsonrpc":"2.0"}')
        flow = auth.auth_flow(request)
        signed = next(flow)

        assert "Authorization" in signed.headers
        assert signed.headers["Authorization"].startswith("AWS4-HMAC-SHA256")
        assert "gw.example" in signed.headers.get("host", signed.headers.get("Host", ""))
        # The session token must ride along for temporary (assumed-role) creds.
        assert signed.headers.get("X-Amz-Security-Token") == "sessiontoken"
        assert "X-Amz-Date" in signed.headers

    def test_raises_when_no_credentials(self, monkeypatch):
        fake_session = SimpleNamespace(get_credentials=lambda: None)
        monkeypatch.setattr("botocore.session.get_session", lambda: fake_session)
        with pytest.raises(RuntimeError, match="no AWS credentials"):
            gw._sigv4_auth("us-east-1")
