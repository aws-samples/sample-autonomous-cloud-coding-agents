from __future__ import annotations

import contextlib
import json
import os
import subprocess
from typing import Any

from channel_mcp import read_existing_mcp_config
from shell import log

_GIT_GUARD_TIMEOUT_S = 15

_MCP_KIND = "mcp_server"
_SKILL_KIND = "skill"


def _server_key(asset: dict[str, Any]) -> str:
    namespace = asset.get("namespace", "")
    name = asset.get("name", "")
    return f"{namespace}__{name}"


_STRING = "a string"
_STRING_LIST = "a list of strings"
_STRING_MAP = "an object with string values"


def _has_shape(value: Any, shape: str) -> bool:
    if shape == _STRING:
        return isinstance(value, str)
    if shape == _STRING_LIST:
        return isinstance(value, list) and all(isinstance(item, str) for item in value)
    return isinstance(value, dict) and all(isinstance(item, str) for item in value.values())


def _to_mcp_config(runtime: dict[str, Any], server_key: str) -> dict[str, Any]:
    """The registry contract names the discriminant ``transport`` (``http`` / ``sse``
    / ``stdio``), but the Claude Agent SDK's ``McpServerConfig`` uses the key ``type``.
    """
    transport = runtime.get("transport") or runtime.get("type")
    if transport in ("http", "sse"):
        if not runtime.get("url"):
            raise RegistryAssetLoadError(
                f"{server_key}: {transport} mcp_server runtime is missing 'url'"
            )
        shapes = {"url": _STRING, "headers": _STRING_MAP}
    elif transport == "stdio":
        if not runtime.get("command"):
            raise RegistryAssetLoadError(
                f"{server_key}: stdio mcp_server runtime is missing 'command'"
            )
        shapes = {"command": _STRING, "args": _STRING_LIST, "env": _STRING_MAP}
    else:
        raise RegistryAssetLoadError(
            f"{server_key}: unknown mcp_server transport {transport!r} "
            f"(expected http, sse, or stdio)"
        )
    for field, shape in shapes.items():
        if field in runtime and not _has_shape(runtime[field], shape):
            raise RegistryAssetLoadError(
                f"{server_key}: {transport} mcp_server runtime '{field}' must be {shape}"
            )
    if "transport" not in runtime:
        return runtime
    mapped = {k: v for k, v in runtime.items() if k != "transport"}
    mapped["type"] = runtime["transport"]
    return mapped


class RegistryAssetLoadError(RuntimeError):
    """A resolved asset could not be applied. This covers every condition that would leave
    a pinned asset unloaded — missing repo dir, empty/invalid runtime, structurally
    invalid connection config, or a write error (see :func:`apply_mcp_assets`), and
    a server that the Linear scrub removes behind the merge (``pipeline.run_task``). It
    also covers the conditions under which the resolved config, which may hold
    secrets, could reach a commit: ``.mcp.json`` is a symlink, or git cannot
    be shown to leave the written file out of commits."""


