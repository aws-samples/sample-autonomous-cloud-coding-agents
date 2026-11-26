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


_ABSENT_DESCRIPTORS = [
    pytest.param("CUSTOM", None, id="custom-descriptors-null"),
    pytest.param("CUSTOM", {"custom": None}, id="custom-custom-null"),
    pytest.param("CUSTOM", {"custom": {"data": None}}, id="custom-data-null"),
    pytest.param("CUSTOM", "text", id="custom-descriptors-text"),
    pytest.param("CUSTOM", {"custom": "text"}, id="custom-custom-text"),
    pytest.param("MCP", None, id="mcp-descriptors-null"),
    pytest.param("MCP", {"mcpServer": None}, id="mcp-mcpServer-null"),
    pytest.param("MCP", {"mcpServer": {"data": None}}, id="mcp-data-null"),
    pytest.param("MCP", {"mcpServer": ["x"]}, id="mcp-mcpServer-list"),
    pytest.param("SKILL", None, id="skill-descriptors-null"),
    pytest.param("SKILL", {"agentSkillsDefinition": None}, id="skill-agentSkillsDefinition-null"),
    pytest.param(
        "SKILL",
        {"agentSkillsDefinition": {"additionalData": None}},
        id="skill-additionalData-null",
    ),
    pytest.param(
        "SKILL",
        {"agentSkillsDefinition": {"additionalData": {"skillMd": None}}},
        id="skill-skillMd-null",
    ),
    pytest.param(
        "SKILL",
        {"agentSkillsDefinition": {"additionalData": {"skillMd": {"data": None}}}},
        id="skill-data-null",
    ),
    pytest.param(
        "SKILL",
        {"agentSkillsDefinition": {"additionalData": {"skillMd": "text"}}},
        id="skill-skillMd-text",
    ),
]


