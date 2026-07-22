"""Apply registry-resolved assets (#246) to the agent's runtime environment.

The orchestrator resolves a blueprint's ``registry://`` pins at the create-task
boundary and threads a ``resolved_assets`` bundle into the invocation payload
(see docs/design/REGISTRY.md §7/§8). This module is the agent-side consumer:
it takes that bundle and applies each asset kind with the right mechanism.

Each asset kind lands where it is consumed:
- ``mcp_server`` → merged into ``<repo_dir>/.mcp.json`` **here**, alongside
  whatever ``channel_mcp.py`` wrote, so the Claude Agent SDK
  (``setting_sources=["project"]``) picks it up at session start.
- ``cedar_policy_module`` → applied ORCHESTRATOR-side (the resolved text is
  merged into the ``cedar_policies`` payload, byte-identical to inline policies);
  the loader below is log-only.
- ``skill`` → applied at system-prompt assembly
  (``prompt_builder._registry_skill_addendum``); the loader below is log-only.

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


def apply_cedar_modules(resolved_cedar_modules: list[dict[str, Any]]) -> None:
    """Log resolved cedar_policy_module assets (#246).

    Cedar text is applied ORCHESTRATOR-side: the resolved module ``content`` is
    merged into the payload's ``cedar_policies`` list before it reaches the
    agent, so registry-sourced Cedar is byte-identical to inline blueprint
    policies and flows through the same ``PolicyEngine(extra_policies=...)``
    path (REGISTRY.md §8). The agent therefore does NOT re-apply Cedar here —
    doing so would double-load it. This only surfaces what resolved so it shows
    in the task log alongside the MCP/skill loaders.
    """
    if resolved_cedar_modules:
        names = ", ".join(
            f"{a.get('namespace')}/{a.get('name')}@{a.get('version')}"
            for a in resolved_cedar_modules
        )
        log(
            "TASK",
            f"registry: {len(resolved_cedar_modules)} cedar_policy_module asset(s) "
            f"applied via cedar_policies payload: {names}",
        )


def apply_skills(repo_dir: str, resolved_skills: list[dict[str, Any]]) -> None:
    """Log resolved skill assets (#246).

    Skill prompt fragments are applied when the system prompt is assembled
    (``prompt_builder._registry_skill_addendum``), not here — a skill is prompt
    text, so it must land in the prompt, and the prompt is built earlier in the
    pipeline than this loader runs. This only surfaces what resolved so it shows
    in the task log alongside the MCP/cedar loaders.
    """
    if resolved_skills:
        names = ", ".join(
            f"{a.get('namespace')}/{a.get('name')}@{a.get('version')}" for a in resolved_skills
        )
        log("TASK", f"registry: {len(resolved_skills)} skill asset(s) applied to prompt: {names}")


def apply_resolved_assets(repo_dir: str, resolved_assets: dict[str, list[dict]]) -> None:
    """Apply an entire resolved-asset bundle to the runtime.

    Dispatches each kind. MCP servers are merged into ``.mcp.json`` here; Cedar
    modules are applied orchestrator-side (merged into ``cedar_policies``) and
    skills are applied at system-prompt assembly — the cedar/skill calls below
    are log-only for those, since their content lands elsewhere in the pipeline.
    Safe to call with an empty bundle (no-op).
    """
    if not resolved_assets:
        return
    apply_mcp_assets(repo_dir, resolved_assets.get("mcp_servers") or [])
    apply_cedar_modules(resolved_assets.get("cedar_policy_modules") or [])
    apply_skills(repo_dir, resolved_assets.get("skills") or [])
