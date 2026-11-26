"""Channel-specific MCP configuration for the agent container.

For inbound channel sources that have a hosted MCP, ``configure_channel_mcp``
writes (or merges into) ``.mcp.json`` in the cloned repo ``cwd``, which the
Claude Agent SDK loads with ``setting_sources=["project"]``. For all other
channel sources it is a no-op.

``strip_linear_mcp_servers`` removes any Linear MCP server a repo committed to
its own ``.mcp.json`` before the SDK loads it (ADR-016).
"""

from __future__ import annotations

import json
import os
import subprocess
from typing import TYPE_CHECKING, Any

from shell import log

if TYPE_CHECKING:
    from collections.abc import Callable

#: The hosted Atlassian MCP requires an interactive, browser-based OAuth 2.1 flow
#: with dynamic client registration and does not accept the stored REST OAuth
#: token as a Bearer header. See ADR-015.
JIRA_MCP_URL = "https://mcp.atlassian.com/v1/sse"

JIRA_MCP_SERVER_KEY = "jira-server"

JIRA_API_TOKEN_ENV = "JIRA_API_TOKEN"  # noqa: S105 — env var *name*, not a secret value


def _jira_server_entry() -> dict[str, Any]:
    return {
        "type": "http",
        "url": JIRA_MCP_URL,
        "headers": {
            "Authorization": f"Bearer ${{{JIRA_API_TOKEN_ENV}}}",
        },
    }


CHANNEL_MCP_BUILDERS: dict[str, tuple[str, Callable[[], dict[str, Any]]]] = {
    "jira": (JIRA_MCP_SERVER_KEY, _jira_server_entry),
}


def read_existing_mcp_config(path: str) -> dict[str, Any]:
    """Return the parsed .mcp.json at ``path``, or an empty dict if absent/invalid.

    Malformed JSON is logged and treated as absent. The file is decoded the way
    the Claude CLI decodes it: a UTF-8 byte-order mark is dropped, and a byte
    that is not UTF-8 (a file saved as Windows-1252) becomes U+FFFD instead of
    raising.
    """
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8-sig", errors="replace") as f:
            parsed = json.load(f)
        if isinstance(parsed, dict):
            return parsed
        log("WARN", f"Ignoring non-object .mcp.json at {path} (got {type(parsed).__name__})")
    except (OSError, json.JSONDecodeError) as e:
        log("WARN", f"Failed to read existing .mcp.json at {path}: {type(e).__name__}: {e}")
    return {}


_GIT_TIMEOUT_S = 15


def _hide_edit_from_git(repo_dir: str) -> None:
    def _git(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", repo_dir, *args],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_S,
            check=False,
        )

    try:
        if _git("ls-files", "--error-unmatch", ".mcp.json").returncode != 0:
            return
        result = _git("update-index", "--skip-worktree", ".mcp.json")
        if result.returncode != 0:
            log(
                "WARN",
                f"Could not hide the .mcp.json edit in {repo_dir} from git "
                f"(exit {result.returncode}): {result.stderr.strip()}",
            )
    except (OSError, subprocess.SubprocessError) as e:
        log(
            "WARN",
            f"Could not hide the .mcp.json edit in {repo_dir} from git: {type(e).__name__}: {e}",
        )


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
        Unused by the wired channels.

    Returns:
      True if a channel MCP entry was (re)written, False otherwise (channel
      unmapped, missing repo_dir, or write failure).
    """
    _ = channel_metadata
    builder_entry = CHANNEL_MCP_BUILDERS.get(channel_source)
    if builder_entry is None:
        return False

    server_key, build_entry = builder_entry

    if not repo_dir or not os.path.isdir(repo_dir):
        log("WARN", f"configure_channel_mcp: repo_dir missing or not a directory: {repo_dir!r}")
        return False

    mcp_path = os.path.join(repo_dir, ".mcp.json")
    config = read_existing_mcp_config(mcp_path)

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
    _hide_edit_from_git(repo_dir)

    log(
        "TASK",
        f"{channel_source} MCP configured at {mcp_path} (server key: {server_key})",
    )
    if channel_source == "jira":
        log(
            "TASK",
            "jira MCP entry is a placeholder and is EXPECTED to fail to connect; "
            "outbound Jira writes use jira_reactions.py (Forge app actor when configured), "
            "not MCP",
        )
    return True


_LINEAR_MCP_MARKERS = ("linear", "mcp.linear.app", "linear_api_token")


def strip_linear_mcp_servers(repo_dir: str) -> int:
    """Remove any Linear MCP server entry from the repo's ``.mcp.json`` (ADR-016).

    Returns the number of server entries removed (0 when none / no file).
    Best-effort: a read/write failure logs and returns 0.
    """
    if not repo_dir or not os.path.isdir(repo_dir):
        return 0
    mcp_path = os.path.join(repo_dir, ".mcp.json")
    config = read_existing_mcp_config(mcp_path)
    servers = config.get("mcpServers")
    if not isinstance(servers, dict) or not servers:
        return 0

    def _is_linear(key: str, value: object) -> bool:
        hay = (key + " " + json.dumps(value, default=str)).lower()
        return any(m in hay for m in _LINEAR_MCP_MARKERS)

    offending = [k for k, v in servers.items() if _is_linear(k, v)]
    if not offending:
        return 0

    for k in offending:
        del servers[k]
    config["mcpServers"] = servers

    other_top_level_keys = [k for k in config if k != "mcpServers"]
    try:
        if not servers and not other_top_level_keys:
            os.remove(mcp_path)
            removed_file = True
        else:
            with open(mcp_path, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2)
                f.write("\n")
            removed_file = False
    except OSError as e:
        log("ERROR", f"strip_linear_mcp_servers: failed to rewrite/remove {mcp_path}: {e}")
        return 0
    _hide_edit_from_git(repo_dir)
    log(
        "WARN",
        f"Removed {len(offending)} Linear MCP server entr(ies) from {mcp_path} "
        f"(ADR-016: Linear is deterministic; the agent has no Linear MCP). "
        f"Keys: {', '.join(offending)}"
        + ("; deleted the now-empty .mcp.json" if removed_file else ""),
    )
    return len(offending)
