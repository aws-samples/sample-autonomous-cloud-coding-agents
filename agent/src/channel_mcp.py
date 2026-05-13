"""Channel-specific MCP configuration for the agent container.

For Linear-origin tasks we write (or merge into) ``.mcp.json`` in the cloned
repo ``cwd`` so the Claude Agent SDK — configured with
``setting_sources=["project"]`` — picks up the Linear MCP at session start
and exposes ``mcp__linear-server__*`` tools.

For all other channel sources this is a no-op: no MCP is written, and the
SDK sees no Linear tools. That's the gate keeping Slack/API/webhook tasks
from touching Linear.

See: cdk/src/handlers/linear-webhook-processor.ts (inbound), runner.py
(SDK invocation), plans at ~/.claude/plans/linear-mcp-findings.md.
"""

from __future__ import annotations

import json
import os
from typing import Any

from shell import log

#: Linear MCP endpoint — hosted by Linear, Streamable HTTP transport.
LINEAR_MCP_URL = "https://mcp.linear.app/mcp"

#: Key name inside ``mcpServers``. Tools surface as
#: ``mcp__linear-server__*`` in the Agent SDK (verified in findings).
LINEAR_MCP_SERVER_KEY = "linear-server"

#: Env var name the MCP server entry reads via ``${LINEAR_API_TOKEN}``
#: placeholder expansion. Populated from ``LinearApiTokenSecret`` by run.sh.
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


def _read_existing_mcp_config(path: str) -> dict[str, Any]:
    """Return the parsed .mcp.json at ``path``, or an empty dict if absent/invalid.

    Malformed JSON is logged and treated as absent — we prefer to overlay a
    valid Linear entry than to crash the agent because a user committed a
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

    Gated on ``channel_source``:
      * ``'linear'`` → ensure the ``linear-server`` entry is present in
        ``.mcp.json`` (merges into any existing config without clobbering
        other servers). Returns True.
      * anything else → no-op. Returns False.

    Args:
      repo_dir: the cloned-repo working directory the SDK will use as ``cwd``.
      channel_source: inbound channel (``TaskConfig.channel_source``).

    Returns:
      True if a Linear MCP entry was (re)written into ``repo_dir/.mcp.json``,
      False otherwise (including any non-Linear channel or missing repo_dir).
    """
    if channel_source != "linear":
        return False

    if not repo_dir or not os.path.isdir(repo_dir):
        log("WARN", f"configure_channel_mcp: repo_dir missing or not a directory: {repo_dir!r}")
        return False

    mcp_path = os.path.join(repo_dir, ".mcp.json")
    config = _read_existing_mcp_config(mcp_path)

    servers = config.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}
    servers[LINEAR_MCP_SERVER_KEY] = _linear_server_entry()
    config["mcpServers"] = servers

    try:
        with open(mcp_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2)
            f.write("\n")
    except OSError as e:
        log("ERROR", f"Failed to write Linear MCP config to {mcp_path}: {e}")
        return False

    log(
        "TASK",
        f"Linear MCP configured at {mcp_path} (server key: {LINEAR_MCP_SERVER_KEY})",
    )
    return True


def configure_profile_mcp(repo_dir: str, mcp_servers: list[str]) -> bool:
    """Write tool-profile MCP server entries into ``.mcp.json``.

    Each entry in ``mcp_servers`` is a server identifier (e.g. ``"eslint-mcp"``).
    The server entries are written as Streamable HTTP stubs — the actual URL
    resolution is expected to be handled by the MCP server registry or
    environment-based configuration.

    For v1, profile MCP server entries use a convention-based URL pattern:
    ``MCP_SERVER_<UPPER_NAME>_URL`` env var, falling back to a placeholder.
    The Claude Agent SDK will attempt to connect; if the URL is invalid or
    unreachable the server simply won't contribute tools.

    Args:
      repo_dir: the cloned-repo working directory.
      mcp_servers: list of MCP server identifiers from the tool profile.

    Returns:
      True if at least one server entry was written, False otherwise.
    """
    if not mcp_servers:
        return False

    if not repo_dir or not os.path.isdir(repo_dir):
        log("WARN", f"configure_profile_mcp: repo_dir missing or not a directory: {repo_dir!r}")
        return False

    mcp_path = os.path.join(repo_dir, ".mcp.json")
    config = _read_existing_mcp_config(mcp_path)

    servers = config.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}

    for server_name in mcp_servers:
        # Convention: look for MCP_SERVER_<NAME>_URL env var for the endpoint
        env_key = f"MCP_SERVER_{server_name.upper().replace('-', '_')}_URL"
        url = os.environ.get(env_key, "")
        if not url:
            log("WARN", f"No URL found for profile MCP server '{server_name}' (checked ${env_key}), skipping")
            continue
        servers[server_name] = {
            "type": "http",
            "url": url,
        }

    config["mcpServers"] = servers

    try:
        with open(mcp_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2)
            f.write("\n")
    except OSError as e:
        log("ERROR", f"Failed to write profile MCP config to {mcp_path}: {e}")
        return False

    written = [s for s in mcp_servers if s in servers]
    log(
        "TASK",
        f"Profile MCP servers configured at {mcp_path}: {written}",
    )
    return len(written) > 0
