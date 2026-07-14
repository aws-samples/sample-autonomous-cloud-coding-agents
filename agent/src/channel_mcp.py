"""Channel-specific MCP configuration for the agent container.

For inbound channel sources that have a hosted MCP we write (or merge into)
``.mcp.json`` in the cloned repo ``cwd`` so the Claude Agent SDK — configured
with ``setting_sources=["project"]`` — picks up the channel MCP at session
start and exposes the server's tools.

Currently wired channels:
- ``linear``  → Linear hosted MCP (``mcp__linear-server__*`` tools) — functional.
- ``jira``    → Atlassian Remote MCP entry — a NON-FUNCTIONAL placeholder. It
  is written for forward-compatibility but cannot connect from a headless
  agent (interactive OAuth 2.1 only); live outbound Jira comments go through
  the REST shim in ``jira_reactions.py``. See ``JIRA_MCP_URL`` below + ADR-015.

For all other channel sources this is a no-op: no MCP is written, and the
SDK sees no channel-specific tools.

See: cdk/src/handlers/{linear,jira}-webhook-processor.ts (inbound),
runner.py (SDK invocation).
"""

from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING, Any

from shell import log

if TYPE_CHECKING:
    from collections.abc import Callable

# ─── Linear ──────────────────────────────────────────────────────────────────

#: Linear MCP endpoint — hosted by Linear, Streamable HTTP transport.
LINEAR_MCP_URL = "https://mcp.linear.app/mcp"

#: Key name inside ``mcpServers``. Tools surface as
#: ``mcp__linear-server__*`` in the Agent SDK.
LINEAR_MCP_SERVER_KEY = "linear-server"

#: Env var name the MCP server entry reads via ``${LINEAR_API_TOKEN}``
#: placeholder expansion. Populated from the OAuth secret by config.py.
LINEAR_API_TOKEN_ENV = "LINEAR_API_TOKEN"  # noqa: S105 — env var *name*, not a secret value

#: channel_metadata key carrying the per-workspace AgentCore Gateway MCP URL
#: (stamped by the orchestrator from the LinearWorkspaceRegistry row when the
#: workspace was onboarded with `bgagent linear add-workspace --gateway`).
GATEWAY_URL_METADATA_KEY = "gateway_url"


def _linear_server_entry(gateway_url: str = "", gateway_bearer: str = "") -> dict[str, Any]:
    """Build the `mcpServers` entry for the Linear MCP.

    Two modes:
      * **Gateway federation** (``gateway_url`` set) — point at the workspace's
        AgentCore Gateway endpoint, authenticating with the M2M bearer the agent
        minted (the gateway's CUSTOM_JWT inbound). The gateway holds the Linear
        OAuth token + owns its 24h refresh, so no per-thread Linear token is
        injected into the container. See docs/design/AGENTCORE_GATEWAY_MCP_SPIKE.md.
      * **Direct** (default) — point at Linear's hosted MCP with the per-thread
        ``${LINEAR_API_TOKEN}`` bearer (resolved by config.py from the OAuth
        secret). The pre-gateway path; unchanged fallback.
    """
    if gateway_url and gateway_bearer:
        return {
            "type": "http",
            "url": gateway_url,
            "headers": {
                "Authorization": f"Bearer {gateway_bearer}",
            },
        }
    return {
        "type": "http",
        "url": LINEAR_MCP_URL,
        "headers": {
            "Authorization": f"Bearer ${{{LINEAR_API_TOKEN_ENV}}}",
        },
    }


# ─── Jira (Atlassian Remote MCP — NON-FUNCTIONAL PLACEHOLDER) ────────────────

#: Atlassian Remote MCP endpoint — Streamable HTTP transport.
#:
#: IMPORTANT: this entry does NOT work from a headless agent and is retained
#: only as a forward-looking placeholder. The hosted Atlassian MCP requires an
#: interactive, browser-based OAuth 2.1 flow with dynamic client registration
#: and will NOT accept the stored REST OAuth token as a Bearer header, so it
#: fails to connect in the runtime (``claude mcp list`` → "Failed to connect").
#:
#: The LIVE outbound path is the REST shim in ``agent/src/jira_reactions.py``
#: (the "Plan B" that became Plan A), which posts comments via the Jira REST
#: v3 API using the same stored OAuth token. See ADR-015 and
#: ``agent/src/prompt_builder.py``. If Atlassian ever ships a token-compatible
#: MCP, this entry can be promoted and the REST shim retired.
JIRA_MCP_URL = "https://mcp.atlassian.com/v1/sse"

#: Key name inside ``mcpServers``. Tools surface as ``mcp__jira-server__*``
#: in the Agent SDK. If this changes the agent prompt's channel addendum
#: must be updated in lockstep.
JIRA_MCP_SERVER_KEY = "jira-server"

#: Env var name the Jira MCP server entry reads via ``${JIRA_API_TOKEN}``
#: placeholder expansion. Populated from the per-tenant OAuth secret by
#: config.resolve_jira_oauth_token.
JIRA_API_TOKEN_ENV = "JIRA_API_TOKEN"  # noqa: S105 — env var *name*, not a secret value


def _jira_server_entry() -> dict[str, Any]:
    """Build the `mcpServers` entry for Atlassian's Remote MCP."""
    return {
        "type": "http",
        "url": JIRA_MCP_URL,
        "headers": {
            "Authorization": f"Bearer ${{{JIRA_API_TOKEN_ENV}}}",
        },
    }


