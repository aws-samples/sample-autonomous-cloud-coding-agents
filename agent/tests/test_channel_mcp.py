"""Unit tests for channel_mcp.configure_channel_mcp — Linear MCP gating + merge."""

from __future__ import annotations

import json
import os

from channel_mcp import (
    LINEAR_API_TOKEN_ENV,
    LINEAR_MCP_SERVER_KEY,
    LINEAR_MCP_URL,
    configure_channel_mcp,
    configure_profile_mcp,
)


def _read_mcp(repo_dir: str) -> dict:
    path = os.path.join(repo_dir, ".mcp.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class TestChannelGate:
    """Only channel_source=='linear' writes anything — everything else is a no-op."""

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


class TestLinearWrite:
    """channel_source=='linear' writes .mcp.json with the linear-server entry."""

    def test_creates_mcp_json_with_linear_server_key(self, tmp_path):
        wrote = configure_channel_mcp(str(tmp_path), "linear")
        assert wrote is True
        config = _read_mcp(str(tmp_path))
        assert LINEAR_MCP_SERVER_KEY in config["mcpServers"]

    def test_renders_linear_url_and_token_placeholder(self, tmp_path):
        configure_channel_mcp(str(tmp_path), "linear")
        entry = _read_mcp(str(tmp_path))["mcpServers"][LINEAR_MCP_SERVER_KEY]
        assert entry["type"] == "http"
        assert entry["url"] == LINEAR_MCP_URL
        assert entry["headers"]["Authorization"] == f"Bearer ${{{LINEAR_API_TOKEN_ENV}}}"

    def test_server_key_is_linear_server(self):
        # If this ever changes, tools surface under a different mcp__ prefix and
        # the agent prompt (prompt_builder._channel_prompt_addendum) must be
        # updated in lockstep.
        assert LINEAR_MCP_SERVER_KEY == "linear-server"


class TestMerge:
    """Existing .mcp.json must not be clobbered."""

    def test_adds_linear_to_existing_empty_mcp_json(self, tmp_path):
        (tmp_path / ".mcp.json").write_text("{}")
        wrote = configure_channel_mcp(str(tmp_path), "linear")
        assert wrote is True
        assert LINEAR_MCP_SERVER_KEY in _read_mcp(str(tmp_path))["mcpServers"]

    def test_preserves_existing_mcp_servers(self, tmp_path):
        existing = {
            "mcpServers": {
                "other-server": {"type": "stdio", "command": "/usr/bin/my-mcp"},
            },
        }
        (tmp_path / ".mcp.json").write_text(json.dumps(existing))

        configure_channel_mcp(str(tmp_path), "linear")
        merged = _read_mcp(str(tmp_path))
        assert "other-server" in merged["mcpServers"]
        assert merged["mcpServers"]["other-server"]["command"] == "/usr/bin/my-mcp"
        assert LINEAR_MCP_SERVER_KEY in merged["mcpServers"]

    def test_overwrites_existing_linear_server_entry(self, tmp_path):
        # If someone committed a stale Linear entry with a wrong token var, we
        # want the fresh ABCA-written entry to win — otherwise the MCP would
        # fail to auth.
        existing = {
            "mcpServers": {
                LINEAR_MCP_SERVER_KEY: {
                    "type": "http",
                    "url": "https://stale.example",
                    "headers": {"Authorization": "Bearer stale"},
                },
            },
        }
        (tmp_path / ".mcp.json").write_text(json.dumps(existing))

        configure_channel_mcp(str(tmp_path), "linear")
        entry = _read_mcp(str(tmp_path))["mcpServers"][LINEAR_MCP_SERVER_KEY]
        assert entry["url"] == LINEAR_MCP_URL
        assert "stale" not in entry["headers"]["Authorization"]

    def test_tolerates_mcp_json_without_mcpservers_key(self, tmp_path):
        # A .mcp.json that only has unrelated top-level keys should still
        # gain an mcpServers map.
        (tmp_path / ".mcp.json").write_text(json.dumps({"version": 1}))
        configure_channel_mcp(str(tmp_path), "linear")
        merged = _read_mcp(str(tmp_path))
        assert merged["version"] == 1
        assert LINEAR_MCP_SERVER_KEY in merged["mcpServers"]

    def test_malformed_mcp_json_is_replaced(self, tmp_path):
        # Malformed JSON is treated as absent (logged as a warning in shell.log)
        # rather than crashing the pipeline.
        (tmp_path / ".mcp.json").write_text("{not json")
        wrote = configure_channel_mcp(str(tmp_path), "linear")
        assert wrote is True
        merged = _read_mcp(str(tmp_path))
        assert LINEAR_MCP_SERVER_KEY in merged["mcpServers"]


class TestRepoDirGuard:
    """Missing repo_dir must not raise — the pipeline should keep going."""

    def test_missing_repo_dir(self, tmp_path):
        missing = tmp_path / "does-not-exist"
        wrote = configure_channel_mcp(str(missing), "linear")
        assert wrote is False

    def test_empty_repo_dir_string(self):
        wrote = configure_channel_mcp("", "linear")
        assert wrote is False


class TestConfigureProfileMcp:
    """Tests for configure_profile_mcp — writing profile MCP server entries."""

    def test_no_op_for_empty_servers(self, tmp_path):
        wrote = configure_profile_mcp(str(tmp_path), [])
        assert wrote is False

    def test_no_op_for_missing_repo_dir(self, tmp_path):
        wrote = configure_profile_mcp(str(tmp_path / "nope"), ["eslint-mcp"])
        assert wrote is False

    def test_writes_server_entry_when_env_var_present(self, tmp_path, monkeypatch):
        monkeypatch.setenv("MCP_SERVER_ESLINT_MCP_URL", "https://eslint.example/mcp")
        wrote = configure_profile_mcp(str(tmp_path), ["eslint-mcp"])
        assert wrote is True
        config = _read_mcp(str(tmp_path))
        assert "eslint-mcp" in config["mcpServers"]
        assert config["mcpServers"]["eslint-mcp"]["url"] == "https://eslint.example/mcp"
        assert config["mcpServers"]["eslint-mcp"]["type"] == "http"

    def test_skips_server_without_env_var(self, tmp_path, monkeypatch):
        monkeypatch.delenv("MCP_SERVER_MYSERVER_URL", raising=False)
        wrote = configure_profile_mcp(str(tmp_path), ["myserver"])
        assert wrote is False

    def test_multiple_servers_partial_env(self, tmp_path, monkeypatch):
        monkeypatch.setenv("MCP_SERVER_SERVER_A_URL", "https://a.example/mcp")
        monkeypatch.delenv("MCP_SERVER_SERVER_B_URL", raising=False)
        wrote = configure_profile_mcp(str(tmp_path), ["server-a", "server-b"])
        assert wrote is True
        config = _read_mcp(str(tmp_path))
        assert "server-a" in config["mcpServers"]
        assert "server-b" not in config["mcpServers"]

    def test_merges_with_existing_mcp_config(self, tmp_path, monkeypatch):
        monkeypatch.setenv("MCP_SERVER_NEW_MCP_URL", "https://new.example/mcp")
        existing = {"mcpServers": {"existing-server": {"type": "http", "url": "https://existing.example"}}}
        (tmp_path / ".mcp.json").write_text(json.dumps(existing))
        configure_profile_mcp(str(tmp_path), ["new-mcp"])
        config = _read_mcp(str(tmp_path))
        assert "existing-server" in config["mcpServers"]
        assert "new-mcp" in config["mcpServers"]

    def test_coexists_with_channel_mcp(self, tmp_path, monkeypatch):
        monkeypatch.setenv("MCP_SERVER_ESLINT_MCP_URL", "https://eslint.example/mcp")
        configure_channel_mcp(str(tmp_path), "linear")
        configure_profile_mcp(str(tmp_path), ["eslint-mcp"])
        config = _read_mcp(str(tmp_path))
        assert LINEAR_MCP_SERVER_KEY in config["mcpServers"]
        assert "eslint-mcp" in config["mcpServers"]
