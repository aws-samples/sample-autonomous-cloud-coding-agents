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


def _linear_server_entry() -> dict[str, Any]:
    """Build the `mcpServers` entry for Linear's hosted MCP."""
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


def configure_channel_mcp(repo_dir: str, channel_source: str) -> bool:
    """Write or merge a channel-specific ``.mcp.json`` into ``repo_dir``.

    Looks up ``channel_source`` in :data:`CHANNEL_MCP_BUILDERS`:
      * present → ensure the corresponding ``mcpServers`` entry is in
        ``.mcp.json`` (merges into any existing config without clobbering
        other servers). Returns True.
      * absent → no-op. Returns False.

    Args:
      repo_dir: the cloned-repo working directory the SDK will use as ``cwd``.
      channel_source: inbound channel (``TaskConfig.channel_source``).

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
