"""Unit tests for registry.agent_registry_client read-side extraction.

Focus: ``_extract_runtime`` must recover the runtime payload from all three
descriptor storage shapes — CUSTOM (verbatim JSON), MCP (JSON + ``_meta``), and
SKILL (Markdown frontmatter, runtime in ``x-abca-runtime``). The SKILL parse
must byte-match what the TS adapter writes (parity).
"""

from __future__ import annotations

import base64
import json

import pytest

from registry.agent_registry_client import AgentRegistryClient
from registry.client import RegistryRecordMalformedError, RegistryResolutionError
from registry.ref import parse_ref

_RUNTIME_META_KEY = "dev.abca.runtime"


def _client() -> AgentRegistryClient:
    return AgentRegistryClient("r", None)


class _FakeBoto:
    """Minimal agent-registry-control stand-in: one page of records, and
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
            "recordType": "CUSTOM",
            "descriptors": {"custom": {"data": json.dumps({"runtime": runtime, "discovery": {}})}},
        }
        assert _client()._extract_runtime(raw) == runtime

    def test_mcp_reads_meta_block(self):
        runtime = {"type": "http", "url": "https://mcp.example.com/mcp"}
        server = {"name": "acme/x", "version": "1.0.0", "_meta": {_RUNTIME_META_KEY: runtime}}
        raw = {
            "recordType": "MCP",
            "descriptors": {"mcpServer": {"data": json.dumps(server)}},
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
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
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
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
        }
        assert _client()._extract_runtime(raw) == {}

    def test_agent_skills_malformed_frontmatter_raises_not_empty(self):
        # A frontmatter block that is present but not valid YAML (unterminated flow
        # sequence) must be rejected, not collapsed to `{}` — collapsing erases the
        # publisher/runtime and hides the corruption (#791).
        skill_md = "---\nname: x\nx-abca-runtime: [1, 2\n---\nbody"
        raw = {
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
        }
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    def test_agent_skills_undecodable_runtime_raises_malformed(self):
        # Frontmatter parses as valid YAML, but x-abca-runtime base64-decodes to a
        # non-JSON string — must classify as MALFORMED (mirrors the TS adapter),
        # not collapse to {} or leak a bare ValueError (PR #837 review).
        bad = base64.b64encode(b"not json").decode()
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(self._skill_md(f"x-abca-runtime: {bad}"))

    def test_custom_invalid_json_raises_malformed(self):
        raw = {"recordType": "CUSTOM", "descriptors": {"custom": {"data": "not json{"}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    def test_mcp_invalid_json_raises_malformed(self):
        raw = {"recordType": "MCP", "descriptors": {"mcpServer": {"data": "{bad json"}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    @pytest.mark.parametrize("data", ["null", "123", "[1, 2]", '"just a string"'])
    def test_custom_non_object_body_raises_malformed(self, data):
        # json.loads succeeds on these, then body.get would raise a bare
        # AttributeError — box it as MALFORMED, mirroring parseDescriptorJson's
        # object check in the TS adapter (#837 review).
        raw = {"recordType": "CUSTOM", "descriptors": {"custom": {"data": data}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    @pytest.mark.parametrize("data", ["null", "[1, 2]", '"s"'])
    def test_mcp_non_object_body_raises_malformed(self, data):
        raw = {"recordType": "MCP", "descriptors": {"mcpServer": {"data": data}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    def test_mcp_non_dict_meta_returns_empty_not_crash(self):
        # `{"_meta": "x"}`: `.get` on a str would raise AttributeError before the
        # #837 guard. Now it yields an empty runtime (resolve then fails REMOVED).
        server = {"name": "acme/x", "version": "1.0.0", "_meta": "not-a-dict"}
        raw = {"recordType": "MCP", "descriptors": {"mcpServer": {"data": json.dumps(server)}}}
        assert _client()._extract_runtime(raw) == {}

    def test_agent_skills_non_mapping_frontmatter_raises_malformed(self):
        # Frontmatter that is valid YAML but a sequence/scalar (not a mapping) must
        # reject as MALFORMED rather than collapse to `{}`, which would hide the
        # corruption the way an unparseable block would (#791 / #837 review).
        skill_md = "---\n- a\n- b\n---\nbody"
        raw = {
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
        }
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

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
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
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
            "recordArn": (
                f"arn:aws:agent-registry:us-east-1:123456789012:registry/r/record/rec-{version}"
            ),
            "name": "mcp_server/acme/pdf-tools",
            "recordType": "MCP",
            "descriptors": {"mcpServer": {"data": json.dumps(server)}},
            "recordVersion": version,
            "status": status,
        }

    def _resolve(self, records: list[dict], ref_str: str):
        client = AgentRegistryClient("r", _FakeBoto(records))
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

    def test_fails_malformed_when_winner_frontmatter_is_unparseable(self):
        # A malformed frontmatter block must reject the ref as MALFORMED — distinct
        # from REMOVED (empty) — rather than resolving with erased attribution (#791).
        skill_md = "---\nname: acme-readme-helper\nx-abca-runtime: [1, 2\n---\nbody"
        record = {
            "recordId": "rec-1.0.0",
            "recordArn": (
                "arn:aws:agent-registry:us-east-1:123456789012:registry/r/record/rec-1.0.0"
            ),
            "name": "skill/acme/readme-helper",
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
            "recordVersion": "1.0.0",
            "status": "APPROVED",
        }
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve([record], "registry://skill/acme/readme-helper@1.0.0")
        assert exc.value.reason == "MALFORMED"

    def test_fails_malformed_when_runtime_value_undecodable(self):
        # Valid YAML frontmatter but an undecodable x-abca-runtime value must be
        # MALFORMED, not REMOVED — matching the TS adapter (PR #837 review).
        bad = base64.b64encode(b"not json").decode()
        skill_md = f"---\nname: acme-readme-helper\nx-abca-runtime: {bad}\n---\nbody"
        record = {
            "recordId": "rec-1.0.0",
            "name": "skill/acme/readme-helper",
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
            "recordVersion": "1.0.0",
            "status": "APPROVED",
        }
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve([record], "registry://skill/acme/readme-helper@1.0.0")
        assert exc.value.reason == "MALFORMED"

    def test_fails_malformed_when_custom_body_invalid(self):
        record = {
            "recordId": "rec-1.0.0",
            "name": "cedar_policy_module/acme/permit",
            "recordType": "CUSTOM",
            "descriptors": {"custom": {"data": "not json{"}},
            "recordVersion": "1.0.0",
            "status": "APPROVED",
        }
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve([record], "registry://cedar_policy_module/acme/permit@1.0.0")
        assert exc.value.reason == "MALFORMED"

    def test_fails_malformed_when_mcp_body_invalid(self):
        record = {
            "recordId": "rec-1.0.0",
            "name": "mcp_server/acme/pdf-tools",
            "recordType": "MCP",
            "descriptors": {"mcpServer": {"data": "{bad json"}},
            "recordVersion": "1.0.0",
            "status": "APPROVED",
        }
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve([record], "registry://mcp_server/acme/pdf-tools@1.0.0")
        assert exc.value.reason == "MALFORMED"

    def test_get_record_fails_closed_on_malformed_target(self):
        # Parity with TS getRecord, which throws for a malformed target rather than
        # handing back a record whose attribution was silently erased (#791).
        skill_md = "---\nname: acme-readme-helper\nx-abca-runtime: [1, 2\n---\nbody"
        record = {
            "recordId": "rec-1.0.0",
            "name": "skill/acme/readme-helper",
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
            "recordVersion": "1.0.0",
            "status": "DRAFT",
        }
        client = AgentRegistryClient("r", _FakeBoto([record]))
        with pytest.raises(RegistryRecordMalformedError):
            client.get_record("skill", "acme", "readme-helper", "1.0.0")

    def test_rejects_malformed_winner_rather_than_downgrading(self):
        # The TS adapter's highest-value test, mirrored: a valid lower version
        # exists but the highest matching version is malformed. Silently resolving
        # the lower one would mask that the pinned (winning) version is corrupt —
        # reject as MALFORMED instead (#791 / #837 review).
        def _skill(version: str, runtime_line: str) -> dict:
            skill_md = f"---\nname: acme-readme-helper\n{runtime_line}\n---\nbody"
            return {
                "recordId": f"rec-{version}",
                "name": "skill/acme/readme-helper",
                "recordType": "SKILL",
                "descriptors": {
                    "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
                },
                "recordVersion": version,
                "status": "APPROVED",
            }

        good = base64.b64encode(json.dumps({"prompt_fragment": "ok"}).encode()).decode()
        records = [
            _skill("1.0.0", f"x-abca-runtime: {good}"),
            _skill("1.1.0", "x-abca-runtime: [1, 2"),  # highest, but unparseable
        ]
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve(records, "registry://skill/acme/readme-helper@^1.0.0")
        assert exc.value.reason == "MALFORMED"

    def test_malformed_message_does_not_leak_descriptor_bytes(self):
        # resolve() returns this reason on an open 422 (via the TS twin); the raw
        # parser text — which can echo descriptor bytes — must stay off the message
        # and only on __cause__ (#837 review).
        record = {
            "recordId": "rec-1.0.0",
            "name": "mcp_server/acme/pdf-tools",
            "recordType": "MCP",
            "descriptors": {"mcpServer": {"data": '{"_meta": SUPERSECRETTOKEN'}},
            "recordVersion": "1.0.0",
            "status": "APPROVED",
        }
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve([record], "registry://mcp_server/acme/pdf-tools@1.0.0")
        assert "SUPERSECRETTOKEN" not in str(exc.value)