# ─── Dispatch ────────────────────────────────────────────────────────────────

#: Per-channel ``mcpServers`` entry builder. The channel_source values mirror
#: ``ChannelSource`` in cdk/src/handlers/shared/types.ts. Sources that don't
#: have a hosted MCP (api, webhook, slack) intentionally have no entry here —
#: the gate in ``configure_channel_mcp`` short-circuits on missing keys.
CHANNEL_MCP_BUILDERS: dict[str, tuple[str, Callable[[], dict[str, Any]]]] = {
    "linear": (LINEAR_MCP_SERVER_KEY, _linear_server_entry),
    "jira": (JIRA_MCP_SERVER_KEY, _jira_server_entry),
}


def _read_existing_mcp_config(path: str) -> dict[str, Any]:
    """Return the parsed .mcp.json at ``path``, or an empty dict if absent/invalid.

    Malformed JSON is logged and treated as absent — we prefer to overlay a
    valid channel entry than to crash the agent because a user committed a
    broken .mcp.json to their repo.
    """
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            parsed = json.load(f)
        if isinstance(parsed, dict):
            return parsed
        log("WARN", f"Ignoring non-object .mcp.json at {path} (got {type(parsed).__name__})")
    except (OSError, json.JSONDecodeError) as e:
        log("WARN", f"Failed to read existing .mcp.json at {path}: {type(e).__name__}: {e}")
    return {}


def _build_linear_entry(channel_metadata: dict[str, str] | None) -> dict[str, Any]:
    """Build the Linear ``mcpServers`` entry, routing through the per-workspace
    AgentCore Gateway when the workspace was onboarded with one.

    The orchestrator stamps ``gateway_url`` into channel_metadata from the
    workspace's registry row. When present, mint the M2M bearer and point the
    entry at the gateway; otherwise fall back to the direct Linear MCP path.
    """
    gateway_url = (channel_metadata or {}).get(GATEWAY_URL_METADATA_KEY, "")
    if gateway_url:
        from gateway_auth import get_gateway_bearer_token
        bearer = get_gateway_bearer_token()
        if bearer:
            log("TASK", f"Linear MCP routed through AgentCore Gateway ({gateway_url})")
            return _linear_server_entry(gateway_url=gateway_url, gateway_bearer=bearer)
        # Gateway configured for the workspace but the token mint failed — do
        # NOT silently fall back to the direct path (the per-thread LINEAR_API_
        # TOKEN may not even be set once a workspace is gateway-managed). Surface it.
        log("WARN", "Linear gateway_url present but M2M token mint failed; using direct MCP path as fallback")
    return _linear_server_entry()


def configure_channel_mcp(
    repo_dir: str,
    channel_source: str,
    channel_metadata: dict[str, str] | None = None,
) -> bool:
    """Write or merge a channel-specific ``.mcp.json`` into ``repo_dir``.

    Looks up ``channel_source`` in :data:`CHANNEL_MCP_BUILDERS`:
      * present → ensure the corresponding ``mcpServers`` entry is in
        ``.mcp.json`` (merges into any existing config without clobbering
        other servers). Returns True.
      * absent → no-op. Returns False.

    Args:
      repo_dir: the cloned-repo working directory the SDK will use as ``cwd``.
      channel_source: inbound channel (``TaskConfig.channel_source``).
      channel_metadata: per-task channel metadata (``TaskConfig.channel_metadata``).
        For Linear, a ``gateway_url`` here routes the MCP through the workspace's
        AgentCore Gateway instead of the direct hosted endpoint.

    Returns:
      True if a channel MCP entry was (re)written, False otherwise (channel
      unmapped, missing repo_dir, or write failure).
    """
    builder_entry = CHANNEL_MCP_BUILDERS.get(channel_source)
    if builder_entry is None:
        return False

    server_key, build_entry = builder_entry

    if not repo_dir or not os.path.isdir(repo_dir):
        log("WARN", f"configure_channel_mcp: repo_dir missing or not a directory: {repo_dir!r}")
        return False

    mcp_path = os.path.join(repo_dir, ".mcp.json")
    config = _read_existing_mcp_config(mcp_path)

    servers = config.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}
    # Linear supports gateway federation (channel_metadata-driven); other
    # channels use their static zero-arg builder.
    if channel_source == "linear":
        servers[server_key] = _build_linear_entry(channel_metadata)
    else:
        servers[server_key] = build_entry()
    config["mcpServers"] = servers

    try:
        with open(mcp_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2)
            f.write("\n")
    except OSError as e:
        log("ERROR", f"Failed to write {channel_source} MCP config to {mcp_path}: {e}")
        return False

    log(
        "TASK",
        f"{channel_source} MCP configured at {mcp_path} (server key: {server_key})",
    )
    if channel_source == "jira":
        # The Jira MCP entry is a non-functional placeholder (see JIRA_MCP_URL
        # docstring + ADR-015). Log it in-band so a "Failed to connect" line in
        # the agent logs isn't mistaken for the cause of a missing comment —
        # the live outbound path is the REST shim in jira_reactions.py.
        log(
            "TASK",
            "jira MCP entry is a placeholder and is EXPECTED to fail to connect; "
            "outbound Jira comments use the REST shim (jira_reactions.py), not MCP",
        )
    return True
