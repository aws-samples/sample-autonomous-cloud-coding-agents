"""Keeps Linear MCP servers out of the ``.mcp.json`` the agent loads.

The Claude Agent SDK — configured with ``setting_sources=["project"]`` — loads
the ``.mcp.json`` in the cloned repo ``cwd`` at session start and exposes its
servers' tools.

ABCA runs Linear 100% deterministically (ADR-016 "Linear is fully
deterministic"). There is no Linear MCP — issue text, recent comments, and
attachments are pre-hydrated at the Lambda tier (the webhook processor +
``linear-attachments.ts`` / ``linear-feedback.fetchRecentComments``), and
outbound reactions / state transitions go through direct GraphQL in
``linear_reactions.py`` (which reads ``LINEAR_API_TOKEN`` set by config.py —
independent of this module). The Linear MCP was removed after it proved
non-functional against a single OAuth app (actor=user data reads error;
actor=app can't re-consent an installed app).

:func:`strip_linear_mcp_servers` ENFORCES that guarantee: it removes any Linear
MCP server a repo may have COMMITTED to its own ``.mcp.json`` before the SDK
loads it (the prompt prohibition is not a security boundary — the SDK loads
``project`` settings and we export ``LINEAR_API_TOKEN``). The pipeline calls it
on every task with a repo.

:func:`read_existing_mcp_config` is shared with ``registry.loader``, which
merges registry servers into the same file.

See: cdk/src/handlers/linear-webhook-processor.ts (inbound), runner.py (SDK
invocation), ADR-016 (Linear determinism).
"""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any

from shell import log


def read_existing_mcp_config(path: str) -> dict[str, Any]:
    """Return the parsed .mcp.json at ``path``, or an empty dict if absent/invalid.

    Malformed JSON is logged and treated as absent — we prefer to overlay a
    valid registry entry than to crash the agent because a user committed a
    broken .mcp.json to their repo.

    The file is decoded the way the Claude CLI decodes it, so that the scrub and
    the registry merge see every server the CLI will load: a UTF-8 byte-order mark
    is dropped, and a byte that is not UTF-8 (a file saved as Windows-1252) becomes
    U+FFFD instead of raising.
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


#: Seconds allowed for each git call of ``_hide_edit_from_git``.
_GIT_TIMEOUT_S = 15


def _hide_edit_from_git(repo_dir: str) -> None:
    """Make git ignore this session's edit of a ``.mcp.json`` the repository tracks.

    What the scrub below removes is for this session only. The post-hook safety
    net (``post_hooks.ensure_committed``) stages every changed tracked file with
    ``git add -u`` and commits it, and the push that follows puts the edit into
    the pull request: the team's Linear server removed, or the whole file
    deleted. ``skip-worktree`` makes git treat the file as unchanged, also when
    the scrub removed it.

    An untracked file is left alone. ``git add -u`` never stages it, and an
    index entry for it makes ``git stash``, ``git rebase`` and ``git merge``
    fail for the agent (``registry.loader``, whose payload may hold secrets,
    lists the file in the clone's exclude file instead).

    Best-effort: a git failure is logged and the task goes on.
    """

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
            return  # not tracked: nothing the safety net could stage
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
    with a repo, regardless of channel_source.

    Returns the number of server entries removed (0 when none / no file).
    Best-effort: a read/write failure logs and returns 0 (the prompt prohibition
    + the absence of any platform-written Linear entry still hold).
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

    # If the Linear server(s) were the ONLY content, drop the whole file rather
    # than leave an inert ``{"mcpServers": {}}`` behind — a repo that shipped a
    # Linear-only .mcp.json ends up with no .mcp.json at all, which is the correct
    # end state (the SDK then has nothing to load). Keep the file only when other
    # MCP servers OR other top-level keys survive (a legit non-Linear server).
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
