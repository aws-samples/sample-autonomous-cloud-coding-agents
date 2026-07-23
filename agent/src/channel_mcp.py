"""Channel-specific MCP configuration for the agent container.

For inbound channel sources that have a hosted MCP we write (or merge into)
``.mcp.json`` in the cloned repo ``cwd`` so the Claude Agent SDK — configured
with ``setting_sources=["project"]`` — picks up the channel MCP at session
start and exposes the server's tools.

Currently wired channels:
- ``jira``    → Atlassian Remote MCP entry — a NON-FUNCTIONAL placeholder. It
  is written for forward-compatibility but cannot connect from a headless
  agent (interactive OAuth 2.1 only); live outbound Jira comments go through
  the REST shim in ``jira_reactions.py``. See ``JIRA_MCP_URL`` below + ADR-015.

Linear is NOT here: ABCA runs Linear 100% deterministically (ADR-016 "Linear
is fully deterministic"). There is no Linear MCP — issue text, recent comments,
and attachments are pre-hydrated at the Lambda tier (the webhook processor +
``linear-attachments.ts`` / ``linear-feedback.fetchRecentComments``), and
outbound reactions / state transitions go through direct GraphQL in
``linear_reactions.py`` (which reads ``LINEAR_API_TOKEN`` set by config.py —
independent of this module). The Linear MCP was removed after it proved
non-functional against a single OAuth app (actor=user data reads error;
actor=app can't re-consent an installed app).

For all other channel sources this is a no-op: no MCP is written, and the
SDK sees no channel-specific tools.

See: cdk/src/handlers/{linear,jira}-webhook-processor.ts (inbound),
runner.py (SDK invocation), ADR-016 (Linear determinism).
"""

from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING, Any

from shell import log

if TYPE_CHECKING:
    from collections.abc import Callable

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
        Currently unused by the wired channels (Jira's entry is static); retained
        for call-site compatibility and future channel builders that need it.

    Returns:
      True if a channel MCP entry was (re)written, False otherwise (channel
      unmapped, missing repo_dir, or write failure).
    """
    _ = channel_metadata  # reserved for future channel builders (see docstring)
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


#: Substrings that mark an ``mcpServers`` entry as a Linear MCP server. Matched
#: (case-insensitively) against the server KEY and, defensively, the JSON of its
#: value (url / command / args / headers) so an entry named innocuously
#: (``"specs": {url:"https://mcp.linear.app/sse"}``) or reading the token
#: (``${LINEAR_API_TOKEN}``) is caught regardless of its key.
_LINEAR_MCP_MARKERS = ("linear", "mcp.linear.app", "linear_api_token")


def strip_linear_mcp_servers(repo_dir: str) -> int:
    """Remove any Linear MCP server entry from the repo's ``.mcp.json``.

    ADR-016 ENFORCEMENT (not just convention): Linear is 100% deterministic and
    the agent must have NO Linear MCP tools. The prompt says so, but a prompt is
    not a security boundary — a repo could COMMIT a ``.mcp.json`` with a
    ``linear-server`` entry using ``${LINEAR_API_TOKEN}``; the SDK loads
    ``project`` settings + we export ``LINEAR_API_TOKEN``, so under
    ``bypassPermissions`` those tools would authenticate and run. This scrubs any
    such entry from the on-disk config BEFORE the SDK reads it, on every task
    with a repo, regardless of channel_source. Jira's own entry (written by
    ``configure_channel_mcp`` for jira tasks) never matches these markers.

    Returns the number of server entries removed (0 when none / no file).
    Best-effort: a read/write failure logs and returns 0 (the prompt prohibition
    + the absence of any platform-written Linear entry still hold).
    """
    if not repo_dir or not os.path.isdir(repo_dir):
        return 0
    mcp_path = os.path.join(repo_dir, ".mcp.json")
    config = _read_existing_mcp_config(mcp_path)
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

    # If the Linear server(s) were the ONLY content, drop the whole file rather
    # than leave an inert ``{"mcpServers": {}}`` behind — a repo that shipped a
    # Linear-only .mcp.json ends up with no .mcp.json at all, which is the correct
    # end state (the SDK then has nothing to load). Keep the file only when other
    # MCP servers OR other top-level keys survive (a legit non-Linear server, or a
    # Jira entry the platform just wrote for a jira task).
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
    log(
        "WARN",
        f"Removed {len(offending)} Linear MCP server entr(ies) from {mcp_path} "
        f"(ADR-016: Linear is deterministic; the agent has no Linear MCP). "
        f"Keys: {', '.join(offending)}"
        + ("; deleted the now-empty .mcp.json" if removed_file else ""),
    )
    return len(offending)
