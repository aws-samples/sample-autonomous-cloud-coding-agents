"""Apply resolved registry assets (#246) to the agent's runtime environment.

The orchestrator resolves the Blueprint's ``registry://`` refs and threads a
bundle of ``{kind, namespace, name, version, runtime}`` entries into the payload
(``TaskConfig.resolved_assets``). Each per-kind loader here applies its runtime
payload:

  * ``mcp_server`` → merge the connection config into ``.mcp.json`` (PR 2).
  * ``cedar_policy_module`` / ``skill`` → PR 3.

The merge mirrors ``channel_mcp.configure_channel_mcp``: read the existing
``.mcp.json`` (if any), overlay the registry servers without clobbering other
entries, and write it back. Runs alongside the channel MCP wiring so the SDK's
project-scoped scan picks up both.
"""

from __future__ import annotations

import json
import os
from typing import Any

from shell import log

# The runtime payload for an mcp_server asset is a single ``mcpServers`` entry's
# value (transport/url/headers/…); we key it by ``<namespace>__<name>`` so two
# registry servers never collide and the source asset is legible in the config.
_MCP_KIND = "mcp_server"
_SKILL_KIND = "skill"


def _server_key(asset: dict[str, Any]) -> str:
    namespace = asset.get("namespace", "")
    name = asset.get("name", "")
    return f"{namespace}__{name}".replace("-", "_")


def _read_existing_mcp_config(path: str) -> dict[str, Any]:
    """Return the parsed .mcp.json at ``path``, or {} if absent/invalid.

    Mirrors ``channel_mcp._read_existing_mcp_config`` — a malformed file is
    logged and treated as absent rather than crashing the agent.
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


def apply_mcp_assets(repo_dir: str, resolved_assets: list[dict[str, Any]]) -> int:
    """Merge resolved ``mcp_server`` assets into ``<repo_dir>/.mcp.json``.

    Returns the number of MCP servers written. A no-op (returns 0) when there are
    no mcp_server assets or ``repo_dir`` is missing.
    """
    mcp_assets = [a for a in resolved_assets if a.get("kind") == _MCP_KIND]
    if not mcp_assets:
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
    for asset in mcp_assets:
        runtime = asset.get("runtime")
        if not isinstance(runtime, dict) or not runtime:
            log("WARN", f"apply_mcp_assets: skipping {_server_key(asset)} — empty runtime payload")
            continue
        servers[_server_key(asset)] = runtime
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

    log("TASK", f"Registry: merged {written} MCP server(s) into {mcp_path}")
    return written


def build_skill_prompt_fragment(resolved_assets: list[dict[str, Any]]) -> str:
    """Assemble the appended system-prompt text from resolved ``skill`` assets.

    Each skill's runtime payload carries a ``prompt_fragment`` (and optional
    advisory ``tool_hints``). Fragments are concatenated in resolution order under
    a single heading, so the model sees them as extra instructions. Returns "" when
    there are no skills — the caller then appends nothing.

    Skills are prompt text only: a skill cannot invoke tools; ``tool_hints`` are
    advisory prose referencing tools an MCP server separately provides (no
    transitive dependency — the operator attaches both).
    """
    skills = [a for a in resolved_assets if a.get("kind") == _SKILL_KIND]
    if not skills:
        return ""

    parts: list[str] = []
    for asset in skills:
        runtime = asset.get("runtime")
        if not isinstance(runtime, dict):
            continue
        fragment = runtime.get("prompt_fragment")
        if not isinstance(fragment, str) or not fragment.strip():
            continue
        name = f"{asset.get('namespace', '')}/{asset.get('name', '')}"
        parts.append(f"### Skill: {name}\n\n{fragment.strip()}")
        hints = runtime.get("tool_hints")
        if isinstance(hints, list) and hints:
            parts.append(f"_Suggested tools: {', '.join(str(h) for h in hints)}._")

    if not parts:
        return ""
    body = "\n\n".join(parts)
    log("TASK", f"Registry: appended {len(skills)} skill fragment(s) to the system prompt")
    return f"\n\n## Skills\n\n{body}"


def apply_resolved_assets(repo_dir: str, resolved_assets: list[dict[str, Any]]) -> None:
    """Apply the asset kinds that mutate on-disk state (mcp_server → .mcp.json).

    Cedar policy modules are applied orchestrator-side (merged into the
    cedar_policies payload) and skills are applied in prompt_builder via
    :func:`build_skill_prompt_fragment`, so neither is handled here.
    """
    if not resolved_assets:
        return
    apply_mcp_assets(repo_dir, resolved_assets)
