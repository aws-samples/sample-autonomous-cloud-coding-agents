"""Tests for registry skill fragments in the system prompt (#246, PR 3)."""

from __future__ import annotations

from prompt_builder import _registry_skill_addendum
from tests.conftest import make_task_config


def _config(resolved_assets: dict):
    return make_task_config(resolved_assets=resolved_assets)


def _skill(name: str, content: str, tool_hints: list[str] | None = None) -> dict:
    return {
        "kind": "skill",
        "namespace": "acme",
        "name": name,
        "version": "1.0.0",
        "descriptor": {"summary": "s", "permissions": [], "tool_hints": tool_hints or []},
        "content": content,
        "warnings": [],
    }


class TestRegistrySkillAddendum:
    def test_empty_when_no_skills(self):
        assert _registry_skill_addendum(_config({})) == ""
        assert _registry_skill_addendum(_config({"skills": []})) == ""

    def test_includes_skill_fragment_content(self):
        cfg = _config({"skills": [_skill("refactor", "Preserve public APIs when refactoring.")]})
        out = _registry_skill_addendum(cfg)
        assert "Preserve public APIs when refactoring." in out
        assert "## Skill: acme/refactor" in out

    def test_renders_tool_hints(self):
        cfg = _config({"skills": [_skill("refactor", "body", tool_hints=["Edit", "Bash"])]})
        out = _registry_skill_addendum(cfg)
        assert "Edit" in out and "Bash" in out

    def test_multiple_skills_each_rendered(self):
        cfg = _config({"skills": [_skill("a", "alpha body"), _skill("b", "beta body")]})
        out = _registry_skill_addendum(cfg)
        assert "alpha body" in out
        assert "beta body" in out

    def test_skips_skill_missing_content(self):
        skill = _skill("x", "")
        skill["content"] = None
        cfg = _config({"skills": [skill]})
        assert _registry_skill_addendum(cfg) == ""
