"""Unit tests for channel_mcp.strip_linear_mcp_servers — the Linear MCP scrub.

ABCA runs Linear 100% deterministically (ADR-016), so there is no Linear MCP
entry: a Linear server a repository commits to ``.mcp.json`` is removed before
the SDK loads the file.
"""

from __future__ import annotations

import json
import os
import subprocess

from channel_mcp import strip_linear_mcp_servers


def _read_mcp(repo_dir: str) -> dict:
    path = os.path.join(repo_dir, ".mcp.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class TestStripLinearMcpServers:
    """ADR-016 ENFORCEMENT (review finding #1): a repo can't smuggle a Linear MCP
    server in via a committed .mcp.json — it's stripped before the SDK reads it."""

    def test_removes_linear_server_by_key(self, tmp_path):
        (tmp_path / ".mcp.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "linear-server": {"type": "http", "url": "https://mcp.linear.app/sse"},
                        "other": {"command": "some-tool"},
                    }
                }
            )
        )
        removed = strip_linear_mcp_servers(str(tmp_path))
        assert removed == 1
        servers = _read_mcp(str(tmp_path))["mcpServers"]
        assert "linear-server" not in servers
        assert "other" in servers  # unrelated servers survive

    def test_removes_entry_named_innocuously_but_referencing_linear_url(self, tmp_path):
        # A non-obvious key can't hide a Linear MCP — the value is scanned too.
        # Linear was the ONLY server → the now-empty .mcp.json is deleted entirely.
        (tmp_path / ".mcp.json").write_text(
            json.dumps(
                {"mcpServers": {"specs": {"type": "http", "url": "https://mcp.linear.app/sse"}}}
            )
        )
        removed = strip_linear_mcp_servers(str(tmp_path))
        assert removed == 1
        assert not (tmp_path / ".mcp.json").exists()

    def test_keeps_file_when_other_servers_survive(self, tmp_path):
        # A repo's legit non-Linear server means the file stays (Linear entry gone).
        (tmp_path / ".mcp.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "linear-server": {"url": "https://mcp.linear.app/sse"},
                        "my-tool": {"command": "/usr/bin/my-mcp"},
                    }
                }
            )
        )
        removed = strip_linear_mcp_servers(str(tmp_path))
        assert removed == 1
        assert (tmp_path / ".mcp.json").exists()
        assert _read_mcp(str(tmp_path))["mcpServers"] == {"my-tool": {"command": "/usr/bin/my-mcp"}}

    def test_keeps_file_when_other_top_level_keys_survive(self, tmp_path):
        # Linear was the only server but the file carries other config → keep it,
        # just with an empty mcpServers.
        (tmp_path / ".mcp.json").write_text(
            json.dumps(
                {
                    "version": 3,
                    "mcpServers": {"linear-server": {"url": "https://mcp.linear.app/sse"}},
                }
            )
        )
        removed = strip_linear_mcp_servers(str(tmp_path))
        assert removed == 1
        assert (tmp_path / ".mcp.json").exists()
        merged = _read_mcp(str(tmp_path))
        assert merged["version"] == 3
        assert merged["mcpServers"] == {}

    def test_removes_entry_reading_linear_api_token(self, tmp_path):
        (tmp_path / ".mcp.json").write_text(
            json.dumps(
                {"mcpServers": {"lin": {"command": "mcp", "env": {"TOKEN": "${LINEAR_API_TOKEN}"}}}}
            )
        )
        removed = strip_linear_mcp_servers(str(tmp_path))
        assert removed == 1

    def test_leaves_jira_and_other_servers_untouched(self, tmp_path):
        servers = {
            "jira-server": {"type": "http", "url": "https://mcp.atlassian.com/v1/sse"},
            "docs": {"command": "docs-mcp"},
        }
        (tmp_path / ".mcp.json").write_text(json.dumps({"mcpServers": servers}))
        removed = strip_linear_mcp_servers(str(tmp_path))
        assert removed == 0
        assert _read_mcp(str(tmp_path))["mcpServers"] == servers

    def test_noop_when_no_file(self, tmp_path):
        assert strip_linear_mcp_servers(str(tmp_path)) == 0

    def test_scrubs_a_file_saved_in_a_legacy_encoding(self, tmp_path):
        # Windows-1252: the "é" is the single byte 0xE9, which is not valid UTF-8.
        # The Claude CLI reads such a file (the byte becomes U+FFFD) and loads its
        # servers, so the scrub has to read it as well instead of failing the task.
        config = {
            "description": "Serveurs MCP de l'équipe",
            "mcpServers": {
                "linear": {"type": "http", "url": "https://mcp.linear.app/mcp"},
                "docs": {"command": "docs-mcp"},
            },
        }
        (tmp_path / ".mcp.json").write_bytes(
            json.dumps(config, ensure_ascii=False).encode("cp1252")
        )
        assert strip_linear_mcp_servers(str(tmp_path)) == 1
        assert _read_mcp(str(tmp_path))["mcpServers"] == {"docs": {"command": "docs-mcp"}}

    def test_scrubs_a_file_that_starts_with_a_byte_order_mark(self, tmp_path):
        # "UTF-8 with BOM" (Windows PowerShell 5, Visual Studio). The Claude CLI drops
        # the mark and loads the servers; read as broken JSON, the file would keep
        # its Linear server.
        config = {
            "mcpServers": {
                "linear": {"type": "http", "url": "https://mcp.linear.app/mcp"},
                "docs": {"command": "docs-mcp"},
            }
        }
        (tmp_path / ".mcp.json").write_bytes(b"\xef\xbb\xbf" + json.dumps(config).encode())
        assert strip_linear_mcp_servers(str(tmp_path)) == 1
        assert _read_mcp(str(tmp_path))["mcpServers"] == {"docs": {"command": "docs-mcp"}}

    def test_utf16_file_is_ignored_not_fatal(self, tmp_path):
        # Windows PowerShell 5 writes `... > .mcp.json` as UTF-16 with a byte-order
        # mark. The CLI cannot parse that either: warn, leave the file, carry on.
        (tmp_path / ".mcp.json").write_bytes(b"\xff\xfe" + '{"mcpServers": {}}'.encode("utf-16-le"))
        assert strip_linear_mcp_servers(str(tmp_path)) == 0

    def test_noop_when_no_linear_entry(self, tmp_path):
        jira = {"type": "http", "url": "https://mcp.atlassian.com/v1/sse"}
        (tmp_path / ".mcp.json").write_text(json.dumps({"mcpServers": {"jira-server": jira}}))
        assert strip_linear_mcp_servers(str(tmp_path)) == 0


