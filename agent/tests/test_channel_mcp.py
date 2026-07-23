"""Unit tests for channel_mcp.configure_channel_mcp — Jira MCP gating + merge.

Linear is NOT tested here: ABCA runs Linear 100% deterministically (ADR-016),
so there is no Linear MCP entry. The gate below asserts that channel_source=='linear'
is now a no-op (no .mcp.json written).
"""

from __future__ import annotations

import json
import os

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
        (tmp_path / ".mcp.json").write_text(
            json.dumps(
                {"mcpServers": {"specs": {"type": "http", "url": "https://mcp.linear.app/sse"}}}
            )
        )
        removed = strip_linear_mcp_servers(str(tmp_path))
        assert removed == 1
        assert _read_mcp(str(tmp_path))["mcpServers"] == {}

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

    def test_noop_when_no_linear_entry(self, tmp_path):
        (tmp_path / ".mcp.json").write_text(
            json.dumps({"mcpServers": {"jira-server": {"type": "http", "url": JIRA_MCP_URL}}})
        )
        assert strip_linear_mcp_servers(str(tmp_path)) == 0
