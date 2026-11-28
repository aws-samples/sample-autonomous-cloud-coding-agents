"""Apply resolved registry assets (#246) to the agent's runtime environment.

The orchestrator resolves the Blueprint's ``registry://`` refs and threads a
bundle of ``{kind, namespace, name, version, runtime}`` entries into the payload
(``TaskConfig.resolved_assets``). Each per-kind loader here applies its runtime
payload:

  * ``mcp_server`` → merge the connection config into ``.mcp.json`` (PR 2).
  * ``cedar_policy_module`` / ``skill`` → PR 3.

The merge reads the existing ``.mcp.json`` (if any), overlays the registry
servers without clobbering other entries, and writes it back, so the SDK's
project-scoped scan picks them up.
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
from typing import Any

from channel_mcp import read_existing_mcp_config
from shell import log

# Seconds to allow each git plumbing call when protecting .mcp.json from commit.
_GIT_GUARD_TIMEOUT_S = 15

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


# The shapes the Claude Code CLI requires of the connection fields it reads.
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
    """Normalize a registry mcp_server runtime payload into the ``.mcp.json``
    entry shape the Claude Agent SDK actually consumes.

    The registry contract names the discriminant ``transport`` (``http`` / ``sse``
    / ``stdio``), but the SDK's ``McpServerConfig`` uses the key ``type``. Writing
    ``transport`` unchanged produces an entry the agent does not recognize, so a published
    server following the documented contract would silently fail to load (#246).
    Map ``transport`` → ``type`` and pass the rest through untouched.

    Fail-closed: a structurally invalid payload (http/sse without ``url``, stdio
    without ``command``, an unknown transport, or a field the transport uses in
    another shape than the CLI accepts) raises :class:`RegistryAssetLoadError`.
    Writing a broken ``.mcp.json`` entry would let the task run with the pinned
    tool surface silently missing while the audit bundle claims the asset loaded
    — exactly the fail-open the resolve-side validation also guards against
    (#246 review).
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
    # The CLI validates these fields of an entry of this transport. When one has
    # another shape it skips the entry, and the session starts without the server.
    # It does not read a field of the other transport (``args`` of an http server),
    # so that one is not checked.
    for field, shape in shapes.items():
        if field in runtime and not _has_shape(runtime[field], shape):
            raise RegistryAssetLoadError(
                f"{server_key}: {transport} mcp_server runtime '{field}' must be {shape}"
            )
    if "transport" not in runtime:
        return runtime  # already in SDK shape
    mapped = {k: v for k, v in runtime.items() if k != "transport"}
    mapped["type"] = runtime["transport"]
    return mapped


class RegistryAssetLoadError(RuntimeError):
    """A resolved asset could not be applied. Raised so the task fails-closed
    rather than running with an audit record claiming an asset that was never
    actually loaded (#246 Option C). This covers every condition that would leave
    a pinned asset unloaded — missing repo dir, empty/invalid runtime, structurally
    invalid connection config, or a write error (see :func:`apply_mcp_assets`), and
    a server that the Linear scrub removes behind the merge (``pipeline.run_task``). It
    also covers the conditions under which the resolved config, which may hold
    secrets, could reach a commit: ``.mcp.json`` is a symlink (#758), or git cannot
    be shown to leave the written file out of commits (#759). The
    only warn-and-continue case is a pre-existing malformed ``.mcp.json`` on disk
    (:func:`channel_mcp.read_existing_mcp_config`), which is replaced, not fatal."""


def _protect_mcp_json_from_commit(repo_dir: str, mcp_path: str) -> None:
    """Keep the ``.mcp.json`` we just wrote out of the commits made in the clone.

    The resolved runtime we just wrote may carry secret-bearing fields (bearer
    ``headers``, a ``url`` with a token query string, ``args`` like
    ``--api-key=…``). ``.mcp.json`` lives in the live git clone, and the
    post-hook safety net (``git add -u`` → commit → ``git push``) will exfiltrate
    it into the PR whenever the target repo *tracks* ``.mcp.json`` (#246 review
    B4). Setting ``skip-worktree`` blocks both ``git add -u`` and an explicit
    ``git add .mcp.json``; the advice git prints with that refusal is switched
    off in the clone. Mechanical enforcement, mirroring the ADR-016
    Linear-strip posture — a prompt is not a security boundary.

    A file the repo does not track is listed in the clone's own exclude file
    instead (``.git/info/exclude``, never committed, as ``attachments`` does for
    its directory): ``git add -A``, ``git add .`` and ``git add .mcp.json`` leave
    it alone, and the advice git prints when it refuses the last of them is
    switched off in the clone. Giving the file an index entry for the flag
    (``--intent-to-add``) is an uncommitted change to git: ``git stash``,
    ``rebase``, ``cherry-pick``, ``merge`` and ``reset --hard`` then fail for the
    agent. That entry is only the fallback where the file is not ignored
    afterwards: the repo's own ``.gitignore`` re-includes it, which outranks the
    exclude file, or the exclude file could not be written.

    Neither mechanism touches the working tree, so the SDK still reads the file.
    Both keep the agent's own edits of ``.mcp.json`` out of its commits as well,
    and git names another cause when it refuses them (a sparse-checkout
    definition, a ``.gitignore`` file): the ``TASK`` line logged here records the
    real one (#760).

    Fail-closed (#759): the file is on disk when this runs, so a guard that is not
    in place leaves it for ``git add -u`` to stage. The exit code of
    ``update-index`` is not the proof: the flag is read back with ``git ls-files
    -v``, and :class:`RegistryAssetLoadError` is raised when it is not set (another
    git process holds ``index.lock``, the index entry is unmerged, sparse checkout
    is enabled in the clone, ``repo_dir`` is not in a repository) or when a git
    call fails or times out. The pipeline then fails the task before the agent
    starts, and commits nothing.
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
            # The leading newline is for an exclude file whose last line has none.
            with contextlib.suppress(OSError), open(exclude, "a", encoding="utf-8") as f:
                f.write("\n/.mcp.json\n")
            if _git("check-ignore", "-q", ".mcp.json").returncode == 0:
                # git refuses an add that names the ignored file. The refusal
                # stays; the advice git prints with it is off for this clone.
                _git("config", "advice.addIgnoredFile", "false")
                _log_platform_managed(".git/info/exclude: git add reports the path as ignored")
                return
            # Not ignored after all (the repo's .gitignore re-includes it, or the
            # exclude file could not be written): give the untracked file an
            # index entry so skip-worktree can attach.
            _git("add", "--intent-to-add", ".mcp.json")
        # git refuses an add that names the flagged file. The refusal stays; the
        # advice git prints with it is off for this clone.
        _git("config", "advice.updateSparsePath", "false")
        marked = _git("update-index", "--skip-worktree", ".mcp.json")
        # The flag has to be on the entry of the file itself. For this pathspec git also lists the
        # entries below a directory of that name. "s" is "S" (skip-worktree) with assume-unchanged.
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
        which the commit guard does not cover (#758).
      * git cannot be shown to leave the written file out of commits (#759, see
        :func:`_protect_mcp_json_from_commit`).

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
            # Fail closed: a pinned asset with no runtime cannot be honored, and
            # skipping it would make the stamped audit bundle lie about what ran.
            raise RegistryAssetLoadError(f"{key}: resolved mcp_server has an empty runtime payload")
        entry = _to_mcp_config(runtime, key)
        if key in written and servers[key] != entry:
            # Two pins of one asset that resolved to different versions: the key
            # holds one of them, and the audit bundle would name both as loaded.
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

    # The runtime we just wrote may carry secrets; keep the safety-net commit
    # from pushing it to the PR (#246 review B4).
    _protect_mcp_json_from_commit(repo_dir, mcp_path)

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
