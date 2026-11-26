"""In-process SDK MCP bridge to the AgentCore Gateway (ADR-019 P1).

The Gateway's inbound auth is ``AWS_IAM`` (SigV4). The Claude Agent SDK's
*remote* MCP client (the ``.mcp.json`` ``http`` transport) can only attach a
STATIC ``Authorization`` header, so it cannot talk to a SigV4 endpoint. This
module registers a local :func:`create_sdk_mcp_server` tool that opens a
SigV4-signed Streamable-HTTP MCP session to the Gateway with the compute role's
credentials and proxies the model's call to the federated Lambda-backed tool.

Gated on :data:`GATEWAY_URL_ENV`: when it is absent,
:func:`build_gateway_server` returns ``None``.
"""

from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING, Any

from shell import log, log_error_cw

if TYPE_CHECKING:
    from collections.abc import Generator

    import httpx2

GATEWAY_URL_ENV = "ABCA_TOOL_GATEWAY_URL"

GATEWAY_SERVICE = "bedrock-agentcore"

GATEWAY_SERVER_NAME = "abca_gateway"

REMOTE_REPO_CONFIG_TOOL = "abca_repo_config"

_GATEWAY_TIMEOUT_S = 20.0

#: The server may hold a response stream open. This is the value the mcp 1.x
#: transport applied by default (``sse_read_timeout``).
_GATEWAY_STREAM_READ_TIMEOUT_S = 300.0


def _sigv4_auth(region: str) -> httpx2.Auth:
    import httpx2
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from botocore.session import get_session as get_botocore_session  # noqa: TID251

    credentials = get_botocore_session().get_credentials()
    if credentials is None:
        raise RuntimeError("no AWS credentials available to sign the Gateway request")

    class _SigV4(httpx2.Auth):
        # SigV4 signs a hash of the body, so httpx2 must buffer it before auth.
        requires_request_body = True

        def auth_flow(self, request: httpx2.Request) -> Generator[httpx2.Request, httpx2.Response]:
            # botocore's RefreshableCredentials refreshes when it is frozen.
            frozen = credentials.get_frozen_credentials()
            aws_request = AWSRequest(
                method=request.method,
                url=str(request.url),
                data=request.content,
                headers=dict(request.headers),
            )
            SigV4Auth(frozen, GATEWAY_SERVICE, region).add_auth(aws_request)
            request.headers.update(dict(aws_request.headers))
            yield request

    return _SigV4()


def _match_remote_tool(tools: list[Any], suffix: str) -> str:
    """The Gateway names a Lambda-backed tool ``<targetName>___<toolName>``."""
    matches = [t.name for t in tools if t.name == suffix or t.name.endswith(f"___{suffix}")]
    if not matches:
        available = ", ".join(t.name for t in tools) or "<none>"
        raise RuntimeError(f"Gateway exposes no '{suffix}' tool (available: {available})")
    if len(matches) > 1:
        raise RuntimeError(f"Gateway exposes multiple '{suffix}' tools: {', '.join(matches)}")
    return matches[0]


def _result_to_text(result: Any) -> str:
    structured = getattr(result, "structured_content", None)
    if structured:
        return json.dumps(structured)
    texts = [
        block.text
        for block in (getattr(result, "content", None) or [])
        if getattr(block, "type", None) == "text" and getattr(block, "text", None)
    ]
    return "\n".join(texts)


async def _call_gateway(url: str, region: str, tool_suffix: str, arguments: dict[str, Any]) -> Any:
    import httpx2
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    auth = _sigv4_auth(region)
    timeout = httpx2.Timeout(_GATEWAY_TIMEOUT_S, read=_GATEWAY_STREAM_READ_TIMEOUT_S)
    async with (
        # The transport does not close a client it is handed, so this block does.
        httpx2.AsyncClient(auth=auth, timeout=timeout) as http_client,
        streamable_http_client(url, http_client=http_client) as (read, write),
        ClientSession(read, write, read_timeout_seconds=_GATEWAY_TIMEOUT_S) as session,
    ):
        await session.initialize()
        listed = await session.list_tools()
        remote_name = _match_remote_tool(listed.tools, tool_suffix)
        return await session.call_tool(remote_name, arguments)


