"""In-process SDK MCP bridge to the AgentCore Gateway (ADR-019 P1).

ABCA federates its agent-facing MCP tools behind a single managed **AgentCore
Gateway** whose inbound auth is ``AWS_IAM`` (SigV4). The Claude Agent SDK's
*remote* MCP client (the ``.mcp.json`` ``http`` transport) can only attach a
STATIC ``Authorization`` header, so it cannot talk to a SigV4 endpoint — every
request needs a fresh signature over its own body + timestamp.

Rather than run a separate stdio proxy subprocess (the shape ADR-019 originally
sketched), this module bridges **in-process**: the agent process already holds
the compute role's AWS credentials, so it registers a local
:func:`create_sdk_mcp_server` tool (the same mechanism as
``clarification_tool.py``) whose implementation:

1. resolves the compute role's credentials + region,
2. opens a SigV4-signed Streamable-HTTP MCP session to the Gateway
   (``service = "bedrock-agentcore"``), and
3. proxies the model's call to the federated Lambda-backed tool, returning its
   result as an SDK tool result.

The credentials never leave the process and there is no subprocess to manage.
The whole bridge is gated on :data:`GATEWAY_URL_ENV`: absent (local dev, tests,
or a deploy without ``--context enableToolGateway=true``) → :func:`build_gateway_server`
returns ``None`` and the runner simply doesn't offer the tool.

This is the P1 slice — a single read-only tool (``abca_repo_config``). The
bridge discovers the federated tool by suffix (the Gateway exposes it as
``<targetName>___<toolName>``) so the agent side stays decoupled from the exact
target name the CDK picks.

Counterparts: ``cdk/src/constructs/tool-gateway.ts`` (the Gateway + target),
``cdk/src/handlers/tool-repo-config.ts`` (the Lambda the tool routes to).
"""

from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING, Any

from shell import log, log_error_cw

if TYPE_CHECKING:
    from collections.abc import Generator

    import httpx2

#: Env var carrying the Gateway MCP endpoint URL. Set on the compute
#: environment (AgentCore runtime env / ECS container) by the CDK
#: ``ToolGateway`` wiring ONLY under ``--context enableToolGateway=true``; its
#: absence disables the whole bridge.
GATEWAY_URL_ENV = "ABCA_TOOL_GATEWAY_URL"

#: SigV4 signing service name for AgentCore Gateway data-plane invokes.
GATEWAY_SERVICE = "bedrock-agentcore"

#: In-process SDK MCP server name. The SDK surfaces each tool as
#: ``mcp__<server>__<tool>``; the model therefore sees
#: ``mcp__abca_gateway__repo_config``. Named neutrally as a general convention
#: (no channel-specific term like "linear"). NOTE: this is a naming convention,
#: NOT something ``strip_linear_mcp_servers`` enforces — that scrubber only
#: rewrites the on-disk ``.mcp.json`` in the cloned repo and never sees this
#: in-process SDK server.
GATEWAY_SERVER_NAME = "abca_gateway"

#: Suffix of the federated tool name the Gateway exposes
#: (``<targetName>___abca_repo_config``). We match on the suffix so the agent
#: need not know the CDK target name. Mirrors ``REPO_CONFIG_TOOL_NAME`` in
#: ``cdk/src/constructs/tool-gateway.ts``.
REMOTE_REPO_CONFIG_TOOL = "abca_repo_config"

#: How long a single Gateway round-trip may take before we give up.
_GATEWAY_TIMEOUT_S = 20.0

#: Read timeout of the HTTP client under the MCP session. The server may hold a
#: response stream open, so it is longer than one round-trip; each request is
#: still bounded by ``_GATEWAY_TIMEOUT_S`` (``read_timeout_seconds`` below). It
#: is the value the mcp 1.x transport applied by default (``sse_read_timeout``).
_GATEWAY_STREAM_READ_TIMEOUT_S = 300.0


