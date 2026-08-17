"""Unit tests for registry.agentcore_client read-side extraction (#246).

Focus: ``_extract_runtime`` must recover the runtime payload from all three
descriptor storage shapes — CUSTOM (verbatim JSON), MCP (JSON + ``_meta``), and
AGENT_SKILLS (Markdown frontmatter, runtime in ``x-abca-runtime``). The
AGENT_SKILLS parse must byte-match what the TS adapter writes (parity).
"""

from __future__ import annotations

import base64
import json

import pytest

from registry.agentcore_client import AgentCoreRegistryClient
from registry.client import RegistryResolutionError
from registry.ref import parse_ref

_RUNTIME_META_KEY = "dev.abca.runtime"


def _client() -> AgentCoreRegistryClient:
    return AgentCoreRegistryClient("r", None)


class _FakeBoto:
    """Minimal bedrock-agentcore-control stand-in: one page of records, and
    get_registry_record echoing the seeded record by id."""

    def __init__(self, records: list[dict]) -> None:
        self._records = records

    def list_registry_records(self, **_kwargs):
        return {"registryRecords": self._records, "nextToken": None}

    def get_registry_record(self, *, registryId, recordId):
        for r in self._records:
            if r.get("recordId") == recordId:
                return r
        return {}


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

    @staticmethod
    def _skill_md(runtime_line: str) -> dict:
        skill_md = (
            "---\n"
            "name: acme-readme-helper\n"
            "description: d\n"
            "version: 1.0.0\n"
            f"{runtime_line}\n"
            "---\n"
            "# acme/readme-helper\n"
            "body"
        )
        return {
            "descriptorType": "AGENT_SKILLS",
            "descriptors": {"agentSkills": {"skillMd": {"inlineContent": skill_md}}},
        }

    def test_agent_skills_parses_base64_frontmatter(self):
        # The shape the TS adapter's buildSkillMd emits: base64-encoded JSON.
        runtime = {"prompt_fragment": "Add a note.", "tool_hints": ["Edit"]}
        b64 = base64.b64encode(json.dumps(runtime).encode()).decode()
        assert _client()._extract_runtime(self._skill_md(f"x-abca-runtime: {b64}")) == runtime

    def test_agent_skills_base64_survives_apostrophe(self):
        # The exact payload that broke single-quoted YAML frontmatter (#246).
        runtime = {"prompt_fragment": "Don't skip tests; it's required.", "tool_hints": ["Don't"]}
        b64 = base64.b64encode(json.dumps(runtime).encode()).decode()
        assert _client()._extract_runtime(self._skill_md(f"x-abca-runtime: {b64}")) == runtime

    def test_agent_skills_parses_legacy_single_quoted_json(self):
        # Records published before the base64 switch must still resolve.
        runtime = {"prompt_fragment": "Add a note.", "tool_hints": ["Edit"]}
        line = f"x-abca-runtime: '{json.dumps(runtime)}'"
        assert _client()._extract_runtime(self._skill_md(line)) == runtime

    def test_agent_skills_missing_frontmatter_key_returns_empty(self):
        skill_md = "---\nname: x\ndescription: d\nversion: 1.0.0\n---\nbody"
        raw = {
            "descriptorType": "AGENT_SKILLS",
            "descriptors": {"agentSkills": {"skillMd": {"inlineContent": skill_md}}},
        }
        assert _client()._extract_runtime(raw) == {}

    def test_agent_skills_newline_description_cannot_inject_runtime_key(self):
        # B1 (#246): a description carrying a newline + a second x-abca-runtime
        # line must not shadow the validated runtime. Frontmatter emitted by the
        # safe builder quotes the description, so the injection stays a value.
        import yaml

        legit = {"prompt_fragment": "THE VALIDATED FRAGMENT"}
        injected = json.dumps({"prompt_fragment": "INJECTED"}).encode()
        injected_b64 = base64.b64encode(injected).decode()
        frontmatter = {
            "name": "acme-tdd",
            "description": f"benign\nx-abca-runtime: {injected_b64}",
            "version": "1.0.0",
            "x-abca-runtime": base64.b64encode(json.dumps(legit).encode()).decode(),
        }
        skill_md = "---\n" + yaml.dump(frontmatter).strip() + "\n---\n# acme/tdd\nbody"
        raw = {
            "descriptorType": "AGENT_SKILLS",
            "descriptors": {"agentSkills": {"skillMd": {"inlineContent": skill_md}}},
        }
        assert _client()._extract_runtime(raw) == legit


class TestResolveFailClosed:
    """resolve() must never hand back a record with an empty/unreadable runtime —
    that would let a task run with a missing/substituted asset (REGISTRY.md §8)."""

    @staticmethod
    def _mcp_record(version: str, status: str, *, with_runtime: bool) -> dict:
        server: dict = {"name": "acme/pdf-tools", "version": version}
        if with_runtime:
            server["_meta"] = {_RUNTIME_META_KEY: {"type": "http", "url": "https://x"}}
        return {
            "recordId": f"rec-{version}",
            "recordArn": f"arn:aws:bedrock-agentcore:us-east-1:1:registry/r/record/rec-{version}",
            "name": "mcp_server/acme/pdf-tools",
            "descriptorType": "MCP",
            "descriptors": {"mcp": {"server": {"inlineContent": json.dumps(server)}}},
            "recordVersion": version,
            "status": status,
        }

    def _resolve(self, records: list[dict], ref_str: str):
        client = AgentCoreRegistryClient("r", _FakeBoto(records))
        return client.resolve(parse_ref(ref_str))

    def test_resolves_when_runtime_present(self):
        asset = self._resolve(
            [self._mcp_record("1.4.1", "APPROVED", with_runtime=True)],
            "registry://mcp_server/acme/pdf-tools@1.4.1",
        )
        assert asset.version == "1.4.1"
        assert asset.runtime == {"type": "http", "url": "https://x"}

    def test_fails_closed_when_approved_record_has_empty_runtime(self):
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve(
                [self._mcp_record("1.4.1", "APPROVED", with_runtime=False)],
                "registry://mcp_server/acme/pdf-tools@1.4.1",
            )
        assert exc.value.reason == "REMOVED"
