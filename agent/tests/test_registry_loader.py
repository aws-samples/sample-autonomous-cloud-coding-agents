"""Unit tests for registry.loader — merging resolved mcp_server assets (#246)."""

from __future__ import annotations

import json

from registry.loader import (
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
        n = apply_mcp_assets(str(tmp_path), [_mcp_asset("acme", "pdf-tools", "1.0.0", runtime)])
        assert n == 1
        merged = _read_mcp(tmp_path)
        assert merged["mcpServers"]["acme__pdf_tools"] == runtime

    def test_preserves_existing_servers(self, tmp_path):
        existing = {"mcpServers": {"other": {"command": "/usr/bin/x"}}}
        (tmp_path / ".mcp.json").write_text(json.dumps(existing))
        n = apply_mcp_assets(
            str(tmp_path),
            [_mcp_asset("acme", "weather", "2.1.0", {"transport": "sse", "url": "https://w"})],
        )
        assert n == 1
        merged = _read_mcp(tmp_path)
        assert merged["mcpServers"]["other"]["command"] == "/usr/bin/x"
        assert "acme__weather" in merged["mcpServers"]

    def test_merges_multiple_servers(self, tmp_path):
        assets = [
            _mcp_asset("acme", "a", "1.0.0", {"transport": "http", "url": "https://a"}),
            _mcp_asset("acme", "b", "1.0.0", {"transport": "http", "url": "https://b"}),
        ]
        n = apply_mcp_assets(str(tmp_path), assets)
        assert n == 2
        merged = _read_mcp(tmp_path)
        assert set(merged["mcpServers"]) == {"acme__a", "acme__b"}

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
        n = apply_mcp_assets(str(tmp_path), assets)
        assert n == 0
        assert not (tmp_path / ".mcp.json").exists()

    def test_skips_empty_runtime(self, tmp_path):
        n = apply_mcp_assets(str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", {})])
        assert n == 0
        assert not (tmp_path / ".mcp.json").exists()

    def test_no_op_on_missing_repo_dir(self):
        asset = _mcp_asset("acme", "x", "1.0.0", {"transport": "http", "url": "u"})
        n = apply_mcp_assets("/nonexistent/dir", [asset])
        assert n == 0

    def test_malformed_existing_treated_as_absent(self, tmp_path):
        (tmp_path / ".mcp.json").write_text("{ not valid json")
        runtime = {"transport": "http", "url": "https://x"}
        n = apply_mcp_assets(str(tmp_path), [_mcp_asset("acme", "x", "1.0.0", runtime)])
        assert n == 1
        assert _read_mcp(tmp_path)["mcpServers"]["acme__x"] == runtime


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

    def test_skips_blank_or_invalid_runtime(self):
        blank = _skill_asset("acme", "a", {"prompt_fragment": "   "})
        assert build_skill_prompt_fragment([blank]) == ""
        assert build_skill_prompt_fragment([_skill_asset("acme", "a", {})]) == ""


class TestApplyResolvedAssets:
    def test_empty_is_noop(self, tmp_path):
        apply_resolved_assets(str(tmp_path), [])
        assert not (tmp_path / ".mcp.json").exists()

    def test_dispatches_mcp(self, tmp_path):
        apply_resolved_assets(
            str(tmp_path),
            [_mcp_asset("acme", "x", "1.0.0", {"transport": "http", "url": "https://x"})],
        )
        assert (tmp_path / ".mcp.json").exists()

    def test_skill_and_cedar_do_not_touch_mcp_json(self, tmp_path):
        # apply_resolved_assets only handles on-disk kinds (mcp_server). Skills
        # and cedar modules are applied elsewhere, so no .mcp.json is written.
        apply_resolved_assets(str(tmp_path), [_skill_asset("acme", "r", {"prompt_fragment": "X."})])
        assert not (tmp_path / ".mcp.json").exists()