def _protect_mcp_json_from_commit(repo_dir: str, mcp_path: str) -> None:
    """What git does with the two mechanisms used here:

    - ``skip-worktree`` is a flag on an index entry. It blocks both ``git add -u``
      and an explicit ``git add .mcp.json``.
    - An index entry made with ``--intent-to-add`` is an uncommitted change to git:
      ``git stash``, ``rebase``, ``cherry-pick``, ``merge`` and ``reset --hard``
      then fail.
    - A ``.gitignore`` of the repo that re-includes the file outranks
      ``.git/info/exclude``.
    - ``update-index`` exits 0 without setting the flag where sparse checkout is
      enabled, so the flag is read back with ``git ls-files -v``.
    """

    def _log_platform_managed(how: str) -> None:
        log(
            "TASK",
            f"Registry: {mcp_path} is platform-managed for this task and left out of its "
            f"commits, the agent's own edits of it included ({how})",
        )

    def _git(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", repo_dir, *args],
            capture_output=True,
            text=True,
            timeout=_GIT_GUARD_TIMEOUT_S,
            check=False,
        )

    try:
        tracked = _git("ls-files", "--error-unmatch", ".mcp.json").returncode == 0
        if not tracked:
            exclude = os.path.join(repo_dir, ".git", "info", "exclude")
            with contextlib.suppress(OSError), open(exclude, "a", encoding="utf-8") as f:
                f.write("\n/.mcp.json\n")
            if _git("check-ignore", "-q", ".mcp.json").returncode == 0:
                _git("config", "advice.addIgnoredFile", "false")
                _log_platform_managed(".git/info/exclude: git add reports the path as ignored")
                return
            _git("add", "--intent-to-add", ".mcp.json")
        _git("config", "advice.updateSparsePath", "false")
        marked = _git("update-index", "--skip-worktree", ".mcp.json")
        # For this pathspec git also lists the entries below a directory of that name.
        # "s" is "S" (skip-worktree) with assume-unchanged.
        entry = _git("ls-files", "-v", "--", ".mcp.json").stdout
        flagged = entry in ("S .mcp.json\n", "s .mcp.json\n")
    except (OSError, subprocess.SubprocessError) as e:
        raise RegistryAssetLoadError(
            f"could not keep {mcp_path} out of commits: {type(e).__name__}: {e}"
        ) from e
    if not flagged:
        reason = " ".join(marked.stderr.split()) or (
            "git reported no error, as it does where sparse checkout is enabled"
        )
        raise RegistryAssetLoadError(
            f"could not keep {mcp_path} out of commits: git did not mark it "
            f"skip-worktree ({reason})"
        )
    _log_platform_managed(
        "git skip-worktree: git add reports the path as outside the sparse-checkout definition"
    )


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
      * two pins of one asset whose resolved connection configs differ: they
        share one ``.mcp.json`` key, so only one of them could be loaded.

    Fail-closed as well where the resolved config, which may hold secrets, could
    reach a commit made in the clone:
      * ``.mcp.json`` is a symlink — the write would land in the link's target,
        which the commit guard does not cover.
      * git cannot be shown to leave the written file out of commits (see
        :func:`_protect_mcp_json_from_commit`).
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
    if os.path.islink(mcp_path):
        raise RegistryAssetLoadError(
            f"refusing to write the resolved MCP config through a symlink: {mcp_path}. "
            "Make .mcp.json a regular file in the repository, or remove the Blueprint's "
            "mcp_server pins."
        )
    config = read_existing_mcp_config(mcp_path)
    servers = config.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}

    written: list[str] = []
    for asset in mcp_assets:
        key = _server_key(asset)
        runtime = asset.get("runtime")
        if not isinstance(runtime, dict) or not runtime:
            raise RegistryAssetLoadError(f"{key}: resolved mcp_server has an empty runtime payload")
        entry = _to_mcp_config(runtime, key)
        if key in written and servers[key] != entry:
            raise RegistryAssetLoadError(
                f"{key}: pinned more than once, and version {asset.get('version')} "
                f"resolved to a different connection config than the earlier pin"
            )
        servers[key] = entry
        written.append(key)

    config["mcpServers"] = servers
    try:
        with open(mcp_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2)
            f.write("\n")
    except OSError as e:
        raise RegistryAssetLoadError(f"failed to write {mcp_path}: {e}") from e

    _protect_mcp_json_from_commit(repo_dir, mcp_path)

    log("TASK", f"Registry: merged {len(written)} MCP server(s) into {mcp_path}")
    return written


def build_skill_prompt_fragment(resolved_assets: list[dict[str, Any]]) -> str:
    """Assemble the appended system-prompt text from resolved ``skill`` assets.

    Each skill's runtime payload carries a ``prompt_fragment`` (and optional
    advisory ``tool_hints``). Fragments are concatenated in resolution order under
    a single heading. Returns "" when there are no skills.
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

    Returns the list of mcp_server keys actually written. Propagates
    :class:`RegistryAssetLoadError`.
    """
    if not resolved_assets:
        return []
    return apply_mcp_assets(repo_dir, resolved_assets)
