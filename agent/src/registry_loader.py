"""Apply registry-resolved assets (#246) to the agent's runtime environment.

The orchestrator resolves a blueprint's ``registry://`` pins at the create-task
boundary and threads a ``resolved_assets`` bundle into the invocation payload
(see docs/design/REGISTRY.md §7/§8). This module is the agent-side consumer:
it takes that bundle and applies each asset kind with the right mechanism.

MVP (this PR) wires ``mcp_server`` end-to-end — the resolved server config is
merged into ``<repo_dir>/.mcp.json`` alongside whatever ``channel_mcp.py``
wrote, so the Claude Agent SDK (``setting_sources=["project"]``) picks it up at
session start. ``cedar_policy_module`` and ``skill`` are stubs here; PR 3 fills
them in (Cedar text appended to the PolicyEngine set; skill prompt fragments
into the SDK setting sources).

Design note — parity with channel_mcp.py: both write ``.mcp.json`` by
read-merge-write on the ``mcpServers`` map, never clobbering other servers.
Registry assets and the channel MCP can therefore coexist in one file.
"""

from __future__ import annotations

import json
import os
from typing import Any

from shell import log

#: Key under which the resolved MCP server config lives in the descriptor
#: (REGISTRY.md §3.3). The value is a ready-to-write ``mcpServers`` entry.
_MCP_SERVER_CONFIG_KEY = "server_config"


def _read_existing_mcp_config(path: str) -> dict[str, Any]:
    """Return the parsed .mcp.json at ``path``, or an empty dict if absent/invalid.

    Mirrors ``channel_mcp._read_existing_mcp_config`` — malformed JSON is logged
    and treated as absent rather than crashing the agent on a broken file.
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


def _mcp_server_key(asset: dict[str, Any]) -> str:
    """The ``mcpServers`` key an asset registers under.

    Prefer the descriptor's ``tool_prefix`` stripped of the ``mcp__`` scaffolding
    (so tools surface consistently), falling back to ``namespace-name`` which is
    always present and unique per asset.
    """
    namespace = asset.get("namespace", "")
    name = asset.get("name", "")
    return f"{namespace}-{name}".strip("-") or name or "registry-mcp"


def apply_mcp_assets(repo_dir: str, resolved_mcp_servers: list[dict[str, Any]]) -> int:
    """Merge resolved MCP server assets into ``<repo_dir>/.mcp.json``.

    Read-merge-write on the ``mcpServers`` map, preserving any channel MCP or
    repo-committed entries. Each asset's descriptor carries a ``server_config``
    (the ``mcpServers`` entry value); assets missing it are skipped with a warn
    rather than writing a malformed entry.

    Args:
      repo_dir: the cloned-repo working directory the SDK uses as ``cwd``.
      resolved_mcp_servers: the ``mcp_servers`` list from the resolved bundle;
        each item is a resolved-asset dict (kind/namespace/name/version/descriptor).

    Returns:
      The number of MCP entries written (0 when nothing to apply, or on a
      write failure — logged).
    """
    if not resolved_mcp_servers:
        return 0
    if not repo_dir or not os.path.isdir(repo_dir):
        log("WARN", f"apply_mcp_assets: repo_dir missing or not a directory: {repo_dir!r}")
        return 0

    mcp_path = os.path.join(repo_dir, ".mcp.json")
    config = _read_existing_mcp_config(mcp_path)
    servers = config.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}

    written = 0
    for asset in resolved_mcp_servers:
        descriptor = asset.get("descriptor") or {}
        server_config = descriptor.get(_MCP_SERVER_CONFIG_KEY)
        if not isinstance(server_config, dict):
            log(
                "WARN",
                f"apply_mcp_assets: asset {asset.get('namespace')}/{asset.get('name')} "
                f"has no '{_MCP_SERVER_CONFIG_KEY}' in its descriptor; skipping",
            )
            continue
        servers[_mcp_server_key(asset)] = server_config
        written += 1

    if written == 0:
        return 0

    config["mcpServers"] = servers
    try:
        with open(mcp_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2)
            f.write("\n")
    except OSError as e:
        log("ERROR", f"apply_mcp_assets: failed to write {mcp_path}: {e}")
        return 0

    log("TASK", f"registry: merged {written} MCP server asset(s) into {mcp_path}")
    return written


def apply_cedar_modules(resolved_cedar_modules: list[dict[str, Any]]) -> list[str]:
    """Return Cedar policy text for resolved cedar_policy_module assets.

    STUB (PR 3): the resolver already returns these assets, but wiring the text
    into the PolicyEngine's policy set is deferred. Returns an empty list today
    so callers can unconditionally extend their policy list.
    """
    if resolved_cedar_modules:
        log(
            "TASK",
            f"registry: {len(resolved_cedar_modules)} cedar_policy_module asset(s) "
            "resolved but not yet applied (PR 3)",
        )
    return []


def apply_skills(repo_dir: str, resolved_skills: list[dict[str, Any]]) -> int:
    """Apply resolved skill assets to the SDK setting sources.

    STUB (PR 3): returns 0 today. The resolver returns these assets; loading the
    prompt fragments into the SDK's setting_sources is deferred to PR 3.
    """
    if resolved_skills:
        log(
            "TASK",
            f"registry: {len(resolved_skills)} skill asset(s) resolved but not yet applied (PR 3)",
        )
    return 0


def apply_resolved_assets(repo_dir: str, resolved_assets: dict[str, list[dict]]) -> None:
    """Apply an entire resolved-asset bundle to the runtime.

    Dispatches each kind to its loader. MVP applies MCP servers; cedar/skills are
    logged-only stubs (PR 3). Safe to call with an empty bundle (no-op).
    """
    if not resolved_assets:
        return
    apply_mcp_assets(repo_dir, resolved_assets.get("mcp_servers") or [])
    apply_cedar_modules(resolved_assets.get("cedar_policy_modules") or [])
    apply_skills(repo_dir, resolved_assets.get("skills") or [])
