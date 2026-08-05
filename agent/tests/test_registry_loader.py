"""Unit tests for registry.loader — merging resolved mcp_server assets (#246)."""

from __future__ import annotations

import json

import pytest

from registry.loader import (
    RegistryAssetLoadError,
    apply_mcp_assets,
    apply_resolved_assets,
    build_skill_prompt_fragment,
)


def _read_mcp(repo_dir) -> dict:
    with open(repo_dir / ".mcp.json", encoding="utf-8") as f:
        return json.load(f)


def _mcp_asset(namespace: str, name: str, version: str, runtime: dict) -> dict:
    return {
        "kind": "mcp_server",
        "namespace": namespace,
        "name": name,
        "version": version,
        "runtime": runtime,
    }


class TestApplyMcpAssets:
    def test_writes_new_mcp_json(self, tmp_path):
        runtime = {"transport": "http", "url": "https://mcp.example.com/sse"}
        asset = _mcp_asset("acme", "pdf-tools", "1.0.0", runtime)
        written = apply_mcp_assets(str(tmp_path), [asset])
        assert written == ["acme__pdf-tools"]
        merged = _read_mcp(tmp_path)
        # Hyphens are preserved (injective key) — not normalized to underscores.
        # `transport` is normalized to the SDK's `type` discriminant key (#246).
        assert merged["mcpServers"]["acme__pdf-tools"] == {
            "type": "http",
            "url": "https://mcp.example.com/sse",
        }

    def test_normalizes_transport_to_type(self, tmp_path):
        # A publisher following the documented `transport` contract must produce
        # a `.mcp.json` entry the SDK recognizes (discriminant key `type`), with
        # no leftover `transport` key and all other fields preserved.
        runtime = {
            "transport": "sse",
            "url": "https://x/sse",
            "headers": {"Authorization": "Bearer t"},
            "tool_prefix": "mcp__x__",
        }
        apply_mcp_assets(str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", runtime)])
        entry = _read_mcp(tmp_path)["mcpServers"]["acme__x"]
        assert entry["type"] == "sse"
        assert "transport" not in entry
        assert entry["url"] == "https://x/sse"
        assert entry["headers"] == {"Authorization": "Bearer t"}
        assert entry["tool_prefix"] == "mcp__x__"

    def test_preserves_existing_servers(self, tmp_path):
        existing = {"mcpServers": {"other": {"command": "/usr/bin/x"}}}
        (tmp_path / ".mcp.json").write_text(json.dumps(existing))
        written = apply_mcp_assets(
            str(tmp_path),
            [_mcp_asset("acme", "weather", "2.1.0", {"transport": "sse", "url": "https://w"})],
        )
        assert written == ["acme__weather"]
        merged = _read_mcp(tmp_path)
        assert merged["mcpServers"]["other"]["command"] == "/usr/bin/x"
        assert "acme__weather" in merged["mcpServers"]

    def test_merges_multiple_servers(self, tmp_path):
        assets = [
            _mcp_asset("acme", "a", "1.0.0", {"transport": "http", "url": "https://a"}),
            _mcp_asset("acme", "b", "1.0.0", {"transport": "http", "url": "https://b"}),
        ]
        written = apply_mcp_assets(str(tmp_path), assets)
        assert set(written) == {"acme__a", "acme__b"}
        merged = _read_mcp(tmp_path)
        assert set(merged["mcpServers"]) == {"acme__a", "acme__b"}

    def test_hyphen_and_underscore_names_do_not_collide(self, tmp_path):
        # foo-bar and foo_bar are distinct assets; the key must not collapse them
        # to one entry (last-write-wins would drop a resolved server) (#246).
        assets = [
            _mcp_asset("acme", "foo-bar", "1.0.0", {"transport": "http", "url": "https://dash"}),
            _mcp_asset(
                "acme", "foo_bar", "1.0.0", {"transport": "http", "url": "https://underscore"}
            ),
        ]
        written = apply_mcp_assets(str(tmp_path), assets)
        assert set(written) == {"acme__foo-bar", "acme__foo_bar"}
        merged = _read_mcp(tmp_path)
        assert set(merged["mcpServers"]) == {"acme__foo-bar", "acme__foo_bar"}
        assert merged["mcpServers"]["acme__foo-bar"]["url"] == "https://dash"
        assert merged["mcpServers"]["acme__foo_bar"]["url"] == "https://underscore"

    def test_ignores_non_mcp_kinds(self, tmp_path):
        assets = [
            {
                "kind": "cedar_policy_module",
                "namespace": "acme",
                "name": "p",
                "version": "1.0.0",
                "runtime": {"cedar_text": "permit(...);"},
            },
        ]
        written = apply_mcp_assets(str(tmp_path), assets)
        assert written == []
        assert not (tmp_path / ".mcp.json").exists()

    def test_empty_runtime_raises(self, tmp_path):
        # Fail-closed (#246 review): a pinned asset with no runtime cannot be
        # honored; skipping it would make the stamped audit bundle lie.
        with pytest.raises(RegistryAssetLoadError, match="empty runtime payload"):
            apply_mcp_assets(str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", {})])
        assert not (tmp_path / ".mcp.json").exists()

    def test_http_without_url_raises(self, tmp_path):
        with pytest.raises(RegistryAssetLoadError, match="missing 'url'"):
            apply_mcp_assets(
                str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", {"transport": "http"})]
            )

    def test_stdio_without_command_raises(self, tmp_path):
        with pytest.raises(RegistryAssetLoadError, match="missing 'command'"):
            apply_mcp_assets(
                str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", {"transport": "stdio"})]
            )

    def test_unknown_transport_raises(self, tmp_path):
        with pytest.raises(RegistryAssetLoadError, match="unknown mcp_server transport"):
            apply_mcp_assets(
                str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", {"transport": "grpc", "url": "u"})]
            )

    def test_stdio_with_command_loads(self, tmp_path):
        written = apply_mcp_assets(
            str(tmp_path),
            [_mcp_asset("acme", "x", "1.0.0", {"transport": "stdio", "command": "run-me"})],
        )
        assert written == ["acme__x"]
        assert _read_mcp(tmp_path)["mcpServers"]["acme__x"] == {
            "type": "stdio",
            "command": "run-me",
        }

    def test_missing_repo_dir_raises(self):
        # Infrastructure failure (#246 Option C): the asset resolved but there's
        # nowhere to write it — fail-closed so the audit can't claim it loaded.
        asset = _mcp_asset("acme", "x", "1.0.0", {"transport": "http", "url": "u"})
        with pytest.raises(RegistryAssetLoadError, match="repo_dir missing"):
            apply_mcp_assets("/nonexistent/dir", [asset])

    def test_write_error_raises(self, tmp_path, monkeypatch):
        # Infrastructure failure: .mcp.json write fails → fail-closed.
        asset = _mcp_asset("acme", "x", "1.0.0", {"transport": "http", "url": "u"})

        def _boom(*_a, **_k):
            raise OSError("disk full")

        monkeypatch.setattr("builtins.open", _boom)
        with pytest.raises(RegistryAssetLoadError, match="failed to write"):
            apply_mcp_assets(str(tmp_path), [asset])

    def test_malformed_existing_treated_as_absent(self, tmp_path):
        # Degraded-but-safe: a corrupt existing .mcp.json is replaced, not fatal.
        (tmp_path / ".mcp.json").write_text("{ not valid json")
        runtime = {"transport": "http", "url": "https://x"}
        written = apply_mcp_assets(str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", runtime)])
        assert written == ["acme__x"]
        # Written in SDK shape (transport → type).
        assert _read_mcp(tmp_path)["mcpServers"]["acme__x"] == {"type": "http", "url": "https://x"}


def _skill_asset(namespace: str, name: str, runtime: dict) -> dict:
    return {
        "kind": "skill",
        "namespace": namespace,
        "name": name,
        "version": "1.0.0",
        "runtime": runtime,
    }


class TestBuildSkillPromptFragment:
    def test_empty_when_no_skills(self):
        assert build_skill_prompt_fragment([]) == ""
        mcp = _mcp_asset("acme", "x", "1.0.0", {"transport": "http", "url": "u"})
        assert build_skill_prompt_fragment([mcp]) == ""

    def test_appends_fragment_with_heading(self):
        out = build_skill_prompt_fragment(
            [_skill_asset("acme", "research", {"prompt_fragment": "Summarize findings."})]
        )
        assert "## Skills" in out
        assert "### Skill: acme/research" in out
        assert "Summarize findings." in out

    def test_includes_tool_hints(self):
        runtime = {"prompt_fragment": "Do X.", "tool_hints": ["Bash", "Edit"]}
        out = build_skill_prompt_fragment([_skill_asset("acme", "r", runtime)])
        assert "Bash, Edit" in out

    def test_concatenates_multiple_in_order(self):
        out = build_skill_prompt_fragment(
            [
                _skill_asset("acme", "a", {"prompt_fragment": "First."}),
                _skill_asset("acme", "b", {"prompt_fragment": "Second."}),
            ]
        )
        assert out.index("First.") < out.index("Second.")

    def test_blank_fragment_raises(self):
        # Fail-closed (#246 review): a pinned skill whose fragment is missing/blank
        # would otherwise be silently dropped while stamped as loaded.
        blank = _skill_asset("acme", "a", {"prompt_fragment": "   "})
        with pytest.raises(RegistryAssetLoadError, match="no usable 'prompt_fragment'"):
            build_skill_prompt_fragment([blank])

    def test_missing_runtime_raises(self):
        with pytest.raises(RegistryAssetLoadError, match="no usable 'prompt_fragment'"):
            build_skill_prompt_fragment([_skill_asset("acme", "a", {})])


class TestApplyResolvedAssets:
    def test_empty_is_noop(self, tmp_path):
        apply_resolved_assets(str(tmp_path), [])
        assert not (tmp_path / ".mcp.json").exists()

    def test_dispatches_mcp(self, tmp_path):
        written = apply_resolved_assets(
            str(tmp_path),
            [_mcp_asset("acme", "x", "1.0.0", {"transport": "http", "url": "https://x"})],
        )
        assert written == ["acme__x"]
        assert (tmp_path / ".mcp.json").exists()

    def test_propagates_infra_failure(self, tmp_path):
        # Fail-closed (#246 Option C): an mcp_server that resolved but can't be
        # written must raise so the pipeline fails the task.
        with pytest.raises(RegistryAssetLoadError):
            apply_resolved_assets(
                "/nonexistent/dir",
                [_mcp_asset("acme", "x", "1.0.0", {"transport": "http", "url": "u"})],
            )

    def test_skill_and_cedar_do_not_touch_mcp_json(self, tmp_path):
        # apply_resolved_assets only handles on-disk kinds (mcp_server). Skills
        # and cedar modules are applied elsewhere, so no .mcp.json is written.
        apply_resolved_assets(str(tmp_path), [_skill_asset("acme", "r", {"prompt_fragment": "X."})])
        assert not (tmp_path / ".mcp.json").exists()


class TestAdr016LinearReStrip:
    """A registry-published Linear MCP server merged into .mcp.json must be
    scrubbed by strip_linear_mcp_servers (ADR-016), which the pipeline now runs
    AFTER the registry merge. Guards the bypass where a registry asset could
    re-introduce Linear tools under bypassPermissions (#246 review)."""

    def test_registry_linear_server_is_stripped_after_merge(self, tmp_path):
        from channel_mcp import strip_linear_mcp_servers

        # A registry asset that (maliciously or accidentally) provides Linear.
        apply_resolved_assets(
            str(tmp_path),
            [
                _mcp_asset(
                    "evil",
                    "linear",
                    "1.0.0",
                    {"transport": "http", "url": "https://mcp.linear.app/sse"},
                ),
                _mcp_asset("acme", "pdf", "1.0.0", {"transport": "http", "url": "https://pdf"}),
            ],
        )
        # The pipeline runs this immediately after the merge.
        removed = strip_linear_mcp_servers(str(tmp_path))
        assert removed == 1
        servers = _read_mcp(tmp_path)["mcpServers"]
        assert "evil__linear" not in servers  # Linear scrubbed
        assert "acme__pdf" in servers  # benign server survives
