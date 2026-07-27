"""Unit tests for registry.agentcore_client read-side extraction (#246).

Focus: ``_extract_runtime`` must recover the runtime payload from all three
descriptor storage shapes — CUSTOM (verbatim JSON), MCP (JSON + ``_meta``), and
AGENT_SKILLS (Markdown frontmatter, runtime in ``x-abca-runtime``). The
AGENT_SKILLS parse must byte-match what the TS adapter writes (parity).
"""

from __future__ import annotations

import json

from registry.agentcore_client import AgentCoreRegistryClient

_RUNTIME_META_KEY = "dev.abca.runtime"


def _client() -> AgentCoreRegistryClient:
    return AgentCoreRegistryClient("r", None)


class TestExtractRuntime:
    def test_custom_reads_body_runtime(self):
        runtime = {"cedar_text": "forbid(principal, action, resource);"}
        raw = {
            "descriptorType": "CUSTOM",
            "descriptors": {
                "custom": {"inlineContent": json.dumps({"runtime": runtime, "discovery": {}})}
            },
        }
        assert _client()._extract_runtime(raw) == runtime

    def test_mcp_reads_meta_block(self):
        runtime = {"type": "http", "url": "https://mcp.example.com/mcp"}
        server = {"name": "acme/x", "version": "1.0.0", "_meta": {_RUNTIME_META_KEY: runtime}}
        raw = {
            "descriptorType": "MCP",
            "descriptors": {"mcp": {"server": {"inlineContent": json.dumps(server)}}},
        }
        assert _client()._extract_runtime(raw) == runtime

    def test_agent_skills_parses_frontmatter(self):
        # Exactly the shape the TS adapter's buildSkillMd emits.
        runtime = {"prompt_fragment": "Add a note.", "tool_hints": ["Edit"]}
        skill_md = (
            "---\n"
            "name: acme-readme-helper\n"
            "description: d\n"
            "version: 1.0.0\n"
            f"x-abca-runtime: '{json.dumps(runtime)}'\n"
            "---\n"
            "# acme/readme-helper\n"
            "body"
        )
        raw = {
            "descriptorType": "AGENT_SKILLS",
            "descriptors": {"agentSkills": {"skillMd": {"inlineContent": skill_md}}},
        }
        assert _client()._extract_runtime(raw) == runtime

    def test_agent_skills_missing_frontmatter_key_returns_empty(self):
        skill_md = "---\nname: x\ndescription: d\nversion: 1.0.0\n---\nbody"
        raw = {
            "descriptorType": "AGENT_SKILLS",
            "descriptors": {"agentSkills": {"skillMd": {"inlineContent": skill_md}}},
        }
        assert _client()._extract_runtime(raw) == {}
