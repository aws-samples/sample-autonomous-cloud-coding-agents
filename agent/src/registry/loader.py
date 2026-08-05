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
    # Do NOT normalize hyphens to underscores: ``acme/foo-bar`` and
    # ``acme/foo_bar`` are distinct registry assets, and collapsing both to
    # ``acme__foo_bar`` would silently drop one server (last write wins), so the
    # loaded tool surface would diverge from the resolved audit bundle (#246).
    # MCP config keys allow hyphens, so the raw components are already a safe,
    # injective key.
    return f"{namespace}__{name}"


def _to_mcp_config(runtime: dict[str, Any], server_key: str) -> dict[str, Any]:
    """Normalize a registry mcp_server runtime payload into the ``.mcp.json``
    entry shape the Claude Agent SDK actually consumes.

    The registry contract names the discriminant ``transport`` (``http`` / ``sse``
    / ``stdio``), but the SDK's ``McpServerConfig`` (and the existing
    ``channel_mcp`` entries) use the key ``type``. Writing ``transport``
    unchanged produces an entry the agent does not recognize, so a published
    server following the documented contract would silently fail to load (#246).
    Map ``transport`` → ``type`` and pass the rest through untouched.

    Fail-closed: a structurally invalid payload (http/sse without ``url``, stdio
    without ``command``, or an unknown transport) raises
    :class:`RegistryAssetLoadError`. Writing a broken ``.mcp.json`` entry would
    let the task run with the pinned tool surface silently missing while the
    audit bundle claims the asset loaded — exactly the fail-open the resolve-side
    validation also guards against (#246 review).
    """
    transport = runtime.get("transport") or runtime.get("type")
    if transport in ("http", "sse"):
        if not runtime.get("url"):
            raise RegistryAssetLoadError(
                f"{server_key}: {transport} mcp_server runtime is missing 'url'"
            )
    elif transport == "stdio":
        if not runtime.get("command"):
            raise RegistryAssetLoadError(
                f"{server_key}: stdio mcp_server runtime is missing 'command'"
            )
    else:
        raise RegistryAssetLoadError(
            f"{server_key}: unknown mcp_server transport {transport!r} "
            f"(expected http, sse, or stdio)"
        )
    if "transport" not in runtime:
        return runtime  # already in SDK shape
    mapped = {k: v for k, v in runtime.items() if k != "transport"}
    mapped["type"] = runtime["transport"]
    return mapped


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


class RegistryAssetLoadError(RuntimeError):
    """A resolved asset could not be applied due to an *infrastructure* failure
    (the asset resolved fine, but writing it to disk failed). Raised so the task
    fails-closed rather than running with an audit record claiming an asset that
    was never actually loaded (#246 Option C). Contrast with *degraded-but-safe*
    conditions (empty runtime, malformed existing config), which warn + skip."""


def apply_mcp_assets(repo_dir: str, resolved_assets: list[dict[str, Any]]) -> list[str]:
    """Merge resolved ``mcp_server`` assets into ``<repo_dir>/.mcp.json``.

    Returns the list of server keys actually written. Empty when there are no
    mcp_server assets.

    Fail-closed on any condition that would leave a pinned asset unloaded while
    the audit bundle claims it loaded (raises :class:`RegistryAssetLoadError`):
      * ``repo_dir`` missing / not a directory — the asset resolved but there's
        nowhere to write it.
      * ``.mcp.json`` write error (OSError).
      * an empty / non-dict runtime payload for a pinned asset.
      * a structurally invalid connection config (see :func:`_to_mcp_config`).

    A pinned asset is one the operator explicitly referenced in the Blueprint, so
    "load it or fail the task" keeps the stamped ``resolved_assets`` audit record
    accurate by construction — a warn-and-skip here would let the record claim an
    asset the agent never actually loaded (#246 review, Option C).
    """
    mcp_assets = [a for a in resolved_assets if a.get("kind") == _MCP_KIND]
    if not mcp_assets:
        return []

    if not repo_dir or not os.path.isdir(repo_dir):
        raise RegistryAssetLoadError(
            f"cannot apply {len(mcp_assets)} resolved mcp_server asset(s): "
            f"repo_dir missing or not a directory: {repo_dir!r}"
        )

    mcp_path = os.path.join(repo_dir, ".mcp.json")
    config = _read_existing_mcp_config(mcp_path)
    servers = config.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}

    written: list[str] = []
    for asset in mcp_assets:
        key = _server_key(asset)
        runtime = asset.get("runtime")
        if not isinstance(runtime, dict) or not runtime:
            # Fail closed: a pinned asset with no runtime cannot be honored, and
            # skipping it would make the stamped audit bundle lie about what ran.
            raise RegistryAssetLoadError(f"{key}: resolved mcp_server has an empty runtime payload")
        servers[key] = _to_mcp_config(runtime, key)
        written.append(key)

    if not written:
        return []

    config["mcpServers"] = servers
    try:
        with open(mcp_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2)
            f.write("\n")
    except OSError as e:
        raise RegistryAssetLoadError(f"failed to write {mcp_path}: {e}") from e

    log("TASK", f"Registry: merged {len(written)} MCP server(s) into {mcp_path}")
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
        name = f"{asset.get('namespace', '')}/{asset.get('name', '')}"
        runtime = asset.get("runtime")
        fragment = runtime.get("prompt_fragment") if isinstance(runtime, dict) else None
        if not isinstance(runtime, dict) or not isinstance(fragment, str) or not fragment.strip():
            # Fail closed: a pinned skill whose fragment is missing/empty would be
            # silently dropped from the prompt while still stamped as loaded in the
            # audit bundle — surface it instead (#246 review, Option C).
            raise RegistryAssetLoadError(f"{name}: resolved skill has no usable 'prompt_fragment'")
        parts.append(f"### Skill: {name}\n\n{fragment.strip()}")
        hints = runtime.get("tool_hints")
        if isinstance(hints, list) and hints:
            parts.append(f"_Suggested tools: {', '.join(str(h) for h in hints)}._")

    body = "\n\n".join(parts)
    log("TASK", f"Registry: appended {len(skills)} skill fragment(s) to the system prompt")
    return f"\n\n## Skills\n\n{body}"


def apply_resolved_assets(repo_dir: str, resolved_assets: list[dict[str, Any]]) -> list[str]:
    """Apply the asset kinds that mutate on-disk state (mcp_server → .mcp.json).

    Cedar policy modules are applied orchestrator-side (merged into the
    cedar_policies payload) and skills are applied in prompt_builder via
    :func:`build_skill_prompt_fragment`, so neither is handled here.

    Returns the list of mcp_server keys actually written (for the caller to
    reconcile against the stamped audit bundle). Propagates
    :class:`RegistryAssetLoadError` on an infrastructure failure so the pipeline
    fails the task rather than running with a resolved asset silently missing.
    """
    if not resolved_assets:
        return []
    return apply_mcp_assets(repo_dir, resolved_assets)