class _FakeBoto:
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
        runtime = {"prompt_fragment": "Add a note.", "tool_hints": ["Edit"]}
        b64 = base64.b64encode(json.dumps(runtime).encode()).decode()
        assert _client()._extract_runtime(self._skill_md(f"x-abca-runtime: {b64}")) == runtime

    def test_agent_skills_base64_survives_apostrophe(self):
        runtime = {"prompt_fragment": "Don't skip tests; it's required.", "tool_hints": ["Don't"]}
        b64 = base64.b64encode(json.dumps(runtime).encode()).decode()
        assert _client()._extract_runtime(self._skill_md(f"x-abca-runtime: {b64}")) == runtime

    def test_agent_skills_parses_legacy_single_quoted_json(self):
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
        raw = {"recordType": "CUSTOM", "descriptors": {"custom": {"data": data}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    @pytest.mark.parametrize("data", ["null", "[1, 2]", '"s"'])
    def test_mcp_non_object_body_raises_malformed(self, data):
        raw = {"recordType": "MCP", "descriptors": {"mcpServer": {"data": data}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    def test_mcp_non_dict_meta_returns_empty_not_crash(self):
        server = {"name": "acme/x", "version": "1.0.0", "_meta": "not-a-dict"}
        raw = {"recordType": "MCP", "descriptors": {"mcpServer": {"data": json.dumps(server)}}}
        assert _client()._extract_runtime(raw) == {}

    def test_agent_skills_non_mapping_frontmatter_raises_malformed(self):
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

    @pytest.mark.parametrize(("record_type", "descriptors"), _ABSENT_DESCRIPTORS)
    def test_absent_descriptor_reads_as_an_empty_payload(self, record_type, descriptors):
        raw = {"recordType": record_type, "descriptors": descriptors}
        assert _client()._extract_runtime(raw) == {}

    @pytest.mark.parametrize(
        ("record_type", "descriptor"), [("CUSTOM", "custom"), ("MCP", "mcpServer")]
    )
    @pytest.mark.parametrize(
        "data",
        [
            pytest.param("", id="empty-string"),
            pytest.param(0, id="zero"),
            pytest.param(False, id="false"),
        ],
    )
    def test_body_that_is_not_json_text_raises_malformed(self, record_type, descriptor, data):
        raw = {"recordType": record_type, "descriptors": {descriptor: {"data": data}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    @pytest.mark.parametrize(
        ("record_type", "descriptor", "body"),
        [
            pytest.param("CUSTOM", "custom", '{"runtime": {"limit": NaN}}', id="custom"),
            pytest.param(
                "MCP",
                "mcpServer",
                '{"_meta": {"dev.abca.runtime": {"limit": Infinity}}}',
                id="mcp",
            ),
        ],
    )
    def test_non_json_number_in_body_raises_malformed(self, record_type, descriptor, body):
        # json.loads reads NaN, Infinity and -Infinity unless told otherwise; JSON.parse
        # rejects them.
        raw = {"recordType": record_type, "descriptors": {descriptor: {"data": body}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    @pytest.mark.parametrize(
        "value",
        [
            pytest.param(base64.b64encode(b'{"limit": -Infinity}').decode(), id="base64"),
            pytest.param("""'{"limit": NaN}'""", id="legacy-json"),
        ],
    )
    def test_agent_skills_non_json_number_in_runtime_raises_malformed(self, value):
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(self._skill_md(f"x-abca-runtime: {value}"))

    def test_agent_skills_duplicate_frontmatter_key_last_value_wins(self):
        # PyYAML keeps the last value of a repeated key, and so does js-yaml under `json: true`.
        def b64(runtime: dict) -> str:
            return base64.b64encode(json.dumps(runtime).encode()).decode()

        first = b64({"prompt_fragment": "FIRST"})
        second = b64({"prompt_fragment": "SECOND"})
        raw = self._skill_md(f"x-abca-runtime: {first}\nx-abca-runtime: {second}")
        assert _client()._extract_runtime(raw) == {"prompt_fragment": "SECOND"}


class TestResolveFailClosed:
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
            _skill("1.1.0", "x-abca-runtime: [1, 2"),
        ]
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve(records, "registry://skill/acme/readme-helper@^1.0.0")
        assert exc.value.reason == "MALFORMED"

    def test_malformed_message_does_not_leak_descriptor_bytes(self):
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

    def _resolve_payload(self, record_type: str, descriptors: object):
        record = {
            "recordId": "rec-1.0.0",
            "name": "mcp_server/acme/pdf-tools",
            "recordType": record_type,
            "descriptors": descriptors,
            "recordVersion": "1.0.0",
            "status": "APPROVED",
        }
        return self._resolve([record], "registry://mcp_server/acme/pdf-tools@1.0.0")

    @pytest.mark.parametrize(("record_type", "descriptors"), _ABSENT_DESCRIPTORS)
    def test_fails_removed_when_a_descriptor_level_is_absent(self, record_type, descriptors):
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve_payload(record_type, descriptors)
        assert exc.value.reason == "REMOVED"

    @pytest.mark.parametrize(
        ("record_type", "descriptors"),
        [
            pytest.param("CUSTOM", {"custom": {"data": '{"runtime": null}'}}, id="custom-runtime"),
            pytest.param("MCP", {"mcpServer": {"data": '{"_meta": null}'}}, id="mcp-meta"),
            pytest.param(
                "MCP",
                {"mcpServer": {"data": '{"_meta": {"dev.abca.runtime": null}}'}},
                id="mcp-meta-runtime",
            ),
        ],
    )
    def test_fails_removed_when_the_body_holds_a_null_runtime(self, record_type, descriptors):
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve_payload(record_type, descriptors)
        assert exc.value.reason == "REMOVED"

    def test_get_record_returns_a_record_whose_descriptor_level_is_null(self):
        record = {
            "recordId": "rec-1.0.0",
            "name": "cedar_policy_module/acme/permit",
            "recordType": "CUSTOM",
            "descriptors": {"custom": None},
            "recordVersion": "1.0.0",
            "status": "DRAFT",
        }
        client = AgentRegistryClient("r", _FakeBoto([record]))
        assert client.get_record("cedar_policy_module", "acme", "permit", "1.0.0") is record

    def test_resolves_beside_unrelated_corrupt_records(self):
        def _mcp(record_id: str, name: str, version: str, data: str) -> dict:
            return {
                "recordId": record_id,
                "name": f"mcp_server/acme/{name}",
                "recordType": "MCP",
                "descriptors": {"mcpServer": {"data": data}},
                "recordVersion": version,
                "status": "APPROVED",
            }

        healthy = json.dumps({"_meta": {_RUNTIME_META_KEY: {"type": "http", "url": "https://x"}}})
        asset = self._resolve(
            [
                _mcp("rec-other", "other", "1.0.0", "{bad json"),
                _mcp("rec-lower", "pdf-tools", "1.0.0", "{bad json"),
                _mcp("rec-healthy", "pdf-tools", "1.1.0", healthy),
            ],
            "registry://mcp_server/acme/pdf-tools@^1.0.0",
        )
        assert asset.version == "1.1.0"

    def test_unknown_status_is_not_a_resolution_candidate(self):
        records = [
            self._mcp_record("1.0.0", "APPROVED", with_runtime=True),
            self._mcp_record("1.1.0", "SOME_FUTURE_STATUS", with_runtime=True),
        ]
        asset = self._resolve(records, "registry://mcp_server/acme/pdf-tools@^1.0.0")
        assert asset.version == "1.0.0"
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve(records, "registry://mcp_server/acme/pdf-tools@1.1.0")
        assert exc.value.reason == "NO_MATCHING_VERSION"

    def test_a_record_without_a_name_does_not_stop_the_others(self):
        nameless = {**self._mcp_record("2.0.0", "APPROVED", with_runtime=True), "name": None}
        healthy = self._mcp_record("1.0.0", "APPROVED", with_runtime=True)
        client = AgentRegistryClient("r", _FakeBoto([nameless, healthy]))
        asset = client.resolve(parse_ref("registry://mcp_server/acme/pdf-tools@^1.0.0"))
        assert asset.version == "1.0.0"
        assert client.get_record("mcp_server", "acme", "pdf-tools", "1.0.0") is healthy

    def test_a_record_without_a_version_does_not_stop_its_siblings(self):
        versionless = {
            **self._mcp_record("1.1.0", "APPROVED", with_runtime=True),
            "recordVersion": None,
        }
        records = [versionless, self._mcp_record("1.0.0", "APPROVED", with_runtime=True)]
        asset = self._resolve(records, "registry://mcp_server/acme/pdf-tools@^1.0.0")
        assert asset.version == "1.0.0"