class TestSessionEditStaysOutOfCommits:
    """The scrub changes ``.mcp.json`` for this session only.

    The post-hook safety net (``post_hooks.ensure_committed``) stages every changed
    tracked file with ``git add -u``, commits and pushes. On a repository that
    tracks ``.mcp.json`` the pull request would then carry the session's edit: the
    team's Linear server removed, or the whole file deleted.
    """

    @staticmethod
    def _git(repo, *args) -> str:
        result = subprocess.run(
            ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", *args],
            capture_output=True,
            text=True,
            check=False,
        )
        # A step that failed must not read as "nothing was staged".
        assert result.returncode == 0, f"git {' '.join(args)}: {result.stderr.strip()}"
        return result.stdout

    def _repo(self, tmp_path, mcp_config: dict | None) -> None:
        """One commit holding ``code.txt`` and, when given, ``.mcp.json``."""
        self._git(tmp_path, "init", "-q")
        (tmp_path / "code.txt").write_text("before\n")
        tracked = ["code.txt"]
        if mcp_config is not None:
            (tmp_path / ".mcp.json").write_text(json.dumps(mcp_config))
            tracked.append(".mcp.json")
        # -f: an ignore file of the host that lists .mcp.json must not leave it untracked.
        self._git(tmp_path, "add", "-f", "--", *tracked)
        self._git(tmp_path, "commit", "-qm", "init")

    def _staged_by_safety_net(self, tmp_path) -> list[str]:
        """What ``git add -u`` stages once the agent has also changed ``code.txt``.

        ``code.txt`` is the control: it has to be staged, or the command did not do
        its work and an empty list would prove nothing.
        """
        (tmp_path / "code.txt").write_text("after\n")
        self._git(tmp_path, "add", "-u")
        return self._git(tmp_path, "diff", "--cached", "--name-only").split()

    def test_scrubbed_file_is_not_staged(self, tmp_path):
        self._repo(
            tmp_path,
            {
                "mcpServers": {
                    "linear": {"type": "http", "url": "https://mcp.linear.app/mcp"},
                    "docs": {"command": "docs-mcp"},
                }
            },
        )
        assert strip_linear_mcp_servers(str(tmp_path)) == 1
        assert self._staged_by_safety_net(tmp_path) == ["code.txt"]

    def test_removal_of_a_linear_only_file_is_not_staged(self, tmp_path):
        self._repo(tmp_path, {"mcpServers": {"linear": {"url": "https://mcp.linear.app/mcp"}}})
        assert strip_linear_mcp_servers(str(tmp_path)) == 1
        assert not (tmp_path / ".mcp.json").exists()
        assert self._staged_by_safety_net(tmp_path) == ["code.txt"]

    def test_file_the_repository_does_not_track_stays_untracked(self, tmp_path):
        # `git add -u` never stages an untracked file, so there is nothing to hide.
        # An index entry for it (`git add --intent-to-add`) makes `git stash`,
        # `git rebase` and `git merge` fail for the agent; the registry loader, whose
        # payload may hold secrets, lists the file in the clone's exclude file instead.
        self._repo(tmp_path, None)
        servers = {"linear": {"url": "https://mcp.linear.app/mcp"}, "docs": {"command": "docs-mcp"}}
        (tmp_path / ".mcp.json").write_text(json.dumps({"mcpServers": servers}))
        assert strip_linear_mcp_servers(str(tmp_path)) == 1
        assert self._git(tmp_path, "ls-files", "--", ".mcp.json") == ""
        assert self._staged_by_safety_net(tmp_path) == ["code.txt"]
