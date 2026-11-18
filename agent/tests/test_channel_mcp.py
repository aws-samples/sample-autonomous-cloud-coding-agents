"""Unit tests for channel_mcp.configure_channel_mcp — Jira MCP gating + merge.

Linear is NOT tested here: ABCA runs Linear 100% deterministically (ADR-016),
so there is no Linear MCP entry. The gate below asserts that channel_source=='linear'
is now a no-op (no .mcp.json written).
"""

from __future__ import annotations

import json
import os
import subprocess

from channel_mcp import (
    JIRA_API_TOKEN_ENV,
    JIRA_MCP_SERVER_KEY,
    JIRA_MCP_URL,
    configure_channel_mcp,
    strip_linear_mcp_servers,
)


def _read_mcp(repo_dir: str) -> dict:
    path = os.path.join(repo_dir, ".mcp.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class TestChannelGate:
    """Only channel_source with a wired MCP writes anything — everything else is a no-op."""

    def test_no_op_for_linear_channel(self, tmp_path):
        # ADR-016: Linear is fully deterministic — no Linear MCP is written.
        wrote = configure_channel_mcp(str(tmp_path), "linear")
        assert wrote is False
        assert not (tmp_path / ".mcp.json").exists()

    def test_no_op_for_linear_channel_ignores_gateway_url(self, tmp_path):
        # A stale gateway_url in metadata must not resurrect a Linear MCP entry.
        wrote = configure_channel_mcp(
            str(tmp_path),
            "linear",
            {"gateway_url": "https://gw.example/mcp"},
        )
        assert wrote is False
        assert not (tmp_path / ".mcp.json").exists()

    def test_no_op_for_slack_channel(self, tmp_path):
        wrote = configure_channel_mcp(str(tmp_path), "slack")
        assert wrote is False
        assert not (tmp_path / ".mcp.json").exists()

    def test_no_op_for_api_channel(self, tmp_path):
        wrote = configure_channel_mcp(str(tmp_path), "api")
        assert wrote is False
        assert not (tmp_path / ".mcp.json").exists()

    def test_no_op_for_webhook_channel(self, tmp_path):
        wrote = configure_channel_mcp(str(tmp_path), "webhook")
        assert wrote is False
        assert not (tmp_path / ".mcp.json").exists()

    def test_no_op_for_empty_channel(self, tmp_path):
        wrote = configure_channel_mcp(str(tmp_path), "")
        assert wrote is False
        assert not (tmp_path / ".mcp.json").exists()


class TestRepoDirGuard:
    """Missing repo_dir must not raise — the pipeline should keep going."""

    def test_missing_repo_dir(self, tmp_path):
        missing = tmp_path / "does-not-exist"
        wrote = configure_channel_mcp(str(missing), "jira")
        assert wrote is False

    def test_empty_repo_dir_string(self):
        wrote = configure_channel_mcp("", "jira")
        assert wrote is False


class TestJiraWrite:
    """channel_source=='jira' writes .mcp.json with the jira-server entry."""

    def test_creates_mcp_json_with_jira_server_key(self, tmp_path):
        wrote = configure_channel_mcp(str(tmp_path), "jira")
        assert wrote is True
        config = _read_mcp(str(tmp_path))
        assert JIRA_MCP_SERVER_KEY in config["mcpServers"]

    def test_renders_jira_url_and_token_placeholder(self, tmp_path):
        configure_channel_mcp(str(tmp_path), "jira")
        entry = _read_mcp(str(tmp_path))["mcpServers"][JIRA_MCP_SERVER_KEY]
        assert entry["type"] == "http"
        assert entry["url"] == JIRA_MCP_URL
        assert entry["headers"]["Authorization"] == f"Bearer ${{{JIRA_API_TOKEN_ENV}}}"

    def test_server_key_is_jira_server(self):
        # If this changes, tools surface under a different mcp__ prefix and
        # the agent prompt addendum must be updated in lockstep.
        assert JIRA_MCP_SERVER_KEY == "jira-server"


class TestJiraMerge:
    """Jira entry must coexist with other servers and overwrite stale jira entries."""

    def test_adds_jira_to_existing_empty_mcp_json(self, tmp_path):
        (tmp_path / ".mcp.json").write_text("{}")
        wrote = configure_channel_mcp(str(tmp_path), "jira")
        assert wrote is True
        assert JIRA_MCP_SERVER_KEY in _read_mcp(str(tmp_path))["mcpServers"]

    def test_preserves_existing_mcp_servers(self, tmp_path):
        existing = {
            "mcpServers": {
                "other-server": {"type": "stdio", "command": "/usr/bin/my-mcp"},
            },
        }
        (tmp_path / ".mcp.json").write_text(json.dumps(existing))

        configure_channel_mcp(str(tmp_path), "jira")
        merged = _read_mcp(str(tmp_path))
        assert "other-server" in merged["mcpServers"]
        assert merged["mcpServers"]["other-server"]["command"] == "/usr/bin/my-mcp"
        assert JIRA_MCP_SERVER_KEY in merged["mcpServers"]

    def test_overwrites_existing_jira_server_entry(self, tmp_path):
        existing = {
            "mcpServers": {
                JIRA_MCP_SERVER_KEY: {
                    "type": "http",
                    "url": "https://stale.example",
                    "headers": {"Authorization": "Bearer stale"},
                },
            },
        }
        (tmp_path / ".mcp.json").write_text(json.dumps(existing))

        configure_channel_mcp(str(tmp_path), "jira")
        entry = _read_mcp(str(tmp_path))["mcpServers"][JIRA_MCP_SERVER_KEY]
        assert entry["url"] == JIRA_MCP_URL
        assert "stale" not in entry["headers"]["Authorization"]

    def test_tolerates_mcp_json_without_mcpservers_key(self, tmp_path):
        (tmp_path / ".mcp.json").write_text(json.dumps({"version": 1}))
        configure_channel_mcp(str(tmp_path), "jira")
        merged = _read_mcp(str(tmp_path))
        assert merged["version"] == 1
        assert JIRA_MCP_SERVER_KEY in merged["mcpServers"]

    def test_keeps_the_servers_of_a_file_with_a_byte_order_mark(self, tmp_path):
        # A byte-order mark does not make the file malformed (the Claude CLI reads
        # it): the Jira entry joins the repository's servers, it does not replace them.
        existing = {"mcpServers": {"docs": {"command": "docs-mcp"}}}
        (tmp_path / ".mcp.json").write_bytes(b"\xef\xbb\xbf" + json.dumps(existing).encode())
        configure_channel_mcp(str(tmp_path), "jira")
        assert set(_read_mcp(str(tmp_path))["mcpServers"]) == {"docs", JIRA_MCP_SERVER_KEY}

    def test_malformed_mcp_json_is_replaced(self, tmp_path):
        # Malformed JSON is treated as absent (logged as a warning in shell.log)
        # rather than crashing the pipeline.
        (tmp_path / ".mcp.json").write_text("{not json")
        wrote = configure_channel_mcp(str(tmp_path), "jira")
        assert wrote is True
        merged = _read_mcp(str(tmp_path))
        assert JIRA_MCP_SERVER_KEY in merged["mcpServers"]


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
        configure_channel_mcp(str(tmp_path), "jira")  # writes jira-server
        removed = strip_linear_mcp_servers(str(tmp_path))
        assert removed == 0
        assert JIRA_MCP_SERVER_KEY in _read_mcp(str(tmp_path))["mcpServers"]

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
        (tmp_path / ".mcp.json").write_text(
            json.dumps({"mcpServers": {"jira-server": {"type": "http", "url": JIRA_MCP_URL}}})
        )
        assert strip_linear_mcp_servers(str(tmp_path)) == 0


class TestSessionEditStaysOutOfCommits:
    """The scrub and the Jira entry change ``.mcp.json`` for this session only.

    The post-hook safety net (``post_hooks.ensure_committed``) stages every changed
    tracked file with ``git add -u``, commits and pushes. On a repository that
    tracks ``.mcp.json`` the pull request would then carry the session's edit: the
    team's Linear server removed, the whole file deleted, or the Jira placeholder
    added.
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

    def test_jira_entry_is_not_staged(self, tmp_path):
        self._repo(tmp_path, {"mcpServers": {"docs": {"command": "docs-mcp"}}})
        assert configure_channel_mcp(str(tmp_path), "jira") is True
        assert self._staged_by_safety_net(tmp_path) == ["code.txt"]

    def test_file_the_repository_does_not_track_stays_untracked(self, tmp_path):
        # `git add -u` never stages an untracked file, so there is nothing to hide.
        # An index entry for it (`git add --intent-to-add`, which the registry loader
        # uses for its secret-bearing payload) makes `git stash`, `git rebase` and
        # `git merge` fail for the agent.
        self._repo(tmp_path, None)
        assert configure_channel_mcp(str(tmp_path), "jira") is True
        assert self._git(tmp_path, "ls-files", "--", ".mcp.json") == ""
        assert self._staged_by_safety_net(tmp_path) == ["code.txt"]