_REPO_CONFIG_DESCRIPTION = (
    "Look up the ABCA onboarding configuration for a GitHub repository — its "
    "compute substrate, model, and the build/lint commands ABCA gates PRs "
    "against. Use this to align your build verification with what the "
    'platform CI expects. The "repo" argument is the "owner/name" slug '
    '(e.g. "aws-samples/my-repo") — usually the repository you are working in.'
)


def _expected_gateway_errors() -> tuple[type[BaseException], ...]:
    expected: list[type[BaseException]] = [OSError, TimeoutError]
    try:
        import httpx2

        expected.append(httpx2.HTTPError)
    except ImportError:
        pass
    try:
        from mcp.shared.exceptions import MCPError

        expected.append(MCPError)
    except ImportError:
        pass
    return tuple(expected)


async def _repo_config_impl(gateway_url: str, region: str, args: dict[str, Any]) -> dict[str, Any]:
    repo = str(args.get("repo", "")).strip()
    if not repo:
        return {
            "content": [{"type": "text", "text": "Error: 'repo' argument is required."}],
            "is_error": True,
        }
    try:
        result = await _call_gateway(gateway_url, region, REMOTE_REPO_CONFIG_TOOL, {"repo": repo})
    except Exception as raised:
        # The MCP client runs in anyio task groups, which raise every failure
        # inside an ExceptionGroup, once per nested context manager.
        cause = raised
        while isinstance(cause, ExceptionGroup) and len(cause.exceptions) == 1:
            cause = cause.exceptions[0]
        detail = f"{type(cause).__name__}: {cause}"
        if isinstance(cause, _expected_gateway_errors()):
            log("WARN", f"gateway repo_config failed for {repo!r}: {detail}")
        else:
            log_error_cw(f"gateway repo_config UNEXPECTED failure for {repo!r}: {detail}")
        return {
            "content": [{"type": "text", "text": f"Error calling repo_config: {detail}"}],
            "is_error": True,
        }
    return {
        "content": [{"type": "text", "text": _result_to_text(result)}],
        "is_error": bool(getattr(result, "is_error", False)),
    }


def build_gateway_server() -> Any:
    """Build the in-process SDK MCP server bridging to the AgentCore Gateway.

    Returns the SDK server config for ``ClaudeAgentOptions(mcp_servers=...)``,
    or ``None`` when the bridge is disabled — the Gateway URL env is unset
    (feature off) or the SDK is unavailable.
    """
    gateway_url = os.environ.get(GATEWAY_URL_ENV, "").strip()
    if not gateway_url:
        return None

    try:
        from claude_agent_sdk import create_sdk_mcp_server, tool
    except ImportError as exc:
        log(
            "WARN",
            f"{GATEWAY_URL_ENV} is set but claude_agent_sdk is unavailable "
            f"({exc}); AgentCore Gateway tool bridge disabled",
        )
        return None  # nosemgrep: py-silent-success-masking -- feature-detect logged above; tool disabled not failed  # noqa: E501

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or ""
    if not region:
        log(
            "WARN",
            f"{GATEWAY_URL_ENV} is set but no AWS region is resolvable "
            "(AWS_REGION / AWS_DEFAULT_REGION); AgentCore Gateway tool bridge disabled",
        )
        return None

    @tool("repo_config", _REPO_CONFIG_DESCRIPTION, {"repo": str})
    async def repo_config(args: dict[str, Any]) -> dict[str, Any]:
        return await _repo_config_impl(gateway_url, region, args)

    return create_sdk_mcp_server(name=GATEWAY_SERVER_NAME, tools=[repo_config])