def _sigv4_auth(region: str) -> httpx2.Auth:
    """Build an ``httpx2.Auth`` that SigV4-signs each request for the Gateway.

    Credentials come from the **compute role's** ambient chain (the AgentCore
    runtime execution role / ECS task role) — that is the principal the CDK
    grants ``bedrock-agentcore:InvokeGateway``, NOT the per-task tenant
    SessionRole. We therefore sign with botocore's ambient credentials rather
    than ``aws_session``'s tag-scoped session.
    """
    import httpx2
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    # TID251: only the compute role's credentials are read, to sign the request;
    # no client is built, so there is nothing to attribute.
    from botocore.session import get_session as get_botocore_session  # noqa: TID251

    credentials = get_botocore_session().get_credentials()
    if credentials is None:
        raise RuntimeError("no AWS credentials available to sign the Gateway request")

    class _SigV4(httpx2.Auth):
        # SigV4 signs a hash of the body, so httpx2 must buffer it before auth.
        requires_request_body = True

        def auth_flow(self, request: httpx2.Request) -> Generator[httpx2.Request, httpx2.Response]:
            # Re-freeze on every request so a rotation within THIS credentials
            # chain is picked up — botocore's RefreshableCredentials (what the
            # task/execution role resolves to on ECS/AgentCore) refreshes the
            # frozen snapshot transparently. A non-refreshable credential object
            # captured at build time would keep signing with its original
            # material; that is not a case that arises for the ambient role
            # credentials this bridge signs with. Signing is cheap relative to
            # the network round-trip.
            frozen = credentials.get_frozen_credentials()
            aws_request = AWSRequest(
                method=request.method,
                url=str(request.url),
                data=request.content,
                headers=dict(request.headers),
            )
            SigV4Auth(frozen, GATEWAY_SERVICE, region).add_auth(aws_request)
            # Copy the signed headers (Authorization, X-Amz-Date,
            # X-Amz-Security-Token, …) back onto the outgoing httpx2 request.
            request.headers.update(dict(aws_request.headers))
            yield request

    return _SigV4()


def _match_remote_tool(tools: list[Any], suffix: str) -> str:
    """Return the federated tool whose name ends with ``suffix``.

    The Gateway names a Lambda-backed tool ``<targetName>___<toolName>``; we
    match the ``<toolName>`` suffix so the agent stays decoupled from the CDK
    target name. Raises if no (or an ambiguous) match is found.
    """
    matches = [t.name for t in tools if t.name == suffix or t.name.endswith(f"___{suffix}")]
    if not matches:
        available = ", ".join(t.name for t in tools) or "<none>"
        raise RuntimeError(f"Gateway exposes no '{suffix}' tool (available: {available})")
    if len(matches) > 1:
        raise RuntimeError(f"Gateway exposes multiple '{suffix}' tools: {', '.join(matches)}")
    return matches[0]


def _result_to_text(result: Any) -> str:
    """Flatten an MCP ``CallToolResult`` into a text payload for the SDK.

    Prefers ``structured_content`` (the tool's JSON return) when present,
    otherwise concatenates any text content blocks.
    """
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
    """Open a SigV4-signed MCP session to ``url`` and invoke the federated tool."""
    import httpx2
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    auth = _sigv4_auth(region)
    timeout = httpx2.Timeout(_GATEWAY_TIMEOUT_S, read=_GATEWAY_STREAM_READ_TIMEOUT_S)
    async with (
        # The transport does not close a client it is handed, so this block does.
        httpx2.AsyncClient(auth=auth, timeout=timeout) as http_client,
        streamable_http_client(url, http_client=http_client) as (read, write),
        # The session's timeout bounds each of its requests: the handshake and the
        # listing as well as the call.
        ClientSession(read, write, read_timeout_seconds=_GATEWAY_TIMEOUT_S) as session,
    ):
        await session.initialize()
        listed = await session.list_tools()
        remote_name = _match_remote_tool(listed.tools, tool_suffix)
        return await session.call_tool(remote_name, arguments)


#: The tool description shown to the model. Module-level so the wording is one
#: place and the test can assert the tool is registered with it.
_REPO_CONFIG_DESCRIPTION = (
    "Look up the ABCA onboarding configuration for a GitHub repository — its "
    "compute substrate, model, and the build/lint commands ABCA gates PRs "
    "against. Use this to align your build verification with what the "
    'platform CI expects. The "repo" argument is the "owner/name" slug '
    '(e.g. "aws-samples/my-repo") — usually the repository you are working in.'
)


