"""Tests for the agent-side registry asset loader (#246)."""

from __future__ import annotations

import json
import os

from registry_loader import (
    apply_cedar_modules,
    apply_mcp_assets,
    apply_resolved_assets,
    apply_skills,
)


def _read_mcp(repo_dir: str) -> dict:
    with open(os.path.join(repo_dir, ".mcp.json"), encoding="utf-8") as f:
        return json.load(f)


def _mcp_asset(name: str, server_config: dict, namespace: str = "acme") -> dict:
    return {
        "kind": "mcp_server",
        "namespace": namespace,
        "name": name,
        "version": "1.0.0",
        "descriptor": {"summary": "s", "permissions": [], "server_config": server_config},
        "warnings": [],
    }


class TestApplyMcpAssets:
    def test_no_op_on_empty_list(self, tmp_path):
        assert apply_mcp_assets(str(tmp_path), []) == 0
        assert not (tmp_path / ".mcp.json").exists()

    def test_writes_resolved_server_into_mcp_json(self, tmp_path):
        cfg = {"type": "http", "url": "https://mcp.example/pdf"}
        written = apply_mcp_assets(str(tmp_path), [_mcp_asset("pdf-tools", cfg)])
        assert written == 1
        servers = _read_mcp(str(tmp_path))["mcpServers"]
        assert servers["acme-pdf-tools"] == cfg

    def test_merges_alongside_existing_channel_entry(self, tmp_path):
        # Simulate channel_mcp.py having already written a linear-server entry.
        (tmp_path / ".mcp.json").write_text(
            json.dumps({"mcpServers": {"linear-server": {"type": "http", "url": "x"}}})
        )
        apply_mcp_assets(str(tmp_path), [_mcp_asset("pdf-tools", {"type": "http", "url": "y"})])
        servers = _read_mcp(str(tmp_path))["mcpServers"]
        # Both coexist — the channel entry is not clobbered.
        assert "linear-server" in servers
        assert "acme-pdf-tools" in servers

    def test_writes_multiple_assets(self, tmp_path):
        written = apply_mcp_assets(
            str(tmp_path),
            [_mcp_asset("a", {"url": "1"}), _mcp_asset("b", {"url": "2"})],
        )
        assert written == 2
        assert len(_read_mcp(str(tmp_path))["mcpServers"]) == 2

    def test_skips_asset_missing_server_config(self, tmp_path):
        bad = {
            "kind": "mcp_server",
            "namespace": "acme",
            "name": "broken",
            "version": "1.0.0",
            "descriptor": {"summary": "s", "permissions": []},  # no server_config
            "warnings": [],
        }
        assert apply_mcp_assets(str(tmp_path), [bad]) == 0

    def test_no_op_on_missing_repo_dir(self):
        assert apply_mcp_assets("/nonexistent/dir/xyz", [_mcp_asset("a", {"url": "1"})]) == 0

    def test_tolerates_malformed_existing_mcp_json(self, tmp_path):
        (tmp_path / ".mcp.json").write_text("{ not json")
        written = apply_mcp_assets(str(tmp_path), [_mcp_asset("pdf", {"url": "z"})])
        assert written == 1
        assert "acme-pdf" in _read_mcp(str(tmp_path))["mcpServers"]


class TestStubs:
    def test_cedar_modules_stub_returns_empty(self):
        assert apply_cedar_modules([{"kind": "cedar_policy_module"}]) == []

    def test_skills_stub_returns_zero(self, tmp_path):
        assert apply_skills(str(tmp_path), [{"kind": "skill"}]) == 0


class TestApplyResolvedAssets:
    def test_empty_bundle_is_noop(self, tmp_path):
        apply_resolved_assets(str(tmp_path), {})
        assert not (tmp_path / ".mcp.json").exists()

    def test_dispatches_mcp_servers(self, tmp_path):
        bundle = {
            "mcp_servers": [_mcp_asset("pdf-tools", {"type": "http", "url": "u"})],
            "cedar_policy_modules": [],
            "skills": [],
        }
        apply_resolved_assets(str(tmp_path), bundle)
        assert "acme-pdf-tools" in _read_mcp(str(tmp_path))["mcpServers"]