#: Exception types that represent an EXPECTED federation hiccup — network,
#: transport, timeout, or a Gateway/MCP-level error. These are logged at WARN
#: and surfaced as a tool error; anything outside this set is treated as an
#: unexpected (likely coding/deployment) bug and logged loudly (see below).
def _expected_gateway_errors() -> tuple[type[BaseException], ...]:
    """Resolve the expected-error tuple lazily (``mcp``/``httpx2`` are optional).

    Imported inside the function so a missing transport dependency can't break
    module import; if either is unavailable we still catch ``OSError`` /
    ``TimeoutError`` and fall through to the loud path for the rest.
    """
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
    """The ``repo_config`` tool body — validates, calls the Gateway, shapes the result.

    Extracted from the registered closure so it can be unit-tested directly
    (the SDK server wraps the closure in machinery that is awkward to invoke).
    Always returns an SDK tool-result dict; a federation failure is surfaced as
    ``is_error`` rather than raised, so a Gateway hiccup never aborts the task.

    A failure is classified: an EXPECTED transport/gateway error is logged at
    WARN (a routine hiccup), while any other exception — an ``AttributeError``
    from an unexpected response shape, a ``RuntimeError`` from
    ``_match_remote_tool`` (the Gateway not exposing the tool the agent expects
    is a deployment-contract violation), etc. — is logged via ``log_error_cw``
    so it reaches operators' APPLICATION_LOGS instead of hiding in a WARN line.
    Both still return a tool error rather than raising, preserving the
    never-abort-the-task contract.
    """
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
        # inside an ExceptionGroup, once per nested context manager. Classify and
        # report the cause, not "unhandled errors in a TaskGroup".
        cause = raised
        while isinstance(cause, ExceptionGroup) and len(cause.exceptions) == 1:
            cause = cause.exceptions[0]
        detail = f"{type(cause).__name__}: {cause}"
        if isinstance(cause, _expected_gateway_errors()):
            # Routine federation hiccup (network / transport / gateway). The agent
            # can proceed without the config; a failed call must not abort the task.
            log("WARN", f"gateway repo_config failed for {repo!r}: {detail}")
        else:
            # Unexpected: a coding or deployment-contract bug (bad response shape,
            # missing/ambiguous federated tool, …). Still don't abort the task, but
            # surface it loudly so it is not buried in a WARN triage line.
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
    (feature off) or the SDK is unavailable. In both cases the runner just
    doesn't offer the tool.
    """
    gateway_url = os.environ.get(GATEWAY_URL_ENV, "").strip()
    if not gateway_url:
        return None

    try:
        from claude_agent_sdk import create_sdk_mcp_server, tool
    except ImportError as exc:  # SDK always present in the container
        # Feature-detect: no SDK means the bridge can't be built, so return None
        # (like the URL-unset path above) to disable the tool rather than abort
        # startup — callers treat None as "gateway tool not offered", not failure.
        # Log a WARN (matching the region-unset path below) so this isn't silent:
        # the operator opted in via the URL, so "can't honor it" deserves a signal.
        log(
            "WARN",
            f"{GATEWAY_URL_ENV} is set but claude_agent_sdk is unavailable "
            f"({exc}); AgentCore Gateway tool bridge disabled",
        )
        return None  # nosemgrep: py-silent-success-masking -- feature-detect logged above; tool disabled not failed  # noqa: E501

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or ""
    if not region:
        # A blank region would only surface far downstream as an opaque SigV4
        # signing error on the first tool call. The Gateway URL being set while
        # region is unresolved is a deployment misconfiguration, so disable the
        # bridge here with a clear reason instead — same "don't abort startup,
        # just don't offer the tool" posture as the URL-unset path above.
        log(
            "WARN",
            f"{GATEWAY_URL_ENV} is set but no AWS region is resolvable "
            "(AWS_REGION / AWS_DEFAULT_REGION); AgentCore Gateway tool bridge disabled",
        )
        return None

    # Thin SDK closure over _repo_config_impl.
    @tool("repo_config", _REPO_CONFIG_DESCRIPTION, {"repo": str})
    async def repo_config(args: dict[str, Any]) -> dict[str, Any]:
        return await _repo_config_impl(gateway_url, region, args)

    return create_sdk_mcp_server(name=GATEWAY_SERVER_NAME, tools=[repo_config])
